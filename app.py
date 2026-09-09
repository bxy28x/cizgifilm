import os
import json
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request
from flask_cors import CORS
import yt_dlp

app = Flask(__name__)

# CORS Tüm Origin ve Header'lara açık
CORS(app, resources={r"/*": {"origins": "*"}})

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Cookies (YouTube'un "Sign in to confirm you're not a bot" hatasini asmak icin)
# ---------------------------------------------------------------------------
COOKIES_FILE = os.environ.get("YT_COOKIES_FILE", os.path.join(BASE_DIR, "cookies.txt"))


def _bootstrap_cookies_from_env():
    """Render restart/redeploy sonrasi disk sifirlansa bile, YT_COOKIES_CONTENT
    env variable'i set edilmisse cookies.txt'i baslangicta otomatik olusturur.
    Cerezleri guncellemek istediginde Render'daki YT_COOKIES_CONTENT degerini
    degistirip servisi yeniden baslatman yeterli - baska bir islem gerekmez."""
    content = os.environ.get("YT_COOKIES_CONTENT", "")
    if content and not os.path.exists(COOKIES_FILE):
        try:
            with open(COOKIES_FILE, "w") as f:
                f.write(content)
            print("[bilgi] cookies.txt, YT_COOKIES_CONTENT env variable'indan olusturuldu.")
        except Exception as e:
            print(f"[uyari] cookies.txt env'den olusturulamadi: {e}")


_bootstrap_cookies_from_env()


def _ydl_base_opts():
    """Tum yt_dlp cagrilarinda ortak olan opsiyonlar (cookies dahil)."""
    opts = {
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {'youtube': ['player_client=ios,android,web']},
    }
    if os.path.exists(COOKIES_FILE):
        opts['cookiefile'] = COOKIES_FILE
    else:
        print(f"[uyari] cookies.txt bulunamadi ({COOKIES_FILE}) - cerezsiz devam ediliyor, bot tespiti hatasi alabilirsin.")
    return opts


# ---------------------------------------------------------------------------
# Genel config (diziler + reklam)
# ---------------------------------------------------------------------------
def _extract_youtube_id(url_or_id):
    """youtu.be/ID, youtube.com/watch?v=ID, youtube.com/shorts/ID veya sade ID
    formatlarindan video ID'sini cikarir."""
    if not url_or_id:
        return None
    if re.fullmatch(r'[A-Za-z0-9_-]{11}', url_or_id):
        return url_or_id
    patterns = [
        r'(?:youtu\.be/)([A-Za-z0-9_-]{11})',
        r'(?:[?&]v=)([A-Za-z0-9_-]{11})',
        r'(?:youtube\.com/shorts/)([A-Za-z0-9_-]{11})',
    ]
    for p in patterns:
        m = re.search(p, url_or_id)
        if m:
            return m.group(1)
    return None


CONFIG = {
    "SHOWS": [
        {"name": "Oggy",              "playlistId": "PLTLXNxXgTfEz5rZnXpx9uPx8LbENHN3_A"},
        {"name": "Esrarengiz Kasaba", "playlistId": "PLO7jGcCLf31VzYNKRuiGNjaIpS8Kb_fGB"},
        {"name": "Doraemon",          "playlistId": "PLCxWTrC_hNKNGoehF-TGH89pzp2FGySHx"},
        {"name": "4. Çizgi Film",     "playlistId": "PL3SPOx9gE-q0RtN0a9RP4vtOyB48w89Oz"},
        {"name": "Emiray",            "playlistId": "PL8dXShvpbmneB6w8UzuA1kWYyH0dFDZgJ"},
    ],
    # Reklam olarak oynatılacak YouTube videosu (link ya da sade video ID olabilir).
    # Render'da AD_VIDEO_URL environment variable'ıyla da değiştirebilirsin.
    "AD_SOURCE_URL": os.environ.get("AD_VIDEO_URL", "https://youtu.be/UgFdtIkDvSU"),
    "AD_DURATION_SECONDS": 30,
}
CONFIG["AD_VIDEO_ID"] = _extract_youtube_id(CONFIG["AD_SOURCE_URL"])

# Reklamın gerçek (googlevideo) stream linkini her istekte değil, TTL boyunca
# önbellekte tutuyoruz - hem hızlı hem de YouTube'a gereksiz istek atmıyoruz.
_AD_STREAM_CACHE = {"url": None, "ts": 0}
AD_STREAM_CACHE_TTL_SECONDS = int(os.environ.get("AD_STREAM_CACHE_TTL_SECONDS", "14400"))  # 4 saat


def get_ad_stream_url():
    if not CONFIG["AD_VIDEO_ID"]:
        return None
    now = time.time()
    if _AD_STREAM_CACHE["url"] and (now - _AD_STREAM_CACHE["ts"] < AD_STREAM_CACHE_TTL_SECONDS):
        return _AD_STREAM_CACHE["url"]
    url = get_live_m3u8(CONFIG["AD_VIDEO_ID"])
    if url:
        _AD_STREAM_CACHE["url"] = url
        _AD_STREAM_CACHE["ts"] = now
    return url

# ---------------------------------------------------------------------------
# Playlist cache (shows.json)
# Her /api/shows isteginde YouTube'u canli taramak yerine, sonucu diske yazip
# TTL suresi boyunca oradan servis ediyoruz. Hem cok daha hizli, hem de
# YouTube'a giden istek sayisini (dolayisiyla bot-tespiti riskini) azaltiyor.
# ---------------------------------------------------------------------------
SHOWS_CACHE_FILE = os.environ.get("SHOWS_CACHE_FILE", os.path.join(BASE_DIR, "shows.json"))
SHOWS_CACHE_TTL_SECONDS = int(os.environ.get("SHOWS_CACHE_TTL_SECONDS", "21600"))  # 6 saat


def _load_shows_cache():
    """Cache dosyasi varsa ve TTL suresi gecmemisse icerigini dondurur, aksi halde None."""
    try:
        if not os.path.exists(SHOWS_CACHE_FILE):
            return None
        age = time.time() - os.path.getmtime(SHOWS_CACHE_FILE)
        if age > SHOWS_CACHE_TTL_SECONDS:
            return None
        with open(SHOWS_CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[uyari] shows cache okunamadi: {e}")
        return None


def _save_shows_cache(results):
    """Yarim/hatali dosya birakmamak icin once tmp dosyaya yazip sonra atomik rename yapar."""
    tmp_path = SHOWS_CACHE_FILE + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False)
        os.replace(tmp_path, SHOWS_CACHE_FILE)
    except Exception as e:
        print(f"[uyari] shows cache yazilamadi: {e}")


def _fetch_all_shows_live():
    with ThreadPoolExecutor(max_workers=5) as executor:
        return list(executor.map(fetch_single_playlist, CONFIG["SHOWS"]))


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def fetch_single_playlist(show):
    """Tek bir oynatma listesini hızlıca çekmek için yt_dlp Python kütüphanesini kullanır."""
    playlist_url = f"https://www.youtube.com/playlist?list={show['playlistId']}"

    ydl_opts = {
        **_ydl_base_opts(),
        'extract_flat': 'in_playlist',
        'skip_download': True,
        'playlist_items': '1-100',  # Hızlı yanıt için ilk 100 videoyu alır
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
        "videos": videos,
    }


def get_live_m3u8(video_id):
    """Video oynatma linkini doğrudan yt_dlp ile alır."""
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts = {
        **_ydl_base_opts(),
        'format': 'best',
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
        cached = _load_shows_cache()
        if cached is not None:
            return jsonify(cached)

        results = _fetch_all_shows_live()
        _save_shows_cache(results)
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e), "traceback": traceback.format_exc()}), 500


@app.route('/api/shows/refresh', methods=['POST', 'OPTIONS'])
def refresh_shows():
    """Cache'i TTL'i beklemeden zorla tazeler (5 playlist'i canli yt_dlp ile tarar)."""
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200

    try:
        results = _fetch_all_shows_live()
        _save_shows_cache(results)
        return jsonify({"status": "ok", "shows": len(results)})
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

        ad_url = get_ad_stream_url()
        ad_obj = None
        if ad_url:
            ad_obj = {
                "url": ad_url,
                "durationSeconds": CONFIG["AD_DURATION_SECONDS"],
            }

        return jsonify({
            "videoId": video_id,
            "streamUrl": stream_url,
            # İstemci: ad varsa önce onu ad.durationSeconds kadar oynatıp,
            # sonra streamUrl'e geçmeli. ad null ise direkt bölüme geçer.
            "ad": ad_obj,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/ad', methods=['GET', 'OPTIONS'])
def get_ad():
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200
    ad_url = get_ad_stream_url()
    if not ad_url:
        return jsonify({"error": "Reklam adresi alınamadı"}), 500
    return jsonify({
        "url": ad_url,
        "durationSeconds": CONFIG["AD_DURATION_SECONDS"],
    })


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
