/* ===========================================
   Pi Pillary – Cheops Pyramid Gallery
   - Apex (#0) oben, zentriert
   - Erste N Reihen sofort als VIDEO
   - Sonst PNG; Videos erst im Sichtbereich / ab Zoom
   - Achsen & Rarity aus pi_phi_table.json (optional)
   =========================================== */

/* ========= CONFIG ========= */
const CFG = {
  API: "https://inpinity.online/pillary/api", // absolut -> immer dein Worker
  ROWS: 100,
  TILE: 32,
  GAP: 4,                  // 0 = Kante-auf-Kante
  PRELOAD_CONCURRENCY: 4,  // optionales Voll-Preload per Checkbox
  SCALE_IMG_THRESHOLD: 0.7, // ab welchem Zoom Videos (wenn sichtbar)
  INITIAL_ROWS_VISIBLE: 10,  // wie viele Reihen anfänglich exakt sichtbar

  // Geometrie/Rarity-Tabelle (π/φ, Achse, Rarity)
  GEOM_URL: "/pillary/pi_phi_table.json", // lege die Datei so ab
};

/* ========= DOM HOOKS ========= */
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

// GEOM-Daten-Cache: index -> { is_axis, rarity_score, digit_pi, ... }
const GEOM = new Map();

/* ========= API Helper ========= */
const api = (p) => fetch(`${CFG.API}${p}`).then(r => {
  if (!r.ok) throw new Error(`API ${p} -> ${r.status}`);
  return r.json();
});

/* ========= Utility ========= */
function rowOf(index){ return Math.floor(Math.sqrt(index)); }
function tile(i){ return stage.querySelector(`.tile[data-index="${i}"]`); }

/* ========= Geometrie-Daten laden (optional, aber empfohlen) ========= */
async function loadGeom() {
  try {
    const res = await fetch(CFG.GEOM_URL, { cache: "force-cache" });
    if (!res.ok) return;
    const arr = await res.json();
    for (const o of arr) {
      // Deine Tabelle zählt ab 1, unser Index ab 0 → normalisieren:
      const idx = (o.id != null) ? (Number(o.id)-1) : null;
      if (idx == null || idx < 0) continue;
      GEOM.set(idx, {
        is_axis: !!o.is_axis,
        rarity_score: Number(o.rarity_score ?? NaN),
        digit_pi: o.digit_pi,
        digit_phi: o.digit_phi,
        tier: o.tier
      });
    }
  } catch (_) {}
}

/* ===========================================
   LAYOUT: ZENTRIERTE PYRAMIDE
   Reihe r hat 1+2r Spalten, Startindex r^2
   =========================================== */
function layoutPyramid() {
  const unit = CFG.TILE + CFG.GAP;
  const maxCols = 1 + (CFG.ROWS - 1) * 2; // breiteste Reihe ganz unten
  stage.style.width = (maxCols * unit - CFG.GAP) + "px";

  let y = 0;
  for (let row = 0; row < CFG.ROWS; row++) {
    const cols = 1 + row * 2;
    const rowStartIndex = row * row; // Startindex dieser Reihe
    const xOffset = ((maxCols - cols) / 2) * unit; // **zentriert**
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

      // Default: Thumbnail
      const img = document.createElement("img");
      img.alt = `#${index}`;
      img.src = `${CFG.API}/thumb/${index}`;
      img.onerror = ()=> el.classList.add("failed");
      el.appendChild(img);

      // Badge für π-Digit
      const badge = document.createElement("div");
      badge.className = "digit";
      badge.textContent = "";
      el.appendChild(badge);

      // Falls GEOM schon da ist, gleich Achse/Rarity vorbelegen
      const g = GEOM.get(index);
      if (g) {
        if (g.is_axis) el.classList.add("axis");
        if (Number.isFinite(g.rarity_score)) {
          const norm = Math.max(0, Math.min(1, g.rarity_score / 10)); // grobe Normierung 0..10 → 0..1
          el.style.setProperty("--rar", String(norm));
          el.setAttribute("data-heat","1"); // für CSS-Overlay
        }
      }

      stage.appendChild(el);
      x += unit;
    }
    y += unit;
  }
  stage.style.height = (unit * CFG.ROWS - CFG.GAP) + "px";
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
  // horizontal zentriert, vertikal ganz oben (Apex = #0)
  const midX = Math.max(0, (stage.scrollWidth * scale - stageWrap.clientWidth) / 2);
  stageWrap.scrollTo({ left: midX, top: 0, behavior: "auto" });
}

/** Erst-View: so zoomen, dass die ersten N Reihen exakt passen */
function setInitialView() {
  const unit = CFG.TILE + CFG.GAP;
  const wanted = CFG.INITIAL_ROWS_VISIBLE * unit - CFG.GAP;
  const h = Math.max(100, stageWrap.clientHeight);
  const targetScale = Math.max(0.2, Math.min(6, h / wanted));

  setScale(targetScale, { noSwap: true });
  requestAnimationFrame(() => {
    centerOnApex();
    // Erstes Medien-Setup
    visibleSwap();
    // **Wunsch:** Erste N Reihen direkt als Video
    forceVideoForTopRows(CFG.INITIAL_ROWS_VISIBLE);
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
   BATCH-LADER: META + STATUS
   =========================================== */
async function loadMetaBatch(from, to) {
  const { data } = await api(`/batch/meta?from=${from}&to=${to}`);
  data.forEach(meta=>{
    const i = meta.index;
    const el = tile(i);
    if (!el) return;

    // π-Digit aus API-Attributes (Fallback: GEOM)
    const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
    const by = (k) => attrs.find(a => (a.trait_type||"").toLowerCase() === k);
    const digit = by("digit")?.value ?? meta.Digit ?? GEOM.get(i)?.digit_pi;
    const axis  = by("axis")?.value ?? meta.Axis ?? (GEOM.get(i)?.is_axis ? "true" : null);

    const badge = el.querySelector(".digit");
    if (badge && digit != null) badge.textContent = String(digit);
    if (axis === true || axis === "true") el.classList.add("axis");

    // Rarity aus Meta (oder GEOM), als Overlay-Heat
    const rarity =
      meta.rarity_score ??
      (attrs.find(a=> (a.trait_type||"").toLowerCase()==="rarity_score")?.value) ??
      (attrs.find(a=> (a.trait_type||"").toLowerCase()==="rarityscore")?.value) ??
      GEOM.get(i)?.rarity_score;
    if (rarity != null) {
      const s = Number(rarity);
      // Normierung 0..100 → 0..1; falls 0..10 in den GEOMs, passt das auch
      const norm = Math.max(0, Math.min(1, s > 10 ? s/100 : s/10));
      el.style.setProperty("--rar", String(norm));
      el.setAttribute("data-heat","1");
    }
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
    (attrs.find(a => (a.trait_type||"").toLowerCase() === "rarityscore")?.value) ??
    GEOM.get(idx)?.rarity_score;

  const digit = (attrs.find(a => (a.trait_type||"").toLowerCase() === "digit")?.value) ?? GEOM.get(idx)?.digit_pi;
  const axis  = (attrs.find(a => (a.trait_type||"").toLowerCase() === "axis")?.value) ?? (GEOM.get(idx)?.is_axis ? "true" : "");
  const pair  = (attrs.find(a => (a.trait_type||"").toLowerCase() === "matchingpair")?.value) ?? "";

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
   MEDIEN-STEUERUNG
   =========================================== */

// Schaltet EIN Tile um je nach Sichtbarkeit + Zoom
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

// Nur sichtbare Tiles prüfen (Scroll/Zoom)
function visibleSwap() {
  const wrapRect = stageWrap.getBoundingClientRect();
  for (const el of stage.children) {
    const rect = el.getBoundingClientRect();
    const visible = !(rect.right < wrapRect.left || rect.left > wrapRect.right || rect.bottom < wrapRect.top || rect.top > wrapRect.bottom);
    toggleTileMedia(el, visible);
  }
}

// Erste N Reihen sofort auf Video setzen (auch wenn Schwelle erfüllt)
function forceVideoForTopRows(N) {
  for (let i=0;i<TOTAL;i++){
    const r = rowOf(i);
    if (r >= N) break;
    const el = tile(i);
    if (!el) continue;
    toggleTileMedia(el, true); // treat as visible
  }
}

// IntersectionObserver – live Umschalten
const io = new IntersectionObserver((entries)=>{
  for (const ent of entries) {
    const el = ent.target;
    if (!(el instanceof HTMLElement)) continue;
    toggleTileMedia(el, ent.isIntersecting);
  }
}, {
  root: stageWrap,
  rootMargin: "256px 0px", // Preload-Puffer
  threshold: 0.25
});

/* ===========================================
   OPTIONAL: volles Preload (manuell via Checkbox)
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
   SCROLL-LADER (Lazy-Batches je sichtbarer Zeile)
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
    const to = from + (1 + r*2) - 1;
    loadMetaBatch(from, to).catch(()=>{});
    loadStatusBatch(from, to).catch(()=>{});
  });

  visibleSwap();
}, { passive:true });

/* ===========================================
   NAVIGATION (Jump & Keyboard)
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
   SSE (Heartbeats)
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
(async ()=>{
  await loadGeom();      // Achsen/Rarity vorbereiten
  layoutPyramid();       // Tiles erzeugen
  Array.from(stage.children).forEach(el => io.observe(el)); // Sichtbarkeit beobachten
  requestAnimationFrame(setInitialView);  // Apex-View & Top-Reihen als Video
  connectEvents();

  // Meta & Status in Wellen (bremst Browser nicht aus)
  const windowSize = 300;
  for (let f=0; f<TOTAL; f+=windowSize) {
    const t = Math.min(TOTAL-1, f+windowSize-1);
    loadMetaBatch(f, t).catch(()=>{});
    loadStatusBatch(f, t).catch(()=>{});
    await new Promise(r=>setTimeout(r, 40));
  }
})();