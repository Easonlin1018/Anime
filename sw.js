const CACHE_VERSION = "anime-tracker-v11-series-title-identity-1";
const SHELL = ["./", "./index.html", "./vendor/opencc-js-1.4.1-full.js?v=1.4.1", "./v11-core.js?v=series-title-identity-1", "./v11-ui.js?v=series-title-identity-1", "./v11-styles.css?v=duplicate-reconciliation-1", "./cross-media.js?v=anime-search-multi-1", "./spotify-config.js", "./spotify-themes.js?v=duplicate-reconciliation-1", "./manifest.webmanifest", "./icons/app-icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("message", event => {
    if (event.data?.type !== "GET_CACHE_STATUS") return;
    event.waitUntil(caches.keys().then(cacheNames => event.source?.postMessage({
        type:"ANIME_SW_CACHE_STATUS",
        cacheVersion:CACHE_VERSION,
        cacheNames
    })));
});
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
    const isVersionedShell = event.request.mode === "navigate" || /\.(?:html|js|css)$/iu.test(url.pathname);
    if (isVersionedShell) {
        event.respondWith(fetch(event.request, { cache:"no-store" }).then(response => {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
            return response;
        }).catch(async () => {
            const cached = await caches.match(event.request);
            if (cached) return cached;
            if (event.request.mode === "navigate") return caches.match("./index.html");
            throw new Error("離線快取中找不到此資源");
        }));
        return;
    }
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy)); return response; })));
});
