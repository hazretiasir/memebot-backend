/**
 * Telegram bildirim yardımcısı (backend/utils).
 * TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID yoksa sessizce atlar.
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

function send(message) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    const body = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {}); // sessizce yut
    req.write(body);
    req.end();
}

module.exports = { send };
