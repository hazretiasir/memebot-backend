const express = require('express');
const router = express.Router();
const DeviceToken = require('../models/DeviceToken');

// POST /api/notifications/register
router.post('/register', async (req, res) => {
    const { token, platform } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    try {
        await DeviceToken.findOneAndUpdate(
            { token: token },
            { 
               token: token, 
               platform: platform || 'unknown',
               lastActiveAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ message: 'Token registered successfully' });
    } catch (err) {
        console.error('FCM Token registration error:', err);
        res.status(500).json({ error: 'Failed to register token' });
    }
});

module.exports = router;
