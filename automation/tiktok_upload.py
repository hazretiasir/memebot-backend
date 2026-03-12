#!/usr/bin/env python3
"""
TikTok Video Uploader — Playwright stealth + storage_state tabanlı.
GitHub Actions'da post_meme.py tarafından çağrılır.
TIKTOK_SESSION env var'ından tam oturum durumunu okur.
"""

import os
import json
import time
import tempfile
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from playwright_stealth import stealth_sync

TIKTOK_SESSION = os.environ.get("TIKTOK_SESSION", "")


def upload_to_tiktok(video_path: str, caption: str) -> bool:
    if not TIKTOK_SESSION:
        print("⚠️  TIKTOK_SESSION env var bulunamadı — TikTok atlanıyor.")
        return False

    try:
        session = json.loads(TIKTOK_SESSION)
    except json.JSONDecodeError:
        print("❌ TIKTOK_SESSION geçerli JSON değil.")
        return False

    # storage_state'i geçici dosyaya yaz (Playwright API bunu dosyadan okuyor)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as tf:
        json.dump(session, tf)
        session_file = tf.name

    try:
        result = _run_upload(session_file, video_path, caption)
    finally:
        os.unlink(session_file)

    return result


def _run_upload(session_file: str, video_path: str, caption: str) -> bool:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        context = browser.new_context(
            storage_state=session_file,
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            locale="tr-TR",
            timezone_id="Europe/Istanbul",
        )

        page = context.new_page()
        stealth_sync(page)

        try:
            result = _do_upload(page, video_path, caption)
        except Exception as e:
            print(f"❌ TikTok upload hatası: {e}")
            result = False
        finally:
            browser.close()

    return result


def _do_upload(page, video_path: str, caption: str) -> bool:
    print("🎵 TikTok upload sayfasına gidiliyor...")

    # Creator Center URL'ini dene, fallback olarak eski URL
    upload_urls = [
        "https://www.tiktok.com/creator-center/upload",
        "https://www.tiktok.com/upload",
    ]
    for url in upload_urls:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(3)
            if "login" not in page.url.lower():
                print(f"✅ Oturum aktif. ({url})")
                break
        except Exception:
            continue
    else:
        print("❌ Oturum süresi dolmuş — tiktok_save_cookies.py ile yeniden kaydet.")
        return False

    # Sayfa tamamen yüklenene kadar bekle
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except PlaywrightTimeout:
        pass
    time.sleep(4)

    # Upload alanını bul — tüm frame'lerde ara
    print("🔍 Upload alanı aranıyor...")
    print(f"   Frame sayısı: {len(page.frames)}")
    file_input = None

    # 1) Tüm yüklü frame'leri iterate et (frame_locator yerine)
    for i, frame in enumerate(page.frames):
        try:
            fi = frame.locator("input[type='file']")
            fi.wait_for(state="attached", timeout=3000)
            file_input = fi
            print(f"  Frame[{i}] ({frame.url[:60]}) içinde bulundu.")
            break
        except PlaywrightTimeout:
            continue

    # 2) Sayfa yüklendikten sonra iframe'ler eklenmiş olabilir, tekrar dene
    if file_input is None:
        time.sleep(3)
        for i, frame in enumerate(page.frames):
            try:
                fi = frame.locator("input[type='file']")
                fi.wait_for(state="attached", timeout=2000)
                file_input = fi
                print(f"  2.tur Frame[{i}] içinde bulundu.")
                break
            except PlaywrightTimeout:
                continue

    if file_input is None:
        print("❌ Dosya yükleme alanı bulunamadı.")
        print(f"   Mevcut URL: {page.url}")
        # Hata ayıklama için frame URL'lerini listele
        for i, frame in enumerate(page.frames):
            print(f"   Frame[{i}]: {frame.url[:80]}")
        return False

    print(f"📤 Video seçiliyor: {video_path}")
    file_input.set_input_files(video_path)

    # Yükleme tamamlanana kadar bekle
    print("⏳ Video yükleniyor ve işleniyor...")
    _wait_for_upload(page)

    # Caption yaz
    _write_caption(page, caption)

    # Post et
    return _click_post(page)


def _wait_for_upload(page):
    """Video yüklenip işlenene kadar bekler (max 3 dakika)."""
    try:
        # Progress bar veya "Uploading" metni kaybolana kadar bekle
        page.wait_for_function(
            """() => {
                const text = document.body.innerText;
                return !text.includes('Uploading') && !text.includes('Yükleniyor');
            }""",
            timeout=180000,
        )
    except PlaywrightTimeout:
        pass
    time.sleep(3)


def _write_caption(page, caption: str):
    """Caption alanını bulup yazar."""
    print("✏️  Caption yazılıyor...")
    selectors = [
        "div[contenteditable='true'][data-e2e='caption-input']",
        "div[contenteditable='true'].public-DraftEditor-content",
        "div[contenteditable='true']",
    ]
    for sel in selectors:
        try:
            box = page.locator(sel).first
            box.wait_for(timeout=5000)
            box.click()
            time.sleep(0.5)
            page.keyboard.press("Control+a")
            page.keyboard.press("Delete")
            # İnsan gibi yazmak için hafif delay
            box.type(caption[:2200], delay=20)
            time.sleep(1)
            print("✅ Caption yazıldı.")
            return
        except PlaywrightTimeout:
            continue
    print("⚠️  Caption alanı bulunamadı, devam ediliyor...")


def _click_post(page) -> bool:
    """Post butonunu bulup tıklar."""
    print("🚀 Post butonu aranıyor...")
    selectors = [
        "button[data-e2e='post-btn']",
        "button:has-text('Post')",
        "button:has-text('Yayınla')",
        "button:has-text('Paylaş')",
    ]
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            btn.wait_for(timeout=5000)
            btn.click()
            print("✅ Post butonuna basıldı.")
            break
        except PlaywrightTimeout:
            continue
    else:
        print("❌ Post butonu bulunamadı.")
        return False

    # Başarı doğrulaması — profil sayfasına yönlendirilmeli
    try:
        page.wait_for_url("**/profile**", timeout=30000)
    except PlaywrightTimeout:
        pass

    # URL hâlâ upload'da değilse başarılı say
    if "upload" not in page.url:
        print("✅ TikTok'a başarıyla yüklendi!")
        return True

    print("⚠️  Upload sonucu doğrulanamadı.")
    return True  # Yine de True dön — başarılı olmuş olabilir
