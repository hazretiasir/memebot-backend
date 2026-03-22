require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Video = require('../models/Video');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    console.log('MongoDB bağlandı.');

    const videos = await Video.find({});
    console.log(`Toplam ${videos.length} video işlenecek...`);

    let fixed = 0;
    const bulkOps = [];

    for (const video of videos) {
        const beforeView = video.viewCount;
        const beforeScore = video.relevanceScore;

        video.recalculateScore();

        if (video.viewCount !== beforeView || video.relevanceScore !== beforeScore) {
            fixed++;
            bulkOps.push({
                updateOne: {
                    filter: { _id: video._id },
                    update: { $set: { viewCount: video.viewCount, relevanceScore: video.relevanceScore } }
                }
            });
        }
    }

    if (bulkOps.length > 0) {
        await Video.bulkWrite(bulkOps);
        console.log(`✅ ${fixed} video güncellendi (viewCount düzeltildi ve/veya relevanceScore yenilendi).`);
    } else {
        console.log('✅ Tüm videolar zaten tutarlı, güncelleme gerekmedi.');
    }

    mongoose.disconnect();
});
