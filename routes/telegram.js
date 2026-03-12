const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client  = require('../config/aws');
const Video     = require('../models/Video');
const SearchLog = require('../models/SearchLog');
const { send: tg } = require('../utils/telegram_notify');

const CHAT_ID    = process.env.TELEGRAM_CHAT_ID  || '';
const GITHUB_PAT = process.env.GITHUB_PAT        || '';
const GITHUB_REPO = 'hazretiasir/memebot-backend';
const S3_BUCKET   = process.env.S3_BUCKET_NAME   || '';
const S3_MAX_GB   = 20.0;

function authorized(chatId) {
    return String(chatId) === String(CHAT_ID);
}

async function triggerWorkflow(workflowFile, inputs = {}) {
    await axios.post(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
        { ref: 'main', inputs },
        { headers: { Authorization: `Bearer ${GITHUB_PAT}`, Accept: 'application/vnd.github+json' } }
    );
}

// ── Komut işleyiciler ──────────────────────────────────────────────────────────

async function cmdStatus() {
    const total  = await Video.countDocuments();
    const posted = await Video.countDocuments({ everPosted: true });

    // S3 boyutu
    let sizeGB = 0, objCount = 0, token;
    try {
        do {
            const resp = await s3Client.send(new ListObjectsV2Command({
                Bucket: S3_BUCKET, ContinuationToken: token,
            }));
            for (const obj of resp.Contents || []) { sizeGB += obj.Size; objCount++; }
            token = resp.NextContinuationToken;
        } while (token);
        sizeGB = sizeGB / (1024 ** 3);
    } catch (_) { sizeGB = -1; }

    const s3Line = sizeGB >= 0
        ? `☁️ S3: ${objCount} obje — ${sizeGB.toFixed(2)} / ${S3_MAX_GB} GB (${(S3_MAX_GB - sizeGB).toFixed(2)} GB kaldı)`
        : `☁️ S3: erişim hatası`;

    tg(
        `📊 <b>MemeBot Durum</b>\n\n` +
        `🎬 Toplam video: <b>${total}</b>\n` +
        `📲 Paylaşılan:   <b>${posted}</b>\n` +
        `📦 Stok kalan:   <b>${total - posted}</b>\n\n` +
        s3Line
    );
}

async function cmdStok() {
    const total     = await Video.countDocuments();
    const posted    = await Video.countDocuments({ everPosted: true });
    const remaining = total - posted;
    const emoji     = remaining < 10 ? '🚨' : remaining < 20 ? '⚠️' : '✅';
    tg(`${emoji} <b>Video Stok</b>\n\nKalan: <b>${remaining}</b> / ${total}\nPaylaşılan: <b>${posted}</b>`);
}

async function cmdS3() {
    let totalBytes = 0, totalCount = 0, token;
    do {
        const resp = await s3Client.send(new ListObjectsV2Command({
            Bucket: S3_BUCKET, ContinuationToken: token,
        }));
        for (const obj of resp.Contents || []) { totalBytes += obj.Size; totalCount++; }
        token = resp.NextContinuationToken;
    } while (token);

    const gb        = totalBytes / (1024 ** 3);
    const remaining = S3_MAX_GB - gb;
    tg(
        `☁️ <b>S3 Bucket</b>\n\n` +
        `📁 Obje sayısı: <b>${totalCount}</b>\n` +
        `💾 Kullanılan:  <b>${gb.toFixed(2)} GB</b>\n` +
        `🆓 Kalan:       <b>${remaining.toFixed(2)} GB</b> / ${S3_MAX_GB} GB`
    );
}

async function cmdBugun() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const total  = await SearchLog.countDocuments({ createdAt: { $gte: since } });
    const top    = await SearchLog.aggregate([
        { $match:  { createdAt: { $gte: since } } },
        { $group:  { _id: '$query', count: { $sum: 1 } } },
        { $sort:   { count: -1 } },
        { $limit:  5 },
    ]);

    if (total === 0) { tg('🔍 Bugün henüz hiç arama yapılmadı.'); return; }

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const lines  = top.map((t, i) => `   ${medals[i]} <b>${t._id}</b> — ${t.count} kez`);
    tg(`🔍 <b>Bugünkü Aramalar (Mobil Uygulama)</b>\n\nToplam: <b>${total}</b>\n\n` + lines.join('\n'));
}

async function cmdSon() {
    const video = await Video.findOne({ everPosted: true })
        .sort({ socialPostedAt: -1 })
        .select('title socialPostedAt socialPlatforms');
    if (!video) { tg('Henüz hiç video paylaşılmamış.'); return; }
    const platforms = (video.socialPlatforms || []).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' + ');
    const date = video.socialPostedAt
        ? new Date(video.socialPostedAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
        : '?';
    tg(`📲 <b>Son Paylaşım</b>\n\n🎬 ${video.title}\n📅 ${date}\n📱 ${platforms || '?'}`);
}

async function cmdPost() {
    if (!GITHUB_PAT) { tg('❌ GITHUB_PAT tanımlı değil.'); return; }
    await triggerWorkflow('post_meme.yml');
    tg('🚀 <b>Post Meme</b> workflow tetiklendi — birkaç dakika içinde paylaşılacak.');
}

async function cmdScraper() {
    if (!GITHUB_PAT) { tg('❌ GITHUB_PAT tanımlı değil.'); return; }
    await triggerWorkflow('scraper.yml');
    tg('🕵️ <b>Scraper</b> workflow tetiklendi — çalışmaya başlıyor.');
}

function cmdYardim() {
    tg(
        `🤖 <b>MemeBot Komutları</b>\n\n` +
        `<b>Durum</b>\n` +
        `/status — genel sistem durumu\n` +
        `/stok — kalan video sayısı\n` +
        `/s3 — bucket boyutu\n` +
        `/bugun — bugünkü arama istatistikleri\n` +
        `/son — son paylaşılan video\n\n` +
        `<b>Kontrol</b>\n` +
        `/post — hemen video paylaştır\n` +
        `/scraper — scraper'ı başlat`
    );
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Telegram'a hemen 200 dön

    const message = req.body?.message;
    if (!message) return;
    if (!authorized(message.chat?.id)) return;

    const cmd = (message.text || '').trim().split(' ')[0].toLowerCase();

    try {
        if      (cmd === '/status')  await cmdStatus();
        else if (cmd === '/stok')    await cmdStok();
        else if (cmd === '/s3')      await cmdS3();
        else if (cmd === '/bugun')   await cmdBugun();
        else if (cmd === '/son')     await cmdSon();
        else if (cmd === '/post')    await cmdPost();
        else if (cmd === '/scraper') await cmdScraper();
        else if (cmd === '/yardim' || cmd === '/start') cmdYardim();
    } catch (err) {
        tg(`❌ Komut hatası (<code>${cmd}</code>):\n<code>${err.message}</code>`);
    }
});

module.exports = router;
