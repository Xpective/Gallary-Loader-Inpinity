/* Pillary SW v3 – robust & silent on errors */
const CACHE = "pillary-v3";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js"
];

// Hilfen
const isSameOrigin = (url) => new URL(url).origin === self.location.origin;
const isAPI = (url) => new URL(url).pathname.startsWith("/pillary/api/");

// Install: Precache Basis-Assets
self.addEventListener("install", (e)=>{
  e.waitUntil((async ()=>{
    const c = await caches.open(CACHE);
    try { await c.addAll(ASSETS); } catch(_) { /* ignore */ }
    await self.skipWaiting();
  })());
});

// Activate: alte Caches räumen
self.addEventListener("activate", (e)=>{
  e.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k === CACHE ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

// Fetch: nur GET, nur same-origin; API NIE cachen; Fehler abfangen
self.addEventListener("fetch", (e)=>{
  const req = e.request;

  // Nur GET behandeln
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin NICHT anfassen
  if (!isSameOrigin(url)) return;

  // API (inkl. /events, /thumb, /video) immer direkt ans Netz, ohne Cache
  if (isAPI(url)) {
    e.respondWith((async ()=>{
      try { return await fetch(req); }
      catch(_) { return new Response("API unavailable", { status: 502 }); }
    })());
    return;
  }

  // Navigations-Requests: network-first, Fallback Index aus Cache
  if (req.mode === "navigate") {
    e.respondWith((async ()=>{
      try {
        const net = await fetch(req);
        // Erfolgreich? Optional still revalidate in Cache
        const copy = net.clone();
        caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        return net;
      } catch(_) {
        const hit = await caches.match("./index.html");
        return hit || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Statische Assets & Thumbs: cache-first / stale-while-revalidate
  if (/\.(css|js|png|jpg|jpeg|gif|webp|ico)$/.test(url.pathname) ||
      url.pathname.includes("/pillary/api/thumb/")) {
    e.respondWith((async ()=>{
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) {
        // still revalidate
        fetch(req).then(res=>{
          if (res && res.ok) cache.put(req, res.clone());
        }).catch(()=>{});
        return hit;
      }
      try {
        const net = await fetch(req);
        if (net && net.ok) cache.put(req, net.clone());
        return net;
      } catch(_) {
        // Kein Netz + kein Cache → 404 still
        return new Response("Not available", { status: 404 });
      }
    })());
    return;
  }

  // Alles andere: network-first mit stillen Fehlern
  e.respondWith((async ()=>{
    try { return await fetch(req); }
    catch(_) {
      const hit = await caches.match(req);
      return hit || new Response("Unavailable", { status: 503 });
    }
  })());
});