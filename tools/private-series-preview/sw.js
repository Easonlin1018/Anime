"use strict";

const cacheName = "anime-private-series-__REVISION__";
const files = ["/", "/preview.css", "/preview.js", "/model.js", "/v11-core.js",
    "/vendor/opencc.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const responses = await Promise.all(files.map(async path => {
            const response = await fetch(new Request(path, { cache:"no-store", redirect:"error" }));
            if (!response.ok || response.headers.get("X-Anime-Preview-Commit") !== "__REVISION__") {
                throw new Error("驗收資源版本不一致");
            }
            return new Response(await response.arrayBuffer(), {
                headers:{ "Content-Type":response.headers.get("Content-Type"),
                    "Content-Security-Policy":response.headers.get("Content-Security-Policy"),
                    "X-Anime-Preview-Commit":"__REVISION__", "Referrer-Policy":"no-referrer",
                    "X-Content-Type-Options":"nosniff" }
            });
        }));
        const cache = await caches.open(cacheName);
        await Promise.all(responses.map((response, index) => cache.put(files[index], response)));
    })());
});

self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    const path = url.pathname === "/index.html" ? "/" : url.pathname;
    event.respondWith((async () => {
        if (event.request.method !== "GET" || url.origin !== self.location.origin || url.search || !files.includes(path)) {
            return new Response("", { status:403 });
        }
        const cache = await caches.open(cacheName);
        return await cache.match(path) || new Response("請連線後在一般 Safari 開啟驗收頁。", {
            status:503, headers:{ "Content-Type":"text/plain; charset=utf-8" }
        });
    })());
});
