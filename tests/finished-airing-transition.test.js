"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require(appSourcePath("v11-core.js"));

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const ui = fs.readFileSync(appSourcePath("v11-ui.js"), "utf8");
const at = "2026-11-08T12:00:00.000Z";
const before = "2026-10-01T00:00:00.000Z";
const seconds = value => Date.parse(value) / 1000;
const copy = value => JSON.parse(JSON.stringify(value));

function between(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
    return source.slice(first, last);
}

// Actual category/metadata/migration/startup functions and the actual v11
// persistence wrapper. Browser, clock, network and storage are isolated I/O.
const production = [
    between(html, "function stripDisplayYear", "async function searchWikipedia"),
    between(html, "function normalizeAnimeAliasList", "function deriveAliasVariants"),
    between(html, "function getAniListMediaId", "function getMediaIdentityTitles"),
    between(html, "function normalizeStreamingLinks", "function buildAnimeRecordFromMedia"),
    between(html, "function loadStoredAnime", "function showToast"),
    between(html, "function escapeHtml", "function delay"),
    between(html, "function formatAiringDateTime", "function editAnimeReview"),
    between(ui, "function persistAnime", "function currentSettings"),
    between(ui, "const originalSaveAndRender", "updateProgress = function")
].join("\n");

function watching(identity = 9101, extra = {}) {
    const title = `通用完結判斷作品 ${identity}`;
    return V.migrateList([{
        id:`finished-local-${identity}`, anilistId:identity, source:"anilist", sourceId:String(identity),
        title, displayTitle:title, canonicalTitle:title, groupTitle:title, anilistTitles:{ native:title },
        titleSource:"manual", titleManuallyEdited:true, aliases:[title], format:"TV", status:"RELEASING",
        category:"watching", categorySource:"automatic", categoryManuallyEdited:false,
        episodes:12, totalEpisodes:12, releasedEpisodes:5,
        startDate:{ year:2026, month:7, day:1 }, endDate:null,
        watched:5, currentEpisode:5, progress:5 / 12, reviewWatched:2, reviewSessionActive:false,
        rating:8.5, notes:"保留完整筆記", note:"保留短筆記", customPlatform:"原本平台",
        createdAt:before, addedAt:before, updatedAt:before, lastWatchedAt:before,
        reviewStartedAt:before, reviewCompletedAt:null, trackingLifecycleResetAt:before,
        nextEpisodeAt:"2026-10-03T13:00:00.000Z", nextSeasonDate:"2027-04-01",
        lastMetadataSync:before, customField:{ retained:[1, 2, 3] },
        ...extra
    }], before)[0];
}

function finished(extra = {}) {
    return {
        id:9101, title:{ native:"通用完結判斷作品 9101" }, format:"TV", status:"FINISHED", episodes:12,
        startDate:{ year:2026, month:7, day:1 }, endDate:{ year:2026, month:10, day:31 },
        nextAiringEpisode:null, lastMetadataSync:at,
        ...extra
    };
}

for (const [label, extra] of [
    ["invalid future start month", { startDate:{ year:2027, month:13, day:1 } }],
    ["invalid future end month", { endDate:{ year:2027, month:13, day:1 }, airedEpisode:{ episode:12, airingAt:seconds(before) } }],
    ["impossible end day", { endDate:{ year:2026, month:2, day:30 }, airedEpisode:{ episode:12, airingAt:seconds(before) } }],
    ["boolean total", { episodes:true }],
    ["boolean schedule", { episodes:1, endDate:null, airedEpisode:{ episode:true, airingAt:true } }],
    ["false cached episode", { airedEpisode:false }],
    ["invalid schedule collection", { airingSchedule:{ nodes:"invalid" } }]
]) {
    test(`malformed ${label} cannot become trustworthy completion evidence`, () => {
        const run = runtime();
        assert.equal(run.api.hasTrustedFinishedAiringEvidence(finished(extra), at), false);
        const original = watching();
        run.api.applyMediaMetadata(original, finished(extra), at);
        assert.equal(original.category, "watching");
        assert.equal(run.api.migrateExistingAnimeRecords([original], at).list[0].category, "watching");
    });
}

function storage(list, options = {}) {
    const data = new Map(Object.entries({
        [V.STORAGE_KEY]:JSON.stringify(list),
        [V.HISTORY_KEY]:JSON.stringify([{ id:"history", animeId:list[0]?.id, delta:1, at:before }]),
        [V.WORKS_KEY]:"[]", [V.MANGA_HISTORY_KEY]:"[]",
        anime_event_overrides_v10:"{}", anime_event_anime_overrides_v11:"{}",
        anime_theme_lookup_cache_v1:'{"preserve":"theme-cache"}',
        anime_theme_last_undo_v1:'{"preserve":"theme-undo"}',
        anime_tracker_last_undo_v11:'{"kind":"compact-delete","targetId":"unrelated"}',
        [V.WATCH_RESET_UNDO_KEY]:'{"history":[{"retained":true}]}',
        [V.RESTORE_KEY]:'[{"id":"synthetic-backup","retained":true}]',
        anime_tracker_auto_sync_v11:"1", anime_metadata_sync_v10_1:before
    }));
    const writes = [];
    return {
        writes,
        getItem:key => data.get(String(key)) ?? null,
        setItem(key, value) {
            if (String(key) === options.failKey) throw new DOMException("Synthetic quota failure", "QuotaExceededError");
            writes.push(String(key)); data.set(String(key), String(value));
        },
        removeItem:key => { writes.push(`remove:${key}`); data.delete(String(key)); },
        snapshot:() => Object.fromEntries(data)
    };
}

function runtime(list = [watching()], options = {}) {
    const localStorage = options.storage || storage(list, options);
    const trace = { requests:[], renders:[], refreshes:0, errors:[], warnings:[], toasts:[], timers:0 };
    const calendarStatus = {};
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [options.now || at])); }
        static now() { return Date.parse(options.now || at); }
    }
    const context = vm.createContext({
        animeList:copy(list), animeSyncing:false, AnimeTrackerV11:V, V,
        assertAnimeStorageAvailable:() => {},
        withAnimeStorageWrite:operation => operation(),
        window:{ AnimeTrackerV11:V }, localStorage, Date:Clock,
        STORAGE_KEY:V.STORAGE_KEY, OLD_KEYS:[], ANIME_SYNC_KEY:"anime_metadata_sync_v10_1",
        EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11", EVENT_OVERRIDES_KEY:"anime_event_overrides_v10",
        EVENT_MATCH_DEBUG:false, eventOverrides:{}, eventAnimeOverrides:{}, autoSyncTimer:null,
        document:{ getElementById:id => id === "calendar-status" ? calendarStatus : null, addEventListener:() => {} },
        console:{ error:error => trace.errors.push(error), warn:(...args) => trace.warnings.push(args), info:() => {} },
        setTimeout:() => { trace.timers++; return trace.timers; }, clearTimeout:() => {}, handleSync:() => {},
        delay:async () => {}, showToast:message => trace.toasts.push(message),
        requestAniListMediaPage:async ids => {
            trace.requests.push(Array.from(ids));
            return options.request ? options.request(ids) : [finished()];
        },
        refreshV11:() => trace.refreshes++,
        renderList:() => trace.renders.push(copy(context.animeList))
    });
    vm.runInContext(production, context, { filename:"production-finished-airing.js" });
    return { api:context, localStorage, trace };
}

const preservedFields = ["id", "anilistId", "watched", "currentEpisode", "progress", "reviewWatched", "reviewSessionActive",
    "rating", "notes", "note", "createdAt", "addedAt", "lastWatchedAt", "reviewStartedAt", "reviewCompletedAt",
    "trackingLifecycleResetAt", "nextEpisodeAt", "nextSeasonDate", "customPlatform", "customField"];

function assertPreserved(actual, original) {
    for (const field of preservedFields) assert.deepEqual(copy(actual[field]), copy(original[field]), `${field} must be preserved`);
}

test("FINISHED with a known episode total, fresh observation and a completed end day is trusted", () => {
    const { api } = runtime();
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished(), at), true);
    assert.equal(api.getAutomaticCategoryTransition(watching(), finished(), at), "backlog");
});

test("validated past final airing proves completion without a fuzzy end date", () => {
    const { api } = runtime();
    for (const evidence of [
        { airedEpisode:{ episode:12, airingAt:seconds("2026-10-31T13:00:00Z") } },
        { airingSchedule:{ nodes:[{ episode:12, airingAt:seconds("2026-10-31T13:00:00Z") }] } }
    ]) assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ endDate:null, ...evidence }), at), true);
});

test("automatic finished transition changes one category and its version but no viewing or historical fields", () => {
    const { api } = runtime(), item = watching(9101, {
        relations:[{ relationType:"SEQUEL", node:{ id:9102, type:"ANIME", format:"TV", title:{ native:"通用第二季" } } }],
        manuallyLinkedMedia:["unrelated-film"]
    }), beforeItem = copy(item);
    assert.equal(api.applyAutomaticCategoryFromMedia(item, finished(), at), true);
    assert.deepEqual(item, { ...beforeItem, category:"backlog", updatedAt:at });
    assertPreserved(item, beforeItem);
    assert.equal(V.isAnimeCurrentlyWatching(item), true, "Aired completion does not complete the user's 5/12 viewing");
    const saved = copy(item);
    assert.equal(api.applyAutomaticCategoryFromMedia(item, finished(), "2026-11-08T12:00:01.000Z"), false);
    assert.deepEqual(item, saved, "Repeated category evaluation is idempotent");
});

for (const [label, patch] of [
    ["RELEASING status", { status:"RELEASING" }],
    ["unknown status", { status:"UNKNOWN" }],
    ["missing status", { status:null }],
    ["cancelled status", { status:"CANCELLED" }],
    ["unknown episode count", { episodes:null }],
    ["zero episode count", { episodes:0 }],
    ["fractional episode count", { episodes:12.5 }],
    ["negative episode count", { episodes:-1 }],
    ["missing observation time", { lastMetadataSync:null }],
    ["invalid observation time", { lastMetadataSync:"not-a-date" }],
    ["outdated observation", { lastMetadataSync:"2026-11-06T12:00:00.000Z" }],
    ["future observation time", { lastMetadataSync:"2026-11-08T12:00:00.001Z" }],
    ["past premiere alone", { endDate:null }],
    ["partial end date", { endDate:{ year:2026, month:10, day:null } }],
    ["invalid calendar date", { endDate:{ year:2026, month:2, day:30 } }],
    ["today's end date without exact final airing", { endDate:{ year:2026, month:11, day:8 } }],
    ["future end date", { endDate:{ year:2026, month:12, day:1 } }],
    ["future premiere contradicting FINISHED", { startDate:{ year:2027, month:1, day:1 } }],
    ["end date earlier than premiere", { startDate:{ year:2026, month:11, day:1 } }],
    ["future next episode", { nextAiringEpisode:{ episode:13, airingAt:seconds("2026-11-09T12:00:00Z") } }],
    ["explicit incomplete released count", { releasedEpisodes:11 }],
    ["explicit released count above total", { releasedEpisodes:13 }],
    ["final airing count above total", { airedEpisode:{ episode:13, airingAt:seconds("2026-10-31T13:00:00Z") } }],
    ["marked aired episode still in the future", { airedEpisode:{ episode:12, airingAt:seconds("2026-11-09T12:00:00Z") } }],
    ["airing schedule still has a future final", { airingSchedule:{ nodes:[{ episode:12, airingAt:seconds("2026-11-09T12:00:00Z") }] } }]
]) {
    test(`${label} cannot auto-finish a watching anime`, () => {
        const { api } = runtime(), item = watching(), original = copy(item), media = finished(patch);
        assert.equal(api.hasTrustedFinishedAiringEvidence(media, at), false);
        assert.equal(api.getAutomaticCategoryTransition(item, media, at), null);
        assert.equal(api.applyAutomaticCategoryFromMedia(item, media, at), false);
        assert.deepEqual(item, original);
    });
}

test("the six-hour metadata freshness boundary is inclusive and one millisecond older is rejected", () => {
    const { api } = runtime();
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ lastMetadataSync:"2026-11-08T06:00:00.000Z" }), at), true);
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ lastMetadataSync:"2026-11-08T05:59:59.999Z" }), at), false);
});

test("a reported count synthesized from FINISHED cannot replace independent final-airing evidence", () => {
    const { api } = runtime();
    const media = finished({ endDate:null, releasedEpisodes:12 });
    assert.equal(api.releasedEpisodeCount(media, {}, at), 12);
    assert.equal(api.hasTrustedFinishedAiringEvidence(media, at), false);
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ endDate:null,
        airingSchedule:{ nodes:[{ episode:1, airingAt:seconds("2026-07-01T13:00:00Z") }] } }), at), false,
    "A perPage=1 airing response must not be assumed to contain the final episode");
});

for (const [label, ownership] of [
    ["manual source", { categorySource:"manual", categoryManuallyEdited:false }],
    ["manual flag", { categorySource:"automatic", categoryManuallyEdited:true }],
    ["missing both markers", { categorySource:undefined, categoryManuallyEdited:undefined }],
    ["missing manual flag", { categorySource:"automatic", categoryManuallyEdited:undefined }],
    ["missing source", { categorySource:undefined, categoryManuallyEdited:false }],
    ["unknown source", { categorySource:"legacy-import", categoryManuallyEdited:false }]
]) {
    test(`${label} prevents automatic watching-to-backlog ownership changes`, () => {
        const { api } = runtime(), item = watching(9101, ownership), original = copy(item);
        assert.equal(api.getAutomaticCategoryTransition(item, finished(), at), null);
        assert.equal(api.applyAutomaticCategoryFromMedia(item, finished(), at), false);
        assert.deepEqual(copy(item), original);
    });
}

for (const [label, extra] of [
    ["completed", { category:"completed" }], ["review", { category:"review", reviewSessionActive:true }],
    ["deleted", { deletedAt:before, deletedFromCategory:"watching" }]
]) {
    test(`${label} records keep their existing classification and user data`, () => {
        const { api } = runtime(), item = watching(9101, extra), original = copy(item);
        assert.equal(api.applyAutomaticCategoryFromMedia(item, finished(), at), false);
        assert.deepEqual(item, original);
    });
}

test("live metadata observation persists endDate and uses fetch time rather than AniList's historical updatedAt", () => {
    const { api } = runtime(), item = watching(), original = copy(item);
    const media = finished({ updatedAt:seconds("2020-01-01T00:00:00Z") });
    delete media.lastMetadataSync;
    api.applyMediaMetadata(item, media, at);
    assert.equal(item.category, "backlog");
    assert.equal(item.lastMetadataSync, at);
    assert.equal(item.updatedAt, at);
    assert.deepEqual(copy(item.endDate), { year:2026, month:10, day:31 });
    assertPreserved(item, original);
    const snapshot = api.buildStoredAnimeMediaSnapshot(item);
    assert.equal(snapshot.lastMetadataSync, at);
    assert.deepEqual(copy(snapshot.endDate), { year:2026, month:10, day:31 });
});

test("fresh stored finished evidence transitions during startup and remains backlog after reload", () => {
    const original = watching(9101, { status:"FINISHED", endDate:{ year:2026, month:10, day:31 }, releasedEpisodes:12, lastMetadataSync:at });
    const run = runtime([original]);
    run.api.loadStoredAnime();
    assert.equal(run.api.animeList[0].category, "backlog");
    assert.equal(run.api.animeList[0].updatedAt, at);
    assertPreserved(run.api.animeList[0], original);
    assert.equal(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0].category, "backlog");
    const reload = runtime([], { storage:run.localStorage });
    reload.api.loadStoredAnime();
    assert.equal(reload.api.animeList[0].category, "backlog");
    assertPreserved(reload.api.animeList[0], original);
});

test("stale stored FINISHED evidence remains watching until a fresh fetch confirms completion", async () => {
    const original = watching(9101, { status:"FINISHED", endDate:{ year:2026, month:10, day:31 }, releasedEpisodes:12, lastMetadataSync:before });
    const run = runtime([original]);
    run.api.loadStoredAnime();
    assert.equal(run.api.animeList[0].category, "watching");
    await run.api.syncAnimeMetadata(true);
    assert.equal(run.trace.errors.length, 0);
    assert.equal(run.api.animeList[0].category, "backlog");
    assert.equal(run.api.animeList[0].lastMetadataSync, at);
    assertPreserved(run.api.animeList[0], original);
});

test("startup cannot manufacture a trusted final total from a released count on an unknown-total watching record", () => {
    const original = watching(9101, { status:"FINISHED", episodes:null, totalEpisodes:null,
        endDate:{ year:2026, month:10, day:31 }, releasedEpisodes:12, lastMetadataSync:at });
    const run = runtime([original]);
    run.api.loadStoredAnime();
    assert.equal(run.api.animeList[0].category, "watching");
    assert.equal(run.api.window.__ANIME_EXISTING_MEDIA_MIGRATION__.categoryChanged, 0);
    assertPreserved(run.api.animeList[0], original);
});

test("a finished media response updates only that anime, not another season in the same series", async () => {
    const series = { seriesId:"generic-series", seriesKey:"generic-series", groupTitle:"共同系列" };
    const list = [watching(9101, series), watching(9102, series)];
    const run = runtime(list);
    const initial = run.localStorage.snapshot();
    await run.api.syncAnimeMetadata(true);
    assert.equal(run.trace.errors.length, 0);
    assert.deepEqual(run.trace.requests, [[9101, 9102]]);
    assert.equal(run.api.animeList[0].category, "backlog");
    assert.equal(run.api.animeList[1].category, "watching");
    assert.equal(run.api.animeList[1].updatedAt, before);
    assertPreserved(run.api.animeList[0], list[0]);
    assertPreserved(run.api.animeList[1], list[1]);
    for (const key of [V.HISTORY_KEY, V.WATCH_RESET_UNDO_KEY, V.RESTORE_KEY, "anime_tracker_last_undo_v11", "anime_theme_last_undo_v1"])
        assert.equal(run.localStorage.getItem(key), initial[key], `Classification does not rewrite ${key}`);
    assert.equal(run.trace.timers, 1, "The saved metadata change uses the existing cloud-sync debounce");
});

test("failed main persistence cannot publish or sync an automatic finished transition", async () => {
    const list = [watching()], store = storage(list, { failKey:V.STORAGE_KEY }), initial = store.snapshot();
    const run = runtime(list, { storage:store });
    await run.api.syncAnimeMetadata(true);
    assert.deepEqual(copy(run.api.animeList), list);
    assert.deepEqual(store.snapshot(), initial);
    assert.equal(run.trace.renders.length, 0);
    assert.equal(run.trace.refreshes, 0);
    assert.equal(run.trace.timers, 0);
    assert.equal(run.trace.errors.length, 1);
    assert.ok(run.trace.toasts.every(message => !/同步完成|已完成同步/u.test(message)));
});

test("startup quota failure retains the original watching record without claiming the transition completed", () => {
    const original = watching(9101, { status:"FINISHED", endDate:{ year:2026, month:10, day:31 }, releasedEpisodes:12, lastMetadataSync:at });
    const store = storage([original], { failKey:V.STORAGE_KEY }), initial = store.snapshot();
    const run = runtime([original], { storage:store });
    assert.doesNotThrow(() => run.api.loadStoredAnime());
    assert.equal(run.api.animeList[0].category, "watching");
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__.persisted, false);
    assert.deepEqual(store.snapshot(), initial);
    assertPreserved(run.api.animeList[0], original);
    assert.ok(run.trace.warnings.length > 0);
});

test("stored positive proof does not bypass the required fresh independent finish evidence", () => {
    const { api } = runtime();
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ endDate:null, finishedAiringEvidence:true }), at), false);
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ finishedAiringEvidence:true, lastMetadataSync:before }), at), false);
    assert.equal(api.hasTrustedFinishedAiringEvidence(finished({ finishedAiringEvidence:false }), at), false);
});

for (const [label, contradiction] of [
    ["missing AniList total", { episodes:null }],
    ["incomplete released count", { releasedEpisodes:11 }],
    ["future marked-airing entry", { airedEpisode:{ episode:12, airingAt:seconds("2026-11-09T12:00:00Z") } }],
    ["future final schedule entry", { airingSchedule:{ nodes:[{ episode:12, airingAt:seconds("2026-11-09T12:00:00Z") }] } }],
    ["future next episode", { nextAiringEpisode:{ episode:13, airingAt:seconds("2026-11-09T12:00:00Z") } }]
]) {
    test(`${label} stays protected after live metadata persistence and startup normalization`, async () => {
        const original = watching(), media = finished(contradiction);
        delete media.lastMetadataSync;
        const run = runtime([original], { request:async () => [media] });
        await run.api.syncAnimeMetadata(true);
        assert.equal(run.trace.errors.length, 0);
        assert.equal(run.api.animeList[0].category, "watching");
        assert.equal(run.api.animeList[0].finishedAiringEvidence, false,
            "Lossy schedule/count normalization cannot discard a negative metadata proof");
        assertPreserved(run.api.animeList[0], original);
        const reloaded = runtime([], { storage:run.localStorage });
        reloaded.api.loadStoredAnime();
        assert.equal(reloaded.api.animeList[0].category, "watching");
        assert.equal(reloaded.api.animeList[0].finishedAiringEvidence, false);
        assertPreserved(reloaded.api.animeList[0], original);
        const fresh = finished(); delete fresh.lastMetadataSync;
        reloaded.api.applyMediaMetadata(reloaded.api.animeList[0], fresh, at);
        assert.equal(reloaded.api.animeList[0].category, "backlog", "A genuinely fresh valid response can replace negative proof");
        assert.equal(reloaded.api.animeList[0].finishedAiringEvidence, true);
    });
}
