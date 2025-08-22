const CACHE = "pillary-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js"];

self.addEventListener("install", (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});

self.addEventListener("fetch", (e)=>{
  const url = new URL(e.request.url);
  if (url.pathname.endsWith("/pillary/") || url.pathname.endsWith("/pillary/index.html")) {
    e.respondWith(fetch(e.request).catch(()=>caches.match("./index.html")));
    return;
  }
  if (/\.(css|js)$/.test(url.pathname) || url.pathname.includes("/pillary/api/thumb/")) {
    e.respondWith(
      caches.match(e.request).then((hit)=> hit || fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy));
        return res;
      }))
    );
  }
});
