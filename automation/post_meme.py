#!/usr/bin/env python3
"""
MemeBot Social Media Auto-Poster
Runs via GitHub Actions 3x/day.
- Picks a random unposted video from MongoDB
- Posts to Instagram as Reel (via Graph API, uses S3 presigned URL directly)
- Posts to TikTok (via Content Posting API, downloads file temporarily)
- Marks video as posted in MongoDB so it's never reposted
"""

import os
import sys
import time
import tempfile
import boto3
import requests
from pymongo import MongoClient
from datetime import datetime, timezone, timedelta
from tiktok_upload import upload_to_tiktok
from telegram_notify import send as tg

# ── Config ────────────────────────────────────────────────────────────────────

MONGODB_URI          = os.environ["MONGODB_URI"]
AWS_ACCESS_KEY_ID    = os.environ["AWS_ACCESS_KEY_ID"]
AWS_SECRET_ACCESS_KEY= os.environ["AWS_SECRET_ACCESS_KEY"]
AWS_REGION           = os.environ.get("AWS_REGION", "eu-central-1")
S3_BUCKET            = os.environ["S3_BUCKET_NAME"]

INSTAGRAM_USER_ID    = os.environ.get("INSTAGRAM_USER_ID", "")
INSTAGRAM_ACCESS_TOKEN = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
TIKTOK_ONLY          = os.environ.get("TIKTOK_ONLY", "").lower() == "true"

# ── Instagram Token Yönetimi ──────────────────────────────────────────────────

def get_instagram_token(db) -> str:
    """
    Token'ı MongoDB'den okur. 45 günden eskiyse yeniler ve kaydeder.
    MongoDB'de kayıt yoksa env var'daki token'ı kullanır ve kaydeder.
    """
    cfg = db["config"]
    doc = cfg.find_one({"key": "instagram_access_token"})

    token = doc["value"] if doc else INSTAGRAM_ACCESS_TOKEN
    if not token:
        return ""

    # 45 günden eskiyse yenile, doc yoksa (ilk çalışma) sadece kaydet
    needs_refresh = False
    if doc and doc.get("refreshed_at"):
        age = datetime.now(timezone.utc) - doc["refreshed_at"].astimezone(timezone.utc)
        needs_refresh = age >= timedelta(days=45)

    if needs_refresh:
        print("🔄 Instagram token yenileniyor...")
        resp = requests.get(
            "https://graph.instagram.com/refresh_access_token",
            params={"grant_type": "ig_refresh_token", "access_token": token},
            timeout=15,
        )
        data = resp.json()
        if "access_token" in data:
            token = data["access_token"]
            cfg.update_one(
                {"key": "instagram_access_token"},
                {"$set": {"value": token, "refreshed_at": datetime.now(timezone.utc)}},
                upsert=True,
            )
            print(f"✅ Token yenilendi, {data.get('expires_in', '?')} sn geçerli.")
            tg("🔄 <b>Instagram token yenilendi.</b>")
        else:
            print(f"⚠️  Token yenilenemedi: {data} — mevcut token kullanılıyor.")
    else:
        # İlk kez MongoDB'ye kaydet
        if not doc:
            cfg.update_one(
                {"key": "instagram_access_token"},
                {"$set": {"value": token, "refreshed_at": datetime.now(timezone.utc)}},
                upsert=True,
            )

    return token

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
        total = col.count_documents({})
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


# ── Instagram ─────────────────────────────────────────────────────────────────

def post_to_instagram(video_url: str, caption: str, token: str, thumbnail_url: str = None) -> bool:
    if not INSTAGRAM_USER_ID or not token:
        print("⚠️  Instagram credentials not configured — skipping.")
        return False

    base = f"https://graph.facebook.com/v18.0/{INSTAGRAM_USER_ID}"

    # 1. Create Reel container
    print("📸 Creating Instagram Reel container...")
    params = {
        "media_type":    "REELS",
        "video_url":     video_url,
        "caption":       caption,
        "share_to_feed": "true",
        "access_token":  token,
    }
    if thumbnail_url:
        params["cover_url"] = thumbnail_url
        print(f"   Thumbnail URL eklendi.")

    r = requests.post(f"{base}/media", data=params, timeout=30)

    if r.status_code != 200:
        print(f"❌ Container creation failed ({r.status_code}): {r.text}")
        return False

    container_id = r.json()["id"]
    print(f"   Container ID: {container_id}")

    # 2. Poll until processing is finished (max ~5 min)
    print("⏳ Waiting for Instagram to process video...")
    for attempt in range(20):
        time.sleep(15)
        s = requests.get(
            f"https://graph.facebook.com/v18.0/{container_id}",
            params={"fields": "status_code", "access_token": token},
            timeout=15,
        ).json().get("status_code", "UNKNOWN")
        print(f"   [{attempt+1}/20] status: {s}")
        if s == "FINISHED":
            break
        if s == "ERROR":
            print("❌ Instagram processing error.")
            return False

    # 3. Publish Reel
    print("🚀 Publishing Reel...")
    pub = requests.post(f"{base}/media_publish", data={
        "creation_id": container_id,
        "access_token": token,
    }, timeout=30)

    if pub.status_code != 200:
        print(f"❌ Publish failed ({pub.status_code}): {pub.text}")
        return False

    media_id = pub.json().get("id")
    print(f"✅ Instagram Reel published! Media ID: {media_id}")

    # 4. Story — thumbnail varsa image story, yoksa atla
    if thumbnail_url:
        _post_instagram_story(base, token, thumbnail_url)

    return True


def _post_instagram_story(base: str, token: str, thumbnail_url: str):
    """Thumbnail ile Instagram Story paylaşır."""
    print("📖 Instagram Story paylaşılıyor...")
    r = requests.post(f"{base}/media", data={
        "media_type":   "STORIES",
        "image_url":    thumbnail_url,
        "access_token": token,
    }, timeout=30)

    if r.status_code != 200:
        print(f"⚠️  Story container hatası ({r.status_code}): {r.text[:100]}")
        return

    story_id = r.json().get("id")
    time.sleep(3)

    pub = requests.post(f"{base}/media_publish", data={
        "creation_id":  story_id,
        "access_token": token,
    }, timeout=30)

    if pub.status_code == 200:
        print(f"✅ Instagram Story published!")
    else:
        print(f"⚠️  Story publish hatası ({pub.status_code}): {pub.text[:100]}")




# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print("🤖 MemeBot Auto-Poster starting —", now_str)
    tg(f"🤖 <b>MemeBot paylaşım başlıyor...</b>\n{now_str}")

    # MongoDB
    client = MongoClient(MONGODB_URI)
    db     = client["memebot"]
    col    = db["videos"]

    # Instagram token — MongoDB'den al, gerekirse yenile
    ig_token = get_instagram_token(db)

    # S3
    s3 = boto3.client(
        "s3",
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION,
    )

    # Pick video
    video = get_unposted_video(col)
    print(f"🎬 Selected: \"{video['title']}\" (ID: {video['_id']})")

    s3_key = video.get("s3Key", "")
    if not s3_key:
        print("❌ Video has no s3Key — aborting.")
        sys.exit(1)

    caption          = build_caption(video)
    posted_platforms = []

    # ── Instagram (presigned URL → no local download needed) ──────────────────
    if TIKTOK_ONLY:
        print("⏭️  Instagram atlandı (tiktok_only modu).")
    else:
        url           = presigned_url(s3, s3_key, expires=7200)
        thumbnail_key = video.get("thumbnailKey")
        thumb_url     = presigned_url(s3, thumbnail_key, expires=7200) if thumbnail_key else None
        if post_to_instagram(url, caption, token=ig_token, thumbnail_url=thumb_url):
            posted_platforms.append("instagram")

    # ── TikTok (Content Posting API) ──────────────────────────────────────────
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        print(f"⬇️  TikTok için video indiriliyor ({s3_key})...")
        s3.download_file(S3_BUCKET, s3_key, tmp_path)
        if upload_to_tiktok(tmp_path, caption):
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
