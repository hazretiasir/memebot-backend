const puppeteer = require('puppeteer');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ─── Ayarlar ──────────────────────────────────────────────────────────────────
const TARGET_ACCOUNTS  = ['gibidizisi'];
const UPLOAD_URL       = 'http://localhost:3000/api/videos/upload';
const DELAY_UPLOADS    = 5000;   // yüklemeler arası bekleme (ms)
const MAX_STALE_ROUNDS = 6;      // art arda yeni içerik gelmezse dur
const STATUS_FILE      = path.join(__dirname, '..', 'scraper_status.json');

const IG_SESSION_ID = process.env.INSTAGRAM_SESSION_ID || '';
const COOKIES_FILE  = path.join(__dirname, '..', 'ig_cookies.txt');

// Netscape cookies dosyası oluştur (yt-dlp için)
function writeCookiesFile() {
    const decoded = decodeURIComponent(IG_SESSION_ID);
    const content = '# Netscape HTTP Cookie File\n' +
        `.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\t${decoded}\n`;
    fs.writeFileSync(COOKIES_FILE, content);
}

// ─── Yardımcılar ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function updateProgress(status, stageText, progress) {
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ status, stageText, progress })); } catch (_) {}
}

function randBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── 1. Adım: Sayfa sonuna kadar ilerleyerek tüm reel URL'lerini topla ────────
async function scrapeAllReels(browser, account, baseProgress) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🔍 @${account} — reel taraması başlıyor...`);
    updateProgress('running', `@${account} taranıyor...`, baseProgress);

    const DB_FILE = path.join(__dirname, '..', `scraped_ig_${account}.json`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Session cookie
    await page.setCookie({
        name: 'sessionid', value: IG_SESSION_ID,
        domain: '.instagram.com', path: '/', secure: true, httpOnly: true,
    });

    const shortcodes = new Set();

    // Instagram API/GraphQL yanıtlarını dinle — reel shortcode'larını yakala
    page.on('response', async (response) => {
        const url = response.url();
        if (
            url.includes('/api/v1/') ||
            url.includes('graphql/query') ||
            url.includes('/clips/user/') ||
            url.includes('timeline') ||
            url.includes('reels_media')
        ) {
            try {
                const json = await response.json();
                extractShortcodes(json, shortcodes);
            } catch (_) {}
        }
    });

    const TARGET_URL = `https://www.instagram.com/${account}/reels/`;
    console.log(`🌐 ${TARGET_URL} açılıyor...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(3000);

    // ── Sayfa sonuna kadar insan gibi kaydır ─────────────────────────────────
    let lastCount   = 0;
    let staleRounds = 0;
    let totalScrolls = 0;

    while (staleRounds < MAX_STALE_ROUNDS) {
        // ↓ 2-3 adım aşağı
        const steps = randBetween(2, 4);
        for (let s = 0; s < steps; s++) {
            await page.evaluate(() => window.scrollBy(0, 500 + Math.random() * 300));
            await sleep(randBetween(400, 700));
        }

        // Bazen insan gibi biraz yukarı git
        if (Math.random() < 0.25) {
            const upAmount = randBetween(80, 200);
            await page.evaluate(n => window.scrollBy(0, -n), upAmount);
            await sleep(randBetween(300, 600));
        }

        await sleep(randBetween(1200, 2200));
        totalScrolls++;

        // DOM'dan da shortcode topla
        const domCodes = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/reel/"]'))
                .map(a => { const m = a.href.match(/\/reel\/([A-Za-z0-9_-]{8,12})/); return m ? m[1] : null; })
                .filter(Boolean);
        });
        domCodes.forEach(c => shortcodes.add(c));

        if (shortcodes.size === lastCount) {
            staleRounds++;
            console.log(`⏳ Yeni içerik yok (${staleRounds}/${MAX_STALE_ROUNDS}). Bekleniyor...`);
            await sleep(randBetween(2000, 3500));
        } else {
            staleRounds = 0;
            lastCount = shortcodes.size;
            console.log(`✅ Toplam reel: ${shortcodes.size} (kaydırma #${totalScrolls})`);
            updateProgress('running', `@${account} tarıyor... ${shortcodes.size} reel`, baseProgress + 2);
            // Yeni yüklenen içeriklerin API çağrısı bitmesi için kısa bekle
            await sleep(randBetween(800, 1400));
        }
    }

    const urls = Array.from(shortcodes).map(c => `https://www.instagram.com/reel/${c}/`);
    console.log(`\n🎉 @${account} taraması tamamlandı! ${urls.length} reel toplandı.`);
    fs.writeFileSync(DB_FILE, JSON.stringify(urls, null, 2));
    updateProgress('running', `@${account} taraması bitti (${urls.length} reel). İndirme başlıyor...`, baseProgress + 10);
    await page.close();
    return urls;
}

// JSON içinden shortcode'ları recursive olarak çıkar
function extractShortcodes(obj, set) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(i => extractShortcodes(i, set)); return; }
    if (obj.code && typeof obj.code === 'string' && /^[A-Za-z0-9_-]{8,12}$/.test(obj.code)) {
        set.add(obj.code);
    }
    if (obj.shortcode && typeof obj.shortcode === 'string') set.add(obj.shortcode);
    Object.values(obj).forEach(v => extractShortcodes(v, set));
}

// ─── 2. Adım: İndir ve yükle ──────────────────────────────────────────────────
async function downloadAndUpload(account, reelUrls, baseProgress) {
    if (!reelUrls.length) { console.log(`⚠️ @${account} için reel bulunamadı.`); return; }

    console.log(`\n[2/2] @${account} — ${reelUrls.length} reel işlenecek`);
    const UPLOADED_DB = path.join(__dirname, '..', `uploaded_ig_${account}.json`);

    // Daha önce yüklenenler (URL bazlı, title değil)
    let uploadedUrls = new Set();
    if (fs.existsSync(UPLOADED_DB)) {
        try { JSON.parse(fs.readFileSync(UPLOADED_DB)).forEach(u => uploadedUrls.add(u)); } catch (_) {}
        console.log(`💾 Daha önce yüklenmiş: ${uploadedUrls.size} reel`);
    }

    const toProcess = reelUrls.filter(u => !uploadedUrls.has(u));
    console.log(`📋 İşlenecek yeni reel sayısı: ${toProcess.length}`);

    for (let i = 0; i < toProcess.length; i++) {
        const url = toProcess[i];
        const progress = baseProgress + 10 + Math.floor((i / toProcess.length) * 85);
        updateProgress('running', `@${account} İndiriliyor (${i + 1}/${toProcess.length})`, progress);
        console.log(`\n▶ [${i + 1}/${toProcess.length}] ${url}`);

        try {
            // Metadata
            const meta = await youtubedl(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                cookies: COOKIES_FILE,
            });

            if (!meta || !meta.url) {
                console.log(`⚠️ Video URL'si alınamadı (fotoğraf olabilir). Atlanıyor.`);
                continue;
            }

            // ── Başlık temizle ────────────────────────────────────────────
            let title = (meta.description || meta.title || '').trim();
            title = title
                .replace(/#\S+/g, '')       // hashtag'leri kaldır
                .replace(/@\S+/g, '')       // mention'ları kaldır
                .replace(/https?:\/\/\S+/g, '') // URL'leri kaldır
                .replace(/\s*\w+\.(?:com|tv|net|org|co)\b.*$/is, '') // domain + sonrası (exxen.com a gir... gibi)
                .replace(/[^\w\sğüşıöçĞÜŞİÖÇ.,!?'"-]/g, ' ') // özel karakterler
                .replace(/\s+/g, ' ')
                .trim();

            // Jenerik / boş başlıklar için hesap adını kullan (shortcode YOK)
            const GENERIC = /^(video by|reel by|shared|gönderi|post)/i;
            if (title.length < 8 || GENERIC.test(title)) {
                title = `Gıbı Dizisi`;
            }
            // Çok uzunsa kırp
            if (title.length > 100) title = title.substring(0, 100).trim();

            // ── Video + Ses ayrı indir, ffmpeg ile birleştir ──────────────
            const tempFile = path.join(__dirname, '..', `temp_ig_${Date.now()}.mp4`);
            console.log(`⬇️  Video+ses ayrı indiriliyor, birleştiriliyor...`);

            await youtubedl(url, {
                output: tempFile,
                format: 'bestvideo+bestaudio/best',
                mergeOutputFormat: 'mp4',
                ffmpegLocation: ffmpegPath,
                noCheckCertificates: true,
                cookies: COOKIES_FILE,
            });

            if (!fs.existsSync(tempFile)) { console.log(`❌ Dosya yazılamadı.`); continue; }

            const fileSizeMB = (fs.statSync(tempFile).size / 1024 / 1024).toFixed(1);
            console.log(`⬆️  Yükleniyor (${fileSizeMB}MB): "${title.substring(0, 60)}"`);
            updateProgress('running', `@${account} Yükleniyor (${i + 1}/${toProcess.length})`, progress + 1);

            const formData = new FormData();
            formData.append('video', fs.createReadStream(tempFile));
            formData.append('title', title);
            formData.append('tags', `gıbı,dizi,komedi,instagram,${account}`);
            formData.append('uploadedBy', `ig_bot_${account}`);

            const response = await axios.post(UPLOAD_URL, formData, {
                headers: { ...formData.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            console.log(`✅ Yüklendi! ID: ${response.data.video._id}`);
            uploadedUrls.add(url);
            fs.writeFileSync(UPLOADED_DB, JSON.stringify(Array.from(uploadedUrls), null, 2));
            fs.unlinkSync(tempFile);

            await sleep(DELAY_UPLOADS);

        } catch (err) {
            console.error(`❌ Hata (${url}):`, err.message);
            // Yarım kalan temp dosyaları temizle
            try {
                fs.readdirSync(path.join(__dirname, '..'))
                    .filter(f => f.startsWith('temp_ig_'))
                    .forEach(f => { try { fs.unlinkSync(path.join(__dirname, '..', f)); } catch (_) {} });
            } catch (_) {}
        }
    }
}

// ─── Ana akış ─────────────────────────────────────────────────────────────────
async function run() {
    console.log('='.repeat(50));
    console.log('🤖 Instagram Reel Avcısı v2');
    console.log(`🎯 Hedef: [${TARGET_ACCOUNTS.join(', ')}]`);
    console.log('='.repeat(50));

    if (!IG_SESSION_ID) {
        console.error('❌ INSTAGRAM_SESSION_ID eksik! .env dosyanıza ekleyin.');
        process.exit(1);
    }

    writeCookiesFile();
    updateProgress('running', 'Başlatılıyor...', 0);

    let browser;
    try {
        browser = await Promise.race([
            puppeteer.launch({
                headless: false,   // Canlı izlenebilir pencere
                defaultViewport: null,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Chrome 30sn içinde başlamadı')), 30000)
            ),
        ]);
    } catch (err) {
        console.error('❌ Chrome başlatılamadı:', err.message);
        updateProgress('error', err.message, 0);
        return;
    }

    for (let i = 0; i < TARGET_ACCOUNTS.length; i++) {
        const account = TARGET_ACCOUNTS[i];
        const base = Math.floor(i * (100 / TARGET_ACCOUNTS.length));
        try {
            if (!browser.connected) {
                try { await browser.close(); } catch (_) {}
                browser = await puppeteer.launch({
                    headless: false, defaultViewport: null,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
                });
            }
            const urls = await scrapeAllReels(browser, account, base);
            await downloadAndUpload(account, urls, base);
        } catch (err) {
            console.error(`💥 @${account} kritik hata:`, err.message);
        }
    }

    await browser.close();
    console.log('\n🏁 TÜM GÖREVLER TAMAMLANDI!');
    updateProgress('completed', 'Tüm Instagram görevleri tamamlandı!', 100);
}

run();
