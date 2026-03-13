const express = require('express');
const router = express.Router();
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── POST /api/downloader/download ───────────────────────────────────────────
// For VIDEO: resolves direct CDN URL via yt-dlp → Flutter downloads from CDN.
// For AUDIO: skips metadata step, immediately returns a proxy-audio URL with
//            the original platform URL. yt-dlp handles Twitter auth inside proxy.
router.post('/download', async (req, res) => {
    const { url, format } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const isAudio = format === 'mp3';
    console.log(`[Downloader] Request: ${url} (format: ${format ?? 'mp4'})`);

    try {
        if (isAudio) {
            // Don't pre-resolve CDN URL for audio — Twitter CDN blocks raw server
            // requests. Let proxy-audio run yt-dlp with the original URL instead.
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const host = req.get('host');
            const proxyUrl = `${protocol}://${host}/api/downloader/proxy-audio?url=${encodeURIComponent(url)}`;
            console.log(`[Downloader] ✅ Audio → proxy route`);
            return res.json({
                downloadUrl: proxyUrl,
                filename: 'MemeBot_Audio.mp3',
                referer: url,
            });
        }

        // ── VIDEO: resolve direct CDN URL ─────────────────────────────────────
        const baseOpts = {
            dumpSingleJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            impersonate: 'chrome',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            addHeader: [
                'Referer:https://www.tiktok.com/',
                'Accept-Language:tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            ],
        };

        let info;
        try {
            info = await youtubedl(url, {
                ...baseOpts,
                format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
            });
        } catch (firstErr) {
            // Pinterest ve bazı platformlar ext kısıtlı format stringiyle başarısız olabiliyor.
            // "Requested format is not available" hatasında ext kısıtlaması olmadan tekrar dene.
            const errText = firstErr.stderr || firstErr.message || '';
            if (errText.includes('Requested format is not available')) {
                console.log('[Downloader] Format not found, retrying with "best"...');
                info = await youtubedl(url, { ...baseOpts, format: 'best' });
            } else {
                throw firstErr;
            }
        }

        let downloadUrl = info.url;
        if (!downloadUrl && Array.isArray(info.formats) && info.formats.length > 0) {
            const withUrls = info.formats.filter((f) => !!f.url);
            const preferred = withUrls
                .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none')
                .pop();
            downloadUrl = preferred?.url ?? withUrls.pop()?.url;
        }

        if (!downloadUrl) {
            return res.status(422).json({
                error: 'Bu platform için doğrudan URL çözümlenemedi. Lütfen başka bir link deneyin.',
            });
        }

        const ext = info.ext || 'mp4';
        const safeTitle = (info.title ?? 'video')
            .replace(/[^\w\-_\u00C0-\u024F]/g, '_')
            .replace(/_+/g, '_')
            .substring(0, 60)
            .trim();

        console.log(`[Downloader] ✅ Video resolved: ${safeTitle}.${ext}`);
        return res.json({
            downloadUrl,
            filename: `${safeTitle}.${ext}`,
            referer: info.webpage_url ?? url,
        });
    } catch (err) {
        console.error('[Downloader] ❌ Error details:', err.stderr || err.message);

        let userMessage = 'Video bilgileri alınamadı (API Hatası)';
        if (err.message.includes('403') || (err.stderr && err.stderr.includes('403'))) {
            userMessage = 'Bu video/platform şu an erişimi engelliyor (403). Lütfen farklı bir video veya link formatı deneyin.';
        } else if (err.message.includes('redirect') || (err.stderr && err.stderr.includes('redirect'))) {
            userMessage = 'Video linki yönlendirme döngüsüne girdi veya artık mevcut değil.';
        }

        return res.status(500).json({
            error: userMessage,
            details: err.stderr || err.message,
            tip: 'TikTok profil linki yerine doğrudan video linki kullanmayı deneyin.',
        });
    }
});

// ─── GET /api/downloader/proxy-audio ─────────────────────────────────────────
// Receives the ORIGINAL platform URL (e.g. twitter.com/…/video/1).
// Uses yt-dlp (with its built-in Twitter extractor + HLS support) to download
// the best audio and convert to clean MP3 via ffmpeg-static.
// Sends the file with Content-Length so Android can play it without issues.
router.get('/proxy-audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL is required');

    const tempId = Date.now();
    const tempDir = os.tmpdir();
    // yt-dlp will produce: tempBase.mp3  (after --extract-audio --audio-format mp3)
    const tempBase = path.join(tempDir, `MemeBot_${tempId}`);
    const tempMp3 = `${tempBase}.mp3`;

    console.log(`[Proxy Audio] yt-dlp download starting: ${url.substring(0, 70)}...`);

    try {
        await youtubedl(url, {
            // Output template: yt-dlp downloads native format, converts → .mp3
            output: `${tempBase}.%(ext)s`,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '128K',
            noWarnings: true,
            noCheckCertificates: true,
            // Point yt-dlp at the bundled ffmpeg-static binary
            ffmpegLocation: ffmpegPath,
        });

        if (!fs.existsSync(tempMp3)) {
            console.error('[Proxy Audio] MP3 not found after yt-dlp. Listing temp dir...');
            const candidates = fs.readdirSync(tempDir).filter(f => f.startsWith(`MemeBot_${tempId}`));
            console.error('[Proxy Audio] Candidates:', candidates);
            return res.status(500).json({ error: 'Ses dosyası oluşturulamadı. Lütfen tekrar deneyin.' });
        }

        console.log(`[Proxy Audio] ✅ MP3 ready. Sending to client...`);

        // res.download sets Content-Length from file stat → Android plays cleanly
        res.download(tempMp3, 'MemeBot_Audio.mp3', (err) => {
            if (err) console.error('[Proxy Audio] Send error:', err.message);
            // Clean up temp file and any intermediate files yt-dlp left behind
            fs.readdirSync(tempDir)
                .filter(f => f.startsWith(`MemeBot_${tempId}`))
                .forEach(f => { try { fs.unlinkSync(path.join(tempDir, f)); } catch { } });
        });

    } catch (err) {
        console.error('[Proxy Audio] ❌ yt-dlp error:', err.message);
        // Cleanup on error
        fs.readdirSync(tempDir)
            .filter(f => f.startsWith(`MemeBot_${tempId}`))
            .forEach(f => { try { fs.unlinkSync(path.join(tempDir, f)); } catch { } });

        if (!res.headersSent) {
            res.status(500).json({
                error: 'Ses indirilemedi',
                details: err.message,
            });
        }
    }
});

module.exports = router;
