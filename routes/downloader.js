const express = require('express');
const router = express.Router();
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Write YouTube cookies once at startup ────────────────────────────────────
const COOKIES_PATH = path.join(os.tmpdir(), 'yt_cookies.txt');
(function initCookies() {
    const b64 = process.env.YOUTUBE_COOKIES_B64;
    const raw = process.env.YOUTUBE_COOKIES;
    if (b64) {
        fs.writeFileSync(COOKIES_PATH, Buffer.from(b64, 'base64').toString('utf8'), 'utf8');
        console.log('[Downloader] YouTube cookies loaded from base64 env.');
    } else if (raw) {
        fs.writeFileSync(COOKIES_PATH, raw, 'utf8');
        console.log('[Downloader] YouTube cookies loaded from raw env.');
    }
})();

// ─── POST /api/downloader/download ───────────────────────────────────────────
// Returns a direct CDN URL — Flutter downloads from there directly.
// This avoids Render timeout and disk usage entirely.
router.post('/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const isAudio = format === 'mp3';
    console.log(`[Downloader] Fetching CDN URL for: ${url} (format: ${format})`);

    try {
        const options = {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            noPlaylist: true,
            // No format restriction — let yt-dlp pick the best available
            format: isAudio ? 'bestaudio[ext=m4a]/bestaudio/bestaudio' : 'best',
        };

        if (fs.existsSync(COOKIES_PATH)) {
            options.cookies = COOKIES_PATH;
        }

        const info = await youtubedl(url, options);

        // Extract direct stream URL
        const directUrl = info.url
            || (info.requested_formats && info.requested_formats[0]?.url)
            || null;

        if (!directUrl) {
            return res.status(500).json({ error: 'Could not extract direct URL' });
        }

        const ext = info.ext || (isAudio ? 'm4a' : 'mp4');
        const safeTitle = (info.title || 'MemeBot_Video').replace(/[^a-z0-9_\- ]/gi, '_').substring(0, 60);

        console.log(`[Downloader] CDN URL resolved for: ${safeTitle}`);
        res.json({
            downloadUrl: directUrl,
            filename: `${safeTitle}.${ext}`,
            title: info.title,
            ext,
        });

    } catch (err) {
        console.error('[Downloader] Error:', err.message);
        res.status(500).json({ error: 'Failed to process URL', details: err.message });
    }
});

module.exports = router;
