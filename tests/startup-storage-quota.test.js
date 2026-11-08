"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "v11-ui.js"), "utf8");
const themes = fs.readFileSync(path.join(root, "spotify-themes.js"), "utf8");
const crossMedia = fs.readFileSync(path.join(root, "cross-media.js"), "utf8");
const at = "2026-10-08T13:00:00.000Z";
const before = "2026-10-01T00:00:00.000Z";
const copy = value => JSON.parse(JSON.stringify(value));
const EVENT_KEY = "anime_event_overrides_v10";
const EVENT_ANIME_KEY = "anime_event_anime_overrides_v11";
const CATEGORY_BACKUP = "anime_tracker_title_series_migration_backup_v1";
const PENDING_KEY = "anime_tracker_startup_pending_v1";

function between(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
    return source.slice(first, last);
}

// Real startup/category/identity code and real renderer; only browser I/O is replaced.
const production = [
    between(html, "function stripDisplayYear", "async function searchWikipedia"),
    between(html, "function normalizeAnimeAliasList", "function deriveAliasVariants"),
    between(html, "function getAniListMediaId", "function getMediaIdentityTitles"),
    between(html, "function normalizeStreamingLinks", "function buildAnimeRecordFromMedia"),
    between(html, "function loadStoredAnime", "function delay"),
    between(html, "function formatAiringDateTime", "async function syncAnimeMetadata"),
    between(html, "function getAnimeTitlePresentation", "function exportData")
].join("\n");

// Execute the production v11 initializer, including its persistence guard.
// Stop before unrelated progress/delete event handlers; keep its closure variables.
const bootstrap = `${ui.slice(0, ui.indexOf("const originalMoveCategory"))}\n` +
    `${between(ui, "function exportBackup()", "function readImport")}\n` +
    "window.__quotaTestBootstrap = { history:() => watchHistory, persistAnime, snapshot, exportBackup }; })();";

function anime(identity = 101, extra = {}) {
    const title = `通用測試作品 ${identity}`;
    return V.migrateList([V.migrateAnime({
        id:`local-${identity}`, anilistId:identity, source:"anilist", sourceId:String(identity),
        title, displayTitle:title, canonicalTitle:title, groupTitle:title,
        titleSource:"manual", titleManuallyEdited:true, aliases:[title],
        format:"TV", status:"RELEASING", startDate:{ year:2026, month:10, day:1 },
        category:"waiting", categorySource:"automatic", categoryManuallyEdited:false,
        releasedEpisodes:1, nextEpisode:2, nextAiringAt:Date.parse(at) / 1000 + 6960,
        watched:0, currentEpisode:0, progress:0, reviewWatched:4,
        rating:8.5, note:"保留筆記", notes:"保留筆記", customPlatform:"自訂平台",
        createdAt:before, addedAt:before, updatedAt:before, lastWatchedAt:before,
        reviewStartedAt:before, reviewCompletedAt:null, customField:{ retained:true },
        ...extra
    }, before)], before)[0];
}

function seed(list = [anime()], extra = {}) {
    return {
        [V.STORAGE_KEY]:JSON.stringify(list),
        [EVENT_KEY]:JSON.stringify({ event:{ includeAnimeIds:[list[0].id], notes:"retain" } }),
        [EVENT_ANIME_KEY]:JSON.stringify({ event:{ includeAnimeIds:[list[0].id] } }),
        [V.HISTORY_KEY]:JSON.stringify([{ id:"history", animeId:list[0].id, delta:1, at:before }]),
        [V.WORKS_KEY]:JSON.stringify([]),
        [V.MANGA_HISTORY_KEY]:JSON.stringify([{ id:"manga-history", workId:"other", delta:2 }]),
        anime_theme_lookup_cache_v1:JSON.stringify({ "source:other":{ title:"OP", retained:true } }),
        anime_theme_last_undo_v1:JSON.stringify({ animeId:"other", before:{ notes:"retain" } }),
        anime_tracker_last_undo_v11:JSON.stringify({ type:"delete", targetId:"deleted", before:{ retained:true } }),
        [V.WATCH_RESET_UNDO_KEY]:JSON.stringify({ history:[{ id:"previous-history", delta:5 }] }),
        [V.RESTORE_KEY]:JSON.stringify([{ id:"restore", data:{ retained:true } }]),
        unrelated_user_data:"retain unrelated bytes",
        ...extra
    };
}

function duplicateSeed() {
    const primary = anime();
    const preferred = anime(202, { id:"preferred", category:"watching", watched:5, currentEpisode:5 });
    const duplicate = anime(202, { id:"duplicate", category:"watching", watched:3, currentEpisode:3 });
    const deleted = anime(303, { id:"deleted", category:"_deleted", deletedAt:before, deletedFromCategory:"review" });
    return seed([primary, preferred, duplicate, deleted], {
        [EVENT_KEY]:JSON.stringify({ event:{ includeAnimeIds:["preferred", "duplicate"], hidden:true } }),
        [EVENT_ANIME_KEY]:JSON.stringify({ event:{ includeAnimeIds:["duplicate"] } }),
        [V.HISTORY_KEY]:JSON.stringify([
            ...Array.from({ length:10 }, (_, n) => ({ id:`preferred-history-${n}`, animeId:"preferred", delta:1, at:before })),
            { id:"duplicate-history", animeId:"duplicate", delta:1, at:before }
        ]),
        [V.WORKS_KEY]:JSON.stringify([
            { workId:"work-preferred", title:"通用測試作品 202", mediaEntries:[{ id:"preferred", mediaType:"anime", title:"通用測試作品 202" }] },
            { workId:"work-duplicate", title:"通用測試作品 202", mediaEntries:[{ id:"duplicate", mediaType:"anime", title:"通用測試作品 202" }] }
        ]),
        [V.MANGA_HISTORY_KEY]:JSON.stringify([{ id:"manga-history", workId:"work-duplicate", delta:2 }]),
        anime_theme_lookup_cache_v1:JSON.stringify({ "source:duplicate":{ title:"OP", retained:true } }),
        anime_theme_last_undo_v1:JSON.stringify({ animeId:"duplicate", before:{ notes:"retain" } })
    });
}

// A browser-like quota: failed setItem has no effect; replacement counts total
// UTF-16 key/value bytes. Limits are fixtures, not claims about Safari's capacity.
function storage(initial, options = {}) {
    const data = new Map(Object.entries(initial));
    const trace = [];
    const size = entries => [...entries].reduce((total, [key, value]) => total + 2 * (key.length + value.length), 0);
    const api = {
        data, trace,
        limit:options.limit ?? Infinity,
        getItem:key => data.get(String(key)) ?? null,
        setItem(key, value) {
            key = String(key); value = String(value);
            const next = new Map(data); next.set(key, value);
            const entry = { operation:"set", key, value, before:Object.fromEntries(data), committed:false };
            trace.push(entry);
            if (key === options.failKey || size(next) > api.limit || options.fail?.(entry, api)) {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
            }
            data.set(key, value); entry.committed = true;
        },
        removeItem(key) {
            key = String(key); trace.push({ operation:"remove", key });
            if (key === options.failRemoveKey) throw new DOMException("Storage unavailable", "SecurityError");
            data.delete(key);
        },
        clear() { trace.push({ operation:"clear" }); data.clear(); },
        snapshot:() => Object.fromEntries(data),
        size:() => size(data)
    };
    return api;
}

function runtime(localStorage) {
    const nodes = new Map();
    const timers = [];
    const trace = { warnings:[], errors:[], refreshes:0, handlers:[], exports:[], exportClicks:0 };
    class BrowserURL extends URL {
        static createObjectURL(blob) { trace.exports.push(blob); return "blob:quota-regression"; }
        static revokeObjectURL() {}
    }
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [at])); }
        static now() { return Date.parse(at); }
    }
    const element = id => {
        if (!nodes.has(id)) nodes.set(id, { innerHTML:"", textContent:"", style:{}, dataset:{} });
        return nodes.get(id);
    };
    const context = vm.createContext({
        window:{ AnimeTrackerV11:V }, AnimeTrackerV11:V, localStorage, Date:Clock, Blob, URL:BrowserURL,
        animeList:[], animeListQuery:"", animeListSort:"watching-first", animeSyncing:false,
        STORAGE_KEY:V.STORAGE_KEY, OLD_KEYS:["anime_list_v8_7"], ANIME_SYNC_KEY:"anime_metadata_sync_v10_1",
        EVENT_OVERRIDES_KEY:EVENT_KEY, EVENT_ANIME_OVERRIDES_KEY:EVENT_ANIME_KEY, EVENT_MATCH_DEBUG:false,
        eventOverrides:JSON.parse(localStorage.getItem(EVENT_KEY) || "{}"),
        eventAnimeOverrides:JSON.parse(localStorage.getItem(EVENT_ANIME_KEY) || "{}"),
        eventSettings:{}, toastTimer:null,
        document:{ getElementById:element, querySelectorAll:() => [], querySelector:() => null,
            addEventListener:(type, handler, capture) => trace.handlers.push({ type, handler, capture }),
            createElement:() => ({ click:() => trace.exportClicks++ }) },
        console:{ warn:(...args) => trace.warnings.push(args), error:(...args) => trace.errors.push(args), info:() => {} },
        setTimeout:fn => { timers.push(fn); return timers.length; }, clearTimeout:() => {},
        refreshV11:() => trace.refreshes++, handleSync:() => {}, formatEventDate:value => value
    });
    vm.runInContext(production, context, { filename:"production-startup-storage.js" });
    context.window.migrateExistingAnimeRecords = context.migrateExistingAnimeRecords;
    return {
        api:context, localStorage, nodes, trace,
        boot() {
            context.loadStoredAnime(); context.renderList();
            vm.runInContext(bootstrap, context, { filename:"production-v11-storage-bootstrap.js" });
            // Run deferred warnings while preserving the toast dismissal timer.
            const pending = timers.splice(0);
            pending.filter(fn => fn !== context.closeToast).forEach(fn => fn());
        }
    };
}

function originalKeysUnchanged(localStorage, initial) {
    for (const [key, value] of Object.entries(initial)) {
        assert.equal(localStorage.getItem(key), value, `${key} must retain original bytes`);
    }
    assert.deepEqual(localStorage.trace.filter(entry => entry.operation !== "set" &&
        !(entry.operation === "remove" && entry.key === PENDING_KEY && !Object.hasOwn(initial, PENDING_KEY))), [],
    "Startup may remove only its newly-created internal journal, never existing keys or backups");
}

function failedBootPreservesOriginal(run, initial) {
    assert.doesNotThrow(() => run.boot(), "Quota must not abort production startup/bootstrap");
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, false);
    assert.deepEqual(copy(run.api.animeList), JSON.parse(initial[V.STORAGE_KEY]), "Unpersisted migrations must not be published in memory");
    assert.deepEqual(copy(run.api.eventOverrides), JSON.parse(initial[EVENT_KEY]));
    assert.deepEqual(copy(run.api.eventAnimeOverrides), JSON.parse(initial[EVENT_ANIME_KEY]));
    assert.deepEqual(copy(run.api.window.__quotaTestBootstrap.history()), JSON.parse(initial[V.HISTORY_KEY]));
    originalKeysUnchanged(run.localStorage, initial);
    assert.match(run.nodes.get("list-waiting").innerHTML, /通用測試作品 101/u);
    assert.equal(run.nodes.get("toast-box").style.display, "block", "Failure warning must be visible without blocking rendered UI");
    assert.match(run.nodes.get("toast-msg").innerHTML, /儲存|容量|空間|保留/u);
    assert.ok(run.trace.warnings.length > 0, "The storage failure is reported for diagnosis");
}

test("near-full storage: multi-key journal growth cannot block UI, migrate in memory or clear existing keys", () => {
    const initial = duplicateSeed();
    const store = storage(initial); store.limit = store.size() + 32;
    failedBootPreservesOriginal(runtime(store), initial);
    assert.ok(store.trace.some(entry => !entry.committed), "Exercise a real fixture capacity failure");
});

test("startup journal creation failure occurs before main or auxiliary data writes", () => {
    const initial = duplicateSeed(), store = storage(initial, { failKey:PENDING_KEY });
    failedBootPreservesOriginal(runtime(store), initial);
    assert.ok(store.trace.some(entry => entry.key === PENDING_KEY && !entry.committed));
    assert.equal(store.trace.filter(entry => entry.committed && Object.hasOwn(initial, entry.key)).length, 0);
});

test("real total-size quota after the main write rolls back growing UUID history references without deleting data", () => {
    const initial = seed([anime(101, { id:"same" }), anime(202, { id:"same" })], {
        [V.HISTORY_KEY]:JSON.stringify(Array.from({ length:100 }, (_, n) => ({
            id:`collision-history-${n}`, animeId:"same", anilistId:202, delta:1, at:before
        })))
    });
    const baseline = storage(initial);
    const baselineRun = runtime(baseline);
    assert.doesNotThrow(() => baselineRun.boot());
    const firstMainWrite = baseline.trace.find(entry => entry.key === V.STORAGE_KEY && entry.committed);
    assert.ok(firstMainWrite && baseline.trace.some(entry => entry.key === V.HISTORY_KEY && entry.committed));
    const afterMain = { ...firstMainWrite.before, [V.STORAGE_KEY]:firstMainWrite.value };
    const limit = Object.entries(afterMain).reduce((bytes, [key, value]) => bytes + 2 * (key.length + value.length), 0) + 32;
    const store = storage(initial, { limit });
    failedBootPreservesOriginal(runtime(store), initial);
    assert.ok(store.trace.some(entry => entry.key === PENDING_KEY && entry.committed), "The durable journal fits before the data writes");
    assert.ok(store.trace.some(entry => entry.key === V.STORAGE_KEY && entry.committed && entry.value !== initial[V.STORAGE_KEY]),
        "Actually exercise partial persistence before the capacity failure");
    assert.ok(store.trace.some(entry => entry.key === V.HISTORY_KEY && !entry.committed),
        "UUID history-reference growth must cause an actual size-limit failure");
    assert.equal(store.getItem(PENDING_KEY), null, "Successful rollback cleans only the current internal journal");
});

test("backup failure after a successful primary write warns without discarding or pretending the persisted transition", () => {
    const initial = seed(), store = storage(initial, { failKey:CATEGORY_BACKUP });
    const run = runtime(store);
    assert.doesNotThrow(() => run.boot());
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
    assert.equal(run.api.animeList[0].category, "watching");
    assert.deepEqual(copy(run.api.animeList), JSON.parse(store.getItem(V.STORAGE_KEY)));
    assert.ok(store.trace.some(entry => entry.key === CATEGORY_BACKUP && !entry.committed));
    const mainWrite = store.trace.findIndex(entry => entry.key === V.STORAGE_KEY && entry.committed);
    const backupAttempt = store.trace.findIndex(entry => entry.key === CATEGORY_BACKUP);
    assert.ok(mainWrite >= 0 && backupAttempt > mainWrite, "A backup cannot consume quota before the primary save");
    for (const [key, value] of Object.entries(initial)) if (key !== V.STORAGE_KEY) assert.equal(store.getItem(key), value);
    assert.equal(run.nodes.get("toast-box").style.display, "block");
    assert.match(run.nodes.get("list-watching").innerHTML, /通用測試作品 101/u);
});

test("pre-existing backups do not permit an unpersisted main-list growth at the capacity limit", () => {
    const initial = seed([anime()], {
        [CATEGORY_BACKUP]:JSON.stringify({ existing:true, animeList:[{ untouched:true }] }),
        anime_tracker_schema_version:"11"
    });
    const store = storage(initial); store.limit = store.size();
    failedBootPreservesOriginal(runtime(store), initial);
    assert.ok(store.trace.some(entry => entry.key === V.STORAGE_KEY && !entry.committed));
    assert.equal(store.getItem(CATEGORY_BACKUP), initial[CATEGORY_BACKUP], "An existing backup is never replaced to save capacity");
});

for (const backupKey of ["anime_tracker_duplicate_migration_backup_v1", "anime_tracker_legacy_identity_recovery_backup_v1"]) {
    test(`${backupKey} failure remains nonfatal after primary/auxiliary persistence succeeds`, () => {
        let initial = duplicateSeed();
        if (backupKey.includes("legacy_identity")) {
            const legacy = anime(); delete legacy.anilistId; delete legacy.source; delete legacy.sourceId;
            initial = seed([legacy], {
                [V.WORKS_KEY]:JSON.stringify([{ workId:"legacy-work", title:legacy.title, mediaEntries:[
                    { id:legacy.id, mediaType:"anime", sourceId:"101", title:legacy.title, aliases:[legacy.title] }
                ] }])
            });
        }
        const store = storage(initial, { failKey:backupKey });
        const run = runtime(store);
        assert.doesNotThrow(() => run.boot());
        assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
        assert.equal(run.api.animeList[0].category, "watching");
        assert.deepEqual(copy(run.api.animeList), JSON.parse(store.getItem(V.STORAGE_KEY)));
        assert.ok(store.trace.some(entry => entry.key === backupKey && !entry.committed));
        assert.equal(store.getItem("anime_tracker_last_undo_v11"), initial.anime_tracker_last_undo_v11);
        assert.equal(store.getItem(V.WATCH_RESET_UNDO_KEY), initial[V.WATCH_RESET_UNDO_KEY]);
        assert.equal(store.getItem("unrelated_user_data"), initial.unrelated_user_data);
        assert.equal(run.nodes.get("toast-box").style.display, "block");
    });
}

test("main-list failure preserves raw main, history, tombstones, undo and auxiliary bytes", () => {
    const initial = duplicateSeed(), store = storage(initial, { failKey:V.STORAGE_KEY });
    failedBootPreservesOriginal(runtime(store), initial);
    assert.ok(store.trace.some(entry => entry.key === V.STORAGE_KEY && !entry.committed));
});

test("failed startup preserves raw legacy progress and time fields rather than publishing normalized copies", () => {
    const original = anime();
    original.watched = 4; original.currentEpisode = 2; original.progress = 0.42; original.reviewWatched = 7;
    original.addedAt = "legacy-added-time"; original.lastWatchedAt = "legacy-watch-time";
    original.updatedAt = "legacy-update-time"; original.reviewStartedAt = "legacy-review-time";
    const initial = seed([original]), store = storage(initial, { failKey:V.STORAGE_KEY });
    failedBootPreservesOriginal(runtime(store), initial);
});

for (const failKey of [EVENT_KEY, EVENT_ANIME_KEY, V.HISTORY_KEY, V.WORKS_KEY,
    V.MANGA_HISTORY_KEY, "anime_theme_lookup_cache_v1", "anime_theme_last_undo_v1"]) {
    test(`auxiliary failure at ${failKey}: rollback retains original list/history/tombstones/undo and rendered UI`, () => {
        const initial = duplicateSeed(), store = storage(initial, { failKey });
        failedBootPreservesOriginal(runtime(store), initial);
        assert.ok(store.trace.some(entry => entry.key === failKey && !entry.committed), `Exercise ${failKey} failure`);
    });
}

test("the second fresh page load under the same quota reads and renders all original records again", () => {
    const initial = duplicateSeed(), store = storage(initial); store.limit = store.size() + 32;
    failedBootPreservesOriginal(runtime(store), initial);
    failedBootPreservesOriginal(runtime(store), initial);
    assert.equal(JSON.parse(store.getItem(V.STORAGE_KEY)).length, 4);
    assert.equal(JSON.parse(store.getItem(V.STORAGE_KEY))[3].deletedAt, before);
});

for (const failKey of [V.WORKS_KEY, "anime_theme_last_undo_v1"]) {
test(`failed rollback after ${failKey} remains recoverable across page loads, including original auxiliary UI data`, () => {
    const initial = duplicateSeed();
    const store = storage(initial, {
        fail:entry => entry.key === failKey ||
            ([V.HISTORY_KEY, V.WORKS_KEY].includes(entry.key) && entry.value === initial[entry.key])
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const run = runtime(store);
        assert.doesNotThrow(() => run.boot(), "A failed recovery must still load the original data for UI");
        assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, false);
        assert.deepEqual(copy(run.api.animeList), JSON.parse(initial[V.STORAGE_KEY]));
        assert.deepEqual(copy(run.api.window.__quotaTestBootstrap.history()), JSON.parse(initial[V.HISTORY_KEY]),
            "v11 must read original journal history rather than partially remapped persistent history");
        const viewSnapshot = run.api.window.__quotaTestBootstrap.snapshot();
        assert.deepEqual(copy(viewSnapshot.animeList), JSON.parse(initial[V.STORAGE_KEY]));
        assert.deepEqual(copy(viewSnapshot.watchHistory), JSON.parse(initial[V.HISTORY_KEY]));
        assert.match(run.nodes.get("list-waiting").innerHTML, /通用測試作品 101/u);
        assert.equal(run.nodes.get("toast-box").style.display, "block");
        const pending = JSON.parse(store.getItem(PENDING_KEY));
        assert.ok(pending, "The original snapshots stay durably recoverable until rollback succeeds");
        assert.equal(pending.originals[V.HISTORY_KEY], initial[V.HISTORY_KEY]);
        assert.deepEqual(pending.originalList, JSON.parse(initial[V.STORAGE_KEY]));
        for (const key of ["anime_tracker_last_undo_v11", V.WATCH_RESET_UNDO_KEY, V.RESTORE_KEY, "unrelated_user_data"]) {
            assert.equal(store.getItem(key), initial[key]);
        }
        const beforeBlockedWrite = store.trace.length;
        assert.throws(() => run.api.window.__quotaTestBootstrap.persistAnime(), /原始資料|復原|查看/u);
        assert.equal(store.trace.length, beforeBlockedWrite, "Recovery write guard throws before touching persistence or memory");
        assert.deepEqual(copy(run.api.animeList), JSON.parse(initial[V.STORAGE_KEY]));
        const beforeSecondaryBoot = store.trace.length;
        assert.doesNotThrow(() => vm.runInContext(themes, run.api));
        assert.doesNotThrow(() => vm.runInContext(crossMedia, run.api));
        assert.equal(store.trace.length, beforeSecondaryBoot, "Secondary modules must respect pending recovery");
        const mediaSnapshot = run.api.window.CrossMediaTracker.snapshot();
        assert.deepEqual(copy(mediaSnapshot.works), JSON.parse(initial[V.WORKS_KEY]),
            "Cross-media must use the original recovery overlay, not partially committed works");
        assert.deepEqual(copy(mediaSnapshot.mangaReadHistory), JSON.parse(initial[V.MANGA_HISTORY_KEY]));
        assert.equal(store.trace.length, beforeSecondaryBoot, "Recovery snapshot does not write data");
    }
});
}

test("a committed journal left by cleanup failure never rolls back successfully persisted data on refresh", () => {
    const initial = duplicateSeed(), store = storage(initial, { failRemoveKey:PENDING_KEY });
    const first = runtime(store);
    assert.doesNotThrow(() => first.boot());
    assert.equal(first.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
    const committed = JSON.parse(store.getItem(V.STORAGE_KEY));
    const history = store.getItem(V.HISTORY_KEY);
    assert.equal(committed.length, 3);
    assert.equal(committed[0].category, "watching");
    assert.ok(store.getItem(PENDING_KEY), "Commit marker survives unsuccessful internal cleanup");
    const second = runtime(store);
    assert.doesNotThrow(() => second.boot());
    assert.equal(second.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
    assert.deepEqual(copy(second.api.animeList), committed);
    assert.equal(store.getItem(V.HISTORY_KEY), history);
    assert.equal(store.getItem("anime_tracker_last_undo_v11"), initial.anime_tracker_last_undo_v11);
    assert.equal(store.getItem(V.WATCH_RESET_UNDO_KEY), initial[V.WATCH_RESET_UNDO_KEY]);
    assert.equal(JSON.parse(store.getItem(V.STORAGE_KEY)).find(item => item.id === "deleted").deletedAt, before);
});

test("a commit-marker write failure rolls back primary and all auxiliary data instead of reporting success", () => {
    const initial = duplicateSeed(), store = storage(initial, {
        fail:entry => entry.key === PENDING_KEY && JSON.parse(entry.value).state === 1
    });
    failedBootPreservesOriginal(runtime(store), initial);
    assert.ok(store.trace.some(entry => entry.key === PENDING_KEY && !entry.committed && JSON.parse(entry.value).state === 1));
});

test("an interrupted pending journal recovers the original record/history view even while main restoration still exceeds quota", () => {
    const original = duplicateSeed(), initial = { ...original };
    const originalList = JSON.parse(original[V.STORAGE_KEY]);
    initial[V.STORAGE_KEY] = JSON.stringify(originalList.filter(item => item.id !== "duplicate").map(item =>
        item.id === "local-101" ? { ...item, category:"watching" } : item));
    initial[V.HISTORY_KEY] = JSON.stringify(JSON.parse(original[V.HISTORY_KEY]).map(item => ({ ...item, animeId:"preferred" })));
    initial[PENDING_KEY] = JSON.stringify({
        state:0, originals:{ [V.STORAGE_KEY]:original[V.STORAGE_KEY], [V.HISTORY_KEY]:original[V.HISTORY_KEY] }, originalList
    });
    const store = storage(initial, { failKey:V.STORAGE_KEY });
    for (let attempt = 0; attempt < 2; attempt++) {
        const run = runtime(store);
        assert.doesNotThrow(() => run.boot());
        assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, false);
        assert.deepEqual(copy(run.api.animeList), originalList);
        assert.deepEqual(copy(run.api.window.__quotaTestBootstrap.history()), JSON.parse(original[V.HISTORY_KEY]));
        assert.match(run.nodes.get("list-waiting").innerHTML, /通用測試作品 101/u);
        const journal = JSON.parse(store.getItem(PENDING_KEY));
        assert.deepEqual(journal.originalList, originalList);
        assert.equal(journal.originals[V.STORAGE_KEY], original[V.STORAGE_KEY]);
        assert.equal(store.getItem("anime_tracker_last_undo_v11"), original.anime_tracker_last_undo_v11);
        assert.equal(store.getItem(V.WATCH_RESET_UNDO_KEY), original[V.WATCH_RESET_UNDO_KEY]);
    }
});

test("an invalid existing startup journal is retained with a warning and blocks destructive migration writes", () => {
    const initial = duplicateSeed(); initial[PENDING_KEY] = JSON.stringify({ invalid:true });
    const store = storage(initial);
    failedBootPreservesOriginal(runtime(store), initial);
    assert.equal(store.trace.filter(entry => entry.committed).length, 0);
});

test("malformed pending-journal shapes and unknown keys never overwrite stored or unrelated user data", () => {
    const validOriginals = { [V.STORAGE_KEY]:JSON.stringify([anime()]) };
    const malformed = [
        "not-json", "null", "[]", JSON.stringify({ state:9, originals:validOriginals, originalList:[anime()] }),
        JSON.stringify({ state:0, originals:[], originalList:[anime()] }),
        JSON.stringify({ state:0, originals:{ [V.STORAGE_KEY]:{ invalid:true } }, originalList:[anime()] }),
        JSON.stringify({ state:0, originals:{ unrelated_user_data:"unauthorized-overwrite" }, originalList:[anime()] }),
        JSON.stringify({ state:0, originals:{ ...validOriginals, unknown_storage_key:null }, originalList:[anime()] })
    ];
    for (const pending of malformed) {
        const initial = seed([anime()], { [PENDING_KEY]:pending, unknown_storage_key:"preserve unknown" });
        const store = storage(initial), run = runtime(store);
        failedBootPreservesOriginal(run, initial);
        assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__.recoveryPending, true);
        assert.equal(store.trace.filter(entry => entry.committed).length, 0);
        assert.equal(store.getItem("unknown_storage_key"), "preserve unknown");
    }
});

test("invalid stored history shape keeps its bytes and installs a DOM guard before any migration can write", () => {
    const initial = seed([anime()], { [V.HISTORY_KEY]:JSON.stringify({ legacyHistory:"preserve for recovery" }) });
    const store = storage(initial), run = runtime(store);
    assert.doesNotThrow(() => run.boot());
    const startup = run.api.window.__ANIME_STARTUP_STORAGE__;
    assert.equal(startup.persisted, false);
    assert.equal(startup.recoveryPending, true);
    assert.ok(startup.invalidKeys.includes(V.HISTORY_KEY));
    assert.deepEqual(copy(run.api.animeList), JSON.parse(initial[V.STORAGE_KEY]));
    originalKeysUnchanged(store, initial);
    assert.equal(store.trace.filter(entry => entry.committed).length, 0);
    assert.equal(run.api.window.__ANIME_STARTUP_RECOVERY_GUARD__, true);
    const clickGuard = run.trace.handlers.find(entry => entry.type === "click" && entry.capture === true);
    const submitGuard = run.trace.handlers.find(entry => entry.type === "submit" && entry.capture === true);
    assert.ok(clickGuard && submitGuard, "Capture guards precede mutating UI handlers");
    const blocked = { prevented:false, stopped:false };
    clickGuard.handler({ type:"click", target:{ closest:selector => selector === "button" ? {} : null },
        preventDefault:() => { blocked.prevented = true; }, stopImmediatePropagation:() => { blocked.stopped = true; } });
    assert.equal(blocked.prevented, true); assert.equal(blocked.stopped, true);
    const exportClick = { prevented:false };
    clickGuard.handler({ type:"click", target:{ closest:selector => selector.startsWith("#v11-export") ? {} : null },
        preventDefault:() => { exportClick.prevented = true; }, stopImmediatePropagation:() => {} });
    assert.equal(exportClick.prevented, false, "Non-destructive export remains available");
    assert.match(run.nodes.get("list-waiting").innerHTML, /通用測試作品 101/u);
    assert.equal(run.nodes.get("anime-startup-storage-warning").hidden, false);
});

test("failed-startup export preserves raw watched/currentEpisode mismatches, original times and ownership markers", async () => {
    const original = anime();
    original.watched = 8; original.currentEpisode = 3; original.progress = 0.27;
    original.reviewWatched = 6; original.updatedAt = "legacy-updated-at";
    original.addedAt = "legacy-added-at"; original.lastWatchedAt = "legacy-last-watched-at";
    original.reviewStartedAt = "legacy-review-started-at"; original.reviewCompletedAt = "legacy-review-completed-at";
    original.aliases = []; // Force a genuine metadata write without relying on progress normalization.
    delete original.categorySource; delete original.categoryManuallyEdited;
    const initial = seed([original]), store = storage(initial, { failKey:V.STORAGE_KEY }), run = runtime(store);
    failedBootPreservesOriginal(run, initial);
    const writesBeforeExport = store.trace.length;
    assert.doesNotThrow(() => run.api.window.__quotaTestBootstrap.exportBackup());
    assert.equal(run.trace.exportClicks, 1); assert.equal(run.trace.exports.length, 1);
    const backup = JSON.parse(await run.trace.exports[0].text());
    assert.deepEqual(backup[V.STORAGE_KEY], JSON.parse(initial[V.STORAGE_KEY]));
    assert.deepEqual(backup.watchHistory, JSON.parse(initial[V.HISTORY_KEY]));
    assert.deepEqual(backup.works, JSON.parse(initial[V.WORKS_KEY]));
    assert.deepEqual(backup[V.MANGA_HISTORY_KEY], JSON.parse(initial[V.MANGA_HISTORY_KEY]));
    assert.equal(store.trace.length, writesBeforeExport, "Export cannot normalize or persist raw legacy records");
    originalKeysUnchanged(store, initial);
});

test("main-list failure can be retried on refresh without creating a backup or pretending watching was saved", () => {
    const initial = seed(), store = storage(initial, { failKey:V.STORAGE_KEY });
    failedBootPreservesOriginal(runtime(store), initial);
    failedBootPreservesOriginal(runtime(store), initial);
    assert.equal(JSON.parse(store.getItem(V.STORAGE_KEY))[0].category, "waiting");
    assert.equal(store.getItem(CATEGORY_BACKUP), null);
});

test("an old-key-only installation reloads the same original list twice when creating the main key fails", () => {
    const initial = seed();
    initial.anime_list_v8_7 = initial[V.STORAGE_KEY]; delete initial[V.STORAGE_KEY];
    const store = storage(initial, { failKey:V.STORAGE_KEY });
    for (let attempt = 0; attempt < 2; attempt++) {
        const run = runtime(store);
        assert.doesNotThrow(() => run.boot());
        assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, false);
        assert.deepEqual(copy(run.api.animeList), JSON.parse(initial.anime_list_v8_7));
        assert.equal(store.getItem(V.STORAGE_KEY), null, "Failed startup cannot invent a persisted main list");
        originalKeysUnchanged(store, initial);
        assert.match(run.nodes.get("list-waiting").innerHTML, /通用測試作品 101/u);
    }
});

test("v11 bootstrap respects failed startup and performs no second migration/write attempt", () => {
    const initial = seed(), store = storage(initial, { failKey:V.STORAGE_KEY }), run = runtime(store);
    assert.doesNotThrow(() => run.api.loadStoredAnime());
    const attempts = store.trace.length;
    assert.doesNotThrow(() => vm.runInContext(bootstrap, run.api));
    assert.equal(store.trace.length, attempts, "v11 must not bypass the failed startup guard");
    assert.equal(run.api.animeList[0].category, "waiting");
    originalKeysUnchanged(store, initial);
});

test("schema metadata quota failure does not abort a successfully persisted primary category or load", () => {
    const initial = seed([anime()], { anime_tracker_schema_version:"10" });
    const store = storage(initial, { failKey:"anime_tracker_schema_version" }), run = runtime(store);
    assert.doesNotThrow(() => run.boot());
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
    assert.equal(run.api.animeList[0].category, "watching");
    assert.deepEqual(copy(run.api.animeList), JSON.parse(store.getItem(V.STORAGE_KEY)));
    assert.equal(store.getItem("anime_tracker_schema_version"), "10");
    assert.ok(store.trace.some(entry => entry.key === "anime_tracker_schema_version" && !entry.committed));
    assert.equal(run.nodes.get("toast-box").style.display, "block");
    assert.match(run.nodes.get("list-watching").innerHTML, /通用測試作品 101/u);
    for (const [key, value] of Object.entries(initial)) if (key !== V.STORAGE_KEY) assert.equal(store.getItem(key), value);
});

test("Theme Songs and cross-media initializers cannot bypass failed startup, rewrite auxiliary data or delete undo", () => {
    const initial = duplicateSeed(), store = storage(initial, { failKey:V.STORAGE_KEY }), run = runtime(store);
    failedBootPreservesOriginal(run, initial);
    const attempts = store.trace.length;
    assert.doesNotThrow(() => vm.runInContext(themes, run.api, { filename:"production-themes-quota-bootstrap.js" }));
    assert.doesNotThrow(() => vm.runInContext(crossMedia, run.api, { filename:"production-cross-media-quota-bootstrap.js" }));
    assert.ok(run.api.window.ThemeSongs && run.api.window.CrossMediaTracker, "Feature APIs still initialize for usable UI");
    assert.equal(store.trace.length, attempts, "Secondary startup scripts cannot persist blocked migrations");
    originalKeysUnchanged(store, initial);
    assert.doesNotThrow(() => run.api.window.CrossMediaTracker.snapshot());
    assert.equal(store.trace.length, attempts, "A snapshot must not bypass blocked startup persistence");
    originalKeysUnchanged(store, initial);
});

test("successful startup publishes only persisted category change and leaves history, undo and unrelated data untouched", () => {
    const initial = seed(), store = storage(initial), run = runtime(store);
    assert.doesNotThrow(() => run.boot());
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
    assert.equal(run.api.animeList[0].category, "watching");
    assert.deepEqual(copy(run.api.animeList), JSON.parse(store.getItem(V.STORAGE_KEY)));
    const original = JSON.parse(initial[V.STORAGE_KEY])[0], current = run.api.animeList[0];
    for (const field of ["id", "anilistId", "watched", "currentEpisode", "progress", "reviewWatched", "rating",
        "note", "notes", "lastWatchedAt", "reviewStartedAt", "reviewCompletedAt", "createdAt", "addedAt", "customField"]) {
        assert.deepEqual(copy(current[field]), original[field], `Automatic startup preserves ${field}`);
    }
    for (const key of [V.HISTORY_KEY, V.WATCH_RESET_UNDO_KEY, V.RESTORE_KEY, "anime_tracker_last_undo_v11", "unrelated_user_data"]) {
        assert.equal(store.getItem(key), initial[key], `${key} remains unchanged`);
    }
    assert.deepEqual(store.trace.filter(entry => entry.operation !== "set" && entry.key !== PENDING_KEY), []);
    assert.match(run.nodes.get("list-watching").innerHTML, /通用測試作品 101/u);
});

test("successful duplicate migration preserves every watch-history entry and tombstone while remapping references", () => {
    const initial = duplicateSeed(), store = storage(initial), run = runtime(store);
    assert.doesNotThrow(() => run.boot());
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__?.persisted, true);
    const persisted = JSON.parse(store.getItem(V.STORAGE_KEY));
    assert.equal(persisted.length, 3);
    assert.equal(persisted.find(item => item.id === "deleted").deletedAt, before);
    const history = JSON.parse(store.getItem(V.HISTORY_KEY));
    assert.equal(history.length, 11);
    assert.ok(history.every(item => item.animeId === "preferred"));
    assert.deepEqual(history.map(item => item.id), JSON.parse(initial[V.HISTORY_KEY]).map(item => item.id));
    assert.equal(store.getItem("anime_tracker_last_undo_v11"), initial.anime_tracker_last_undo_v11);
    assert.equal(store.getItem(V.WATCH_RESET_UNDO_KEY), initial[V.WATCH_RESET_UNDO_KEY]);
    assert.deepEqual(copy(run.api.animeList), persisted);
    const dataWrites = store.trace.filter(entry => entry.committed && !/backup/u.test(entry.key));
    assert.ok(dataWrites.some(entry => entry.key === V.STORAGE_KEY));
    assert.ok(dataWrites.some(entry => entry.key === V.HISTORY_KEY));
    const journalWrites = store.trace.filter(entry => entry.key === PENDING_KEY && entry.committed);
    assert.equal(journalWrites.length, 2, "Persist a pending snapshot and a commit marker before cleanup");
    assert.equal(journalWrites[0].value.length, journalWrites[1].value.length, "Commit marker must not need more quota than pending journal");
    assert.notEqual(journalWrites[0].value, journalWrites[1].value);
    const mainIndex = store.trace.findIndex(entry => entry.key === V.STORAGE_KEY && entry.committed);
    const journalIndex = store.trace.findIndex(entry => entry.key === PENDING_KEY && entry.committed);
    const historyIndex = store.trace.findIndex(entry => entry.key === V.HISTORY_KEY && entry.committed);
    assert.ok(journalIndex >= 0 && mainIndex > journalIndex && historyIndex > mainIndex);
    assert.equal(store.trace[historyIndex].before[V.STORAGE_KEY], store.getItem(V.STORAGE_KEY));
    assert.equal(store.trace[historyIndex].before[V.HISTORY_KEY], initial[V.HISTORY_KEY],
        "An observable intermediate state exists: a journal is recoverable, not a cross-key atomic transaction");
});
