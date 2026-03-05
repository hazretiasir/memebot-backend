const express = require('express');
const router = express.Router();

// ─── POST /api/downloader/download ───────────────────────────────────────────
// Uses cobalt.tools API — handles YouTube, TikTok, Twitter, Instagram, Reddit.
// Returns a direct CDN URL; Flutter downloads from there (no server storage).
router.post('/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const isAudio = format === 'mp3';
    console.log(`[Downloader] cobalt request for: ${url} (audio=${isAudio})`);

    try {
        const cobaltRes = await fetch('https://api.cobalt.tools/', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                url,
                videoQuality: '1080',
                audioFormat: isAudio ? 'mp3' : 'best',
                filenameStyle: 'basic',
                downloadMode: isAudio ? 'audio' : 'auto',
            }),
        });

        const data = await cobaltRes.json();
        console.log(`[Downloader] cobalt status: ${data.status}`);

        // cobalt returns: stream | redirect | tunnel | picker | error
        if (data.status === 'error') {
            return res.status(500).json({
                error: 'Downloader error',
                details: data.error?.code || JSON.stringify(data),
            });
        }

        // For "picker" (e.g. Instagram carousel), return the first item
        if (data.status === 'picker') {
            const first = data.picker?.[0];
            if (!first?.url) {
                return res.status(500).json({ error: 'No downloadable item found' });
            }
            return res.json({ downloadUrl: first.url, filename: `MemeBot.${isAudio ? 'mp3' : 'mp4'}` });
        }

        // stream / redirect / tunnel
        const downloadUrl = data.url;
        if (!downloadUrl) {
            return res.status(500).json({ error: 'No URL returned by cobalt', details: JSON.stringify(data) });
        }

        res.json({
            downloadUrl,
            filename: `MemeBot.${isAudio ? 'mp3' : 'mp4'}`,
        });

    } catch (err) {
        console.error('[Downloader] Error:', err.message);
        res.status(500).json({ error: 'Failed to process URL', details: err.message });
    }
});

module.exports = router;
