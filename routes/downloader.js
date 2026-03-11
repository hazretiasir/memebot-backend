const express = require('express');
const router = express.Router();
const youtubedl = require('youtube-dl-exec');

// ─── POST /api/downloader/download ───────────────────────────────────────────
// Backend is a **URL resolver only** — it finds the direct CDN link and hands
// it back to the Flutter client, which downloads the file itself. This keeps
// the Render server completely free of disk & bandwidth load.
router.post('/download', async (req, res) => {
    const { url, format } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const isAudio = format === 'mp3';
    console.log(`[Downloader] Resolving URL for: ${url} (format: ${format ?? 'mp4'})`);

    try {
        // Pull full JSON metadata without downloading anything
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            // Prefer a single-stream progressive MP4 so the client can play it
            // without needing FFmpeg for merging. Falls back to best available.
            format: isAudio
                ? 'bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio'
                : 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
        });

        // Resolve the best direct URL from the metadata
        let downloadUrl = info.url; // single-stream URL (most platforms)

        if (!downloadUrl && Array.isArray(info.formats) && info.formats.length > 0) {
            // Pick the highest-quality format that has a direct URL
            const withUrls = info.formats.filter((f) => !!f.url);
            const preferred = withUrls
                .filter((f) => isAudio ? f.vcodec === 'none' : f.acodec !== 'none')
                .pop();
            downloadUrl = preferred?.url ?? withUrls.pop()?.url;
        }

        if (!downloadUrl) {
            return res.status(422).json({
                error: 'Bu platform için doğrudan URL çözümlenemedi. Lütfen başka bir link deneyin.',
            });
        }

        // Determine real extension from metadata or direct URL to prevent codec mismatch
        let ext = info.ext || (isAudio ? 'm4a' : 'mp4');
        if (downloadUrl.includes('.mp3')) ext = 'mp3';
        else if (downloadUrl.includes('.webm')) ext = 'webm';
        else if (downloadUrl.includes('.m4a') && ext !== 'mp3') ext = 'm4a';
        else if (downloadUrl.includes('.aac')) ext = 'aac';

        const safeTitle = (info.title ?? 'video')
            .replace(/[^\w\-_\u00C0-\u024F]/g, '_')
            .replace(/_+/g, '_')
            .substring(0, 60)
            .trim();
        const filename = `${safeTitle}.${ext}`;
        const referer = info.webpage_url ?? url;

        console.log(`[Downloader] ✅ Resolved: ${filename}`);
        return res.json({ downloadUrl, filename, referer });
    } catch (err) {
        console.error('[Downloader] ❌ Error:', err.message);
        return res.status(500).json({
            error: 'Video URL çözümlenemedi',
            details: err.message,
        });
    }
});

module.exports = router;
