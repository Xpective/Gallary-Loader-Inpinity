export interface Env {
  JSON_BASE_CID: string;
  IPFS_GATEWAYS: string;   // "https://cloudflare-ipfs.com,https://ipfs.io,..." (ohne Slash am Ende)
  COLLECTION_MINT: string;
  CREATOR: string;
  RPC: string;
  PAGES_HOST: string;
}

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
  const list = (env.IPFS_GATEWAYS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : ["https://cloudflare-ipfs.com","https://ipfs.io"];
}

function toHttpFromIpfs(gw: string, uri: string) {
  if (uri.startsWith("ipfs://")) return `${gw}/ipfs/${uri.slice("ipfs://".length)}`;
  return uri; // bereits http(s)
}

async function fetchWithCache(req: Request, maxAge = 3600) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok) {
    const res = new Response(resp.body, resp);
    res.headers.set("cache-control", `public, max-age=${maxAge}`);
    await cache.put(req, res.clone());
    return res;
  }
  return resp;
}

async function fetchJsonFromCid(env: Env, path: string) {
  for (const gw of gateways(env)) {
    const url = `${gw}/ipfs/${env.JSON_BASE_CID}/${path}`;
    const req = new Request(url, { cf: { cacheEverything: true } });
    const res = await fetchWithCache(req, 24*3600);
    if (res.ok) return res.json();
  }
  throw new Error("JSON not reachable");
}

function collectMediaCandidates(env: Env, meta: any) {
  const arr: string[] = [];
  const push = (v: any) => { if (!v) return; if (Array.isArray(v)) v.forEach(push); else arr.push(String(v)); };

  // gängige Felder zuerst
  push(meta.animation_url);
  push(meta.properties?.animation_url);
  // properties.files[].uri mit type video
  const files = meta.properties?.files;
  if (Array.isArray(files)) {
    files.forEach((f:any)=>{
      if (!f?.uri) return;
      if (!f?.type || /video|mp4|quicktime/i.test(String(f.type))) push(f.uri);
    });
  }
  // Fallbacks
  push(meta.image);
  push(meta.properties?.image);
  return Array.from(new Set(arr)); // uniq
}

async function proxyBinaryMulti(env: Env, uris: string[], accept: string|undefined, ttlSec = 86400) {
  const gws = gateways(env);
  const candidates: string[] = [];
  for (const uri of uris) for (const gw of gws) candidates.push(toHttpFromIpfs(gw, uri));

  // versuche nacheinander mit kleinem Backoff
  let attempt = 0;
  for (const url of candidates) {
    attempt++;
    try {
      const req = new Request(url, {
        headers: accept ? { accept } : {},
        cf: { cacheEverything: true, cacheTtl: ttlSec }
      });
      const res = await fetchWithCache(req, ttlSec);
      if (res.ok) {
        const out = new Response(res.body, res);
        out.headers.set("cache-control", `public, max-age=${ttlSec}`);
        Object.entries(CORS).forEach(([k,v]) => out.headers.set(k, v));
        // content-type korrigieren wenn leer
        if (!out.headers.get("content-type")) {
          if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) out.headers.set("content-type","video/mp4");
          if (/\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(url)) out.headers.set("content-type","image/*");
        }
        return out;
      }
    } catch {}
    // kurzer Backoff, um Gateway-Bursts zu entschärfen
    await new Promise(r=>setTimeout(r, Math.min(600, 80*attempt)));
  }
  return new Response("Upstream error", { status: 502, headers: CORS });
}

async function metaByIndex(env: Env, index: number) {
  const meta = await fetchJsonFromCid(env, `${index}.json`);
  const mint = meta.mint ?? meta.properties?.mint ?? null;
  const symbol = meta.symbol ?? meta.collection?.name ?? null;
  const links = mint ? {
    magicEdenItem: `https://magiceden.io/item-details/${mint}`,
    okxNftItem: `https://www.okx.com/web3/market/nft/sol/${mint}`,
    magicEdenCollection: symbol ? `https://magiceden.io/marketplace/${symbol}` : undefined,
  } : {};
  return { index, ...meta, links };
}

async function statusByIndex(env: Env, index: number) {
  try {
    const meta: any = await fetchJsonFromCid(env, `${index}.json`);
    const minted = Boolean(meta.mint);
    const verified = Boolean(meta.collection?.verified) || Boolean(meta.properties?.collection?.verified) || false;
    const listed = Boolean(meta.listed ?? false);
    return { index, minted, verified, listed };
  } catch {
    return { index, minted: false, verified: false, listed: false };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "OPTIONS") return ok({ ok: true });

    // Health & Config
    if (pathname.endsWith("/pillary/api/health")) return ok({ ok:true, time:Date.now() });
    if (pathname.endsWith("/pillary/api/config")) return ok({
      pages: env.PAGES_HOST, cid: env.JSON_BASE_CID, gateways: gateways(env)
    });

    // API: Meta / Status / Batches
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
      const jobs = Array.from({length: to-from+1}, (_,i)=> metaByIndex(env, from+i));
      return ok({ from, to, data: await Promise.all(jobs) });
    }

    // API: Video / Thumb (Multi-Gateway + Retry)
    if (/\/pillary\/api\/video\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      try {
        const meta = await metaByIndex(env, idx);
        const cands = collectMediaCandidates(env, meta);
        if (!cands.length) return notFound();
        return proxyBinaryMulti(env, cands, "video/*", 86400);
      } catch { return new Response("Upstream error", { status: 502, headers: CORS }); }
    }
    if (/\/pillary\/api\/thumb\/\d+$/.test(pathname)) {
      const idx = parseInt(pathname.split("/").pop()!);
      try {
        const meta = await metaByIndex(env, idx);
        // Bevorzugt image, aber fallbacks einschließen
        const imgs: string[] = [];
        if (meta.image) imgs.push(meta.image);
        if (meta.properties?.image) imgs.push(meta.properties.image);
        const files = meta.properties?.files;
        if (Array.isArray(files)) {
          files.forEach((f:any)=>{ if (f?.uri && /image|png|jpg|jpeg|gif|webp/i.test(String(f.type||""))) imgs.push(f.uri); });
        }
        // wenn leer: auf animation_url fallen (Standbild aus Video)
        if (imgs.length === 0 && (meta.animation_url || meta.properties?.animation_url)) {
          imgs.push(meta.animation_url || meta.properties.animation_url);
        }
        return imgs.length ? proxyBinaryMulti(env, imgs, "image/*", 86400) : notFound();
      } catch { return new Response("Upstream error", { status: 502, headers: CORS }); }
    }

    // API: Events (SSE)
    if (pathname.endsWith("/pillary/api/events")) {
      const stream = new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode("retry: 5000\n\n"));
          const iv = setInterval(()=>{
            const enc = new TextEncoder();
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

    // STATIC: /pillary* → Pages proxy (alles Nicht-API)
    if (pathname.startsWith("/pillary") && !pathname.startsWith("/pillary/api/")) {
      const host = env.PAGES_HOST || "gallary-loader-inpinity.pages.dev";
      const targetUrl = new URL(`https://${host}${pathname.replace(/^\/pillary/, "") || "/"}`);
      targetUrl.search = url.search;
      const resp = await fetch(targetUrl.toString(), { cf: { cacheEverything: true, cacheTtl: 300 }});
      const out = new Response(resp.body, resp);
      out.headers.set("cache-control", resp.headers.get("cache-control") || "public, max-age=300");
      Object.entries(CORS).forEach(([k,v]) => out.headers.set(k, v));
      return out;
    }

    return notFound();
  }
} satisfies ExportedHandler<Env>;