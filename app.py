import traceback
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request
from flask_cors import CORS
import yt_dlp

app = Flask(__name__)

# CORS Tüm Origin ve Header'lara açık
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
    """Tek bir oynatma listesini hızlıca çekmek için yt_dlp Python kütüphanesini kullanır."""
    playlist_url = f"https://www.youtube.com/playlist?list={show['playlistId']}"
    
    ydl_opts = {
        'extract_flat': 'in_playlist',
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'playlist_items': '1-100', # Hızlı yanıt için ilk 100 videoyu alır
        'extractor_args': {'youtube': ['player_client=ios,android,web']},
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

def get_live_m3u8(video_id):
    """Video oynatma linkini doğrudan yt_dlp ile alır."""
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts = {
        'format': 'best',
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {'youtube': ['player_client=ios,android,web']},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            return info.get('url')
    except Exception as e:
        print(f"Stream hatası ({video_id}): {e}")
        return None

@app.route('/api/shows', methods=['GET', 'OPTIONS'])
def get_shows():
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    try:
        # 5 oynatma listesini paralel olarak (Thread) aynı anda çeker
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
            return jsonify({"error": "Stream adresi alınamadı"}), 500
        return jsonify({"videoId": video_id, "streamUrl": stream_url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
# Render trigger comment
