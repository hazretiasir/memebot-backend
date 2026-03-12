/**
 * Telegram bildirim yardımcısı (Node.js).
 * TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID yoksa sessizce atlar.
 */

const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

async function send(message) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id:    CHAT_ID,
            text:       message,
            parse_mode: 'HTML',
        }, { timeout: 10000 });
    } catch (_) { /* Bildirim başarısız olsa da akışı engelleme */ }
}

module.exports = { send };
