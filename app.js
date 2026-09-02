/* =========================================================
   RENDER FLASK BACKEND İLE ENTEGRE MARATON İSTEMCİSİ
   ========================================================= */
const API_BASE_URL = "https://cizgifilm-1.onrender.com";
const LS_PROGRESS = "marathon_progress";
const LS_SELECTED_SHOWS = "marathon_selected_shows";
const LS_LAST_SELECTION_DATE = "marathon_last_selection_date";

const API_HEADERS = {
  "Accept": "application/json"
};

/* ---------- state ---------- */
let videoElement = null;
let playerContainer = null;
let hlsInstance = null;
let shows = [];            
let activeShows = [];      // Seçili şov havuzu
let showsLoaded = false;
let rotationIndex = 0;
let currentQueue = [];     
let currentShowName = "";
let currentUnitTitle = "";
let mode = null;           
let started = false;
let autosaveInterval = null;
let nextIndex = 0;         

/* ---------- Tarih & Günlük Limit Kontrolü ---------- */
function getTodayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function canChangeSelectionToday() {
  const lastDate = localStorage.getItem(LS_LAST_SELECTION_DATE);
  return lastDate !== getTodayDateString();
}

function updateActiveShows() {
  const savedSelection = JSON.parse(localStorage.getItem(LS_SELECTED_SHOWS));
  if (savedSelection && savedSelection.length > 0) {
    activeShows = shows.filter(s => savedSelection.includes(s.name));
  } else {
    activeShows = [...shows];
  }
}

function randomShowIndex() {
  if (!activeShows.length) return 0;
  const randomActive = activeShows[Math.floor(Math.random() * activeShows.length)];
  return shows.findIndex(s => s.name === randomActive.name);
}

/* ---------- DOM refs ---------- */
const el = {
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  resetBtn: document.getElementById('resetBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  selectionModal: document.getElementById('selectionModal'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  saveSelectionBtn: document.getElementById('saveSelectionBtn'),
  showCheckboxContainer: document.getElementById('showCheckboxContainer'),
  nowTitle: document.getElementById('nowTitle'),
  nextTitle: document.getElementById('nextTitle'),
  adPanel: document.getElementById('adPanel'),
  queue: document.getElementById('queue'),
  status: document.getElementById('status'),
};

function setStatus(msg) { 
  if (el.status) el.status.textContent = msg; 
}

/* ---------- Modal & Ayarlar Mantığı ---------- */
function renderShowCheckboxes() {
  if (!el.showCheckboxContainer) return;
  el.showCheckboxContainer.innerHTML = "";
  const savedSelection = JSON.parse(localStorage.getItem(LS_SELECTED_SHOWS)) || shows.map(s => s.name);

  shows.forEach(s => {
    const isChecked = savedSelection.includes(s.name);
    const label = document.createElement('label');
    label.className = 'checkbox-card';
    label.innerHTML = `
      <input type="checkbox" value="${s.name}" ${isChecked ? 'checked' : ''}>
      <span>${s.name}</span>
    `;
    el.showCheckboxContainer.appendChild(label);
  });
}

if (el.settingsBtn) {
  el.settingsBtn.addEventListener('click', async () => {
    if (!showsLoaded) {
      try {
        await loadAllShowsFromBackend();
      } catch (e) {
        alert("Playlistler henüz yüklenemedi, lütfen tekrar deneyin.");
        return;
      }
    }

    if (!canChangeSelectionToday()) {
      alert("⚠️ Çizgi film tercihini bugün zaten belirledin! Günde sadece 1 defa değişiklik yapabilirsin.");
      return;
    }

    renderShowCheckboxes();
    if (el.selectionModal) el.selectionModal.classList.remove('hidden');
  });
}

if (el.closeModalBtn) {
  el.closeModalBtn.addEventListener('click', () => {
    if (el.selectionModal) el.selectionModal.classList.add('hidden');
  });
}

if (el.saveSelectionBtn) {
  el.saveSelectionBtn.addEventListener('click', () => {
    const checkedInputs = el.showCheckboxContainer.querySelectorAll('input[type="checkbox"]:checked');
    const selectedNames = Array.from(checkedInputs).map(cb => cb.value);

    if (selectedNames.length === 0) {
      alert("Lütfen en az 1 çizgi film seçin!");
      return;
    }

    localStorage.setItem(LS_SELECTED_SHOWS, JSON.stringify(selectedNames));
    localStorage.setItem(LS_LAST_SELECTION_DATE, getTodayDateString());

    updateActiveShows();
    if (el.selectionModal) el.selectionModal.classList.add('hidden');
    setStatus("Seçimlerin kaydedildi.");

    if (started) {
      currentQueue = [];
      advanceRotation();
    }
  });
}

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

  playCurrentQueueVideo(saved.currentTime || 0);
}

/* ---------- queue panel ---------- */
function renderQueuePanel() {
  if (!el.queue) return;
  el.queue.innerHTML = "";
  shows.forEach((s, idx) => {
    const isSelected = activeShows.some(a => a.name === s.name);
    const item = document.createElement('div');
    item.className = 'queue-item' + (idx === rotationIndex && started ? ' active' : '') + (!isSelected ? ' disabled' : '');
    item.innerHTML = `<span class="dot"></span><span>${s.name}</span>`;
    el.queue.appendChild(item);
  });
}

function highlightActiveShow() {
  if (!el.queue) return;
  const items = el.queue.querySelectorAll('.queue-item');
  items.forEach((it, idx) => it.classList.toggle('active', idx === rotationIndex));
}

/* ---------- Backend Fetching & Grouping ---------- */
async function loadAllShowsFromBackend() {
  setStatus("Sunucudan playlistler çekiliyor…");
  
  const response = await fetch(`${API_BASE_URL}/api/shows`, {
    headers: API_HEADERS
  });
  
  if (!response.ok) throw new Error("Flask sunucusuna bağlanılamadı!");
  
  const rawShows = await response.json();
  
  shows = rawShows.map(s => ({
    name: s.name,
    units: groupIntoUnits(s.videos || []),
    unitIndex: 0
  }));

  showsLoaded = true;
  updateActiveShows();
  setStatus("Playlistler başarıyla yüklendi.");
}

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

  playerContainer = videoElement.parentElement;

  videoElement.addEventListener('ended', () => {
    if (mode === 'episode') playCurrentQueueVideo();
  });

  videoElement.addEventListener('error', (e) => {
    console.error("Video Oynatma Hatası:", e);
    setStatus("Video oynatılamadı. Sonraki videoya geçiliyor...");
    setTimeout(() => {
      if (started) playCurrentQueueVideo();
    }, 3000);
  });
}

async function playCurrentQueueVideo(startSeconds = 0) {
  if (currentQueue.length === 0) { 
    advanceRotation(); 
    return; 
  }
  
  const videoId = currentQueue.shift();
  setStatus(`Stream adresi alınıyor (${videoId})…`);

  try {
    const res = await fetch(`${API_BASE_URL}/api/stream/${videoId}`, {
      headers: API_HEADERS
    });
    
    if (!res.ok) throw new Error(`HTTP Hata: ${res.status}`);
    
    const data = await res.json();
    
    if (data.streamUrl) {
      setStatus("Oynatılıyor.");
      loadStream(data.streamUrl, startSeconds);
      saveProgress();
    } else {
      throw new Error("Stream URL boş döndü.");
    }
  } catch (err) {
    console.error(err);
    setStatus("Akış bulunamadı, 2 sn içinde sonraki bölüme geçiliyor...");
    setTimeout(() => playCurrentQueueVideo(), 2000);
  }
}

function loadStream(url, startSeconds = 0) {
  if (!videoElement) initVideoPlayer();

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  const isM3U8 = url.includes('.m3u8');

  // 1. Safari / Native HLS Desteği
  if (isM3U8 && videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    videoElement.src = url;
    videoElement.addEventListener('loadedmetadata', () => {
      if (startSeconds > 0) videoElement.currentTime = startSeconds;
      videoElement.play().catch(err => console.log("Autoplay engellendi:", err));
    }, { once: true });
  } 
  // 2. Chrome/Firefox/Edge HLS.js Desteği
  else if (isM3U8 && typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: false
    });

    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoElement);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (startSeconds > 0) videoElement.currentTime = startSeconds;
      videoElement.play().catch(err => console.log("Autoplay engellendi:", err));
    });

    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error("HLS Kritik Hata:", data.type);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hlsInstance.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hlsInstance.recoverMediaError();
        } else {
          hlsInstance.destroy();
          setStatus("Akış yüklenemedi. Sonraki bölüme geçiliyor...");
          setTimeout(() => playCurrentQueueVideo(), 2000);
        }
      }
    });
  } 
  // 3. Standart MP4 veya Doğrudan Video Linki
  else {
    videoElement.src = url;
    if (startSeconds > 0) videoElement.currentTime = startSeconds;
    videoElement.play().catch(err => console.log("Autoplay engellendi:", err));
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
  if (!show || !show.units || show.units.length === 0) { 
    advanceRotation(); 
    return; 
  }

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

/* ---------- Event Listeners ---------- */
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
  if (videoElement) {
    if (!videoElement.paused) {
      videoElement.pause();
      el.pauseBtn.textContent = '▶ Devam';
    } else {
      videoElement.play();
      el.pauseBtn.textContent = '⏸ Duraklat';
    }
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
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
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
