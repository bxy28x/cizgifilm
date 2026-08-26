const PLAYLISTS = [
  {name:"Oggy", id:"PLTLXNxXgTfEz5rZnXpx9uPx8LbENHN3_A"},
  {name:"Esrarengiz Kasaba", id:"PLgqIWvJ0sPt_89xkec_j8D21Sp5cUXySP"},
  {name:"Doraemon", id:"PLCxWTrC_hNKNGoehF-TGH89pzp2FGySHx"},
  {name:"Playlist 4", id:"PL3SPOx9gE-q0RtN0a9RP4vtOyB48w89Oz"}
];

const AD_VIDEO_ID = "UgFdtIkDvSU";
const state = {
  apiKey: localStorage.getItem("maraton_api_key") || "",
  adSeconds: Number(localStorage.getItem("maraton_ad_seconds") || 30),
  videos: [],
  index: 0,
  partIndex: 0,
  player: null,
  adTimer: null,
  inAd: false
};

const $ = id => document.getElementById(id);
let ytReady = false;

window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  createPlayer();
};

function createPlayer(){
  if(!ytReady || state.player) return;
  state.player = new YT.Player("player", {
    videoId: AD_VIDEO_ID,
    playerVars:{playsinline:1,rel:0,modestbranding:1},
    events:{
      onStateChange:e=>{
        if(e.data === YT.PlayerState.ENDED) handleVideoEnded();
      }
    }
  });
}

function setStatus(t){ $("status").textContent=t; }

async function getPlaylistVideos(playlistId){
  const out=[];
  let pageToken="";
  do{
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part","snippet,contentDetails");
    url.searchParams.set("maxResults","50");
    url.searchParams.set("playlistId",playlistId);
    url.searchParams.set("key",state.apiKey);
    if(pageToken) url.searchParams.set("pageToken",pageToken);
    const r=await fetch(url);
    if(!r.ok) throw new Error(`YouTube API ${r.status}`);
    const data=await r.json();
    for(const item of data.items||[]){
      const id=item.contentDetails?.videoId;
      if(id) out.push({
        videoId:id,
        title:item.snippet?.title || "Bölüm",
        show:item.snippet?.videoOwnerChannelTitle || "",
        playlistId
      });
    }
    pageToken=data.nextPageToken||"";
  }while(pageToken);
  return out;
}

/*
 * Episode grouping:
 * A real episode can be uploaded as multiple YouTube videos:
 *   "Turist Kapanı (1/6)" ... "Turist Kapanı (6/6)"
 * These parts are kept together and count as ONE episode.
 *
 * The same rule is applied to every playlist automatically:
 *   "(1/4)...(4/4)", "(1/6)...(6/6)", etc.
 */
function parsePartTitle(title){
  const m = String(title).match(/\s*\((\d+)\s*\/\s*(\d+)\)\s*$/);
  if(!m) return null;
  return {part:Number(m[1]), total:Number(m[2]), base:title.slice(0,m.index).trim()};
}

function normalizeTitle(title){
  return String(title)
    .replace(/\s*\((\d+)\s*\/\s*(\d+)\)\s*$/,"")
    .replace(/\s+/g," ")
    .trim()
    .toLocaleLowerCase("tr-TR");
}

function groupPlaylistEpisodes(videos){
  const groups=[];
  const map=new Map();

  for(const video of videos){
    const part=parsePartTitle(video.title);

    if(part){
      // Group by the title without (x/y), preserving playlist order.
      const key=normalizeTitle(part.base);
      let group=map.get(key);

      if(!group){
        group={
          key,
          title:part.base,
          parts:[],
          firstIndex:groups.length
        };
        map.set(key,group);
        groups.push(group);
      }

      group.parts.push({
        ...video,
        part:part.part,
        total:part.total
      });
    }else{
      const group={
        key:`single-${groups.length}-${video.videoId}`,
        title:video.title,
        parts:[{...video,part:1,total:1}],
        firstIndex:groups.length
      };
      groups.push(group);
    }
  }

  // Sort multipart episodes by their numeric part, while keeping
  // single-video episodes untouched.
  for(const group of groups){
    group.parts.sort((a,b)=>a.part-b.part);
  }

  return groups.map(group=>({
    episodeId:group.key,
    title:group.title,
    show:group.parts[0]?.show || "",
    parts:group.parts
  }));
}

/*
 * Round-robin by REAL EPISODE:
 * Oggy episode 1 (all parts)
 * -> Esrarengiz Kasaba episode 1 (all parts)
 * -> Doraemon episode 1 (all parts)
 * -> Playlist 4 episode 1 (all parts)
 * -> Oggy episode 2 ...
 */
function buildMarathon(lists){
  const episodeLists=lists.map(groupPlaylistEpisodes);
  const max=Math.max(...episodeLists.map(x=>x.length),0);
  const result=[];

  for(let i=0;i<max;i++){
    for(const list of episodeLists){
      if(list[i]) result.push(list[i]);
    }
  }
  return result;
}

async function loadMarathon(){
  if(!state.apiKey){
    setStatus("Önce Ayarlar'dan YouTube Data API Key gir.");
    return false;
  }
  setStatus("Playlistler okunuyor…");
  try{
    const lists=await Promise.all(PLAYLISTS.map(p=>getPlaylistVideos(p.id)));
    state.videos=buildMarathon(lists);
    state.index=0;
    state.partIndex=0;
    renderQueue();
    const partCount=state.videos.reduce((n,e)=>n+(e.parts?.length||1),0);
    setStatus(`${state.videos.length} gerçek bölüm bulundu (${partCount} YouTube parçası).`);
    updateLabels();
    return true;
  }catch(err){
    console.error(err);
    setStatus("Playlistler alınamadı: "+err.message);
    return false;
  }
}

function renderQueue(){
  $("queue").innerHTML="";
  state.videos.slice(0,100).forEach((v,i)=>{
    const el=document.createElement("div");
    el.className="queue-item"+(i===state.index?" active":"");
    el.innerHTML=`<span class="dot"></span><span>${i+1}. ${escapeHtml(v.show || v.title)}</span>`;
    $("queue").appendChild(el);
  });
}

function currentEpisode(){
  return state.videos[state.index] || null;
}

function currentPart(){
  return currentEpisode()?.parts?.[state.partIndex] || null;
}

function updateLabels(){
  const ep=currentEpisode();
  const part=currentPart();
  const next=state.videos[state.index+1];

  $("nowTitle").textContent = ep
    ? `${ep.title}${part && part.total > 1 ? ` — ${part.part}/${part.total}` : ""}`
    : "Maraton hazır";

  $("nextTitle").textContent = next
    ? next.title
    : "Maraton tamamlandı";

  renderQueue();
}

function renderQueue(){
  $("queue").innerHTML="";
  state.videos.slice(0,100).forEach((ep,i)=>{
    const el=document.createElement("div");
    el.className="queue-item"+(i===state.index?" active":"");
    const parts = ep.parts?.length > 1 ? ` (${ep.parts.length} parça)` : "";
    el.innerHTML=`<span class="dot"></span><span>${i+1}. ${escapeHtml(ep.title)}${parts}</span>`;
    $("queue").appendChild(el);
  });
}

function playIndex(i){
  if(!state.videos.length) return;
  state.index=Math.max(0,Math.min(i,state.videos.length-1));
  state.partIndex=0;
  state.inAd=false;
  clearInterval(state.adTimer);
  $("adPanel").classList.add("hidden");

  const part=currentPart();
  if(!part) return;

  state.player.loadVideoById(part.videoId);
  updateLabels();
  setStatus(`${state.index+1}/${state.videos.length}: ${part.total>1 ? `parça ${part.part}/${part.total}` : "oynatılıyor"}`);
}

function startMarathon(){
  if(!state.videos.length){
    loadMarathon().then(ok=>{if(ok) playIndex(state.index);});
  }else{
    playIndex(state.index);
  }
}

function handleVideoEnded(){
  if(state.inAd) return;

  const ep=currentEpisode();
  if(!ep) return;

  // Multipart episode: move to the next part WITHOUT an ad.
  if(state.partIndex < ep.parts.length - 1){
    state.partIndex++;
    const part=currentPart();
    state.player.loadVideoById(part.videoId);
    updateLabels();
    setStatus(`${ep.title}: parça ${part.part}/${part.total}`);
    return;
  }

  // Only the final part of a real episode triggers the ad.
  if(state.index >= state.videos.length-1){
    setStatus("Maraton tamamlandı.");
    $("nowTitle").textContent="Maraton tamamlandı 🎉";
    return;
  }

  startAd();
}

function startAd(){
  state.inAd=true;
  $("adPanel").classList.remove("hidden");
  let remaining=state.adSeconds;
  $("adCountdown").textContent=remaining;
  state.player.loadVideoById(AD_VIDEO_ID);
  clearInterval(state.adTimer);
  state.adTimer=setInterval(()=>{
    remaining--;
    $("adCountdown").textContent=remaining;
    if(remaining<=0){
      clearInterval(state.adTimer);
      state.inAd=false;
      $("adPanel").classList.add("hidden");
      playIndex(state.index+1);
    }
  },1000);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}

$("startBtn").onclick=startMarathon;
$("pauseBtn").onclick=()=>{
  if(state.player?.pauseVideo) state.player.pauseVideo();
};
$("nextBtn").onclick=()=>{
  if(state.inAd){
    clearInterval(state.adTimer);
    state.inAd=false;
    $("adPanel").classList.add("hidden");
  }
  playIndex(state.index+1);
};
$("resetBtn").onclick=()=>{
  clearInterval(state.adTimer);
  state.inAd=false;
  $("adPanel").classList.add("hidden");
  state.index=0;
  state.partIndex=0;
  updateLabels();
  setStatus("Maraton başa alındı.");
};

$("settingsBtn").onclick=()=>{
  $("apiKey").value=state.apiKey;
  $("adSeconds").value=state.adSeconds;
  $("settingsDialog").showModal();
};

$("settingsForm").addEventListener("submit",e=>{
  if(e.submitter?.value!=="save") return;
  state.apiKey=$("apiKey").value.trim();
  state.adSeconds=Math.max(1,Math.min(300,Number($("adSeconds").value)||30));
  localStorage.setItem("maraton_api_key",state.apiKey);
  localStorage.setItem("maraton_ad_seconds",String(state.adSeconds));
  state.videos=[];
  setStatus("Ayarlar kaydedildi. Maratonu başlat.");
});

if(state.apiKey) setStatus("API anahtarı kayıtlı. Maratonu başlat.");
