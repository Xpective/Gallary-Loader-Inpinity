/* ===========================================
   Pi Pillary – zentrale Zahlen-Pyramide (Cheops-Stil)
   =========================================== */

/* ========= CONFIG ========= */
const CFG = {
  API: "https://inpinity.online/pillary/api",
  ROWS: 100,
  TILE: 32,
  GAP: 4,
  PRELOAD_CONCURRENCY: 4,
  SCALE_IMG_THRESHOLD: 0.7,   // ab diesem Zoom Videos (wenn sichtbar)
  INITIAL_ROWS_VISIBLE: 10
};

/* ========= DOM Helper (null-sicher) ========= */
function reqEl(id) {
  let el = document.getElementById(id);
  if (!el) {
    // Minimal-Modal zur Not dynamisch nachrüsten
    if (id === "modal") {
      const m = document.createElement("div");
      m.id = "modal"; m.className = "hidden";
      m.innerHTML = `<div id="modalContent" class="modal-body"></div><button id="closeModal">Schließen</button>`;
      document.body.appendChild(m);
      el = m;
    } else if (id === "modalContent") {
      const mc = document.createElement("div");
      mc.id = "modalContent"; mc.className = "modal-body";
      reqEl("modal").appendChild(mc);
      el = mc;
    } else if (id === "closeModal") {
      const b = document.createElement("button");
      b.id = "closeModal"; b.textContent = "Schließen";
      reqEl("modal").appendChild(b);
      el = b;
    } else {
      console.error(`[Pillary] Element #${id} nicht gefunden. Prüfe /pillary/index.html IDs.`);
      throw new Error(`Element #${id} not found`);
    }
  }
  return el;
}

/* ========= DOM ========= */
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

/* ========= STATE ========= */
let scale = 1;
let focusedIndex = 0;
let userInteracted = false;
const TOTAL = CFG.ROWS * CFG.ROWS;

/* ========= API Helper ========= */
async function apiGet(p) {
  const r = await fetch(`${CFG.API}${p}`);
  if (!r.ok) throw new Error(`API ${p} -> ${r.status}`);
  return r.json();
}

/* ========= Utils ========= */
function tile(i){ return stage.querySelector(`.tile[data-index="${i}"]`); }
function showModal(html){
  modalContent.innerHTML = html;
  modal.classList.remove("hidden");
  const x = document.getElementById("closeModal");
  if (x) x.onclick = () => modal.classList.add("hidden");
}
closeModalBtn.onclick = () => modal.classList.add("hidden");

/* ===========================================
   LAYOUT: zentrale Zahlen-Pyramide
   Reihe r hat 2r+1 Blöcke; Startindex = r²
   =========================================== */
function layoutPyramid() {
  const unit = CFG.TILE + CFG.GAP;

  const maxCols = 2*(CFG.ROWS - 1) + 1; // breiteste Reihe
  stage.style.width = (maxCols * unit - CFG.GAP) + "px";

  let y = 0;
  for (let row = 0; row < CFG.ROWS; row++) {
    const cols = 2*row + 1;          // 1,3,5,7,...
    const rowStartIndex = row*row;   // 0,1,4,9,16,...
    const mid = Math.floor(cols/2);  // mittlerer Block

    const xOffset = ((maxCols / 2) - mid) * unit; // mittig unter der Achse
    let x = xOffset;

    for (let c = 0; c < cols; c++) {
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

      // Start: Thumbnail (niemals schwarz)
      const img = document.createElement("img");
      img.alt = `#${index}`;
      img.src = `${CFG.API}/thumb/${index}`;
      img.decoding = "async";
      img.loading = "lazy";
      img.onerror = ()=> el.classList.add("failed");
      el.appendChild(img);

      const badge = document.createElement("div");
      badge.className = "digit";
      badge.textContent = "";
      el.appendChild(badge);

      stage.appendChild(el);
      io.observe(el); // Sichtbarkeits-Beobachtung
      x += unit;
    }
    y += unit;
  }
  stage.style.height = (unit * CFG.ROWS - CFG.GAP) + "px";
}

/* ===========================================
   MEDIEN-STEUERUNG (Video nur in Sicht / ab Zoom)
   =========================================== */
function makeVideo(idx, posterUrl) {
  const v = document.createElement("video");
  v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
  v.preload = "metadata";
  if (posterUrl) v.poster = posterUrl; // verhindert „schwarz“
  v.src = `${CFG.API}/video/${idx}`;
  return v;
}

function toggleTileMedia(el, isVisible) {
  const idx = parseInt(el.dataset.index);
  if (el.classList.contains("failed")) return;

  const wantVideo = isVisible && scale >= CFG.SCALE_IMG_THRESHOLD;
  const hasVideo = !!el.querySelector("video");

  if (wantVideo && !hasVideo) {
    const poster = `${CFG.API}/thumb/${idx}`;
    const v = makeVideo(idx, poster);
    v.onerror = ()=> el.classList.add("failed");
    const old = el.firstChild; if (old) el.removeChild(old);
    el.prepend(v);
    v.play().catch(()=>{}); // Autoplay-Safety
  } else if (!wantVideo && hasVideo) {
    const img = document.createElement("img");
    img.alt = `#${idx}`;
    img.src = `${CFG.API}/thumb/${idx}`;
    img.decoding = "async";
    img.loading = "lazy";
    img.onerror = ()=> el.classList.add("failed");
    const old = el.firstChild; if (old) el.removeChild(old);
    el.prepend(img);
  }
}

/* Sichtbarkeits-Observer:
   – setzt .inview-Klasse (für Dimmen außerhalb)
   – triggert Medienwechsel
*/
const io = new IntersectionObserver((entries)=>{
  for (const ent of entries) {
    const el = ent.target;
    if (!(el instanceof HTMLElement)) continue;
    if (ent.isIntersecting) el.classList.add("inview");
    else el.classList.remove("inview");
    toggleTileMedia(el, ent.isIntersecting);
  }
}, {
  root: stageWrap,
  rootMargin: "256px 0px",
  threshold: 0.25
});

function visibleSwap() {
  // ergänzend für Zoom: markiere sichtbar/unsichtbar (grobe Box-Check)
  const wrapRect = stageWrap.getBoundingClientRect();
  for (const el of stage.children) {
    const rect = el.getBoundingClientRect();
    const visible = !(rect.right < wrapRect.left || rect.left > wrapRect.right || rect.bottom < wrapRect.top || rect.top > wrapRect.bottom);
    el.classList.toggle("inview", visible);
    toggleTileMedia(el, visible);
  }
}

function forceVideoForTopRows(N) {
  // Top-N-Reihen sofort als "sichtbar" behandeln (Glow & Video)
  for (let row = 0; row < Math.min(N, CFG.ROWS); row++) {
    const cols = 2*row + 1;
    const start = row*row;
    const end = start + cols - 1;
    for (let i = start; i <= end; i++) {
      const el = tile(i);
      if (el) {
        el.classList.add("inview");
        toggleTileMedia(el, true);
      }
    }
  }
}

/* ===========================================
   ZOOM & INITIAL VIEW
   =========================================== */
function setScale(s, { noSwap = false } = {}) {
  const prev = scale;
  scale = Math.max(0.2, Math.min(6, s));
  stage.style.transform = `scale(${scale})`;
  zoomLevel.textContent = Math.round(scale * 100) + "%";

  const crossed =
    (prev < CFG.SCALE_IMG_THRESHOLD && scale >= CFG.SCALE_IMG_THRESHOLD) ||
    (prev >= CFG.SCALE_IMG_THRESHOLD && scale < CFG.SCALE_IMG_THRESHOLD);

  if (!noSwap && crossed) visibleSwap();
}

function centerOnApex() {
  const midX = Math.max(0, (stage.scrollWidth * scale - stageWrap.clientWidth) / 2);
  stageWrap.scrollTo({ left: midX, top: 0, behavior: "auto" });
}

function setInitialView() {
  const unit = CFG.TILE + CFG.GAP;
  const wanted = CFG.INITIAL_ROWS_VISIBLE * unit - CFG.GAP;
  const h = Math.max(100, stageWrap.clientHeight);
  const targetScale = Math.max(0.2, Math.min(6, h / wanted));

  setScale(targetScale, { noSwap: true });
  requestAnimationFrame(() => {
    centerOnApex();
    visibleSwap();                          // sichtbare Tiles erkennen
    forceVideoForTopRows(CFG.INITIAL_ROWS_VISIBLE); // Top-N direkt Video
  });
}

/* Zoom-Controls */
zoomInBtn.onclick  = () => { userInteracted = true; setScale(scale + .1); visibleSwap(); };
zoomOutBtn.onclick = () => { userInteracted = true; setScale(scale - .1); visibleSwap(); };

/* Pinch/Ctrl+Scroll */
stageWrap.addEventListener("wheel", (e)=>{
  if (!e.ctrlKey) return;
  e.preventDefault();
  userInteracted = true;
  setScale(scale + (e.deltaY < 0 ? .1 : -.1));
  visibleSwap();
}, { passive: false });

["scroll","keydown","pointerdown","touchstart"].forEach(evt=>{
  window.addEventListener(evt, ()=> userInteracted = true, { passive:true });
});

/* ===========================================
   META + STATUS (Batch) + RARITY-Glow
   =========================================== */
async function loadMetaBatch(from, to) {
  const { data } = await apiGet(`/batch/meta?from=${from}&to=${to}`);
  data.forEach(meta=>{
    if (!meta || meta.error) return;  // Problem-Indizes skippen
    const i = meta.index;
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

    // Rarity-Heat (0..100 → 0..1)
    const score =
      meta.rarity_score ??
      (attrs.find(a=> (a.trait_type||"").toLowerCase()==="rarity_score")?.value) ??
      (attrs.find(a=> (a.trait_type||"").toLowerCase()==="rarityscore")?.value);
    if (score != null) {
      const s = Number(score);
      const norm = Math.max(0, Math.min(1, (s - 0) / (100 - 0)));
      el.style.setProperty("--heat", String(norm * 0.65));
      el.setAttribute("data-heat","1");
    }
  });
}

async function loadStatusBatch(from, to) {
  const { data } = await apiGet(`/batch/status?from=${from}&to=${to}`);
  data.forEach(s => {
    const el = tile(s.index);
    if (!el) return;
    if (!s.minted) el.dataset.status = "unminted";
    else if (s.listed) el.dataset.status = "listed";
    else if (s.verified) el.dataset.status = "verified";
    if (s.market && s.market !== "none") {
      el.dataset.market = s.market; // "me" | "okx" | "both"
      const t = el.getAttribute("title") || `#${s.index}`;
      const marketTxt = s.market === "both" ? "ME + OKX" : (s.market.toUpperCase());
      el.title = `${t} — listed on ${marketTxt}`;
    } else {
      el.dataset.market = "none";
    }
  });
}

/* ===========================================
   DETAIL-MODAL
   =========================================== */
async function onTileClick(e) {
  try {
    const el = e.currentTarget;
    const idx = parseInt(el.dataset.index);
    focusedIndex = idx;

    const meta = await apiGet(`/meta/${idx}`);
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

    const linkHtml = `
      <div class="links">
        ${meta.mint ? `<a target="_blank" href="${links.magicEdenItem}">Kaufen @ Magic Eden</a>` : ""}
        ${meta.mint ? `<a target="_blank" href="${links.okxNftItem}">Kaufen @ OKX</a>` : ""}
        <a target="_blank" href="https://magiceden.io/marketplace/inpi">Collection</a>
        <a target="_blank" href="https://solscan.io/account/GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp">Creator</a>
      </div>`;

    showModal(`
      <h3>${meta.name ?? "Item"} — #${idx}</h3>
      ${rows}${linkHtml}
      <video src="${CFG.API}/video/${idx}" controls muted playsinline loop
             preload="metadata" poster="${CFG.API}/thumb/${idx}"
             style="width:100%;margin-top:8px;border-radius:8px"></video>
    `);
  } catch (err) {
    console.error("Modal-Fehler:", err);
    alert("Konnte Details nicht laden. Bitte später erneut versuchen.");
  }
}

/* ===========================================
   OPTIONAL: Preload-Checkbox
   =========================================== */
async function preloadAllVideos() {
  const conc = CFG.PRELOAD_CONCURRENCY;
  let next = 0;
  async function worker() {
    while (preloadAllChk.checked && next < TOTAL) {
      const i = next++;
      const el = tile(i);
      if (!el || el.classList.contains("failed")) continue;
      try {
        if (!el.querySelector("video")) {
          const v = makeVideo(i, `${CFG.API}/thumb/${i}`);
          v.onerror = ()=> el.classList.add("failed");
          const old = el.firstChild; if (old) el.removeChild(old);
          el.prepend(v);
          await v.play().catch(()=>{});
        }
      } catch { el.classList.add("failed"); }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}
preloadAllChk.addEventListener("change", ()=>{ if (preloadAllChk.checked) preloadAllVideos(); });

/* ===========================================
   SCROLL: Lazy-Batches je sichtbarer Zeile
   =========================================== */
let lastScrollY = 0;
stageWrap.addEventListener("scroll", ()=> {
  const y = stageWrap.scrollTop / (scale || 1);
  if (Math.abs(y - lastScrollY) < 64) return;
  lastScrollY = y;

  const unit = CFG.TILE + CFG.GAP;
  const row = Math.floor(y / unit);
  const windowRows = [row-2, row-1, row, row+1, row+2].filter(r => r>=0 && r<CFG.ROWS);
  windowRows.forEach(r=>{
    const from = r*r;
    const to   = from + (2*r + 1) - 1;
    loadMetaBatch(from, to).catch(()=>{});
    loadStatusBatch(from, to).catch(()=>{});
  });

  visibleSwap();
}, { passive:true });

/* ===========================================
   NAVIGATION
   =========================================== */
function scrollToIndex(i, open = false) {
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
  if (e.key === "+" || e.key === "=") { setScale(scale+.1); visibleSwap(); }
  else if (e.key === "-" || e.key === "_") { setScale(scale-.1); visibleSwap(); }
  else if (e.key.toLowerCase() === "f") scrollToIndex(focusedIndex, true);
  else if (e.key === "ArrowDown") { focusedIndex = Math.min(TOTAL-1, focusedIndex+1); scrollToIndex(focusedIndex); }
  else if (e.key === "ArrowUp") { focusedIndex = Math.max(0, focusedIndex-1); scrollToIndex(focusedIndex); }
});

/* ===========================================
   SSE Heartbeats (ggf. /stream nutzen, wenn Blocker)
   =========================================== */
function connectEvents() {
  try {
    const es = new EventSource(`${CFG.API}/events`);
    es.onerror = ()=> { es.close(); setTimeout(connectEvents, 5000); };
  } catch {}
}

/* ===========================================
   BOOT
   =========================================== */
(function boot(){
  layoutPyramid();
  requestAnimationFrame(setInitialView);
  connectEvents();

  // Meta & Status in Wellen
  (async ()=>{
    const windowSize = 150; // kleinere Wellen schonend
    for (let f=0; f<TOTAL; f+=windowSize) {
      const t = Math.min(TOTAL-1, f+windowSize-1);
      loadMetaBatch(f, t).catch(()=>{});
      loadStatusBatch(f, t).catch(()=>{});
      await new Promise(r=>setTimeout(r, 40));
    }
  })();

  // Auf Fenstergröße reagieren (neu einpassen solange keine Interaktion)
  window.addEventListener("resize", ()=>{
    if (!userInteracted) setInitialView();
  });
})();