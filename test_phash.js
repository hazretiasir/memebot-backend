require('dotenv').config();
const mongoose = require('mongoose');
const { imageHash } = require('image-hash');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = require('./config/aws');
const Video = require('./models/Video');

// S3'ten buffer olarak indir
async function downloadFromS3(key) {
    const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
    });
    const response = await s3Client.send(command);

    const chunks = [];
    for await (const chunk of response.Body) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// Buffer'dan pHash üret
function hashFromBuffer(buffer) {
    return new Promise((resolve, reject) => {
        imageHash({ data: buffer }, 16, true, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

// Hamming mesafesi (kaç bit farklı)
function hammingDistance(hash1, hash2) {
    let diff = 0;
    for (let i = 0; i < hash1.length; i++) {
        const b1 = parseInt(hash1[i], 16).toString(2).padStart(4, '0');
        const b2 = parseInt(hash2[i], 16).toString(2).padStart(4, '0');
        for (let j = 0; j < 4; j++) {
            if (b1[j] !== b2[j]) diff++;
        }
    }
    return diff;
}

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB bağlandı\n');

    const boom = await Video.findOne({ title: /boom boom/i }).select('title thumbnailKey');
    const kabe = await Video.findOne({ title: /kabe|hacılar|hu der/i }).select('title thumbnailKey');

    if (!boom) { console.log('❌ "Boom Boom Tel Aviv" bulunamadı'); process.exit(1); }
    if (!kabe) { console.log('❌ "Kabede" videosu bulunamadı'); process.exit(1); }

    console.log(`📹 Video 1: ${boom.title}`);
    console.log(`   Key: ${boom.thumbnailKey}\n`);
    console.log(`📹 Video 2: ${kabe.title}`);
    console.log(`   Key: ${kabe.thumbnailKey}\n`);

    console.log('⬇️  S3\'ten thumbnail\'lar indiriliyor...');
    const [buf1, buf2] = await Promise.all([
        downloadFromS3(boom.thumbnailKey),
        downloadFromS3(kabe.thumbnailKey),
    ]);
    console.log(`   ✅ İndirildi — ${buf1.length} bytes ve ${buf2.length} bytes\n`);

    console.log('🔍 pHash hesaplanıyor...');
    const [hash1, hash2] = await Promise.all([
        hashFromBuffer(buf1),
        hashFromBuffer(buf2),
    ]);
    console.log(`   Hash 1: ${hash1}`);
    console.log(`   Hash 2: ${hash2}\n`);

    const dist = hammingDistance(hash1, hash2);
    const maxBits = hash1.length * 4;
    const similarity = (((maxBits - dist) / maxBits) * 100).toFixed(1);

    console.log(`📊 Hamming Mesafesi : ${dist} bit  (toplam ${maxBits} bit)`);
    console.log(`   Görsel Benzerlik : %${similarity}\n`);

    if (dist <= 10) {
        console.log('🎯 SONUÇ: Görsel KARDEŞ tespit edildi! (≤10 bit) — pHash yöntemi başarılı!');
        console.log('   ✅ Bu iki videonun aynı kaynaktan geldiği otomatik olarak anlaşılabilir.');
    } else if (dist <= 20) {
        console.log('🟡 SONUÇ: Orta benzerlik (11-20 bit) — Muhtemelen aynı kaynak ama farklı kare.');
    } else {
        console.log(`🔴 SONUÇ: Görsel olarak FARKLI içerik. Mesafe ${dist} > 20 bit.`);
        console.log('   pHash tek başına bu iki videoyu bağlayamaz. Başka bir yöntem gerekir.');
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('❌ Hata:', err.message);
    process.exit(1);
});
