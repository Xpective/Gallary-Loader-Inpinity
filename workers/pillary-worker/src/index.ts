export interface Env {
  JSON_BASE_CID: string;
  IPFS_GATEWAYS: string;
  COLLECTION_MINT: string;
  CREATOR: string;
  RPC: string;
  PAGES_HOST: string;

  // Collection Meta (optional)
  COLLECTION_NAME?: string;
  COLLECTION_SYMBOL?: string;
  COLLECTION_DESCRIPTION?: string;
  COLLECTION_CHAIN?: string;
  COLLECTION_STANDARD?: string;
  ME_COLLECTION_SLUG?: string;
  COLLECTION_CERT_URL?: string;
  OKX_TOKEN_URL?: string;

  // Video CIDs (optional je Qualität)
  VIDEO_BASE_CID_LOW?: string;
  VIDEO_BASE_CID_MED?: string;
  VIDEO_BASE_CID_HIGH?: string;

  // Optionales R2-Binding (für Video-Mirror + mint-map.json + sales-24h.json)
  R2?: R2Bucket;
}

// (Workers hat R2Bucket-Typ, hier nur zur Sicherheit)
type R2Bucket = {
  get(key: string, opts?: any): Promise<any>;
  put(key: string, value: any, opts?: any): Promise<any>;
  head?(key: string): Promise<any>;
};

/* -------------------- CORS/Helpers -------------------- */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const ok = (data: unknown, headers: Record<string,string> = {}) =>
  new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
      ...CORS, ...headers
    }
  });
const notFound = () => new Response("Not found", { status: 404, headers: CORS });

function gateways(env: Env) {
  const list = (env.IPFS_GATEWAYS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list
    : ["https://ipfs.inpinity.online","https://cloudflare-ipfs.com","https://ipfs.io"];
}
function toHttpFromIpfs(gw: string, uri: string) {
  if (uri?.startsWith?.("ipfs://")) return `${gw}/ipfs/${uri.slice("ipfs://".length)}`;
  return uri;
}

async function fetchWithCache(req: Request, maxAge = 3600) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;

  const resp = await fetch(req, {
    cf: {
      cacheEverything: true,
      cacheTtl: maxAge,
      cacheTtlByStatus: { "200-299": maxAge, "404": 60, "500-599": 5 }
    }
  });

  if (resp.ok) {
    const res = new Response(resp.body, resp);
    res.headers.set("cache-control", `public, max-age=${maxAge}, stale-while-revalidate=86400`);
    await cache.put(req, res.clone());
    return res;
  }
  return resp;
}

/* -------------------- R2 JSON-Maps (mint/sales) -------------------- */
const MINT_MAP_KEYS = ["mint-map.json", "pillaries/mint-map.json"];
const SALES_24H_KEYS = ["sales-24h.json", "pillaries/sales-24h.json"];

type MintMap = Record<string,string>;      // index(string) -> mint
type SalesMap = Record<string, number|1>;  // mint -> unix_ms oder 1

let mintMapMem: { data: MintMap, ts: number } | null = null;
let salesMapMem: { data: SalesMap, ts: number } | null = null;

const MINT_MAP_TTL_MS  = 15*60*1000; // 15 Min.
const SALES_MAP_TTL_MS =  5*60*1000; // 5 Min.

async function r2GetText(env: Env, keys: string[]): Promise<string|null> {
  if (!env.R2) return null;
  for (const key of keys) {
    try {
      const obj = await env.R2.get(key);
      if (obj) {
        // R2ObjectBody hat text(); fallback arrayBuffer
        if (typeof obj.text === "function") return await obj.text();
        const buf = await obj.arrayBuffer();
        return new TextDecoder().decode(new Uint8Array(buf));
      }
    } catch {}
  }
  return null;
}
async function loadMintMap(env: Env): Promise<MintMap> {
  if (mintMapMem && (Date.now()-mintMapMem.ts) < MINT_MAP_TTL_MS) return mintMapMem.data;
  try {
    const txt = await r2GetText(env, MINT_MAP_KEYS);
    const parsed = txt ? JSON.parse(txt) as MintMap : {};
    mintMapMem = { data: parsed, ts: Date.now() };
    return parsed;
  } catch { mintMapMem = { data: {}, ts: Date.now() }; return mintMapMem.data; }
}
async function loadSalesMap(env: Env): Promise<SalesMap> {
  if (salesMapMem && (Date.now()-salesMapMem.ts) < SALES_MAP_TTL_MS) return salesMapMem.data;
  try {
    const txt = await r2GetText(env, SALES_24H_KEYS);
    const parsed = txt ? JSON.parse(txt) as SalesMap : {};
    salesMapMem = { data: parsed, ts: Date.now() };
    return parsed;
  } catch { salesMapMem = { data: {}, ts: Date.now() }; return salesMapMem.data; }
}
function isSold24h(salesMap: SalesMap, mint: string|undefined|null): boolean {
  if (!mint) return false;
  const v = salesMap[mint];
  if (v == null) return false;
  if (v === 1) return true;
  if (typeof v === "number") {
    const cutoff = Date.now() - 24*60*60*1000;
    return v >= cutoff;
  }
  return false;
}

/* -------------------- JSON & Media -------------------- */
async function fetchJsonFromCid(env: Env, path: string) {
  let lastErr: any = null;
  for (const gw of gateways(env)) {
    const url = `${gw}/ipfs/${env.JSON_BASE_CID}/${path}`;
    try {
      const req = new Request(url, { cf: { cacheEverything: true } });
      const res = await fetchWithCache(req, 24*3600);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e:any) { lastErr = e; }
  }
  throw lastErr || new Error("JSON not reachable");
}

function pickVideoCidsByQ(env: Env, q: string|undefined) {
  const tier = (q||"med").toLowerCase();
  const order = tier === "low" ? ["VIDEO_BASE_CID_LOW","VIDEO_BASE_CID_MED","VIDEO_BASE_CID_HIGH"]
              : tier === "high"? ["VIDEO_BASE_CID_HIGH","VIDEO_BASE_CID_MED","VIDEO_BASE_CID_LOW"]
                               : ["VIDEO_BASE_CID_MED","VIDEO_BASE_CID_HIGH","VIDEO_BASE_CID_LOW"];
  const list: string[] = [];
  for (const k of order) {
    const v = (env as any)[k];
    if (v && String(v).trim()) list.push(String(v).trim());
  }
  return list;
}

function collectMediaCandidates(env: Env, meta: any, index?: number, q?: string) {
  const arr: string[] = [];
  const push = (v: any) => { if (!v) return; if (Array.isArray(v)) v.forEach(push); else arr.push(String(v)); };

  // 1) Priorisierte Video-Ordner nach Qualität
  if (Number.isFinite(index)) {
    const cids = pickVideoCidsByQ(env, q);
    for (const gw of gateways(env)) for (const cid of cids) arr.push(`${gw}/ipfs/${cid}/${index}.mp4`);
  }

  // 2) Standardfelder aus Metadata
  push(meta.animation_url);
  push(meta.properties?.animation_url);
  const files = meta.properties?.files;
  if (Array.isArray(files)) {
    files.forEach((f:any)=>{
      if (!f?.uri) return;
      if (!f?.type || /video|mp4|quicktime|webm/i.test(String(f.type))) push(f.uri);
    });
  }

  // 3) Fallback: images
  push(meta.image);
  push(meta.properties?.image);
  return Array.from(new Set(arr));
}

/* -------------------- Meta & Status -------------------- */
function getTier(meta: any): string | null {
  const attrs = Array.isArray(meta?.attributes) ? meta.attributes : [];
  const tierAttr = attrs.find((a:any)=> (a?.trait_type||"").toLowerCase() === "tier");
  const t = tierAttr?.value ?? meta?.tier ?? null;
  return t ? String(t).toLowerCase() : null; // "legendary" | "epic" | "rare" | ...
}

async function metaByIndex(env: Env, index: number) {
  const meta = await fetchJsonFromCid(env, `${index}.json`);

  // Mint aus JSON oder aus mint-map ergänzen
  const map = await loadMintMap(env);
  const mint = meta.mint ?? meta.properties?.mint ?? map?.[String(index)] ?? null;

  const symbol = meta.symbol ?? meta.collection?.name ?? env.COLLECTION_SYMBOL ?? null;
  const meSlug = (env.ME_COLLECTION_SLUG || symbol || "inpi")?.toString().trim().toLowerCase();

  const links = mint ? {
    magicEdenItem: `https://magiceden.io/item-details/${mint}`,
    okxNftItem:    `https://www.okx.com/web3/market/nft/sol/${mint}`,
    magicEdenCollection: `https://magiceden.io/marketplace/${meSlug}`
  } : {
    magicEdenCollection: `https://magiceden.io/marketplace/${meSlug}`
  };

  return { index, ...meta, mint, links };
}
async function metaByIndexSafe(env: Env, index: number) {
  try { return await metaByIndex(env, index); }
  catch (e:any) { return { index, error: String(e?.message || e) }; }
}

async function statusByIndex(env: Env, index: number) {
  try {
    const meta: any = await fetchJsonFromCid(env, `${index}.json`);
    const map = await loadMintMap(env);
    const sales = await loadSalesMap(env);

    const mint = meta.mint ?? meta.properties?.mint ?? map?.[String(index)] ?? null;
    const minted = Boolean(mint);
    const verified = Boolean(meta.collection?.verified) || Boolean(meta.properties?.collection?.verified) || false;

    const listed = Boolean(meta.listed ?? false);
    // "market" wenn vorhanden übernehmen, sonst heuristisch:
    const market = minted ? (meta.market ?? (listed ? "unknown" : "none")) : "none";

    const tier = getTier(meta);
    const sold24h = isSold24h(sales, mint);

    return { index, minted, mint: mint || null, verified, listed, market, tier, sold24h };
  } catch {
    const map = await loadMintMap(env);
    const sales = await loadSalesMap(env);
    const mint = map?.[String(index)] ?? null;
    const sold24h = isSold24h(sales, mint);
    return { index, minted: Boolean(mint), mint: mint || null, verified: false, listed: false, market: "none", tier: null, sold24h };
  }
}

/* -------------------- Media Proxy inkl. R2 Mirror -------------------- */
async function proxyBinaryMulti(
  env: Env,
  uris: string[],
  accept: string|undefined,
  ttlSec = 86400,
  clientHeaders?: Headers
) {
  const gws = gateways(env);
  const candidates: string[] = [];
  for (const uri of uris) for (const gw of gws) candidates.push(toHttpFromIpfs(gw, uri));

  let attempt = 0;
  for (const url of candidates) {
    attempt++;
    try {
      const h = new Headers();
      if (accept) h.set("accept", accept);
      if (clientHeaders) {
        for (const k of ["range","if-none-match","if-modified-since"]) {
          const v = clientHeaders.get(k);
          if (v) h.set(k, v);
        }
      }
      const req = new Request(url, { headers: h, cf: { cacheEverything: true, cacheTtl: ttlSec } });
      const res = await fetchWithCache(req, ttlSec);
      if (res.ok || res.status === 206 || res.status === 304) {
        const out = new Response(res.body, res);
        out.headers.set("cache-control", `public, max-age=${ttlSec}, stale-while-revalidate=86400`);
        out.headers.set("vary", "Accept, Range");
        Object.entries(CORS).forEach(([k,v]) => out.headers.set(k, v));
        if (!out.headers.get("content-type")) {
          if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) out.headers.set("content-type","video/mp4");
          if (/\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(url)) out.headers.set("content-type","image/*");
        }
        return out;
      }
    } catch {}
    await new Promise(r=>setTimeout(r, Math.min(600, 80*attempt)));
  }
  return new Response("Upstream error", { status: 502, headers: CORS });
}

async function serveVideoWithR2(env: Env, index: number, q: string|undefined, clientHeaders: Headers) {
  const useR2 = !!env.R2;
  const r2Key = `video/${q||"med"}/${index}.mp4`;
  const range = clientHeaders.get("range");
  const wantsRange = !!range && /^bytes=\d*-\d*(,\d*-\d*)*$/.test(range);

  if (useR2) {
    const obj = await env.R2!.get(r2Key, wantsRange ? { range } : undefined);
    if (obj) {
      const size = obj.size ?? (obj.httpMetadata?.contentLength as number | undefined);
      const headers: Record<string,string> = {
        "accept-ranges": "bytes",
        "content-type": obj.httpMetadata?.contentType || "video/mp4",
        ...CORS
      };

      if (wantsRange && obj.range) {
        const { offset, length } = obj.range;
        const end = offset + length - 1;
        headers["content-range"] = `bytes ${offset}-${end}/${size ?? "*"}`;
        headers["content-length"] = String(length);
        return new Response(obj.body, { status: 206, headers });
      } else {
        if (size) headers["content-length"] = String(size);
        return new Response(obj.body, { status: 200, headers });
      }
    }
  }

  const meta = await metaByIndex(env, index);
  const cands = collectMediaCandidates(env, meta, index, q);
  const upstream = await proxyBinaryMulti(env, cands, "video/*", 86400, clientHeaders);

  if ((upstream.ok || upstream.status === 206) && useR2) {
    const clone = upstream.clone();
    clone.arrayBuffer().then(buf => {
      env.R2!.put(r2Key, buf, {
        httpMetadata: { contentType: clone.headers.get("content-type") || "video/mp4" }
      }).catch(()=>{});
    }).catch(()=>{});
  }
  return upstream;
}

/* -------------------- Handler -------------------- */
export default {
  // Cron: prewarm + Maps cachen
  async scheduled(_event: any, env: Env, _ctx: ExecutionContext) {
    await Promise.allSettled([
      loadMintMap(env),
      loadSalesMap(env),
    ]);

    const preRows = 12;
    const jobs: Promise<any>[] = [];
    for (let row=0; row<preRows; row++) {
      const cols = 2*row+1;
      const start = row*row;
      const end = start + cols - 1;
      for (let i=start; i<=end; i++) {
        jobs.push(fetch(`https://${env.PAGES_HOST}/pillary/api/meta/${i}`));
        jobs.push(fetch(`https://${env.PAGES_HOST}/pillary/api/thumb/${i}`, { method:"HEAD" }));
        jobs.push(fetch(`https://${env.PAGES_HOST}/pillary/api/video/${i}?q=med`, { method:"HEAD", headers:{ range:"bytes=0-0" }}));
      }
    }
    await Promise.allSettled(jobs);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "OPTIONS") return ok({ ok: true });

    /* ---- Health & Config ---- */
    if (pathname.endsWith("/pillary/api/health")) return ok({ ok:true, time:Date.now() });
    if (pathname.endsWith("/pillary/api/config")) {
      const meSlug = (env.ME_COLLECTION_SLUG || env.COLLECTION_SYMBOL || "inpi").toString().trim().toLowerCase();
      const [mints, sales] = await Promise.all([loadMintMap(env), loadSalesMap(env)]).catch(()=>[{},{}] as any);
      return ok({
        pages: env.PAGES_HOST,
        cid: env.JSON_BASE_CID,
        gateways: gateways(env),
        mintMapCount: Object.keys(mints||{}).length,
        sales24hCount: Object.keys(sales||{}).length,
        collection: {
          name: env.COLLECTION_NAME || "Pi Pyramide",
          symbol: (env.COLLECTION_SYMBOL || "inpi").toLowerCase(),
          description: env.COLLECTION_DESCRIPTION || "10000 Pi Pyramid blocks",
          chain: env.COLLECTION_CHAIN || "solana",
          standard: env.COLLECTION_STANDARD || "nft",
          mint: env.COLLECTION_MINT || null,
          certUrl: env.COLLECTION_CERT_URL || "",
          meCollectionUrl: `https://magiceden.io/marketplace/${meSlug}`,
          okxTokenUrl: env.OKX_TOKEN_URL || ""
        },
        video: {
          low:  !!(env.VIDEO_BASE_CID_LOW && env.VIDEO_BASE_CID_LOW.trim()),
          med:  !!(env.VIDEO_BASE_CID_MED && env.VIDEO_BASE_CID_MED.trim()),
          high: !!(env.VIDEO_BASE_CID_HIGH && env.VIDEO_BASE_CID_HIGH.trim()),
        }
      });
    }

    /* ---- Mint-/Sales-Map Debug ---- */
    if (/\/pillary\/api\/minted\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      const map = await loadMintMap(env);
      const mint = map?.[String(idx)] ?? null;
      return ok({ index: idx, minted: !!mint, mint });
    }
    if (pathname.endsWith("/pillary/api/mints/count")) {
      const map = await loadMintMap(env);
      return ok({ count: Object.keys(map).length });
    }
    if (pathname.endsWith("/pillary/api/mints/reload")) {
      mintMapMem = null;
      const map = await loadMintMap(env);
      return ok({ reloaded: true, count: Object.keys(map).length }, { "cache-control": "no-store" });
    }
    if (pathname.endsWith("/pillary/api/sales/count")) {
      const sales = await loadSalesMap(env);
      return ok({ count: Object.keys(sales).length });
    }
    if (pathname.endsWith("/pillary/api/sales/reload")) {
      salesMapMem = null;
      const sales = await loadSalesMap(env);
      return ok({ reloaded: true, count: Object.keys(sales).length }, { "cache-control": "no-store" });
    }

    /* ---- Meta / Status / Batch ---- */
    if (/\/pillary\/api\/meta\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      try { return ok(await metaByIndex(env, idx)); }
      catch (e:any) { return ok({ error: e.message }, { "cache-control": "no-store" }); }
    }
    if (/\/pillary\/api\/status\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      return ok(await statusByIndex(env, idx));
    }
    if (pathname.endsWith("/pillary/api/batch/status")) {
      const from = parseInt(searchParams.get("from") ?? "0");
      const to   = parseInt(searchParams.get("to") ?? "299");
      const jobs = Array.from({length: to-from+1}, (_,i)=> statusByIndex(env, from+i));
      return ok({ from, to, data: await Promise.all(jobs) });
    }
    if (pathname.endsWith("/pillary/api/batch/meta")) {
      const from = parseInt(searchParams.get("from") ?? "0");
      const to   = parseInt(searchParams.get("to") ?? "49");
      const jobs = Array.from({length: to-from+1}, (_,i)=> metaByIndexSafe(env, from+i));
      return ok({ from, to, data: await Promise.all(jobs) });
    }

    /* ---- Video ---- */
    if (/\/pillary\/api\/video\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      const q = searchParams.get("q") || "med";
      try { return await serveVideoWithR2(env, idx, q, request.headers); }
      catch {
        try {
          const meta = await metaByIndex(env, idx);
          const cands = collectMediaCandidates(env, meta, idx, q);
          return proxyBinaryMulti(env, cands, "video/*", 86400, request.headers);
        } catch { return new Response("Upstream error", { status: 502, headers: CORS }); }
      }
    }

    /* ---- Thumb ---- */
    if (/\/pillary\/api\/thumb\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      try {
        const meta = await metaByIndex(env, idx);
        const imgs: string[] = [];
        if (meta.image) imgs.push(meta.image);
        if (meta.properties?.image) imgs.push(meta.properties.image);
        const files = meta.properties?.files;
        if (Array.isArray(files)) {
          files.forEach((f:any)=>{ if (f?.uri && /image|png|jpg|jpeg|gif|webp/i.test(String(f.type||""))) imgs.push(f.uri); });
        }
        if (imgs.length === 0 && (meta.animation_url || meta.properties?.animation_url)) {
          imgs.push(meta.animation_url || meta.properties.animation_url);
        }
        return imgs.length ? proxyBinaryMulti(env, imgs, "image/*", 86400, request.headers) : notFound();
      } catch { return new Response("Upstream error", { status: 502, headers: CORS }); }
    }

    /* ---- SSE Heartbeat ---- */
    if (pathname.endsWith("/pillary/api/events")) {
      const stream = new ReadableStream({
        start: (controller) => {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode("retry: 5000\n\n"));
          const iv = setInterval(()=>{
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ t: Date.now(), type: "heartbeat" })}\n\n`));
          }, 15000);
          (controller as any)._iv = iv;
        },
        cancel: (reason) => {
          const iv = (reason as any)?._iv;
          if (iv) clearInterval(iv);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS },
      });
    }

    // STATIC: /pillary* → Pages proxy (Default-Root = /apps)
if (pathname.startsWith("/pillary") && !pathname.startsWith("/pillary/api/")) {
  const host = env.PAGES_HOST || "gallary-loader-inpinity.pages.dev";

  // 1) /pillary → /apps (ohne Redirect, transparentes Rewrite)
  let sub = pathname.replace(/^\/pillary/, "");
  if (sub === "" || sub === "/") sub = "/apps";

  const targetUrl = new URL(`https://${host}${sub}`);
  targetUrl.search = url.search;

  let resp = await fetch(targetUrl.toString(), { cf: { cacheEverything: true, cacheTtl: 300 }});

  // 2) SPA-/Build-Fallback: Wenn 404, erneut "/apps" laden
  if (resp.status === 404) {
    const fallback = new URL(`https://${host}/apps`);
    fallback.search = url.search;
    resp = await fetch(fallback.toString(), { cf: { cacheEverything: true, cacheTtl: 300 }});
  }

  const out = new Response(resp.body, resp);
  out.headers.set("cache-control", resp.headers.get("cache-control") || "public, max-age=300");
  Object.entries(CORS).forEach(([k,v]) => out.headers.set(k, v));
  return out;
}

    return notFound();
  }
} satisfies ExportedHandler<Env>;