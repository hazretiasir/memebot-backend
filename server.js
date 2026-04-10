require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { send: tg } = require('./utils/telegram_notify');

const videoRoutes    = require('./routes/videos');
const searchRoutes   = require('./routes/searches');
const downloaderRoutes = require('./routes/downloader');
const telegramRoutes = require('./routes/telegram');
const notificationsRoutes = require('./routes/notifications');

// Initialize Firebase Admin
const admin = require("firebase-admin");

try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Render (Production): read from env var
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        // Local dev: read from file
        serviceAccount = require("./config/firebase-service-account.json");
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK initialized');
} catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');
const fs = require('fs');

// ─── Local Logging Bridge ─────────────────────────────────────────────────────
// All console.log/error will also go to backend/app.log for easy viewing
const logFile = path.join(__dirname, 'app.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
    const timestamp = new Date().toLocaleString('tr-TR');
    logStream.write(`[${timestamp}] [LOG] ${args.join(' ')}\n`);
    originalLog.apply(console, args);
};

console.error = function (...args) {
    const timestamp = new Date().toLocaleString('tr-TR');
    logStream.write(`[${timestamp}] [ERR] ${args.join(' ')}\n`);
    originalError.apply(console, args);
};

console.log('--- Server Logging Started ---');

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/videos', videoRoutes);
app.use('/api/searches', searchRoutes);
app.use('/api/downloader', downloaderRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/telegram', telegramRoutes);


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
        tg(`❌ <b>MemeBot backend BAŞARISIZ</b>\n\nMongoDB bağlantı hatası:\n<code>${err.message}</code>`);
        process.exit(1);
    });

process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err.message);
    tg(`💥 <b>MemeBot backend CRASH (uncaughtException)</b>\n\n<code>${err.message}</code>`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('💥 unhandledRejection:', msg);
    tg(`💥 <b>MemeBot backend CRASH (unhandledRejection)</b>\n\n<code>${msg}</code>`);
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Internal server error' });
});
