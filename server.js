/**
 * server.js
 * ---------------------------------------------------------------------------
 * Ultra-premium video trimmer backend.
 * ---------------------------------------------------------------------------
 */

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

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function timeToSeconds(input) {
  if (input === undefined || input === null || input === '') return NaN;
  const str = String(input).trim();

  if (/^\d+(\.\d+)?$/.test(str)) {
    return parseFloat(str);
  }

  const parts = str.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return NaN;

  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return NaN;
  }

  let hours = 0, minutes = 0, seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts.map(Number);
  } else {
    [minutes, seconds] = parts.map(Number);
  }

  if (minutes >= 60 || seconds >= 60) return NaN;

  return hours * 3600 + minutes * 60 + seconds;
}

function secondsToTimestamp(totalSeconds) {
  const ms = Math.round((totalSeconds % 1) * 1000);
  const totalWhole = Math.floor(totalSeconds);
  const h = Math.floor(totalWhole / 3600);
  const m = Math.floor((totalWhole % 3600) / 60);
  const s = totalWhole % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function isValidRemoteUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function cleanupFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[cleanup] Failed to delete ${filePath}:`, err.message);
    } else {
      console.log(`[cleanup] Removed temp file: ${path.basename(filePath)}`);
    }
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegPath });
});

app.post('/api/trim', (req, res) => {
  const { url, start, end } = req.body || {};

  if (!url || !isValidRemoteUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid http(s) video URL.' });
  }

  const startSeconds = timeToSeconds(start);
  const endSeconds = timeToSeconds(end);

  if (Number.isNaN(startSeconds) || startSeconds < 0) {
    return res.status(400).json({ error: 'Start time is invalid. Use HH:MM:SS, MM:SS, or seconds.' });
  }
  if (Number.isNaN(endSeconds) || endSeconds <= startSeconds) {
    return res.status(400).json({ error: 'End time must be a valid time greater than the start time.' });
  }

  const duration = endSeconds - startSeconds;
  if (duration > 60 * 30) {
    return res.status(400).json({ error: 'Clips longer than 30 minutes are not supported.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const outputPath = path.join(TEMP_DIR, `trim-${jobId}.mp4`);

  console.log(`[trim] Job ${jobId}: url=${url} start=${startSeconds}s duration=${duration}s`);

  const command = ffmpeg(url)
    .inputOptions([
      '-ss', secondsToTimestamp(startSeconds),
    ])
    .duration(duration)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions([
      '-preset', 'veryfast',
      '-crf', '18',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
    ])
    .format('mp4')
    .on('start', (cmdLine) => {
      console.log(`[trim] Job ${jobId} ffmpeg command: ${cmdLine}`);
    })
    .on('error', (err) => {
      console.error(`[trim] Job ${jobId} failed:`, err.message);
      cleanupFile(outputPath);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to process the video. Check the URL and try again.' });
      }
    })
    .on('end', () => {
      console.log(`[trim] Job ${jobId} finished. Sending file to client.`);

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'Processing finished but no output file was produced.' });
      }

      const downloadName = `trimmed-clip-${jobId}.mp4`;

      res.download(outputPath, downloadName, (err) => {
        if (err) {
          console.error(`[trim] Job ${jobId} download error:`, err.message);
        }
        cleanupFile(outputPath);
      });
    });

  command.save(outputPath);

  req.on('close', () => {
    if (!res.headersSent) {
      try {
        command.kill('SIGKILL');
      } catch (_) { /* already finished */ }
      cleanupFile(outputPath);
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Video Trimmer Pro running at http://localhost:${PORT}`);
  console.log(`   Using ffmpeg binary: ${ffmpegPath}`);
});
