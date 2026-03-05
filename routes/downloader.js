const express = require('express');
const router = express.Router();

// Public cobalt instances — tried in order until one succeeds.
// See: https://instances.cobalt.best
const COBALT_INSTANCES = [
    'https://cobalt.api.timelessnesses.me/',
    'https://cobalt.pinapelz.moe/',
    'https://cob.freetard.eu.org/',
    'https://cobalt.esmailelbob.xyz/',
];

async function tryCobalt(url, isAudio) {
    const body = JSON.stringify({
        url,
        videoQuality: '1080',
        audioFormat: isAudio ? 'mp3' : 'best',
        filenameStyle: 'basic',
        downloadMode: isAudio ? 'audio' : 'auto',
    });

    for (const instance of COBALT_INSTANCES) {
        try {
            console.log(`[Downloader] Trying cobalt instance: ${instance}`);
            const resp = await fetch(instance, {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(15000),
            });
            const data = await resp.json();

            if (data.status === 'error' || data.error) {
                console.log(`[Downloader] ${instance} → error: ${data.error?.code || data.error}`);
                continue; // try next instance
            }

            if (data.status === 'picker') {
                const first = data.picker?.[0];
                if (first?.url) return { downloadUrl: first.url };
                continue;
            }

            if (data.url) {
                return { downloadUrl: data.url };
            }
        } catch (e) {
            console.log(`[Downloader] ${instance} → failed: ${e.message}`);
        }
    }
    return null;
}

// ─── POST /api/downloader/download ───────────────────────────────────────────
router.post('/download', async (req, res) => {
    const { url, format } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const isAudio = format === 'mp3';
    console.log(`[Downloader] Request: ${url} (audio=${isAudio})`);

    try {
        const result = await tryCobalt(url, isAudio);
        if (!result) {
            return res.status(500).json({
                error: 'Tüm indirme sunucuları başarısız oldu. Lütfen daha sonra tekrar deneyin.',
            });
        }

        res.json({
            downloadUrl: result.downloadUrl,
            filename: `MemeBot.${isAudio ? 'mp3' : 'mp4'}`,
        });
    } catch (err) {
        console.error('[Downloader] Unexpected error:', err.message);
        res.status(500).json({ error: 'Beklenmeyen hata', details: err.message });
    }
});

module.exports = router;
