/* ===========================================
   Pi Pillary – Virtual Grid + Lazy Video + Rarity
   Ressourcen-freundlich, overlay-frei, mobil-schonend
   =========================================== */

/* ========= CONFIG ========= */
const CFG = {
  API: "https://inpinity.online/pillary/api", // oder "/pillary/api"
  ROWS: 100,
  TILE: 32,
  GAP: 4,
  PRELOAD_CONCURRENCY: 3,     // konservativ
  SCALE_IMG_THRESHOLD: 0.8,   // höher => weniger Autovideos
  INITIAL_ROWS_VISIBLE: 10
};

// Runtime-Infos
const ua = navigator.userAgent || "";
const isMobile = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(ua) || navigator.userAgentData?.mobile === true;
const NET = navigator.connection;
const lowPower = !!NET?.saveData || /(^|-)2g$/.test(NET?.effectiveType || "");
const cores = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
const MAX_PLAYING = Math.max(8, Math.min(28, cores * 2)); // adaptiv
const QUEUE_MAX_CONC = lowPower ? 2 : 3;                  // API-Fetch-Limit
const RENDER_MARGIN_ROWS = isMobile ? 3 : 6;              // kleiner Puffer mobil

/* ========= POLYFILLS ========= */
window.requestIdleCallback ||= (cb)=> setTimeout(()=>cb({didTimeout:false,timeRemaining:()=>0}), 1);
window.cancelIdleCallback ||= (id)=> clearTimeout(id);

/* ========= OVERLAY-FREE TWEAKS ========= */
(() => {
  // entferne grauen/transpar. Overlays, Topbar-Blur usw.
  const s = document.createElement("style");
  s.textContent = `
    .topbar{background:#0b0f14!important;backdrop-filter:none!important}
    .tile .digit{background:transparent!important;text-shadow:0 0 2px rgba(0,0,0,.85),0 0 6px rgba(0,0,0,.5)}
    .tile[data-status="unminted"]{opacity:1!important; filter:none!important}
  `;
  document.head.appendChild(s);
})();

/* ========= PRECONNECT ========= */
(function preconnect(){
  const hosts = [
    CFG.API.replace(/(https?:\/\/[^/]+).*/,"$1"),
    "https://ipfs.inpinity.online",
    "https://cloudflare-ipfs.com"
  ];
  for (const href of hosts){
    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = href;
    document.head.appendChild(l);
  }
})();

/* ========= DOM ========= */
function reqEl(id){ const el = document.getElementById(id); if(!el) throw new Error(`#${id} fehlt`); return el; }

const stage = reqEl("stage");
const stageWrap = reqEl("stageWrap");
const zoomInBtn = reqEl("zoomIn");
const zoomOutBtn = reqEl("zoomOut");
const zoomLevel = reqEl("zoomLevel");
const preloadAllChk = reqEl("preloadAll");
const toggleRarity = reqEl("toggleRarity");
const jumpTo = reqEl("jumpTo");
const jumpBtn = reqEl("jumpBtn");
const modal = reqEl("modal");
const modalContent = reqEl("modalContent");
const closeModalBtn = reqEl("closeModal");
const toggleAnim = document.getElementById("toggleAnim"); // optional, falls im HTML vorhanden

/* ========= STATE ========= */
let scale = 1;
let focusedIndex = 0;
let userInteracted = false;
const TOTAL = CFG.ROWS * CFG.ROWS;
const playing = new Set();
const renderedRows = new Set();

let io; // IntersectionObserver (zoom-abhängig)

/* Gesehene Metadaten/Status → kompakte Bitfelder (Tipp 9) */
const metaSeen   = new Uint8Array(TOTAL);
const statusSeen = new Uint8Array(TOTAL);

/* Rarity-Heat zwischenspeichern, aber nur anzeigen wenn Toggle aktiv */
const rarityHeat = new Float32Array(TOTAL);

/* ========= GLOBAL ANIM-TOGGLE ========= */
// Mobile/Low-Power standardmäßig AUS; Desktop standardmäßig AN
const storedAnim = localStorage.getItem("pillary-anim");
const ANIM = {
  enabled: storedAnim !== null ? JSON.parse(storedAnim) : !(isMobile || lowPower),
};
if (toggleAnim) {
  toggleAnim.checked = !!ANIM.enabled;
  toggleAnim.addEventListener("change", ()=>{
    ANIM.enabled = toggleAnim.checked;
    localStorage.setItem("pillary-anim", JSON.stringify(ANIM.enabled));
    if (!ANIM.enabled) preloadAllChk.checked = false;
    refreshVisibleMedia();
  });
}

/* Rarity-Heatmap (Checkbox steuert Sichtbarkeit) */
if (toggleRarity) {
  toggleRarity.addEventListener("change", ()=>{
    applyRarityOverlayToVisible();
  });
}
function applyRarityOverlayToVisible(){
  const wrapRect = stageWrap.getBoundingClientRect();
  for (const el of stage.children) {
    const rect = el.getBoundingClientRect();
    const visible = !(rect.right < wrapRect.left || rect.left > wrapRect.right || rect.bottom < wrapRect.top || rect.top > wrapRect.bottom);
    if (!visible) continue;
    const idx = parseInt(el.dataset.index);
    if (toggleRarity.checked && rarityHeat[idx] > 0) {
      el.style.setProperty("--heat", String(rarityHeat[idx] * 0.65));
      el.setAttribute("data-heat","1");
    } else {
      el.style.removeProperty("--heat");
      el.removeAttribute("data-heat");
    }
  }
}

/* ========= API – Queue + Dedupe + Abort (Tipp 1 & 2) ========= */
function apiUrl(p){ return `${CFG.API}${p}`; }

const RequestQueue = (()=> {
  let running = 0;
  const q = [];
  const inflight = new Map();     // key -> Promise
  const controllers = new Map();  // key -> AbortController

  const runNext = () => {
    if (running >= QUEUE_MAX_CONC || q.length === 0) return;
    const job = q.shift();
    if (!job) return;
    running++;
    job.fn().then(job.resolve, job.reject).finally(()=>{ running--; runNext(); });
  };

  function schedule(key, fn){
    if (inflight.has(key)) return inflight.get(key);
    const p = new Promise((resolve,reject)=>{
      q.push({ fn, resolve, reject });
      runNext();
    });
    inflight.set(key, p);
    p.finally(()=> inflight.delete(key));
    return p;
  }

  function abort(key){
    controllers.get(key)?.abort();
  }

  async function get(path){
    const key = `GET ${path}`;
    // alte gleiche Anfrage abbrechen
    abort(key);
    const ac = new AbortController();
    controllers.set(key, ac);

    return schedule(key, async ()=>{
      const r = await fetch(apiUrl(path), { signal: ac.signal });
      if (!r.ok) throw new Error(`${path} -> ${r.status}`);
      return r.json();
    });
  }

  return { get, abort };
})();

async function apiGetThrottled(path){
  return RequestQueue.get(path);
}

/* ========= UTIL ========= */
function tile(i){ return stage.querySelector(`.tile[data-index="${i}"]`); }
function videoTier(){
  if (!ANIM.enabled) return "med";
  const net = NET?.effectiveType || '';
  if (/2g|slow-2g/.test(net)) return "low";
  if (scale < 0.5) return "low";
  if (scale < 1.2) return "med";
  return "high";
}
function videoUrl(i){ return `${CFG.API}/video/${i}?q=${videoTier()}`; }
function showModal(html){ modalContent.innerHTML = html; modal.classList.remove("hidden"); }
closeModalBtn.onclick = () => modal.classList.add("hidden");

/* ========= LAYOUT ========= */
function layoutFrameOnly(){
  const unit = CFG.TILE + CFG.GAP;
  const maxCols = 2*(CFG.ROWS - 1) + 1;
  stage.style.width  = (maxCols * unit - CFG.GAP) + "px";
  stage.style.height = (unit * CFG.ROWS - CFG.GAP) + "px";
}

/* ========= IntersectionObserver abhängig vom Zoom (Tipp 6) ========= */
function makeIO(){
  try { io?.disconnect(); } catch {}
  const margin = scale >= 1.2 ? "256px 0px" : "96px 0px";
  io = new IntersectionObserver((entries)=>{
    for (const ent of entries) {
      const el = ent.target;
      if (!(el instanceof HTMLElement)) continue;
      el.classList.toggle("inview", ent.isIntersecting);
      toggleTileMedia(el, ent.isIntersecting);
    }
  }, { root: stageWrap, rootMargin: margin, threshold: 0.2 });

  // bestehende Tiles (falls schon da) (re-)observieren
  stage.querySelectorAll('.tile').forEach(t => io.observe(t));
}

/* ========= Reihen ========= */
function createRow(row){
  if (renderedRows.has(row)) return;
  const unit = CFG.TILE + CFG.GAP;
  const maxCols = 2*(CFG.ROWS - 1) + 1;
  const cols = 2*row + 1;
  const rowStartIndex = row*row;
  const mid = Math.floor(cols/2);
  const xOffset = ((maxCols / 2) - mid) * unit;
  const y = row * unit;

  let x = xOffset;
  const frag = document.createDocumentFragment();

  for (let c=0; c<cols; c++){
    const index = rowStartIndex + c;

    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.index = String(index);
    el.tabIndex = 0;
    el.title = `#${index}`;
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = el.style.height = CFG.TILE + "px";

    el.addEventListener("click", onTileClick);
    el.addEventListener("keydown", (e)=>{ if (e.key === "Enter") onTileClick({ currentTarget: el }); });

    // Start immer mit Bild (Tipp 4: low priority)
    const img = document.createElement("img");
    img.alt = `#${index}`;
    img.src = `${CFG.API}/thumb/${index}`;
    img.decoding = "async"; img.loading = "lazy"; img.fetchPriority = "low";
    img.referrerPolicy = "no-referrer";
    img.onerror = ()=> el.classList.add("failed");
    el.appendChild(img);

    const badge = document.createElement("div");
    badge.className = "digit"; badge.textContent = "";
    el.appendChild(badge);

    frag.appendChild(el);
    if (io) io.observe(el);
    x += unit;
  }
  stage.appendChild(frag);
  renderedRows.add(row);
}

function destroyRow(row){
  if (!renderedRows.has(row)) return;
  const start = row*row;
  const cols  = 2*row+1;
  for (let i=start;i<start+cols;i++){
    const el = tile(i);
    if (!el) continue;
    if (io) io.unobserve(el);
    destroyVideo(el); // Tipp 3 – Ressourcen frei
    el.remove();
  }
  renderedRows.delete(row);
}

/* ========= Mediensteuerung ========= */
function makeVideo(idx, posterUrl){
  const v = document.createElement("video");
  v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
  v.preload = "metadata"; v.crossOrigin = "anonymous";
  if (posterUrl) v.poster = posterUrl;
  v.src = videoUrl(idx);
  v.onplay = ()=> playing.add(v);
  v.onpause = v.onended = ()=> playing.delete(v);
  return v;
}

// Tipp 3: Video wirklich freigeben
function destroyVideo(el){
  const v = el.querySelector('video');
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  v.remove();
}

function toggleTileMedia(el, isVisible){
  const idx = parseInt(el.dataset.index);
  if (el.classList.contains("failed")) return;

  // Mobil standardmäßig PNG: ANIM.enabled default false auf Mobile/LowPower
  const wantVideo = ANIM.enabled && isVisible && scale >= CFG.SCALE_IMG_THRESHOLD;
  const hasVideo = !!el.querySelector("video");

  if (wantVideo && !hasVideo) {
    if (playing.size >= MAX_PLAYING) { el.classList.add("pulse"); return; }
    el.classList.remove("pulse");
    const v = makeVideo(idx, `${CFG.API}/thumb/${idx}`);
    v.onerror = ()=> el.classList.add("failed");
    const old = el.firstChild; if (old) el.removeChild(old);
    el.prepend(v);
    v.play().catch(()=>{});
  } else if (!wantVideo && hasVideo) {
    destroyVideo(el);
    const img = document.createElement("img");
    img.alt = `#${idx}`;
    img.src = `${CFG.API}/thumb/${idx}`;
    img.decoding = "async"; img.loading = "lazy"; img.fetchPriority = "low";
    img.referrerPolicy = "no-referrer";
    img.onerror = ()=> el.classList.add("failed");
    const old = el.firstChild; if (old) el.removeChild(old);
    el.prepend(img);
    el.classList.add("pulse"); // zeigt: ggf. später wieder Video
  }
}

function refreshVisibleMedia(){
  const wrapRect = stageWrap.getBoundingClientRect();
  for (const el of stage.children) {
    const rect = el.getBoundingClientRect();
    const visible = !(rect.right < wrapRect.left || rect.left > wrapRect.right || rect.bottom < wrapRect.top || rect.top > wrapRect.bottom);
    toggleTileMedia(el, visible);
  }
  applyRarityOverlayToVisible();
}

/* ========= Viewport-Update + Batch-Laden ========= */
let lastViewportBatch = 0;
let batchTimer = 0;

function updateRenderedRows(){
  const unit = CFG.TILE + CFG.GAP;
  const y = stageWrap.scrollTop / (scale || 1);
  const topRow = Math.max(0, Math.floor(y / unit) - RENDER_MARGIN_ROWS);
  const bottomRow = Math.min(CFG.ROWS-1, Math.floor((y + stageWrap.clientHeight/scale)/unit) + RENDER_MARGIN_ROWS);

  for (let r=topRow; r<=bottomRow; r++) createRow(r);
  for (const r of [...renderedRows]) if (r < topRow-1 || r > bottomRow+1) destroyRow(r);

  refreshVisibleMedia();

  // debounced Batch im Sichtbereich
  clearTimeout(batchTimer);
  batchTimer = setTimeout(()=> queueViewportBatch(topRow, bottomRow), 80);
}

function queueViewportBatch(topRow, bottomRow){
  const now = Date.now();
  if (now - lastViewportBatch < 120) return;
  lastViewportBatch = now;

  const from = topRow*topRow;
  const to   = bottomRow*bottomRow + (2*bottomRow + 1) - 1;

  const rM = shrinkRangeBits(from, to, metaSeen);
  const rS = shrinkRangeBits(from, to, statusSeen);

  if (rM) loadMetaBatch(rM.from, rM.to);
  if (rS) loadStatusBatch(rS.from, rS.to);
}

// Tipp 9: Range-Verkleinerung mit Bitfeldern
function shrinkRangeBits(from, to, bits){
  let a = from, b = to;
  while (a <= b && bits[a] === 1) a++;
  while (b >= a && bits[b] === 1) b--;
  if (a > b) return null;

  // wenn >85% bereits bekannt, sparen
  let known = 0;
  for (let i=a; i<=b; i++) if (bits[i] === 1) known++;
  const total = b - a + 1;
  if (total > 40 && known/total > 0.85) return null;

  return { from:a, to:b };
}

/* ========= Next-row Thumb-Warmup (Tipp 7) ========= */
function warmupNextRowThumbs(){
  requestIdleCallback(()=> {
    const unit = CFG.TILE + CFG.GAP;
    const row = Math.floor((stageWrap.scrollTop/scale)/unit) + 1;
    if (row < 0 || row >= CFG.ROWS) return;
    const start = row*row, end = start + (2*row+1) - 1;
    for (let i=start;i<=end;i++){
      const t = tile(i); if (!t || t.querySelector('video')) continue;
      const img = new Image();
      img.fetchPriority = "low"; img.referrerPolicy = "no-referrer";
      img.src = `${CFG.API}/thumb/${i}`;
    }
  }, { timeout: 1500 });
}

/* ========= Meta/Status (Batch) ========= */
async function loadMetaBatch(from, to){
  try{
    const path = `/batch/meta?from=${from}&to=${to}`;
    const { data } = await apiGetThrottled(path);

    data.forEach(meta=>{
      if (!meta || meta.error) return;
      const i = meta.index;
      metaSeen[i] = 1;

      const el = tile(i);
      if (!el) return;
      const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
      const by = (k) => attrs.find(a => (a.trait_type||"").toLowerCase() === k);

      const digit = by("digit")?.value ?? meta.Digit;
      const axis  = by("axis")?.value ?? meta.Axis;
      const pair  = by("matchingpair")?.value ?? meta.MatchingPair;

      const badge = el.querySelector(".digit");
      if (badge && digit != null) badge.textContent = String(digit);
      if (axis === true || axis === "true") el.classList.add("axis");
      if (pair === true || pair === "true") el.classList.add("pair");

      const score =
        meta.rarity_score ??
        (attrs.find(a=> (a.trait_type||"").toLowerCase()==="rarity_score")?.value) ??
        (attrs.find(a=> (a.trait_type||"").toLowerCase()==="rarityscore")?.value);

      if (score != null) {
        const s = Number(score);
        const norm = Math.max(0, Math.min(1, (s - 0) / (100 - 0))); // normalize
        rarityHeat[i] = norm;
        // nur anwenden, wenn Rarity-Toggle aktiv ist
        if (toggleRarity?.checked) {
          el.style.setProperty("--heat", String(norm * 0.65));
          el.setAttribute("data-heat","1");
        }
      }
    });
  }catch{/* still */}
}

async function loadStatusBatch(from, to){
  try{
    const path = `/batch/status?from=${from}&to=${to}`;
    const { data } = await apiGetThrottled(path);

    data.forEach(s=>{
      const i = s.index;
      statusSeen[i] = 1;

      const el = tile(i);
      if (!el) return;
      if (!s.minted) el.dataset.status = "unminted";
      else if (s.listed) el.dataset.status = "listed";
      else if (s.verified) el.dataset.status = "verified";

      if (s.market && s.market !== "none") {
        el.dataset.market = s.market;
        const t = el.getAttribute("title") || `#${s.index}`;
        const marketTxt = s.market === "both" ? "ME + OKX" : (s.market.toUpperCase());
        el.title = `${t} — listed on ${marketTxt}`;
      } else el.dataset.market = "none";
    });
  }catch{/* still */}
}

/* ========= Modal ========= */
async function onTileClick(e){
  try{
    const el = e.currentTarget;
    const idx = parseInt(el.dataset.index);
    focusedIndex = idx;

    const meta = await apiGetThrottled(`/meta/${idx}`);
    const links = meta.links || {};
    const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];

    const rarityScore =
      meta.rarity_score ??
      (attrs.find(a => (a.trait_type||"").toLowerCase() === "rarity_score")?.value) ??
      (attrs.find(a => (a.trait_type||"").toLowerCase() === "rarityscore")?.value);

    const digit = (attrs.find(a => (a.trait_type||"").toLowerCase() === "digit")?.value);
    const axis  = (attrs.find(a => (a.trait_type||"").toLowerCase() === "axis")?.value);
    const pair  = (attrs.find(a => (a.trait_type||"").toLowerCase() === "matchingpair")?.value);

    const rows = [
      ["Index", `#${idx}`],
      ["Name", meta.name || ""],
      ["Mint", meta.mint || ""],
      ["Symbol", meta.symbol || ""],
      ["Digit (π)", digit ?? ""],
      ["Axis", axis ?? ""],
      ["Matching Pair", pair ?? ""],
      ["Animation", meta.animation_url || meta.properties?.animation_url || ""],
      ["Rarity Score", rarityScore ?? ""],
    ].map(([k,v])=> `<div class="meta-row"><b>${k}</b><div>${(v||"").toString()}</div></div>`).join("");

    const mediaHtml = (ANIM.enabled)
      ? `<video src="${videoUrl(idx)}" controls muted playsinline loop preload="metadata"
                poster="${CFG.API}/thumb/${idx}"
                style="width:100%;margin-top:8px;border-radius:8px"></video>`
      : `<img src="${CFG.API}/thumb/${idx}" alt="#${idx}" style="width:100%;margin-top:8px;border-radius:8px" />`;

    const linkHtml = `
      <div class="links" style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap">
        ${meta.mint ? `<a target="_blank" href="${links.magicEdenItem}">Kaufen @ Magic Eden</a>` : ""}
        ${meta.mint ? `<a target="_blank" href="${links.okxNftItem}">Kaufen @ OKX</a>` : ""}
        <a target="_blank" href="https://magiceden.io/marketplace/inpi">Collection @ Magic Eden</a>
        <a target="_blank" href="https://web3.okx.com/ul/FOFXecp">Token @ OKX</a>
        <a target="_blank" href="https://solscan.io/account/GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp">Creator</a>
      </div>`;

    showModal(`
      <h3>${meta.name ?? "Item"} — #${idx}</h3>
      ${rows}${linkHtml}
      ${mediaHtml}
    `);
  }catch(err){
    console.error("Modal-Fehler:", err);
    alert("Konnte Details nicht laden. Bitte später erneut versuchen.");
  }
}

/* ========= Preload-Checkbox ========= */
async function preloadAllVideos(){
  if (!ANIM.enabled){ preloadAllChk.checked = false; return; }
  const conc = CFG.PRELOAD_CONCURRENCY;
  let next = 0;

  async function worker(){
    while (preloadAllChk.checked && ANIM.enabled && next < TOTAL) {
      const i = next++;
      const el = tile(i);
      if (!el || el.classList.contains("failed")) continue;
      try{
        if (!el.querySelector("video")) {
          const v = makeVideo(i, `${CFG.API}/thumb/${i}`);
          v.onerror = ()=> el.classList.add("failed");
          const old = el.firstChild; if (old) el.removeChild(old);
          el.prepend(v);
          await v.play().catch(()=>{});
        }
      }catch{ el.classList.add("failed"); }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}
preloadAllChk.addEventListener("change", ()=>{ if (preloadAllChk.checked) preloadAllVideos(); });

/* ========= Scroll & Resize (Tipp 10) ========= */
let rafId;
stageWrap.addEventListener("scroll", ()=>{
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(()=> {
    updateRenderedRows();
    warmupNextRowThumbs(); // Tipp 7
  });
}, { passive:true });

new ResizeObserver(()=> {
  layoutFrameOnly();
  updateRenderedRows();
}).observe(stageWrap);

/* ========= Zoom & Initial View ========= */
function setScale(s, { noSwap = false } = {}){
  const prev = scale;
  scale = Math.max(0.2, Math.min(6, s));
  stage.style.transform = `scale(${scale})`;
  zoomLevel.textContent = Math.round(scale * 100) + "%";
  const crossed = (prev < CFG.SCALE_IMG_THRESHOLD && scale >= CFG.SCALE_IMG_THRESHOLD) ||
                  (prev >= CFG.SCALE_IMG_THRESHOLD && scale < CFG.SCALE_IMG_THRESHOLD);
  if (!noSwap && crossed) refreshVisibleMedia();
  makeIO(); // Tipp 6: IO an Zoom koppeln
}
function centerOnApex(){
  const midX = Math.max(0, (stage.scrollWidth * scale - stageWrap.clientWidth) / 2);
  stageWrap.scrollTo({ left: midX, top: 0, behavior: "auto" });
}
function setInitialView(){
  const unit = CFG.TILE + CFG.GAP;
  const wanted = CFG.INITIAL_ROWS_VISIBLE * unit - CFG.GAP;
  const h = Math.max(100, stageWrap.clientHeight);
  const targetScale = Math.max(0.2, Math.min(6, h / wanted));
  setScale(targetScale, { noSwap: true });
  requestAnimationFrame(() => {
    centerOnApex();
    updateRenderedRows();
    refreshVisibleMedia();
    // optional: erste Reihen forcieren (nur wenn ANIM)
    if (ANIM.enabled) {
      const top = CFG.INITIAL_ROWS_VISIBLE;
      for (let row = 0; row < Math.min(top, CFG.ROWS); row++) {
        const cols = 2*row + 1;
        const start = row*row;
        const end = start + cols - 1;
        for (let i = start; i <= end; i++) {
          const el = tile(i);
          if (el) { el.classList.add("inview"); toggleTileMedia(el, true); }
        }
      }
    }
  });
}

/* ========= Controls ========= */
zoomInBtn.onclick  = () => { userInteracted = true; setScale(scale + .1); refreshVisibleMedia(); };
zoomOutBtn.onclick = () => { userInteracted = true; setScale(scale - .1); refreshVisibleMedia(); };

stageWrap.addEventListener("wheel", (e)=>{
  if (!e.ctrlKey) return; e.preventDefault();
  userInteracted = true;
  setScale(scale + (e.deltaY < 0 ? .1 : -.1));
  refreshVisibleMedia();
}, { passive: false });

["scroll","keydown","pointerdown","touchstart"].forEach(evt=>{
  window.addEventListener(evt, ()=> userInteracted = true, { passive:true });
});

/* ========= Navigation ========= */
function scrollToIndex(i, open = false){
  const t = tile(i); if (!t) return;
  stageWrap.scrollTo({ left: t.offsetLeft*scale-100, top: t.offsetTop*scale-100, behavior: "smooth" });
  t.focus();
  if (open) onTileClick({ currentTarget: t });
}
jumpBtn.onclick = () => {
  const i = parseInt(jumpTo.value);
  if (Number.isFinite(i) && i >= 0 && i < TOTAL) { userInteracted = true; scrollToIndex(i, false); }
};

document.addEventListener("keydown", (e)=>{
  userInteracted = true;
  if (e.key === "+" || e.key === "=") { setScale(scale+.1); refreshVisibleMedia(); }
  else if (e.key === "-" || e.key === "_") { setScale(scale-.1); refreshVisibleMedia(); }
  else if (e.key.toLowerCase() === "f") scrollToIndex(focusedIndex, true);
  else if (e.key === "ArrowDown") { focusedIndex = Math.min(TOTAL-1, focusedIndex+1); scrollToIndex(focusedIndex); }
  else if (e.key === "ArrowUp") { focusedIndex = Math.max(0, focusedIndex-1); scrollToIndex(focusedIndex); }
});

/* ========= Tab-Hintergrund drosseln (Tipp 8) ========= */
document.addEventListener('visibilitychange', ()=>{
  if (document.hidden){
    stage.querySelectorAll('video').forEach(v=>{ try{ v.pause(); }catch{} });
  } else {
    refreshVisibleMedia();
  }
});

/* ========= SSE ========= */
function connectEvents(){
  try{
    const es = new EventSource(`${CFG.API}/events`);
    es.onerror = ()=> { es.close(); setTimeout(connectEvents, 5000); };
  }catch{}
}

/* ========= Boot ========= */
(function boot(){
  layoutFrameOnly();
  makeIO();               // IO vor dem ersten Render
  requestAnimationFrame(setInitialView);
  connectEvents();

  // initiale Meta/Status in einer großen Batch (Top-Reihen)
  const top = isMobile ? 8 : 12;
  const lastTop = top*top + (2*top+1) - 1;
  (async ()=>{
    const rM = shrinkRangeBits(0, lastTop, metaSeen);
    const rS = shrinkRangeBits(0, lastTop, statusSeen);
    await Promise.all([
      rM ? loadMetaBatch(rM.from, rM.to) : Promise.resolve(),
      rS ? loadStatusBatch(rS.from, rS.to) : Promise.resolve()
    ]).catch(()=>{});
    updateRenderedRows();
  })();

  // kleine Komfortbehandlung: bei erstem Resize ggf. Autoscale
  window.addEventListener("resize", ()=>{
    if (!userInteracted) setInitialView();
  });
})();