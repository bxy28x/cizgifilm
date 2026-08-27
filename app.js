/* =========================================================
   AYARLAR — diziler
   ========================================================= */
const CONFIG = {
  SHOWS: [
    { name: "Oggy",              playlistId: "PLTLXNxXgTfEz5rZnXpx9uPx8LbENHN3_A" },
    { name: "Esrarengiz Kasaba", playlistId: "PLO7jGcCLf31VzYNKRuiGNjaIpS8Kb_fGB" },
    { name: "Doraemon",          playlistId: "PLCxWTrC_hNKNGoehF-TGH89pzp2FGySHx" },
    { name: "4. Çizgi Film",     playlistId: "PL3SPOx9gE-q0RtN0a9RP4vtOyB48w89Oz" },
    { name: "Emiray",            playlistId: "PL8dXShvpbmneB6w8UzuA1kWYyH0dFDZgJ" }
  ]
};

const LS_API_KEY = "marathon_api_key";
const LS_PROGRESS = "marathon_progress";

/* ---------- state ---------- */
let player;
let shows = [];            
let showsLoaded = false;
let rotationIndex = 0;
let currentQueue = [];
let currentShowName = "";
let currentUnitTitle = "";
let mode = null;           // 'episode' | 'ad' | null
let started = false;
let autosaveInterval = null;
let nextIndex = 0;         
let currentVideoId = "";

function randomShowIndex() {
  return Math.floor(Math.random() * shows.length);
}

/* ---------- DOM refs ---------- */
const el = {
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  apiKey: document.getElementById('apiKey'),
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
function getApiKey() { return localStorage.getItem(LS_API_KEY) || ""; }
function setStatus(msg) { el.status.textContent = msg; }

/* =========================================================
   REKLAMSIZ EMBED OYNATICI MOTORU
   ========================================================= */
function initSmartTvPlayer() {
  player = document.getElementById('player');
  
  player.getCurrentTime = function() { return 0; };
  player.getVideoData = function() { return { video_id: currentVideoId }; };
}

function loadVideoByIdHTML5(options) {
  const videoId = typeof options === 'string' ? options : options.videoId;
  const startSeconds = options ? (options.startSeconds || 0) : 0;
  
  currentVideoId = videoId;
  setStatus("Oynatılıyor.");

  // Reklamsız Invidious Embed Adresi
  const embedUrl = `https://inv.nadeko.net/embed/${videoId}?autoplay=1&listen=false&t=${startSeconds}`;
  player.src = embedUrl;
}

/* ---------- progress save / resume ---------- */
function getSavedProgress() {
  try {
    const raw = localStorage.getItem(LS_PROGRESS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProgress() {
  if (mode !== 'episode' || !currentVideoId) return;
  const data = {
    rotationIndex,
    nextIndex,
    unitIndices: shows.map(s => s.unitIndex),
    currentShowName,
    currentUnitTitle,
    remainingQueue: currentQueue.slice(),
    currentVideoId: currentVideoId,
    currentTime: 0,
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
  el.adPanel.classList.add('hidden');
  renderQueuePanel();
  highlightActiveShow();

  if (saved.currentVideoId) {
    loadVideoByIdHTML5({ videoId: saved.currentVideoId, startSeconds: saved.currentTime || 0 });
  } else {
    playCurrentQueueVideo();
  }
}

/* ---------- queue panel (dizi sırası) ---------- */
function renderQueuePanel() {
  el.queue.innerHTML = "";
  CONFIG.SHOWS.forEach((s, idx) => {
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

/* ---------- YouTube playlist fetching ---------- */
async function fetchPlaylistItems(playlistId, apiKey) {
  let items = [];
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&pageToken=${pageToken}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Playlist alınamadı: ${err?.error?.message || res.status}`);
    }
    const data = await res.json();
    for (const it of data.items || []) {
      const vid = it.snippet?.resourceId?.videoId;
      const title = it.snippet?.title || "";
      if (vid && title !== "Private video" && title !== "Deleted video") {
        items.push({ videoId: vid, title });
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
}

function groupIntoUnits(items) {
  const units = [];
  let i = 0;
  const partRe = /\((\d+)\s*\/\s*(\d+)\)\s*$/;

  while (i < items.length) {
    const m = items[i].title.match(partRe);
    if (m) {
      const total = parseInt(m[2], 10);
      const base = items[i].title.replace(partRe, "").trim();
      const group = [items[i]];
      let expected = parseInt(m[1], 10) + 1;
      let j = i + 1;
      while (j < items.length && group.length < total) {
        const mj = items[j].title.match(partRe);
        const baseJ = mj ? items[j].title.replace(partRe, "").trim() : null;
        if (mj && baseJ === base && parseInt(mj[1], 10) === expected) {
          group.push(items[j]);
          expected++;
          j++;
        } else break;
      }
      units.push({ title: base, videoIds: group.map(g => g.videoId) });
      i = j;
    } else {
      units.push({ title: items[i].title, videoIds: [items[i].videoId] });
      i++;
    }
  }
  return units;
}

async function loadAllShows(apiKey) {
  shows = [];
  for (const s of CONFIG.SHOWS) {
    setStatus(`${s.name} yükleniyor…`);
    const items = await fetchPlaylistItems(s.playlistId, apiKey);
    shows.push({ name: s.name, units: groupIntoUnits(items), unitIndex: 0 });
  }
  showsLoaded = true;
  setStatus("Hazır.");
}

/* ---------- marathon logic ---------- */
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
  el.adPanel.classList.add('hidden');
  playCurrentQueueVideo();
}

function playCurrentQueueVideo() {
  if (currentQueue.length === 0) { advanceRotation(); return; }
  const vid = currentQueue.shift();
  loadVideoByIdHTML5(vid);
  saveProgress();
}

function advanceRotation() {
  rotationIndex = nextIndex;
  nextIndex = randomShowIndex();
  playNextShowUnit();
}

/* ---------- settings dialog ---------- */
el.settingsBtn.addEventListener('click', () => {
  el.apiKey.value = getApiKey();
  el.settingsDialog.showModal();
});

el.settingsDialog.addEventListener('close', () => {
  if (el.settingsDialog.returnValue === 'save') {
    localStorage.setItem(LS_API_KEY, el.apiKey.value.trim());
    setStatus(getApiKey() ? "API anahtarı ayarlı. Başlat'a basabilirsin." : "API anahtarı ayarlanmadı.");
  }
});

/* ---------- controls ---------- */
el.startBtn.addEventListener('click', async () => {
  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus("Önce Ayarlar'dan YouTube API anahtarını gir.");
    el.settingsDialog.showModal();
    return;
  }
  el.startBtn.disabled = true;
  try {
    if (!showsLoaded) await loadAllShows(apiKey);
    const saved = getSavedProgress();
    if (saved && !started) {
      resumeFromProgress(saved);
    } else {
      startMarathon();
    }
    startAutosave();
    el.startBtn.textContent = "▶ Maratonu Başlat";
  } catch (e) {
    console.error(e);
    setStatus(`Hata: ${e.message}`);
  } finally {
    el.startBtn.disabled = false;
  }
});

el.pauseBtn.addEventListener('click', () => {
  // Embed iframe içerisinde duraklatma komutu
  setStatus("Oynatıcı içi kontrolleri kullanabilirsiniz.");
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
  el.adPanel.classList.add('hidden');
  el.nowTitle.textContent = "Maraton hazır";
  el.nextTitle.textContent = "—";
  el.pauseBtn.textContent = "⏸ Duraklat";
  el.startBtn.textContent = "▶ Maratonu Başlat";
  renderQueuePanel();
  if (player) {
    player.src = "";
  }
  started = false;
  setStatus(showsLoaded ? "Baştan başlamak için Başlat'a bas." : "API anahtarı ayarlanmadı.");
});

/* Sekme kapanırken / arka plana giderken kaldığı yeri kaydet */
window.addEventListener('beforeunload', saveProgress);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
});

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', () => {
  initSmartTvPlayer();
  renderQueuePanel();
  const hasKey = !!getApiKey();
  const saved = getSavedProgress();
  if (saved) {
    el.startBtn.textContent = "▶ Kaldığın Yerden Devam Et";
    el.nowTitle.textContent = `${saved.currentShowName || ""} — ${saved.currentUnitTitle || ""}`;
  }
  setStatus(hasKey ? (saved ? "Kaldığın yerden devam etmeye hazır." : "API anahtarı ayarlı. Başlat'a basabilirsin.") : "API anahtarı ayarlanmadı.");
});
