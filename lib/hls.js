'use strict';

function absolute(uri, base) {
  return new URL(uri, base).href;
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,\s]+))/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

function parseByteRange(raw, fallbackOffset) {
  const m = String(raw || '').match(/^(\d+)(?:@(\d+))?$/);
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] !== undefined ? Number(m[2]) : fallbackOffset;
  return { offset, end: offset + length - 1, nextOffset: offset + length };
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
    const audioTracks = new Map();
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if ((attrs.TYPE || '').toUpperCase() === 'AUDIO' && attrs['GROUP-ID'] && attrs.URI) {
        const list = audioTracks.get(attrs['GROUP-ID']) || [];
        list.push({
          uri: absolute(attrs.URI, baseUrl),
          name: attrs.NAME || attrs.LANGUAGE || 'Audio',
          isDefault: attrs.DEFAULT === 'YES',
        });
        audioTracks.set(attrs['GROUP-ID'], list);
      }
    }

    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseAttrs(lines[i].slice('#EXT-X-STREAM-INF:'.length));
      const bandwidth = Number(attrs.BANDWIDTH) || 0;
      const resolution = attrs.RESOLUTION || '';
      const heightMatch = resolution.match(/x(\d+)$/);
      const height = heightMatch ? Number(heightMatch[1]) : 0;
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (uri) {
        const audioGroup = attrs.AUDIO ? audioTracks.get(attrs.AUDIO) || null : null;
        const primaryAudio = audioGroup ? audioGroup.find((a) => a.isDefault) || audioGroup[0] : null;
        variants.push({
          uri: absolute(uri, baseUrl),
          bandwidth,
          resolution,
          height,
          audioUri: primaryAudio ? primaryAudio.uri : null,
        });
      }
    }
    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return { kind: 'master', variants };
  }

  const result = {
    kind: 'media',
    segments: [],
    map: null,
    drm: false,
    endlist: false,
  };

  let currentKey = null;
  let pendingRange = null;
  let nextOffset = 0;
  let seq = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      const keyformat = (attrs.KEYFORMAT || 'identity').toLowerCase();
      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128' && attrs.URI && (keyformat === 'identity' || !attrs.KEYFORMAT)) {
        currentKey = {
          method,
          uri: absolute(attrs.URI, baseUrl),
          iv: attrs.IV || null,
        };
      } else {
        result.drm = true;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        const br = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null;
        result.map = {
          uri: absolute(attrs.URI, baseUrl),
          range: br ? [br.offset, br.end] : null,
        };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const br = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), nextOffset);
      if (br) {
        pendingRange = [br.offset, br.end];
        nextOffset = br.nextOffset;
      }
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      result.endlist = true;
    } else if (!line.startsWith('#')) {
      result.segments.push({
        uri: absolute(line, baseUrl),
        range: pendingRange,
        key: currentKey,
        sequence: seq++,
      });
      pendingRange = null;
    }
  }

  return result;
}

function pickVariant(variants) {
  return variants.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0] || null;
}

module.exports = { parsePlaylist, pickVariant };
