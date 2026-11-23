'use strict';

const { request, readBody, httpError, sendJson, sendError } = require('../lib/net');
const { findVideos, classify, suggestName } = require('../lib/parse');

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_RESULTS = 30;
const PROBE_COUNT = 12;

// These sites deliver video in protected or split-up pieces, so there is no plain file to save.
const PROTECTED_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|netflix\.com|primevideo\.com|hotstar\.com|jiocinema\.com|disneyplus\.com|hulu\.com|sonyliv\.com|zee5\.com)$/i;

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
    const r = await request(video.url, { method: 'HEAD', headers: { Referer: page }, timeout: 4000 });
    r.resume();
    const ctype = String(r.headers['content-type'] || '').toLowerCase();
    if (r.statusCode === 404 || r.statusCode === 410 || ctype.startsWith('text/html')) return null;
    const size = video.type === 'hls' ? 0 : Number(r.headers['content-length']) || 0;
    return { ...video, size };
  } catch {
    return video;
  }
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

    if (PROTECTED_HOSTS.test(u.hostname)) {
      return sendJson(res, 200, {
        page: u.href,
        title: '',
        videos: [],
        note: 'This site delivers its video in protected or split-up pieces, so it cannot be saved as a plain file here.',
      });
    }

    const up = await request(u.href, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 15000,
    });
    if (up.statusCode >= 400) {
      up.resume();
      throw httpError(502, `That site answered with an error (${up.statusCode}). It may block automated visits.`);
    }

    const page = up.finalUrl;
    const ctype = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let title = '';
    let videos;
    let directSize = 0;

    if (ctype.startsWith('video/') || /mpegurl/.test(ctype)) {
      up.destroy();
      const type = classify(new URL(page)) || (/mpegurl/.test(ctype) ? 'hls' : TYPE_BY_CTYPE[ctype] || 'video');
      directSize = Number(up.headers['content-length']) || 0;
      videos = [{ url: page, type, source: 'direct', size: type === 'hls' ? 0 : directSize }];
    } else if (!ctype || /^(text\/|application\/(xhtml\+xml|json|ld\+json|xml))/.test(ctype)) {
      const html = await readBody(up, MAX_PAGE_BYTES);
      const result = findVideos(html, page);
      title = result.title;
      videos = result.videos.slice(0, MAX_RESULTS);
      const checked = await Promise.all(
        videos.slice(0, PROBE_COUNT).map((v) => probe(v, page))
      );
      videos = checked.filter(Boolean).concat(videos.slice(PROBE_COUNT));
    } else {
      up.destroy();
      throw httpError(415, 'That link is not a web page or a video file.');
    }

    videos = videos.map((v) => ({ ...v, name: suggestName(v.url, title) }));
    sendJson(res, 200, { page, title, videos });
  } catch (err) {
    sendError(res, err);
  }
};
