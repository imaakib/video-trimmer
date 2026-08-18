const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || 'PASTE_YOUR_PEXELS_KEY_HERE';
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || 'PASTE_YOUR_PIXABAY_KEY_HERE';

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function timeToSeconds(input) {
  if (input === undefined || input === null || input === '') return NaN;
  const str = String(input).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return NaN;
  for (const p of parts) if (!/^\d+(\.\d+)?$/.test(p)) return NaN;
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts.map(Number);
  else [m, s] = parts.map(Number);
  if (m >= 60 || s >= 60) return NaN;
  return h * 3600 + m * 60 + s;
}

function secondsToTimestamp(total) {
  const ms = Math.round((total % 1) * 1000);
  const whole = Math.floor(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function isValidRemoteUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function cleanupFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

function extractTrailingId(inputUrl) {
  const cleanUrl = inputUrl.split('?')[0].replace(/\/$/, '');
  const match = cleanUrl.match(/(\d{4,})(?!.*\d{4,})/);
  return match ? match[1] : null;
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

app.post('/api/trim', async (req, res) => {
  const { url, start, end } = req.body || {};

  if (!url || !isValidRemoteUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid http(s) video URL.' });
  }

  const startSeconds = timeToSeconds(start);
  const endSeconds = timeToSeconds(end);

  if (Number.isNaN(startSeconds) || startSeconds < 0) {
    return res.status(400).json({ error: 'Start time is invalid.' });
  }
  if (Number.isNaN(endSeconds) || endSeconds <= startSeconds) {
    return res.status(400).json({ error: 'End time must be greater than start time.' });
  }

  const duration = endSeconds - startSeconds;
  if (duration > 30) {
    return res.status(400).json({ error: 'Clips longer than 30 seconds are not supported.' });
  }

  let resolvedUrl;
  try {
    resolvedUrl = await resolveDirectVideoUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not resolve that video link.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(TEMP_DIR, `trim-${jobId}.mp4`);

  console.log(`[trim] Job ${jobId}: resolved=${resolvedUrl} start=${startSeconds}s duration=${duration}s`);

  // Stream copy: no decode/re-encode, so this uses very little memory
  // regardless of the source resolution, and never crashes on low-RAM servers.
  const command = ffmpeg(resolvedUrl)
    .inputOptions([
      '-user_agent', BROWSER_UA,
      '-ss', secondsToTimestamp(startSeconds),
    ])
    .duration(duration)
    .outputOptions([
      '-c', 'copy',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
    ])
    .format('mp4')
    .on('start', (cmd) => console.log(`[trim] Job ${jobId} ffmpeg: ${cmd}`))
    .on('error', (err) => {
      console.error(`[trim] Job ${jobId} failed:`, err.message);
      cleanupFile(outputPath);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process the video. Try a different link.' });
      }
    })
    .on('end', () => {
      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'Processing finished but no output file was produced.' });
      }
      res.download(outputPath, `trimmed-clip-${jobId}.mp4`, () => cleanupFile(outputPath));
    });

  command.save(outputPath);

  req.on('close', () => {
    if (!res.headersSent) {
      try { command.kill('SIGKILL'); } catch (_) {}
      cleanupFile(outputPath);
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Video Trimmer Pro running on port ${PORT}`);
});
