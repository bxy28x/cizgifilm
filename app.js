/* =========================================================
   AYARLAR — diziler ve reklam videosu burada
   ========================================================= */
const CONFIG = {
  AD_VIDEO_ID: "UgFdtIkDvSU",
  DEFAULT_AD_SECONDS: 30,
  SHOWS: [
    { name: "Oggy",              playlistId: "PLTLXNxXgTfEz5rZnXpx9uPx8LbENHN3_A" },
    { name: "Esrarengiz Kasaba", playlistId: "PLO7jGcCLf31VzYNKRuiGNjaIpS8Kb_fGB" },
    { name: "Doraemon",          playlistId: "PLCxWTrC_hNKNGoehF-TGH89pzp2FGySHx" },
    { name: "4. Çizgi Film",     playlistId: "PL3SPOx9gE-q0RtN0a9RP4vtOyB48w89Oz" },
    { name: "Emiray",            playlistId: "PL8dXShvpbmneB6w8UzuA1kWYyH0dFDZgJ" }
  ]
};

const LS_API_KEY = "marathon_api_key";
const LS_AD_SECONDS = "marathon_ad_seconds";
const LS_PROGRESS = "marathon_progress";

/* ---------- state ---------- */
let player;
let shows = [];            // { name, units:[{title, videoIds:[]}], unitIndex }
let showsLoaded = false;
let rotationIndex = 0;
let currentQueue = [];
let currentShowName = "";
let currentUnitTitle = "";
let mode = null;           // 'episode' | 'ad' | null
let adInterval = null;
let adSecondsLeft = 0;
let started = false;
let autosaveInterval = null;
let nextIndex = 0;         // rastgele seçilmiş bir sonraki dizi

function randomShowIndex() {
  return Math.floor(Math.random() * shows.length);
}

/* ---------- DOM refs ---------- */
const el = {
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  apiKey: document.getElementById('apiKey'),
  adSeconds: document.getElementById('adSeconds'),
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
function getAdSeconds() {
  const v = parseInt(localStorage.getItem(LS_AD_SECONDS), 10);
  return Number.isFinite(v) && v > 0 ? v : CONFIG.DEFAULT_AD_SECONDS;
}
function setStatus(msg) { el.status.textContent = msg; }

/* ---------- progress save / resume ---------- */
function getSavedProgress() {
  try {
    const raw = localStorage.getItem(LS_PROGRESS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProgress() {
  if (mode !== 'episode' || !player || !player.getCurrentTime) return;
  let videoId = null;
  try { videoId = player.getVideoData ? player.getVideoData().video_id : null; } catch {}
  const data = {
    rotationIndex,
    nextIndex,
    unitIndices: shows.map(s => s.unitIndex),
    currentShowName,
    currentUnitTitle,
    remainingQueue: currentQueue.slice(),
    currentVideoId: videoId,
    currentTime: player.getCurrentTime() || 0,
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
    player.loadVideoById({ videoId: saved.currentVideoId, startSeconds: saved.currentTime || 0 });
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

// "... (1/6)", "... (2/6)" gibi parçaları veya zincirleme bölümleri
// tek bir birim olarak grupla — böylece aralarına reklam girmez.
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

/* ---------- YouTube IFrame player ---------- */
function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '100%', width: '100%',
    host: 'https://www.youtube-nocookie.com',
    playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3 },
    events: { onStateChange: onPlayerStateChange }
  });
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.ENDED) {
    if (mode === 'episode') playCurrentQueueVideo();
    else if (mode === 'ad') finishAd();
  }
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
  if (currentQueue.length === 0) { startAd(); return; }
  const vid = currentQueue.shift();
  player.loadVideoById(vid);
  saveProgress();
}

function startAd() {
  mode = 'ad';
  adSecondsLeft = getAdSeconds();
  el.adCountdown.textContent = adSecondsLeft;
  el.adPanel.classList.remove('hidden');
  player.loadVideoById(CONFIG.AD_VIDEO_ID);

  clearInterval(adInterval);
  adInterval = setInterval(() => {
    adSecondsLeft--;
    el.adCountdown.textContent = Math.max(adSecondsLeft, 0);
    if (adSecondsLeft <= 0) finishAd();
  }, 1000);
}

function finishAd() {
  if (mode !== 'ad') return;
  clearInterval(adInterval);
  mode = null;
  el.adPanel.classList.add('hidden');
  advanceRotation();
}

function advanceRotation() {
  rotationIndex = nextIndex;
  nextIndex = randomShowIndex();
  playNextShowUnit();
}

/* ---------- settings dialog ---------- */
el.settingsBtn.addEventListener('click', () => {
  el.apiKey.value = getApiKey();
  el.adSeconds.value = getAdSeconds();
  el.settingsDialog.showModal();
});

el.settingsDialog.addEventListener('close', () => {
  if (el.settingsDialog.returnValue === 'save') {
    localStorage.setItem(LS_API_KEY, el.apiKey.value.trim());
    const secs = parseInt(el.adSeconds.value, 10);
    localStorage.setItem(LS_AD_SECONDS, Number.isFinite(secs) && secs > 0 ? secs : CONFIG.DEFAULT_AD_SECONDS);
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
  if (!player || !player.getPlayerState) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    player.pauseVideo();
    el.pauseBtn.textContent = '▶ Devam';
  } else {
    player.playVideo();
    el.pauseBtn.textContent = '⏸ Duraklat';
  }
});

el.nextBtn.addEventListener('click', () => {
  if (!started) return;
  if (mode === 'ad') finishAd();
  else { currentQueue = []; startAd(); }
  saveProgress();
});

el.resetBtn.addEventListener('click', () => {
  clearInterval(adInterval);
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
  if (player && player.stopVideo) player.stopVideo();
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
  renderQueuePanel();
  const hasKey = !!getApiKey();
  const saved = getSavedProgress();
  if (saved) {
    el.startBtn.textContent = "▶ Kaldığın Yerden Devam Et";
    el.nowTitle.textContent = `${saved.currentShowName || ""} — ${saved.currentUnitTitle || ""}`;
  }
  setStatus(hasKey ? (saved ? "Kaldığın yerden devam etmeye hazır." : "API anahtarı ayarlı. Başlat'a basabilirsin.") : "API anahtarı ayarlanmadı.");
});
   
