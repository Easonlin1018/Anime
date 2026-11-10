"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const RELEASE = "poster-fix-3";
const VERSION = "anime-tracker-v11-poster-fix-3";
const LEGACY = "anime-tracker-v11-currently-watching-1";
const base = "https://isolated.example/Anime/";
const release = "releases/" + RELEASE + "/";
const absolute = value => new URL(typeof value === "string" ? value : value.url, base).href;
const releaseFile = url => new URL(url).pathname.slice(new URL(release, base).pathname.length);
const mime = file => file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript";
const shellText = file => fs.readFileSync(path.join(root, release, file), "utf8").replace(/^\uFEFF/u, "");

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
        trace.requests.push({ url, cache, redirect:input.redirect });
        if (options.offline || options.failUrl?.(url)) throw new TypeError("Synthetic offline request");
        if (options.badUrl?.(url)) return new Response("Synthetic failed response", { status:503 });
        const physicalRelease = url.startsWith(absolute(release));
        const file = physicalRelease ? releaseFile(url) : new URL(url).pathname;
        const body = options.bodyOverride?.(url) ?? (physicalRelease ? shellText(file) : '{"events":["synthetic current"]}');
        const type = options.mimeOverride?.(url) ?? (physicalRelease ? mime(file) : "application/json");
        return new Response(body, { status:200, headers:{ "Content-Type":type } });
    };
    const open = async name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const rows = stores.get(name);
        return {
            async match(request) {
                const entry = rows.get(absolute(request));
                return entry ? new Response(entry.body, { status:entry.status, headers:entry.headers }) : undefined;
            },
            async put(request, response) {
                if (options.quota?.(name, absolute(request))) throw new DOMException("Synthetic cache quota", "QuotaExceededError");
                rows.set(absolute(request), { body:await response.text(), status:response.status, headers:response.headers });
            }
        };
    };
    const caches = {
        open, async keys() { return [...stores.keys()]; }, async has(name) { return stores.has(name); },
        async delete(name) { trace.deleted.push(name); return stores.delete(name); },
        async match() { trace.globalMatches++; throw Error("A worker must not read another cache namespace"); }
    };
    const context = vm.createContext({
        URL, Request, Response, Promise, DOMException, TextEncoder, crypto:webcrypto, caches, fetch, console:{ warn:() => {} },
        self:{ location:{ href:base + "sw.js?v=currently-watching-1", origin:new URL(base).origin },
            addEventListener:(name, handler) => listeners.set(name, handler),
            skipWaiting:async () => { trace.skips++; },
            clients:{ claim:async () => { trace.claims++; },
                matchAll:async filters => filters.includeUncontrolled
                    ? [...(options.controlled || []), ...(options.uncontrolled || [])] : options.controlled || [] } },
        localStorage:{
            getItem:key => { trace.storage.push(["get", key]); return storedUserData[key] ?? null; },
            setItem:(key, value) => { trace.storage.push(["set", key]); storedUserData[key] = String(value); },
            removeItem:key => { trace.storage.push(["remove", key]); delete storedUserData[key]; },
            clear:() => { trace.storage.push(["clear"]); for (const key of Object.keys(storedUserData)) delete storedUserData[key]; }
        }
    });
    vm.runInContext(source + "\nglobalThis.__config = { CACHE_VERSION, SHELL_CACHE_PREFIX, DATA_CACHE, READY_URL, shellFiles };", context);
    const config = JSON.parse(JSON.stringify(context.__config));
    const dispatch = async (type, data = {}) => {
        const promises = [];
        let responded = false, response;
        const event = { ...data, waitUntil:promise => promises.push(Promise.resolve(promise)),
            respondWith:promise => { responded=true; response=Promise.resolve(promise); } };
        listeners.get(type)?.(event);
        if (response) response = await response;
        await Promise.all(promises);
        return { responded, response };
    };
    return { trace, options, config, stores, originalUserData, storedUserData, open, dispatch,
        shells:() => [...stores.keys()].filter(name => name.startsWith(config.SHELL_CACHE_PREFIX)),
        seed(name, request, body, headers) {
            if (!stores.has(name)) stores.set(name, new Map());
            stores.get(name).set(absolute(request), { body, status:200, headers });
        },
        fetch:async (url, mode = "same-origin", method = "GET") => dispatch("fetch", { request:{ url:absolute(url), mode, method } }),
        async storageCheck(id) {
            let reply;
            await dispatch("message", { source:{ id }, data:{ type:"CHECK_STORAGE_CLIENTS" }, ports:[{ postMessage:value => { reply = value; } }] });
            return JSON.parse(JSON.stringify(reply));
        }
    };
}

test("the root remains legacy and the immutable release references only its own runtime scripts and CSS", () => {
    const run = runtime();
    assert.equal(run.config.CACHE_VERSION, VERSION);
    const legacy = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const html = shellText("index.html");
    for (const file of ["v11-core.js", "v11-ui.js", "cross-media.js", "spotify-themes.js", "v11-styles.css"]) {
        assert.ok(legacy.includes(file + "?v=currently-watching-1"), file + " legacy URL");
        assert.ok(html.includes(release + file), file);
        assert.ok(run.config.shellFiles.includes(file));
    }
    assert.match(html, /href="manifest\.webmanifest"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8")).start_url, "./index.html");
});

test("an original-query worker installs the verified release without replacing live legacy documents", async () => {
    const run = runtime();
    run.seed(LEGACY, "./index.html", "LEGACY");
    await run.dispatch("install");
    await run.dispatch("activate");
    assert.equal(run.trace.skips, 0);
    assert.equal(run.trace.claims, 0);
    assert.deepEqual(run.trace.deleted, []);
    assert.equal(run.trace.requests.length, run.config.shellFiles.length);
    assert.ok(run.trace.requests.every(item => item.url.startsWith(absolute(release)) && item.cache === "no-store" && item.redirect === "error"));
    assert.equal(run.shells().length, 1);
    const cache = await run.open(run.shells()[0]);
    assert.ok(await cache.match(run.config.READY_URL));
    for (const file of run.config.shellFiles) assert.equal(await (await cache.match(release + file)).text(), shellText(file));
    assert.equal(await (await (await run.open(LEGACY)).match("./index.html")).text(), "LEGACY");
});

for (const failure of ["network", "http", "old-response", "mime", "quota-mid-write", "quota-at-marker"]) {
    test(`a failed ${failure} direct install leaves the legacy offline shell unchanged`, async () => {
        const isCore = url => url.endsWith("/v11-core.js");
        const options = {
            network:{ failUrl:isCore },
            http:{ badUrl:isCore },
            "old-response":{ bodyOverride:url => isCore(url) ? "LEGACY JS under new URL" : undefined },
            mime:{ mimeOverride:url => isCore(url) ? "text/html" : undefined },
            "quota-mid-write":{ quota:(_name,url) => isCore(url) },
            "quota-at-marker":{ quota:(_name,url) => url.endsWith("/.shell-ready") }
        }[failure];
        const run = runtime(options);
        run.seed(LEGACY, "./index.html", "LEGACY HTML");
        run.seed(LEGACY, "./v11-core.js?v=currently-watching-1", "LEGACY CORE");
        run.seed("other-app", "./index.html", "FOREIGN HTML");
        const legacyBefore = [...run.stores.get(LEGACY)];
        await assert.rejects(run.dispatch("install"));
        assert.equal(run.shells().length, 0);
        assert.equal(run.trace.skips, 0);
        assert.equal(run.trace.claims, 0);
        assert.deepEqual([...run.stores.get(LEGACY)], legacyBefore);
        assert.ok(run.stores.has("other-app"));
        assert.ok(run.trace.deleted.every(name => name.startsWith(run.config.SHELL_CACHE_PREFIX)));
    });
}

test("the verified shell starts at both canonical URLs and reopens offline with exact-version resources", async () => {
    const run = runtime();
    await run.dispatch("install");
    run.options.offline = true;
    for (const route of ["./", "index.html?view=installed"]) {
        assert.equal(await (await run.fetch(route, "navigate")).response.text(), shellText("index.html"));
    }
    for (const file of run.config.shellFiles.filter(file => file !== "index.html")) {
        assert.equal(await (await run.fetch(release + file)).response.text(), shellText(file));
    }
    assert.equal((await run.fetch(release + "v11-core.js?wrong-version=1")).response.status, 503);
    const external = await run.fetch(release + "index.html", "navigate");
    assert.equal(external.response.headers.get("Location"), base);
    assert.equal(run.trace.requests.length, run.config.shellFiles.length);
    assert.equal(run.trace.globalMatches, 0);
});

test("parallel online navigations repair an evicted asset with one complete validated download", async () => {
    const run = runtime();
    await run.dispatch("install");
    const original = run.shells()[0];
    run.stores.get(original).delete(absolute(release + "v11-core.js"));
    run.options.offline = true;
    assert.equal((await run.fetch("./", "navigate")).response.status, 503);
    run.options.offline = false;
    const calls = run.trace.requests.length;
    const [first, second] = await Promise.all([run.fetch("./", "navigate"), run.fetch("./index.html", "navigate")]);
    assert.equal(await first.response.text(), shellText("index.html"));
    assert.equal(await second.response.text(), shellText("index.html"));
    assert.equal(run.trace.requests.length - calls, run.config.shellFiles.length);
    assert.equal(run.shells().length, 2);
    run.options.offline = true;
    assert.equal(await (await run.fetch("./", "navigate")).response.text(), shellText("index.html"));
    assert.equal(await (await run.fetch(release + "v11-core.js")).response.text(), shellText("v11-core.js"));
});

test("wrong-release and quota-failed repairs leave previous caches and events available for a later repair", async () => {
    const run = runtime();
    await run.dispatch("install");
    const original = run.shells()[0];
    run.stores.get(original).delete(absolute(release + "v11-core.js"));
    run.seed(LEGACY, "events.json", '{"events":["legacy cached"]}');
    run.seed("other-app", release + "v11-core.js", "FOREIGN CORE");
    const before = [...run.stores.get(original)];
    run.options.bodyOverride = url => url.endsWith("/v11-core.js") ? "OLD CORE" : undefined;
    assert.equal((await run.fetch("./", "navigate")).response.status, 503);
    run.options.bodyOverride = undefined;
    run.options.quota = (_name,url) => url.endsWith("/.shell-ready");
    assert.equal((await run.fetch("./", "navigate")).response.status, 503);
    assert.deepEqual([...run.stores.get(original)], before);
    assert.equal(run.shells().length, 1);
    assert.ok(run.stores.has("other-app"));
    assert.equal(run.trace.globalMatches, 0);
    run.options.offline = true;
    assert.equal(await (await run.fetch("./events.json?t=3")).response.text(), '{"events":["legacy cached"]}');
    run.options.offline = false;
    run.options.quota = undefined;
    assert.equal(await (await run.fetch("./", "navigate")).response.text(), shellText("index.html"));
});

test("legacy event snapshots survive update and are superseded only by valid online events", async () => {
    const run = runtime();
    run.seed(LEGACY, "./events.json?kind=upcoming", '{"events":["legacy"]}');
    run.seed("other-app", "./events.json?kind=archive", '{"events":["foreign"]}');
    await run.dispatch("install");
    await run.dispatch("activate");
    run.options.offline = true;
    const events = timestamp => run.fetch(`./events.json?t=${timestamp}&kind=upcoming`);
    assert.equal(await (await events(1)).response.text(), '{"events":["legacy"]}');
    await assert.rejects(run.fetch("./events.json?t=2&kind=archive"));
    run.options.offline = false;
    run.options.bodyOverride = url => url.includes("events.json") ? "<html>HTML is not an event feed</html>" : undefined;
    assert.equal(await (await events(3)).response.text(), '{"events":["legacy"]}');
    run.options.bodyOverride = undefined;
    const fresh = await (await events(4)).response.text();
    assert.equal(fresh, '{"events":["synthetic current"]}');
    assert.deepEqual(run.trace.requests.at(-1), { url:absolute("./events.json?t=4&kind=upcoming"), cache:"no-store", redirect:undefined });
    run.options.offline = true;
    assert.equal(await (await events(5)).response.text(), fresh);
    assert.equal(run.trace.globalMatches, 0);
});

test("a full runtime cache does not suppress valid online events or remove previous offline events", async () => {
    const run = runtime({ quota:() => true });
    run.seed(LEGACY, "./events.json", '{"events":["legacy"]}');
    assert.equal((await run.fetch("./events.json?t=1")).response.status, 200);
    run.options.offline = true;
    assert.equal(await (await run.fetch("./events.json?t=2")).response.text(), '{"events":["legacy"]}');
});

test("the worker fails closed for uncontrolled legacy app windows", async () => {
    const client = { id:"new", url:base };
    const run = runtime({ controlled:[client] });
    assert.deepEqual(await run.storageCheck("new"), { type:"ANIME_SW_STORAGE_CLIENTS", release:RELEASE, safe:true });
    run.options.uncontrolled = [{ id:"legacy", url:base + "index.html" }];
    assert.equal((await run.storageCheck("new")).safe, false);
    assert.equal((await run.storageCheck("legacy")).safe, false);
    run.options.uncontrolled = [{ id:"another-app", url:"https://isolated.example/Other/" }];
    assert.equal((await run.storageCheck("new")).safe, true);
});

test("authentication, Supabase, provider APIs and non-GET requests stay outside the worker", async () => {
    const run = runtime();
    for (const request of ["https://synthetic.supabase.co/rest/v1/progress", "https://api.jikan.moe/v4/anime/1", "https://api.animethemes.moe/anime/1", "./sync-api/status", "./spotify-worker/token", "../Other/events.json"]) {
        assert.equal((await run.fetch(request)).responded, false);
    }
    assert.equal((await run.fetch("./index.html", "navigate", "POST")).responded, false);
    assert.equal(run.trace.requests.length, 0);
});

test("install, update and offline reads preserve original raw synthetic user data", async () => {
    const run = runtime();
    run.seed(LEGACY, "./index.html", "LEGACY");
    await run.dispatch("install");
    await run.dispatch("activate");
    run.options.offline = true;
    await run.fetch("./", "navigate");
    assert.deepEqual(run.storedUserData, run.originalUserData);
    assert.deepEqual(run.trace.storage, []);
});

function registeredWorker(options = {}) {
    const ui = shellText("v11-ui.js");
    const start = ui.indexOf("    function registerAppServiceWorker()");
    const end = ui.indexOf("    function wireStaticControls()", start);
    assert.ok(start >= 0 && end > start);
    const listeners = new Map(), registrations = [], session = new Map(), trace = { reloads:0, updates:0, messages:[], storage:[] };
    const worker = { scriptURL:base+"sw.js?v="+(options.existingRelease || RELEASE), postMessage:value => trace.messages.push(value) };
    const registration = { scope:options.scope || base, active:worker, addEventListener:() => {}, update:async () => { trace.updates++; } };
    const context = vm.createContext({
        window:{ __ANIME_STARTUP_STORAGE__:{ recoveryPending:!!options.recovery } },
        URL,
        navigator:{ serviceWorker:{ controller:worker, addEventListener:(name, handler) => listeners.set(name, handler),
            getRegistration:async () => options.existingRelease ? registration : undefined,
            register:async (url, settings) => { registrations.push({ url, settings }); return registration; } } },
        document:{ baseURI:base, documentElement:{ dataset:{} } }, location:{ reload:() => { trace.reloads++; } },
        sessionStorage:{ getItem:key => session.get(key) ?? null, setItem:(key, value) => session.set(key, String(value)) },
        localStorage:{ setItem:() => trace.storage.push("write"), clear:() => trace.storage.push("clear") },
        showToast:() => {}, console
    });
    vm.runInContext(ui.slice(start, end), context);
    context.registerAppServiceWorker();
    return { context, listeners, registrations, session, trace,
        settle:async () => { await new Promise(resolve => setImmediate(resolve)); } };
}

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

test("an original legacy registration is reused even when its original script query is older", async () => {
    const run = registeredWorker({ existingRelease:"currently-watching-1" });
    await run.settle();
    assert.equal(run.registrations.length, 0);
    assert.equal(run.trace.updates, 1);
});

test("registration does not update an unrelated parent scope worker", async () => {
    const run = registeredWorker({ existingRelease:"other-app", scope:"https://isolated.example/" });
    await run.settle();
    assert.equal(run.registrations.length, 1);
    assert.equal(run.registrations[0].url, `./sw.js?v=${RELEASE}`);
});

test("a controller update keeps a recovery-pending original-data view open", async () => {
    const run = registeredWorker({ recovery:true });
    await run.settle();
    run.listeners.get("controllerchange")();
    assert.equal(run.trace.reloads, 0);
    assert.equal(run.session.size, 0);
    assert.deepEqual(run.trace.storage, []);
});
