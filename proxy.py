from flask import Flask, Response, redirect
import subprocess
import json

app = Flask(__name__)

# Oynatma listesi URL'si
PLAYLIST_URL = "https://youtube.com/playlist?list=PLgpYv-QhGYY-TGk3xvTKshOnjqL0OWXKK"

def get_playlist_videos():
    """Oynatma listesindeki videoların ID ve başlıklarını çeker."""
    cmd = ["yt-dlp", "-j", "--flat-playlist", PLAYLIST_URL]
    res = subprocess.run(cmd, capture_output=True, text=True)
    videos = []
    for line in res.stdout.strip().split("\n"):
        if line:
            data = json.loads(line)
            videos.append({"id": data["id"], "title": data.get("title", "Video")})
    return videos

@app.route("/playlist.m3u")
def playlist_m3u():
    """Her video için localhost tabanlı .m3u8 linkleri içeren M3U dosyası üretir."""
    videos = get_playlist_videos()
    m3u_content = "#EXTM3U\n"
    for vid in videos:
        m3u_content += f"#EXTINF:-1,{vid['title']}\n"
        m3u_content += f"http://localhost:5000/video/{vid['id']}.m3u8\n"
    return Response(m3u_content, mimetype="audio/x-mpegurl")

@app.route("/video/<video_id>.m3u8")
def stream_video(video_id):
    """İstek geldiğinde o videonun güncel Google Video akış adresini çözer ve yönlendirir."""
    yt_url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = ["yt-dlp", "-g", "-f", "best", yt_url]
    res = subprocess.run(cmd, capture_output=True, text=True)
    stream_url = res.stdout.strip()
    
    if stream_url:
        return redirect(stream_url, code=302)
    return "Stream not found", 404

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
