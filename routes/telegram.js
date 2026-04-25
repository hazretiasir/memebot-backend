const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client  = require('../config/aws');
const Video     = require('../models/Video');
const SearchLog = require('../models/SearchLog');
const { send: tg } = require('../utils/telegram_notify');
const admin = require('firebase-admin');
const DeviceToken = require('../models/DeviceToken');

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

// ── Telegram Yardımcıları ──────────────────────────────────────────────────────

async function editTelegramMessage(chatId, messageId, newText) {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: newText,
            parse_mode: 'HTML'
        });
    } catch(err) {
        console.error('Telegram editMessage hatası:', err.message);
    }
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

async function cmdSetToken(args) {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) {
        tg(
            '❌ Eksik parametre.\n\nKullanım:\n' +
            '<code>/settoken twitter TOKEN</code>\n' +
            '<code>/settoken tiktok_refresh TOKEN</code>\n' +
            '<code>/settoken instagram SESSION_ID</code>'
        );
        return;
    }

    const type  = parts[0].toLowerCase();
    const value = parts[1];

    const keyMap = {
        twitter:        'twitter_auth_token',
        tiktok_refresh: 'tiktok_refresh_token',
        instagram:      'instagram_session_id',
    };

    const key = keyMap[type];
    if (!key) {
        tg(`❌ Geçersiz token tipi: <code>${type}</code>\nGeçerliler: twitter, tiktok_refresh, instagram`);
        return;
    }

    const cfg = require('mongoose').connection.db.collection('config');
    await cfg.updateOne(
        { key },
        { $set: { key, value, refreshed_at: new Date() } },
        { upsert: true }
    );

    tg(`✅ <b>${type}</b> token MongoDB'ye kaydedildi.\n\n⚠️ Bu mesajı şimdi sil!`);
}

async function cmdTokens() {
    const cfg = require('mongoose').connection.db.collection('config');

    const igDoc = await cfg.findOne({ key: 'instagram_session_id' });
    const ttDoc = await cfg.findOne({ key: 'tiktok_refresh_token' });
    const twDoc = await cfg.findOne({ key: 'twitter_auth_token' });

    // Instagram
    let igLine;
    if (igDoc?.refreshed_at) {
        const ageDays = Math.floor((Date.now() - new Date(igDoc.refreshed_at)) / 86400000);
        const emoji = ageDays > 30 ? '🟡' : '🟢';
        igLine = `${emoji} <b>Instagram:</b> session_id ${ageDays} gün önce güncellendi`;
    } else {
        igLine = `⚪ <b>Instagram:</b> MongoDB'de session_id kaydı yok (env var kullanılıyor)`;
    }

    // TikTok
    let ttLine;
    if (ttDoc?.refreshed_at) {
        const ageDays = Math.floor((Date.now() - new Date(ttDoc.refreshed_at)) / 86400000);
        ttLine = `🟢 <b>TikTok:</b> ${ageDays} gün önce yenilendi (MongoDB'de kayıtlı)`;
    } else {
        ttLine = `⚪ <b>TikTok:</b> henüz MongoDB'ye kaydedilmedi (ilk paylaşımda kaydedilecek)`;
    }

    // Twitter
    let twLine;
    if (twDoc?.refreshed_at) {
        const ageDays = Math.floor((Date.now() - new Date(twDoc.refreshed_at)) / 86400000);
        twLine = `🟢 <b>Twitter:</b> ${ageDays} gün önce güncellendi (MongoDB'de kayıtlı)`;
    } else {
        twLine = `⚪ <b>Twitter:</b> MongoDB'de kayıt yok (hardcoded fallback kullanılıyor)`;
    }

    tg(`🔑 <b>Token Durumları</b>\n\n${igLine}\n${ttLine}\n${twLine}\n\n💡 Güncellemek için:\n<code>/settoken twitter TOKEN</code>`);
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
        `/scraper — scraper'ı başlat\n` +
        `/tokens — token durumları\n` +
        `/settoken [twitter|tiktok_refresh|instagram] SESSION_ID`
    );
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Telegram'a hemen 200 dön

    // ─── CALLBACK QUERY (Buton Tıklamaları - Moderasyon) ──────────────────────────
    if (req.body?.callback_query) {
        const cb = req.body.callback_query;
        if (!authorized(cb.message?.chat?.id)) return;
        
        const data = cb.data; // e.g. "approve_123" veya "reject_123"
        const chatId = cb.message.chat.id;
        const msgId = cb.message.message_id;

        try {
            if (data.startsWith('approve_')) {
                const videoId = data.replace('approve_', '');
                await Video.findByIdAndUpdate(videoId, { isApproved: true });
                
                const newText = `✅ <b>VİDEO ONAYLANDI</b>\n\nVideo başarıyla keşfet akışına dahil edildi ve artık tüm kullanıcılara gösteriliyor.`;
                await editTelegramMessage(chatId, msgId, newText);
            } 
            else if (data.startsWith('reject_')) {
                const videoId = data.replace('reject_', '');
                const video = await Video.findById(videoId);
                if (video) {
                    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
                    // Delete from S3
                    if (video.s3Key) await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: video.s3Key })).catch(()=>{});
                    if (video.thumbnailKey) await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: video.thumbnailKey })).catch(()=>{});
                    // Delete from DB
                    await Video.findByIdAndDelete(videoId);
                }
                const newText = `❌ <b>VİDEO REDDEDİLDİ</b>\n\nVideo ve ona ait medyalar (thumbnail dahil) AWS S3'ten kalıcı olarak silindi.`;
                await editTelegramMessage(chatId, msgId, newText);
            }
        } catch (err) {
            console.error('Webhook callback hatası:', err);
        }
        return;
    }

    const message = req.body?.message;
    if (!message) return;
    if (!authorized(message.chat?.id)) return;

    const fullText = (message.text || '').trim();
    const cmd = fullText.split(' ')[0].toLowerCase();
    const args = fullText.substring(cmd.length).trim();

    try {
        if      (cmd === '/status')  await cmdStatus();
        else if (cmd === '/stok')    await cmdStok();
        else if (cmd === '/s3')      await cmdS3();
        else if (cmd === '/bugun')   await cmdBugun();
        else if (cmd === '/son')     await cmdSon();
        else if (cmd === '/post')    await cmdPost();
        else if (cmd === '/scraper') await cmdScraper();
        else if (cmd === '/tokens')   await cmdTokens();
        else if (cmd === '/settoken') await cmdSetToken((message.text || '').slice('/settoken'.length));
        else if (cmd === '/duyuru') {
            if (!args) {
                tg('❌ Kullanım: <code>/duyuru [Mesajınız]</code>');
                return;
            }
            tg(`📢 Duyuru gönderimi başlatılıyor...\nMesaj: <i>${args}</i>`);
            try {
                const tokens = await DeviceToken.find({}).select('token -_id').lean();
                if (tokens.length === 0) {
                    tg('❌ Sistemde kayıtlı cihaz tokenı bulunamadı.');
                } else {
                    const tokenList = tokens.map(t => t.token);
                    
                    // Chunk the tokens in groups of 500
                    let success = 0, fail = 0;
                    for (let i = 0; i < tokenList.length; i += 500) {
                        const chunk = tokenList.slice(i, i + 500);
                        const msgObj = {
                            notification: { title: 'MemeBot', body: args },
                            tokens: chunk
                        };
                        const response = await admin.messaging().sendEachForMulticast(msgObj);
                        success += response.successCount;
                        fail += response.failureCount;
                    }
                    tg(`✅ <b>Duyuru Tamamlandı</b>\n\n🟢 Başarılı: <b>${success}</b>\n🔴 Başarısız: <b>${fail}</b>`);
                }
            } catch (notifyErr) {
                tg(`❌ Duyuru sırasında hata:\n<code>${notifyErr.message}</code>`);
            }
        }
        else if (cmd === '/yardim' || cmd === '/start') cmdYardim();
    } catch (err) {
        tg(`❌ Komut hatası (<code>${cmd}</code>):\n<code>${err.message}</code>`);
    }
});

module.exports = router;
