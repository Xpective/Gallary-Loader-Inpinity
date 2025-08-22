export interface Env {
  JSON_BASE_CID: string;
  IPFS_GATEWAYS: string;
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
  return (env.IPFS_GATEWAYS || "").split(",").map(s => s.trim()).filter(Boolean);
}

// Proxy mit Fallback
async function proxyWithFallback(env: Env, path: string, accept?: string, maxAgeSec=86400) {
  for (const gw of gateways(env)) {
    try {
      const url = path.startsWith("http") ? path : `${gw}/ipfs/${path}`;
      const req = new Request(url, { headers: accept ? { accept } : {}, cf: { cacheEverything: true } });
      const res = await fetch(req);
      if (res.ok) {
        const out = new Response(res.body, res);
        out.headers.set("cache-control", `public, max-age=${maxAgeSec}`);
        Object.entries(CORS).forEach(([k,v]) => out.headers.set(k, v));
        return out;
      }
    } catch {}
  }
  return new Response("Upstream error", { status: 502, headers: CORS });
}

async function fetchJsonFromCid(env: Env, path: string) {
  for (const gw of gateways(env)) {
    try {
      const url = `${gw}/ipfs/${env.JSON_BASE_CID}/${path}`;
      const res = await fetch(url, { cf: { cacheEverything: true } });
      if (res.ok) return res.json();
    } catch {}
  }
  throw new Error("JSON not reachable");
}

function resolveIpfsUrl(env: Env, uri?: string|null) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const p = uri.replace("ipfs://", "");
    return `${gateways(env)[0]}/ipfs/${p}`;
  }
  return uri;
}

async function metaByIndex(env: Env, index: number) {
  const meta = await fetchJsonFromCid(env, `${index}.json`);
  const mint = meta.mint ?? null;
  const symbol = meta.symbol ?? meta.collection?.name ?? "InPi";

  const links = mint ? {
    magicEdenItem: `https://magiceden.io/item-details/${mint}`,
    okxNftItem: `https://www.okx.com/web3/market/nft/sol/${mint}`,
    solscan: `https://solscan.io/token/${mint}`,
    collection: `https://magiceden.io/marketplace/${symbol}`,
    creator: `https://solscan.io/account/${env.CREATOR}`,
  } : {};

  return {
    index,
    ...meta,
    collectionInfo: {
      address: env.COLLECTION_MINT,
      creator: env.CREATOR,
      utility: "Zugang zu zukünftigen Inpinity Tokenomics, Premints & Farmverse Game",
    },
    links
  };
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

function sse(controller: ReadableStreamDefaultController, data: any) {
  const enc = new TextEncoder();
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "OPTIONS") return ok({ ok: true });

    // --- API ROUTES ---
    if (pathname.startsWith("/pillary/api/")) {
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

      if (/\/pillary\/api\/video\/\d+$/.test(pathname)) {
        const idx = parseInt(pathname.split("/").pop()!);
        const meta: any = await metaByIndex(env, idx);
        const url = resolveIpfsUrl(env, meta.animation_url || meta.image);
        if (!url) return notFound();
        return proxyWithFallback(env, url, "video/*");
      }

      if (/\/pillary\/api\/thumb\/\d+$/.test(pathname)) {
        const idx = parseInt(pathname.split("/").pop()!);
        const meta: any = await metaByIndex(env, idx);
        const url = resolveIpfsUrl(env, meta.image || meta.animation_url);
        if (!url) return notFound();
        return proxyWithFallback(env, url, "image/*");
      }

      if (pathname.endsWith("/pillary/api/events")) {
        const stream = new ReadableStream({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode("retry: 5000\n\n"));
            const iv = setInterval(()=> sse(controller, { t: Date.now(), type: "heartbeat" }), 15000);
            (controller as any)._iv = iv;
          },
          cancel: (reason) => {
            clearInterval((reason as any)?._iv);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS },
        });
      }

      return notFound();
    }

    // --- STATIC (Pages Proxy) ---
    if (pathname.startsWith("/pillary")) {
      const host = env.PAGES_HOST || "gallary-loader-inpinity.pages.dev";
      const targetUrl = new URL(`https://${host}${pathname.replace(/^\/pillary/, "") || "/"}`);
      targetUrl.search = url.search;
      const resp = await fetch(targetUrl.toString(), { cf: { cacheEverything: true }});
      return new Response(resp.body, resp);
    }

    return notFound();
  }
} satisfies ExportedHandler<Env>;