#!/usr/bin/env python3
"""
TikTok Session Saver — Yerel makinede bir kez çalıştır.
Browser açılır, TikTok'a manuel login yap, Enter'a bas.
Tam oturum durumu (storage_state) JSON olarak kaydedilir.
→ GitHub Secret'a (TIKTOK_SESSION) yapıştır.
"""

import json
import time
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            no_viewport=True,
            locale="tr-TR",
            timezone_id="Europe/Istanbul",
        )
        page = context.new_page()

        # Önce ana sayfaya git, sonra login'e yönlen
        page.goto("https://www.tiktok.com")
        time.sleep(2)
        page.goto("https://www.tiktok.com/login")

        print("\n✅ Browser açıldı.")
        print("👉 Yeni TikTok hesabına giriş yap (email/şifre veya QR kod).")
        print("👉 Ana sayfaya yönlendirildikten sonra buraya dön ve Enter'a bas.\n")
        input("Giriş tamamlandıktan sonra Enter'a bas: ")

        # Biraz bekle — oturum tokenları settle olsun
        time.sleep(2)

        # Tam oturum durumunu kaydet (cookies + localStorage + sessionStorage)
        state = context.storage_state()
        browser.close()

    # Tam oturumu kaydet (yedek)
    output_path = "tiktok_session.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    # GitHub Secret için origins/localStorage kaldırılmış küçük versiyon
    small = {"cookies": state.get("cookies", []), "origins": []}
    small_json = json.dumps(small, ensure_ascii=False, separators=(",", ":"))
    small_size = len(small_json.encode("utf-8"))
    GITHUB_SECRET_LIMIT = 65536  # 64 KB

    small_path = "tiktok_session_small.json"
    with open(small_path, "w", encoding="utf-8") as f:
        f.write(small_json)

    cookie_count = len(state.get("cookies", []))
    origin_count = len(state.get("origins", []))
    print(f"\n✅ Oturum kaydedildi → {output_path}")
    print(f"   {cookie_count} cookie, {origin_count} origin kaydedildi.")
    print(f"\n✅ GitHub Secret versiyonu → {small_path}")
    print(f"   Boyut: {small_size} bytes ({small_size // 1024} KB) — limit: 64 KB")

    if small_size > GITHUB_SECRET_LIMIT:
        print(f"❌ UYARI: {small_path} hâlâ {small_size} bytes — GitHub Secret limitini ({GITHUB_SECRET_LIMIT}) aşıyor!")
    else:
        print(f"✅ Boyut limiti içinde.")

    print("\n📋 Sonraki adım:")
    print("   GitHub repo → Settings → Secrets → Actions → TIKTOK_SESSION")
    print(f"   Value: {small_path} dosyasının tüm içeriğini yapıştır\n")
    print("⚠️  tiktok_session.json ve tiktok_session_small.json dosyalarını commit'leme!\n")


if __name__ == "__main__":
    main()
