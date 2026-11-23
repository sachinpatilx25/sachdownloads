'use strict';

// Reads .m3u8 playlists. Only plain, unencrypted, finished streams are supported.

function absolute(uri, base) {
  return new URL(uri, base).href;
}

function parsePlaylist(text, baseUrl) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw Object.assign(new Error('That link is not a video playlist.'), { status: 422 });
  }

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bandwidth = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
      const resolution = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1] || '';
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (uri) variants.push({ uri: absolute(uri, baseUrl), bandwidth, resolution });
    }
    return { kind: 'master', variants };
  }

  const result = { kind: 'media', segments: [], map: null, encrypted: false, byteRange: false, endlist: false };
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY')) {
      if (/METHOD=(?!NONE)[A-Z0-9-]+/i.test(line)) result.encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP')) {
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      if (uri) result.map = absolute(uri, baseUrl);
      if (/BYTERANGE=/i.test(line)) result.byteRange = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      result.byteRange = true;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      result.endlist = true;
    } else if (!line.startsWith('#')) {
      result.segments.push(absolute(line, baseUrl));
    }
  }
  return result;
}

function pickVariant(variants) {
  return variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
}

module.exports = { parsePlaylist, pickVariant };
