/* =========================================================
   FLASK BACKEND İLE ENTEGRE MARATON İSTEMCİSİ
   ========================================================= */
const API_BASE_URL = "http://192.168.1.110:5000";
const LS_PROGRESS = "marathon_progress";

/* ---------- state ---------- */
let videoElement = null;
let hlsInstance = null;
let shows = [];            // { name, units:[{title, videoIds:[]}], unitIndex }
let showsLoaded = false;
let rotationIndex = 0;
let currentQueue = [];     // O anki birimin videoId listesi
let currentShowName = "";
let currentUnitTitle = "";
let mode = null;           // 'episode' | 'ad' | null
let started = false;
let autosaveInterval = null;
let nextIndex = 0;         // Rastgele seçilmiş bir sonraki dizi

function randomShowIndex() {
  return Math.floor(Math.random() * shows.length);
}

/* ---------- DOM refs ---------- */
const el = {
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  resetBtn: document.getElementById('resetBtn'),
  nowTitle: document.getElementById('nowTitle'),
  nextTitle: document.getElementById('nextTitle'),
  adPanel: document.getElementById('adPanel'),
  adCountdown: document.getElementById('adCountdown'),
  queue: document.getElementById('queue'),
  status: document.getElementById('status'),
};

/* ---------- helpers ---------- */
function setStatus(msg) { el.status.textContent = msg; }

/* ---------- progress save / resume ---------- */
function getSavedProgress() {
  try {
    const raw = localStorage.getItem(LS_PROGRESS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProgress() {
  if (mode !== 'episode' || !videoElement) return;
  const data = {
    rotationIndex,
    nextIndex,
    unitIndices: shows.map(s => s.unitIndex),
    currentShowName,
    currentUnitTitle,
    remainingQueue: currentQueue.slice(),
    currentTime: videoElement.currentTime || 0,
  };
  localStorage.setItem(LS_PROGRESS, JSON.stringify(data));
}

function clearProgress() {
  localStorage.removeItem(LS_PROGRESS);
}

function startAutosave() {
  clearInterval(autosaveInterval);
  autosaveInterval = setInterval(saveProgress, 5000);
}

function resumeFromProgress(saved) {
  rotationIndex = saved.rotationIndex || 0;
  nextIndex = (typeof saved.nextIndex === 'number') ? saved.nextIndex : randomShowIndex();
  shows.forEach((s, i) => { s.unitIndex = saved.unitIndices?.[i] ?? 0; });
  currentShowName = saved.currentShowName || shows[rotationIndex]?.name || "";
  currentUnitTitle = saved.currentUnitTitle || "";
  currentQueue = (saved.remainingQueue || []).slice();
  mode = 'episode';
  started = true;

  el.nowTitle.textContent = `${currentShowName} — ${currentUnitTitle}`;
  el.nextTitle.textContent = shows[nextIndex]?.name || "—";
  if (el.adPanel) el.adPanel.classList.add('hidden');
  renderQueuePanel();
  highlightActiveShow();

  playCurrentQueueVideo();
}

/* ---------- queue panel (dizi sırası) ---------- */
function renderQueuePanel() {
  el.queue.innerHTML = "";
  shows.forEach((s, idx) => {
    const item = document.createElement('div');
    item.className = 'queue-item' + (idx === rotationIndex && started ? ' active' : '');
    item.innerHTML = `<span class="dot"></span><span>${s.name}</span>`;
    el.queue.appendChild(item);
  });
}

function highlightActiveShow() {
  const items = el.queue.querySelectorAll('.queue-item');
  items.forEach((it, idx) => it.classList.toggle('active', idx === rotationIndex));
}

/* ---------- Backend Fetching & Grouping ---------- */
async function loadAllShowsFromBackend() {
  setStatus("Sunucudan playlistler çekiliyor…");
  const response = await fetch(`${API_BASE_URL}/api/shows`);
  if (!response.ok) throw new Error("Flask sunucusuna bağlanılamadı!");
  
  const rawShows = await response.json();
  
  shows = rawShows.map(s => ({
    name: s.name,
    units: groupIntoUnits(s.videos || []),
    unitIndex: 0
  }));

  showsLoaded = true;
  setStatus("Playlistler başarıyla yüklendi.");
}

// Güvenli gruplama fonksiyonu (null/undefined başlık hatası almaz)
function groupIntoUnits(videos) {
  const units = [];
  let i = 0;
  const partRe = /\((\d+)\s*\/\s*(\d+)\)\s*$/;

  while (i < videos.length) {
    const safeTitle = (videos[i] && videos[i].title) ? String(videos[i].title).trim() : "Bölüm";
    const m = safeTitle.match(partRe);

    if (m) {
      const total = parseInt(m[2], 10);
      const base = safeTitle.replace(partRe, "").trim();
      const group = [videos[i]];
      let expected = parseInt(m[1], 10) + 1;
      let j = i + 1;

      while (j < videos.length && group.length < total) {
        const nextTitle = (videos[j] && videos[j].title) ? String(videos[j].title).trim() : "";
        const mj = nextTitle.match(partRe);
        const baseJ = mj ? nextTitle.replace(partRe, "").trim() : null;

        if (mj && baseJ === base && parseInt(mj[1], 10) === expected) {
          group.push(videos[j]);
          expected++;
          j++;
        } else {
          break;
        }
      }

      units.push({ title: base, videoIds: group.map(g => g.id) });
      i = j;
    } else {
      units.push({ title: safeTitle, videoIds: [videos[i].id] });
      i++;
    }
  }

  return units;
}

/* ---------- HTML5 Video / HLS Controller ---------- */
function initVideoPlayer() {
  videoElement = document.getElementById('videoPlayer');
  if (!videoElement) return;

  videoElement.addEventListener('ended', () => {
    if (mode === 'episode') playCurrentQueueVideo();
  });
}

async function playCurrentQueueVideo() {
  if (currentQueue.length === 0) { 
    advanceRotation(); 
    return; 
  }
  
  const videoId = currentQueue.shift();
  setStatus(`Stream adresi alınıyor (${videoId})…`);

  try {
    const res = await fetch(`${API_BASE_URL}/api/stream/${videoId}`);
    const data = await res.json();
    
    if (data.streamUrl) {
      setStatus("Oynatılıyor.");
      loadStream(data.streamUrl);
      saveProgress();
    } else {
      throw new Error("Stream URL boş döndü.");
    }
  } catch (err) {
    console.error(err);
    setStatus("Video yüklenemedi, sonraki bölüme geçiliyor...");
    setTimeout(playCurrentQueueVideo, 2000);
  }
}

function loadStream(url, startSeconds = 0) {
  if (!videoElement) initVideoPlayer();

  if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    videoElement.src = url;
    videoElement.currentTime = startSeconds;
    videoElement.play().catch(() => {});
  } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    if (hlsInstance) hlsInstance.destroy();
    hlsInstance = new Hls();
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoElement);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      videoElement.currentTime = startSeconds;
      videoElement.play().catch(() => {});
    });
  } else {
    videoElement.src = url;
    videoElement.currentTime = startSeconds;
    videoElement.play().catch(() => {});
  }
}

/* ---------- Marathon Logic ---------- */
function startMarathon() {
  started = true;
  rotationIndex = randomShowIndex();
  nextIndex = randomShowIndex();
  renderQueuePanel();
  playNextShowUnit();
}

function playNextShowUnit() {
  highlightActiveShow();
  const show = shows[rotationIndex];
  if (!show || show.units.length === 0) { advanceRotation(); return; }

  const unit = show.units[show.unitIndex];
  show.unitIndex = (show.unitIndex + 1) % show.units.length;

  currentQueue = unit.videoIds.slice();
  currentShowName = show.name;
  currentUnitTitle = unit.title;
  mode = 'episode';

  el.nowTitle.textContent = `${show.name} — ${unit.title}`;
  el.nextTitle.textContent = shows[nextIndex]?.name || "—";
  if (el.adPanel) el.adPanel.classList.add('hidden');
  
  playCurrentQueueVideo();
}

function advanceRotation() {
  rotationIndex = nextIndex;
  nextIndex = randomShowIndex();
  playNextShowUnit();
}

/* ---------- Controls ---------- */
el.startBtn.addEventListener('click', async () => {
  el.startBtn.disabled = true;
  try {
    if (!showsLoaded) await loadAllShowsFromBackend();
    const saved = getSavedProgress();
    if (saved && !started) {
      resumeFromProgress(saved);
    } else {
      startMarathon();
    }
    startAutosave();
    el.startBtn.textContent = "▶ Maraton Çalışıyor";
  } catch (e) {
    console.error(e);
    setStatus(`Hata: ${e.message}`);
  } finally {
    el.startBtn.disabled = false;
  }
});

el.pauseBtn.addEventListener('click', () => {
  if (!videoElement) return;
  if (!videoElement.paused) {
    videoElement.pause();
    el.pauseBtn.textContent = '▶ Devam';
  } else {
    videoElement.play();
    el.pauseBtn.textContent = '⏸ Duraklat';
  }
});

el.nextBtn.addEventListener('click', () => {
  if (!started) return;
  currentQueue = [];
  advanceRotation();
  saveProgress();
});

el.resetBtn.addEventListener('click', () => {
  clearInterval(autosaveInterval);
  clearProgress();
  mode = null;
  currentQueue = [];
  rotationIndex = 0;
  shows.forEach(s => s.unitIndex = 0);
  el.nowTitle.textContent = "Maraton hazır";
  el.nextTitle.textContent = "—";
  el.pauseBtn.textContent = "⏸ Duraklat";
  el.startBtn.textContent = "▶ Maratonu Başlat";
  renderQueuePanel();
  if (videoElement) {
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
  }
  started = false;
  setStatus("Sıfırlandı.");
});

window.addEventListener('beforeunload', saveProgress);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
});

document.addEventListener('DOMContentLoaded', () => {
  initVideoPlayer();
  const saved = getSavedProgress();
  if (saved) {
    el.startBtn.textContent = "▶ Kaldığın Yerden Devam Et";
    el.nowTitle.textContent = `${saved.currentShowName || ""} — ${saved.currentUnitTitle || ""}`;
  }
});
