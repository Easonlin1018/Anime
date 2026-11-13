"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const appSourcePath = require("./release-path.cjs");
const V = require(appSourcePath("v11-core.js"));

const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const production = [
    ["const MEDIA_FIELDS", "async function requestAniList("],
    ["async function requestAniListMediaPage", "function normalizeStreamingLinks"],
    ["function restoreAnimeStartupStorage", "function warnAnimeStartupStorage"],
    ["function assertMetadataSyncStorageIdle", "function filterMetadataSyncPatch"],
    ["let animeSeriesRefreshRunning", "function editAnimeReview"]
].map(([start, end]) => {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return html.slice(from, to);
}).join("\n");

const at = "2026-11-11T12:00:00.000Z";
const chain = [
    [101291, "Bunny Girl Senpai", "TV", 2018, 10, 4],
    [104157, "Dreaming Girl", "MOVIE", 2019, 6, 15],
    [154967, "Sister Venturing Out", "MOVIE", 2023, 6, 23],
    [161474, "Knapsack Kid", "MOVIE", 2023, 12, 1]
];
const byId = new Map(chain.map((entry, index) => [entry[0], index]));

function responseMedia(id) {
    const index = byId.get(id);
    const [mediaId, title, format, year, month, day] = chain[index];
    const edges = [];
    for (const [adjacent, relationType] of [[index - 1, "PREQUEL"], [index + 1, "SEQUEL"]]) {
        if (chain[adjacent]) {
            const [relatedId, , relatedFormat] = chain[adjacent];
            edges.push({ relationType, node:{ id:relatedId, type:"ANIME", format:relatedFormat } });
        }
    }
    return {
        id:mediaId, type:"ANIME", format, startDate:{ year, month, day },
        title:{ english:title }, relations:{ edges }
    };
}

function anime(id, extra = {}) {
    const media = responseMedia(id);
    return {
        id:`local-${id}`, anilistId:id, sourceId:String(id), source:"anilist",
        identitySource:"user-confirmed-anilist", title:media.title.english,
        startDate:media.startDate, year:media.startDate.year, format:media.format,
        watched:0, currentEpisode:0, notes:"原筆記", rating:8, favorite:true, category:"backlog",
        addedAt:at, updatedAt:at, ...extra
    };
}

function runtime(rows, { response, failWrite = () => false, noLock = false } = {}) {
    const watchHistory = [{ id:"original-history", animeId:"local-101291", delta:1, at }];
    const initial = new Map([
        [V.STORAGE_KEY, JSON.stringify(rows)], [V.HISTORY_KEY, JSON.stringify(watchHistory)],
        ["anime_tracker_last_undo_v11", JSON.stringify({ synthetic:true })]
    ]);
    const store = new Map(initial);
    const requests = [], writes = [], renders = [], warnings = [];
    let locked = false;
    const read = () => JSON.parse(store.get(V.STORAGE_KEY));
    const writeAsOtherTab = next => store.set(V.STORAGE_KEY, JSON.stringify(next));
    const context = vm.createContext({
        AnimeTrackerV11:V,
        STORAGE_KEY:V.STORAGE_KEY,
        EVENT_OVERRIDES_KEY:"event_overrides",
        EVENT_ANIME_OVERRIDES_KEY:"event_anime_overrides",
        animeList:rows,
        window:{
            __ANIME_STARTUP_STORAGE__:{ persisted:true },
            animeStorageReady:Promise.resolve(),
            assertAnimeStorageWriteLock:() => assert.equal(locked, true),
            refreshV11:() => renders.push("secondary")
        },
        localStorage:{
            getItem:key => store.get(key) ?? null,
            setItem(key, value) {
                assert.equal(locked, true);
                if (failWrite(key)) throw new DOMException("Synthetic quota", "QuotaExceededError");
                writes.push(key);
                store.set(key, value);
            },
            removeItem(key) {
                assert.equal(locked, true);
                store.delete(key);
            }
        },
        async fetchWithTimeout(url, { body }) {
            assert.equal(url, "https://graphql.anilist.co");
            assert.equal(locked, false);
            const { query, variables:{ ids } } = JSON.parse(body);
            assert.match(query, /query AnimeSeriesMetadata\b/);
            requests.push(ids);
            const media = response ? await response(ids, { read, writeAsOtherTab, store }) : ids.map(responseMedia);
            return { json:async () => ({ data:{ Page:{ media } } }) };
        },
        assertAnimeStartupWritable() {},
        assertAnimeStorageAvailable() { if (noLock) throw new Error("Synthetic unavailable storage lock"); },
        async withAnimeStorageWrite(operation, { hydrate }) {
            assert.equal(hydrate, false);
            assert.equal(locked, false);
            locked = true;
            try { return operation(); }
            finally { locked = false; }
        },
        delay:async () => {},
        startupAnimeView:list => list,
        renderList:() => renders.push("main"),
        showToast() {},
        console:{ warn:(...args) => warnings.push(args) }
    });
    vm.runInContext(production, context, { filename:"anime-series-recovery-production.js" });
    return {
        read, writeAsOtherTab, store, initial, requests, writes, renders, warnings,
        memory:() => context.animeList,
        recover:manual => context.window.recoverAnimeSeriesMetadata(manual),
        review:id => context.getAnimeSeriesReviewRecord(id),
        confirm:(id, token) => context.confirmAnimeSeriesReview(id, token)
    };
}

test("untracked movies bridge two confirmed records while the originals and auxiliary data survive", async () => {
    const original = [anime(101291), anime(161474, { watched:1, currentEpisode:1, category:"completed" })];
    const run = runtime(original);
    assert.notEqual(...V.buildAnimeSeriesIdentity(original).entries.map(entry => entry.seriesKey));
    assert.equal(await run.recover(true), 2);
    assert.deepEqual(run.requests, [[101291, 161474], [104157, 154967]]);
    const persisted = run.read();
    assert.deepEqual(persisted.map(({ seriesMetadata, ...record }) => record), original);
    assert.deepEqual(persisted.map(item => item.seriesMetadata.prequelRootId), ["101291", "101291"]);
    assert.equal(...V.buildAnimeSeriesIdentity(persisted).entries.map(entry => entry.seriesKey));
    assert.deepEqual(run.writes, [V.STORAGE_KEY]);
    assert.deepEqual(run.renders, ["main", "secondary"]);
    assert.equal(run.store.get(V.HISTORY_KEY), run.initial.get(V.HISTORY_KEY));
    assert.equal(run.store.get("anime_tracker_last_undo_v11"), run.initial.get("anime_tracker_last_undo_v11"));
});

test("series recovery keeps progress saved by another tab and skips deleted or relinked rows", async () => {
    const original = [anime(101291), anime(104157), anime(154967), anime(161474)];
    let edited;
    const run = runtime(original, { response:async (ids, storage) => {
        edited = storage.read();
        Object.assign(edited[0], { notes:"另一分頁的筆記", watched:4, currentEpisode:4, favorite:false, rating:9 });
        Object.assign(edited[1], { deletedAt:at, category:"_deleted" });
        Object.assign(edited[2], { anilistId:900001, sourceId:"900001", title:"重新確認過的另一作品" });
        storage.writeAsOtherTab(edited);
        return ids.map(responseMedia);
    } });
    assert.equal(await run.recover(true), 2);
    const persisted = run.read();
    assert.deepEqual(persisted.map(({ seriesMetadata, ...record }) => record), edited);
    assert.ok(persisted[0].seriesMetadata);
    assert.ok(persisted[3].seriesMetadata);
    assert.equal(persisted[1].seriesMetadata, undefined);
    assert.equal(persisted[2].seriesMetadata, undefined);
});

test("quota, API failure and unavailable locking leave storage and memory intact", async () => {
    const original = [anime(101291)];
    for (const options of [
        { failWrite:key => key === V.STORAGE_KEY },
        { response:() => { throw new Error("Synthetic network failure"); } },
        { noLock:true }
    ]) {
        const run = runtime(original, options);
        assert.equal(await run.recover(true), 0);
        assert.deepEqual(run.store, run.initial);
        assert.deepEqual(run.memory(), original);
        assert.deepEqual(run.writes, []);
        assert.deepEqual(run.renders, []);
        assert.equal(run.warnings.length, 1);
        if (options.noLock) assert.deepEqual(run.requests, []);
    }
});

function conflictingMovie() {
    return anime(104157, {
        title:"青春豬頭少年不會夢到嬌憐外出妹", year:2023,
        startDate:{ year:2023, month:6, day:23 },
        seriesMetadata:V.buildVerifiedAnimeSeriesMetadata(responseMedia(104157), "104157")
    });
}

test("a reviewed correction keeps notes and tracking saved after the preview", async () => {
    const movie = conflictingMovie();
    const other = anime(101291);
    const run = runtime([movie, other]);
    const preview = run.review(movie.id);
    assert.ok(preview.review.dateConflict);
    assert.ok(preview.review.titleConflict);
    assert.deepEqual(run.store, run.initial);
    const edited = { ...movie, notes:"另一分頁的筆記", watched:1, currentEpisode:1, rating:9 };
    run.writeAsOtherTab([edited, other]);
    const result = await run.confirm(movie.id, preview.token);
    assert.equal(result.before.notes, edited.notes);
    assert.equal(result.after.title, "青春豬頭少年不會夢到懷夢美少女");
    assert.equal(result.after.year, 2019);
    for (const field of ["id", "anilistId", "sourceId", "category", "notes", "watched", "currentEpisode", "rating", "favorite"]) {
        assert.equal(result.after[field], edited[field]);
    }
    assert.deepEqual(run.read()[1], other);
    assert.deepEqual(run.writes, [V.STORAGE_KEY]);
    assert.deepEqual(run.requests, []);
    assert.equal(run.store.get(V.HISTORY_KEY), run.initial.get(V.HISTORY_KEY));
});

test("a stale preview or failed confirmation cannot publish a correction", async () => {
    const movie = conflictingMovie();
    const stale = runtime([movie]);
    const { token } = stale.review(movie.id);
    const changed = { ...movie, title:"另一分頁改過的名稱", titleSource:"manual" };
    stale.writeAsOtherTab([changed]);
    await assert.rejects(stale.confirm(movie.id, token), /作品資料已變更/);
    assert.deepEqual(stale.read(), [changed]);
    assert.deepEqual(stale.writes, []);

    const quota = runtime([movie], { failWrite:key => key === V.STORAGE_KEY });
    await assert.rejects(quota.confirm(movie.id, quota.review(movie.id).token), { name:"QuotaExceededError" });
    assert.deepEqual(quota.store, quota.initial);
    assert.deepEqual(quota.memory(), [movie]);
    assert.deepEqual(quota.renders, []);
});
