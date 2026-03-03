require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const videoRoutes = require('./routes/videos');
const searchRoutes = require('./routes/searches');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/videos', videoRoutes);
app.use('/api/searches', searchRoutes);


app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('✅ MongoDB connected');
        app.listen(PORT, () => {
            console.log(`🚀 MemeBot backend running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error('❌ MongoDB connection error:', err.message);
        process.exit(1);
    });

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Internal server error' });
});
