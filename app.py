import os
import asyncio
import traceback
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request
from flask_cors import CORS
import yt_dlp
import requests
from playwright.async_api import async_playwright

app = Flask(__name__)

# Tüm kökenlere (Origins) izin ver
CORS(app, resources={r"/*": {"origins": "*"}})

COOKIE_FILE = "cookies.txt"

CONFIG = {
    "SHOWS": [
        { "name": "Oggy",              "playlistId": "PLTLXNxXgTfEz5rZnXpx9uPx8LbENHN3_A" },
        { "name": "Esrarengiz Kasaba", "playlistId": "PLO7jGcCLf31VzYNKRuiGNjaIpS8Kb_fGB" },
        { "name": "Doraemon",          "playlistId": "PLCxWTrC_hNKNGoehF-TGH89pzp2FGySHx" },
        { "name": "4. Çizgi Film",     "playlistId": "PL3SPOx9gE-q0RtN0a9RP4vtOyB48w89Oz" },
        { "name": "Emiray",            "playlistId": "PL8dXShvpbmneB6w8UzuA1kWYyH0dFDZgJ" }
    ]
}

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    return response

# =========================================================
# OTOMATİK ÇEREZ YENİLEME BOTU (Playwright)
# =========================================================
async def _fetch_fresh_cookies():
    print("🤖 Playwright ile yeni YouTube çerezleri çekiliyor...")
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            page = await context.new_page()
            
            # YouTube ana sayfasına git
            await page.goto("https://www.youtube.com", wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)

            cookies = await context.cookies()
            netscape_cookies = "# Netscape HTTP Cookie File\n"
            for c in cookies:
                domain = c['domain']
                flag = "TRUE" if domain.startswith(".") else "FALSE"
                path = c['path']
                secure = "TRUE" if c['secure'] else "FALSE"
                expiration = int(c.get('expires', 0))
                name = c['name']
                value = c['value']
                netscape_cookies += f"{domain}\t{flag}\t{path}\t{secure}\t{expiration}\t{name}\t{value}\n"

            with open(COOKIE_FILE, "w", encoding="utf-8") as f:
                f.write(netscape_cookies)

            print("✅ Yeni çerezler başarıyla kaydoldu (cookies.txt).")
            await browser.close()
    except Exception as e:
        print(f"❌ Çerez çekme hatası: {e}")

def refresh_cookies():
    """Async çerez motorunu senkron ortama köprüler"""
    try:
        asyncio.run(_fetch_fresh_cookies())
    except Exception as e:
        print(f"Asyncio Çalıştırma Hatası: {e}")

# =========================================================
# PLAYLIST VE STREAM MANTIĞI
# =========================================================
def fetch_single_playlist(show):
    playlist_url = f"https://www.youtube.com/playlist?list={show['playlistId']}"
    
    ydl_opts = {
        'extract_flat': 'in_playlist',
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'playlist_items': '1-100',
        'extractor_args': {
            'youtube': {
                'player_client': ['mweb', 'tvhtml5']
            }
        }
    }
    
    videos = []
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(playlist_url, download=False)
            if info and 'entries' in info:
                for entry in info['entries']:
                    if not entry:
                        continue
                    v_id = entry.get('id')
                    v_title = entry.get('title')
                    if v_id and v_title and v_title not in ["[Private video]", "[Deleted video]"]:
                        videos.append({"id": v_id, "title": v_title})
    except Exception as e:
        print(f"Playlist çekme hatası ({show['name']}): {e}")
        
    return {
        "name": show["name"],
        "playlistId": show["playlistId"],
        "videos": videos
    }

def get_external_stream_fallback(video_id):
    """Aktif Piped ve Invidious API örnekleri üzerinden MP4/M3U8 adresi çeker."""
    # 1. Piped API Örnekleri
    piped_instances = [
        "https://pipedapi.kavin.rocks",
        "https://api.piped.privacydev.net",
        "https://pipedapi.palvelu.org",
        "https://piped-api.garudalinux.org",
        "https://pipedapi.mha.fi"
    ]
    
    for instance in piped_instances:
        try:
            res = requests.get(f"{instance}/streams/{video_id}", timeout=3)
            if res.status_code == 200:
                data = res.json()
                if data.get('hls'):
                    return data.get('hls')
                for stream in data.get('videoStreams', []):
                    if stream.get('url') and not stream.get('videoOnly'):
                        return stream.get('url')
        except Exception:
            continue

    # 2. Invidious API Örnekleri
    invidious_instances = [
        "https://invidious.nerdvpn.de",
        "https://inv.nadeko.net",
        "https://invidious.no-commercial.biz",
        "https://invidious.projectsegfau.lt"
    ]
    
    for instance in invidious_instances:
        try:
            res = requests.get(f"{instance}/api/v1/videos/{video_id}", timeout=3)
            if res.status_code == 200:
                data = res.json()
                format_streams = data.get('formatStreams', [])
                if format_streams:
                    return format_streams[0].get('url')
        except Exception:
            continue

    return None

def get_live_m3u8(video_id):
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    
    ydl_opts = {
        'format': 'best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'extractor_args': {
            'youtube': {
                'player_client': ['ios', 'android']
            }
        }
    }
    
    if os.path.exists(COOKIE_FILE):
        ydl_opts['cookiefile'] = COOKIE_FILE

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            url = info.get('url')
            if url:
                return url
    except Exception as e:
        error_msg = str(e)
        print(f"yt-dlp kısıtlamaya takıldı ({video_id}). Hata: {error_msg}")

        # Eğer Bot veya Giriş Engeline takıldıysa OTOMATİK ÇEREZ YENİLE!
        if "Sign in to confirm" in error_msg or "bot" in error_msg.lower() or "403" in error_msg:
            print("🔄 Bot engeli tespit edildi! Playwright ile çerezler yenileniyor...")
            refresh_cookies()
            
            # Yenilenen çerezle TEKRAR dene
            if os.path.exists(COOKIE_FILE):
                ydl_opts['cookiefile'] = COOKIE_FILE
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(video_url, download=False)
                        if info.get('url'):
                            return info.get('url')
                except Exception as retry_e:
                    print(f"İkinci denemede de yt-dlp başarısız: {retry_e}")

    # yt-dlp ve çerez yenileme tamamen başarısız olursa dış servislere başvur
    return get_external_stream_fallback(video_id)

# =========================================================
# ENDPOINTS
# =========================================================
@app.route('/api/shows', methods=['GET', 'OPTIONS'])
def get_shows():
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    try:
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(fetch_single_playlist, CONFIG["SHOWS"]))
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500

@app.route('/api/stream/<video_id>', methods=['GET', 'OPTIONS'])
def get_stream_link(video_id):
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    try:
        stream_url = get_live_m3u8(video_id)
        if not stream_url:
            return jsonify({
                "error": "Stream adresi bulunamadı",
                "videoId": video_id
            }), 404
            
        return jsonify({
            "videoId": video_id, 
            "streamUrl": stream_url
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
