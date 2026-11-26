'use strict';

const { request, readBody, probeMedia, httpError, sendJson, sendError } = require('../lib/net');
const { findVideos, findEmbeds, classify, suggestName, sanitizeName } = require('../lib/parse');
const { parsePlaylist } = require('../lib/hls');
const { extractPlatform } = require('../lib/platforms');

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 30;
const PROBE_COUNT = 12;

const DRM_HOSTS =
  /(^|\.)(netflix\.com|primevideo\.com|hotstar\.com|jiocinema\.com|disneyplus\.com|hulu\.com|sonyliv\.com|zee5\.com)$/i;

const OCTET_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/mp4', 'application/ogg']);

const TYPE_BY_CTYPE = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'video/x-m4v': 'm4v',
};

async function probe(video, page) {
  try {
    const info = await probeMedia(video.url, { Referer: page }, 4500);
    if (info.status === 404 || info.status === 410 || info.ctype.startsWith('text/html')) return null;
    const isHls = video.type === 'hls' || /mpegurl/.test(info.ctype);
    return {
      ...video,
      type: isHls ? 'hls' : TYPE_BY_CTYPE[info.ctype] || video.type,
      size: isHls ? 0 : info.size,
      hasVideo: video.hasVideo !== undefined ? video.hasVideo : !info.ctype.startsWith('audio/'),
      hasAudio: video.hasAudio !== undefined ? video.hasAudio : true,
      directSafe: !isHls,
    };
  } catch {
    return {
      ...video,
      hasVideo: true,
      hasAudio: true,
      directSafe: video.type !== 'hls',
    };
  }
}

async function expandM3u8Variants(playlistUrl, referer, title) {
  const res = await request(playlistUrl, { headers: { Referer: referer }, timeout: 12000 });
  if (res.statusCode >= 400) {
    res.resume();
    return null;
  }
  const text = await readBody(res, MAX_PLAYLIST_BYTES);
  const parsed = parsePlaylist(text, res.finalUrl);
  if (parsed.kind !== 'master' || !parsed.variants.length) return null;

  const baseTitle = sanitizeName(title) || 'stream';
  const out = [];
  for (const v of parsed.variants) {
    out.push({
      url: v.uri,
      type: 'hls',
      source: 'hls',
      quality: v.height ? `${v.height}p` : v.resolution || '',
      height: v.height || 0,
      size: 0,
      hasVideo: true,
      hasAudio: !v.audioUri,
      directSafe: false,
      name: `${baseTitle}${v.height ? ` (${v.height}p)` : ''}.ts`,
    });
  }
  const audioUris = new Set(parsed.variants.map((v) => v.audioUri).filter(Boolean));
  for (const au of audioUris) {
    out.push({
      url: au,
      type: 'hls',
      source: 'hls-audio',
      quality: 'Audio',
      height: 0,
      size: 0,
      hasVideo: false,
      hasAudio: true,
      directSafe: false,
      name: `${baseTitle} (Audio).ts`,
    });
  }
  return out;
}

async function extractFromPage(targetUrl, referer, depth = 0) {
  const plat = await extractPlatform(targetUrl);
  if (plat && (plat.videos.length || plat.note)) return plat;

  const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  if (referer) headers.Referer = referer;

  const up = await request(targetUrl, { headers, timeout: 15000 });
  if (up.statusCode >= 400) {
    up.resume();
    throw httpError(502, `That site answered with an error (${up.statusCode}). It may block automated visits.`);
  }

  const page = up.finalUrl;
  const ctype = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (/mpegurl/.test(ctype) || /\.m3u8$/i.test(new URL(page).pathname)) {
    const text = await readBody(up, MAX_PLAYLIST_BYTES);
    const parsed = parsePlaylist(text, page);
    if (parsed.kind === 'master' && parsed.variants.length) {
      const variants = await expandM3u8Variants(page, referer || page, '');
      if (variants && variants.length) return { page, title: '', videos: variants };
    }
    return {
      page,
      title: '',
      videos: [
        {
          url: page,
          type: 'hls',
          source: 'direct',
          size: 0,
          hasVideo: true,
          hasAudio: true,
          directSafe: false,
          name: suggestName(page, ''),
        },
      ],
    };
  }

  const urlType = classify(new URL(page));
  if (
    ctype.startsWith('video/') ||
    ctype.startsWith('audio/') ||
    (OCTET_TYPES.has(ctype) && (urlType || ctype === 'application/mp4' || ctype === 'application/ogg'))
  ) {
    up.destroy();
    const type = urlType || TYPE_BY_CTYPE[ctype] || 'video';
    const size = Number(up.headers['content-length']) || 0;
    return {
      page,
      title: '',
      videos: [
        {
          url: page,
          type,
          source: 'direct',
          size,
          hasVideo: !ctype.startsWith('audio/'),
          hasAudio: true,
          directSafe: true,
          name: suggestName(page, ''),
        },
      ],
    };
  }

  if (!(!ctype || /^(text\/|application\/(xhtml\+xml|json|ld\+json|xml))/.test(ctype))) {
    up.destroy();
    throw httpError(415, 'That link is not a web page or a video file.');
  }

  const html = await readBody(up, MAX_PAGE_BYTES);
  const result = findVideos(html, page);
  const title = result.title;
  let videos = result.videos.slice(0, MAX_RESULTS);

  if (videos.length) {
    const checked = await Promise.all(videos.slice(0, PROBE_COUNT).map((v) => probe(v, page)));
    videos = checked.filter(Boolean).concat(videos.slice(PROBE_COUNT));
  }

  if (videos.length === 1 && videos[0].type === 'hls') {
    try {
      const expanded = await expandM3u8Variants(videos[0].url, page, title);
      if (expanded && expanded.length) videos = expanded;
    } catch {
      // keep single hls entry
    }
  }

  if (!videos.length && depth < 1) {
    const embeds = findEmbeds(html, page).slice(0, 3);
    for (const emb of embeds) {
      try {
        const sub = await extractFromPage(emb, page, depth + 1);
        if (sub && sub.videos && sub.videos.length) {
          return {
            page: sub.page || page,
            title: title || sub.title,
            videos: sub.videos.map((v) => ({
              ...v,
              name: v.name || suggestName(v.url, title || sub.title),
            })),
          };
        }
      } catch {
        // continue checking other embeds
      }
    }
  }

  videos = videos.map((v) => ({
    ...v,
    name: v.name || suggestName(v.url, title),
    hasVideo: v.hasVideo !== undefined ? v.hasVideo : true,
    hasAudio: v.hasAudio !== undefined ? v.hasAudio : true,
    directSafe: v.directSafe !== undefined ? v.directSafe : v.type !== 'hls',
  }));

  return { page, title, videos };
}

module.exports = async (req, res) => {
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const target = (q.get('url') || '').trim();
    if (!target) throw httpError(400, 'Paste a link first.');

    let u;
    try {
      u = new URL(target);
    } catch {
      throw httpError(400, 'That does not look like a link. It should start with https://');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw httpError(400, 'That does not look like a link. It should start with https://');
    }

    if (DRM_HOSTS.test(u.hostname)) {
      return sendJson(res, 200, {
        page: u.href,
        title: '',
        videos: [],
        note: 'This streaming service uses DRM protection and cannot be downloaded.',
      });
    }

    const out = await extractFromPage(u.href, null, 0);
    sendJson(res, 200, out);
  } catch (err) {
    sendError(res, err);
  }
};
