"use strict";

const cacheName = "anime-private-series-__REVISION__";
const documents = new Set(["/", "/index.html"]);
const files = [...documents, "/preview.css", "/preview.js", "/model.js", "/v11-core.js",
    "/vendor/opencc.js", "/manifest.webmanifest", "/icon.svg"];

async function fetchAsset(path, signal) {
    // The worker only ever sends fixed, credential-free asset requests.
    const response = await fetch(new Request(path, { cache:"no-store", redirect:"error", credentials:"omit", signal }));
    if (!response.ok || response.headers.get("X-Anime-Preview-Commit") !== "__REVISION__") {
        throw new Error("驗收資源版本不一致");
    }
    if (documents.has(path) && (response.headers.get("Content-Type") !== "text/html; charset=utf-8"
        || response.headers.get("Content-Disposition") !== "inline")) {
        throw new Error("驗收首頁不是可直接顯示的 HTML");
    }
    return response;
}

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(cacheName);
        // Read and cache each real HTTP response before requesting the next.
        // This preserves its URL and headers and avoids holding sockets open.
        try {
            for (const path of files) await cache.put(path, await fetchAsset(path));
        } catch (error) {
            await caches.delete(cacheName);
            throw error;
        }
    })());
});

self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

async function openDocument(path) {
    const request = new AbortController();
    const timer = setTimeout(() => request.abort(), 2500);
    try {
        return await fetchAsset(path, request.signal);
    } catch {
        return (await caches.open(cacheName)).match(path);
    } finally {
        clearTimeout(timer);
    }
}

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    const path = url.pathname;
    event.respondWith((async () => {
        if (event.request.method !== "GET" || url.origin !== self.location.origin || url.search || !files.includes(path)) {
            return new Response("", { status:403 });
        }
        const response = event.request.mode === "navigate" && documents.has(path)
            ? await openDocument(path)
            : await (await caches.open(cacheName)).match(path);
        return response || new Response("請連線後在一般 Safari 開啟驗收頁。", {
            status:503, headers:{ "Content-Type":"text/plain; charset=utf-8" }
        });
    })());
});
