'use strict';

// Safe outbound requests. The server fetches pages and videos on the visitor's
// behalf, so every hop (including redirects and DNS answers) is checked to
// make sure it points at the public internet and never at private addresses.

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Mobile Safari/537.36';

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

// Local testing only. Never set this on a deployed site.
const ALLOW_PRIVATE = process.env.VG_ALLOW_PRIVATE === '1';

// Node's BlockList treats IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) as the
// IPv4 address itself, so the IPv4 ranges below also cover those.
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

// Runs at connect time, so a hostname cannot answer "public" during a check
// and "private" when the connection is actually made.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => !isBlockedIp(a.address));
    if (!ok.length) return callback(httpError(400, 'That address is not allowed.'));
    if (options && options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

function request(urlString, { method = 'GET', headers = {}, maxRedirects = 5, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;

    const go = (current) => {
      let u;
      try {
        u = new URL(current);
        assertAllowed(u);
      } catch (e) {
        return reject(e.status ? e : httpError(400, 'That is not a valid link.'));
      }

      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        {
          method,
          lookup: safeLookup,
          timeout,
          headers: {
            'User-Agent': UA,
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity',
            ...headers,
          },
        },
        (res) => {
          const code = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            res.resume();
            if (++hops > maxRedirects) return reject(httpError(508, 'Too many redirects.'));
            try {
              return go(new URL(res.headers.location, u).href);
            } catch {
              return reject(httpError(502, 'The site sent a broken redirect.'));
            }
          }
          res.finalUrl = u.href;
          resolve(res);
        }
      );

      req.on('timeout', () => req.destroy(httpError(504, 'The site took too long to answer.')));
      req.on('error', (e) =>
        reject(e.status ? e : httpError(502, 'Could not reach that site (' + (e.code || e.message) + ').'))
      );
      req.end();
    };

    go(urlString);
  });
}

function decodedStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  return res;
}

// Reads at most maxBytes of text from a response, then stops.
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

module.exports = { request, readBody, httpError, sendJson, sendError, isBlockedIp, UA };
