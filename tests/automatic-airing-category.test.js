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
const at = "2026-10-08T13:00:00.000Z"; // 21:00 in Taiwan, before the advertised second episode.
const before = "2026-10-01T00:00:00.000Z";
const seconds = value => Date.parse(value) / 1000;
const copy = value => JSON.parse(JSON.stringify(value));

function between(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
    return source.slice(first, last);
}

// Run the real metadata, migration, startup, sync, renderer and v11 persistence wrapper.
// Only browser I/O and network responses are replaced; no category logic is reimplemented.
const production = [
    between(html, "function stripDisplayYear", "async function searchWikipedia"),
    between(html, "function normalizeAnimeAliasList", "function deriveAliasVariants"),
    between(html, "function getAniListMediaId", "function getMediaIdentityTitles"),
    between(html, "function normalizeStreamingLinks", "function buildAnimeRecordFromMedia"),
    between(html, "function loadStoredAnime", "function showToast"),
    between(html, "function escapeHtml", "function delay"),
    between(html, "function formatAiringDateTime", "function editAnimeReview"),
    between(html, "function getAnimeTitlePresentation", "function normalizeAnimeSearchText"),
    between(ui, "function touch", "function currentSettings"),
    between(ui, "const originalSaveAndRender", "const originalMoveCategory")
].join("\n");

function fixture(identity = 101, extra = {}) {
    const title = `通用作品 ${identity}`;
    return V.migrateList([V.migrateAnime({
        id:`local-${identity}`, anilistId:identity, source:"anilist", sourceId:String(identity),
        title, displayTitle:title, canonicalTitle:title, groupTitle:title,
        titleSource:"manual", titleManuallyEdited:true, anilistTitles:{ native:title },
        aliases:[title], format:"TV", status:"NOT_YET_RELEASED",
        startDate:{ year:2026, month:10, day:null }, year:2026, airDate:"2026年10月",
        category:"waiting", categorySource:"automatic", categoryManuallyEdited:false,
        watched:0, currentEpisode:0, progress:0, reviewWatched:0,
        rating:9, notes:"使用者筆記", note:"使用者筆記", customPlatform:"自訂平台",
        createdAt:before, addedAt:before, updatedAt:before, lastWatchedAt:null,
        ...extra
    }, before)], before)[0];
}

function media(identity = 101, extra = {}) {
    return {
        id:identity, title:{ native:`通用作品 ${identity}` }, format:"TV", status:"RELEASING",
        episodes:12, startDate:{ year:2026, month:10, day:null },
        releasedEpisodes:1,
        nextAiringEpisode:{ episode:2, airingAt:seconds("2026-10-08T14:56:00.000Z"), timeUntilAiring:6960 },
        ...extra
    };
}

function storage(seed = {}, failKey = "") {
    const data = new Map(Object.entries(seed));
    const writes = [];
    return {
        data, writes,
        getItem:key => data.get(String(key)) ?? null,
        setItem(key, value) {
            if (key === failKey) throw new DOMException("Quota exceeded", "QuotaExceededError");
            writes.push(String(key)); data.set(String(key), String(value));
        },
        removeItem:key => data.delete(String(key)),
        snapshot:() => Object.fromEntries(data)
    };
}

function runtime(list = [fixture()], options = {}) {
    const localStorage = options.storage || storage({
        [V.STORAGE_KEY]:JSON.stringify(list),
        [V.HISTORY_KEY]:JSON.stringify([{ id:"history", animeId:list[0]?.id, delta:1, at:before }]),
        [V.WORKS_KEY]:JSON.stringify([{ workId:"work", title:"作品", mediaEntries:[] }]),
        anime_theme_lookup_cache_v1:JSON.stringify({ cache:"preserve" }),
        anime_tracker_last_undo_v11:JSON.stringify({ kind:"compact-delete", targetId:"other" })
    });
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [at])); }
        static now() { return Date.parse(at); }
    }
    const trace = { requests:[], renders:0, refreshes:0, cards:[], errors:[], warnings:[], toasts:[] };
    const calendarStatus = {};
    const context = vm.createContext({
        animeList:copy(list), animeSyncing:false, AnimeTrackerV11:V, V,
        window:{ AnimeTrackerV11:V }, localStorage, Date:Clock,
        STORAGE_KEY:V.STORAGE_KEY, OLD_KEYS:[], ANIME_SYNC_KEY:"anime_metadata_sync_v10_1",
        EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v10",
        EVENT_OVERRIDES_KEY:"anime_event_overrides_v10", EVENT_MATCH_DEBUG:false,
        eventOverrides:{}, eventAnimeOverrides:{}, autoSyncTimer:null,
        document:{ getElementById:id => id === "calendar-status" ? calendarStatus : null },
        console:{ error:error => trace.errors.push(error), warn:(...args) => trace.warnings.push(args), info:() => {} },
        setTimeout:() => 1, clearTimeout:() => {}, handleSync:() => {},
        delay:async () => {}, showToast:value => trace.toasts.push(value),
        requestAniListMediaPage:async ids => {
            trace.requests.push(Array.from(ids));
            return options.request ? options.request(ids) : [media()];
        },
        refreshV11:() => trace.refreshes++,
        renderList:() => {
            trace.renders++;
            trace.cards = context.animeList.filter(item => !item.deletedAt).map(item => context.buildAnimeItem(item));
        }
    });
    vm.runInContext(production, context, { filename:"production-airing-category.js" });
    return { api:context, localStorage, trace, calendarStatus };
}

const trackingFields = ["id", "anilistId", "source", "sourceId", "watched", "currentEpisode", "progress",
    "reviewWatched", "reviewSessionActive", "reviewStartedAt", "reviewCompletedAt", "lastWatchedAt",
    "rating", "note", "notes", "createdAt", "addedAt", "themeSongs", "customPlatform"];
const tracking = item => Object.fromEntries(trackingFields.map(key => [key, item[key]]));

test("A: automatic waiting plus RELEASING and episode 2 becomes watching, preserving progress", () => {
    const { api } = runtime();
    const anime = fixture(), original = copy(tracking(anime));
    api.applyMediaMetadata(anime, media(), at);
    assert.equal(anime.category, "watching");
    assert.equal(anime.releasedEpisodes, 1);
    assert.equal(anime.watched, 0);
    assert.equal(anime.currentEpisode, 0);
    assert.deepEqual(tracking(anime), original);
    assert.equal(anime.categorySource, "automatic");
    assert.equal(anime.categoryManuallyEdited, false);
    assert.deepEqual(copy(anime.startDate), { year:2026, month:10, day:null });
    assert.equal(anime.airDate, "2026年10月");
});

test("B: a genuinely pending first episode remains waiting", () => {
    const { api } = runtime();
    const anime = fixture();
    const pending = media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:0,
        nextAiringEpisode:{ episode:1, airingAt:seconds("2026-10-10T14:00:00.000Z") } });
    assert.equal(api.resolveMediaAiringState(pending, at), "not-yet-released");
    api.applyMediaMetadata(anime, pending, at);
    assert.equal(anime.category, "waiting");
    assert.equal(anime.releasedEpisodes, 0);
});

test("C: stale status with explicit, consistent released metadata becomes watching", () => {
    const { api } = runtime();
    const anime = fixture();
    api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED" }), at);
    assert.equal(anime.category, "watching");
    assert.equal(api.isMediaClearlyNotYetReleased(media(101, { status:"NOT_YET_RELEASED" }), at), false);
});

test("C: a timestamped aired episode overrides stale status and survives migration", () => {
    const { api } = runtime();
    const anime = fixture();
    const stale = media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:undefined,
        airingSchedule:{ nodes:[{ episode:1, airingAt:seconds("2026-10-01T14:56:00.000Z") }] } });
    api.applyMediaMetadata(anime, stale, at);
    assert.equal(anime.category, "watching");
    assert.equal(anime.releasedEpisodes, 1);
    const restored = copy(anime); restored.category = "waiting";
    const migration = api.migrateExistingAnimeRecords([restored], at);
    assert.equal(migration.list[0].category, "watching");
    assert.deepEqual(copy(migration.list[0].airedEpisode), { episode:1, airingAt:seconds("2026-10-01T14:56:00.000Z") });
});

test("C: an elapsed next-episode timestamp is evidence, without a guessed weekly cadence", () => {
    const { api } = runtime();
    const stale = media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:undefined,
        nextAiringEpisode:{ episode:1, airingAt:seconds(at) - 60, timeUntilAiring:-60 } });
    const anime = fixture();
    api.applyMediaMetadata(anime, stale, at);
    assert.equal(anime.category, "watching");
    assert.equal(anime.releasedEpisodes, 1);
});

test("C: a consistent numbered next episode after an explicit past premiere day confirms release", () => {
    const { api } = runtime();
    const anime = fixture();
    api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:undefined,
        startDate:{ year:2026, month:10, day:1 } }), at);
    assert.equal(anime.category, "watching");
    assert.equal(anime.releasedEpisodes, 1);
    const stored = copy(anime); stored.category = "waiting"; delete stored.releasedEpisodes;
    assert.equal(api.migrateExistingAnimeRecords([stored], at).list[0].category, "watching");
});

test("a numbered future episode on the premiere day does not guess the first episode's airtime", () => {
    const { api } = runtime();
    const anime = fixture();
    api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:undefined,
        startDate:{ year:2026, month:10, day:8 } }), at);
    assert.equal(anime.category, "waiting");
});

test("an impossible premiere date cannot corroborate a future episode number", () => {
    const { api } = runtime();
    const anime = fixture();
    api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:undefined,
        startDate:{ year:2026, month:2, day:31 } }), at);
    assert.equal(anime.category, "waiting");
});

test("C: contradictory timestamps, a future schedule and episode number alone are insufficient", () => {
    const { api } = runtime();
    for (const next of [
        { episode:1, airingAt:seconds(at) - 600, timeUntilAiring:3600 },
        { episode:2, airingAt:seconds(at) + 30 * 86400 },
        { episode:2 },
        { episode:1, airingAt:"invalid" },
        { episode:0, airingAt:seconds(at) - 1 }
    ]) {
        const anime = fixture();
        api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:undefined, nextAiringEpisode:next }), at);
        assert.equal(anime.category, "waiting");
        assert.equal(anime.releasedEpisodes, 0);
    }
});

test("a month, a past premiere date or an unknown status cannot promote waiting", () => {
    const { api } = runtime();
    for (const startDate of [{ year:2026, month:10 }, { year:2025, month:1, day:1 }, {}]) {
        const anime = fixture();
        api.applyMediaMetadata(anime, media(101, { status:"UNKNOWN", releasedEpisodes:undefined, nextAiringEpisode:null, startDate }), at);
        assert.equal(anime.category, "waiting");
    }
});

test("cached released counts conflicting with a pending first episode or future premiere are conservative", () => {
    const { api } = runtime();
    const conflicting = media(101, { status:"NOT_YET_RELEASED",
        nextAiringEpisode:{ episode:1, airingAt:seconds(at) + 3600 } });
    assert.equal(api.resolveMediaAiringState(conflicting, at), "not-yet-released");
    assert.equal(api.resolveMediaAiringState(media(101, { status:"NOT_YET_RELEASED", startDate:{ year:2027, month:1, day:1 } }), at), "not-yet-released");
});

test("D: either manual marker protects the chosen category", () => {
    const { api } = runtime();
    for (const markers of [{ categorySource:"manual", categoryManuallyEdited:false },
        { categorySource:"automatic", categoryManuallyEdited:true }, { categorySource:"manual", categoryManuallyEdited:true }]) {
        const anime = fixture(101, markers);
        api.applyMediaMetadata(anime, media(), at);
        assert.equal(anime.category, "waiting");
        assert.equal(anime.categorySource, markers.categorySource);
        assert.equal(anime.categoryManuallyEdited, markers.categoryManuallyEdited);
    }
});

test("missing legacy category markers are preserved and reported without inventing ownership", () => {
    const { api } = runtime();
    for (const absent of [["categorySource"], ["categoryManuallyEdited"], ["categorySource", "categoryManuallyEdited"]]) {
        const anime = fixture(101, { status:"RELEASING" });
        absent.forEach(field => delete anime[field]);
        const result = api.migrateExistingAnimeRecords([anime], at);
        assert.equal(result.list[0].category, "waiting");
        absent.forEach(field => assert.equal(Object.hasOwn(result.list[0], field), false));
        assert.equal(result.report.categoryReviewRequired.length, 1);
        assert.equal(result.report.categoryReviewRequired[0].suggestedCategory, "watching");
        assert.equal(result.report.categoryReviewRequired[0].reason, "missing-automatic-category-markers");
        assert.equal(api.migrateExistingAnimeRecords(result.list, at).changed, false);
    }
});

test("startup duplicate merging preserves missing and unknown category ownership", () => {
    for (const markers of [{}, { categorySource:"automatic" },
        { categorySource:"automatic", categoryManuallyEdited:null },
        { categorySource:"automatic", categoryManuallyEdited:"unknown" },
        { categorySource:"unknown", categoryManuallyEdited:false }, { categoryManuallyEdited:false }]) {
        const canonical = fixture(101, { id:"legacy-canonical", status:"RELEASING" });
        const owner = fixture(101, { id:"legacy-owner", status:"RELEASING", updatedAt:at });
        delete owner.categorySource;
        delete owner.categoryManuallyEdited;
        Object.assign(owner, markers);
        const { api, localStorage } = runtime([canonical, owner]);
        const history = localStorage.getItem(V.HISTORY_KEY);
        const undo = localStorage.getItem("anime_tracker_last_undo_v11");
        api.loadStoredAnime();
        assert.equal(api.window.__ANIME_DUPLICATE_RECONCILIATION__.mergedCount, 1);
        assert.equal(api.animeList.length, 1);
        const merged = api.animeList[0];
        assert.equal(merged.id, canonical.id);
        assert.equal(merged.category, "waiting");
        for (const field of ["categorySource", "categoryManuallyEdited"]) {
            assert.equal(Object.hasOwn(merged, field), Object.hasOwn(markers, field));
            assert.equal(merged[field], markers[field]);
        }
        assert.equal(api.window.__ANIME_EXISTING_MEDIA_MIGRATION__.categoryReviewRequired.length, 1);
        assert.equal(api.window.__ANIME_EXISTING_MEDIA_MIGRATION__.categoryReviewRequired[0].suggestedCategory, "watching");
        assert.equal(localStorage.getItem(V.HISTORY_KEY), history);
        assert.equal(localStorage.getItem("anime_tracker_last_undo_v11"), undo);
        const persisted = localStorage.getItem(V.STORAGE_KEY);
        api.loadStoredAnime();
        assert.equal(localStorage.getItem(V.STORAGE_KEY), persisted);
    }
});

test("startup duplicate merging retains an explicitly automatic category owner's false marker", () => {
    const canonical = fixture(101, { id:"legacy-canonical", status:"RELEASING" });
    delete canonical.categoryManuallyEdited;
    const owner = fixture(101, { id:"legacy-owner", status:"RELEASING", updatedAt:at });
    const { api } = runtime([canonical, owner]);
    api.loadStoredAnime();
    assert.equal(api.animeList.length, 1);
    assert.equal(api.animeList[0].id, canonical.id);
    assert.equal(api.animeList[0].category, "watching");
    assert.equal(api.animeList[0].categorySource, "automatic");
    assert.equal(api.animeList[0].categoryManuallyEdited, false);
    assert.equal(api.window.__ANIME_EXISTING_MEDIA_MIGRATION__.categoryReviewRequired, undefined);
});

test("startup duplicate merging prioritizes either manual category marker over newer automatic data", () => {
    for (const markers of [{ categorySource:"manual", categoryManuallyEdited:false },
        { categorySource:"automatic", categoryManuallyEdited:true }]) {
        const manual = fixture(101, { id:"legacy-manual", status:"RELEASING", ...markers });
        const newer = fixture(101, { id:"legacy-newer", status:"RELEASING", updatedAt:at });
        const { api } = runtime([manual, newer]);
        api.loadStoredAnime();
        assert.equal(api.animeList.length, 1);
        assert.equal(api.animeList[0].category, "waiting");
        assert.equal(api.animeList[0].categorySource, "manual");
        assert.equal(api.animeList[0].categoryManuallyEdited, true);
        assert.equal(api.window.__ANIME_EXISTING_MEDIA_MIGRATION__.categoryReviewRequired, undefined);
    }
});

test("backup and cloud merging preserve missing category markers of the newer same-ID record", () => {
    for (const markers of [{}, { categorySource:"automatic" },
        { categorySource:"automatic", categoryManuallyEdited:"unknown" }]) {
        const local = fixture(101, { id:"same-local-id", status:"RELEASING" });
        const incoming = fixture(101, { id:local.id, status:"RELEASING", updatedAt:at });
        delete incoming.categorySource;
        delete incoming.categoryManuallyEdited;
        Object.assign(incoming, markers);
        const current = { animeList:[local], works:[], watchHistory:[] };
        const backup = V.createBackup({ animeList:[incoming], works:[], watchHistory:[] });
        for (const merged of [V.importBackup(current, backup, "merge"),
            V.mergeCloudPayload(current, { animeList:[incoming], works:[], watchHistory:[] }, "merge")]) {
            const { api } = runtime(copy(merged.animeList));
            api.loadStoredAnime();
            assert.equal(api.animeList.length, 1);
            assert.equal(api.animeList[0].category, "waiting");
            for (const field of ["categorySource", "categoryManuallyEdited"]) {
                assert.equal(Object.hasOwn(api.animeList[0], field), Object.hasOwn(markers, field));
                assert.equal(api.animeList[0][field], markers[field]);
            }
            assert.equal(api.window.__ANIME_EXISTING_MEDIA_MIGRATION__.categoryReviewRequired.length, 1);
        }
    }
});

test("same-ID merge keeps explicit automatic and manual ownership with the winning record", () => {
    for (const markers of [{ categorySource:"automatic", categoryManuallyEdited:false },
        { categorySource:"manual", categoryManuallyEdited:false },
        { categorySource:"automatic", categoryManuallyEdited:true }]) {
        const local = fixture(101, { id:"same-local-id", status:"RELEASING" });
        delete local.categorySource;
        delete local.categoryManuallyEdited;
        const newer = fixture(101, { id:local.id, status:"RELEASING", updatedAt:at, ...markers });
        for (const list of [V.mergeById([local], [newer]), V.mergeById([newer], [local])]) {
            const { api } = runtime(copy(list));
            api.loadStoredAnime();
            assert.equal(api.animeList[0].category,
                markers.categorySource === "automatic" && markers.categoryManuallyEdited === false ? "watching" : "waiting");
            assert.equal(api.animeList[0].categorySource, markers.categorySource);
            assert.equal(api.animeList[0].categoryManuallyEdited, markers.categoryManuallyEdited);
        }
    }
});

test("E: watching never regresses under a stale NOT_YET_RELEASED response", () => {
    const { api } = runtime();
    const anime = fixture(101, { category:"watching", watched:3, currentEpisode:3 });
    const original = copy(tracking(anime));
    api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:0, nextAiringEpisode:null }), at);
    assert.equal(anime.category, "watching");
    assert.deepEqual(tracking(anime), original);
    assert.equal(api.migrateExistingAnimeRecords([anime], at).list[0].category, "watching");
});

test("F: differing existing watched/currentEpisode values are never normalized by metadata sync", async () => {
    const anime = fixture(101, { watched:2, currentEpisode:0, progress:2 });
    const original = copy(tracking(anime));
    const { api, localStorage } = runtime([anime]);
    await api.syncAnimeMetadata(true);
    assert.equal(api.animeList[0].category, "watching");
    assert.deepEqual(copy(tracking(api.animeList[0])), original);
    assert.deepEqual(tracking(JSON.parse(localStorage.getItem(V.STORAGE_KEY))[0]), original);
});

test("G: completed/review category, original progress and review lifecycle resist all broadcast states", () => {
    const { api } = runtime();
    for (const category of ["completed", "review"]) for (const status of ["RELEASING", "FINISHED", "NOT_YET_RELEASED"]) {
        const anime = fixture(102, { category, watched:12, currentEpisode:12,
            reviewWatched:4, reviewSessionActive:category === "review", reviewStartedAt:before });
        const original = copy(tracking(anime));
        api.applyMediaMetadata(anime, media(102, { status }), at);
        assert.equal(anime.category, category);
        assert.deepEqual(tracking(anime), original);
        assert.equal(api.migrateExistingAnimeRecords([anime], at).list[0].category, category);
    }
});

test("FINISHED waiting follows existing backlog policy; cancelled waiting is retained", () => {
    const { api } = runtime();
    const finished = fixture();
    api.applyMediaMetadata(finished, media(101, { status:"FINISHED", nextAiringEpisode:null }), at);
    assert.equal(finished.category, "backlog");
    assert.equal(finished.watched, 0);
    assert.equal(finished.currentEpisode, 0);
    const cancelled = fixture();
    api.applyMediaMetadata(cancelled, media(101, { status:"CANCELLED" }), at);
    assert.equal(cancelled.category, "waiting");
});

test("automatic backlog still moves to waiting for a genuinely unreleased work", () => {
    const { api } = runtime();
    const anime = fixture(101, { category:"backlog" });
    api.applyMediaMetadata(anime, media(101, { status:"NOT_YET_RELEASED", releasedEpisodes:0, nextAiringEpisode:null }), at);
    assert.equal(anime.category, "waiting");
});

test("H: direct refresh ignores deleted records and startup preserves tombstone identity", () => {
    const { api } = runtime();
    const tombstone = fixture(101, { deletedAt:before, deletedFromCategory:"waiting" });
    const original = copy(tombstone);
    api.applyMediaMetadata(tombstone, media(), at);
    assert.deepEqual(tombstone, original);
    const migrated = api.migrateExistingAnimeRecords([tombstone], at).list[0];
    assert.equal(migrated.deletedAt, before);
    assert.equal(migrated.category, "waiting");
    assert.equal(V.getAnimeAniListIdentity(migrated), "101");
});

test("I: real sync uses the v11 saveAndRender wrapper, persists, renders and survives real startup", async () => {
    const { api, localStorage, trace } = runtime();
    await api.syncAnimeMetadata(true);
    assert.equal(trace.errors.length, 0);
    assert.deepEqual(trace.requests, [[101]]);
    assert.equal(trace.renders, 1);
    assert.equal(trace.refreshes, 1);
    assert.equal(api.animeList[0].category, "watching");
    assert.equal(JSON.parse(localStorage.getItem(V.STORAGE_KEY))[0].category, "watching");
    assert.equal(localStorage.getItem("anime_metadata_sync_v10_1"), at);
    assert.ok(localStorage.writes.indexOf(V.STORAGE_KEY) < localStorage.writes.indexOf("anime_metadata_sync_v10_1"));
    assert.match(trace.cards[0], /進度：0 \/ 12 集/u);
    assert.match(trace.cards[0], /data-progress-action="increment"/u);
    assert.doesNotMatch(trace.cards[0], /預計開播|智慧監測開播中/u);
    const refreshed = runtime([], { storage:localStorage });
    refreshed.api.loadStoredAnime();
    assert.equal(refreshed.api.animeList[0].category, "watching");
    assert.equal(refreshed.api.animeList[0].watched, 0);
    assert.equal(refreshed.api.animeList[0].currentEpisode, 0);
    assert.equal(refreshed.api.animeList[0].airDate, "2026年10月");
});

test("I: startup alone promotes trusted stored metadata even within the six-hour sync cooldown", () => {
    const anime = fixture(101, { releasedEpisodes:1, status:"NOT_YET_RELEASED",
        nextEpisode:2, nextAiringAt:seconds("2026-10-08T14:56:00.000Z") });
    const { api, localStorage, trace } = runtime([anime]);
    localStorage.setItem("anime_metadata_sync_v10_1", at);
    api.loadStoredAnime();
    api.maybeAutoSyncAnimeMetadata();
    assert.equal(api.animeList[0].category, "watching");
    assert.equal(JSON.parse(localStorage.getItem(V.STORAGE_KEY))[0].category, "watching");
    assert.equal(trace.requests.length, 0);
});

test("J: second migration has zero changes and repeated sync is idempotent", async () => {
    const { api, localStorage } = runtime();
    await api.syncAnimeMetadata();
    const serialized = localStorage.getItem(V.STORAGE_KEY);
    const second = api.migrateExistingAnimeRecords(copy(api.animeList), at);
    assert.equal(second.changed, false);
    for (const field of ["titleChanged", "categoryChanged", "metadataChanged", "seriesChanged", "seriesIdentityChanged", "totalChanged"]) assert.equal(second.report[field], 0);
    assert.deepEqual(copy(second.list), JSON.parse(serialized));
    await api.syncAnimeMetadata();
    assert.equal(localStorage.getItem(V.STORAGE_KEY), serialized);
});

test("K: request failure preserves the whole list, storage and sync marker", async () => {
    const { api, localStorage, trace } = runtime(undefined, { request:async () => { throw Error("Network failure"); } });
    const originalList = copy(api.animeList), originalStorage = localStorage.snapshot();
    await api.syncAnimeMetadata(true);
    assert.deepEqual(copy(api.animeList), originalList);
    assert.deepEqual(localStorage.snapshot(), originalStorage);
    assert.equal(trace.renders, 0);
    assert.equal(trace.errors.length, 1);
    assert.equal(api.animeSyncing, false);
});

test("K: failure in batch two cannot leak the successful first batch into memory or disk", async () => {
    const list = Array.from({ length:51 }, (_, index) => fixture(1000 + index));
    let calls = 0;
    const { api, localStorage, trace } = runtime(list, { request:async ids => {
        if (++calls === 2) throw Error("Second batch failed");
        return ids.map(id => media(id));
    } });
    const originalList = copy(api.animeList), originalStorage = localStorage.snapshot();
    await api.syncAnimeMetadata(true);
    assert.equal(calls, 2);
    assert.deepEqual(copy(api.animeList), originalList);
    assert.deepEqual(localStorage.snapshot(), originalStorage);
    assert.equal(trace.renders, 0);
});

test("K/L: storage quota failure leaves original memory, persistence, history and undo intact", async () => {
    const list = [fixture()];
    const localStorage = storage({ [V.STORAGE_KEY]:JSON.stringify(list), [V.HISTORY_KEY]:"[]",
        anime_tracker_last_undo_v11:'{"kind":"compact-delete"}', anime_metadata_sync_v10_1:before }, V.STORAGE_KEY);
    const { api, trace } = runtime(list, { storage:localStorage });
    const originalStorage = localStorage.snapshot();
    await api.syncAnimeMetadata(true);
    assert.deepEqual(copy(api.animeList), list);
    assert.deepEqual(localStorage.snapshot(), originalStorage);
    assert.equal(trace.renders, 0);
    assert.equal(trace.errors[0].name, "QuotaExceededError");
});

test("sync-time quota failure is nonfatal after the primary record has been persisted", async () => {
    const localStorage = storage({ [V.STORAGE_KEY]:JSON.stringify([fixture()]), anime_metadata_sync_v10_1:before }, "anime_metadata_sync_v10_1");
    const { api, trace } = runtime(undefined, { storage:localStorage });
    await api.syncAnimeMetadata(true);
    assert.equal(api.animeList[0].category, "watching");
    assert.equal(JSON.parse(localStorage.getItem(V.STORAGE_KEY))[0].category, "watching");
    assert.equal(localStorage.getItem("anime_metadata_sync_v10_1"), before);
    assert.equal(trace.errors.length, 0);
    assert.equal(trace.warnings.length, 1);
});

test("G/H/L: sync changes only returned active identities; other seasons, review, history and tombstones stay identical", async () => {
    const list = [fixture(), fixture(102, { category:"completed", status:"FINISHED", watched:12, currentEpisode:12 }),
        fixture(103, { category:"review", status:"FINISHED", watched:12, currentEpisode:12, reviewWatched:4, reviewSessionActive:true }),
        fixture(104, { deletedAt:before }), fixture(105, { category:"backlog", status:"FINISHED" })];
    const { api, localStorage, trace } = runtime(list, { request:async () => [media(), media(104)] });
    const auxiliary = localStorage.snapshot();
    await api.syncAnimeMetadata();
    assert.equal(trace.errors.length, 0);
    assert.deepEqual(trace.requests, [[101, 102, 103, 105]]);
    assert.equal(api.animeList[0].category, "watching");
    assert.deepEqual(copy(api.animeList.slice(1)), list.slice(1));
    for (const [key, value] of Object.entries(auxiliary)) if (key !== V.STORAGE_KEY) assert.equal(localStorage.getItem(key), value);
});

test("L: a numeric local ID cannot collide with another season's explicit AniList identity", async () => {
    const list = [fixture(101, { id:102 }), fixture(102, { id:"season-one", category:"completed", status:"FINISHED", watched:12, currentEpisode:12 })];
    const { api, trace } = runtime(list, { request:async () => [media(101)] });
    await api.syncAnimeMetadata();
    assert.equal(trace.errors.length, 0);
    assert.equal(api.animeList[0].id, 102);
    assert.equal(api.animeList[0].anilistId, 101);
    assert.equal(api.animeList[0].category, "watching");
    assert.deepEqual(copy(api.animeList[1]), list[1]);
});

test("in-flight deletion and manual progress/category edits are respected at commit time", async () => {
    const { api, localStorage, trace } = runtime([fixture(), fixture(102)], { request:async () => {
        const latest = JSON.parse(localStorage.getItem(V.STORAGE_KEY));
        latest[0] = { ...latest[0], deletedAt:at, deletedFromCategory:"waiting" };
        latest[1] = { ...latest[1], category:"backlog", categorySource:"manual",
            categoryManuallyEdited:true, watched:3, currentEpisode:3 };
        localStorage.setItem(V.STORAGE_KEY, JSON.stringify(latest));
        return [media(), media(102)];
    } });
    await api.syncAnimeMetadata();
    assert.equal(trace.errors.length, 0);
    assert.equal(api.animeList[0].deletedAt, at);
    assert.equal(api.animeList[0].category, "waiting");
    assert.equal(api.animeList[1].category, "backlog");
    assert.equal(api.animeList[1].watched, 3);
    assert.equal(api.animeList[1].currentEpisode, 3);
});

test("fresh add, metadata refresh and stored migration share the same release decision", () => {
    const { api } = runtime();
    const value = media(101, { status:"NOT_YET_RELEASED" });
    assert.equal(api.resolveAutomaticMediaCategory(value, at), "watching");
    const anime = fixture();
    api.applyMediaMetadata(anime, value, at);
    const stored = copy(anime); stored.category = "waiting";
    assert.equal(api.migrateExistingAnimeRecords([stored], at).list[0].category, "watching");
});

test("backup/export/import preserves automatic ownership, progress and tombstones after repair", async () => {
    const { api } = runtime([fixture(), fixture(102, { deletedAt:before })]);
    await api.syncAnimeMetadata();
    const backup = V.createBackup({ animeList:copy(api.animeList), works:[], watchHistory:[] });
    assert.equal(V.validateBackup(backup).valid, true);
    const imported = V.importBackup({ animeList:[], works:[] }, copy(backup), "replace");
    assert.equal(imported.animeList[0].category, "watching");
    assert.equal(imported.animeList[0].categorySource, "automatic");
    assert.equal(imported.animeList[0].categoryManuallyEdited, false);
    assert.equal(imported.animeList[0].watched, 0);
    assert.equal(imported.animeList[1].deletedAt, before);
    assert.equal(api.migrateExistingAnimeRecords(imported.animeList, at).changed, false);
});
