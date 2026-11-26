'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const ALLOW_PRIVATE = process.env.VG_ALLOW_PRIVATE === '1';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isBlockedIp(ip) {
  if (ALLOW_PRIVATE) return false;
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function assertAllowed(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError(400, 'Only http and https links work.');
  }
  if (u.username || u.password) {
    throw httpError(400, 'Links with a username or password are not supported.');
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!ALLOW_PRIVATE && !ALLOWED_PORTS.has(port)) {
    throw httpError(400, 'That port is not allowed.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) {
    throw httpError(400, 'That address is not allowed.');
  }
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => !isBlockedIp(a.address));
    if (!ok.length) return callback(httpError(400, 'That address is not allowed.'));
    if (options && options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

function mergeCookies(jar, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of list) {
    const pair = String(raw).split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

function cookieHeader(jar) {
  if (!jar.size) return '';
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function request(urlString, { method = 'GET', headers = {}, body = null, maxRedirects = 6, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const jar = new Map();

    const go = (current, reqMethod, reqBody) => {
      let u;
      try {
        u = new URL(current);
        assertAllowed(u);
      } catch (e) {
        return reject(e.status ? e : httpError(400, 'That is not a valid link.'));
      }

      const hdrs = {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers,
      };
      const jarVal = cookieHeader(jar);
      if (jarVal) {
        hdrs.Cookie = hdrs.Cookie ? `${hdrs.Cookie}; ${jarVal}` : jarVal;
      }

      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        {
          method: reqMethod,
          lookup: safeLookup,
          timeout,
          headers: hdrs,
        },
        (res) => {
          mergeCookies(jar, res.headers['set-cookie']);
          const code = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            res.resume();
            if (++hops > maxRedirects) return reject(httpError(508, 'Too many redirects.'));
            try {
              const nextUrl = new URL(res.headers.location, u).href;
              const nextMethod = code === 303 || ((code === 301 || code === 302) && reqMethod === 'POST') ? 'GET' : reqMethod;
              const nextBody = nextMethod === 'GET' ? null : reqBody;
              return go(nextUrl, nextMethod, nextBody);
            } catch {
              return reject(httpError(502, 'The site sent a broken redirect.'));
            }
          }
          res.finalUrl = u.href;
          res.cookieJarHeader = cookieHeader(jar);
          resolve(res);
        }
      );

      req.on('timeout', () => req.destroy(httpError(504, 'The site took too long to answer.')));
      req.on('error', (e) =>
        reject(e.status ? e : httpError(502, 'Could not reach that site (' + (e.code || e.message) + ').'))
      );
      if (reqBody) req.write(reqBody);
      req.end();
    };

    go(urlString, method, body);
  });
}

function decodedStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  return res;
}

function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const stream = decodedStream(res);
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
        stream.destroy();
        res.destroy();
        return finish();
      }
      chunks.push(chunk);
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (e) => (finished ? null : reject(e)));
    res.on('error', (e) => (finished ? null : reject(e)));
  });
}

function readBuffer(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    };
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        return reject(httpError(413, 'Upstream response exceeded limit.'));
      }
      chunks.push(chunk);
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', (e) => (finished ? null : reject(e)));
  });
}

async function probeMedia(url, headers = {}, timeout = 5000) {
  let r = await request(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-1023' }, timeout });
  if (r.statusCode === 416) {
    r.resume();
    r = await request(url, { method: 'HEAD', headers, timeout });
  }
  const ctype = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const cr = String(r.headers['content-range'] || '');
  const m = cr.match(/\/(\d+)$/);
  const size = m ? Number(m[1]) : Number(r.headers['content-length']) || 0;
  const status = r.statusCode || 0;
  const finalUrl = r.finalUrl || url;
  r.destroy();
  return { status, ctype, size, finalUrl };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (!err || !err.status) console.error(err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, (err && err.status) || 500, {
    error: err && err.status ? err.message : 'Something went wrong on the server.',
  });
}

module.exports = {
  request,
  readBody,
  readBuffer,
  probeMedia,
  httpError,
  sendJson,
  sendError,
  isBlockedIp,
  UA,
  MOBILE_UA,
};
