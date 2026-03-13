#!/usr/bin/env node
/**
 * Mevcut videoların Twitter/X kaynak like ve görüntülenme verilerini
 * youtube-dl ile çekip MongoDB'ye yazar. Tek seferlik çalıştırılır.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose  = require('mongoose');
const youtubedl = require('youtube-dl-exec');
const Video     = require('../models/Video');

const DELAY_MS  = 2000; // istek arası bekleme (rate limit koruması)

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB bağlandı\n');

    const videos = await Video.find({
        tweetUrl:  { $ne: null },
        likes:     0,
        viewCount: 0,
    }).select('_id title tweetUrl');

    console.log(`📋 Güncellenecek video: ${videos.length}\n`);

    let updated = 0, skipped = 0, failed = 0;

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        console.log(`[${i + 1}/${videos.length}] ${video.title.substring(0, 50)}`);
        console.log(`  URL: ${video.tweetUrl}`);

        try {
            const meta = await youtubedl(video.tweetUrl, {
                dumpSingleJson: true,
                noWarnings: true,
            });

            const likes = meta.like_count || 0;
            const views = meta.view_count || 0;

            if (likes === 0 && views === 0) {
                console.log(`  ⏭️  Veri yok (0/0) — atlandı`);
                skipped++;
            } else {
                await Video.findByIdAndUpdate(video._id, {
                    likes:     likes,
                    viewCount: views,
                });
                console.log(`  ✅ Güncellendi — 👍 ${likes.toLocaleString()} görüntülenme: ${views.toLocaleString()}`);
                updated++;
            }
        } catch (err) {
            console.log(`  ❌ Hata: ${err.message.slice(0, 80)}`);
            failed++;
        }

        await sleep(DELAY_MS);
    }

    console.log(`\n${'─'.repeat(40)}`);
    console.log(`✅ Güncellendi : ${updated}`);
    console.log(`⏭️  Atlandı    : ${skipped}`);
    console.log(`❌ Hata        : ${failed}`);

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('💥 Script hatası:', err.message);
    process.exit(1);
});
