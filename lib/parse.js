'use strict';

// Finds video links inside a web page's HTML.

const EXT = 'mp4|m4v|webm|mov|mkv|ogv|3gp|m3u8';

const ABSOLUTE_URL = new RegExp(
  `https?:\\/\\/[^\\s"'<>\\\\)]+?\\.(?:${EXT})(?:\\?[^\\s"'<>\\\\)]*)?(?![\\w\\-/]|\\.\\w)`,
  'gi'
);
const QUOTED_PATH = new RegExp(
  `(["'])((?:\\.{0,2}\\/)?[^"'\\s<>\\\\]+?\\.(?:${EXT})(?:\\?[^"'\\s<>\\\\]*)?)\\1`,
  'gi'
);

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : whole;
  });
}

// Pages often keep URLs inside JSON, where "/" is written as "\/" and "&" as "\u0026".
function unescapeJs(text) {
  return text
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/');
}

function attr(tag, name) {
  const m = tag.match(new RegExp('(?:^|[\\s"\'])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  if (!m) return null;
  const value = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return decodeEntities(value);
}

function classify(u) {
  const path = u.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  const m = path.match(/\.(mp4|m4v|webm|mov|mkv|ogv|3gp)$/);
  return m ? m[1] : null;
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+(\.[a-z0-9]{2,4})$/i, '$1')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function suggestName(urlString, title) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return 'video.mp4';
  }
  const segment = safeDecode(u.pathname.split('/').filter(Boolean).pop() || '');
  const type = classify(u);
  const generic = !segment || /^(index|master|playlist|video|videoplayback|manifest|stream|chunklist|media)(\.|$)/i.test(segment);
  let base = segment.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (generic && title) base = title;
  base = sanitizeName(base) || 'video';
  const ext = type === 'hls' ? 'ts' : type && type !== 'video' ? type : 'mp4';
  return base + '.' + ext;
}

function findVideos(html, baseUrl) {
  const found = new Map();

  const add = (raw, source, strict) => {
    if (!raw) return;
    const value = String(raw).trim();
    if (!value || /^(blob|data|javascript):/i.test(value)) return;
    let u;
    try {
      u = new URL(value, baseUrl);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    let type = classify(u);
    if (!type) {
      if (strict) return;
      type = 'video';
    }
    u.hash = '';
    if (!found.has(u.href)) found.set(u.href, { url: u.href, type, source });
  };

  // 1. The page's own video players.
  for (const tag of html.match(/<(?:video|source)\b[^>]*>/gi) || []) {
    add(attr(tag, 'src'), 'player', false);
    add(attr(tag, 'data-src'), 'player', false);
  }

  // 2. Sharing tags that sites add for link previews.
  let title = '';
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    const content = attr(tag, 'content');
    if (!content) continue;
    if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key)) {
      add(content, 'meta', true);
    } else if (key === 'og:title' && !title) {
      title = content;
    }
  }
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = decodeEntities(t[1]);
  }
  title = sanitizeName(title.replace(/<[^>]*>/g, ''));

  // 3. Anything else that looks like a video link in the page or its scripts.
  const text = unescapeJs(decodeEntities(html));
  for (const m of text.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) add(m[1], 'page-data', true);
  for (const m of text.matchAll(ABSOLUTE_URL)) add(m[0], 'page-data', true);
  for (const m of text.matchAll(QUOTED_PATH)) add(m[2], 'page-data', true);

  return { title, videos: [...found.values()] };
}

module.exports = { findVideos, classify, suggestName, sanitizeName, decodeEntities };
