const express = require('express');
const router = express.Router();
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3Client = require('../config/aws');
const Video = require('../models/Video');

// Average video size estimate in MB (used for GB display only)
const AVG_VIDEO_MB = 7;

// Pack tier definitions
const PACK_TIERS = {
    starter: { pct: 0.30, minCount: 800 },
    pro: { pct: 0.70, minCount: 2000 },
    mega: { pct: 1.00, minCount: null },
};

function calcPackCount(total, packType) {
    if (packType === 'mega') return total;
    const t = PACK_TIERS[packType];
    return Math.max(t.minCount, Math.round(total * t.pct));
}

// ─── GET /api/packs/info ─────────────────────────────────────────────────────
// Returns dynamic pack metadata: video counts + estimated sizes for each tier
router.get('/info', async (req, res) => {
    try {
        const total = await Video.countDocuments({ isApproved: { $ne: false } });
        const starterCount = calcPackCount(total, 'starter');
        const proCount = calcPackCount(total, 'pro');
        const megaCount = total;

        res.json({
            totalVideos: total,
            packs: {
                starter: {
                    videoCount: starterCount,
                    estimatedGB: parseFloat((starterCount * AVG_VIDEO_MB / 1024).toFixed(1)),
                },
                pro: {
                    videoCount: proCount,
                    estimatedGB: parseFloat((proCount * AVG_VIDEO_MB / 1024).toFixed(1)),
                },
                mega: {
                    videoCount: megaCount,
                    estimatedGB: parseFloat((megaCount * AVG_VIDEO_MB / 1024).toFixed(1)),
                },
            },
        });
    } catch (err) {
        console.error('Pack info error:', err);
        res.status(500).json({ error: 'Failed to get pack info' });
    }
});

// ─── POST /api/packs/videos ──────────────────────────────────────────────────
// Paginated list of video records for a pack tier (no presigned URLs yet)
router.post('/videos', async (req, res) => {
    try {
        const { packType, page = 1, pageSize = 50 } = req.body;
        if (!PACK_TIERS[packType]) return res.status(400).json({ error: 'Invalid pack type' });

        const total = await Video.countDocuments({ isApproved: { $ne: false } });
        const packCount = calcPackCount(total, packType);
        const skip = (page - 1) * pageSize;

        if (skip >= packCount) {
            return res.json({ packType, page, pageSize, totalInPack: packCount, videos: [] });
        }

        const limit = Math.min(pageSize, packCount - skip);
        const videos = await Video.find({ isApproved: { $ne: false } })
            .sort({ relevanceScore: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('_id s3Key title')
            .lean();

        res.json({
            packType,
            page,
            pageSize,
            totalInPack: packCount,
            videos: videos.map(v => ({
                id: v._id.toString(),
                s3Key: v.s3Key,
                title: v.title,
            })),
        });
    } catch (err) {
        console.error('Pack videos error:', err);
        res.status(500).json({ error: 'Failed to get pack videos' });
    }
});

// ─── POST /api/packs/presign ─────────────────────────────────────────────────
// Returns presigned S3 download URLs (1-hour TTL) for given items
router.post('/presign', async (req, res) => {
    try {
        const { items } = req.body; // [{ id, s3Key, title }]
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items array required' });
        }
        if (items.length > 100) {
            return res.status(400).json({ error: 'Max 100 items per request' });
        }

        const urls = await Promise.all(
            items.map(async ({ id, s3Key, title }) => {
                const cmd = new GetObjectCommand({
                    Bucket: process.env.S3_BUCKET_NAME,
                    Key: s3Key,
                    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(title || 'video')}.mp4"`,
                });
                const url = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
                return { id, url };
            })
        );

        res.json({ urls });
    } catch (err) {
        console.error('Pack presign error:', err);
        res.status(500).json({ error: 'Presign failed' });
    }
});

// ─── GET /api/packs/updates?packType=X&since=ISO_DATE ────────────────────────
// Returns videos added to the system after the given timestamp
router.get('/updates', async (req, res) => {
    try {
        const { packType, since } = req.query;
        if (!PACK_TIERS[packType]) return res.status(400).json({ error: 'Invalid pack type' });
        if (!since) return res.status(400).json({ error: 'since is required' });

        const sinceDate = new Date(since);
        if (isNaN(sinceDate.getTime())) return res.status(400).json({ error: 'Invalid since date' });

        const newVideos = await Video.find({
            isApproved: { $ne: false },
            createdAt: { $gt: sinceDate },
        })
            .sort({ createdAt: 1 })
            .select('_id s3Key title')
            .lean();

        res.json({
            packType,
            since,
            newCount: newVideos.length,
            videos: newVideos.map(v => ({
                id: v._id.toString(),
                s3Key: v.s3Key,
                title: v.title,
            })),
        });
    } catch (err) {
        console.error('Pack updates error:', err);
        res.status(500).json({ error: 'Update check failed' });
    }
});

module.exports = router;
