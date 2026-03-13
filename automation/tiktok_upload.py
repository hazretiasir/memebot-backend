#!/usr/bin/env python3
"""
TikTok Video Uploader — Resmi Content Posting API (REST, browser yok).
GitHub Actions'da post_meme.py tarafından çağrılır.
Token otomatik yenilenir.
"""

import os
import math
import time
import requests
from telegram_notify import send as tg

BASE = "https://open.tiktokapis.com"


def upload_to_tiktok(video_path: str, caption: str, access_token: str) -> bool:
    if not access_token:
        print("⚠️  TikTok access token yok — atlanıyor.")
        return False

    token = access_token
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json; charset=UTF-8",
    }

    video_size   = os.path.getsize(video_path)
    chunk_size   = 10 * 1024 * 1024  # 10 MB
    total_chunks = math.ceil(video_size / chunk_size)

    print(f"📤 TikTok API upload başlıyor… "
          f"({video_size // 1024 // 1024} MB, {total_chunks} parça)")

    # 1. Upload başlat
    init_payload = {
        "post_info": {
            "title":              caption[:2200],
            "privacy_level":      "SELF_ONLY",  # Sandbox: sadece hesap sahibi görür. Production onayı sonrası PUBLIC_TO_EVERYONE yap.
            "disable_duet":       False,
            "disable_comment":    False,
            "disable_stitch":     False,
        },
        "source_info": {
            "source":             "FILE_UPLOAD",
            "video_size":         video_size,
            "chunk_size":         min(chunk_size, video_size),
            "total_chunk_count":  total_chunks,
        },
    }

    resp = requests.post(
        f"{BASE}/v2/post/publish/video/init/",
        json=init_payload, headers=headers, timeout=30,
    )
    result = resp.json()
    err = result.get("error", {})

    if err.get("code", "") != "ok":
        print(f"❌ Upload init hatası: {result}")
        return False

    publish_id = result["data"]["publish_id"]
    upload_url = result["data"]["upload_url"]
    print(f"✅ Upload başlatıldı — publish_id: {publish_id}")

    # 2. Dosyayı parça parça yükle
    with open(video_path, "rb") as f:
        for idx in range(total_chunks):
            chunk = f.read(chunk_size)
            start = idx * chunk_size
            end   = start + len(chunk) - 1

            put_resp = requests.put(
                upload_url,
                data=chunk,
                headers={
                    "Content-Range":  f"bytes {start}-{end}/{video_size}",
                    "Content-Length": str(len(chunk)),
                    "Content-Type":   "video/mp4",
                },
                timeout=120,
            )
            print(f"   Parça {idx + 1}/{total_chunks}: HTTP {put_resp.status_code}")

            if put_resp.status_code not in (200, 201, 206):
                print(f"❌ Parça yükleme hatası: {put_resp.text[:200]}")
                return False

    print("⏳ TikTok işliyor…")

    # 3. Durum sorgula (max 3 dk)
    for attempt in range(18):
        time.sleep(10)
        status_resp = requests.post(
            f"{BASE}/v2/post/publish/status/fetch/",
            json={"publish_id": publish_id},
            headers=headers,
            timeout=15,
        )
        status_data = status_resp.json()
        status = status_data.get("data", {}).get("status", "UNKNOWN")
        print(f"   [{attempt + 1}/18] status: {status}")

        if status == "PUBLISH_COMPLETE":
            print("✅ TikTok'a başarıyla yüklendi!")
            return True
        if status in ("FAILED", "ERROR"):
            fail_reason = status_data.get("data", {}).get("fail_reason", "")
            print(f"❌ TikTok yükleme başarısız: {fail_reason or status_data}")
            return False

    print("⚠️  TikTok yükleme zaman aşımına uğradı.")
    return False
