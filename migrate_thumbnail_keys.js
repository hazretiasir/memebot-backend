/**
 * Migration: backfill thumbnailKey for existing videos that have
 * thumbnailUrl but no thumbnailKey (uploaded before the schema change).
 *
 * Run once: node migrate_thumbnail_keys.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Video = require('./models/Video');

const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;
const CF = process.env.CLOUDFRONT_DOMAIN;

function extractKey(url) {
    if (!url) return null;
    if (CF) return url.replace(`${CF}/`, '');
    return url.replace(
        `https://${BUCKET}.s3.${REGION}.amazonaws.com/`,
        ''
    );
}

async function run() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');

    const videos = await Video.find({
        thumbnailUrl: { $ne: null },
        $or: [
            { thumbnailKey: null },
            { thumbnailKey: { $exists: false } },
        ],
    });

    console.log(`Found ${videos.length} videos to migrate...`);

    for (const v of videos) {
        const key = extractKey(v.thumbnailUrl);
        if (key) {
            await Video.findByIdAndUpdate(v._id, { thumbnailKey: key });
            console.log(`  ✅ ${v._id} → thumbnailKey: ${key}`);
        }
    }

    console.log('Migration complete!');
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('Migration error:', err);
    process.exit(1);
});
