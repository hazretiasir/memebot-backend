#!/usr/bin/env python3
"""
MemeBot Günlük Arama Raporu (Mobil Uygulama)
Her sabah çalışır. Dünkü arama istatistiklerini Telegram'a gönderir.
"""

import os
import sys
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
from telegram_notify import send as tg

MONGODB_URI = os.environ["MONGODB_URI"]


def main():
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=10000)
    db = client["memebot"]
    col = db["searchlogs"]

    now       = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)

    # ── Dünkü toplam arama sayısı ─────────────────────────────────────────────
    total = col.count_documents({"createdAt": {"$gte": yesterday}})

    # ── En popüler 5 arama terimi ─────────────────────────────────────────────
    top_terms = list(col.aggregate([
        {"$match":  {"createdAt": {"$gte": yesterday}}},
        {"$group":  {"_id": "$query", "count": {"$sum": 1}}},
        {"$sort":   {"count": -1}},
        {"$limit":  5},
    ]))

    client.close()

    if total == 0:
        tg("📱 <b>MemeBot Günlük Arama Raporu (Mobil Uygulama)</b>\n\nDün hiç arama yapılmadı.")
        return

    date_str = yesterday.strftime("%d %b %Y")
    lines = [
        f"📱 <b>MemeBot Günlük Arama Raporu (Mobil Uygulama)</b>",
        f"📅 {date_str}",
        f"",
        f"🔍 Toplam arama: <b>{total}</b>",
        f"",
        f"🏆 En çok aranan 5 terim:",
    ]

    medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"]
    for i, term in enumerate(top_terms):
        lines.append(f"   {medals[i]} <b>{term['_id']}</b> — {term['count']} kez")

    message = "\n".join(lines)
    print(message.replace("<b>", "").replace("</b>", ""))
    tg(message)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        tg(f"❌ <b>Günlük arama raporu gönderilemedi</b>\n<code>{e}</code>")
        sys.exit(1)
