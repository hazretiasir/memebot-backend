const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Ayarlar
const TARGET_FOLDER = 'C:\\Users\\asir-\\Downloads\\meme videoları';
const UPLOAD_URL = 'http://localhost:3000/api/videos/upload';
const DELAY_MS = 3000; // Gemini API limitlerine takılmamak için 3 saniye bekleme

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadVideo(filePath, fileName) {
    const formData = new FormData();
    const title = path.parse(fileName).name; // Dosya uzantısı hariç adını title yapıyoruz

    formData.append('video', fs.createReadStream(filePath));
    formData.append('title', title);
    formData.append('tags', 'meme,arşiv');
    formData.append('uploadedBy', 'admin_bot');

    console.log(`\n⏳ Yükleniyor: ${title}`);
    try {
        const response = await axios.post(UPLOAD_URL, formData, {
            headers: {
                ...formData.getHeaders(),
            },
        });
        console.log(`✅ Başarılı: ${title} (ID: ${response.data.video._id})`);
    } catch (err) {
        console.error(`❌ Hata (${title}):`, err.response?.data || err.message);
    }
}

async function bulkUpload() {
    if (!fs.existsSync(TARGET_FOLDER)) {
        console.error(`❌ Klasör bulunamadı: ${TARGET_FOLDER}`);
        return;
    }

    const files = fs.readdirSync(TARGET_FOLDER);
    const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv'];

    const videoFiles = files.filter(f => videoExtensions.includes(path.extname(f).toLowerCase()));

    if (videoFiles.length === 0) {
        console.log('Klasörde hiç video bulunamadı.');
        return;
    }

    console.log(`Toplam ${videoFiles.length} video bulundu. Yükleme başlıyor...\n`);

    for (let i = 0; i < videoFiles.length; i++) {
        const fileName = videoFiles[i];
        const filePath = path.join(TARGET_FOLDER, fileName);

        console.log(`[${i + 1}/${videoFiles.length}] İşleniyor...`);
        await uploadVideo(filePath, fileName);

        if (i < videoFiles.length - 1) {
            console.log(`Bekleniyor (${DELAY_MS}ms)...`);
            await sleep(DELAY_MS);
        }
    }

    console.log('\n🎉 Tüm yüklemeler tamamlandı!');
}

bulkUpload();
