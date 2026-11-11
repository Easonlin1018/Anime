"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const appSourcePath = require("./release-path.cjs");
const V = require(appSourcePath("v11-core.js"));

const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const at = "2026-11-11T12:00:00.000Z";
const coverUrl = "https://cover.example.invalid/anime.png";
const oldCover = "https://cover.example.invalid/saved.png";
const syncKey = "anime_metadata_sync_v10_1";
const { STORAGE_KEY } = V;
const production = [
    ["const MEDIA_FIELDS", "async function requestAniList("],
    ["async function requestAniListMediaPage", "function normalizeStreamingLinks"],
    ["function getAniListCover", "function buildMediaMetadataPatch"],
    ["function restoreAnimeStartupStorage", "function warnAnimeStartupStorage"],
    ["function assertMetadataSyncStorageIdle", "function filterMetadataSyncPatch"],
    ["let animeCoverRecoveryRunning", "function editAnimeReview"]
].map(([start, end]) => {
    const from = html.indexOf(start), to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return html.slice(from, to);
}).join("\n");

function anime(id, extra = {}) {
    return {
        id:"anime-" + id, title:"Synthetic anime " + id, anilistId:id, source:"anilist", sourceId:id,
        category:"backlog", categorySource:"manual", categoryManuallyEdited:true,
        watched:3, currentEpisode:3, totalEpisodes:12, rating:8, favorite:true, notes:"保留舊筆記",
        addedAt:at, updatedAt:at, userExtension:{ favorite:true },
        ...extra
    };
}

function media(id, extra = {}) {
    return { id, type:"ANIME", coverImage:{ large:coverUrl, medium:"" }, ...extra };
}

function runtime(rows, options = {}) {
    const initial = new Map([
        [STORAGE_KEY, JSON.stringify(rows)],
        [syncKey, at],
        [V.HISTORY_KEY, JSON.stringify([{ animeId:"anime-101", delta:1 }])],
        ["anime_tracker_last_undo_v11", JSON.stringify({ kept:true })]
    ]);
    const store = new Map(initial);
    const session = options.session || new Map();
    const requests = [], writes = [], renders = [], messages = [], warnings = [];
    let locked = false;
    const api = vm.createContext({
        AnimeTrackerV11:V,
        animeList:rows,
        STORAGE_KEY,
        EVENT_OVERRIDES_KEY:"event_overrides",
        EVENT_ANIME_OVERRIDES_KEY:"event_anime_overrides",
        window:{
            __ANIME_STARTUP_STORAGE__:{ persisted:!options.pending },
            refreshV11:() => renders.push("v11"),
            refreshAnimeDetailPoster:() => renders.push("detail poster"),
            assertAnimeStorageWriteLock() { assert.equal(locked, true); }
        },
        location:{ href:"https://app.example.invalid/Anime/" },
        navigator:{ onLine:!options.offline },
        console:{ warn:(...args) => warnings.push(args) },
        localStorage:{
            getItem:key => store.get(key) ?? null,
            setItem(key, value) {
                assert.equal(locked, true);
                if (options.quota?.()) throw new Error("Synthetic quota");
                writes.push(key);
                store.set(key, value);
            },
            removeItem(key) { assert.equal(locked, true); store.delete(key); }
        },
        sessionStorage:{
            getItem:key => session.get(key) ?? null,
            setItem(key, value) { session.set(key, value); }
        },
        assertAnimeStartupWritable() {},
        assertAnimeStorageAvailable() { if (options.noLock) throw new Error("Synthetic no Web Locks"); },
        async withAnimeStorageWrite(operation, { hydrate }) {
            assert.equal(hydrate, false);
            assert.equal(locked, false);
            locked = true;
            try { return operation(); }
            finally { locked = false; }
        },
        async fetchWithTimeout(url, { body }) {
            assert.equal(url, "https://graphql.anilist.co");
            assert.equal(locked, false);
            const request = JSON.parse(body);
            requests.push(request);
            const result = options.response
                ? await options.response(request.variables.ids, store)
                : request.variables.ids.map(id => media(id));
            return { json:async () => ({ data:{ Page:{ media:result } } }) };
        },
        delay:async () => {},
        startupAnimeView:list => list,
        renderList:() => renders.push("list"),
        showToast:message => messages.push(message),
        escapeHtml:text => text
    });
    vm.runInContext(production, api, { filename:"legacy-poster-recovery-production.js" });
    return {
        api, initial, store, session, requests, writes, renders, messages, warnings,
        recover:manual => api.window.recoverAnimeCovers(manual),
        persisted:() => JSON.parse(store.get(STORAGE_KEY))
    };
}

test("auto recovery fetches an existing confirmed cover independently of the six-hour metadata cooldown", async () => {
    const old = anime(101);
    const run = runtime([old]);
    assert.equal(await run.recover(), 1);
    assert.deepEqual(run.requests.map(request => request.variables.ids), [[101]]);
    assert.match(run.requests[0].query, /query AnimeCoverRecovery/);
    assert.match(run.requests[0].query, /coverImage\s*\{/);
    assert.doesNotMatch(run.requests[0].query, /nextAiringEpisode|search:|relations/);
    assert.deepEqual(run.persisted(), [{ ...old, anilistCover:{ id:"101", large:coverUrl, medium:"" } }]);
    assert.deepEqual(run.writes, [STORAGE_KEY]);
    assert.deepEqual(run.renders, ["list", "v11", "detail poster"]);
    for (const [key, value] of run.initial) {
        if (key !== STORAGE_KEY) assert.equal(run.store.get(key), value);
    }
    assert.equal(await run.recover(), 0);
    assert.equal(run.requests.length, 1);
});

test("local IDs, fuzzy or wrong-source matches, duplicate claims, and deleted rows cannot backfill automatically", async () => {
    const rows = [
        anime(101),
        anime(102, { id:102, anilistId:undefined, source:undefined, sourceId:undefined, year:2026 }),
        anime(103, { identitySource:"legacy-title-year-format" }),
        anime(104, { dataSource:"MyAnimeList" }),
        anime(105, { sourceId:106 }),
        anime(107),
        anime(107, { id:"anime-107-duplicate", deletedAt:at, category:"_deleted" }),
        anime(108, { deletedAt:at }),
        anime(2147483648)
    ];
    const run = runtime(rows);
    assert.equal(await run.recover(true), 1);
    assert.deepEqual(run.requests.map(request => request.variables.ids), [[101]]);
    assert.deepEqual(run.persisted().slice(1), JSON.parse(JSON.stringify(rows.slice(1))));
});

test("manual repair supplements a saved poster and legacy coverImage without replacing either", async () => {
    const rows = [
        anime(101, { poster:oldCover, coverImage:{ medium:"./covers/fallback.webp" } }),
        anime(102, { anilistCover:{ id:102, large:oldCover } })
    ];
    const run = runtime(rows);
    assert.equal(await run.recover(), 0);
    assert.equal(run.requests.length, 0);
    assert.equal(await run.recover(true), 1);
    assert.deepEqual(run.requests.map(request => request.variables.ids), [[101]]);
    assert.deepEqual(run.persisted(), [
        { ...rows[0], anilistCover:{ id:"101", large:coverUrl, medium:"" } },
        rows[1]
    ]);
});

test("duplicate, foreign, wrong-type and invalid cover results are ignored", async () => {
    const rows = [101,102,103,104,105].map(id => anime(id));
    const run = runtime(rows, { response:() => [
        media(101), media("101"), media(102, { type:"MANGA" }),
        media(103, { coverImage:{ large:"http://cover.example.invalid/unsafe.png" } }),
        media(104, { coverImage:{ extraLarge:coverUrl } }),
        media(105, { coverImage:null }), media(999)
    ] });
    assert.equal(await run.recover(), 1);
    assert.deepEqual(run.persisted(), rows.map(row => row.anilistId === 104
        ? { ...row, anilistCover:{ id:"104", large:coverUrl, medium:"" } } : row));
});

test("recovery keeps concurrent non-cover edits and skips changes to the cover, identity or active row", async () => {
    const rows = [101,102,103,104,105,106].map(id => anime(id));
    let current;
    const run = runtime(rows, { response(ids, store) {
        current = rows.map((row, i) => i === 0 ? { ...row, notes:"Updated meanwhile", watched:4 }
            : i === 1 ? { ...row, poster:oldCover }
            : i === 2 ? { ...row, sourceId:903, anilistId:903 }
            : i === 3 ? { ...row, deletedAt:at }
            : i === 4 ? { ...row, trackingLifecycleResetAt:at }
            : row);
        current.push({ ...rows[5], id:"other-106" });
        store.set(STORAGE_KEY, JSON.stringify(current));
        return ids.map(id => media(id));
    } });
    assert.equal(await run.recover(), 1);
    assert.deepEqual(run.persisted(), [
        { ...current[0], anilistCover:{ id:"101", large:coverUrl, medium:"" } },
        ...current.slice(1)
    ]);
});

test("quota failure keeps the original bytes and the manual action can retry in the same session", async () => {
    let blocked = true;
    const run = runtime([anime(101)], { quota:() => blocked });
    assert.equal(await run.recover(), 0);
    assert.deepEqual(run.store, run.initial);
    assert.deepEqual(run.renders, []);
    assert.equal(run.warnings.length, 1);
    blocked = false;
    assert.equal(await run.recover(), 0);
    assert.equal(run.requests.length, 1);
    assert.equal(await run.recover(true), 1);
    assert.equal(run.requests.length, 2);
});

test("a new page in the same tab honors the auto-attempt marker", async () => {
    const rows = [anime(101)];
    const first = runtime(rows, { response:() => [] });
    assert.equal(await first.recover(), 0);
    assert.equal(first.requests.length, 1);
    const reloaded = runtime(rows, { session:first.session });
    assert.equal(await reloaded.recover(), 0);
    assert.equal(reloaded.requests.length, 0);
    assert.equal(await reloaded.recover(true), 1);
});

test("requests use batches of up to 50 and stop when writing is unsafe or offline", async () => {
    const run = runtime(Array.from({ length:51 }, (_, i) => anime(i + 1)));
    assert.equal(await run.recover(), 51);
    assert.deepEqual(run.requests.map(request => request.variables.ids.length), [50, 1]);
    for (const options of [{ offline:true }, { pending:true }, { noLock:true }]) {
        const readOnly = runtime([anime(101)], options);
        assert.equal(await readOnly.recover(true), 0);
        assert.equal(readOnly.requests.length, 0);
        assert.deepEqual(readOnly.store, readOnly.initial);
    }
});
