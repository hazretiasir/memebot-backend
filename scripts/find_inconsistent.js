require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Video = require('../models/Video');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    const videos = await Video.find({
        $expr: { $gt: ['$likes', '$viewCount'] }
    }).select('title likes viewCount').sort({ likes: -1 });

    console.log(`Tutarsız video sayısı: ${videos.length}\n`);
    console.log('likes | views | başlık');
    console.log('─'.repeat(60));
    videos.forEach(v => {
        console.log(`${String(v.likes).padStart(5)} | ${String(v.viewCount).padStart(5)} | ${v.title.substring(0, 50)}`);
    });
    mongoose.disconnect();
});
