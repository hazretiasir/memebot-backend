#!/usr/bin/env python3
"""
MemeBot Social Media Auto-Poster
Runs via GitHub Actions 3x/day.
- Picks a random unposted video from MongoDB
- Posts to Instagram as Reel (via instagrapi, sessionid cookie)
- Posts to TikTok (via Content Posting API)
- Marks video as posted in MongoDB so it's never reposted
"""

import os
import sys
import time
import tempfile
import urllib.parse
import boto3
import requests
from pathlib import Path
from pymongo import MongoClient
from datetime import datetime, timezone, timedelta
from tiktok_upload import upload_to_tiktok
from telegram_notify import send as tg

# ── Config ────────────────────────────────────────────────────────────────────

MONGODB_URI           = os.environ["MONGODB_URI"]
AWS_ACCESS_KEY_ID     = os.environ["AWS_ACCESS_KEY_ID"]
AWS_SECRET_ACCESS_KEY = os.environ["AWS_SECRET_ACCESS_KEY"]
AWS_REGION            = os.environ.get("AWS_REGION", "eu-central-1")
S3_BUCKET             = os.environ["S3_BUCKET_NAME"]

INSTAGRAM_SESSION_ID  = os.environ.get("INSTAGRAM_SESSION_ID", "")
TIKTOK_CLIENT_KEY     = os.environ.get("TIKTOK_CLIENT_KEY", "")
TIKTOK_CLIENT_SECRET  = os.environ.get("TIKTOK_CLIENT_SECRET", "")
TIKTOK_ACCESS_TOKEN   = os.environ.get("TIKTOK_ACCESS_TOKEN", "")
TIKTOK_REFRESH_TOKEN  = os.environ.get("TIKTOK_REFRESH_TOKEN", "")
TIKTOK_ONLY           = os.environ.get("TIKTOK_ONLY", "").lower() == "true"

# ── Instagram Session Yönetimi ────────────────────────────────────────────────

def get_instagram_session(db) -> str:
    """
    Instagram session_id'yi MongoDB'den okur.
    MongoDB'de kayıt yoksa env var'daki session_id'yi kullanır ve kaydeder.
    Döndürülen değer URL-decode edilmiş ham session_id'dir.
    """
    cfg = db["config"]
    doc = cfg.find_one({"key": "instagram_session_id"})

    raw = doc["value"] if doc else INSTAGRAM_SESSION_ID
    if not raw:
        return ""

    # URL decode: 65789932680%3A... → 65789932680:...
    session_id = urllib.parse.unquote(raw)

    # İlk kez MongoDB'ye kaydet
    if not doc:
        cfg.update_one(
            {"key": "instagram_session_id"},
            {"$set": {"value": raw, "refreshed_at": datetime.now(timezone.utc)}},
            upsert=True,
        )

    return session_id


# ── TikTok Token Yönetimi ─────────────────────────────────────────────────────

def get_tiktok_token(db) -> str:
    """
    Access token'ı refresh token ile yeniler.
    Güncel refresh + access token'ı MongoDB'ye kaydeder.
    """
    cfg = db["config"]

    doc = cfg.find_one({"key": "tiktok_refresh_token"})
    refresh_token = doc["value"] if doc else TIKTOK_REFRESH_TOKEN

    if not refresh_token:
        return TIKTOK_ACCESS_TOKEN

    resp = requests.post(
        "https://open.tiktokapis.com/v2/oauth/token/",
        data={
            "client_key":    TIKTOK_CLIENT_KEY,
            "client_secret": TIKTOK_CLIENT_SECRET,
            "grant_type":    "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=15,
    )
    data = resp.json()

    if "access_token" in data:
        new_access  = data["access_token"]
        new_refresh = data.get("refresh_token", refresh_token)
        now = datetime.now(timezone.utc)

        cfg.update_one(
            {"key": "tiktok_access_token"},
            {"$set": {"value": new_access, "refreshed_at": now}},
            upsert=True,
        )
        cfg.update_one(
            {"key": "tiktok_refresh_token"},
            {"$set": {"value": new_refresh, "refreshed_at": now}},
            upsert=True,
        )
        print("🔄 TikTok token yenilendi ve MongoDB'ye kaydedildi.")
        tg("🔄 <b>TikTok token yenilendi.</b>")
        return new_access

    print(f"⚠️  TikTok token yenilenemedi: {data}")
    tg(f"⚠️ <b>TikTok token yenilenemedi!</b>\n<code>{data}</code>")
    acc_doc = cfg.find_one({"key": "tiktok_access_token"})
    return acc_doc["value"] if acc_doc else TIKTOK_ACCESS_TOKEN


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_unposted_video(col):
    """Returns a random video that has never been posted to social media.
    everPosted=True olan videolar sonsuza kadar atlanır, hiçbir zaman sıfırlanmaz."""
    pipeline = [
        {"$match": {"everPosted": {"$ne": True}}},
        {"$sample": {"size": 1}},
        {"$project": {"_id": 1, "title": 1, "tags": 1, "s3Key": 1, "thumbnailKey": 1}},
    ]
    result = list(col.aggregate(pipeline))

    if not result:
        total  = col.count_documents({})
        posted = col.count_documents({"everPosted": True})
        print(f"⚠️  Tüm videolar paylaşıldı ({posted}/{total}) — yeni içerik eklenmesi gerekiyor.")
        sys.exit(0)

    return result[0]


def presigned_url(s3, key, expires=3600):
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=expires,
    )


def build_caption(video):
    title    = video.get("title", "Meme Video")
    tags     = video.get("tags", [])
    hashtags = " ".join(f"#{t.replace(' ', '')}" for t in tags[:10] if t)
    cta      = "📲 Türkiye'nin en iyi meme uygulaması → bio'da"
    return f"{title}\n\n{cta}\n\n{hashtags}".strip()


# ── Instagram (instagrapi — cookie tabanlı) ───────────────────────────────────

def post_to_instagram(video_path: str, caption: str, session_id: str) -> bool:
    if not session_id:
        print("⚠️  Instagram session_id tanımlı değil — atlanıyor.")
        return False

    try:
        from instagrapi import Client

        print("📸 Instagram'a bağlanılıyor (cookie inject)...")
        cl = Client()
        cl.delay_range = [1, 3]

        # login_by_sessionid() cloud IP'lerde Instagram'ın bot-detection
        # endpointini tetikler. Cookie'yi doğrudan settings'e yazıyoruz.
        user_id = session_id.split(":")[0]
        cl.set_settings({
            "cookies": {
                "sessionid": session_id,
                "ds_user_id": user_id,
            },
            "authorization_data": {
                "ds_user_id": user_id,
                "sessionid": session_id,
            },
            "last_login": int(__import__("time").time()),
        })
        print(f"   ✅ Cookie yüklendi (user_id: {user_id})")

        print("🎬 Instagram Reel yükleniyor...")
        media = cl.clip_upload(
            path=Path(video_path),
            caption=caption,
        )

        print(f"✅ Instagram Reel paylaşıldı! Media ID: {media.pk}")
        return True

    except Exception as e:
        err_msg = str(e)
        print(f"❌ Instagram paylaşım hatası: {err_msg}")
        tg(f"❌ <b>Instagram paylaşım hatası!</b>\n<code>{err_msg[:300]}</code>")
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print("🤖 MemeBot Auto-Poster starting —", now_str)
    tg(f"🤖 <b>MemeBot paylaşım başlıyor...</b>\n{now_str}")

    # MongoDB
    client = MongoClient(MONGODB_URI)
    db     = client["memebot"]
    col    = db["videos"]

    # Instagram session — MongoDB'den al
    ig_session = get_instagram_session(db)

    # TikTok token — MongoDB'den al, refresh et, kaydet
    tt_token = get_tiktok_token(db)

    # S3
    s3 = boto3.client(
        "s3",
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION,
    )

    # Pick video
    video   = get_unposted_video(col)
    s3_key  = video.get("s3Key", "")
    print(f"🎬 Selected: \"{video['title']}\" (ID: {video['_id']})")

    if not s3_key:
        print("❌ Video has no s3Key — aborting.")
        sys.exit(1)

    caption          = build_caption(video)
    posted_platforms = []

    # ── Video'yu yerel diske indir (her iki platform da kullanır) ─────────────
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        print(f"⬇️  Video indiriliyor ({s3_key})...")
        s3.download_file(S3_BUCKET, s3_key, tmp_path)
        print(f"   ✅ İndirildi: {tmp_path}")

        # ── Instagram ─────────────────────────────────────────────────────────
        if TIKTOK_ONLY:
            print("⏭️  Instagram atlandı (tiktok_only modu).")
        else:
            if post_to_instagram(tmp_path, caption, session_id=ig_session):
                posted_platforms.append("instagram")

        # ── TikTok ────────────────────────────────────────────────────────────
        if upload_to_tiktok(tmp_path, caption, tt_token):
            posted_platforms.append("tiktok")

    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    # ── Mark as posted ─────────────────────────────────────────────────────────
    if posted_platforms:
        col.update_one(
            {"_id": video["_id"]},
            {"$set": {
                "everPosted":      True,
                "socialPostedAt":  datetime.now(timezone.utc),
                "socialPlatforms": posted_platforms,
            }},
        )
        print(f"✅ Marked as posted on: {', '.join(posted_platforms)}")
        platforms_str = " + ".join(p.capitalize() for p in posted_platforms)
        tg(
            f"✅ <b>MemeBot yeni video paylaştı!</b>\n\n"
            f"🎬 <b>{video['title']}</b>\n"
            f"📲 Platform: {platforms_str}"
        )
    else:
        print("⚠️  No platform succeeded — video NOT marked as posted.")
        tg(
            f"⚠️ <b>MemeBot paylaşım başarısız!</b>\n\n"
            f"🎬 Video: {video['title']}\n"
            f"Hiçbir platforma paylaşılamadı."
        )

    client.close()
    print("🏁 Done!")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        tg(f"💥 <b>MemeBot CRASH!</b>\n\n<code>{e}</code>")
        raise
