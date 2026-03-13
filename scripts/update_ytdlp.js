#!/usr/bin/env node
/**
 * Downloads the latest yt-dlp binary from GitHub releases into ./bin/yt-dlp.
 * Runs automatically via `postinstall` in package.json.
 * On Windows (local dev) this is skipped gracefully.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

if (process.platform === 'win32') {
  console.log('[update-ytdlp] Windows detected — skipping binary download (use bundled yt-dlp).');
  process.exit(0);
}

const binDir  = path.join(__dirname, '..', 'bin');
const binPath = path.join(binDir, 'yt-dlp');
const url     = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

console.log('[update-ytdlp] Downloading latest yt-dlp...');

function download(url, dest, redirects = 0) {
  if (redirects > 10) { console.error('[update-ytdlp] Too many redirects'); process.exit(1); }

  https.get(url, { headers: { 'User-Agent': 'memebot-backend' } }, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      return download(res.headers.location, dest, redirects + 1);
    }
    if (res.statusCode !== 200) {
      console.error(`[update-ytdlp] HTTP ${res.statusCode} — skipping update.`);
      return; // Non-fatal: bundled binary will be used
    }

    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      fs.chmodSync(dest, 0o755);
      console.log(`[update-ytdlp] ✅ yt-dlp saved to ${dest}`);
    });
  }).on('error', (err) => {
    console.error('[update-ytdlp] Download error (non-fatal):', err.message);
  });
}

download(url, binPath);
