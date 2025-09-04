
const CACHE_NAME = "psv-conv-v2.7.4";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.v274.js",
  "./nlp.v274.js",
  "./manifest.json",
  "./icon-192x192.png",
  "./icon-512x512.png"
];

self.addEventListener("install", evt => {
  evt.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)));
});

self.addEventListener("activate", evt => {
  evt.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
  )));
});

self.addEventListener("fetch", evt => {
  evt.respondWith(
    caches.match(evt.request).then(res=> res || fetch(evt.request).then(fetchRes=>{
      const copy = fetchRes.clone();
      caches.open(CACHE_NAME).then(c=>c.put(evt.request, copy));
      return fetchRes;
    }).catch(()=> caches.match("./index.html")))
  );
});
