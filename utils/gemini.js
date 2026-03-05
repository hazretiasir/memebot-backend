const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);


// ─── Turkish character normalization ─────────────────────────────────────────
const TR_MAP = { 'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U', 'ö': 'o', 'Ö': 'O', 'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I' };
function normalize(str) {
    return str.replace(/[şŞüÜöÖçÇğĞıİ]/g, c => TR_MAP[c] || c).toLowerCase();
}

// ─── Local synonym fallback dictionary ───────────────────────────────────────
const SYNONYMS = {
    'düşüyor': ['düşme', 'düşüş', 'falls', 'fall', 'fail', 'kayıyor'],
    'düşme': ['düşüyor', 'falls', 'fail'],
    'gülüyor': ['gülerken', 'kahkaha', 'laughing', 'laugh', 'komedi'],
    'ağlıyor': ['ağlarken', 'crying', 'cry', 'üzgün'],
    'dans': ['dancing', 'dance', 'kıvranıyor'],
    'çığlık': ['bağırıyor', 'screaming', 'scream'],
    'sinirleniyor': ['kızıyor', 'angry', 'sinirli'],
    'şaşırıyor': ['şaşkın', 'surprised', 'shocked', 'wtf'],
    'koşuyor': ['kaçıyor', 'running', 'run'],
    'seçiyor': ['choosing', 'choose', 'tercih'],
    'beklenti': ['expectation', 'vs gerçek', 'reality'],
    'kedi': ['cat', 'kedi meme', 'miyav'],
    'cat': ['kedi', 'feline'],
    'köpek': ['dog', 'woof'],
    'dog': ['köpek'],
    'drake': ['drake meme', 'seçiyor', 'hotline bling'],
    'bebek': ['baby', 'infant'],
    'çocuk': ['kid', 'child'],
    'adam': ['man', 'guy'],
    'kadın': ['woman', 'girl'],
    'mutlu': ['happy', 'sevinçli', 'happiness'],
    'üzgün': ['sad', 'ağlıyor', 'mutsuz'],
    'komedi': ['funny', 'eğlenceli', 'komik'],
    'komik': ['komedi', 'funny', 'eğlenceli'],
    'funny': ['komik', 'komedi', 'eğlenceli'],
    'fail': ['düşüyor', 'kazara', 'hata'],
    'viral': ['trending', 'popüler'],
    'ofis': ['office', 'çalışma'],
    'okul': ['school', 'sınıf'],
    'araba': ['car', 'araç'],
};

const NORM_LOOKUP = {};
Object.entries(SYNONYMS).forEach(([k, v]) => { NORM_LOOKUP[normalize(k)] = v; });

const FORMAT_PATTERNS = [
    { pattern: /drake|seç/i, tags: ['drake', 'drake meme', 'hotline bling'] },
    { pattern: /beklenti|expectat/i, tags: ['beklenti vs gerçek', 'expectation vs reality'] },
    { pattern: /komedi|funny|komik/i, tags: ['komedi', 'funny', 'viral'] },
];

function _localExpand(originalQuery) {
    const query = originalQuery.toLowerCase().trim();
    const words = query.split(/\s+/);
    const expanded = new Set([query]);

    words.forEach(word => {
        const syns = SYNONYMS[word] || NORM_LOOKUP[normalize(word)];
        if (syns) {
            syns.forEach(s => expanded.add(s));
            syns.slice(0, 2).forEach(syn =>
                expanded.add(words.map(w => w === word ? syn : w).join(' ')));
        }
    });

    if (words.length === 1) {
        const syns = SYNONYMS[words[0]] || NORM_LOOKUP[normalize(words[0])];
        if (syns) syns.forEach(s => expanded.add(s));
    }

    const normQ = normalize(query);
    FORMAT_PATTERNS.forEach(({ pattern, tags }) => {
        if (pattern.test(query) || pattern.test(normQ))
            tags.forEach(t => expanded.add(t));
    });

    return [originalQuery, ...[...expanded].filter(t => t !== originalQuery)].slice(0, 8);
}

// ─── Gemini Query Expansion ───────────────────────────────────────────────────

// Timeout wrapper: reject if Gemini doesn't respond within ms milliseconds
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Gemini timeout after ${ms}ms`)), ms)
        )
    ]);
}

async function expandQuery(originalQuery) {
    if (!process.env.GEMINI_API_KEY) {
        const result = _localExpand(originalQuery);
        console.log(`🔍 Query expanded (local): "${originalQuery}" →`, result);
        return result;
    }

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `Sen bir meme video arama motorusun. Kullanıcının araması: "${originalQuery}"

Bu aramayla ilgili, farklı kelimelerle ifade edilmiş 4 arama terimi üret.
Türkçe ve İngilizce karışık olabilir. 1-4 kelime, arama dostu olsun.
Sadece JSON array döndür, başka hiçbir şey yazma: ["terim1","terim2","terim3","terim4"]`;

        // 5 second timeout — fail fast on Render free tier
        const result = await withTimeout(model.generateContent(prompt), 5000);
        const cleaned = result.response.text().trim().replace(/```json|```/g, '').trim();
        const aiTerms = JSON.parse(cleaned);

        if (!Array.isArray(aiTerms)) throw new Error('Not an array');

        // Merge AI terms with local expansion
        const localTerms = _localExpand(originalQuery);
        const all = [...new Set([
            originalQuery,
            ...localTerms.slice(1, 4),
            ...aiTerms.map(t => String(t).toLowerCase().trim()),
        ])].filter(Boolean).slice(0, 8);

        console.log(`🧠 Query expanded (AI+local): "${originalQuery}" →`, all);
        return all;
    } catch (err) {
        console.warn(`⚠️  Gemini expansion failed, using local: ${err.message.slice(0, 80)}`);
        const result = _localExpand(originalQuery);
        console.log(`🔍 Query expanded (local): "${originalQuery}" →`, result);
        return result;
    }
}

// ─── Gemini Embedding (text-embedding-004, 768 dims) ─────────────────────────
async function generateEmbedding(text) {
    if (!process.env.GEMINI_API_KEY) return null;
    try {
        // gemini-embedding-001 is available on v1beta for this project
        const model = genAI.getGenerativeModel(
            { model: 'gemini-embedding-001' },
            { apiVersion: 'v1beta' }
        );
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (err) {
        console.warn(`⚠️  Embedding failed: ${err.message.slice(0, 120)}`);
        return null;
    }
}



// ─── Gemini Auto-Tagging ──────────────────────────────────────────────────────

function _localGenerateTags(title) {
    const words = title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const tags = new Set();

    words.forEach(word => {
        const normWord = normalize(word);
        // Direct match
        const syns = SYNONYMS[word] || NORM_LOOKUP[normWord];
        if (syns) { tags.add(word); syns.slice(0, 3).forEach(s => tags.add(s)); }
        else { tags.add(word); } // keep the word itself as a tag
    });

    // Meme format detection
    const normTitle = normalize(title);
    FORMAT_PATTERNS.forEach(({ pattern, tags: fmtTags }) => {
        if (pattern.test(title) || pattern.test(normTitle))
            fmtTags.forEach(t => tags.add(t));
    });

    // Always add: komedi, meme as base tags
    tags.add('meme'); tags.add('komedi');

    return [...tags].filter(t => t.length > 1).slice(0, 10);
}

async function generateTags(title, transcript = '') {
    if (!process.env.GEMINI_API_KEY) return _localGenerateTags(title);
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const transcriptHint = transcript
            ? `\nVideodaki diyalog/konuşmalar:\n"${transcript.substring(0, 500)}"`
            : '';
        const prompt = `Sen bir meme video etiketleme asistanısın. Aşağıdaki video başlığı için en iyi arama etiketlerini üret.

Video başlığı: "${title}"${transcriptHint}

Kurallar:
- 6-8 etiket üret
- Türkçe ve İngilizce karışık olabilir
- Kısa (1-2 kelime) ve arama dostu olsun
- Meme kültürüne uygun olsun
- Sadece JSON array döndür, başka hiçbir şey yazma
- Küçük harf, boşluksuz veya kısa kelimeler

Örnek çıktı: ["kedi","cat","komedi","fail","funny","viral","hayvan","düşme"]`;

        const result = await model.generateContent(prompt);
        const cleaned = result.response.text().trim().replace(/```json|```/g, '').trim();
        const tags = JSON.parse(cleaned);
        if (!Array.isArray(tags)) return _localGenerateTags(title);
        return tags.map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 10);
    } catch (err) {
        console.warn(`⚠️  Auto-tagging AI failed, using local: ${err.message.slice(0, 60)}`);
        return _localGenerateTags(title);
    }
}

// ─── Gemini Audio Transcription (Inline MP3 via ffmpeg) ───────────────────────────────────
// Returns: { transcript: string, hasSpeech: boolean }
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

function extractAudio(videoPath, audioPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate(64) // 64kbps is enough for speech
            .on('end', () => resolve(audioPath))
            .on('error', err => reject(err))
            .save(audioPath);
    });
}


async function generateTranscript(videoBuffer, mimeType = 'video/mp4', maxRetries = 3) {
    if (!process.env.GEMINI_API_KEY) return { transcript: '', hasSpeech: false };

    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let videoTmpPath = null;
        let audioTmpPath = null;
        try {
            // 1. Write video buffer to temp file
            videoTmpPath = path.join(os.tmpdir(), `memebot_vid_${Date.now()}_${attempt}.mp4`);
            audioTmpPath = path.join(os.tmpdir(), `memebot_aud_${Date.now()}_${attempt}.mp3`);

            fs.writeFileSync(videoTmpPath, videoBuffer);

            // 2. Extract Audio (extremely fast for small memes)
            await extractAudio(videoTmpPath, audioTmpPath);
            const audioBuffer = fs.readFileSync(audioTmpPath);
            const b64 = audioBuffer.toString('base64');

            // 3. Clean up temp files immediately to save disk space
            try { fs.unlinkSync(videoTmpPath); } catch (_) { }
            try { fs.unlinkSync(audioTmpPath); } catch (_) { }
            videoTmpPath = null;
            audioTmpPath = null;

            // 4. Send MP3 directly inline to Gemini (No File API needed!)
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const prompt = `Bu sesi dinle ve içindeki TÜM Türkçe konuşmaları, diyalogları ve seslendirmeleri olduğu gibi yaz.
Eğer hiç konuşma yoksa (sadece müzik, efekt veya sessizlik), tam olarak şunu yaz: KONUSMA_YOK
Başka hiçbir açıklama ekleme, sadece konuşmaları yaz.`;

            const result = await withTimeout(
                model.generateContent([
                    { inlineData: { mimeType: 'audio/mp3', data: b64 } },
                    prompt,
                ]),
                30000 // 30s timeout
            );

            const text = result.response.text().trim();
            const hasSpeech = text !== 'KONUSMA_YOK' && text.length > 3;
            const transcript = hasSpeech ? text : '';

            console.log(`🎙️  Transcript [attempt ${attempt}]: hasSpeech=${hasSpeech}, length=${transcript.length}`);

            return { transcript, hasSpeech };

        } catch (err) {
            lastErr = err;
            if (videoTmpPath) { try { fs.unlinkSync(videoTmpPath); } catch (_) { } }
            if (audioTmpPath) { try { fs.unlinkSync(audioTmpPath); } catch (_) { } }
            console.warn(`⚠️  Transcript attempt ${attempt}/${maxRetries} failed: ${err.message.slice(0, 80)}`);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, 3000 * attempt));
        }
    }

    console.error(`❌ Transcript failed after ${maxRetries} attempts: ${lastErr?.message}`);
    return { transcript: '', hasSpeech: false };
}

// ─── Gemini Video-to-Text (Vision from thumbnail) ────────────────────────────
async function generateVideoDescription(imageBuffer, mimeType = 'image/jpeg') {
    if (!process.env.GEMINI_API_KEY) return null;
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `Sen bir meme arama motoru için video sahnesi betimleyicisisin.
Sana bir meme videosunun temsilci karesini (thumbnail) veriyorum.
Bu sahnede tam olarak ne oluyor?
- Mekan, ortam nasıl?
- Kişilerin dış görünüşü (kıyafet rengi, saç vb.) nasıl?
- Ne yapıyorlar, hareketleri ve mimikleri nasıl?
- İnsanlar bu videoyu ararken hangi kelimelerle arardı?

1 veya 2 cümleyle, doğrudan, arama motoruna uygun kelimeler kullanarak betimle. Yorum katma, sadece gördüğünü tanımla.`;

        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType
            }
        };

        const result = await model.generateContent([prompt, imagePart]);
        const description = result.response.text().trim();
        console.log(`👁️  Vision Description: "${description.substring(0, 100)}..."`);
        return description;
    } catch (err) {
        console.warn(`⚠️  Vision API failed: ${err.message.slice(0, 80)}`);
        return null;
    }
}

module.exports = { expandQuery, generateEmbedding, generateTags, generateVideoDescription, generateTranscript };
