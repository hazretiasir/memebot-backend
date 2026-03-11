require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const videoRoutes = require('./routes/videos');
const searchRoutes = require('./routes/searches');
const downloaderRoutes = require('./routes/downloader');

const app = express();
const PORT = process.env.PORT || 3000;
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/videos', videoRoutes);
app.use('/api/searches', searchRoutes);
app.use('/api/downloader', downloaderRoutes);


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

// ─── Automated Tasks ────────────────────────────────────────────────────────
// Run the auto scraper twice a day: at 08:00 AM and 20:00 (8:00 PM)
cron.schedule('0 8,20 * * *', () => {
    console.log(`[CRON] Running auto_scraper.js at ${new Date().toISOString()}`);
    // We spawn it as a child process so it doesn't block the main event loop
    // and correctly loads all its puppeteer environment safely.
    const scraperPath = path.join(__dirname, 'scripts', 'auto_scraper.js');
    const scraperProcess = spawn('node', [scraperPath]);

    scraperProcess.stdout.on('data', (data) => {
        console.log(`[Scraper]: ${data}`);
    });

    scraperProcess.stderr.on('data', (data) => {
        console.error(`[Scraper Error]: ${data}`);
    });

    scraperProcess.on('close', (code) => {
        console.log(`[CRON] auto_scraper.js finished with exit code ${code}`);
    });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Internal server error' });
});
