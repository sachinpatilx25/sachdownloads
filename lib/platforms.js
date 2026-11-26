'use strict';

const { request, readBody, probeMedia } = require('./net');
const { sanitizeName } = require('./parse');

const MAX_API_BYTES = 2 * 1024 * 1024;

function sortFormats(videos) {
  return videos.slice().sort((a, b) => {
    const aMuxed = a.hasVideo && a.hasAudio && a.type !== 'hls' ? 2 : a.hasVideo ? 1 : 0;
    const bMuxed = b.hasVideo && b.hasAudio && b.type !== 'hls' ? 2 : b.hasVideo ? 1 : 0;
    if (bMuxed !== aMuxed) return bMuxed - aMuxed;
    return (b.height || 0) - (a.height || 0) || (b.size || 0) - (a.size || 0);
  });
}

async function fetchJson(url, opts = {}) {
  const res = await request(url, { timeout: 12000, ...opts });
  const text = await readBody(res, MAX_API_BYTES);
  if (res.statusCode >= 400) return { ok: false, status: res.statusCode, data: null };
  try {
    return { ok: true, status: res.statusCode, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.statusCode, data: null };
  }
}

async function extractYouTube(u) {
  const m = u.href.match(
    /(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (!m) return null;
  const videoId = m[1];

  const clients = [
    {
      name: 'ANDROID_VR',
      version: '1.60.19',
      extra: { androidSdkVersion: 32 },
      ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    },
    {
      name: 'VISIONOS',
      version: '0.1',
      extra: {},
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    },
  ];

  let lastReason = '';
  for (const client of clients) {
    const payload = JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: client.name,
          clientVersion: client.version,
          hl: 'en',
          gl: 'US',
          ...client.extra,
        },
      },
    });

    const { ok, data } = await fetchJson('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'User-Agent': client.ua,
        'Content-Type': 'application/json',
      },
      body: payload,
    });

    if (!ok || !data) continue;
    const status = (data.playabilityStatus && data.playabilityStatus.status) || '';
    if (status !== 'OK') {
      lastReason = (data.playabilityStatus && data.playabilityStatus.reason) || status;
      continue;
    }

    const sd = data.streamingData || {};
    const title = sanitizeName((data.videoDetails && data.videoDetails.title) || 'youtube_video');
    const seen = new Set();
    const videos = [];

    const pushFmt = (f, muxed) => {
      if (!f || !f.url || seen.has(f.url)) return;
      seen.add(f.url);
      const mime = String(f.mimeType || '');
      const isAudioOnly = mime.startsWith('audio/');
      const type = mime.includes('webm') ? 'webm' : isAudioOnly ? 'm4a' : 'mp4';
      const height = Number(f.height) || 0;
      const size = /^\d+$/.test(String(f.contentLength || '')) ? Number(f.contentLength) : 0;
      videos.push({
        url: f.url,
        type,
        source: 'youtube',
        quality: height ? `${height}p` : isAudioOnly ? 'Audio' : '',
        height,
        size,
        hasVideo: !isAudioOnly,
        hasAudio: muxed || isAudioOnly,
        directSafe: false,
        name: `${title}${height ? ` (${height}p)` : isAudioOnly ? ' (Audio)' : ''}.${type}`,
      });
    };

    for (const f of sd.formats || []) {
      if (!f.url) continue;
      try {
        const probe = await probeMedia(f.url, { 'User-Agent': client.ua }, 4000);
        if (probe.status === 200 || probe.status === 206) pushFmt(f, true);
      } catch {
        // skip PO-token blocked muxed URL
      }
    }
    for (const f of sd.adaptiveFormats || []) pushFmt(f, false);

    if (videos.length) {
      return {
        page: u.href,
        title,
        videos: sortFormats(videos).slice(0, 12),
      };
    }
  }

  if (/bot|sign in|login/i.test(lastReason)) {
    return {
      page: u.href,
      title: '',
      videos: [],
      note: 'YouTube temporarily flagged this cloud server IP with bot verification. Run SachDownload locally for unrestricted YouTube downloads.',
    };
  }
  return { page: u.href, title: '', videos: [], note: lastReason || 'YouTube could not play this video.' };
}

async function extractVimeo(u) {
  const m = u.href.match(/(?:vimeo\.com\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/|video\/)?|player\.vimeo\.com\/video\/)(\d+)/);
  if (!m) return null;
  const id = m[1];
  const h = u.searchParams.get('h');
  const cfgUrl = `https://player.vimeo.com/video/${id}/config${h ? '?h=' + encodeURIComponent(h) : ''}`;
  const { ok, data } = await fetchJson(cfgUrl, { headers: { Referer: 'https://vimeo.com/' } });
  if (!ok || !data || !data.request || !data.request.files) return null;

  const title = sanitizeName((data.video && data.video.title) || `vimeo_${id}`);
  const videos = [];
  for (const p of data.request.files.progressive || []) {
    if (!p.url) continue;
    const height = Number(p.height) || 0;
    videos.push({
      url: p.url,
      type: 'mp4',
      source: 'vimeo',
      quality: p.quality || (height ? `${height}p` : ''),
      height,
      size: 0,
      hasVideo: true,
      hasAudio: true,
      directSafe: true,
      name: `${title}${height ? ` (${height}p)` : ''}.mp4`,
    });
  }
  const hls = data.request.files.hls || {};
  const cdn = hls.default_cdn && hls.cdns && hls.cdns[hls.default_cdn];
  let hasDrmOnly = false;
  if (cdn && cdn.url) {
    if (/\/drm\//i.test(cdn.url)) {
      hasDrmOnly = !videos.length;
    } else {
      videos.push({
        url: cdn.url,
        type: 'hls',
        source: 'vimeo',
        quality: 'HLS',
        height: 0,
        size: 0,
        hasVideo: true,
        hasAudio: true,
        directSafe: false,
        name: `${title}.ts`,
      });
    }
  }
  if (!videos.length) {
    if (hasDrmOnly) {
      return { page: 'https://vimeo.com/', title, videos: [], note: 'This Vimeo stream uses DRM (CBCS) protection and cannot be downloaded.' };
    }
    return null;
  }
  return { page: 'https://vimeo.com/', title, videos: sortFormats(videos) };
}

async function extractDailymotion(u) {
  const m = u.href.match(/(?:dailymotion\.com\/(?:video|embed\/video)\/|dai\.ly\/)([A-Za-z0-9]+)/);
  if (!m) return null;
  const id = m[1];
  const { ok, data } = await fetchJson(`https://www.dailymotion.com/player/metadata/video/${id}`, {
    headers: { Referer: 'https://www.dailymotion.com/' },
  });
  if (!ok || !data || data.error) return null;

  const title = sanitizeName(data.title || `dailymotion_${id}`);
  const videos = [];
  const seen = new Set();
  for (const [label, list] of Object.entries(data.qualities || {})) {
    for (const item of list || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const isHls = /mpegurl/i.test(item.type || '') || /\.m3u8/i.test(item.url);
      const height = /^\d+$/.test(label) ? Number(label) : 0;
      videos.push({
        url: item.url,
        type: isHls ? 'hls' : 'mp4',
        source: 'dailymotion',
        quality: height ? `${height}p` : 'Auto',
        height,
        size: 0,
        hasVideo: true,
        hasAudio: true,
        directSafe: !isHls,
        name: `${title}${height ? ` (${height}p)` : ''}.${isHls ? 'ts' : 'mp4'}`,
      });
    }
  }
  if (!videos.length) return null;
  return { page: 'https://www.dailymotion.com/', title, videos: sortFormats(videos) };
}

async function extractTwitter(u) {
  const m = u.href.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  const [, user, id] = m;
  const { ok, data } = await fetchJson(`https://api.fxtwitter.com/${encodeURIComponent(user)}/status/${id}`);
  if (!ok || !data || !data.tweet || !data.tweet.media || !data.tweet.media.videos) return null;

  const title = sanitizeName((data.tweet.text || `tweet_${id}`).slice(0, 70));
  const videos = [];
  const seen = new Set();
  for (const v of data.tweet.media.videos) {
    const variants = v.variants && v.variants.length ? v.variants : [{ url: v.url, content_type: 'video/mp4' }];
    for (const vr of variants) {
      if (!vr.url || seen.has(vr.url) || !/mp4/i.test(vr.content_type || 'mp4')) continue;
      seen.add(vr.url);
      const resM = vr.url.match(/\/(\d+)x(\d+)\//);
      const height = resM ? Number(resM[2]) : Number(v.height) || 0;
      videos.push({
        url: vr.url,
        type: 'mp4',
        source: 'x',
        quality: height ? `${height}p` : '',
        height,
        size: 0,
        hasVideo: true,
        hasAudio: true,
        directSafe: true,
        name: `${title}${height ? ` (${height}p)` : ''}.mp4`,
      });
    }
  }
  if (!videos.length) return null;
  return { page: 'https://x.com/', title, videos: sortFormats(videos) };
}

async function extractReddit(u) {
  const m = u.href.match(/reddit\.com\/(r\/[^/]+\/comments\/[a-z0-9]+)/i);
  if (!m) return null;
  const { ok, data } = await fetchJson(`https://old.reddit.com/${m[1]}.json`, {
    headers: { 'User-Agent': 'VideoGrabber/2.0 (web video tool)' },
  });
  if (!ok || !Array.isArray(data) || !data[0]) return null;
  const post = data[0].data && data[0].data.children && data[0].data.children[0] && data[0].data.children[0].data;
  if (!post) return null;

  const rv = (post.secure_media && post.secure_media.reddit_video) || (post.media && post.media.reddit_video);
  if (!rv) return null;
  const title = sanitizeName(post.title || 'reddit_video');
  const height = Number(rv.height) || 0;
  const videos = [];
  if (rv.hls_url) {
    videos.push({
      url: rv.hls_url,
      type: 'hls',
      source: 'reddit',
      quality: height ? `${height}p HLS` : 'HLS',
      height,
      size: 0,
      hasVideo: true,
      hasAudio: true,
      directSafe: false,
      name: `${title}.ts`,
    });
  }
  if (rv.fallback_url) {
    videos.push({
      url: rv.fallback_url,
      type: 'mp4',
      source: 'reddit',
      quality: height ? `${height}p` : '',
      height,
      size: 0,
      hasVideo: true,
      hasAudio: false,
      directSafe: true,
      name: `${title}.mp4`,
    });
  }
  if (!videos.length) return null;
  return { page: 'https://www.reddit.com/', title, videos };
}

async function extractPlatform(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return await extractYouTube(u);
  if (/(^|\.)(vimeo\.com|player\.vimeo\.com)$/.test(host)) return await extractVimeo(u);
  if (/(^|\.)(dailymotion\.com|dai\.ly)$/.test(host)) return await extractDailymotion(u);
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return await extractTwitter(u);
  if (/(^|\.)reddit\.com$/.test(host)) return await extractReddit(u);
  return null;
}

module.exports = { extractPlatform };
