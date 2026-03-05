const express = require('express');
const router = express.Router();
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Cookie setup ─────────────────────────────────────────────────────────────
const COOKIES_PATH = path.join(os.tmpdir(), 'yt_cookies.txt');
(function initCookies() {
    const b64 = process.env.YOUTUBE_COOKIES_B64;
    const raw = process.env.YOUTUBE_COOKIES;
    if (b64) {
        try {
            fs.writeFileSync(COOKIES_PATH, Buffer.from(b64, 'base64').toString('utf8'), 'utf8');
            console.log('[Downloader] Cookies loaded (base64), size:', fs.statSync(COOKIES_PATH).size);
        } catch (e) { console.error('[Downloader] Cookie write error:', e.message); }
    } else if (raw) {
        fs.writeFileSync(COOKIES_PATH, raw, 'utf8');
        console.log('[Downloader] Cookies loaded (raw)');
    } else {
        console.log('[Downloader] No cookies env found');
    }
})();

// ─── yt-dlp extraction ────────────────────────────────────────────────────────
async function tryYtdlp(url, isAudio) {
    // Try multiple player clients — different ones evade bot detection differently
    const clientCombos = [
        'ios,android_music',
        'tv_embedded,ios',
        'android_embedded,ios',
        'web_embedded,ios',
    ];

    for (const clients of clientCombos) {
        try {
            console.log(`[Downloader] yt-dlp attempt with player_client=${clients}`);
            const options = {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                noPlaylist: true,
                format: isAudio ? 'bestaudio[ext=m4a]/bestaudio' : 'best',
                extractorArgs: `youtube:player_client=${clients}`,
            };
            if (fs.existsSync(COOKIES_PATH)) options.cookies = COOKIES_PATH;

            const info = await youtubedl(url, options);
            const directUrl = info.url || info.requested_formats?.[0]?.url;
            if (directUrl) {
                console.log(`[Downloader] yt-dlp success with ${clients}`);
                return { downloadUrl: directUrl, ext: info.ext || (isAudio ? 'm4a' : 'mp4'), title: info.title };
            }
        } catch (e) {
            console.log(`[Downloader] yt-dlp(${clients}) failed: ${e.message?.substring(0, 120)}`);
        }
    }
    return null;
}

// ─── Cobalt fallback ──────────────────────────────────────────────────────────
const COBALT_INSTANCES = [
    'https://cobalt.api.timelessnesses.me/',
    'https://cobalt.pinapelz.moe/',
    'https://cob.freetard.eu.org/',
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
            const resp = await fetch(instance, {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(12000),
            });
            const data = await resp.json();
            if (data.url) {
                console.log(`[Downloader] cobalt success: ${instance}`);
                return { downloadUrl: data.url };
            }
            if (data.status === 'picker' && data.picker?.[0]?.url) {
                return { downloadUrl: data.picker[0].url };
            }
            console.log(`[Downloader] cobalt ${instance} → ${data.status || data.error?.code}`);
        } catch (e) {
            console.log(`[Downloader] cobalt ${instance} failed: ${e.message}`);
        }
    }
    return null;
}

// ─── Unsupported platforms ─────────────────────────────────────────────────────
function isUnsupported(url) {
    return /youtube\.com|youtu\.be|tiktok\.com|tiktokcdn/i.test(url);
}

function getReferer(originalUrl) {
    if (/instagram\.com/i.test(originalUrl)) return 'https://www.instagram.com/';
    if (/twitter\.com|x\.com/i.test(originalUrl)) return 'https://twitter.com/';
    if (/pinterest\./i.test(originalUrl))    return 'https://www.pinterest.com/';
    if (/reddit\.com/i.test(originalUrl))    return 'https://www.reddit.com/';
    return null;
}

// ─── POST /api/downloader/download ────────────────────────────────────────────
router.post('/download', async (req, res) => {
    const { url, format } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (isUnsupported(url)) {
        return res.status(400).json({
            error: 'YouTube ve TikTok desteklenmiyor. Instagram, Twitter, Pinterest veya Reddit linklerini deneyin.',
        });
    }

    const isAudio = format === 'mp3';
    console.log(`[Downloader] Request: ${url}`);

    let result = await tryYtdlp(url, isAudio);
    if (!result) result = await tryCobalt(url, isAudio);

    if (!result) {
        return res.status(500).json({
            error: 'Bu video indirilemedi. Lütfen daha sonra tekrar deneyin.',
        });
    }

    const ext = isAudio ? 'mp3' : (result.ext || 'mp4');
    res.json({
        downloadUrl: result.downloadUrl,
        filename: `MemeBot.${ext}`,
        referer: getReferer(url),
    });
});

module.exports = router;
