// tools/build-mint-map.mjs
import pLimit from "p-limit";
import fetch from "node-fetch";

// CONFIG
const JSON_BASE_CID = process.env.JSON_BASE_CID || "bafy...";   // << deine CID
const TOTAL = Number(process.env.TOTAL || 10000);               // 100x100
const GATEWAYS = (process.env.GW_LIST || "https://ipfs.inpinity.online,https://cloudflare-ipfs.com,https://ipfs.io")
  .split(",").map(s=>s.trim()).filter(Boolean);
const CONCURRENCY = Number(process.env.CONCURRENCY || 24);

const limit = pLimit(CONCURRENCY);

function urlFor(i){
  return GATEWAYS.map(gw => `${gw}/ipfs/${JSON_BASE_CID}/${i}.json`);
}

async function fetchJson(i){
  let lastErr = null;
  for (const u of urlFor(i)){
    try {
      const r = await fetch(u, { timeout: 12000 });
      if (r.ok) return await r.json();
    } catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("unreachable");
}

const out = {};
const jobs = Array.from({ length: TOTAL }, (_,i)=> limit(async ()=>{
  try {
    const j = await fetchJson(i);
    const mint = j.mint || j.properties?.mint || null;
    if (mint) out[i] = String(mint);
  } catch {}
}));

await Promise.all(jobs);
console.log(JSON.stringify(out)); // auf STDOUT