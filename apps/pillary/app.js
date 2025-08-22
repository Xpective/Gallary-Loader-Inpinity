const CFG = {
  API: "/pillary/api",
  ROWS: 100,
  TILE: 32,
  GAP: 4,
  PRELOAD_CONCURRENCY: 6,
  RARITY_MIN: 0,
  RARITY_MAX: 100,
  SCALE_IMG_THRESHOLD: 0.7,
};

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

let scale = 1;
let focusedIndex = 0;
const TOTAL = CFG.ROWS * CFG.ROWS;

const api = (p) => fetch(`${CFG.API}${p}`).then(r => {
  if (!r.ok) throw new Error(`API ${p} -> ${r.status}`);
  return r.json();
});

/** Layout als Pyramide (zentral) */
function layoutPyramid() {
  const unit = CFG.TILE + CFG.GAP;
  const maxCols = 1 + (CFG.ROWS - 1) * 2;
  const stageWidth = maxCols * unit - CFG.GAP;
  stage.style.width = stageWidth + "px";

  let y = 0;
  for (let row = 0; row < CFG.ROWS; row++) {
    const cols = 1 + row * 2;            // 1,3,5,…
    const rowStartIndex = row * row;     // Reihenstart
    const xOffset = ((maxCols - cols) / 2) * unit;
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

      const img = document.createElement("img");
      img.alt = `#${index}`;
      img.src = `${CFG.API}/thumb/${index}`;
      el.appendChild(img);

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

function setScale(s) {
  const prev = scale;
  scale = Math.max(0.2, Math.min(6, s));
  stage.style.transform = `scale(${scale})`;
  zoomLevel.textContent = Math.round(scale * 100) + "%";
  if ((prev < CFG.SCALE_IMG_THRESHOLD && scale >= CFG.SCALE_IMG_THRESHOLD) ||
      (prev >= CFG.SCALE_IMG_THRESHOLD && scale < CFG.SCALE_IMG_THRESHOLD)) {
    swapMediaForScale();
  }
}

zoomInBtn.onclick  = () => setScale(scale + .1);
zoomOutBtn.onclick = () => setScale(scale - .1);

stageWrap.addEventListener("wheel", (e)=>{
  if (!e.ctrlKey) return;
  e.preventDefault();
  setScale(scale + (e.deltaY < 0 ? .1 : -.1));
}, { passive: false });

closeModal.onclick = () => modal.classList.add("hidden");
function showModal(html){ modalContent.innerHTML = html; modal.classList.remove("hidden"); }

function tile(i){ return stage.querySelector(`.tile[data-index="${i}"]`); }

/** Batch-Laden von Metadaten */
async function loadMetaBatch(from, to) {
  const { data } = await api(`/batch/meta?from=${from}&to=${to}`);
  data.forEach(meta=>{
    const i = meta.index;
    const el = tile(i);
    if (!el) return;

    const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
    const by = (k) => attrs.find(a => (a.trait_type||"").toLowerCase() === k);

    const digit = meta.Digit ?? by("digit")?.value;
    const axis  = meta.Axis ?? by("axis")?.value;
    const pair  = meta.MatchingPair ?? by("matchingpair")?.value;

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
  });
}

/** Klick öffnet Modal mit Collection-Infos */
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

  const rows = [
    ["Index", `#${idx}`],
    ["Name", meta.name || ""],
    ["Mint", meta.mint || ""],
    ["Symbol", meta.symbol || ""],
    ["Digit (π)", digit ?? ""],
    ["Rarity Score", rarityScore ?? ""],
  ].map(([k,v])=> `<div class="meta-row"><b>${k}</b><div>${(v||"").toString()}</div></div>`).join("");

  const attrHtml = attrs.length
    ? `<div class="meta-row"><b>Attributes</b><div>${attrs.map(a=>`${a.trait_type??""}: ${a.value??""}`).join(" • ")}</div></div>`
    : "";

  const linkHtml = `
    <div class="links">
      ${meta.mint ? `<a target="_blank" href="${links.magicEdenItem}">Kaufen @ Magic Eden</a>` : ""}
      ${meta.mint ? `<a target="_blank" href="${links.okxNftItem}">Kaufen @ OKX</a>` : ""}
      <a target="_blank" href="${links.collection}">Collection</a>
      <a target="_blank" href="${links.creator}">Creator</a>
    </div>`;

  const collHtml = `
    <div class="collection-info">
      <p><b>Collection Utility:</b> Zugang zu Inpinity Farmverse, Premints & Tokenomics-Phasen</p>
      <p><b>Contract:</b> ${meta.collectionInfo?.address}</p>
      <p><b>Creator:</b> ${meta.collectionInfo?.creator}</p>
    </div>`;

  showModal(`
    <h3>${meta.name ?? "Item"} — #${idx}</h3>
    ${rows}${attrHtml}${collHtml}${linkHtml}
    <video src="${CFG.API}/video/${idx}" controls muted playsinline loop style="width:100%;margin-top:8px;border-radius:8px"></video>
  `);
}

/** Bild ↔ Video Swap */
function swapMediaForScale() {
  const useVideo = scale >= CFG.SCALE_IMG_THRESHOLD;
  for (const el of stage.children) {
    const idx = parseInt(el.dataset.index);
    const hasVideo = el.querySelector("video");
    if (useVideo && !hasVideo) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
      v.src = `${CFG.API}/video/${idx}`;
      const old = el.firstChild; if (old) el.removeChild(old);
      el.prepend(v);
      v.play().catch(()=>{});
    } else if (!useVideo && hasVideo) {
      const img = document.createElement("img");
      img.alt = `#${idx}`;
      img.src = `${CFG.API}/thumb/${idx}`;
      const old = el.firstChild; if (old) el.removeChild(old);
      el.prepend(img);
    }
  }
}

/** Auto-Preload Videos */
async function preloadAllVideos() {
  const conc = CFG.PRELOAD_CONCURRENCY;
  let next = 0;
  async function worker() {
    while (preloadAllChk.checked && next < TOTAL) {
      const i = next++;
      const el = tile(i);
      if (!el) continue;
      try {
        if (!el.querySelector("video")) {
          const v = document.createElement("video");
          v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
          v.src = `${CFG.API}/video/${i}`;
          const old = el.firstChild; if (old) el.removeChild(old);
          el.prepend(v);
          await v.play().catch(()=>{});
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}
preloadAllChk.addEventListener("change", ()=>{ if (preloadAllChk.checked) preloadAllVideos(); });

/** Lazy-Load Batches beim Scrollen */
let lastScrollY = 0;
stageWrap.addEventListener("scroll", ()=> {
  const y = stageWrap.scrollTop / (scale || 1);
  if (Math.abs(y - lastScrollY) < 64) return;
  lastScrollY = y;
  const rowHeight = CFG.TILE + CFG.GAP;
  const row = Math.floor(y / rowHeight);
  const windowRows = [row-2, row-1, row, row+1, row+2].filter(r => r>=0 && r<CFG.ROWS);
  windowRows.forEach(r=>{
    const from = r*r;
    const to = from + (1 + r*2) - 1;
    loadMetaBatch(from, to).catch(()=>{});
    loadStatusBatch(from, to).catch(()=>{});
  });
}, { passive:true });

/** Scroll zu bestimmtem Index */
function scrollToIndex(i, open = false) {
  const t = tile(i); if (!t) return;
  stageWrap.scrollTo({ left: t.offsetLeft*scale-100, top: t.offsetTop*scale-100, behavior: "smooth" });
  t.focus();
  if (open) onTileClick({ currentTarget: t });
}
jumpBtn.onclick = () => {
  const i = parseInt(jumpTo.value);
  if (Number.isFinite(i) && i >= 0 && i < TOTAL) scrollToIndex(i, false);
};

/** Start */
layoutPyramid();
swapMediaForScale();

// Start bei Reihe 10
const row10start = 10*10;
scrollToIndex(row10start);

(async ()=>{
  const windowSize = 300;
  for (let f=0; f<TOTAL; f+=windowSize) {
    const t = Math.min(TOTAL-1, f+windowSize-1);
    loadMetaBatch(f, t).catch(()=>{});
    loadStatusBatch(f, t).catch(()=>{});
    await new Promise(r=>setTimeout(r, 40));
  }
})();