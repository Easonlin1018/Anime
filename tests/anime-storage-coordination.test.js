"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require(appSourcePath("v11-core.js"));

const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const start = html.indexOf("const ANIME_WRITE_LOCK");
const end = html.indexOf("function loadStoredAnime", start);
assert.ok(start > 0 && end > start);
const production = html.slice(start, end);
const key = "anime_list_v8_8";

function fixture() {
    const lockNames = [];
    let queued = Promise.resolve();
    const locks = {
        request(name, options, callback) {
            assert.equal(options.mode, "exclusive");
            lockNames.push(name);
            const run = queued.then(callback);
            queued = run.catch(() => {});
            return run;
        }
    };
    const values = new Map([[key, JSON.stringify([{ id:"one", watched:1 }])]]);
    const store = {
        getItem(name) { return values.get(name) ?? null; },
        setItem(name, value) { values.set(name, value); },
        removeItem(name) { values.delete(name); }
    };
    function tab({ safe = true, supported = true, read = null, refresh = () => {} } = {}) {
        const controller = {
            postMessage(message, [port]) {
                assert.equal(message.type, "CHECK_STORAGE_CLIENTS");
                queueMicrotask(() => port.reply({ type:"ANIME_SW_STORAGE_CLIENTS", release:"legacy-series-1", safe }));
            }
        };
        class Channel {
            constructor() {
                this.port1 = { close() {} };
                this.port2 = { reply:value => this.port1.onmessage({ data:value }) };
            }
        }
        const api = vm.createContext({
            window:{ refreshAnimeWriterState:refresh }, navigator:{ locks:supported ? locks : null, serviceWorker:{ controller } },
            MessageChannel:Channel, setTimeout, clearTimeout, STORAGE_KEY:key, EVENT_PREFS_KEY:"prefs",
            EVENT_SETTINGS_KEY:"settings", animeList:[], eventPrefs:{}, eventSettings:{},
            startupAnimeView:list => list, assertAnimeStartupWritable() {},
            localStorage:{
                getItem(name) { read?.(name); return store.getItem(name); },
                setItem:(name, value) => store.setItem(name, value),
                removeItem:name => store.removeItem(name)
            }
        });
        vm.runInContext(production, api);
        return api;
    }
    return { lockNames, store, tab };
}

test("a write requested between another tab's final read and write must hydrate after that commit", async () => {
    const env = fixture();
    const trace = [];
    const b = env.tab();
    let competing, once = false;
    const a = env.tab({ read:name => {
        if (name !== key || once) return;
        once = true;
        competing = b.window.withAnimeStorageWrite(() => {
            b.window.assertAnimeStorageWriteLock();
            trace.push("B:write");
            assert.equal(b.animeList[0].watched, 2);
            b.animeList.push({ id:"two", watched:0 });
            b.localStorage.setItem(key, JSON.stringify(b.animeList));
        });
    } });
    await a.window.withAnimeStorageWrite(() => {
        a.window.assertAnimeStorageWriteLock();
        trace.push("A:write");
        a.animeList[0].watched = 2;
        a.localStorage.setItem(key, JSON.stringify(a.animeList));
    });
    await competing;
    assert.deepEqual(trace, ["A:write", "B:write"]);
    assert.deepEqual(JSON.parse(env.store.getItem(key)), [{ id:"one", watched:2 }, { id:"two", watched:0 }]);
    assert.deepEqual(env.lockNames, ["anime-tracker-v11-storage", "anime-tracker-v11-storage"]);
    assert.throws(() => a.window.assertAnimeStorageWriteLock(), /尚未取得/u);
});

test("missing browser locks and a negative legacy-client check both block the write callback", async () => {
    const env = fixture();
    let executed = 0;
    const noLocks = env.tab({ supported:false });
    assert.throws(() => noLocks.window.withAnimeStorageWrite(() => executed++), /無法安全協調/u);
    const legacyClient = env.tab({ safe:false });
    await assert.rejects(legacyClient.window.withAnimeStorageWrite(() => executed++), /舊版分頁/u);
    assert.equal(executed, 0);
    assert.deepEqual(JSON.parse(env.store.getItem(key)), [{ id:"one", watched:1 }]);
});

test("an import quota failure under the same lock rolls back the list and auxiliary data before publication", async () => {
    const env = fixture(), tab = env.tab();
    const history = JSON.stringify([{ id:"original-history" }]);
    env.store.setItem(V.HISTORY_KEY, history);
    const original = env.store.getItem(key);
    let published = 0;
    Object.assign(tab, {
        V, AnimeTrackerV11:V, EVENT_OVERRIDES_KEY:"overrides", EVENT_ANIME_OVERRIDES_KEY:"anime-overrides",
        eventOverrides:{}, eventAnimeOverrides:{}, watchHistory:JSON.parse(history),
        renderList:() => published++, renderEvents:() => published++, refreshV11:() => published++
    });
    tab.window.__ANIME_STARTUP_STORAGE__ = { persisted:true, warnings:[] };
    const ui = fs.readFileSync(appSourcePath("v11-ui.js"), "utf8");
    vm.runInContext(html.slice(html.indexOf("function restoreAnimeStartupStorage"), html.indexOf("function warnAnimeStartupStorage"))
        + ui.slice(ui.indexOf("    function applyImportedData"), ui.indexOf("    function renderRestorePoints")), tab);
    const write = env.store.setItem;
    env.store.setItem = (name, value) => {
        if (name === V.WORKS_KEY) throw new Error("Synthetic works quota");
        write(name,value);
    };
    await assert.rejects(tab.window.withAnimeStorageWrite(() => tab.applyImportedData({
        animeList:[{ id:"two", title:"Synthetic replacement" }],
        watchHistory:[{ id:"replacement-history" }],
        eventOverrides:{ x:{ retained:true } }
    })), /Synthetic works quota/);
    assert.equal(env.store.getItem(key),original);
    assert.equal(env.store.getItem(V.HISTORY_KEY),history);
    assert.equal(env.store.getItem("overrides"),null);
    assert.equal(env.store.getItem("anime_tracker_startup_pending_v1"),null);
    assert.equal(tab.animeList[0].id,"one");
    assert.equal(published,0);
});
