"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "v11-ui.js"), "utf8");
const VERSION = "anime-tracker-v11-currently-watching-1";
const RELEASE = "currently-watching-1";
const base = "https://isolated.example/Anime/";
const absolute = value => new URL(typeof value === "string" ? value : value.url, base).href;

function runtime(options = {}) {
    const listeners = new Map(), stores = new Map();
    const trace = { requests:[], deleted:[], skips:0, claims:0, globalMatches:0, storage:[] };
    const originalUserData = {
        anime_list_v8_8:'[{"id":"synthetic-one","currentEpisode":5,"watched":5,"notes":"retain"},{"id":"synthetic-deleted","category":"_deleted","deletedAt":"2026-10-01"}]',
        anime_tracker_watch_history_v1:'[{"id":"history","animeId":"synthetic-one","delta":1}]',
        anime_tracker_last_undo_v11:'{"type":"synthetic-undo","record":{"retained":true}}',
        anime_tracker_restore_points_v1:'[{"id":"synthetic-backup","data":{"retained":true}}]'
    };
    const storedUserData = { ...originalUserData };
    const fetch = async (input, init = {}) => {
        const url = absolute(input), cache = init.cache ?? input.cache ?? "default";
        trace.requests.push({ url, cache });
        if (options.offline || options.failUrl?.(url)) throw new TypeError("Synthetic offline request");
        if (options.badUrl?.(url)) return new Response("Synthetic failed response", { status:503 });
        const body = cache === "reload" || cache === "no-store" ? `CURRENT:${url}` : `HTTP-STALE:${url}`;
        return new Response(body, { status:200 });
    };
    const open = async name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const rows = stores.get(name);
        return {
            async addAll(requests) {
                // addAll commits its batch only if all requests succeed.
                const loaded = await Promise.all(requests.map(async request => {
                    const response = await fetch(request);
                    if (!response.ok) throw new TypeError("Synthetic addAll rejected HTTP error");
                    return [absolute(request), await response.text()];
                }));
                for (const [url, body] of loaded) rows.set(url, { body, status:200 });
            },
            async match(request) {
                const entry = rows.get(absolute(request));
                return entry ? new Response(entry.body, { status:entry.status }) : undefined;
            },
            async put(request, response) {
                if (options.cachePutFailure) throw new DOMException("Synthetic cache quota", "QuotaExceededError");
                rows.set(absolute(request), { body:await response.text(), status:response.status });
            },
            async keys() { return [...rows.keys()].map(url => new Request(url)); }
        };
    };
    const caches = {
        open, async keys() { return [...stores.keys()]; },
        async delete(name) { trace.deleted.push(name); return stores.delete(name); },
        async match() { trace.globalMatches++; throw Error("A worker must not read another cache namespace"); }
    };
    const context = vm.createContext({
        URL, Request, Response, Promise, DOMException, caches, fetch, console:{ warn:() => {} },
        self:{ location:{ href:base + "sw.js?v=" + RELEASE, origin:new URL(base).origin },
            addEventListener:(name, handler) => listeners.set(name, handler),
            skipWaiting:async () => { trace.skips++; }, clients:{ claim:async () => { trace.claims++; } } },
        localStorage:{
            getItem:key => { trace.storage.push(["get", key]); return storedUserData[key] ?? null; },
            setItem:(key, value) => { trace.storage.push(["set", key]); storedUserData[key] = String(value); },
            removeItem:key => { trace.storage.push(["remove", key]); delete storedUserData[key]; },
            clear:() => { trace.storage.push(["clear"]); for (const key of Object.keys(storedUserData)) delete storedUserData[key]; }
        }
    });
    vm.runInContext(source + "\nglobalThis.__config = { CACHE_VERSION, SHELL };", context);
    const config = JSON.parse(JSON.stringify(context.__config));
    const dispatch = async (type, data = {}) => {
        const promises = [];
        let responded = false, response;
        const event = { ...data, waitUntil:promise => promises.push(Promise.resolve(promise)),
            respondWith:promise => { responded=true; response=Promise.resolve(promise); } };
        listeners.get(type)?.(event);
        if (response) response = await response;
        await Promise.all(promises);
        await new Promise(resolve => setImmediate(resolve));
        return { responded, response };
    };
    return { trace, options, config, stores, originalUserData, storedUserData, open, dispatch,
        seed(name, request, body) { if (!stores.has(name)) stores.set(name, new Map()); stores.get(name).set(absolute(request), { body, status:200 }); },
        fetch:async (url, mode = "same-origin", method = "GET") => dispatch("fetch", { request:{ url:absolute(url), mode, method } }) };
}

function registeredWorker(options = {}) {
    const start = ui.indexOf("    function registerAppServiceWorker()");
    const end = ui.indexOf("    function wireStaticControls()", start);
    assert.ok(start >= 0 && end > start);
    const listeners = new Map(), registrations = [], session = new Map(), trace = { reloads:0, updates:0, messages:[], storage:[] };
    const worker = { scriptURL:base+"sw.js?v="+RELEASE, postMessage:value => trace.messages.push(value) };
    const context = vm.createContext({
        window:{ __ANIME_STARTUP_STORAGE__:{ recoveryPending:!!options.recovery } },
        navigator:{ serviceWorker:{ controller:worker, addEventListener:(name, handler) => listeners.set(name, handler),
            register:async (url, settings) => { registrations.push({ url, settings }); return { active:worker, addEventListener:() => {}, update:async () => { trace.updates++; } }; } } },
        document:{ documentElement:{ dataset:{} } }, location:{ reload:() => { trace.reloads++; } },
        sessionStorage:{ getItem:key => session.get(key) ?? null, setItem:(key, value) => session.set(key, String(value)) },
        localStorage:{ setItem:() => trace.storage.push("write"), clear:() => trace.storage.push("clear") },
        showToast:() => {}, console
    });
    vm.runInContext(ui.slice(start, end), context);
    context.registerAppServiceWorker();
    return { context, listeners, registrations, session, trace,
        settle:async () => { await new Promise(resolve => setImmediate(resolve)); } };
}

test("the release cache and all changed app resources share the current-viewing version", () => {
    const run = runtime();
    assert.equal(run.config.CACHE_VERSION, VERSION);
    for (const asset of ["v11-core.js", "v11-ui.js", "cross-media.js", "spotify-themes.js", "v11-styles.css"]) {
        const expected = `${asset}?v=${RELEASE}`;
        assert.ok(html.includes(`"${expected}"`), `${asset} must have the release version in index.html`);
        assert.ok(run.config.SHELL.includes(`./${expected}`), `${asset} must have the same release version in SHELL`);
    }
    assert.equal(run.config.SHELL.length, 11);
});

test("install bypasses stale HTTP responses and completes the entire shell before skipWaiting", async () => {
    const run = runtime();
    run.seed("anime-tracker-v11-theme-songs-native-title-1", "./index.html", "OLD-INDEX");
    await run.dispatch("install");
    assert.equal(run.trace.skips, 1);
    assert.equal(run.trace.requests.length, run.config.SHELL.length);
    assert.ok(run.trace.requests.every(request => ["reload", "no-store"].includes(request.cache)));
    const cache = await run.open(VERSION);
    for (const request of run.config.SHELL) assert.match(await (await cache.match(request)).text(), /^CURRENT:/);
    assert.equal(await (await (await run.open("anime-tracker-v11-theme-songs-native-title-1")).match("./index.html")).text(), "OLD-INDEX");
});

for (const failure of ["network", "http"]) {
    test(`a failed ${failure} shell install never activates or destroys existing cache entries`, async () => {
        const options = { [failure === "network" ? "failUrl" : "badUrl"]:url => url.includes("v11-core.js") };
        const run = runtime(options);
        run.seed("anime-tracker-v11-theme-songs-native-title-1", "./index.html", "OLD-INDEX");
        run.seed(VERSION, "./icons/app-icon.svg", "EXISTING-GOOD");
        await assert.rejects(run.dispatch("install"));
        assert.equal(run.trace.skips, 0);
        assert.equal(run.trace.claims, 0);
        assert.equal(await (await (await run.open("anime-tracker-v11-theme-songs-native-title-1")).match("./index.html")).text(), "OLD-INDEX");
        assert.equal(await (await (await run.open(VERSION)).match("./icons/app-icon.svg")).text(), "EXISTING-GOOD");
        assert.equal(run.stores.get(VERSION).size, 1);
        assert.deepEqual(run.trace.deleted, []);
    });
}

test("activate cleans only this application's old caches and preserves other same-origin applications", async () => {
    const run = runtime();
    for (const name of [VERSION, "anime-tracker-v10-old", "anime-tracker-v11-theme-songs-native-title-1", "other-app-shell-v7", "workbox-precache-v2", "not-anime-tracker-v11"]) run.seed(name, "./index.html", name);
    await run.dispatch("activate");
    assert.deepEqual(run.trace.deleted.sort(), ["anime-tracker-v10-old", "anime-tracker-v11-theme-songs-native-title-1"]);
    assert.ok(run.stores.has(VERSION));
    assert.ok(run.stores.has("other-app-shell-v7"));
    assert.ok(run.stores.has("workbox-precache-v2"));
    assert.ok(run.stores.has("not-anime-tracker-v11"));
    assert.equal(run.trace.claims, 1);
});

test("offline navigation and release resources use only the newly installed shell", async () => {
    const run = runtime();
    await run.dispatch("install");
    run.seed("other-app-shell-v7", "./index.html", "FOREIGN-HTML");
    run.options.offline = true;
    const navigation = await run.fetch("./unknown-route", "navigate");
    assert.match(await navigation.response.text(), /^CURRENT:.*\/Anime\/index\.html$/);
    for (const asset of ["v11-core.js", "v11-ui.js", "cross-media.js", "spotify-themes.js", "v11-styles.css"]) {
        const result = await run.fetch(`./${asset}?v=${RELEASE}`);
        assert.match(await result.response.text(), /^CURRENT:/);
    }
    assert.equal(run.trace.globalMatches, 0);
});

test("a missing release asset cannot silently fall back to an old or foreign cache", async () => {
    const run = runtime({ offline:true });
    const asset = `./v11-ui.js?v=${RELEASE}`;
    run.seed("anime-tracker-v11-theme-songs-native-title-1", asset, "OLD-JS");
    run.seed("other-app-shell-v7", asset, "FOREIGN-JS");
    await assert.rejects(run.fetch(asset));
    assert.equal(run.trace.globalMatches, 0);
});

test("a failed HTTP resource response cannot overwrite the good offline release copy", async () => {
    const run = runtime();
    await run.dispatch("install");
    run.options.badUrl = url => url.includes("v11-ui.js");
    const failedNetwork = await run.fetch(`./v11-ui.js?v=${RELEASE}`);
    assert.equal(failedNetwork.response.status, 200);
    assert.match(await failedNetwork.response.text(), /^CURRENT:/);
    run.options.offline = true;
    const result = await run.fetch(`./v11-ui.js?v=${RELEASE}`);
    assert.equal(result.response.status, 200);
    assert.match(await result.response.text(), /^CURRENT:/);
});

test("events and ordinary same-origin assets cannot read foreign cache fallbacks", async () => {
    const run = runtime({ offline:true });
    for (const request of ["./events.json", "./icons/app-icon.svg"]) {
        run.seed(VERSION, request, "CURRENT-CACHED");
        run.seed("other-app-shell-v7", request, "FOREIGN-CACHED");
        const result = await run.fetch(request);
        assert.equal(await result.response.text(), "CURRENT-CACHED");
    }
    assert.equal(run.trace.globalMatches, 0);
});

test("events retain a fresh original request but reuse the same current cache across timestamp changes", async () => {
    const run = runtime();
    const firstUrl = "./events.json?t=111&kind=upcoming";
    const first = await run.fetch(firstUrl);
    const originalBody = await first.response.text();
    assert.equal(run.trace.requests[0].url, absolute(firstUrl));
    assert.equal(run.trace.requests[0].cache, "no-store");
    assert.match(originalBody, /^CURRENT:/);
    assert.ok(run.stores.get(VERSION).has(absolute("./events.json?kind=upcoming")));
    assert.equal(run.stores.get(VERSION).has(absolute(firstUrl)), false);
    run.options.offline = true;
    const offline = await run.fetch("./events.json?t=222&kind=upcoming");
    assert.equal(await offline.response.text(), originalBody);
    assert.equal(run.trace.requests[1].url, absolute("./events.json?t=222&kind=upcoming"));
    assert.equal(run.trace.requests[1].cache, "no-store");
    assert.equal(run.trace.globalMatches, 0);
    assert.deepEqual(run.storedUserData, run.originalUserData);
    assert.deepEqual(run.trace.storage, []);
});

test("events timestamp normalization preserves every other query parameter", async () => {
    const run = runtime();
    await run.fetch("./events.json?t=111&kind=upcoming&lang=zh-TW");
    run.options.offline = true;
    await assert.rejects(run.fetch("./events.json?t=222&kind=archive&lang=zh-TW"));
    await assert.rejects(run.fetch("./events.json?t=222&kind=upcoming&lang=en"));
    const original = await run.fetch("./events.json?t=333&kind=upcoming&lang=zh-TW");
    assert.match(await original.response.text(), /^CURRENT:/);
    assert.equal(run.trace.globalMatches, 0);
});

test("timestamped events cannot recover from an older release or another application's canonical cache", async () => {
    const run = runtime({ offline:true });
    run.seed("anime-tracker-v11-theme-songs-native-title-1", "./events.json", "OLD-EVENTS");
    run.seed("other-app-shell-v7", "./events.json", "FOREIGN-EVENTS");
    await assert.rejects(run.fetch("./events.json?t=222"));
    assert.equal(run.trace.globalMatches, 0);
    run.seed(VERSION, "./events.json", "CURRENT-EVENTS");
    const current = await run.fetch("./events.json?t=333");
    assert.equal(await current.response.text(), "CURRENT-EVENTS");
});

test("cache quota failure preserves a successful online response without publishing stale fallback data", async () => {
    const run = runtime({ cachePutFailure:true });
    const result = await run.fetch(`./v11-ui.js?v=${RELEASE}`);
    assert.equal(result.response.status, 200);
    assert.match(await result.response.text(), /^CURRENT:/);
    assert.equal(run.trace.globalMatches, 0);
});

test("authentication, Supabase, provider APIs and non-GET requests remain outside the worker", async () => {
    const run = runtime();
    for (const request of ["https://synthetic.supabase.co/rest/v1/progress", "https://api.jikan.moe/v4/anime/1", "https://api.animethemes.moe/anime/1", "./sync-api/status", "./spotify-worker/token"]) {
        assert.equal((await run.fetch(request)).responded, false);
    }
    assert.equal((await run.fetch("./index.html", "same-origin", "POST")).responded, false);
    assert.equal(run.trace.requests.length, 0);
});

test("install, upgrade and offline reads preserve raw animation/history/tombstone/undo/backup storage", async () => {
    const run = runtime();
    run.seed("anime-tracker-v11-theme-songs-native-title-1", "./index.html", "OLD-INDEX");
    await run.dispatch("install");
    await run.dispatch("activate");
    run.options.offline = true;
    await run.fetch("./", "navigate");
    assert.deepEqual(run.storedUserData, run.originalUserData);
    assert.deepEqual(run.trace.storage, []);
});

test("registration uses the new worker URL, fresh update checks and one reload per release", async () => {
    const run = registeredWorker();
    await run.settle();
    assert.equal(run.registrations[0].url, `./sw.js?v=${RELEASE}`);
    assert.equal(run.registrations[0].settings?.updateViaCache, "none");
    assert.equal(run.trace.updates, 1);
    run.session.set("anime_tracker_sw_reload_version", "theme-songs-native-title-1");
    run.listeners.get("controllerchange")();
    run.listeners.get("controllerchange")();
    assert.equal(run.trace.reloads, 1);
    assert.equal(run.session.get("anime_tracker_sw_reload_version"), RELEASE);
    assert.deepEqual(run.trace.storage, []);
});

test("a controller update keeps a recovery-pending original-data view open", async () => {
    const run = registeredWorker({ recovery:true });
    await run.settle();
    run.listeners.get("controllerchange")();
    assert.equal(run.trace.reloads, 0);
    assert.equal(run.session.size, 0);
    assert.deepEqual(run.trace.storage, []);
});
