require('dotenv').config();
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const mongoose = require('mongoose');
const Video = require('../models/Video');

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

async function main() {
    console.log('Veritabanına bağlanılıyor...');
    await mongoose.connect(process.env.MONGODB_URI);

    console.log('Tüm aktif videolar DBden alınıyor...');
    const videos = await Video.find({}, 's3Key thumbnailKey');

    const activeKeys = new Set();
    videos.forEach(v => {
        if (v.s3Key) activeKeys.add(v.s3Key);
        if (v.thumbnailKey) activeKeys.add(v.thumbnailKey);
    });
    console.log(`DB'de toplam ${activeKeys.size} geçerli dosya anahtarı var.`);

    let orphans = [];
    let continuationToken = undefined;

    console.log('S3 Bucket taranıyor...');
    do {
        const command = new ListObjectsV2Command({
            Bucket: process.env.S3_BUCKET_NAME,
            ContinuationToken: continuationToken
        });
        const response = await s3Client.send(command);

        if (response.Contents) {
            response.Contents.forEach(item => {
                if (!activeKeys.has(item.Key)) {
                    orphans.push(item.Key);
                }
            });
        }
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    console.log(`Bulunan yetim (bozuk/silinmiş) dosya sayısı: ${orphans.length}`);

    if (orphans.length > 0) {
        console.log('Yetim dosyalar S3ten siliniyor...');
        // Delete in batches of 1000 (S3 API limit)
        for (let i = 0; i < orphans.length; i += 1000) {
            const batch = orphans.slice(i, i + 1000).map(key => ({ Key: key }));
            const deleteCmd = new DeleteObjectsCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Delete: { Objects: batch }
            });
            await s3Client.send(deleteCmd);
            console.log(`- ${batch.length} dosya kalıcı olarak silindi. (Batch ${Math.floor(i / 1000) + 1})`);
        }
    }

    console.log('Temizlik tamamlandı!');
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
