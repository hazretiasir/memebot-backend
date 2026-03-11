const express = require('express');
const router = express.Router();
const multer = require('multer');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const s3Client = require('../config/aws');
const Video = require('../models/Video');
const SearchLog = require('../models/SearchLog');
const { generateAndUploadThumbnail } = require('../utils/thumbnail');
const { expandQuery, generateEmbedding, generateTags, generateVideoDescription, generateTranscript } = require('../utils/gemini');





// Multer: store in memory, then upload to S3
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'), false);
        }
    },
});

// Helper: build public S3 URL (or CloudFront if configured)
function buildUrl(key) {
    const cf = process.env.CLOUDFRONT_DOMAIN;
    if (cf) return `${cf}/${key}`;
    return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// Helper: generate pre-signed URL for thumbnail (1 hour TTL)
async function getThumbnailSignedUrl(thumbnailKey) {
    if (!thumbnailKey) return null;
    try {
        return await getSignedUrl(
            s3Client,
            new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: thumbnailKey }),
            { expiresIn: 3600 }
        );
    } catch (_) {
        return null;
    }
}

// Helper: map a Video document to response JSON (with pre-signed thumbnail)
async function videoToJson(v) {
    const signedThumb = await getThumbnailSignedUrl(v.thumbnailKey);
    return {
        _id: v._id,
        title: v.title,
        tags: v.tags,
        s3Url: v.s3Url,
        thumbnailUrl: signedThumb,
        tweetUrl: v.tweetUrl,
        likes: v.likes,
        dislikes: v.dislikes,
        relevanceScore: v.relevanceScore,
        viewCount: v.viewCount,
        downloadCount: v.downloadCount,
        createdAt: v.createdAt,
    };
}

// ─── POST /api/videos/upload ─────────────────────────────────────────────────
router.post('/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
    }

    const { title, tags, uploadedBy, tweetUrl } = req.body;
    if (!title) {
        return res.status(400).json({ error: 'Title is required' });
    }

    try {
        const ext = req.file.originalname.split('.').pop();
        const key = `videos/${uuidv4()}.${ext}`;

        // Upload to S3
        await s3Client.send(
            new PutObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME,
                Key: key,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            })
        );

        const s3Url = buildUrl(key);

        // Parse tags
        let parsedTags = [];
        if (tags) {
            parsedTags = typeof tags === 'string'
                ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
                : tags;
        }

        // Save to MongoDB
        const video = new Video({
            title,
            tags: parsedTags,
            s3Key: key,
            s3Url,
            uploadedBy: uploadedBy || 'anonymous',
            tweetUrl: tweetUrl || null,
        });

        await video.save();

        // ── Post-processing in background (non-blocking) ──────
        const videoBuffer = req.file.buffer;
        const videoMime = req.file.mimetype;
        const videoId = video._id;

        setImmediate(async () => {
            try {
                // ── STEP 1: Generate Thumbnail ────────────────────────────────────────
                const { thumbUrl, thumbKey, thumbBuffer } = await generateAndUploadThumbnail(videoBuffer, videoMime);
                console.log(`✅ Thumbnail generated for video ${videoId}`);
                await Video.findByIdAndUpdate(videoId, { thumbnailUrl: thumbUrl, thumbnailKey: thumbKey });

                // ── STEP 2: Audio Transcript (strongest semantic signal) ──────────
                const { transcript, hasSpeech } = await generateTranscript(videoBuffer, videoMime);
                console.log(`🎙️  Transcript done: hasSpeech=${hasSpeech}, len=${transcript.length}`);

                // ── STEP 3: AI Description from Thumbnail ─────────────────────
                let aiDescription = null;
                if (thumbBuffer) {
                    aiDescription = await generateVideoDescription(thumbBuffer, 'image/jpeg');
                    if (aiDescription) console.log(`✅ AI Description generated for video ${videoId}`);
                }

                // ── STEP 4: AI Tags → now powered by transcript too ──────────────
                const aiTags = await generateTags(title, transcript);
                const mergedTags = [...new Set([...parsedTags, ...aiTags])];

                // ── STEP 5: Build unified searchText & Embedding ──────────────
                const searchText = [title, mergedTags.join(' '), aiDescription || '', transcript].join(' ').trim();
                const embedding = await generateEmbedding(searchText);
                if (embedding) console.log(`✅ Embedding generated for video ${videoId}`);

                // ── STEP 6: Persist everything ───────────────────────────────
                await Video.findByIdAndUpdate(videoId, {
                    description: aiDescription,
                    tags: mergedTags,
                    transcript,
                    hasSpeech,
                    searchText,
                    ...(embedding ? { embedding } : {}),
                });
                console.log(`🏁 Post-processing complete for video ${videoId}`);
            } catch (err) {
                console.error(`⚠️ Post-processing failed for ${videoId}:`, err.message);
            }
        });


        res.status(201).json({

            message: 'Video uploaded successfully',
            video: {
                _id: video._id,
                title: video.title,
                tags: video.tags,
                s3Url: video.s3Url,
                tweetUrl: video.tweetUrl,
                likes: video.likes,
                dislikes: video.dislikes,
                relevanceScore: video.relevanceScore,
                createdAt: video.createdAt,
            },
        });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed', details: err.message });
    }
});

// ─── GET /api/videos/suggest-tags?title=... ─────────────────────────────────
// Returns AI-generated tag suggestions for a given video title (pre-upload)
router.get('/suggest-tags', async (req, res) => {
    const { title } = req.query;
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: 'title is required' });
    }
    try {
        const tags = await generateTags(title.trim());
        res.json({ tags });
    } catch (err) {
        res.status(500).json({ error: 'Tag generation failed', tags: [] });
    }
});

// ─── GET /api/videos/suggestions?q=... ──────────────────────────────────────
// Returns real search suggestions from actual video titles + tags (no AI cost)
router.get('/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ suggestions: [] });

    // Escape regex special characters for safety
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    try {
        const [titleMatches, tagMatches] = await Promise.all([
            // Titles that contain the query
            Video.find({ title: regex })
                .select('title')
                .sort({ relevanceScore: -1 })
                .limit(5)
                .lean(),
            // Tags that contain the query (from popular videos)
            Video.find({ tags: { $elemMatch: { $regex: escaped, $options: 'i' } } })
                .select('tags')
                .sort({ relevanceScore: -1 })
                .limit(8)
                .lean(),
        ]);

        const suggestions = [];       // final ordered list (preserves title casing)
        const seenNormalized = new Set(); // for case-insensitive dedup

        // Titles first (higher quality signal, better capitalization)
        titleMatches.forEach((v) => {
            const key = v.title.toLowerCase().trim();
            if (!seenNormalized.has(key)) {
                seenNormalized.add(key);
                suggestions.push(v.title);
            }
        });

        // Tags second — only add if not already represented by title
        tagMatches.forEach((v) => {
            (v.tags || []).forEach((tag) => {
                if (regex.test(tag)) {
                    const key = tag.toLowerCase().trim();
                    if (!seenNormalized.has(key)) {
                        seenNormalized.add(key);
                        suggestions.push(tag);
                    }
                }
            });
        });

        res.json({ suggestions: suggestions.slice(0, 8) });
    } catch (err) {
        console.error('[Suggestions] Error:', err.message);
        res.json({ suggestions: [] }); // Graceful degradation
    }
});

// ─── GET /api/videos/check?url=...&title=... ────────────────────────────
// Checks if a video already exists by its source URL or exact title
router.get('/check', async (req, res) => {
    const { url, title } = req.query;
    try {
        const query = { $or: [] };
        if (url) query.$or.push({ tweetUrl: url });
        if (title) {
            // Escape special regex characters in title to prevent crashes
            const escapedTitle = title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or.push({ title: { $regex: `^${escapedTitle}$`, $options: 'i' } });
        }

        if (query.$or.length === 0) return res.json({ exists: false });

        const video = await Video.findOne(query).select('_id title tweetUrl');
        res.json({ exists: !!video, video });
    } catch (err) {
        res.status(500).json({ exists: false, error: err.message });
    }
});

// ─── GET /api/videos/search?q=...&limit=5 ────────────────────────────────────
router.get('/search', async (req, res) => {
    const { q, limit = 1, page = 1, excludeIds } = req.query;

    if (!q || q.trim() === '') {
        return res.status(400).json({ error: 'Search query is required' });
    }

    try {
        const query = q.trim().toLowerCase();
        const limitNum = Math.min(parseInt(limit) || 1, 20);
        const pageNum = Math.max(parseInt(page) || 1, 1);
        const skip = (pageNum - 1) * limitNum;
        const excludeArray = excludeIds ? excludeIds.split(',') : [];


        // ── 0. Run query expansion + embedding generation in parallel ─────────
        const [expandedTerms, queryEmbedding] = await Promise.all([
            expandQuery(query),
            generateEmbedding(query),
        ]);

        const scoreMap = new Map(); // id → { video, score }

        function addToMap(results, weight) {
            results.forEach(v => {
                const id = v._id.toString();
                if (excludeArray.includes(id)) return; // User already saw this
                if (scoreMap.has(id)) scoreMap.get(id).score += weight;
                else scoreMap.set(id, { video: v, score: weight });
            });
        }


        // ── 0.5. Doğrudan Peş Peşe Kelimeleri Barındıranlar (Mutlak VIP Öncelik) ───────
        const queryWordsArr = query.split(/\s+/).filter(Boolean);
        if (queryWordsArr.length >= 3) {
            let exactPhrases = [];
            // Aranan cümleden 3'lü (veya daha uzun) peş peşe kelime öbekleri çıkar
            for (let i = 0; i <= queryWordsArr.length - 3; i++) {
                exactPhrases.push(queryWordsArr.slice(i, i + 3).join(' '));
            }
            if (exactPhrases.length > 0) {
                const regexes = exactPhrases.map(p => new RegExp(p, 'i'));
                try {
                    const exactMatches = await Video.find({
                        $or: [
                            { title: { $in: regexes } },
                            { tags: { $in: regexes } },
                            { description: { $in: regexes } },
                            { transcript: { $in: regexes } },
                            { searchText: { $in: regexes } },
                        ]
                    }).limit(10);
                    addToMap(exactMatches, 100); // 3 Kelimeyi Peş Peşe İçerenlere OLAĞANÜSTÜ BONUS!
                } catch (err) { }
            }
        }

        // ── 1. Vector search (semantic — highest trust) ───────────────────────
        if (queryEmbedding) {
            try {
                // Fetch more candidates to allow pagination properly
                const vectorResults = await Video.aggregate([
                    {
                        $vectorSearch: {
                            index: 'vector_index',        // name set in Atlas UI
                            path: 'embedding',
                            queryVector: queryEmbedding,
                            numCandidates: 100,
                            limit: 50,
                        },
                    },
                    {
                        $project: {
                            title: 1, tags: 1, s3Key: 1, s3Url: 1,
                            thumbnailUrl: 1, thumbnailKey: 1, description: 1,
                            likes: 1, dislikes: 1, relevanceScore: 1,
                            viewCount: 1, downloadCount: 1, createdAt: 1,
                            uploadedBy: 1,
                            vectorScore: { $meta: 'vectorSearchScore' },
                        },
                    },
                ]);
                addToMap(vectorResults, 3); // vector results get highest weight
            } catch (err) {
                if (!err.message.includes('PlanExecutor error')) {
                    console.warn('⚠️  Vector search unavailable:', err.message.slice(0, 100));
                }
            }
        }

        // ── 2. Keyword expansion search (runs for all expanded terms) ─────────
        // We fetch up to 50 items here since we handle pagination in memory for hybridization
        const searchPromises = expandedTerms.map(async (term) => {
            const textResults = await Video.find(
                { $text: { $search: term } },
                { score: { $meta: 'textScore' } }
            ).sort({ score: { $meta: 'textScore' }, relevanceScore: -1 }).limit(50);

            if (textResults.length > 0) return textResults;

            const words = term.split(/\s+/).filter(Boolean);
            const regexes = words.map(w => new RegExp(w, 'i'));
            return Video.find({
                $or: [
                    { title: { $in: regexes } },
                    { tags: { $in: regexes } },
                    { description: { $in: regexes } },
                    { transcript: { $in: regexes } },
                    { searchText: { $in: regexes } },
                ],
            }).sort({ relevanceScore: -1, createdAt: -1 }).limit(50);
        });

        const allKeywordResults = await Promise.all(searchPromises);
        allKeywordResults.forEach((results, i) => addToMap(results, i === 0 ? 2 : 1));

        // ── 2.5 Çoklu Kelime (Multi-Word) Uyuşma Bonusu ───────────────────────
        // Arama sorgusundaki kelimelerden 3 ve daha fazlası birebir uyuşuyorsa muazzam bir öncelik puanı ekle
        const queryWords = query.split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
        if (queryWords.length > 0) {
            for (const [id, entry] of scoreMap.entries()) {
                const v = entry.video;
                const searchStr = `${v.title || ''} ${v.description || ''} ${(v.tags || []).join(' ')}`.toLowerCase();

                let matchCount = 0;
                for (const qw of queryWords) {
                    if (searchStr.includes(qw)) matchCount++;
                }

                if (matchCount >= 3) {
                    entry.score += 20; // 3 kelime uyanlar her zaman 1. sıraya (çok can alıcı)
                } else if (matchCount === 2) {
                    entry.score += 5;  // 2 kelime uyanlara yüksek şans
                } else if (matchCount === 1) {
                    entry.score += 1;  // 1 kelime uyanlar sıradan bonus
                }
            }
        }

        // ── 3. Rank, filter by minimum score, apply pagination (slice) ───────
        const MIN_SCORE = 2;
        let allRankedVideos = [...scoreMap.values()]
            .filter(e => e.score >= MIN_SCORE)
            .sort((a, b) => b.score - a.score || b.video.relevanceScore - a.video.relevanceScore)
            .map(e => e.video);

        // ── 4. Still nothing? Fall back to most popular ───────────────────────
        if (allRankedVideos.length === 0) {
            allRankedVideos = await Video.find({
                ...(excludeArray.length > 0 ? { _id: { $nin: excludeArray } } : {})
            })
                .sort({ relevanceScore: -1, likes: -1 })
                .limit(50);
        }

        // Paginate results in memory
        const total = allRankedVideos.length;
        const videos = allRankedVideos.slice(skip, skip + limitNum);

        // ── 4. Side effects (non-blocking) ───────────────────────────────────
        // Increment view counts AND recalculate relevance score per video
        const ids = videos.map(v => v._id);
        setImmediate(async () => {
            try {
                const docs = await Video.find({ _id: { $in: ids } });
                await Promise.all(docs.map(doc => {
                    doc.viewCount += 1;
                    doc.recalculateScore();
                    return doc.save();
                }));
            } catch (_) { /* ignore */ }
        });

        // Log search query for trending only on the first request (non-blocking)
        if (pageNum === 1) {
            SearchLog.create({ query: query }).catch(() => { /* ignore */ });
        }

        res.json({
            query: q,
            count: videos.length,
            total,
            page: pageNum,
            videos: await Promise.all(videos.map(videoToJson)),
        });

    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Search failed', details: err.message });
    }
});


// ─── POST /api/videos/:id/feedback ───────────────────────────────────────────
router.post('/:id/feedback', async (req, res) => {
    const { type } = req.body; // "like" | "dislike" | "search_upvote" | "search_downvote"

    if (!['like', 'dislike', 'search_upvote', 'search_downvote'].includes(type)) {
        return res.status(400).json({ error: 'invalid type string' });
    }

    try {
        const video = await Video.findById(req.params.id);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        if (type === 'like') {
            video.likes += 1;
        } else if (type === 'dislike') {
            video.dislikes += 1;
        } else if (type === 'search_upvote') {
            video.searchUpvotes += 1;
            video.recalculateScore();
        } else if (type === 'search_downvote') {
            video.searchDownvotes += 1;
            video.recalculateScore();
        }

        await video.save();

        res.json({
            message: 'Feedback recorded',
            likes: video.likes,
            dislikes: video.dislikes,
            relevanceScore: video.relevanceScore,
        });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: 'Feedback failed', details: err.message });
    }
});

// ─── POST /api/videos/:id/download ───────────────────────────────────────────
// Returns a pre-signed S3 URL valid for 10 minutes
router.post('/:id/download', async (req, res) => {
    try {
        const video = await Video.findById(req.params.id);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: video.s3Key,
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(video.title)}.mp4"`,
        });

        const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 600 });

        // Increment download count + recalculate score (non-blocking)
        setImmediate(async () => {
            try {
                video.downloadCount += 1;
                video.recalculateScore();
                await video.save();
            } catch (_) { /* ignore */ }
        });

        res.json({ downloadUrl: presignedUrl });
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Download failed', details: err.message });
    }
});

// ─── GET /api/videos/:id/stream ──────────────────────────────────────────────
// Returns a pre-signed S3 URL for inline video streaming (1 hour)
router.get('/:id/stream', async (req, res) => {
    try {
        const video = await Video.findById(req.params.id);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: video.s3Key,
            // No ResponseContentDisposition → browser/player streams inline
        });

        const streamUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        res.json({ streamUrl });
    } catch (err) {
        console.error('Stream error:', err);
        res.status(500).json({ error: 'Stream URL failed', details: err.message });
    }
});

// ─── POST /api/videos/feed ───────────────────────────────────────────────────
// Smart Algorithm: Engagement * Randomness (Infinite Non-Repeating Scroll)
router.post('/feed', async (req, res) => {
    try {
        const { limit = 10, seenIds = [] } = req.body;

        // 1. Zaten Görülen Videoları Dışla
        const objectIdSeenIds = (seenIds || [])
            .filter(id => mongoose.Types.ObjectId.isValid(id))
            .map(id => new mongoose.Types.ObjectId(id));

        const matchStage = {
            $match: {
                _id: { $nin: objectIdSeenIds }
            }
        };

        // 2. Akıllı Pipeline (Smart Aggregation)
        // Kalanlardan rastgele 100 tane alır, izlenme ve skorları harmanlayıp en iyileri çeker.
        // Bu sayede hem çok popülerler hem de hiç izlenmemiş "hidden gem"ler akışa dengeli düşer.
        const videos = await Video.aggregate([
            matchStage,
            { $sample: { size: 100 } }, // Havuz optimizasyonu
            {
                $addFields: {
                    engagementScore: {
                        $add: [
                            1, // Base puan
                            "$likes",
                            { $multiply: ["$downloadCount", 2] },
                            { $multiply: ["$relevanceScore", 0.5] },
                            { $subtract: [0, "$dislikes"] }
                        ]
                    },
                    randomWeight: { $rand: {} } // 0.0 to 1.0 arası şans faktörü
                }
            },
            {
                $addFields: {
                    // Popüler videolar her zaman 1. sırada çıkmasın diye randomize ile çarpıyoruz
                    finalScore: { $multiply: [{ $max: ["$engagementScore", 1] }, "$randomWeight"] }
                }
            },
            { $sort: { finalScore: -1 } },
            { $limit: parseInt(limit) }
        ]);

        const populatedVideos = await Promise.all(videos.map(videoToJson));

        res.json({
            count: populatedVideos.length,
            videos: populatedVideos
        });
    } catch (err) {
        console.error('Feed error:', err);
        res.status(500).json({ error: 'Feed failed', details: err.message });
    }
});

// ─── POST /api/videos/batch ──────────────────────────────────────────────────
// Returns a list of videos matching the provided array of IDs
router.post('/batch', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'List of video IDs is required' });
        }

        // Fetch videos that match the IDs
        const videos = await Video.find({ _id: { $in: ids } });

        // Transform them and get fresh S3 URLs
        const populatedVideos = await Promise.all(videos.map(videoToJson));

        // Return them in the exact order requested if possible, or just send them back
        // We'll let the client handle exact sorting if they want
        res.json({ videos: populatedVideos });
    } catch (err) {
        console.error('Batch fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch batch videos', details: err.message });
    }
});

// ─── GET /api/videos/count ───────────────────────────────────────────────────
router.get('/count', async (req, res) => {
    try {
        const count = await Video.countDocuments();
        res.json({ count });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get count' });
    }
});

// ─── GET /api/videos ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { page = 1, limit = 20, sort = 'recent' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const sortMap = {
            recent: { createdAt: -1 },
            popular: { relevanceScore: -1, likes: -1 },
            most_downloaded: { downloadCount: -1 },
        };

        const sortObj = sortMap[sort] || sortMap.recent;

        const maxLimit = Math.min(parseInt(limit), 5000);

        const [videos, total] = await Promise.all([
            Video.find().sort(sortObj).skip(skip).limit(maxLimit).allowDiskUse(true),
            Video.countDocuments(),
        ]);

        res.json({
            total,
            page: parseInt(page),
            videos: videos.map(v => ({
                _id: v._id,
                title: v.title,
                tags: v.tags,
                s3Url: v.s3Url,
                thumbnailUrl: v.thumbnailUrl,
                likes: v.likes,
                dislikes: v.dislikes,
                relevanceScore: v.relevanceScore,
                downloadCount: v.downloadCount,
                tweetUrl: v.tweetUrl,
                createdAt: v.createdAt,
            })),
        });
    } catch (err) {
        console.error('List error:', err);
        res.status(500).json({ error: 'Failed to list videos', details: err.message });
    }
});

// ─── POST /api/videos/run-scraper ───────────────────────────────────────────
let scraperProcess = null;

router.post('/run-scraper', (req, res) => {
    if (scraperProcess) {
        return res.json({ message: 'Bot zaten çalışıyor' });
    }

    const STATUS_FILE = path.join(__dirname, '..', 'scraper_status.json');
    try {
        // Reset old status before starting
        fs.writeFileSync(STATUS_FILE, JSON.stringify({ status: 'started', stageText: 'Otomasyon Uyandırılıyor...', progress: 0 }));
    } catch (e) { }

    const scriptPath = path.join(__dirname, '..', 'scripts', 'auto_scraper.js');
    const errLog = path.join(__dirname, '..', 'scraper_err.log');

    // fork() uses the SAME node binary already running — most reliable on Windows
    scraperProcess = fork(scriptPath, [], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        silent: true  // pipe child stdout/stderr so we can capture them
    });

    scraperProcess.stdout.on('data', (d) => process.stdout.write('[scraper] ' + d));
    scraperProcess.stderr.on('data', (d) => {
        process.stderr.write('[scraper ERR] ' + d);
        fs.appendFileSync(errLog, d.toString());
    });

    scraperProcess.on('error', (err) => {
        fs.appendFileSync(errLog, `Fork Error: ${err.message}\n`);
        scraperProcess = null;
    });

    scraperProcess.on('close', (code) => {
        console.log(`[scraper] exited with code ${code}`);
        scraperProcess = null;
    });

    res.json({ message: 'Otomasyon Başlatıldı' });
});

// ─── GET /api/videos/scraper-status ─────────────────────────────────────────
router.get('/scraper-status', (req, res) => {
    const STATUS_FILE = path.join(__dirname, '..', 'scraper_status.json');
    try {
        if (fs.existsSync(STATUS_FILE)) {
            const data = fs.readFileSync(STATUS_FILE, 'utf8');
            return res.json(JSON.parse(data));
        }
    } catch (e) { }

    res.json({ status: 'idle', stageText: 'Sistem Beklemede', progress: 0 });
});

module.exports = router;
