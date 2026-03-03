const express = require('express');
const router = express.Router();
const SearchLog = require('../models/SearchLog');

// ─── GET /api/searches/trending ──────────────────────────────────────────────
// Returns top N queries from the last 24 hours, ranked by search count.
router.get('/trending', async (req, res) => {
    const { limit = 8 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 8, 20);

    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    try {
        const trending = await SearchLog.aggregate([
            // 1. Only last 24 hours
            { $match: { createdAt: { $gte: oneDayAgo } } },

            // 2. Group by query, count occurrences
            {
                $group: {
                    _id: '$query',
                    count: { $sum: 1 },
                    lastSearched: { $max: '$createdAt' },
                },
            },

            // 3. Sort by popularity descending
            { $sort: { count: -1, lastSearched: -1 } },

            // 4. Limit
            { $limit: limitNum },

            // 5. Shape output
            {
                $project: {
                    _id: 0,
                    query: '$_id',
                    count: 1,
                },
            },
        ]);

        res.json({ trending });
    } catch (err) {
        console.error('Trending search error:', err);
        res.status(500).json({ error: 'Failed to fetch trending searches' });
    }
});

// ─── DELETE /api/searches/trending (admin cleanup — optional) ─────────────────
// Removes all search logs older than 30 days to keep collection small.
router.delete('/cleanup', async (req, res) => {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const result = await SearchLog.deleteMany({ createdAt: { $lt: thirtyDaysAgo } });
        res.json({ deleted: result.deletedCount });
    } catch (err) {
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

module.exports = router;
