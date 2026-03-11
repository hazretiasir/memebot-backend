const puppeteer = require('puppeteer');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TARGET_ACCOUNTS = ['yalcdb', 'videolarsivi', 'BelalArsiv'];
const UPLOAD_URL = 'http://localhost:3000/api/videos/upload';
const DELAY_BETWEEN_UPLOADS = 5000;
const MAX_VIDEOS_PER_ACCOUNT = 50;

// Hardcoded X_AUTH_TOKEN from previous working version
const X_AUTH_TOKEN = 'aa296debbaae4e6f19c6b2a177616a2e4875d587';
const STATUS_FILE = path.join(__dirname, '..', 'scraper_status.json');

function updateProgress(status, stageText, progress) {
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({ status, stageText, progress }));
    } catch (e) { }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeTweetLinks(browser, targetAccount, baseProgress) {
    console.log(`\n========================================`);
    console.log(`[1/2] ${targetAccount} hesabı taranıyor...`);
    updateProgress('running', `@${targetAccount} taranıyor... (Puppeteer)`, baseProgress + 1);

    // DB dosyaları
    const DB_FILE = path.join(__dirname, '..', `scraped_tweets_${targetAccount}.json`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const TARGET_URL = `https://x.com/${targetAccount}/media`;

    console.log(`🌐 Cookie yerleştiriliyor...`);
    await page.setCookie({
        name: 'auth_token',
        value: X_AUTH_TOKEN,
        domain: '.x.com',
        path: '/',
        secure: true,
        httpOnly: true
    });

    let allStatusUrls = new Set();

    // Listen to background network traffic
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
                        if (!allStatusUrls.has(cleanLink) && allStatusUrls.size < MAX_VIDEOS_PER_ACCOUNT) {
                            allStatusUrls.add(cleanLink);
                            addedNew = true;
                        }
                    });
                    if (addedNew) {
                        console.log(`🤖 Arka plandan yakalandı! Toplam: ${allStatusUrls.size}/${MAX_VIDEOS_PER_ACCOUNT}`);
                        fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(allStatusUrls), null, 2));
                    }
                }
            } catch (e) { }
        }
    });

    // networkidle2: redirect tamamlandıktan sonra bekle (domcontentloaded frame detach'e yol açıyor)
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(4000);

    let scrolls = 0;
    while (allStatusUrls.size < MAX_VIDEOS_PER_ACCOUNT && scrolls < 5) {
        await page.keyboard.press('PageDown');
        await sleep(1000);
        await page.keyboard.press('PageDown');
        await sleep(2000);
        scrolls++;
        console.log(`Kaydırma turu: ${scrolls}/5`);
    }

    console.log(`🎉 [${targetAccount}] taraması bitti. (${allStatusUrls.size} link toplandı)`);
    updateProgress('running', `@${targetAccount} taraması bitti. Video indirme başlıyor...`, baseProgress + 5);
    await page.close();
    return Array.from(allStatusUrls);
}

async function downloadAndUpload(targetAccount, tweetUrls, baseProgress) {
    if (tweetUrls.length === 0) return;

    console.log(`\n[2/2] ${targetAccount} hesap indirme ve API yükleme aşaması başlıyor...`);
    const UPLOADED_DB_FILE = path.join(__dirname, '..', `uploaded_tweets_${targetAccount}.json`);

    let uploadedUrls = new Set();
    if (fs.existsSync(UPLOADED_DB_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(UPLOADED_DB_FILE));
            saved.forEach(url => uploadedUrls.add(url));
            console.log(`Daha önce [${targetAccount}] hesabı için yüklenmiş ${uploadedUrls.size} video bellekten okundu.`);
        } catch (e) { }
    }

    let existingTitles = new Set();
    try {
        console.log(`🔍 Tüm veritabanı başlıkları taranıyor (Çifte yüklemeyi önlemek için)...`);
        const res = await axios.get('http://localhost:3000/api/videos?limit=50000');
        res.data.videos.forEach(v => {
            if (v.title && v.title.length > 3) existingTitles.add(v.title.toLowerCase());
        });
        console.log(`✅ ${existingTitles.size} özgün video başlığı API'den alındı.`);
    } catch (err) {
        console.log(`⚠️ API'den başlıklar alınamadı, kopya kontrolü sadece URL bazlı çalışacak.`);
    }

    // Process only up to MAX_VIDEOS_PER_ACCOUNT
    const urlsToProcess = tweetUrls.slice(0, MAX_VIDEOS_PER_ACCOUNT);

    for (let i = 0; i < urlsToProcess.length; i++) {
        const url = urlsToProcess[i];
        const currentProgress = baseProgress + 5 + Math.floor((i / urlsToProcess.length) * 28);
        updateProgress('running', `@${targetAccount} Medya İndiriliyor (${i + 1}/${urlsToProcess.length})`, currentProgress);

        console.log(`\n▶ [${i + 1}/${urlsToProcess.length}] İşleniyor: ${url}`);

        if (uploadedUrls.has(url)) {
            console.log(`⏭️ Zaten sistemde yt-dlp ile işlenmiş, atlanıyor...`);
            continue;
        }

        try {
            // 1. Get metadata
            const meta = await youtubedl(url, {
                dumpSingleJson: true,
                noWarnings: true
            });

            if (!meta || !meta.url) {
                console.log(`⚠️ Video bulunamadı (Sadece fotoğraf olabilir). Atlanıyor.`);
                continue;
            }

            let description = meta.description || meta.title || '';
            description = description.replace(/https:\/\/t\.co\/\w+/g, '').replace(/@\w+/g, '').trim();

            // Fallback title: tweet ID from URL
            if (description.length < 5) {
                const tweetId = url.split('/').pop();
                description = `Arşiv Video ${tweetId.slice(-8)}`;
            }

            const checkTitle = description.toLowerCase();
            if (checkTitle.length > 3 && existingTitles.has(checkTitle)) {
                console.log(`🚫 Daha önce Giresun/Belalarşiv veya Yalçın hesabından yüklenmiş (Aynı Metin Başlığı). Atlanıyor!`);
                uploadedUrls.add(url);
                fs.writeFileSync(UPLOADED_DB_FILE, JSON.stringify(Array.from(uploadedUrls), null, 2));
                continue;
            }

            const tempFilePath = path.join(__dirname, '..', `temp_${targetAccount}_${Date.now()}.mp4`);

            console.log(`⬇️ MP4 İndiriliyor...`);
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

            console.log(`⬆️ Sisteme API Yüklemesi Başlıyor... Başlık: "${description.substring(0, 40)}..."`);
            updateProgress('running', `@${targetAccount} Sunucuya Yükleniyor (${i + 1}/${urlsToProcess.length})`, currentProgress + 1);
            const formData = new FormData();
            formData.append('video', fs.createReadStream(tempFilePath));
            formData.append('title', description);
            formData.append('tags', `meme,X,arşiv,${targetAccount}`);
            formData.append('uploadedBy', `automation_bot_${targetAccount}`);

            const response = await axios.post(UPLOAD_URL, formData, {
                headers: { ...formData.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(`✅ Başarıyla AWS / MongoDB yüklendi! DB ID: ${response.data.video._id}`);

            uploadedUrls.add(url);
            fs.writeFileSync(UPLOADED_DB_FILE, JSON.stringify(Array.from(uploadedUrls), null, 2));
            fs.unlinkSync(tempFilePath);

            console.log(`Bekleniyor (${DELAY_BETWEEN_UPLOADS}ms)...`);
            await sleep(DELAY_BETWEEN_UPLOADS);

        } catch (err) {
            console.error(`❌ Hata (${url}):`, err.message);
            try {
                const parentDir = path.join(__dirname, '..');
                const files = fs.readdirSync(parentDir);
                files.filter(f => f.startsWith(`temp_${targetAccount}_`)).forEach(f => fs.unlinkSync(path.join(parentDir, f)));
            } catch (e) { }
        }
    }
}

async function runAutomation() {
    console.log("=================================================");
    console.log("🚀 Otomatik 10'lu Twitter/X Avcısı Başlatıldı 🚀");
    console.log(`Hedefler: [${TARGET_ACCOUNTS.join(', ')}]`);
    console.log("=================================================");

    updateProgress('running', `Avcı Başlatıldı, Bağlantı Kuruluyor...`, 0);

    // 30 saniye içinde başlamazsa hata yaz
    let browser;
    try {
        browser = await Promise.race([
            puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer'
                    // NOT: --single-process kaldırıldı — tab çökünce tüm tarayıcıyı öldürüyordu
                ]
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Chrome 30 saniyede başlamadı (Render free tier sınırı)')), 30000)
            )
        ]);
    } catch (launchErr) {
        console.error('\u274c Chrome hatası:', launchErr.message);
        updateProgress('error', `Chrome başlamadı: ${launchErr.message}`, 0);
        return;
    }


    for (let i = 0; i < TARGET_ACCOUNTS.length; i++) {
        const target = TARGET_ACCOUNTS[i];
        const baseProgressPct = Math.floor(i * (100 / TARGET_ACCOUNTS.length));
        try {
            // Tarayıcı öldüyse (ConnectionClosedError) yeniden başlat
            if (!browser.connected) {
                console.log('⚠️  Browser öldü, yeniden başlatılıyor...');
                try { await browser.close(); } catch (_) { }
                browser = await puppeteer.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer']
                });
            }
            const urls = await scrapeTweetLinks(browser, target, baseProgressPct);
            await downloadAndUpload(target, urls, baseProgressPct);
        } catch (err) {
            console.error(`💥 ${target} hesabında kritik çökme:`, err.message);
            // Browser öldüyse yeniden başlat
            if (err.message.includes('Connection closed') || err.message.includes('detached')) {
                console.log('🔄 Browser yeniden başlatılıyor...');
                try { await browser.close(); } catch (_) { }
                try {
                    browser = await puppeteer.launch({
                        headless: true,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer']
                    });
                } catch (relaunchErr) {
                    console.error('❌ Browser yeniden başlatılamadı:', relaunchErr.message);
                    break;
                }
            }
        }
    }

    await browser.close();
    console.log('\n🚀 BÜTÜN HESAPLAR İÇİN OTOMASYON GÖREVİ TAMAMLANDI!');
    updateProgress('completed', 'Tüm görevler başarıyla tamamlandı!', 100);
}

if (require.main === module) {
    runAutomation();
} else {
    module.exports = { runAutomation };
}
