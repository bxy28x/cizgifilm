import subprocess
import json
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)

# GitHub Pages, Smart TV ve tarayıcı istemcisinin CORS kısıtlamalarına takılmaması
# ve custom header'ları (Bypass-Tunnel-Reminder, User-Agent vb.) rahatça gönderebilmesi için
CORS(app, resources={r"/api/*": {"origins": "*"}}, supports_credentials=True, allow_headers=["*"], methods=["GET", "OPTIONS"])

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
def add_tunnel_bypass_headers(response):
    """Localtunnel uyarı ekranını pasifize eden ve CORS başlıklarını garantiye alan hook."""
    response.headers["Bypass-Tunnel-Reminder"] = "true"
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    return response

def get_live_m3u8(video_id):
    """Verilen YouTube Video ID'si için yt-dlp ile doğrudan oynatılabilir akış linkini alır."""
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = [
        "yt-dlp",
        "-g",
        "-f", "b/best",
        "--no-warnings",
        "--extractor-args", "youtube:player_client=ios,android,web",
        video_url
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', timeout=15)
        lines = [line.strip() for line in proc.stdout.strip().split('\n') if line.strip()]
        return lines[0] if lines else None
    except Exception as e:
        print(f"yt-dlp hatası ({video_id}):", e)
        return None

@app.route('/api/shows', methods=['GET', 'OPTIONS'])
def get_shows():
    """Playlist'leri tarar ve geçerli videoları döndürür."""
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    result = []
    for show in CONFIG["SHOWS"]:
        playlist_url = f"https://www.youtube.com/playlist?list={show['playlistId']}"
        cmd = [
            "yt-dlp", 
            "--flat-playlist", 
            "-j", 
            "--no-warnings",
            "--extractor-args", "youtube:player_client=ios,android,web",
            playlist_url
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', timeout=20)
            
            videos = []
            for line in proc.stdout.strip().split("\n"):
                if not line:
                    continue
                try:
                    vdata = json.loads(line)
                    v_title = vdata.get("title")
                    v_id = vdata.get("id")
                    
                    # Başlığı boş, silinmiş veya gizli olan videoları süz
                    if v_id and v_title and v_title not in ["[Private video]", "[Deleted video]"]:
                        videos.append({
                            "id": v_id,
                            "title": v_title
                        })
                except Exception:
                    continue
                
            result.append({
                "name": show["name"],
                "playlistId": show["playlistId"],
                "videos": videos
            })
        except Exception as e:
            print(f"Playlist çekme hatası ({show['name']}):", e)
            result.append({
                "name": show["name"],
                "playlistId": show["playlistId"],
                "videos": []
            })
        
    return jsonify(result)

@app.route('/api/stream/<video_id>', methods=['GET', 'OPTIONS'])
def get_stream_link(video_id):
    """Sıradaki video için canlı akış adresi döner."""
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    stream_url = get_live_m3u8(video_id)
    if not stream_url:
        return jsonify({"error": "Stream adresi alınamadı"}), 500
    
    return jsonify({
        "videoId": video_id,
        "streamUrl": stream_url
    })

if __name__ == '__main__':
    # Termux ortamında kilitlenmeleri önlemek için threaded=True aktif
    app.run(host='0.0.0.0', port=5000, debug=True, threaded=True)
