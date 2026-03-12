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
import json
import random
import time
import tempfile
import boto3
import requests
from pymongo import MongoClient
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

MONGODB_URI          = os.environ["MONGODB_URI"]
AWS_ACCESS_KEY_ID    = os.environ["AWS_ACCESS_KEY_ID"]
AWS_SECRET_ACCESS_KEY= os.environ["AWS_SECRET_ACCESS_KEY"]
AWS_REGION           = os.environ.get("AWS_REGION", "eu-central-1")
S3_BUCKET            = os.environ["S3_BUCKET_NAME"]

INSTAGRAM_USER_ID    = os.environ.get("INSTAGRAM_USER_ID", "")
INSTAGRAM_ACCESS_TOKEN = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
TIKTOK_ACCESS_TOKEN  = os.environ.get("TIKTOK_ACCESS_TOKEN", "")

# ── Helpers ───────────────────────────────────────────────────────────────────

def get_unposted_video(col):
    """Returns a random video that hasn't been posted to social media yet.
    If all videos have been posted, resets the cycle and starts over."""
    pipeline = [
        {"$match": {"socialPostedAt": {"$exists": False}}},
        {"$sample": {"size": 1}},
        {"$project": {"_id": 1, "title": 1, "tags": 1, "s3Key": 1}},
    ]
    result = list(col.aggregate(pipeline))

    if not result:
        print("♻️  All videos posted — resetting cycle...")
        col.update_many({}, {"$unset": {"socialPostedAt": "", "socialPlatforms": ""}})
        result = list(col.aggregate(pipeline))

    return result[0]


def presigned_url(s3, key, expires=3600):
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=expires,
    )


def build_caption(video):
    title = video.get("title", "Meme Video")
    tags  = video.get("tags", [])
    hashtags = " ".join(f"#{t.replace(' ', '')}" for t in tags[:10] if t)
    base  = "#meme #memes #komedi #memevideo #türkmeme #eğlence #funnyvideo"
    return f"{title}\n\n{hashtags}\n{base}".strip()


# ── Instagram ─────────────────────────────────────────────────────────────────

def post_to_instagram(video_url: str, caption: str) -> bool:
    if not INSTAGRAM_USER_ID or not INSTAGRAM_ACCESS_TOKEN:
        print("⚠️  Instagram credentials not configured — skipping.")
        return False

    base = f"https://graph.facebook.com/v18.0/{INSTAGRAM_USER_ID}"

    # 1. Create media container
    print("📸 Creating Instagram Reel container...")
    r = requests.post(f"{base}/media", data={
        "media_type":    "REELS",
        "video_url":     video_url,
        "caption":       caption,
        "share_to_feed": "true",
        "access_token":  INSTAGRAM_ACCESS_TOKEN,
    }, timeout=30)

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
            params={"fields": "status_code", "access_token": INSTAGRAM_ACCESS_TOKEN},
            timeout=15,
        ).json().get("status_code", "UNKNOWN")
        print(f"   [{attempt+1}/20] status: {s}")
        if s == "FINISHED":
            break
        if s == "ERROR":
            print("❌ Instagram processing error.")
            return False

    # 3. Publish
    print("🚀 Publishing Reel...")
    pub = requests.post(f"{base}/media_publish", data={
        "creation_id": container_id,
        "access_token": INSTAGRAM_ACCESS_TOKEN,
    }, timeout=30)

    if pub.status_code == 200:
        print(f"✅ Instagram published! Media ID: {pub.json().get('id')}")
        return True

    print(f"❌ Publish failed ({pub.status_code}): {pub.text}")
    return False


# ── TikTok ────────────────────────────────────────────────────────────────────

def post_to_tiktok(video_path: str, caption: str) -> bool:
    if not TIKTOK_ACCESS_TOKEN:
        print("⚠️  TikTok credentials not configured — skipping.")
        return False

    file_size = os.path.getsize(video_path)
    headers = {
        "Authorization": f"Bearer {TIKTOK_ACCESS_TOKEN}",
        "Content-Type":  "application/json; charset=UTF-8",
    }

    # 1. Initialize upload
    print("🎵 Initializing TikTok upload...")
    init = requests.post(
        "https://open.tiktokapis.com/v2/post/publish/video/init/",
        headers=headers,
        json={
            "post_info": {
                "title":               caption[:150],
                "privacy_level":       "PUBLIC_TO_EVERYONE",
                "disable_duet":        False,
                "disable_comment":     False,
                "disable_stitch":      False,
            },
            "source_info": {
                "source":             "FILE_UPLOAD",
                "video_size":         file_size,
                "chunk_size":         file_size,   # single chunk
                "total_chunk_count":  1,
            },
        },
        timeout=30,
    )

    if init.status_code != 200:
        print(f"❌ TikTok init failed ({init.status_code}): {init.text}")
        return False

    data       = init.json().get("data", {})
    publish_id = data.get("publish_id")
    upload_url = data.get("upload_url")
    print(f"   Publish ID: {publish_id}")

    # 2. Upload file (single chunk)
    print("📤 Uploading video to TikTok...")
    with open(video_path, "rb") as f:
        up = requests.put(
            upload_url,
            headers={
                "Content-Type":  "video/mp4",
                "Content-Range": f"bytes 0-{file_size-1}/{file_size}",
            },
            data=f,
            timeout=300,
        )

    if up.status_code not in (200, 201):
        print(f"❌ TikTok upload failed ({up.status_code}): {up.text}")
        return False

    print(f"✅ TikTok upload complete! Publish ID: {publish_id}")
    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("🤖 MemeBot Auto-Poster starting —", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))

    # MongoDB
    client = MongoClient(MONGODB_URI)
    col    = client["memebot"]["videos"]

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
    url = presigned_url(s3, s3_key, expires=7200)
    if post_to_instagram(url, caption):
        posted_platforms.append("instagram")

    # ── TikTok (needs local file) ──────────────────────────────────────────────
    if TIKTOK_ACCESS_TOKEN:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            print(f"⬇️  Downloading video for TikTok ({s3_key})...")
            s3.download_file(S3_BUCKET, s3_key, tmp_path)
            if post_to_tiktok(tmp_path, caption):
                posted_platforms.append("tiktok")
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    # ── Mark as posted ─────────────────────────────────────────────────────────
    if posted_platforms:
        col.update_one(
            {"_id": video["_id"]},
            {"$set": {
                "socialPostedAt":  datetime.now(timezone.utc),
                "socialPlatforms": posted_platforms,
            }},
        )
        print(f"✅ Marked as posted on: {', '.join(posted_platforms)}")
    else:
        print("⚠️  No platform succeeded — video NOT marked as posted.")

    client.close()
    print("🏁 Done!")


if __name__ == "__main__":
    main()
