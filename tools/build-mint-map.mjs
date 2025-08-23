// tools/build-mint-map.mjs
// Erzeugt eine index->mint Map aus Helius DAS (per Collection-Adresse)
//
// ENV erwartet:
//   HELIUS_API_KEY="..."         (dein Helius Key)
//   COLLECTION_MINT="..."        (deine verified Collection Mint)
// Optional:
//   EXPECTED_BASE_CID="bafy..."  (nur zur Sanity-Prüfung/Heuristik)
//   FETCH_JSON_FALLBACK="1"      (fehlt Index -> JSON der Assets abrufen)
//   JSON_TIMEOUT_MS="8000"       (Timeout pro JSON-Request)
//   JSON_CONCURRENCY="8"         (gleichzeitige JSON-Requests)
//
// Aufruf:
//   HELIUS_API_KEY=... COLLECTION_MINT=... node tools/build-mint-map.mjs > mint-map.json
//
// Ausgabe: Eine kompakte JSON-Map { "0": "Mint...", "1": "Mint...", ... }

const API_KEY = process.env.HELIUS_API_KEY || "";
const COLLECTION = process.env.COLLECTION_MINT || "";
const EXPECTED_CID = (process.env.EXPECTED_BASE_CID || "").trim();
const DO_JSON_FALLBACK = process.env.FETCH_JSON_FALLBACK === "1";
const JSON_TIMEOUT_MS = parseInt(process.env.JSON_TIMEOUT_MS || "8000", 10);
const JSON_CONCURRENCY = Math.max(1, parseInt(process.env.JSON_CONCURRENCY || "8", 10));

if (!API_KEY) {
  console.error("ERROR: HELIUS_API_KEY fehlt");
  process.exit(1);
}
if (!COLLECTION) {
  console.error("ERROR: COLLECTION_MINT fehlt");
  process.exit(1);
}

const ENDPOINT = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function timeoutFetch(url, opts={}, ms=JSON_TIMEOUT_MS){
  return Promise.race([
    fetch(url, opts),
    new Promise((_,rej)=> setTimeout(()=>rej(new Error("Timeout")), ms))
  ]);
}

// ---------- Helius DAS ----------
async function getAssetsByGroup(cursor=null, limit=1000){
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAssetsByGroup",
    params: {
      groupKey: "collection",
      groupValue: COLLECTION,
      cursor,
      limit
    }
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Helius error: ${json.error?.message || json.error}`);
  return json.result; // { items, cursor, total, limit }
}

// ---------- Index-Heuristiken ----------
function parseIndexFromUri(uri){
  if (!uri) return null;
  const m = String(uri).match(/\/(\d+)\.json(?:\?.*)?$/i);
  return m ? parseInt(m[1],10) : null;
}
function parseIndexFromName(name){
  if (!name) return null;
  // z.B. "Pi Pyramide #1234" oder "Item 1234"
  const m = String(name).match(/#?(\d+)\b/);
  return m ? parseInt(m[1],10) : null;
}
function parseIndexFromAttributes(attrs){
  if (!Array.isArray(attrs)) return null;
  const keys = ["index","id","number","token_id","pi_index","digit","Digit","Index","ID"];
  for (const a of attrs){
    const key = (a?.trait_type || a?.traitType || a?.key || "").toLowerCase();
    let val = a?.value;
    if (keys.includes(key)) {
      const n = Number(String(val).replace(/[^\d]/g,""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// Fallback: JSON abrufen (falls Index noch unbekannt)
async function fetchIndexFromJson(uri){
  if (!uri) return null;
  try {
    const res = await timeoutFetch(uri, { headers: { "accept":"application/json" } }, JSON_TIMEOUT_MS);
    if (!res.ok) return null;
    const j = await res.json();
    // 1) filename kann schon index enthalten -> geschenkt
    let idx = null;
    if (j?.name) idx = parseIndexFromName(j.name);
    if (idx == null && Array.isArray(j?.attributes)) {
      idx = parseIndexFromAttributes(j.attributes);
    }
    return Number.isFinite(idx) ? idx : null;
  } catch { return null; }
}

function uriFromAsset(asset){
  // Helius DAS Felder haben sich ein wenig bewegt je nach Version.
  // Versuche mehrere Pfade robust:
  return asset?.content?.json_uri
      || asset?.content?.links?.json
      || asset?.content?.metadata?.uri
      || asset?.content?.metadata?.json_uri
      || asset?.content?.raw?.url
      || null;
}
function nameFromAsset(asset){
  return asset?.content?.metadata?.name || asset?.content?.metadata?.data?.name || null;
}
function attrsFromAsset(asset){
  return asset?.content?.metadata?.attributes || asset?.content?.metadata?.data?.attributes || null;
}

async function main(){
  const map = Object.create(null);
  let cursor = null;
  let page = 0;
  let total = 0;
  let fetched = 0;

  // Assets durchpagen
  do {
    page++;
    const r = await getAssetsByGroup(cursor, 1000);
    const items = r?.items || [];
    cursor = r?.cursor || null;
    total += items.length;

    // Erstversuch: ohne zusätzliche Requests
    const needJson = [];

    for (const a of items){
      const mint = a?.id;
      if (!mint) continue;

      const uri = uriFromAsset(a);
      const name = nameFromAsset(a);
      const attrs = attrsFromAsset(a);

      let idx = parseIndexFromUri(uri);
      if (idx == null) idx = parseIndexFromName(name);
      if (idx == null) idx = parseIndexFromAttributes(attrs);

      // Optional sanity: base CID check (wenn gesetzt)
      if (idx != null && EXPECTED_CID) {
        if (!String(uri||"").includes(EXPECTED_CID)) {
          // Index wirkt plausibel, aber URI gehört nicht zu deinem Base-CID – trotzdem akzeptieren,
          // nur als Hinweis loggen:
          // console.warn(`Warn: Index ${idx} kommt aus anderer CID: ${uri}`);
        }
      }

      if (idx == null && DO_JSON_FALLBACK && uri) {
        needJson.push({ mint, uri });
      } else if (idx != null) {
        if (map[idx] && map[idx] !== mint) {
          // Kollision (sollte nicht passieren)
          // Nimm die erste und melde
          // console.warn(`Index-Kollision ${idx}: ${map[idx]} vs ${mint}`);
        } else {
          map[idx] = mint;
          fetched++;
        }
      }
    }

    // Fallback: JSON wirklich laden (begrenzte Parallelität)
    if (needJson.length && DO_JSON_FALLBACK){
      let next = 0;
      async function worker(){
        while (next < needJson.length) {
          const j = needJson[next++];
          const idx = await fetchIndexFromJson(j.uri);
          if (idx != null) {
            if (!map[idx]) { map[idx] = j.mint; fetched++; }
          }
        }
      }
      const workers = Array.from({ length: JSON_CONCURRENCY }, () => worker());
      await Promise.all(workers);
    }

    // sanft throttlen
    await sleep(150);
  } while (cursor);

  // Sortierte Ausgabe
  const sortedKeys = Object.keys(map).map(Number).sort((a,b)=>a-b);
  const out = {};
  for (const k of sortedKeys) out[k] = map[k];

  // zu STDOUT
  process.stdout.write(JSON.stringify(out));

  // kurze Stats auf STDERR
  console.error(`\nFertig. ${fetched} Einträge gemappt (Assets gesamt: ${total}).`);
}

main().catch(err=>{
  console.error("FAIL:", err?.message || err);
  process.exit(1);
});