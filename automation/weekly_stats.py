#!/usr/bin/env python3
"""
MemeBot Haftalık İstatistik Raporu (Mobil Uygulama)
Her Pazartesi sabahı çalışır. Geçen haftanın uygulama içi
görüntülenme, like ve indirme verilerini Telegram'a gönderir.
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
    col = db["videos"]

    now      = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    # ── Genel toplamlar ───────────────────────────────────────────────────────
    totals = list(col.aggregate([
        {"$group": {
            "_id":           None,
            "total_videos":  {"$sum": 1},
            "total_views":   {"$sum": "$viewCount"},
            "total_likes":   {"$sum": "$likes"},
            "total_dislikes":{"$sum": "$dislikes"},
            "total_downloads":{"$sum": "$downloadCount"},
        }}
    ]))
    t = totals[0] if totals else {}

    # ── Bu hafta eklenen videolar ─────────────────────────────────────────────
    new_this_week = col.count_documents({"createdAt": {"$gte": week_ago}})

    # ── Bu haftanın en çok izlenen videosu ───────────────────────────────────
    top_video = col.find_one(
        {"createdAt": {"$gte": week_ago}},
        sort=[("viewCount", -1)],
        projection={"title": 1, "viewCount": 1},
    )

    # ── Sosyal medyaya paylaşılan (toplam) ────────────────────────────────────
    posted_total = col.count_documents({"everPosted": True})
    remaining    = t.get("total_videos", 0) - posted_total

    client.close()

    # ── Raporu oluştur ────────────────────────────────────────────────────────
    week_str = f"{week_ago.strftime('%d %b')} – {now.strftime('%d %b %Y')}"

    lines = [
        f"📱 <b>MemeBot Haftalık Rapor (Mobil Uygulama)</b>",
        f"📅 {week_str}",
        f"",
        f"👁  Toplam görüntülenme:  <b>{t.get('total_views', 0):,}</b>",
        f"❤️  Toplam like:          <b>{t.get('total_likes', 0):,}</b>",
        f"👎 Toplam dislike:        <b>{t.get('total_dislikes', 0):,}</b>",
        f"⬇️  Toplam indirme:       <b>{t.get('total_downloads', 0):,}</b>",
        f"",
        f"🎬 Toplam video:          <b>{t.get('total_videos', 0):,}</b>",
        f"🆕 Bu hafta eklenen:      <b>{new_this_week}</b>",
        f"📲 Sosyal medyaya giden:  <b>{posted_total}</b>",
        f"📦 Stok kalan:            <b>{remaining}</b>",
    ]

    if top_video:
        lines += [
            f"",
            f"🏆 Bu haftanın en çok izleneni:",
            f"   <i>{top_video['title'][:60]}</i> ({top_video['viewCount']:,} görüntülenme)",
        ]

    message = "\n".join(lines)
    print(message.replace("<b>", "").replace("</b>", "").replace("<i>", "").replace("</i>", ""))
    tg(message)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        tg(f"❌ <b>Haftalık rapor gönderilemedi</b>\n<code>{e}</code>")
        sys.exit(1)
