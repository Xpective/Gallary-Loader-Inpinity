const CACHE = "pillary-v2";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js"];

self.addEventListener("install", (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});

self.addEventListener("fetch", (e)=>{
  const url = new URL(e.request.url);

  // Niemals API über SW cachen
  if (url.pathname.startsWith("/pillary/api/")) return;

  // Startseite fallback
  if (url.pathname === "/pillary/" || url.pathname === "/pillary/index.html") {
    e.respondWith(fetch(e.request).catch(()=>caches.match("./index.html")));
    return;
  }

  // Thumbs cache-first
  if (url.pathname.includes("/pillary/api/thumb/")) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy));
        return res;
      }))
    ); return;
  }

  // Statische Assets cache-first
  if (/\.(css|js)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy));
        return res;
      }))
    ); return;
  }
});