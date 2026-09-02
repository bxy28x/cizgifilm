import os
import traceback
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request
from flask_cors import CORS
import yt_dlp
import requests

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
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS, POST"
    return response

# =========================================================
# UZAKTAN ÇEREZ GÜNCELLEME ENDPOINT'İ (Telefon / Worker için)
# =========================================================
@app.route('/api/update-cookies', methods=['POST', 'OPTIONS'])
def update_cookies():
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    try:
        data = request.get_json()
        if not data or 'cookies' not in data:
            return jsonify({"error": "Çerez verisi bulunamadı"}), 400

        cookie_content = data['cookies']
        
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            f.write(cookie_content)

        print("📥 Telefon üzerinden yeni çerezler başarıyla alındı ve kaydedildi!")
        return jsonify({"status": "success", "message": "Çerezler başarıyla güncellendi"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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
                'player_client': ['ios', 'android', 'mweb']
            }
        }
    }
    
    if os.path.exists(COOKIE_FILE) and os.path.getsize(COOKIE_FILE) > 50:
        ydl_opts['cookiefile'] = COOKIE_FILE

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            url = info.get('url')
            if url:
                return url
    except Exception as e:
        print(f"yt-dlp kısıtlamaya takıldı ({video_id}). Hata: {e}")

    # yt-dlp veya çerez yetersiz kalırsa dış servislere (Piped/Invidious) başvur
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
        
