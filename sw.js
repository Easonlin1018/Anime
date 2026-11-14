const SHELL_RELEASE = "legacy-series-1";
const CACHE_VERSION = "anime-tracker-v11-legacy-series-1";
const SHELL_CACHE_PREFIX = `${CACHE_VERSION}-shell-`;
const LEGACY_CACHE = "anime-tracker-v11-currently-watching-1";
const DATA_CACHE = "anime-tracker-runtime-v1";
const APP_SCOPE = new URL("./", self.location.href);
const appUrl = path => new URL(path, APP_SCOPE).href;
const releaseUrl = file => appUrl(`releases/${SHELL_RELEASE}/${file}`);
const HTML_PATHS = new Set([APP_SCOPE.pathname, new URL(appUrl("index.html")).pathname]);
const EVENTS_URL = appUrl("events.json");
const READY_URL = releaseUrl(".shell-ready");

// SHA-256 of the immutable UTF-8 release files, normalizing CRLF to LF.
const SHELL_HASHES = {
    "index.html": "fd78983bf326780a2c28cabccfd044420f5b64961195c9182d85dc80559de752",
    "vendor/opencc-js-1.4.1-full.js": "f04e8f700d3a36b01a32bb0f051e6e5aff4b29dd1cb19f0787bb0c959abe36a8",
    "v11-core.js": "1e5857430a594678354bb327e7279bfb40f586824465b9c40ddc0021083ca887",
    "v11-ui.js": "4cad40c9ef33ccd395c2efc6abf765441df26bbd1596073467052a906348c2f3",
    "v11-styles.css": "8adb744d039b17dcd0b3471bb046a74f66d18611fb16478f831ec43a349b6f6a",
    "cross-media.js": "43717652508d44b16d6b192c49c82acedd3530bad71f2bf611532dfcf127ea01",
    "spotify-themes.js": "2dd7675165a560fa08c8484aed89216ca4dcbe83d550baab19251f286f87c301"
};

const shellFiles = Object.keys(SHELL_HASHES);
const shellPaths = new Map(shellFiles.map(file => [new URL(releaseUrl(file)).pathname, file]));
const shellFingerprint = JSON.stringify(SHELL_HASHES);
const stablePaths = new Set(["manifest.webmanifest", "icons/app-icon.svg", "spotify-config.js", "sync-config.js",
    ...shellFiles.filter(file => file !== "index.html")].map(file => new URL(appUrl(file)).pathname));
let preparingRelease;

function hasExpectedType(file, response) {
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (file.endsWith(".html")) return type === "text/html";
    if (file.endsWith(".css")) return type === "text/css";
    return /^(?:application|text)\/(?:javascript|ecmascript)$/u.test(type || "");
}

async function fetchShellAsset(file) {
    const url = releaseUrl(file);
    const response = await fetch(new Request(url, { cache:"no-store", redirect:"error" }));
    if (response.status !== 200 || response.redirected || !hasExpectedType(file, response)) {
        throw new Error(`Shell asset unavailable: ${file}`);
    }
    const text = (await response.clone().text()).replace(/\r\n/g, "\n");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== SHELL_HASHES[file]) throw new Error(`Shell release mismatch: ${file}`);
    return [url, response];
}

async function findCompleteRelease() {
    const names = (await caches.keys()).filter(name => name.startsWith(SHELL_CACHE_PREFIX)).sort().reverse();
    for (const name of names) {
        const cache = await caches.open(name);
        const marker = await cache.match(READY_URL);
        if (!marker || await marker.text() !== shellFingerprint) continue;
        const files = await Promise.all(shellFiles.map(file => cache.match(releaseUrl(file))));
        if (files.every(Boolean)) return cache;
    }
    return null;
}

async function stageRelease() {
    // Keep the active cache untouched even when a fetch or Cache.put fails.
    const entries = await Promise.all(shellFiles.map(fetchShellAsset));
    const random = crypto.getRandomValues(new Uint32Array(2)).join("-");
    const name = `${SHELL_CACHE_PREFIX}${Date.now()}-${random}`;
    try {
        const cache = await caches.open(name);
        for (const [url, response] of entries) await cache.put(url, response);
        await cache.put(READY_URL, new Response(shellFingerprint));
        return cache;
    } catch (error) {
        await caches.delete(name).catch(() => {});
        throw error;
    }
}

function ensureRelease() {
    if (!preparingRelease) {
        preparingRelease = findCompleteRelease().then(cache => cache || stageRelease())
            .finally(() => { preparingRelease = undefined; });
    }
    return preparingRelease;
}

function shellUnavailable() {
    return new Response("目前無法讀取完整的網站快取，請在連線後重新開啟。", {
        status:503, headers:{ "Content-Type":"text/plain; charset=utf-8", "Cache-Control":"no-store" }
    });
}

async function serveRelease(file) {
    try {
        const cache = await ensureRelease();
        return await cache.match(releaseUrl(file)) || shellUnavailable();
    } catch { return shellUnavailable(); }
}

// Do not take over legacy documents before they close. The network still
// serves the complete legacy shell at its original paths while this waits.
self.addEventListener("install", event => event.waitUntil(ensureRelease()));

async function storageClientsAreSafe(sender) {
    try {
        if (!sender?.id) return false;
        const controlled = new Set((await self.clients.matchAll({ type:"window" })).map(client => client.id));
        if (!controlled.has(sender.id)) return false;
        const all = await self.clients.matchAll({ type:"window", includeUncontrolled:true });
        return all.every(client => {
            const url = new URL(client.url);
            return url.origin !== APP_SCOPE.origin || !url.pathname.startsWith(APP_SCOPE.pathname)
                || controlled.has(client.id);
        });
    } catch { return false; }
}

self.addEventListener("message", event => {
    if (event.data?.type === "CHECK_STORAGE_CLIENTS" && event.ports?.[0]) {
        event.waitUntil(storageClientsAreSafe(event.source).then(safe => event.ports[0].postMessage({
            type:"ANIME_SW_STORAGE_CLIENTS", release:SHELL_RELEASE, safe
        })));
        return;
    }
    if (event.data?.type !== "GET_CACHE_STATUS") return;
    event.waitUntil(caches.keys().then(cacheNames => event.source?.postMessage({
        type:"ANIME_SW_CACHE_STATUS", cacheVersion:CACHE_VERSION, cacheNames
    })));
});

async function matchData(cacheKey) {
    for (const name of [DATA_CACHE, LEGACY_CACHE]) {
        try {
            if (!await caches.has(name)) continue;
            const response = await (await caches.open(name)).match(cacheKey);
            if (response) return response;
        } catch {}
    }
    return undefined;
}

async function networkFirstData(request, cacheKey, events = false) {
    try {
        const response = await fetch(request, { cache:"no-store" });
        if (!response.ok) throw new Error("網站資源暫時無法取得");
        if (events) {
            const payload = await response.clone().json();
            if (!payload || typeof payload !== "object") throw new Error("活動資料格式無效");
        }
        try { await (await caches.open(DATA_CACHE)).put(cacheKey, response.clone()); }
        catch { /* Cache quota must not prevent a successful network response. */ }
        return response;
    } catch (error) {
        const cached = await matchData(cacheKey);
        if (cached) return cached;
        throw error;
    }
}

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    if (url.origin !== APP_SCOPE.origin || !url.pathname.startsWith(APP_SCOPE.pathname)) return;
    const navigation = event.request.mode === "navigate";
    if (navigation && HTML_PATHS.has(url.pathname)) {
        event.respondWith(serveRelease("index.html"));
        return;
    }
    const file = shellPaths.get(url.pathname);
    if (file) {
        // The app only runs at the canonical entry, keeping one manifest
        // identity and resolving legacy service URLs against the app root.
        if (file === "index.html" && navigation) event.respondWith(Response.redirect(APP_SCOPE.href));
        else event.respondWith(!navigation && url.href === releaseUrl(file)
            ? serveRelease(file) : Promise.resolve(shellUnavailable()));
        return;
    }
    if (url.pathname === new URL(EVENTS_URL).pathname) {
        const cacheKey = new URL(url);
        cacheKey.searchParams.delete("t");
        event.respondWith(networkFirstData(event.request, cacheKey.href, true));
        return;
    }
    if (!navigation && stablePaths.has(url.pathname)) {
        event.respondWith(networkFirstData(event.request, url.href));
    }
});
