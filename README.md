# Video Grabber

Paste a link to a video or to a video page (YouTube, Vimeo, Dailymotion, X/Twitter, Reddit, embedded players, direct MP4/WebM, or HLS `.m3u8` streams) and save it directly from the browser.

## Put it online (Vercel)

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New -> Project**, import the repository, and deploy.
3. Open the deployed URL.

## What changed
- Added native platform extraction (`lib/platforms.js`) for YouTube (`ANDROID_VR`), Vimeo player config, Dailymotion player metadata, X/Twitter (`fxtwitter`), and Reddit JSON.
- Added cookie jar tracking across HTTP redirects and `Range` fallback probing (`lib/net.js`) so servers that reject `HEAD` requests still resolve cleanly.
- Added `<iframe>` embed traversal and expanded JSON/player URL detection (`lib/parse.js`).
- Added HLS `#EXT-X-BYTERANGE`, `#EXT-X-MAP` byte-range, master playlist quality expansion, separate audio track listing, and standard non-DRM `AES-128` segment decryption (`lib/hls.js`, `api/download.js`).
- Removed duplicate `check=1` preflight downloads and added direct/proxied download buttons with clear video/audio labels (`index.html`).

## Run locally

```bash
npx vercel dev
```
