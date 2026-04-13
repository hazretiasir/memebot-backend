const express = require('express');
const router = express.Router();
const axios = require('axios');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

/**
 * GET /api/youtube/search?q=recep+ivedik+pilates&limit=3
 *
 * Searches YouTube and returns video metadata for embedding.
 * Only called as fallback when local DB search returns 0 results.
 */
router.get('/search', async (req, res) => {
    const { q, limit = 3 } = req.query;

    if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: 'Query too short' });
    }

    if (!YOUTUBE_API_KEY) {
        return res.status(503).json({ error: 'YouTube API not configured' });
    }

    try {
        const response = await axios.get(YOUTUBE_SEARCH_URL, {
            params: {
                key: YOUTUBE_API_KEY,
                q: q.trim(),
                part: 'snippet',
                type: 'video',
                maxResults: Math.min(parseInt(limit) || 3, 5),
                relevanceLanguage: 'tr',
                safeSearch: 'none',
            },
            timeout: 8000,
        });

        const videos = (response.data.items || []).map(item => ({
            youtubeId: item.id.videoId,
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
            publishedAt: item.snippet.publishedAt,
            source: 'youtube',
        }));

        console.log(`🔴 YouTube search: "${q}" → ${videos.length} results`);
        res.json({ videos, query: q.trim() });

    } catch (err) {
        const status = err.response?.status;
        const message = err.response?.data?.error?.message || err.message;
        console.error(`❌ YouTube API error [${status}]: ${message}`);

        if (status === 403) {
            return res.status(403).json({ error: 'YouTube API quota exceeded' });
        }
        res.status(500).json({ error: 'YouTube search failed' });
    }
});

module.exports = router;
