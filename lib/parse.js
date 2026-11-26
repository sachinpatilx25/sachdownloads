'use strict';

const EXT = 'mp4|m4v|webm|mov|mkv|ogv|3gp|m3u8';

const ABSOLUTE_URL = new RegExp(
  `https?:\\/\\/[^\\s"'<>\\\\)]+?\\.(?:${EXT})(?:\\?[^\\s"'<>\\\\)]*)?(?![\\w\\-/]|\\.\\w)`,
  'gi'
);
const QUOTED_PATH = new RegExp(
  `(["'])((?:\\.{0,2}\\/)?[^"'\\s<>\\\\]+?\\.(?:${EXT})(?:\\?[^"'\\s<>\\\\]*)?)\\1`,
  'gi'
);
const PREVIEW_RE = /(\.t\.mp4|thumb-|\/preview\/|\/thumbs\/|storyboard)/i;
const IGNORED_IFRAMES =
  /(accounts\.google\.com|googletagmanager\.com|google-analytics\.com|googlesyndication\.com|doubleclick\.net|facebook\.com\/plugins|recaptcha|hcaptcha|challenges\.cloudflare\.com)/i;

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

function unescapeJs(text) {
  return text
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':')
    .replace(/\\x2f/gi, '/')
    .replace(/\\x3a/gi, ':')
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
  const generic =
    !segment || /^(index|master|playlist|video|videoplayback|manifest|stream|chunklist|media)(\.|$)/i.test(segment);
  let base = segment.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (generic && title) base = title;
  base = sanitizeName(base) || 'video';
  const ext = type === 'hls' ? 'ts' : type && type !== 'video' ? type : 'mp4';
  return base + '.' + ext;
}

function extractTitle(html) {
  let title = '';
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    const content = attr(tag, 'content');
    if (key === 'og:title' && content && !title) title = content;
  }
  if (!title) {
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = decodeEntities(t[1]);
  }
  return sanitizeName(title.replace(/<[^>]*>/g, ''));
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
    if (PREVIEW_RE.test(u.href)) return;
    let type = classify(u);
    if (!type) {
      if (strict) return;
      type = 'video';
    }
    u.hash = '';
    if (!found.has(u.href)) found.set(u.href, { url: u.href, type, source });
  };

  for (const tag of html.match(/<(?:video|source)\b[^>]*>/gi) || []) {
    for (const a of ['src', 'data-src', 'data-video-src', 'data-hls', 'data-mp4']) {
      add(attr(tag, a), 'player', false);
    }
  }

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    const content = attr(tag, 'content');
    if (content && ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key)) {
      add(content, 'meta', true);
    }
  }

  const title = extractTitle(html);
  const text = unescapeJs(decodeEntities(html));

  for (const m of text.matchAll(
    /"(?:contentUrl|videoUrl|video_url|playbackUrl|hlsUrl|mp4Url|streamUrl|file)"\s*:\s*"([^"]+)"/gi
  )) {
    add(m[1], 'page-data', true);
  }
  for (const m of text.matchAll(ABSOLUTE_URL)) add(m[0], 'page-data', true);
  for (const m of text.matchAll(QUOTED_PATH)) add(m[2], 'page-data', true);

  return { title, videos: [...found.values()] };
}

function findEmbeds(html, baseUrl) {
  const embeds = [];
  const seen = new Set();
  for (const tag of html.match(/<iframe\b[^>]*>/gi) || []) {
    const raw = attr(tag, 'src') || attr(tag, 'data-src');
    if (!raw || /^(about|javascript|data):/i.test(raw.trim())) continue;
    let u;
    try {
      u = new URL(raw.trim(), baseUrl);
    } catch {
      continue;
    }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !IGNORED_IFRAMES.test(u.href) && !seen.has(u.href)) {
      seen.add(u.href);
      embeds.push(u.href);
    }
  }
  return embeds;
}

module.exports = { findVideos, findEmbeds, extractTitle, classify, suggestName, sanitizeName, decodeEntities };
