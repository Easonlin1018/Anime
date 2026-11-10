"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require(appSourcePath("v11-core.js"));

const before = "2026-10-01T00:00:00.000Z";
const at = "2026-11-08T12:00:00.000Z";
const copy = value => JSON.parse(JSON.stringify(value));
const anime = (id = "season-one", extra = {}) => ({
    id, anilistId:id === "season-one" ? 101 : 202, title:`Synthetic ${id}`,
    category:"watching", categorySource:"automatic", categoryManuallyEdited:false,
    currentEpisode:0, watched:0, episodes:12, totalEpisodes:12,
    notes:"long note", note:"different legacy short note", rating:8,
    seriesKey:"synthetic-same-series", nextEpisodeAt:"2026-11-09T12:00:00.000Z",
    updatedAt:before, lastWatchedAt:before, ...extra
});

for (const [label, overrides, expected] of [
    ["zero progress despite a new lastWatchedAt", { lastWatchedAt:at }, false],
    ["first normal episode", { currentEpisode:1, watched:1 }, true],
    ["legacy watched only", { currentEpisode:undefined, watched:5 }, true],
    ["canonical currentEpisode zero wins over stale watched", { currentEpisode:0, watched:5 }, false],
    ["canonical currentEpisode five wins over stale watched", { currentEpisode:5, watched:0 }, true],
    ["last unfinished episode", { currentEpisode:11 }, true],
    ["known total reached", { currentEpisode:12 }, false],
    ["known total exceeded", { currentEpisode:13 }, false],
    ["unknown total", { currentEpisode:5, totalEpisodes:null, episodes:"??" }, true],
    ["zero total is unknown", { currentEpisode:5, totalEpisodes:0 }, true],
    ["invalid total is unknown", { currentEpisode:5, totalEpisodes:"unknown" }, true],
    ["negative progress", { currentEpisode:-1 }, false],
    ["invalid progress", { currentEpisode:"not-a-number" }, false],
    ["boolean is not episode progress", { currentEpisode:true }, false],
    ["review count alone is not normal progress", { reviewWatched:5 }, false],
    ["review category is separate", { currentEpisode:5, reviewWatched:2, category:"review" }, false],
    ["explicit completion with unknown total", { currentEpisode:5, totalEpisodes:null, episodes:"??", category:"completed" }, false],
    ["deleted timestamp", { currentEpisode:5, deletedAt:before }, false],
    ["deleted category without a timestamp", { currentEpisode:5, category:"_deleted" }, false],
    ["finished broadcast but unfinished viewer", { currentEpisode:5, category:"backlog", status:"FINISHED" }, true],
    ["manually classified backlog with genuine progress", { currentEpisode:5, category:"backlog", categorySource:"manual", categoryManuallyEdited:true }, true]
]) {
    test(`derived currently-watching membership: ${label}`, () => {
        const item = anime("season-one", overrides), original = copy(item);
        assert.equal(V.isAnimeCurrentlyWatching(item), expected);
        assert.deepEqual(copy(item), original, "The view predicate never migrates or mutates a record");
        assert.equal(Object.hasOwn(item, "currentlyWatching"), false, "There is no duplicate stored membership flag");
    });
}

test("missing and malformed records never appear in the derived view", () => {
    for (const value of [null, undefined, [], {}, { currentEpisode:Infinity }])
        assert.equal(V.isAnimeCurrentlyWatching(value), false);
    assert.deepEqual(V.getNormalAnimeProgress({ currentEpisode:"5", totalEpisodes:"12" }), { current:5, total:12 });
});

for (const totalEpisodes of [0, "unknown", null, undefined]) {
    test(`a known legacy episodes count remains authoritative when totalEpisodes is ${String(totalEpisodes)}`, () => {
        const item = anime("legacy", { currentEpisode:12, watched:12, totalEpisodes, episodes:12 });
        assert.deepEqual(V.getNormalAnimeProgress(item), { current:12, total:12 });
        assert.equal(V.isAnimeCurrentlyWatching(item), false);
        assert.equal(V.watchStats([], [item], at).currentlyWatching, 0);
        const almost = { ...item, currentEpisode:11, watched:11 };
        const finished = V.updateAnimeProgress([almost], almost.id, 1, at);
        assert.equal(finished.anime.category, "completed");
        assert.equal(finished.anime.currentEpisode, 12);
    });
}

test("same-series seasons and movies are evaluated independently", () => {
    const list = [anime(), anime("season-two", { currentEpisode:5 }), anime("movie", { episodes:1, totalEpisodes:1 }),
        anime("deleted-season", { currentEpisode:3, deletedAt:before })];
    assert.deepEqual(list.filter(V.isAnimeCurrentlyWatching).map(item => item.id), ["season-two"]);
    assert.deepEqual(list.map(item => item.category), ["watching", "watching", "watching", "watching"]);
});

test("normal progress 0→1→5 changes membership without changing broadcast category or siblings", () => {
    const list = [anime(), anime("season-two")], original = copy(list);
    const first = V.updateAnimeProgress(list, "season-one", 1, at);
    assert.equal(V.isAnimeCurrentlyWatching(first.anime), true);
    assert.equal(first.anime.category, "watching");
    const fifth = V.updateAnimeProgress(first.list, "season-one", 4, at);
    assert.equal(fifth.anime.currentEpisode, 5);
    assert.equal(fifth.historyRecord.delta, 4);
    assert.equal(V.isAnimeCurrentlyWatching(fifth.anime), true);
    assert.deepEqual(fifth.list[1], original[1]);
    assert.deepEqual(list, original);
});

test("11→12 completes only the selected record and preserves its user and broadcast fields", () => {
    const list = [anime("season-one", { currentEpisode:11, watched:11 }), anime("season-two", { currentEpisode:5 })];
    const result = V.updateAnimeProgress(list, "season-one", 1, at);
    assert.equal(result.anime.category, "completed");
    assert.equal(result.anime.currentEpisode, 12);
    assert.equal(result.anime.watched, 12);
    assert.equal(V.isAnimeCurrentlyWatching(result.anime), false);
    for (const key of ["notes", "note", "rating", "seriesKey", "nextEpisodeAt", "categorySource", "categoryManuallyEdited"])
        assert.deepEqual(result.anime[key], list[0][key], key);
    assert.deepEqual(result.list[1], list[1]);
    assert.equal(result.historyRecord.delta, 1);
});

for (const category of ["watching", "backlog", "waiting"]) {
    test(`1→0 leaves the view and retains its original ${category} classification`, () => {
        const list = [anime("season-one", { category, currentEpisode:1, watched:1 })];
        const result = V.updateAnimeProgress(list, "season-one", -1, at);
        assert.equal(result.anime.category, category);
        assert.equal(result.anime.currentEpisode, 0);
        assert.equal(V.isAnimeCurrentlyWatching(result.anime), false);
        assert.equal(result.anime.lastWatchedAt, before);
        assert.equal(result.historyRecord.correction, true);
        assert.equal(result.historyRecord.delta, -1);
    });
}

test("progress does not normalize unrelated legacy fields or add absent timestamps", () => {
    const old = anime("season-one", { createdAt:"legacy-created", addedAt:undefined, aliases:undefined,
        lastMetadataSync:"legacy-sync", reviewWatched:4, customData:{ preserve:[1, 2] } });
    const result = V.updateAnimeProgress([old], old.id, 1, at);
    const allowed = new Set(["currentEpisode", "watched", "updatedAt", "lastWatchedAt"]);
    for (const key of Object.keys(old)) if (!allowed.has(key)) assert.deepEqual(result.anime[key], old[key], key);
    assert.deepEqual(Object.keys(result.anime).sort(), Object.keys(old).sort());
    const negative = { id:"raw", title:"Raw", watched:1, episodes:12, notes:"raw note" };
    const reverted = V.updateAnimeProgress([negative], "raw", -1, at).anime;
    assert.equal(Object.hasOwn(reverted, "lastWatchedAt"), false);
    assert.equal(Object.hasOwn(reverted, "addedAt"), false);
    assert.equal(Object.hasOwn(reverted, "createdAt"), false);
});

test("review updates keep normal progress, history type and derived membership separate", () => {
    const list = [anime("season-one", { category:"review", currentEpisode:12, watched:12, reviewWatched:0 })];
    const result = V.updateAnimeReviewProgress(list, "season-one", 1, at);
    assert.equal(result.anime.reviewWatched, 1);
    assert.equal(result.anime.currentEpisode, 12);
    assert.equal(result.anime.watched, 12);
    assert.equal(result.anime.category, "review");
    assert.equal(V.isAnimeCurrentlyWatching(result.anime), false);
    assert.equal(result.historyRecord.type, "review");
    assert.equal(result.anime.note, list[0].note);
    assert.equal(result.anime.notes, list[0].notes);
});

test("an explicit completed category is not guessed away when legacy progress is corrected", () => {
    const result = V.updateAnimeProgress([anime("season-one", { category:"completed", currentEpisode:12 })], "season-one", -1, at);
    assert.equal(result.anime.currentEpisode, 11);
    assert.equal(result.anime.category, "completed");
    assert.equal(V.isAnimeCurrentlyWatching(result.anime), false);
});

test("backup, reload and cloud merging derive membership without a new persistent list", () => {
    const started = V.updateAnimeProgress([anime()], "season-one", 5, at).list;
    const backup = V.createBackup({ animeList:started }, { preserveStoredRecords:true });
    assert.equal(V.isAnimeCurrentlyWatching(backup[V.STORAGE_KEY][0]), true);
    const reloaded = JSON.parse(JSON.stringify(backup[V.STORAGE_KEY]));
    assert.equal(V.isAnimeCurrentlyWatching(reloaded[0]), true);
    for (const list of [V.mergeById([anime()], reloaded), V.mergeById(reloaded, [anime()])]) {
        assert.equal(V.isAnimeCurrentlyWatching(list[0]), true);
        assert.equal(list[0].category, "watching");
        assert.equal(list[0].notes, "long note");
    }
    assert.equal(Object.hasOwn(backup, "currentlyWatching"), false);
    assert.equal(Object.hasOwn(reloaded[0], "currentlyWatching"), false);
});

test("undo and import restore membership from progress rather than a stale saved selection", () => {
    const beforeList = [anime()], after = V.updateAnimeProgress(beforeList, "season-one", 1, at).list;
    assert.equal(V.isAnimeCurrentlyWatching(after[0]), true);
    const undo = V.restoreDeleteUndoState(after, {}, { type:"batch", before:beforeList }, at);
    assert.equal(V.isAnimeCurrentlyWatching(undo.list[0]), false);
    const restored = V.importBackup({ animeList:beforeList }, V.createBackup({ animeList:after }), "replace");
    assert.equal(V.isAnimeCurrentlyWatching(restored.animeList[0]), true);
});

test("statistics distinguish broadcasting category from genuine currently-watching progress", () => {
    const list = [anime(), anime("season-two", { currentEpisode:5 }),
        anime("finished-broadcast", { currentEpisode:4, category:"backlog", status:"FINISHED" }),
        anime("review", { currentEpisode:12, category:"review", reviewWatched:1 })];
    const stats = V.watchStats([], list, new Date(at));
    assert.equal(stats.watching, 2);
    assert.equal(stats.currentlyWatching, 2);
});

const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
function productionFunction(name) {
    const start = html.indexOf(`function ${name}(`), following = /\n(?:async )?function /g;
    following.lastIndex = start;
    const next = following.exec(html);
    assert.ok(start >= 0 && next, `Missing production helper ${name}`);
    return html.slice(start, next.index);
}
function journal(list, options = {}) {
    const initial = {
        [V.STORAGE_KEY]:JSON.stringify(list), [V.HISTORY_KEY]:JSON.stringify([{ id:"existing", animeId:"older", delta:1, at:before }]),
        anime_event_overrides_v10:"{}", anime_event_anime_overrides_v11:"{}", [V.WORKS_KEY]:"[]", [V.MANGA_HISTORY_KEY]:"[]",
        anime_theme_lookup_cache_v1:"{}", anime_theme_last_undo_v1:JSON.stringify({ original:true }),
        anime_tracker_last_undo_v11:JSON.stringify({ type:"delete", retained:true }),
        [V.RESTORE_KEY]:JSON.stringify([{ id:"existing-backup", retained:true }]), unrelated:"original bytes"
    };
    const data = new Map(Object.entries(initial)), operations = [];
    let mainWrites = 0;
    const storage = {
        getItem:key => data.get(key) ?? null,
        setItem(key, value) {
            value = String(value); operations.push({ kind:"set", key });
            if (key === V.STORAGE_KEY) mainWrites++;
            const candidate = new Map(data); candidate.set(key, value);
            const bytes = [...candidate].reduce((total, [k, v]) => total + 2 * (k.length + v.length), 0);
            if (options.failKey === key || (options.failCommit && key === "anime_tracker_startup_pending_v1" && JSON.parse(value).state === 1)
                || (options.failRollback && key === V.STORAGE_KEY && mainWrites > 1) || bytes > (options.limit ?? Infinity))
                throw new DOMException("Synthetic quota", "QuotaExceededError");
            data.set(key, value);
        },
        removeItem(key) { operations.push({ kind:"remove", key }); data.delete(key); },
        snapshot:() => Object.fromEntries(data)
    };
    const context = vm.createContext({ window:{ __ANIME_STARTUP_STORAGE__:{ persisted:true, recoveryPending:false, originalList:copy(list) } },
        localStorage:storage, STORAGE_KEY:V.STORAGE_KEY, EVENT_OVERRIDES_KEY:"anime_event_overrides_v10",
        EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11", AnimeTrackerV11:V, warnAnimeStartupStorage:() => {} });
    vm.runInContext(["getAnimeStartupStoredItem", "restoreAnimeStartupStorage", "isAnimeStartupSnapshot", "commitAnimeStartupChanges"].map(productionFunction).join("\n"), context);
    return { storage, context, initial, operations,
        writer:(writes, originalList) => { assert.equal(originalList, list); context.commitAnimeStartupChanges(writes, originalList); } };
}

for (const review of [false, true]) {
    test(`${review ? "review" : "normal"} progress uses the existing synchronous journal writer before publishing its history`, () => {
        const list = [anime("season-one", { category:review ? "review" : "watching" })], run = journal(list);
        const history = JSON.parse(run.initial[V.HISTORY_KEY]);
        const commit = review ? V.commitAnimeReviewProgress : V.commitAnimeProgress;
        const result = commit(run.storage, list, history, "season-one", 1, at, run.writer);
        assert.equal(result.changed, true);
        assert.equal(result.history.length, 2);
        assert.equal(JSON.parse(run.storage.getItem(V.HISTORY_KEY)).length, 2);
        assert.deepEqual(JSON.parse(run.storage.getItem(V.STORAGE_KEY)), result.list);
        assert.equal(run.storage.getItem("anime_tracker_startup_pending_v1"), null);
        assert.deepEqual(list, [anime("season-one", { category:review ? "review" : "watching" })]);
        for (const [key, value] of Object.entries(run.initial)) if (![V.STORAGE_KEY, V.HISTORY_KEY].includes(key))
            assert.equal(run.storage.getItem(key), value, key);
    });
}

for (const failKey of ["anime_tracker_startup_pending_v1", V.STORAGE_KEY, V.HISTORY_KEY]) {
    test(`progress quota failure at ${failKey} preserves original main/history/undo/backups without a success result`, () => {
        const list = [anime()], run = journal(list, { failKey }), beforeState = run.storage.snapshot(), beforeList = copy(list);
        assert.throws(() => V.commitAnimeProgress(run.storage, list, [], list[0].id, 1, at, run.writer), { name:"QuotaExceededError" });
        assert.deepEqual(run.storage.snapshot(), beforeState);
        assert.deepEqual(list, beforeList);
        assert.equal(V.isAnimeCurrentlyWatching(list[0]), false);
    });
}

test("actual aggregate storage capacity can reject the journal without modifying progress or history", () => {
    const list = [anime()], base = journal(list), limit = Object.entries(base.initial).reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0);
    const run = journal(list, { limit });
    assert.throws(() => V.commitAnimeProgress(run.storage, list, [], list[0].id, 1, at, run.writer), { name:"QuotaExceededError" });
    assert.deepEqual(run.storage.snapshot(), run.initial);
});

test("failure writing the durable commit marker rolls back both main and new watch history", () => {
    const list = [anime()], run = journal(list, { failCommit:true });
    assert.throws(() => V.commitAnimeProgress(run.storage, list, [], list[0].id, 1, at, run.writer), { name:"QuotaExceededError" });
    assert.deepEqual(run.storage.snapshot(), run.initial);
    assert.equal(run.context.window.__ANIME_STARTUP_STORAGE__.recoveryPending, false);
});

test("failed rollback retains the existing durable original-data overlay instead of publishing a fake success", () => {
    const list = [anime()], run = journal(list, { failKey:V.HISTORY_KEY, failRollback:true });
    assert.throws(() => V.commitAnimeProgress(run.storage, list, [], list[0].id, 1, at, run.writer), { name:"QuotaExceededError" });
    assert.equal(run.context.window.__ANIME_STARTUP_STORAGE__.recoveryPending, true);
    const snapshot = JSON.parse(run.storage.getItem("anime_tracker_startup_pending_v1"));
    assert.equal(snapshot.state, 0);
    assert.equal(snapshot.originals[V.STORAGE_KEY], run.initial[V.STORAGE_KEY]);
    assert.equal(snapshot.originals[V.HISTORY_KEY], run.initial[V.HISTORY_KEY]);
    assert.equal(run.context.getAnimeStartupStoredItem(V.STORAGE_KEY), run.initial[V.STORAGE_KEY]);
    assert.deepEqual(list, [anime()]);
    assert.equal(V.isAnimeCurrentlyWatching(list[0]), false);
});

for (const review of [false, true]) {
    for (const version of [at, "2030-01-01T00:00:00.000Z"]) {
        test(`${review ? "review" : "normal"} progress advances a known ${version === at ? "same-millisecond" : "future-clock"} version and survives both cloud merge orders`, () => {
            const original = anime("selected", { currentEpisode:0, watched:0, reviewWatched:0,
                category:review ? "review" : "watching", updatedAt:version });
            const sibling = anime("sibling", { currentEpisode:5, watched:5 });
            const update = review ? V.updateAnimeReviewProgress : V.updateAnimeProgress;
            const result = update([original, sibling], "selected", 1, at);
            assert.equal(result.anime.updatedAt, new Date(Date.parse(version) + 1).toISOString());
            assert.deepEqual(result.list[1], sibling);
            for (const merged of [V.mergeById(result.list, [original, sibling]), V.mergeById([original, sibling], result.list)]) {
                const record = merged.find(item => item.id === "selected");
                assert.equal(review ? record.reviewWatched : record.currentEpisode, 1);
                assert.equal(record.updatedAt, result.anime.updatedAt);
                assert.equal(record.notes, original.notes);
            }
        });
    }
}
