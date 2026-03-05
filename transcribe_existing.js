/**
 * transcribe_existing.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Batch script: Transcribes audio for all existing videos (hasSpeech = null).
 * After transcription, re-generates tags (with transcript) and embedding.
 *
 * Usage:  node transcribe_existing.js
 *
 * Behavior:
 *   - Concurrency: 4 parallel workers (safe for Gemini free-tier rate limits)
 *   - Retry: maxRetries = 3 per video (exponential backoff)
 *   - Idempotent: only processes videos where hasSpeech = null
 *   - Progress: logged to terminal as [N/TOTAL] ✅ or ❌
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const pLimit = require('p-limit');

const Video = require('./models/Video');
const { generateTranscript, generateTags, generateEmbedding } = require('./utils/gemini');

const CONCURRENCY = 4;
const limit = pLimit(CONCURRENCY);

// ── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadVideoBuffer(url) {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(resp.data);
}

// ── Process a single video ────────────────────────────────────────────────────
async function processVideo(video, index, total) {
    const label = `[${index}/${total}] "${video.title.substring(0, 50)}"`;

    try {
        // 1. Download from S3 / CloudFront
        const videoBuffer = await downloadVideoBuffer(video.s3Url);
        const mimeType = 'video/mp4';

        // 2. Transcribe (maxRetries=3 handled inside generateTranscript)
        const { transcript, hasSpeech } = await generateTranscript(videoBuffer, mimeType);

        // 3. Re-generate tags using transcript as semantic signal
        const newTags = await generateTags(video.title, transcript);
        const mergedTags = [...new Set([...(video.tags || []), ...newTags])];

        // 4. Build unified searchText → single embedding
        const searchText = [
            video.title,
            mergedTags.join(' '),
            video.description || '',
            transcript,
        ].join(' ').trim();
        const embedding = await generateEmbedding(searchText);

        // 5. Persist all updates to MongoDB
        const update = {
            transcript,
            hasSpeech,
            searchText,
            tags: mergedTags,
            ...(embedding ? { embedding } : {}),
        };
        await Video.findByIdAndUpdate(video._id, update);

        console.log(`✅ ${label} — hasSpeech=${hasSpeech}, tags=${mergedTags.length}, transcript_len=${transcript.length}`);

    } catch (err) {
        // Mark as processed-but-failed (hasSpeech=false) so we don't retry endlessly
        await Video.findByIdAndUpdate(video._id, { hasSpeech: false, transcript: '' }).catch(() => { });
        console.error(`❌ ${label} — ERROR: ${err.message.slice(0, 100)}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected!\n');

    // Only fetch videos that haven't been transcribed yet
    const videos = await Video.find({ hasSpeech: null }, '_id title tags description s3Url').lean();
    const total = videos.length;
    console.log(`🎙️  Found ${total} unprocessed videos. Starting batch transcription with concurrency=${CONCURRENCY}...\n`);

    if (total === 0) {
        console.log('Nothing to do. All videos already processed.');
        await mongoose.disconnect();
        return;
    }

    const startTime = Date.now();

    const tasks = videos.map((video, i) =>
        limit(() => processVideo(video, i + 1, total))
    );
    await Promise.all(tasks);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    const processed = await Video.countDocuments({ hasSpeech: { $ne: null } });
    const withSpeech = await Video.countDocuments({ hasSpeech: true });

    console.log(`\n🏁 DONE in ${mins}m${secs}s`);
    console.log(`   Total processed : ${processed}`);
    console.log(`   Has speech       : ${withSpeech}`);
    console.log(`   No speech/failed : ${processed - withSpeech}`);

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
