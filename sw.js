const SHELL_RELEASE = "poster-fix-2";
const CACHE_VERSION = "anime-tracker-v11-poster-fix-2";
const APP_CACHE_PREFIX = "anime-tracker-";
const APP_SCOPE = new URL("./", self.location.href);
const appUrl = path => new URL(path, APP_SCOPE).href;
const RELEASE_ASSETS = ["v11-core.js", "v11-ui.js", "v11-styles.css", "cross-media.js", "spotify-themes.js"];
const SHELL = ["./", "./index.html", "./vendor/opencc-js-1.4.1-full.js?v=1.4.1",
    ...RELEASE_ASSETS.map(file => `./${file}?v=${SHELL_RELEASE}`),
    "./spotify-config.js", "./manifest.webmanifest", "./icons/app-icon.svg"];
const SHELL_URLS = new Map(SHELL.map(path => {
    const href = appUrl(path);
    return [new URL(href).pathname, href];
}));
const HTML_PATHS = new Set([APP_SCOPE.pathname, new URL(appUrl("./index.html")).pathname]);

// SHA-256 of the release files, with CRLF line endings normalized to LF.
// The optional Spotify config is a deployment setting and has no release digest.
const SHELL_HASHES = {
    "index.html": "fd60233dff448f9538c360cb2f5f6b828e25a33f226f72be4696f1ba1b7c2993",
    "vendor/opencc-js-1.4.1-full.js": "f04e8f700d3a36b01a32bb0f051e6e5aff4b29dd1cb19f0787bb0c959abe36a8",
    "v11-core.js": "12d96acd29db0f10b05f0b53539a375fbaf72d39769bef067c02b3ac37154f8c",
    "v11-ui.js": "39c3da97a37d27ac5e2da2a9223ca727ac32555c5f9d612ef8f4ba29c9784dae",
    "v11-styles.css": "8adb744d039b17dcd0b3471bb046a74f66d18611fb16478f831ec43a349b6f6a",
    "cross-media.js": "66b4bfe2af853ed44ca197fb7bed94b291a4a6d0bc91a1cae6257621a9278688",
    "spotify-themes.js": "f06fd229b9828242385b084aae613a0e8c3008533897752f2926fae6032b047c",
    "manifest.webmanifest": "ae92ca0ebd465c39a48665d8d1a31458f7d99822e9ac291ba946f2636047d2ed",
    "icons/app-icon.svg": "662405018be573f4399086a2d0ac11c6f0193f852eb21a04b5e51cde4600c71a"
};

async function fetchShellAsset(path) {
    const request = new Request(appUrl(path), { cache:"no-store", redirect:"error" });
    const response = await fetch(request);
    if (response.status !== 200 || response.redirected) throw new Error(`Shell asset unavailable: ${path}`);
    const file = path === "./" ? "index.html" : path.slice(2).split("?")[0];
    const expected = SHELL_HASHES[file];
    if (expected) {
        const text = (await response.clone().text()).replace(/\r\n/g, "\n");
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
        if (actual !== expected) throw new Error(`Shell release mismatch: ${path}`);
    }
    return [request, response];
}

async function installShell() {
    // Read and validate the complete generation before touching its cache. An
    // interrupted write can only affect the inactive generation.
    const entries = await Promise.all(SHELL.map(fetchShellAsset));
    const cache = await caches.open(CACHE_VERSION);
    for (const [request, response] of entries) await cache.put(request, response);
}

function shellUnavailable() {
    return new Response("目前無法讀取完整的網站快取，請在連線後重新開啟。", {
        status:503, headers:{ "Content-Type":"text/plain; charset=utf-8" }
    });
}

async function serveShell(url, document = false) {
    try {
        const cache = await caches.open(CACHE_VERSION);
        if (document) {
            const present = await Promise.all(SHELL.map(path => cache.match(appUrl(path))));
            if (present.some(response => !response)) return shellUnavailable();
            return present[SHELL.findIndex(path => appUrl(path) === url)] || shellUnavailable();
        }
        return await cache.match(url) || shellUnavailable();
    } catch { return shellUnavailable(); }
}

// An installed update waits for old controlled documents to close so they
// cannot begin loading one release and finish loading another.
self.addEventListener("install", event => event.waitUntil(installShell()));
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
async function networkFirst(request, options, cacheKey = request) {
    try {
        const response = await fetch(request, options);
        if (!response.ok) throw new Error("網站資源暫時無法取得");
        return await cacheResponse(cacheKey, response);
    } catch (error) {
        const cached = await matchCurrentCache(cacheKey);
        if (cached) return cached;
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
        event.respondWith(networkFirst(event.request, { cache:"no-store" }, cacheKey.href));
        return;
    }
    if (url.origin !== self.location.origin) return;
    const shellUrl = SHELL_URLS.get(url.pathname);
    if (shellUrl) {
        const document = HTML_PATHS.has(url.pathname);
        event.respondWith(document || url.href === shellUrl
            ? serveShell(shellUrl, document) : Promise.resolve(shellUnavailable()));
        return;
    }
    if (event.request.mode === "navigate") {
        const atAppRoot = new URL("./", url).href === APP_SCOPE.href;
        event.respondWith(networkFirst(event.request, { cache:"no-store" }).catch(error => {
            if (atAppRoot) return serveShell(appUrl("./index.html"), true);
            throw error;
        }));
        return;
    }
    if (/\.(?:html|js|css)$/iu.test(url.pathname)) {
        event.respondWith(networkFirst(event.request, { cache:"no-store" }));
        return;
    }
    event.respondWith(matchCurrentCache(event.request).then(cached => cached
        || fetch(event.request).then(response => cacheResponse(event.request, response))));
});
