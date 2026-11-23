'use strict';

const { pipeline } = require('node:stream');
const { request, readBody, httpError, sendJson, sendError } = require('../lib/net');
const { parsePlaylist, pickVariant } = require('../lib/hls');
const { sanitizeName, suggestName } = require('../lib/parse');

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_SEGMENTS = 4000;
const PREFETCH = 4;
const PLAYLIST_LIMIT = 2 * 1024 * 1024;

const OCTET_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/mp4', 'application/ogg']);
const EXT_BY_TYPE = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'video/mp2t': 'ts',
  'video/x-m4v': 'm4v',
};

function isPlaylist(ctype, url) {
  return /mpegurl/.test(ctype) || /\.m3u8$/i.test(new URL(url).pathname);
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function chooseName(requested, target, plan) {
  let name = sanitizeName(requested) || suggestName(target, '');
  const ext = plan.kind === 'hls' ? plan.ext : EXT_BY_TYPE[plan.ctype];
  if (plan.kind === 'hls') {
    name = name.replace(/\.[a-z0-9]{2,4}$/i, '') + '.' + ext;
  } else if (ext && !/\.[a-z0-9]{2,4}$/i.test(name)) {
    name += '.' + ext;
  }
  return name;
}

async function loadStream(first, headers) {
  let base = first.finalUrl;
  let playlist = parsePlaylist(await readBody(first, PLAYLIST_LIMIT), base);

  if (playlist.kind === 'master') {
    const best = pickVariant(playlist.variants);
    if (!best) throw httpError(422, 'No playable video was found in that playlist.');
    const r = await request(best.uri, { headers, timeout: 30000 });
    if (r.statusCode >= 400) {
      r.resume();
      throw httpError(502, 'The site refused to share the stream playlist.');
    }
    base = r.finalUrl;
    playlist = parsePlaylist(await readBody(r, PLAYLIST_LIMIT), base);
    if (playlist.kind !== 'media') throw httpError(422, 'This stream layout is not supported.');
  }

  if (playlist.encrypted) throw httpError(422, 'This stream is encrypted, so it cannot be saved here.');
  if (playlist.byteRange) throw httpError(422, 'This kind of stream is not supported.');
  if (!playlist.endlist) throw httpError(422, 'This is a live stream, so it cannot be saved as a file.');
  if (!playlist.segments.length) throw httpError(422, 'The stream has no video parts to download.');
  if (playlist.segments.length > MAX_SEGMENTS) throw httpError(413, 'This stream is too long to save here.');

  return { segments: playlist.segments, init: playlist.map, ext: playlist.map ? 'mp4' : 'ts' };
}

async function makePlan(target, ref, range) {
  let origin;
  try {
    origin = new URL(target).origin + '/';
  } catch {
    throw httpError(400, 'That is not a valid link.');
  }

  let referer = origin;
  try {
    const r = new URL(ref);
    if (r.protocol === 'http:' || r.protocol === 'https:') referer = r.href;
  } catch {
    // no usable page link; fall back to the video's own site
  }

  const headers = { Referer: referer };
  const up = await request(target, { headers: range ? { ...headers, Range: range } : headers, timeout: 30000 });

  if (up.statusCode >= 400) {
    up.resume();
    if (up.statusCode === 401 || up.statusCode === 403) {
      throw httpError(502, 'The site refused the download. The video may need you to be signed in, or it blocks downloads.');
    }
    if (up.statusCode === 404 || up.statusCode === 410) throw httpError(404, 'That video is no longer there.');
    throw httpError(502, `The site answered with an error (${up.statusCode}).`);
  }

  const ctype = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (isPlaylist(ctype, up.finalUrl)) {
    const stream = await loadStream(up, headers);
    return { kind: 'hls', headers, ...stream };
  }

  if (!(ctype.startsWith('video/') || ctype.startsWith('audio/') || OCTET_TYPES.has(ctype))) {
    up.destroy();
    throw httpError(415, 'That link is a web page, not a video file. Paste the page into "Find video" instead.');
  }

  const size = Number(up.headers['content-length']) || 0;
  if (size > MAX_BYTES) {
    up.destroy();
    throw httpError(413, 'This file is larger than 2 GB, which is the limit here.');
  }

  return { kind: 'file', up, ctype, size };
}

function sendFile(res, plan, filename) {
  const { up } = plan;
  res.statusCode = up.statusCode === 206 ? 206 : 200;
  res.setHeader('Content-Type', plan.ctype || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) {
    if (up.headers[h]) res.setHeader(h, up.headers[h]);
  }
  pipeline(up, res, () => {});
}

function drainOrClose(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

// Joins the parts of a playlist-based video into one file, fetching a few parts ahead.
async function sendStream(res, plan, filename) {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', plan.ext === 'mp4' ? 'video/mp4' : 'video/mp2t');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const parts = plan.init ? [plan.init, ...plan.segments] : plan.segments;
  const queue = [];
  let next = 0;
  const fill = () => {
    while (queue.length < PREFETCH && next < parts.length) {
      const p = request(parts[next++], { headers: plan.headers, timeout: 30000 });
      p.catch(() => {});
      queue.push(p);
    }
  };
  const cleanup = () => {
    for (const p of queue) p.then((r) => r.destroy()).catch(() => {});
    queue.length = 0;
  };

  try {
    fill();
    while (queue.length) {
      if (closed) return cleanup();
      const r = await queue.shift();
      fill();
      if (r.statusCode >= 400) {
        r.resume();
        throw httpError(502, 'A part of the video could not be fetched.');
      }
      for await (const chunk of r) {
        if (closed) {
          r.destroy();
          return cleanup();
        }
        if (!res.write(chunk)) await drainOrClose(res);
      }
    }
    res.end();
  } catch (err) {
    cleanup();
    res.destroy();
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') throw httpError(405, 'Use GET.');

    const q = new URL(req.url, 'http://localhost').searchParams;
    const target = (q.get('url') || '').trim();
    if (!target) throw httpError(400, 'Paste a video link first.');

    const check = q.get('check') === '1';
    const plan = await makePlan(target, q.get('ref') || '', check ? '' : req.headers.range || '');
    const filename = chooseName(q.get('name'), target, plan);

    if (check) {
      if (plan.kind === 'file') plan.up.destroy();
      return sendJson(res, 200, {
        ok: true,
        kind: plan.kind,
        filename,
        size: plan.size || 0,
        segments: plan.segments ? plan.segments.length : 0,
      });
    }

    if (plan.kind === 'file') return sendFile(res, plan, filename);
    return await sendStream(res, plan, filename);
  } catch (err) {
    sendError(res, err);
  }
};
