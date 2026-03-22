const mongoose = require('mongoose');
const Video = require('./models/Video');
require('dotenv').config();

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const duplicates = await Video.aggregate([
            {
                $group: {
                    _id: '$title',
                    count: { $sum: 1 },
                    ids: { $push: '$_id' }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            }
        ]);

        console.log(`🔍 Found ${duplicates.length} titles with duplicates.`);

        let totalDeleted = 0;
        for (const item of duplicates) {
            // Keep the first one, delete the rest
            const toKeep = item.ids[0];
            const toDelete = item.ids.slice(1);

            const result = await Video.deleteMany({ _id: { $in: toDelete } });
            totalDeleted += result.deletedCount;
            console.log(`🗑️ Deleted ${result.deletedCount} duplicates for title: "${item._id}"`);
        }

        console.log(`\n✨ DONE! Total duplicates removed: ${totalDeleted}`);

    } catch (err) {
        console.error('❌ Error during cleanup:', err);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
    }
}

run();
