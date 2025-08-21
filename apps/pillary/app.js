const CFG = {
  API: "/pillary/api",
  ROWS: 100,
  TILE: 32,
  GAP: 4,
  PRELOAD_CONCURRENCY: 8,
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

function layoutPyramid() {
  let y = 0, index = 0;
  for (let row = 0; row < CFG.ROWS; row++) {
    const cols = 1 + row * 2;
    let x = 0;
    for (let c = 0; c < cols; c++, index++) {
      const el = document.createElement("div");
      el.className = "tile";
      el.dataset.index = index;
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
      stage.appendChild(el);
      x += CFG.TILE + CFG.GAP;
    }
    y += CFG.TILE + CFG.GAP;
  }
  stage.style.width  = Math.max(...[...stage.children].map(t => t.offsetLeft + CFG.TILE)) + "px";
  stage.style.height = (CFG.TILE + CFG.GAP) * CFG.ROWS + "px";
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

const api = (p) => fetch(`${CFG.API}${p}`).then(r => r.json());

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

function tile(i){ return stage.querySelector(`.tile[data-index="${i}"]`); }

async function onTileClick(e) {
  const el = e.currentTarget;
  const idx = parseInt(el.dataset.index);
  focusedIndex = idx;
  const meta = await api(`/meta/${idx}`);
  const links = meta.links || {};
  const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
  const rarityScore = meta.rarity_score ?? (attrs.find(a => a.trait_type?.toLowerCase() === "rarity_score")?.value);

  const rows = [
    ["Index", `#${idx}`],
    ["Name", meta.name || ""],
    ["Mint", meta.mint || ""],
    ["Symbol", meta.symbol || ""],
    ["Animation", meta.animation_url || meta.properties?.animation_url || ""],
    ["Rarity Score", rarityScore ?? ""],
  ].map(([k,v])=> `<div class="meta-row"><b>${k}</b><div>${(v||"").toString()}</div></div>`).join("");

  const attrHtml = attrs.length
    ? `<div class="meta-row"><b>Attributes</b><div>${attrs.map(a=>`${a.trait_type??""}: ${a.value??""}`).join(" • ")}</div></div>`
    : "";

  const linkHtml = `
    <div class="links">
      ${meta.mint ? `<a target="_blank" href="${links.magicEdenItem}">Magic Eden</a>` : ""}
      ${meta.mint ? `<a target="_blank" href="${links.okxNftItem}">OKX</a>` : ""}
      ${meta.symbol ? `<a target="_blank" href="${links.magicEdenCollection}">Collection</a>` : ""}
    </div>`;

  showModal(`
    <h3>${meta.name ?? "Item"} — #${idx}</h3>
    ${rows}${attrHtml}${linkHtml}
    <video src="${CFG.API}/video/${idx}" controls muted playsinline loop style="width:100%;margin-top:8px;border-radius:8px"></video>
  `);
}

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
      el.appendChild(v);
      v.play().catch(()=>{});
    } else if (!useVideo && hasVideo) {
      const img = document.createElement("img");
      img.alt = `#${idx}`;
      img.src = `${CFG.API}/thumb/${idx}`;
      const old = el.firstChild; if (old) el.removeChild(old);
      el.appendChild(img);
    }
  }
}

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
          el.appendChild(v);
          await v.play().catch(()=>{});
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}
preloadAllChk.addEventListener("change", ()=>{ if (preloadAllChk.checked) preloadAllVideos(); });

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
    api(`/batch/meta?from=${from}&to=${to}`).catch(()=>{});
  });
}, { passive:true });

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

document.addEventListener("keydown", (e)=>{
  if (e.key === "+" || e.key === "=") setScale(scale+.1);
  else if (e.key === "-" || e.key === "_") setScale(scale-.1);
  else if (e.key.toLowerCase() === "f") scrollToIndex(focusedIndex, true);
  else if (e.key === "ArrowDown") { focusedIndex = Math.min(TOTAL-1, focusedIndex+1); scrollToIndex(focusedIndex); }
  else if (e.key === "ArrowUp") { focusedIndex = Math.max(0, focusedIndex-1); scrollToIndex(focusedIndex); }
});

toggleRarity.addEventListener("change", async ()=>{
  if (!toggleRarity.checked) {
    for (const el of stage.children) { el.style.setProperty("--heat","0"); el.removeAttribute("data-heat"); }
    return;
  }
  const windowSize = 200;
  for (let f=0; f<TOTAL; f+=windowSize) {
    const t = Math.min(TOTAL-1, f+windowSize-1);
    const { data } = await api(`/batch/meta?from=${f}&to=${t}`);
    data.forEach(meta=>{
      const score = meta.rarity_score ?? (meta.attributes||[]).find(a=>`${a.trait_type}`.toLowerCase()==="rarity_score")?.value;
      if (score != null) {
        const el = tile(meta.index); if (!el) return;
        const s = Number(score);
        const norm = Math.max(0, Math.min(1, (s - CFG.RARITY_MIN) / (CFG.RARITY_MAX - CFG.RARITY_MIN)));
        el.style.setProperty("--heat", String(norm * 0.65));
        el.setAttribute("data-heat","1");
      }
    });
  }
});

function connectEvents() {
  try {
    const es = new EventSource(`${CFG.API}/events`);
    es.onerror = ()=> { es.close(); setTimeout(connectEvents, 5000); };
  } catch {}
}
connectEvents();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
}

layoutPyramid();

(async ()=>{
  const windowSize = 300;
  for (let f=0; f<TOTAL; f+=windowSize) {
    const t = Math.min(TOTAL-1, f+windowSize-1);
    loadStatusBatch(f, t);
    await new Promise(r=>setTimeout(r, 40));
  }
})();
swapMediaForScale();
preloadAllVideos();

const urlParams = new URLSearchParams(location.search);
if (urlParams.has("i")) {
  const i = parseInt(urlParams.get("i"));
  if (Number.isFinite(i)) scrollToIndex(i, true);
}