require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    const result = await mongoose.connection.db.collection('videos').updateMany(
        { dislikes: { $exists: true } },
        { $unset: { dislikes: '' } }
    );
    console.log(`✅ ${result.modifiedCount} videodan dislikes alanı silindi.`);
    mongoose.disconnect();
});
