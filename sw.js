// Service worker: aplikacja otwiera się bez internetu.
// Pliki aplikacji: najpierw sieć (świeża wersja), przy braku sieci kopia z pamięci.
// Biblioteki i czcionki z CDN: kopia z pamięci, odświeżana w tle.
const VERSION = "tablica-v59";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "parser.js", "words.js", "config.js", "manifest.webmanifest",
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
    // nagrania lektora („tablica-tts”) zostają przy aktualizacjach aplikacji
    for (const k of await caches.keys()) if (k !== VERSION && k !== "tablica-tts") await caches.delete(k);
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
        // świeża wersja z serwera (z pominięciem pamięci przeglądarki); budujemy nowe żądanie,
        // bo Safari nie pozwala kopiować żądań nawigacji z dodatkowymi opcjami
        const res = await fetch(url.href, { cache: "no-cache", credentials: "same-origin" });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) ||
               (req.mode === "navigate" ? (await c.match("index.html")) || (await c.match("./")) : null) ||
               Response.error();
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

// „Odśwież aplikację”: pobierz WSZYSTKIE pliki aplikacji na nowo i dopiero gdy każdy się udał, podmień kopię.
// Jeśli choć jeden się nie pobierze, stara (działająca) kopia zostaje nietknięta.
self.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "refresh") return;
  const port = e.ports && e.ports[0];
  e.waitUntil((async () => {
    try {
      const fresh = await Promise.all(SHELL.map(async (p) => {
        const r = await fetch(new URL(p, self.registration.scope).href, { cache: "reload" });
        if (!r.ok) throw new Error(p + " " + r.status);
        return [p, r];
      }));
      const c = await caches.open(VERSION);
      await Promise.all(fresh.map(([p, r]) => c.put(new URL(p, self.registration.scope).href, r)));
      port && port.postMessage({ ok: true });
    } catch (err) { port && port.postMessage({ ok: false, error: String(err && err.message || err) }); }
  })());
});
