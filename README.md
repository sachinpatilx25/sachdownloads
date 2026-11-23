# Video Grabber

Paste a link to a video, or to a page that has one. The site finds the video file and lets you save it. It is built for phones, where there is no Network tab in the browser tools.

## Put it online (Vercel)

The site needs a small server part, because a browser alone is not allowed to read other websites' pages.

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New → Project**, import the repository, and press **Deploy**. No settings or packages are needed.
3. Open the address Vercel gives you.

## Use it

1. Paste a link into the box and tap **Find video**.
2. Tap **Download** on the result you want. The file goes to your browser's downloads.

If nothing is found, the page probably loads its video with JavaScript. Open **Video not found? Use the page helper** on the site. It gives you a bookmark that runs inside the page you are watching and lists the video files the page loaded. That is the same list the Network tab would show.

## What it can and cannot save

| Works | Does not work |
| --- | --- |
| Direct files: `.mp4`, `.webm`, `.mov`, `.mkv`, `.m4v`, `.ogv`, `.3gp` | YouTube, Netflix, Prime Video, Hotstar and similar |
| Plain `.m3u8` playlists that are finished and not encrypted (joined into one file) | Encrypted or live streams |
| Pages where the video is in the page's code | Videos that need you to be signed in |

Some playlist videos keep the sound in a separate stream. Those can come out without sound.

Only save videos you have the right to keep.

## Limits

- Each download must finish within 60 seconds on Vercel's free plan (`maxDuration` in `vercel.json`). Very large files on a slow source can be cut off.
- Files over 2 GB and playlists over 4,000 parts are refused.
- There is no sign-in or rate limiting. If you share the address widely, add a limit before you do.

## How it works

- `api/extract.js` opens the page and looks for video players, link-preview tags and video links in the page's code.
- `api/download.js` fetches the video and hands it to your browser as a download. Playlist videos are joined part by part.
- `lib/net.js` makes every outside request. It refuses private and internal addresses, checks every redirect, and only allows web ports.
- `index.html` is the whole front end. The page helper bookmark is built in it.

## Run it on a computer

```
npx vercel dev
```

Open the address it prints.
