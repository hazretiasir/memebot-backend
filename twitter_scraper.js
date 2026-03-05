const puppeteer = require('puppeteer');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const ffmpegPath = require('ffmpeg-static');

const TARGET_ACCOUNT = process.argv[2] || 'yalcdb';
const TARGET_URL = `https://x.com/${TARGET_ACCOUNT}/media`;
const UPLOAD_URL = 'http://localhost:3000/api/videos/upload';
const DB_FILE = path.join(__dirname, `scraped_tweets_${TARGET_ACCOUNT}.json`);
const UPLOADED_DB_FILE = path.join(__dirname, `uploaded_tweets_${TARGET_ACCOUNT}.json`);
const DELAY_BETWEEN_UPLOADS = 5000; // 5 seconds

// BURAYA X'TEN ALDIĞINIZ auth_token DEĞERİNİ YAPIŞTIRIN
const X_AUTH_TOKEN = 'aa296debbaae4e6f19c6b2a177616a2e4875d587';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. AŞAMA: TWITTER'I KAYDIRARAK LİNKLERİ TOPLA
async function scrapeTweetLinks() {
    console.log(`[1/3] ${TARGET_ACCOUNT} hesabındaki medya linkleri taranıyor...`);

    // session kalıcı olsun diye userDataDir kullanıyoruz, böylece 1 kere giriş yapınca hep kalır
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: path.join(__dirname, 'twitter_session')
    });
    const page = await browser.newPage();

    // viewport'u geniş tutalım
    await page.setViewport({ width: 1280, height: 800 });

    if (X_AUTH_TOKEN !== 'BURAYA_YAPISTIRIN' && X_AUTH_TOKEN !== '') {
        console.log('✅ Cookie algılandı! X hesabına otomatik erişiliyor...');
        await page.setCookie({
            name: 'auth_token',
            value: X_AUTH_TOKEN,
            domain: '.x.com',
            path: '/',
            secure: true,
            httpOnly: true
        });
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
        await sleep(5000);
    } else {
        console.log(`❌ HATA: Lütfen kodun 13. satırına auth_token değerini girin!`);
        await browser.close();
        return [];
    }

    let allStatusUrls = new Set();

    // YAKALAYICI: Twitter'ın arka plan verilerini gizlice dinle (DOM silinse bile kaçırmaz)
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('UserMedia') || url.includes('graphql')) {
            try {
                const json = await response.json();
                const str = JSON.stringify(json);
                const matches = str.match(/https:\/\/(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/\d+/g);
                if (matches) {
                    let addedNew = false;
                    matches.forEach(m => {
                        const cleanLink = m.replace('twitter.com', 'x.com');
                        if (!allStatusUrls.has(cleanLink)) {
                            allStatusUrls.add(cleanLink);
                            addedNew = true;
                        }
                    });
                    if (addedNew) {
                        console.log(`🤖 Arka plandan yakalandı! Toplam: ${allStatusUrls.size}`);
                        fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(allStatusUrls), null, 2));
                    }
                }
            } catch (e) { }
        }
    });

    // Eğer önceden taranmış varsa onları yükleyelim ki baştan başlamasın
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE);
            const saved = JSON.parse(raw);
            saved.forEach(url => allStatusUrls.add(url));
            console.log(`Önceden taranmış ${allStatusUrls.size} link yüklendi.`);
        } catch (e) { }
    }

    let previousUrlCount = 0;
    let unchangedScrolls = 0;
    const MAX_UNCHANGED_SCROLLS = 12; // 12 x 4 saniye = Yeni bir şey bulamazsa 48 saniye bekleyecek

    console.log("Tarama ve aşağı kaydırma işlemi başlıyor. Lütfen sekmeyi kapatmayın...");

    while (unchangedScrolls < MAX_UNCHANGED_SCROLLS) {

        // Çok daha insansı ve güçlü kaydırma metodu (PageDown)
        await page.keyboard.press('PageDown');
        await sleep(1000);
        await page.keyboard.press('PageDown');
        await sleep(1000);
        await page.keyboard.press('PageDown');

        await sleep(2000);

        if (allStatusUrls.size === previousUrlCount) {
            unchangedScrolls++;
            console.log(`Yeni video bulunamadı, daha aşağıya zorlanıyor (${unchangedScrolls}/${MAX_UNCHANGED_SCROLLS})...`);
            // Sayfa sıkışırsa biraz yukarı çıkıp tekrar inelim
            if (unchangedScrolls === 5) {
                await page.keyboard.press('PageUp');
                await sleep(1000);
            }
        } else {
            unchangedScrolls = 0;
            previousUrlCount = allStatusUrls.size;
        }
    }

    console.log(`\n🎉 Tarama tamamlandı! Toplam ${allStatusUrls.size} video tweet bulundu.`);
    await browser.close();
    return Array.from(allStatusUrls);
}


// 2. AŞAMA: YT-DLP İLE İNDİRİP BACKEND'E YÜKLE
async function downloadAndUpload(tweetUrls) {
    console.log(`\n[2/3] İndirme ve Yükleme aşaması başlıyor...`);

    // Daha önce yüklenenleri belleğe al
    let uploadedUrls = new Set();
    if (fs.existsSync(UPLOADED_DB_FILE)) {
        try {
            const raw = fs.readFileSync(UPLOADED_DB_FILE);
            const saved = JSON.parse(raw);
            saved.forEach(url => uploadedUrls.add(url));
            console.log(`Daha önce [${TARGET_ACCOUNT}] hesabı için yüklenmiş ${uploadedUrls.size} video atlanacak...`);
        } catch (e) { }
    }

    // YENİ: Veritabanındaki diğer hesaplardan yüklenmiş mevcut başlıkları (videoları) al
    let existingTitles = new Set();
    try {
        console.log(`🔍 Tüm veritabanı başlıkları taranıyor (Çifte yüklemeyi önlemek için)...`);
        const res = await axios.get('http://localhost:3000/api/videos?limit=50000');
        res.data.videos.forEach(v => {
            if (v.title && v.title.length > 3) existingTitles.add(v.title.toLowerCase());
        });
        console.log(`✅ ${existingTitles.size} özgün video başlığı hafızaya alındı.`);
    } catch (err) {
        console.log(`⚠️ Başlıklar alınamadı, kopya kontrolü kısıtlı çalışacak.`);
    }

    for (let i = 0; i < tweetUrls.length; i++) {
        const url = tweetUrls[i];
        console.log(`\n▶ [${i + 1}/${tweetUrls.length}] İşleniyor: ${url}`);

        if (uploadedUrls.has(url)) {
            console.log(`⏭️ Zaten yüklenmiş, atlanıyor...`);
            continue;
        }

        try {
            // 1. yt-dlp ile metadata'yı json ortamında al
            const meta = await youtubedl(url, {
                dumpSingleJson: true,
                noWarnings: true
            });

            // Eğer tweet içinde video yoksa atla
            if (!meta || !meta.url) {
                console.log(`⚠️ Video bulunamadı, atlanıyor.`);
                continue;
            }

            let description = meta.description || meta.title || 'Meme video';
            // Clean up Twitter shortlinks (https://t.co/...)
            description = description.replace(/https:\/\/t\.co\/\w+/g, '').trim();

            const checkTitle = description.toLowerCase();
            if (checkTitle.length > 3 && existingTitles.has(checkTitle)) {
                console.log(`🚫 Daha önce Giresun/Belalarşiv veya Yalçın hesabından yüklenmiş (Aynı Başlık). Atlanıyor!`);

                // Bunu da listeye ekle ki bir daha kontrol etmesin
                uploadedUrls.add(url);
                fs.writeFileSync(UPLOADED_DB_FILE, JSON.stringify(Array.from(uploadedUrls), null, 2));
                continue;
            }

            const tempFilePath = path.join(__dirname, `temp_${Date.now()}.mp4`);

            console.log(`⬇️ İndiriliyor...`);
            // 2. yt-dlp ve ffmpeg-static ile videoyu mp4 formatında, en yüksek kalitede birleştir (mux)
            await youtubedl(url, {
                output: tempFilePath,
                format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                mergeOutputFormat: 'mp4',
                ffmpegLocation: ffmpegPath,
            });

            if (!fs.existsSync(tempFilePath)) {
                console.log(`❌ Dosya diske yazılamadı.`);
                continue;
            }

            console.log(`⬆️ Sisteme yükleniyor... Title: "${description.substring(0, 40)}..."`);
            // 3. API'ye post et
            const formData = new FormData();
            formData.append('video', fs.createReadStream(tempFilePath));

            // Tweet açıklamasını başlık (ve açıklama/etiket için yapay zekaya referans) olarak yolluyoruız
            formData.append('title', description);
            formData.append('tags', `meme,X,arşiv,${TARGET_ACCOUNT}`);
            formData.append('uploadedBy', 'twitter_bot');

            const response = await axios.post(UPLOAD_URL, formData, {
                headers: { ...formData.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(`✅ Başarıyla yüklendi! ID: ${response.data.video._id}`);

            // 4. Durumu kaydet ve geçici dosyayı sil
            uploadedUrls.add(url);
            fs.writeFileSync(UPLOADED_DB_FILE, JSON.stringify(Array.from(uploadedUrls), null, 2));
            fs.unlinkSync(tempFilePath);

            // 5. Rate-limit için bekle
            console.log(`Bekleniyor (${DELAY_BETWEEN_UPLOADS}ms)...`);
            await sleep(DELAY_BETWEEN_UPLOADS);

        } catch (err) {
            console.error(`❌ Hata (${url}):`, err.message);
            // dosya takılı kaldıysa sil
            try {
                const files = fs.readdirSync(__dirname);
                files.filter(f => f.startsWith('temp_')).forEach(f => fs.unlinkSync(path.join(__dirname, f)));
            } catch (e) { }
        }
    }

    console.log('\n🚀 TÜM İŞLEMLER BİTTİ!');
}


async function main() {
    // 1. Linkleri topla
    const urls = await scrapeTweetLinks();

    // 2. Varsa indirmeye geç
    if (urls.length > 0) {
        await downloadAndUpload(urls);
    } else {
        console.log("Hiç link bulunamadı, işlem iptal edildi.");
    }
}

main();
