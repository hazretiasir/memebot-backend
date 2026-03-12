#!/usr/bin/env python3
"""
Telegram bildirim yardımcısı.
TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID env var'ları yoksa sessizce atlar.
"""

import os
import requests

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.environ.get("TELEGRAM_CHAT_ID", "")


def send(message: str) -> None:
    """Telegram'a mesaj gönderir. Token/chat ID yoksa atlar."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id":    TELEGRAM_CHAT_ID,
                "text":       message,
                "parse_mode": "HTML",
            },
            timeout=10,
        )
    except Exception:
        pass  # Bildirim başarısız olsa da ana akışı engelleme
