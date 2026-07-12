const CACHE_VERSION = "anime-tracker-v11-statistics-1";
const SHELL = ["./", "./index.html", "./v11-core.js", "./v11-ui.js", "./v11-styles.css", "./spotify-config.js", "./spotify-themes.js", "./manifest.webmanifest", "./icons/app-icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim())));
function excluded(url) {
    if (url.origin === self.location.origin) return /(?:spotify-worker|sync-api)/i.test(url.pathname);
    return /(?:spotify\.com|scdn\.co|jikan\.moe|supabase|workers\.dev|cloudflare|auth\/v1|rest\/v1)/i.test(url.href);
}
self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    if (excluded(url)) return;
    if (url.pathname.endsWith("/events.json")) {
        event.respondWith(fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy)); return response; }).catch(() => caches.match(event.request)));
        return;
    }
    if (url.origin !== self.location.origin) return;
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy)); return response; })));
});
