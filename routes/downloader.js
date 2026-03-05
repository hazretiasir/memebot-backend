const express = require('express');
const router = express.Router();
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── POST /api/downloader/download ───────────────────────────────────────────
router.post('/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const isAudio = format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    const filePath = path.join(os.tmpdir(), `memebot_${uuidv4()}.${ext}`);

    console.log(`[Downloader] Request received for: ${url} (format: ${ext})`);

    try {
        const options = {
            output: filePath,
            noWarnings: true,
            noCheckCertificates: true,
            // Bypass YouTube bot detection by using the Android/iOS player client
            extractorArgs: 'youtube:player_client=android,ios,web',
            noPlaylist: true,
        };

        if (isAudio) {
            options.extractAudio = true;
            options.audioFormat = 'mp3';
            options.audioQuality = 0;
        } else {
            // Prefer pre-merged mp4 to avoid ffmpeg dependency on Render.
            // Falls back to best available if no combined mp4 exists.
            options.format = 'best[ext=mp4]/best';
        }

        // Run youtube-dl
        await youtubedl(url, options);
        console.log(`[Downloader] Download completed to temp file: ${filePath}`);

        // Stream file back to client
        res.download(filePath, `MemeBot_Video.${ext}`, (err) => {
            if (err) {
                console.error('[Downloader] Error sending file to client:', err);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            }
            // Essential: Delete file to avoid filling up server disk
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[Downloader] Temp file deleted: ${filePath}`);
            }
        });

    } catch (err) {
        console.error('[Downloader] Download error:', err.message);
        // Cleanup if task failed mid-way
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.status(500).json({ error: 'Failed to process video', details: err.message });
    }
});

module.exports = router;
