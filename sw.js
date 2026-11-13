// Service worker: aplikacja otwiera się bez internetu.
// Pliki aplikacji: najpierw sieć (świeża wersja), przy braku sieci kopia z pamięci.
// Biblioteki i czcionki z CDN: kopia z pamięci, odświeżana w tle.
const VERSION = "tablica-v4";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "parser.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const CDN = [FB + "firebase-app.js", FB + "firebase-auth.js", FB + "firebase-firestore.js"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(CDN.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

const CDN_HOSTS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) ||
               (req.mode === "navigate" ? await c.match("index.html") : Response.error());
      }
    })());
    return;
  }

  // Firebase SDK (www.gstatic.com/firebasejs) i czcionki; ruch do bazy i logowania idzie bez zmian.
  if (CDN_HOSTS.includes(url.hostname) && (url.hostname !== "www.gstatic.com" || url.pathname.startsWith("/firebasejs/"))) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});
