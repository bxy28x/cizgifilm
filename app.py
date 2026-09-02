import traceback
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request
from flask_cors import CORS
import yt_dlp
import requests

app = Flask(__name__)

CORS(app, resources={r"/*": {"origins": "*"}})

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
            if 'entries' in info:
                for entry in info['entries']:
                    v_id = entry.get('id')
                    v_title = entry.get('title')
                    if v_id and v_title and v_title not in ["[Private video]", "[Deleted video]"]:
                        videos.append({"id": v_id, "title": v_title})
    except Exception as e:
        print(f"Playlist hatası ({show['name']}): {e}")
        
    return {
        "name": show["name"],
        "playlistId": show["playlistId"],
        "videos": videos
    }

def get_external_stream_fallback(video_id):
    """Aktif Piped ve Invidious instances üzerinden MP4 adresi çeker."""
    youtube_url = f"https://www.youtube.com/watch?v={video_id}"

    # 1. Güncel ve Aktif Piped API Örnekleri
    piped_instances = [
        "https://pipedapi.kavin.rocks",
        "https://api.piped.privacydev.net",
        "https://pipedapi.palvelu.org",
        "https://piped-api.garudalinux.org"
    ]
    
    for instance in piped_instances:
        try:
            res = requests.get(f"{instance}/streams/{video_id}", timeout=3)
            if res.status_code == 200:
                data = res.json()
                for stream in data.get('videoStreams', []):
                    if stream.get('url') and not stream.get('videoOnly'):
                        return stream.get('url')
        except Exception:
            continue

    # 2. Güncel Invidious API Örnekleri
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
    
    # iOS/Android Native Client taklidi
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
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            url = info.get('url')
            if url:
                return url
    except Exception as e:
        print(f"yt-dlp banlandı ({video_id}), alternatif servisler devreye giriyor...")
    
    return get_external_stream_fallback(video_id)

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
            # Fallback: Adres bulunamazsa doğrudan YouTube Embed yönlendirmesi
            return jsonify({
                "videoId": video_id, 
                "streamUrl": f"https://www.youtube.com/embed/{video_id}?autoplay=1",
                "isEmbed": True
            })
        return jsonify({"videoId": video_id, "streamUrl": stream_url, "isEmbed": False})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
