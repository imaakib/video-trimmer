const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || 'PASTE_YOUR_PEXELS_KEY_HERE';
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || 'PASTE_YOUR_PIXABAY_KEY_HERE';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function extractTrailingId(inputUrl) {
  const cleanUrl = inputUrl.split('?')[0].replace(/\/$/, '');
  const match = cleanUrl.match(/(\d{4,})(?!.*\d{4,})/);
  return match ? match[1] : null;
}

function isValidRemoteUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function resolveDirectVideoUrl(inputUrl) {
  const parsed = new URL(inputUrl);
  const host = parsed.hostname.replace(/^www\./, '');

  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(parsed.pathname)) {
    return inputUrl;
  }

  if (host.includes('pexels.com')) {
    const id = extractTrailingId(inputUrl);
    if (!id) throw new Error('Could not find a Pexels video ID in that link.');
    if (!PEXELS_API_KEY || PEXELS_API_KEY.startsWith('PASTE_')) {
      throw new Error('Server is missing a valid Pexels API key.');
    }
    const resp = await fetch(`https://api.pexels.com/videos/videos/${id}`, {
      headers: { Authorization: PEXELS_API_KEY },
    });
    const bodyText = await resp.text();
    if (!resp.ok) throw new Error(`Pexels API error (status ${resp.status}).`);
    const data = JSON.parse(bodyText);
    const files = (data.video_files || []).filter((f) => f.file_type === 'video/mp4');
    const best = files.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (!best) throw new Error('No downloadable file found for that Pexels video.');
    return best.link;
  }

  if (host.includes('pixabay.com')) {
    const id = extractTrailingId(inputUrl);
    if (!id) throw new Error('Could not find a Pixabay video ID in that link.');
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY.startsWith('PASTE_')) {
      throw new Error('Server is missing a valid Pixabay API key.');
    }
    const resp = await fetch(`https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&id=${id}`);
    const bodyText = await resp.text();
    if (!resp.ok) throw new Error(`Pixabay API error (status ${resp.status}).`);
    const data = JSON.parse(bodyText);
    const hit = data.hits && data.hits[0];
    if (!hit) throw new Error('No video found for that Pixabay ID.');
    const videos = hit.videos || {};
    const best = videos.large || videos.medium || videos.small || videos.tiny;
    if (!best || !best.url) throw new Error('No downloadable file found for that Pixabay video.');
    return best.url;
  }

  return inputUrl;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Just looks up the real link. No video processing happens here.
app.post('/api/resolve', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidRemoteUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid http(s) video URL.' });
  }
  try {
    const videoUrl = await resolveDirectVideoUrl(url);
    res.json({ videoUrl });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not resolve that video link.' });
  }
});

// Lightweight passthrough proxy so the browser can safely capture/record the
// video stream (avoids third-party CORS restrictions). Just pipes bytes —
// no decoding, no buffering the whole file, so it uses very little memory.
app.get('/api/stream', async (req, res) => {
  const target = req.query.url;
  if (!target || !isValidRemoteUrl(target)) {
    return res.status(400).send('Invalid url');
  }
  try {
    const upstream = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
    res.status(upstream.status);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    if (upstream.headers.get('content-length')) res.set('Content-Length', upstream.headers.get('content-length'));
    if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range'));
    res.set('Accept-Ranges', 'bytes');
    upstream.body.pipeTo(
      new WritableStream({
        write(chunk) { res.write(chunk); },
        close() { res.end(); },
      })
    ).catch(() => res.end());
  } catch (err) {
    res.status(502).send('Could not fetch video');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Trimmer Pro (no-FFmpeg) running on port ${PORT}`);
});
