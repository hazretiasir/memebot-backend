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

        // Extract extension and safe title
        let ext = info.ext || (isAudio ? 'm4a' : 'mp4');
        const safeTitle = (info.title ?? 'video')
            .replace(/[^\w\-_\u00C0-\u024F]/g, '_')
            .replace(/_+/g, '_')
            .substring(0, 60)
            .trim();

        // Instead of giving Android a raw M3U8/AAC Twitter stream (which crashes Android's file player),
        // We will tell flutter to download from our server, and our server will proxy/transcode it safely to temp disk.
        let finalDownloadUrl = downloadUrl;
        let finalFilename = `${safeTitle}.${isAudio ? 'mp3' : ext}`;

        if (isAudio) {
            // Tell the flutter app to hit a new Proxy endpoint on our backend which handles the entire transcode securely.
            // Use the current host to build the proxy URL
            const host = req.get('host') || 'localhost:3000';
            const protocol = req.protocol || 'https';
            finalDownloadUrl = `${protocol}://${host}/api/downloader/proxy-audio?url=${encodeURIComponent(downloadUrl)}`;
        }

        console.log(`[Downloader] ✅ Resolved: ${finalFilename}`);
        return res.json({ downloadUrl: finalDownloadUrl, filename: finalFilename, referer: info.webpage_url ?? url });
    } catch (err) {
        console.error('[Downloader] ❌ Error:', err.message);
        return res.status(500).json({
            error: 'Video URL çözümlenemedi',
            details: err.message,
        });
    }
});

// ─── GET /api/downloader/proxy-audio ─────────────────────────────────────────
// Downloads the raw fragmented audio stream (like Twitter M3U8/AAC) and transcodes
// it into a clean MP3 file on the server's temp disk. Then sends the file with
// exact Content-Length so Android DownloadManager doesn't crash on playback.
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
ffmpeg.setFfmpegPath(ffmpegPath);

router.get('/proxy-audio', (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL is required');

    const tempFile = path.join(os.tmpdir(), `MemeBot_Audio_${Date.now()}.mp3`);

    console.log(`[Downloader Proxy] Transcoding Audio to TEMP MP3 -> ${url.substring(0, 50)}...`);

    ffmpeg(url)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .format('mp3')
        .on('error', (err) => {
            console.error('[FFmpeg Proxy Error]:', err.message);
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (!res.headersSent) res.status(500).end();
        })
        .on('end', () => {
            console.log('[Downloader Proxy] Transcoding complete. Sending file...');
            res.download(tempFile, 'MemeBot_Audio.mp3', (err) => {
                if (err) console.error('[Downloader Proxy] Send error:', err);
                // Cleanup temp file after streaming it completely
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            });
        })
        .save(tempFile);
});

module.exports = router;
