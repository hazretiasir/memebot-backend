#!/usr/bin/env python3
"""
MemeBot Health Check
Her sabah çalışır. MongoDB, S3, Instagram token ve TikTok token kontrol eder.
Herhangi bir kontrol başarısız olursa exit(1) ile çıkar → GitHub Actions kırmızı olur.
"""

import os
import sys
import requests
import boto3
from pymongo import MongoClient
from botocore.exceptions import ClientError

MONGODB_URI           = os.environ["MONGODB_URI"]
AWS_ACCESS_KEY_ID     = os.environ["AWS_ACCESS_KEY_ID"]
AWS_SECRET_ACCESS_KEY = os.environ["AWS_SECRET_ACCESS_KEY"]
AWS_REGION            = os.environ.get("AWS_REGION", "eu-central-1")
S3_BUCKET             = os.environ["S3_BUCKET_NAME"]
INSTAGRAM_USER_ID     = os.environ.get("INSTAGRAM_USER_ID", "")
INSTAGRAM_ACCESS_TOKEN= os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
TIKTOK_REFRESH_TOKEN  = os.environ.get("TIKTOK_REFRESH_TOKEN", "")
TIKTOK_CLIENT_KEY     = os.environ.get("TIKTOK_CLIENT_KEY", "")
TIKTOK_CLIENT_SECRET  = os.environ.get("TIKTOK_CLIENT_SECRET", "")

errors = []


def check_mongodb():
    print("🔍 MongoDB kontrol ediliyor...")
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client["memebot"]
        total  = db["videos"].count_documents({})
        posted = db["videos"].count_documents({"everPosted": True})
        remaining = total - posted

        # MongoDB'deki güncel token'ı oku
        cfg_doc = db["config"].find_one({"key": "instagram_access_token"})
        token_source = "MongoDB" if cfg_doc else "env var"

        client.close()
        print(f"   ✅ Bağlantı OK — {total} video, {posted} paylaşıldı, {remaining} kaldı")
        print(f"   ℹ️  Instagram token kaynağı: {token_source}")

        if remaining == 0:
            errors.append("⚠️  Tüm videolar paylaşıldı — yeni içerik ekle!")
        elif remaining < 10:
            print(f"   ⚠️  Sadece {remaining} video kaldı, yakında içerik ekle.")
    except Exception as e:
        errors.append(f"❌ MongoDB bağlantı hatası: {e}")
        print(f"   ❌ {e}")


def check_s3():
    print("🔍 S3 kontrol ediliyor...")
    try:
        s3 = boto3.client(
            "s3",
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            region_name=AWS_REGION,
        )
        resp = s3.list_objects_v2(Bucket=S3_BUCKET, MaxKeys=1)
        count = resp.get("KeyCount", 0)
        print(f"   ✅ S3 erişimi OK — bucket: {S3_BUCKET} ({count} obje örnek)")
    except ClientError as e:
        errors.append(f"❌ S3 erişim hatası: {e}")
        print(f"   ❌ {e}")


def check_instagram_token():
    print("🔍 Instagram token kontrol ediliyor...")
    if not INSTAGRAM_USER_ID or not INSTAGRAM_ACCESS_TOKEN:
        print("   ⚠️  Instagram credentials eksik — atlıyor.")
        return

    # Önce MongoDB'deki token'ı dene
    token = INSTAGRAM_ACCESS_TOKEN
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=3000)
        doc = client["memebot"]["config"].find_one({"key": "instagram_access_token"})
        if doc and doc.get("value"):
            token = doc["value"]
        client.close()
    except Exception:
        pass

    try:
        resp = requests.get(
            f"https://graph.facebook.com/v18.0/{INSTAGRAM_USER_ID}",
            params={"fields": "id,name", "access_token": token},
            timeout=10,
        )
        data = resp.json()
        if "error" in data:
            errors.append(f"❌ Instagram token geçersiz: {data['error'].get('message', '')}")
            print(f"   ❌ Token geçersiz: {data['error'].get('message', '')}")
        else:
            print(f"   ✅ Instagram token OK — hesap: {data.get('name', data.get('id'))}")
    except Exception as e:
        errors.append(f"❌ Instagram API hatası: {e}")
        print(f"   ❌ {e}")


def check_tiktok_token():
    print("🔍 TikTok token kontrol ediliyor...")
    if not TIKTOK_REFRESH_TOKEN:
        print("   ⚠️  TIKTOK_REFRESH_TOKEN eksik — atlıyor.")
        return

    try:
        resp = requests.post(
            "https://open.tiktokapis.com/v2/oauth/token/",
            data={
                "client_key":    TIKTOK_CLIENT_KEY,
                "client_secret": TIKTOK_CLIENT_SECRET,
                "grant_type":    "refresh_token",
                "refresh_token": TIKTOK_REFRESH_TOKEN,
            },
            timeout=10,
        )
        data = resp.json()
        if "access_token" in data:
            print(f"   ✅ TikTok token OK — yenilendi.")
        else:
            errors.append(f"❌ TikTok token yenilenemedi: {data}")
            print(f"   ❌ {data}")
    except Exception as e:
        errors.append(f"❌ TikTok API hatası: {e}")
        print(f"   ❌ {e}")


def main():
    print("🏥 MemeBot Health Check başlıyor...\n")

    check_mongodb()
    check_s3()
    check_instagram_token()
    check_tiktok_token()

    print("\n" + "─" * 40)
    if errors:
        print(f"❌ {len(errors)} sorun tespit edildi:")
        for e in errors:
            print(f"   {e}")
        sys.exit(1)
    else:
        print("✅ Tüm kontroller başarılı — sistem sağlıklı.")


if __name__ == "__main__":
    main()
