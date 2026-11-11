"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const V = require(appSourcePath("v11-core.js"));

const before = "2026-10-01T00:00:00.000Z";
const at = "2026-11-08T12:00:00.000Z";
const copy = value => JSON.parse(JSON.stringify(value));
const anime = (extra = {}) => ({
    id:"synthetic-detail-season-one", anilistId:101, title:"Synthetic detail season one",
    category:"watching", categorySource:"automatic", categoryManuallyEdited:false,
    currentEpisode:5, watched:5, totalEpisodes:12, episodes:12,
    updatedAt:before, lastWatchedAt:before,
    reviewWatched:2, reviewSessionActive:false, reviewStartedAt:before,
    reviewCompletedAt:before, notes:"preserved long note", note:"preserved legacy note",
    rating:8, seriesKey:"synthetic-series", userExtension:{ nested:["preserve"] },
    nextEpisodeAt:"2026-11-09T12:00:00.000Z", broadcastTime:"23:30", ...extra
});
const changedKeys = (old, next) => [...new Set([...Object.keys(old), ...Object.keys(next)])]
    .filter(key => JSON.stringify(old[key]) !== JSON.stringify(next[key])).sort();

test("detail correction 5/12 to 12/12 completes without fabricating a viewing event", () => {
    const old = anime(), original = copy(old);
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:12, totalEpisodes:12 }, at);
    assert.equal(result.changed, true);
    assert.equal(result.anime.category, "completed");
    assert.equal(result.anime.currentEpisode, 12);
    assert.equal(result.anime.watched, 12);
    assert.equal(result.historyRecord, null);
    assert.deepEqual(changedKeys(old, result.anime), ["category", "currentEpisode", "updatedAt", "watched"]);
    assert.deepEqual(old, original);
});

test("detail correction 0/12 to 5/12 enters the derived currently-watching view", () => {
    const result = V.correctAnimeDetailProgress(anime({ currentEpisode:0, watched:0 }), { currentEpisode:5 }, at);
    assert.equal(result.anime.category, "watching");
    assert.equal(V.isAnimeCurrentlyWatching(result.anime), true);
    assert.equal(result.anime.lastWatchedAt, before);
    assert.equal(Object.hasOwn(result.anime, "currentlyWatching"), false);
});

test("detail correction 1/12 to 0/12 leaves the derived view and preserves broadcast classification", () => {
    const result = V.correctAnimeDetailProgress(anime({ currentEpisode:1, watched:1 }), { currentEpisode:0 }, at);
    assert.equal(result.anime.currentEpisode, 0);
    assert.equal(result.anime.category, "watching");
    assert.equal(V.isAnimeCurrentlyWatching(result.anime), false);
});

for (const unknownTotal of [null, 0, ""]) {
    test(`detail correction with explicitly unknown total ${JSON.stringify(unknownTotal)} never infers completion`, () => {
        const result = V.correctAnimeDetailProgress(anime(), { currentEpisode:12, totalEpisodes:unknownTotal }, at);
        assert.equal(result.anime.category, "watching");
        assert.equal(result.anime.totalEpisodes, null);
        assert.equal(result.anime.episodes, null);
        assert.equal(V.isAnimeCurrentlyWatching(result.anime), true);
    });
}

test("an existing unknown total stays unknown when only normal progress is corrected", () => {
    const result = V.correctAnimeDetailProgress(anime({ totalEpisodes:null, episodes:null }), { currentEpisode:12 }, at);
    assert.equal(result.anime.category, "watching");
    assert.equal(V.isAnimeCurrentlyWatching(result.anime), true);
});

test("correcting a known total to the already-watched count applies the completion rule", () => {
    const result = V.correctAnimeDetailProgress(anime({ currentEpisode:12, watched:12, totalEpisodes:24, episodes:24 }), { totalEpisodes:12 }, at);
    assert.equal(result.anime.category, "completed");
    assert.deepEqual(changedKeys(anime({ currentEpisode:12, watched:12, totalEpisodes:24, episodes:24 }), result.anime), ["category", "episodes", "totalEpisodes", "updatedAt"]);
});

for (const manual of [
    { categorySource:"manual", categoryManuallyEdited:false },
    { categorySource:"automatic", categoryManuallyEdited:true },
    { categorySource:"manual", categoryManuallyEdited:true }
]) {
    test(`manual classification is preserved during completion correction: ${JSON.stringify(manual)}`, () => {
        const old = anime({ category:"backlog", ...manual });
        const result = V.correctAnimeDetailProgress(old, { currentEpisode:12 }, at);
        assert.equal(result.anime.currentEpisode, 12);
        assert.equal(result.anime.category, "backlog");
        assert.equal(result.anime.categorySource, manual.categorySource);
        assert.equal(result.anime.categoryManuallyEdited, manual.categoryManuallyEdited);
    });
}

test("explicitly correcting a legacy record's progress can complete without inventing automatic ownership", () => {
    const old = anime();
    delete old.categorySource;
    delete old.categoryManuallyEdited;
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:12 }, at);
    assert.equal(result.anime.category, "completed");
    assert.equal(Object.hasOwn(result.anime, "categorySource"), false);
    assert.equal(Object.hasOwn(result.anime, "categoryManuallyEdited"), false);
});

test("an explicit different category wins over completion and records manual ownership", () => {
    const result = V.correctAnimeDetailProgress(anime(), { currentEpisode:12, category:"backlog", categoryExplicitlyChanged:true }, at);
    assert.equal(result.anime.category, "backlog");
    assert.equal(result.anime.categorySource, "manual");
    assert.equal(result.anime.categoryManuallyEdited, true);
    assert.equal(result.anime.lastWatchedAt, before);
});

test("an explicit completed choice can update manual classification without altering progress", () => {
    const old = anime({ category:"backlog", categorySource:"manual", categoryManuallyEdited:true });
    const result = V.correctAnimeDetailProgress(old, { category:"completed", categoryExplicitlyChanged:true }, at);
    assert.equal(result.anime.category, "completed");
    assert.equal(result.anime.currentEpisode, 5);
    assert.deepEqual(changedKeys(old, result.anime), ["category", "updatedAt"]);
});

test("an unchanged category selection does not silently claim ownership", () => {
    const old = anime();
    delete old.categorySource;
    delete old.categoryManuallyEdited;
    const result = V.correctAnimeDetailProgress(old, { category:"watching", categoryExplicitlyChanged:true }, at);
    assert.equal(result.changed, false);
    assert.equal(result.anime, old);
    assert.equal(Object.hasOwn(result.anime, "categorySource"), false);
});

test("review rows retain normal progress, category, review progress and session timestamps", () => {
    const old = anime({ category:"review", reviewSessionActive:true }), original = copy(old);
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:12, totalEpisodes:24, category:"completed", categoryExplicitlyChanged:true }, at);
    assert.equal(result.reason, "review-protected");
    assert.equal(result.changed, false);
    assert.equal(result.anime, old);
    assert.deepEqual(result.anime, original);
    assert.equal(result.historyRecord, null);
});

for (const deleted of [{ deletedAt:before }, { category:"_deleted" }]) {
    test(`deleted rows cannot be revived through detail progress: ${JSON.stringify(deleted)}`, () => {
        const old = anime(deleted), original = copy(old);
        const result = V.correctAnimeDetailProgress(old, { currentEpisode:12, category:"watching", categoryExplicitlyChanged:true }, at);
        assert.equal(result.reason, "deleted");
        assert.equal(result.changed, false);
        assert.deepEqual(result.anime, original);
    });
}

test("notes-only detail edits do not normalize mismatched legacy progress aliases or classify records", () => {
    const old = anime({ currentEpisode:12, watched:2, totalEpisodes:0, episodes:12 });
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:12, totalEpisodes:12, category:"watching" }, at);
    assert.equal(result.changed, false);
    assert.equal(result.anime, old);
    assert.equal(result.anime.watched, 2);
    assert.equal(result.anime.totalEpisodes, 0);
    assert.equal(result.anime.category, "watching");
    assert.equal(result.anime.updatedAt, before);
});

test("correction versions move forward even when the device clock is behind", () => {
    const old = anime({ updatedAt:"2026-11-09T12:00:00.000Z" });
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:6 }, at);
    assert.equal(result.anime.updatedAt, "2026-11-09T12:00:00.001Z");
});

test("numeric form strings are supported without changing unrelated user data", () => {
    const old = anime();
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:"6", totalEpisodes:"12" }, at);
    assert.equal(result.anime.currentEpisode, 6);
    assert.deepEqual(changedKeys(old, result.anime), ["currentEpisode", "updatedAt", "watched"]);
    assert.equal(result.anime.userExtension, old.userExtension);
});

for (const value of [-1, 1.5, "unknown", "", NaN, Infinity, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    test(`invalid normal progress is rejected atomically: ${String(value)}`, () => {
        const old = anime();
        const result = V.correctAnimeDetailProgress(old, { currentEpisode:value, totalEpisodes:24, category:"completed", categoryExplicitlyChanged:true }, at);
        assert.equal(result.reason, "invalid-progress");
        assert.equal(result.changed, false);
        assert.equal(result.anime, old);
    });
}

test("invalid totals and categories are rejected without partially correcting progress", () => {
    const old = anime();
    for (const totalEpisodes of [-1, 12.5, "unknown", Infinity, true]) {
        const result = V.correctAnimeDetailProgress(old, { currentEpisode:6, totalEpisodes }, at);
        assert.equal(result.reason, "invalid-progress");
        assert.equal(result.anime, old);
    }
    const invalidCategory = V.correctAnimeDetailProgress(old, { currentEpisode:6, category:"_deleted", categoryExplicitlyChanged:true }, at);
    assert.equal(invalidCategory.reason, "invalid-category");
    assert.equal(invalidCategory.anime, old);
});

test("correction is single-record and leaves same-series siblings, tombstones and all history untouched", () => {
    const list = [anime(), anime({ id:"synthetic-season-two", currentEpisode:0, watched:0 }), anime({ id:"synthetic-tombstone", deletedAt:before, category:"_deleted" })];
    const history = [{ id:"synthetic-history", animeId:list[0].id, delta:5, episode:5, at:before, arbitrary:"preserve" }];
    const original = copy({ list, history });
    const result = V.correctAnimeDetailProgress(Object.freeze(list[0]), { currentEpisode:12 }, at);
    const correctedList = [result.anime, ...list.slice(1)];
    assert.equal(result.historyRecord, null);
    assert.deepEqual(list, original.list);
    assert.deepEqual(history, original.history);
    assert.equal(correctedList[1], list[1]);
    assert.equal(correctedList[2], list[2]);
    assert.deepEqual(correctedList.filter(V.isAnimeCurrentlyWatching), []);
});

test("corrected progress, original history and tombstones survive JSON reload and preserved-record backup", () => {
    const old = anime();
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:12 }, at);
    const tombstone = anime({ id:"synthetic-deleted", category:"_deleted", deletedAt:before });
    const history = [{ id:"synthetic-history", animeId:old.id, delta:5, episode:5, at:before }];
    const reloaded = JSON.parse(JSON.stringify([result.anime, tombstone]));
    const backup = V.createBackup({ animeList:reloaded, watchHistory:history, works:[], settings:{ theme:"dark" } }, { preserveStoredRecords:true });
    const imported = V.normalizeImportedBackup(JSON.stringify(backup));
    assert.deepEqual(imported[V.STORAGE_KEY], reloaded);
    assert.deepEqual(imported.watchHistory, history);
    assert.equal(imported[V.STORAGE_KEY][0].category, "completed");
    assert.equal(imported[V.STORAGE_KEY][0].lastWatchedAt, before);
    assert.deepEqual(imported[V.STORAGE_KEY][0].userExtension, old.userExtension);
    assert.deepEqual(imported[V.STORAGE_KEY][1], tombstone);
});

test("a corrected detail record wins over its older cloud version in either merge direction", () => {
    const old = anime({ updatedAt:at });
    const result = V.correctAnimeDetailProgress(old, { currentEpisode:12 }, before);
    for (const merged of [V.mergeById([result.anime], [old]), V.mergeById([old], [result.anime])]) {
        assert.equal(merged[0].currentEpisode, 12);
        assert.equal(merged[0].watched, 12);
        assert.equal(merged[0].category, "completed");
        assert.equal(merged[0].updatedAt, "2026-11-08T12:00:00.001Z");
        assert.equal(merged[0].lastWatchedAt, before);
        assert.equal(merged[0].notes, old.notes);
        assert.deepEqual(merged[0].userExtension, old.userExtension);
    }
});
