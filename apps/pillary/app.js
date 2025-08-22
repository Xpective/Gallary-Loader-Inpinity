/* ===========================================
   Pi Pillary – zentrale Zahlen-Pyramide (Cheops-Stil)
   =========================================== */

/* ========= CONFIG ========= */
const CFG = {
  // Wenn du im Browser über https://inpinity.online/pillary aufrufst,
  // kannst du auch "/pillary/api" nehmen. Für Tests auf der Pages-URL nimm die absolute:
  API: "https://inpinity.online/pillary/api",
  ROWS: 100,
  TILE: 32,
  GAP: 4,                     // 0 = Kante-auf-Kante
  PRELOAD_CONCURRENCY: 4,     // optionales Voll-Preload (Checkbox)
  SCALE_IMG_THRESHOLD: 0.7,   // ab diesem Zoom Videos (wenn sichtbar)
  INITIAL_ROWS_VISIBLE: 10     // erste N Reihen sollen anfänglich genau in die Höhe passen
};

/* ========= DOM ========= */
const stage = document.getElementById("stage");
const stageWrap = document.getElementById("stageWrap");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomLevel = document.getElementById("zoomLevel");
const preloadAllChk = document.getElementById("preloadAll");
const toggleRarity = document.getElementById("toggleRarity");
const jumpTo = document.getElementById("jumpTo");
const jumpBtn = document.getElementById("jumpBtn");
const modal = document.getElementById("modal");
const modalContent = document.getElementById("modalContent");
const closeModal = document.getElementById("closeModal");

/* ========= STATE ========= */
let scale = 1;
let focusedIndex = 0;
let userInteracted = false;
const TOTAL = CFG.ROWS * CFG.ROWS;

/* ========= API Helper ========= */
const api = (p) => fetch(`${CFG.API}${p}`).then(r => {
  if (!r.ok) throw new Error(`API ${p} -> ${r.status}`);
  return r.json();
});

/* ========= Utils ========= */
function tile(i){ return stage.querySelector(`.tile[data-index="${i}"]`); }

/* ===========================================
   LAYOUT: zentrale Zahlen-Pyramide
   Reihe r hat 2r+1 Blöcke; Startindex = r²
   → #0 oben alleine; darunter 1..3; darunter 4..8; etc.
   =========================================== */
function layoutPyramid() {
  const unit = CFG.TILE + CFG.GAP;

  // breiteste Reihe (unten) hat 2*(ROWS-1)+1 Spalten
  const maxCols = 2*(CFG.ROWS - 1) + 1;
  stage.style.width = (maxCols * unit - CFG.GAP) + "px";

  let y = 0;
  for (let row = 0; row < CFG.ROWS; row++) {
    const cols = 2*row + 1;          // 1,3,5,7,...
    const rowStartIndex = row*row;   // 0,1,4,9,16,...
    const mid = Math.floor(cols/2);  // mittlerer Block dieser Reihe

    // so ausrichten, dass der mittlere Block unter der zentralen Achse liegt
    const xOffset = ((maxCols / 2) - mid) * unit;
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

      // Standard: zunächst Thumbnail
      const img = document.createElement("img");
      img.alt = `#${index}`;
      img.src = `${CFG.API}/thumb/${index}`;
      img.onerror = ()=> el.classList.add("failed");
      el.appendChild(img);

      // Badge für Ziffer (wird via Meta befüllt)
      const badge = document.createElement("div");
      badge.className = "digit";
      badge.textContent = "";
      el.appendChild(badge);

      stage.appendChild(el);
      x += unit;
    }
    y += unit;
  }
  stage.style.height = (unit * CFG.ROWS - CFG.GAP) + "px";
}

/* ===========================================
   ZOOM & INITIAL VIEW (erste N Reihen passend)
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
  // horizontal zentriert, vertikal oben (Apex = #0)
  const midX = Math.max(0, (stage.scrollWidth * scale - stageWrap.clientWidth) / 2);
  stageWrap.scrollTo({ left: midX, top: 0, behavior: "auto" });
}

/** Erst-View: zoomt so, dass die ersten N Reihen exakt in die Höhe passen */
function setInitialView() {
  const unit = CFG.TILE + CFG.GAP;
  const wanted = CFG.INITIAL_ROWS_VISIBLE * unit - CFG.GAP;
  const h = Math.max(100, stageWrap.clientHeight);
  const targetScale = Math.max(0.2, Math.min(6, h / wanted));

  setScale(targetScale, { noSwap: true });
  requestAnimationFrame(() => {
    centerOnApex();
    visibleSwap();                 // sichtbare Tiles einmal prüfen
    forceVideoForTopRows(CFG.INITIAL_ROWS_VISIBLE); // erste N Reihen direkt Video
  });
}

/* Zoom-Controls */
zoomInBtn.onclick  = () => { userInteracted = true; setScale(scale + .1); };
zoomOutBtn.onclick = () => { userInteracted = true; setScale(scale - .1); };

/* Pinch/Ctrl+Scroll */
stageWrap.addEventListener("wheel", (e)=>{
  if (!e.ctrlKey) return;
  e.preventDefault();
  userInteracted = true;
  setScale(scale + (e.deltaY < 0 ? .1 : -.1));
}, { passive: false });

["scroll","keydown","pointerdown","touchstart"].forEach(evt=>{
  window.addEventListener(evt, ()=> userInteracted = true, { passive:true });
});

/* ===========================================
   META + STATUS (Batch)
   =========================================== */
async function loadMetaBatch(from, to) {
  const { data } = await api(`/batch/meta?from=${from}&to=${to}`);
  data.forEach(meta=>{
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
  });
}

async function loadStatusBatch(from, to) {
  const { data } = await api(`/batch/status?from=${from}&to=${to}`);
  data.forEach(s => {
    const el = tile(s.index);
    if (!el) return;
    if (!s.minted) el.dataset.status = "unminted";
    else if (s.listed) el.dataset.status = "listed";
    else if (s.verified) el.dataset.status = "verified";
    if (s.freshBought) el.classList.add("fresh");

    // Market-Badge optional
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
  const el = e.currentTarget;
  const idx = parseInt(el.dataset.index);
  focusedIndex = idx;

  const meta = await api(`/meta/${idx}`);
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

  const attrHtml = attrs.length
    ? `<div class="meta-row"><b>Attributes</b><div>${attrs.map(a=>`${a.trait_type??""}: ${a.value??""}`).join(" • ")}</div></div>`
    : "";

  const linkHtml = `
    <div class="links">
      ${meta.mint ? `<a target="_blank" href="${links.magicEdenItem}">Kaufen @ Magic Eden</a>` : ""}
      ${meta.mint ? `<a target="_blank" href="${links.okxNftItem}">Kaufen @ OKX</a>` : ""}
      <a target="_blank" href="https://magiceden.io/marketplace/InPi">Collection</a>
      <a target="_blank" href="https://solscan.io/account/GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp">Creator</a>
    </div>`;

  showModal(`
    <h3>${meta.name ?? "Item"} — #${idx}</h3>
    ${rows}${attrHtml}${linkHtml}
    <video src="${CFG.API}/video/${idx}" controls muted playsinline loop style="width:100%;margin-top:8px;border-radius:8px"></video>
  `);
}

/* ===========================================
   MEDIEN-STEUERUNG (Video nur im Sichtbereich / ab Zoom)
   =========================================== */
function toggleTileMedia(el, isVisible) {
  const idx = parseInt(el.dataset.index);
  if (el.classList.contains("failed")) return;

  const wantVideo = isVisible && scale >= CFG.SCALE_IMG_THRESHOLD;
  const hasVideo = !!el.querySelector("video");

  if (wantVideo && !hasVideo) {
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
    v.src = `${CFG.API}/video/${idx}`;
    v.onerror = ()=> el.classList.add("failed");
    const old = el.firstChild; if (old) el.removeChild(old);
    el.prepend(v);
    v.play().catch(()=>{});
  } else if (!wantVideo && hasVideo) {
    const img = document.createElement("img");
    img.alt = `#${idx}`;
    img.src = `${CFG.API}/thumb/${idx}`;
    img.onerror = ()=> el.classList.add("failed");
    const old = el.firstChild; if (old) el.removeChild(old);
    el.prepend(img);
  }
}

function visibleSwap() {
  const wrapRect = stageWrap.getBoundingClientRect();
  for (const el of stage.children) {
    const rect = el.getBoundingClientRect();
    const visible = !(rect.right < wrapRect.left || rect.left > wrapRect.right || rect.bottom < wrapRect.top || rect.top > wrapRect.bottom);
    toggleTileMedia(el, visible);
  }
}

function forceVideoForTopRows(N) {
  // treat as visible, damit Top-Reihen sofort als Video kommen
  const unit = CFG.TILE + CFG.GAP;
  for (let row = 0; row < Math.min(N, CFG.ROWS); row++) {
    const cols = 2*row + 1;
    const start = row*row;
    const end = start + cols - 1;
    for (let i = start; i <= end; i++) {
      const el = tile(i);
      if (el) toggleTileMedia(el, true);
    }
  }
}

// IntersectionObserver für Live-Umschalten
const io = new IntersectionObserver((entries)=>{
  for (const ent of entries) {
    const el = ent.target;
    if (!(el instanceof HTMLElement)) continue;
    toggleTileMedia(el, ent.isIntersecting);
  }
}, {
  root: stageWrap,
  rootMargin: "256px 0px",
  threshold: 0.25
});

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
          const v = document.createElement("video");
          v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
          v.src = `${CFG.API}/video/${i}`;
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
    const to   = from + (2*r + 1) - 1; // start + cols - 1
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
  if (e.key === "+" || e.key === "=") setScale(scale+.1);
  else if (e.key === "-" || e.key === "_") setScale(scale-.1);
  else if (e.key.toLowerCase() === "f") scrollToIndex(focusedIndex, true);
  else if (e.key === "ArrowDown") { focusedIndex = Math.min(TOTAL-1, focusedIndex+1); scrollToIndex(focusedIndex); }
  else if (e.key === "ArrowUp") { focusedIndex = Math.max(0, focusedIndex-1); scrollToIndex(focusedIndex); }
});

/* ===========================================
   SSE Heartbeats
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
  Array.from(stage.children).forEach(el => io.observe(el)); // Sichtbarkeit beobachten
  requestAnimationFrame(setInitialView);
  connectEvents();

  // Meta & Status in Wellen (bremst Browser nicht aus)
  (async ()=>{
    const windowSize = 300;
    for (let f=0; f<TOTAL; f+=windowSize) {
      const t = Math.min(TOTAL-1, f+windowSize-1);
      loadMetaBatch(f, t).catch(()=>{});
      loadStatusBatch(f, t).catch(()=>{});
      await new Promise(r=>setTimeout(r, 40));
    }
  })();
})();