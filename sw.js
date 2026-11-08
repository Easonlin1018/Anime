const CACHE_VERSION = "anime-tracker-v11-currently-watching-1";
const APP_CACHE_PREFIX = "anime-tracker-";
const SHELL = ["./", "./index.html", "./vendor/opencc-js-1.4.1-full.js?v=1.4.1", "./v11-core.js?v=currently-watching-1", "./v11-ui.js?v=currently-watching-1", "./v11-styles.css?v=currently-watching-1", "./cross-media.js?v=currently-watching-1", "./spotify-config.js", "./spotify-themes.js?v=currently-watching-1", "./manifest.webmanifest", "./icons/app-icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(SHELL.map(path => new Request(new URL(path, self.location.href), { cache:"no-store" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim())));
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
    return /(?:spotify\.com|scdn\.co|jikan\.moe|animethemes\.moe|itunes\.apple\.com|music\.apple\.com|supabase|workers\.dev|cloudflare|auth\/v1|rest\/v1)/i.test(url.href);
}
// Never fall back to another release's cache, or to another app's cache.
async function matchCurrentCache(request) {
    try { return await (await caches.open(CACHE_VERSION)).match(request); }
    catch { return undefined; }
}
async function cacheResponse(request, response) {
    if (response.ok) {
        try { await (await caches.open(CACHE_VERSION)).put(request, response.clone()); }
        catch { /* Cache quota must not prevent a successful network response. */ }
    }
    return response;
}
async function networkFirst(request, options, navigation = false, cacheKey = request) {
    try {
        const response = await fetch(request, options);
        if (!response.ok) throw new Error("網站資源暫時無法取得");
        return await cacheResponse(cacheKey, response);
    } catch (error) {
        const cached = await matchCurrentCache(cacheKey);
        if (cached) return cached;
        if (navigation) {
            const index = await matchCurrentCache(new URL("./index.html", self.location.href).href);
            if (index) return index;
        }
        throw error;
    }
}
self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    if (excluded(url)) return;
    if (url.pathname.endsWith("/events.json")) {
        // The app's timestamp bypasses HTTP caching, not its offline data copy.
        const cacheKey = new URL(url);
        cacheKey.searchParams.delete("t");
        event.respondWith(networkFirst(event.request, { cache:"no-store" }, false, cacheKey.href));
        return;
    }
    if (url.origin !== self.location.origin) return;
    const navigation = event.request.mode === "navigate";
    if (navigation || /\.(?:html|js|css)$/iu.test(url.pathname)) {
        event.respondWith(networkFirst(event.request, { cache:"no-store" }, navigation));
        return;
    }
    event.respondWith(matchCurrentCache(event.request).then(cached => cached
        || fetch(event.request).then(response => cacheResponse(event.request, response))));
});
