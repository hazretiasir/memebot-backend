const mongoose = require('mongoose');
const Video = require('./models/Video');
require('dotenv').config();

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
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
            },
            {
                $sort: { count: -1 }
            }
        ]);

        console.log('--- DUPLICATE REPORT ---');
        duplicates.forEach(d => {
            console.log(`${d.count} Kere: ${d._id}`);
        });
        console.log('--- END OF REPORT ---');

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

run();
