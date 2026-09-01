"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}\n  ${error.stack}`);
        process.exitCode = 1;
    }
}

function quotaError() {
    return new DOMException("Quota exceeded", "QuotaExceededError");
}

function quotaStorage(limitBytes = Infinity, failKey = "") {
    const data = new Map();
    const bytes = value => String(value).length * 2;
    let capacity = limitBytes;
    return {
        data,
        setItem(key, value) {
            if (String(key) === String(failKey)) throw quotaError();
            const nextValue = String(value);
            const currentBytes = [...data.entries()].reduce((total, [storedKey, storedValue]) => total + bytes(storedKey) + bytes(storedValue), 0);
            const oldBytes = data.has(key) ? bytes(key) + bytes(data.get(key)) : 0;
            const nextBytes = currentBytes - oldBytes + bytes(key) + bytes(nextValue);
            if (nextBytes > capacity) throw quotaError();
            data.set(String(key), nextValue);
        },
        getItem:key => data.get(String(key)) ?? null,
        removeItem:key => data.delete(String(key)),
        setLimit(value) { capacity = Number(value); },
        usedBytes() {
            return [...data.entries()].reduce((total, [key, value]) => total + bytes(key) + bytes(value), 0);
        },
        snapshot() { return Object.fromEntries([...data.entries()].sort(([a], [b]) => a.localeCompare(b))); }
    };
}

const at = "2026-09-01T12:00:00.000Z";
const undoKey = "anime_tracker_last_undo_v11";
function anime(id, anilistId, title, overrides = {}) {
    return V.migrateAnime({
        id, anilistId, title, displayTitle:title, canonicalTitle:title,
        groupTitle:"通用系列", seriesKey:"anilist:series-generic",
        category:"completed", watched:12, currentEpisode:12,
        episodes:12, totalEpisodes:12, rating:9, notes:"保留資料",
        customPlatform:"自訂平台", aliases:[title, `${title} alias`],
        themeSongs:{ openings:[], endings:[] },
        createdAt:"2026-01-01T00:00:00.000Z",
        updatedAt:"2026-08-31T00:00:00.000Z",
        ...overrides
    }, at);
}

function auxiliaryFor(targetId) {
    return {
        eventOverrides:{ e1:{ includeAnimeIds:[targetId, "other"], note:"event" }, e2:{ includeAnimeIds:["other"] } },
        eventAnimeOverrides:{ e3:{ excludeAnimeIds:[targetId] } },
        watchHistory:[
            { id:"h1", animeId:targetId, delta:1, episode:1, at:"2026-01-01T00:00:00.000Z" },
            { id:"h2", animeId:"other", delta:1, episode:1, at:"2026-01-02T00:00:00.000Z" }
        ],
        themeCache:{ [`source:${targetId}`]:{ value:{ malId:1 }, queriedAt:1, ttl:1 }, "source:other":{ value:{ malId:2 } } },
        themeUndo:{ animeId:targetId, before:{ openings:[], endings:[] } }
    };
}

function runTransaction({ list, target, storage = null, failStage = "", trace = [] } = {}) {
    const failKeys = { history:V.HISTORY_KEY, works:V.WORKS_KEY, storage:V.STORAGE_KEY };
    const transactionStorage = storage || quotaStorage(Infinity, failKeys[failStage] || "");
    const state = auxiliaryFor(target.id);
    const undo = V.createCompactDeleteUndo(target, target.anilistId, state, {
        spotify:{ animeId:target.id, cacheKey:`source:${target.id}`, cachePresent:true },
        crossMedia:{ workId:"work-1", mediaId:target.id }
    }, at);
    let rollbackCount = 0;
    const result = V.runAnimeDeleteTransaction({
        list,
        id:target.id,
        identity:String(target.anilistId),
        now:at,
        undo,
        undoKey,
        storage:transactionStorage,
        trace:step => trace.push(step),
        cleanup:() => {
            if (failStage === "history" || failStage === "works") {
                try { transactionStorage.setItem(failStage === "history" ? V.HISTORY_KEY : V.WORKS_KEY, "[]"); }
                catch (error) { error.deleteStage = failStage; throw error; }
            }
            if (["spotify", "cross-media"].includes(failStage)) {
                const error = new Error(`${failStage} failed`);
                error.deleteStage = failStage;
                throw error;
            }
            return V.cleanupAnimeAuxiliaryState(state, target.id);
        },
        persist:nextList => transactionStorage.setItem(V.STORAGE_KEY, JSON.stringify(nextList)),
        rollback:() => { rollbackCount++; }
    });
    return { result, undo, state, rollbackCount };
}

const target = anime("local-s2", 2002, "第二季");
const sibling = anime("local-s1", 2001, "第一季");

test("1. 舊 full undo 在接近 quota 時會先拋錯且尚未建立 tombstone", () => {
    const library = Array.from({ length:400 }, (_, index) => anime(`local-${index}`, 3000 + index, `作品 ${index}`, { notes:"x".repeat(600) }));
    const fullUndo = { type:"delete", targetId:target.id, targetIdentity:"2002", at, before:library, auxiliary:{ ...auxiliaryFor(target.id), works:Array.from({ length:80 }, (_, index) => ({ workId:`w-${index}`, mediaEntries:library.slice(index, index + 2) })) } };
    const compactUndo = V.createCompactDeleteUndo(target, "2002", auxiliaryFor(target.id), {}, at);
    const fullBytes = JSON.stringify(fullUndo).length * 2;
    const compactBytes = JSON.stringify(compactUndo).length * 2;
    const storage = quotaStorage(24000 + compactBytes + 200);
    storage.setItem("near-quota-fixture", "x".repeat(12000));
    assert.throws(() => storage.setItem(undoKey, JSON.stringify(fullUndo)), error => error.name === "QuotaExceededError");
    storage.setItem(undoKey, JSON.stringify(compactUndo));
    assert.ok(fullBytes > compactBytes * 20);
    console.log(`  full undo ${fullBytes} bytes; compact undo ${compactBytes} bytes`);
});

test("2. UNDO_KEY QuotaExceededError 重現 confirm 後無 tombstone 的第一個失敗點", () => {
    const trace = [];
    let cleanupCalled = false, persistCalled = false;
    const undo = V.createCompactDeleteUndo(target, "2002", auxiliaryFor(target.id), {}, at);
    const result = V.runAnimeDeleteTransaction({
        list:[sibling, target], id:target.id, identity:"2002", now:at, undo, undoKey,
        storage:quotaStorage(Infinity, undoKey), trace:step => trace.push(step),
        cleanup:() => { cleanupCalled = true; }, persist:() => { persistCalled = true; }
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "undo");
    assert.equal(result.quotaExceeded, true);
    assert.equal(cleanupCalled, false);
    assert.equal(persistCalled, false);
    assert.equal(result.list.find(item => item.anilistId === 2002).deletedAt, null);
    assert.deepEqual(trace, ["STEP 1 findAnimeRecordIndex", "STEP 4 JSON.stringify undo", "STEP 5 save UNDO_KEY"]);
});

test("3. compact undo 成功後單一 Media 正常 tombstone", () => {
    const { result } = runTransaction({ list:[sibling, target], target });
    assert.equal(result.ok, true);
    assert.equal(result.list.find(item => item.anilistId === 2001).deletedAt, null);
    assert.ok(result.list.find(item => item.anilistId === 2002).deletedAt);
});

test("4. compact undo 完整恢復 exact record 與 targeted auxiliary refs", () => {
    const state = auxiliaryFor(target.id);
    const undo = V.createCompactDeleteUndo(target, "2002", state, {}, at);
    const deletedList = V.markAnimeDeletedById([sibling, target], target.id, at, "2002").list;
    const cleaned = V.cleanupAnimeAuxiliaryState(state, target.id);
    const restored = V.restoreDeleteUndoState(deletedList, cleaned, undo, "2026-09-01T13:00:00.000Z");
    const restoredTarget = restored.list.find(item => item.anilistId === 2002);
    assert.equal(restoredTarget.deletedAt, null);
    assert.equal(restoredTarget.rating, 9);
    assert.equal(restoredTarget.notes, "保留資料");
    assert.deepEqual(restored.state.eventOverrides.e1.includeAnimeIds.sort(), ["local-s2", "other"].sort());
    assert.equal(restored.state.watchHistory.filter(record => record.animeId === target.id).length, 1);
    assert.ok(restored.state.themeCache[`source:${target.id}`]);
    assert.equal(restored.state.themeUndo.animeId, target.id);
});

test("5. legacy full before undo 仍能 restore", () => {
    const before = [sibling, target];
    const deleted = V.markAnimeDeletedById(before, target.id, at, "2002").list;
    const legacy = { type:"delete", targetId:target.id, targetIdentity:"2002", before, auxiliary:auxiliaryFor(target.id) };
    const restored = V.restoreDeleteUndoState(deleted, V.cleanupAnimeAuxiliaryState(auxiliaryFor(target.id), target.id), legacy, at);
    assert.equal(restored.legacy, true);
    assert.equal(restored.list.find(item => item.anilistId === 2002).deletedAt, null);
    assert.equal(restored.state.watchHistory.length, 2);
});

["history", "works", "spotify", "cross-media"].forEach((stage, offset) => {
    test(`${6 + offset}. ${stage} cleanup failure 會 rollback 且不留下 tombstone`, () => {
        const { result, rollbackCount } = runTransaction({ list:[sibling, target], target, failStage:stage });
        assert.equal(result.ok, false);
        assert.equal(result.stage, stage);
        assert.equal(rollbackCount, 1);
        assert.equal(result.list.find(item => item.anilistId === 2002).deletedAt, null);
    });
});

test("10. STORAGE_KEY persist QuotaExceededError 會 rollback", () => {
    const { result, rollbackCount } = runTransaction({ list:[sibling, target], target, failStage:"storage" });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "persist");
    assert.equal(result.quotaExceeded, true);
    assert.equal(rollbackCount, 1);
    assert.equal(result.list.filter(item => !item.deletedAt).length, 2);
});

test("11. localStorage 完全無空間時不刪除，UI 有明確錯誤 toast", () => {
    const storage = quotaStorage(0);
    const { result } = runTransaction({ list:[sibling, target], target, storage });
    const ui = fs.readFileSync(path.resolve(__dirname, "..", "v11-ui.js"), "utf8");
    assert.equal(result.stage, "undo");
    assert.equal(result.quotaExceeded, true);
    assert.equal(result.list.filter(item => !item.deletedAt).length, 2);
    assert.match(ui, /儲存空間不足，無法建立刪除復原點，因此未刪除/u);
});

test("12. transaction trace 保留 mark、cleanup、persist 順序", () => {
    const trace = [];
    const { result } = runTransaction({ list:[sibling, target], target, trace });
    assert.equal(result.ok, true);
    assert.deepEqual(trace, [
        "STEP 1 findAnimeRecordIndex", "STEP 4 JSON.stringify undo", "STEP 5 save UNDO_KEY",
        "STEP 6 markAnimeDeletedById", "STEP 7 cleanupAnimeAuxiliaryReferences", "STEP 8 saveAndRender"
    ]);
});

test("13. UI 採 compact undo 且不再把整個 animeList 存進單部刪除復原點", () => {
    const ui = fs.readFileSync(path.resolve(__dirname, "..", "v11-ui.js"), "utf8");
    const deleteBlock = ui.slice(ui.indexOf("deleteAnime = function"), ui.indexOf("const originalBuildAnimeItem"));
    assert.match(deleteBlock, /createCompactDeleteUndo/u);
    assert.match(deleteBlock, /runAnimeDeleteTransaction/u);
    assert.doesNotMatch(deleteBlock, /before:\s*animeList/u);
});

test("14. Spotify 與 CrossMedia 提供 targeted snapshot/restore API", () => {
    const spotify = fs.readFileSync(path.resolve(__dirname, "..", "spotify-themes.js"), "utf8");
    const crossMedia = fs.readFileSync(path.resolve(__dirname, "..", "cross-media.js"), "utf8");
    assert.match(spotify, /snapshotAnimeCleanup/u);
    assert.match(spotify, /restoreAnimeCleanupSnapshot/u);
    assert.match(crossMedia, /snapshotAnimeDeletion/u);
    assert.match(crossMedia, /restoreAnimeDeletionSnapshot/u);
});

test("15. 舊流程的 UNDO quota fault 完整重現 confirm 後無 toast、UI 不變", () => {
    const storage = quotaStorage(Infinity, undoKey), toasts = [];
    let list = [sibling, target], confirmAccepted = true, thrown = null;
    try {
        if (!confirmAccepted) return;
        storage.setItem(undoKey, JSON.stringify({ type:"delete", before:list, auxiliary:auxiliaryFor(target.id) }));
        list = V.markAnimeDeletedById(list, target.id, at, "2002").list;
        toasts.push("deleted");
    } catch (error) { thrown = error; }
    assert.equal(confirmAccepted, true);
    assert.equal(thrown.name, "QuotaExceededError");
    assert.equal(toasts.length, 0);
    assert.equal(list.find(item => item.anilistId === 2002).deletedAt, null);
    assert.equal(list.filter(item => !item.deletedAt).length, 2);
});

test("16. rollback restore 失敗時必須保留 compact recovery，不能刪除 UNDO_KEY", () => {
    const storage = quotaStorage(), state = auxiliaryFor(target.id);
    const undo = V.createCompactDeleteUndo(target, "2002", state, {}, at);
    const result = V.runAnimeDeleteTransaction({
        list:[sibling, target], id:target.id, identity:"2002", now:at, undo, undoKey, storage,
        cleanup:() => {
            storage.setItem(V.HISTORY_KEY, "[]");
            const error = new Error("persist failed");
            error.deleteStage = "persist";
            throw error;
        },
        persist:() => {},
        rollback:() => { throw quotaError(); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.rollbackSucceeded, false);
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.error.rollbackError.name, "QuotaExceededError");
    assert.equal(storage.getItem(undoKey), JSON.stringify(undo));
});

test("17. near-quota partial rollback 會保留真實 persistent recovery，之後可補完 auxiliary restore", () => {
    const EVENT_KEY = "anime_event_overrides_v10";
    const EVENT_ANIME_KEY = "anime_event_anime_overrides_v11";
    const THEME_KEY = "anime_theme_lookup_cache_v1";
    const list = [sibling, target], state = auxiliaryFor(target.id);
    state.watchHistory[0].payload = "h".repeat(1200);
    const undo = V.createCompactDeleteUndo(target, "2002", state, {
        spotify:{ animeId:target.id, cacheKey:`source:${target.id}`, cachePresent:true },
        crossMedia:{ workId:"work-1", mediaId:target.id }
    }, at);
    const worksBefore = [{ workId:"work-1", mediaEntries:[{ id:target.id, deletedAt:null }] }];
    const before = {
        [V.STORAGE_KEY]:JSON.stringify(list),
        [EVENT_KEY]:JSON.stringify(state.eventOverrides),
        [EVENT_ANIME_KEY]:JSON.stringify(state.eventAnimeOverrides),
        [V.HISTORY_KEY]:JSON.stringify(state.watchHistory),
        [THEME_KEY]:JSON.stringify(state.themeCache),
        [V.WORKS_KEY]:JSON.stringify(worksBefore)
    };
    const storage = quotaStorage();
    Object.entries(before).forEach(([key, value]) => storage.setItem(key, value));
    const undoBytes = (undoKey.length + JSON.stringify(undo).length) * 2;
    storage.setLimit(storage.usedBytes() + undoBytes + 120);
    const cleaned = V.cleanupAnimeAuxiliaryState(state, target.id);
    const deletedWorks = [{
        workId:"work-1",
        mediaEntries:[{ id:target.id, deletedAt:at, updatedAt:at, syncEnvelope:"w".repeat(600) }]
    }];
    const result = V.runAnimeDeleteTransaction({
        list, id:target.id, identity:"2002", now:at, undo, undoKey, storage,
        cleanup:() => {
            storage.setItem(EVENT_KEY, JSON.stringify(cleaned.eventOverrides));
            storage.setItem(EVENT_ANIME_KEY, JSON.stringify(cleaned.eventAnimeOverrides));
            storage.setItem(V.HISTORY_KEY, JSON.stringify(cleaned.watchHistory));
            storage.setItem(THEME_KEY, JSON.stringify(cleaned.themeCache));
            storage.setItem(V.WORKS_KEY, JSON.stringify(deletedWorks));
            return cleaned;
        },
        persist:nextList => storage.setItem(V.STORAGE_KEY, JSON.stringify(nextList) + "x".repeat(2000)),
        rollback:() => {
            const errors = [];
            [
                () => storage.setItem(EVENT_KEY, before[EVENT_KEY]),
                () => storage.setItem(EVENT_ANIME_KEY, before[EVENT_ANIME_KEY]),
                () => storage.setItem(V.HISTORY_KEY, before[V.HISTORY_KEY]),
                () => storage.setItem(THEME_KEY, before[THEME_KEY]),
                () => storage.setItem(V.WORKS_KEY, before[V.WORKS_KEY]),
                () => storage.setItem(V.STORAGE_KEY, before[V.STORAGE_KEY])
            ].forEach(action => { try { action(); } catch (error) { errors.push(error); } });
            if (errors.length) throw errors[0];
        }
    });
    assert.equal(result.ok, false);
    assert.equal(result.rollbackSucceeded, false);
    assert.equal(result.recoveryRequired, true);
    assert.ok(storage.getItem(undoKey), "compact undo must survive partial rollback");
    assert.equal(storage.getItem(V.STORAGE_KEY), before[V.STORAGE_KEY], "main anime record remains active");
    assert.notEqual(storage.getItem(V.HISTORY_KEY), before[V.HISTORY_KEY], "history demonstrates partial persistent rollback");
    assert.equal(storage.getItem(V.WORKS_KEY), before[V.WORKS_KEY], "later rollback steps still run");

    storage.setLimit(Infinity);
    const recovery = V.restoreDeleteUndoState(
        JSON.parse(storage.getItem(V.STORAGE_KEY)),
        {
            eventOverrides:JSON.parse(storage.getItem(EVENT_KEY)),
            eventAnimeOverrides:JSON.parse(storage.getItem(EVENT_ANIME_KEY)),
            watchHistory:JSON.parse(storage.getItem(V.HISTORY_KEY)),
            themeCache:JSON.parse(storage.getItem(THEME_KEY)),
            themeUndo:null
        },
        JSON.parse(storage.getItem(undoKey)),
        "2026-09-01T13:00:00.000Z"
    );
    assert.equal(recovery.restored, true, "active anime must not block auxiliary recovery");
    storage.setItem(V.STORAGE_KEY, JSON.stringify(recovery.list));
    storage.setItem(EVENT_KEY, JSON.stringify(recovery.state.eventOverrides));
    storage.setItem(EVENT_ANIME_KEY, JSON.stringify(recovery.state.eventAnimeOverrides));
    storage.setItem(V.HISTORY_KEY, JSON.stringify(recovery.state.watchHistory));
    storage.setItem(THEME_KEY, JSON.stringify(recovery.state.themeCache));
    storage.removeItem(undoKey);
    assert.deepEqual(JSON.parse(storage.getItem(V.HISTORY_KEY)), state.watchHistory);
    assert.equal(storage.getItem(undoKey), null);
});

test("18. rollback incomplete 的 UI 必須警告 recoveryRequired，不能宣稱資料未變更", () => {
    const ui = fs.readFileSync(path.resolve(__dirname, "..", "v11-ui.js"), "utf8");
    const deleteBlock = ui.slice(ui.indexOf("deleteAnime = function"), ui.indexOf("const originalBuildAnimeItem"));
    assert.match(deleteBlock, /recoveryRequired/u);
    assert.match(deleteBlock, /復原資料已保留/u);
    assert.doesNotMatch(deleteBlock, /刪除交易已取消，資料未變更/u);
});

test("19. rollback success 後 persistent state 完整等於 before 且移除 failed transaction undo", () => {
    const storage = quotaStorage();
    const before = {
        [V.STORAGE_KEY]:JSON.stringify([sibling, target]),
        [V.HISTORY_KEY]:JSON.stringify(auxiliaryFor(target.id).watchHistory),
        [V.WORKS_KEY]:JSON.stringify([{ workId:"work-1", mediaEntries:[{ id:target.id, deletedAt:null }] }])
    };
    Object.entries(before).forEach(([key, value]) => storage.setItem(key, value));
    const undo = V.createCompactDeleteUndo(target, "2002", auxiliaryFor(target.id), {}, at);
    const result = V.runAnimeDeleteTransaction({
        list:[sibling, target], id:target.id, identity:"2002", now:at, undo, undoKey, storage,
        cleanup:() => {
            storage.setItem(V.HISTORY_KEY, "[]");
            storage.setItem(V.WORKS_KEY, JSON.stringify([{ workId:"work-1", mediaEntries:[{ id:target.id, deletedAt:at }] }]));
            const error = new Error("persist failed");
            error.deleteStage = "persist";
            throw error;
        },
        persist:() => {},
        rollback:() => Object.entries(before).forEach(([key, value]) => storage.setItem(key, value))
    });
    assert.equal(result.ok, false);
    assert.equal(result.rollbackSucceeded, true);
    assert.equal(result.recoveryRequired, false);
    assert.equal(storage.getItem(undoKey), null);
    assert.deepEqual(storage.snapshot(), Object.fromEntries(Object.entries(before).sort(([a], [b]) => a.localeCompare(b))));
});

[
    ["history", V.HISTORY_KEY],
    ["spotify", "anime_theme_lookup_cache_v1"],
    ["cross-media", V.WORKS_KEY],
    ["storage", V.STORAGE_KEY]
].forEach(([rollbackStage, touchedKey], offset) => {
    test(`${20 + offset}. ${rollbackStage} restore failure 會保留 compact recovery`, () => {
        const storage = quotaStorage(), undo = V.createCompactDeleteUndo(target, "2002", auxiliaryFor(target.id), {}, at);
        storage.setItem(touchedKey, JSON.stringify({ before:true }));
        const result = V.runAnimeDeleteTransaction({
            list:[sibling, target], id:target.id, identity:"2002", now:at, undo, undoKey, storage,
            cleanup:() => {
                storage.setItem(touchedKey, JSON.stringify({ partial:true }));
                const error = new Error("delete persist failed");
                error.deleteStage = "persist";
                throw error;
            },
            persist:() => {},
            rollback:() => {
                const error = quotaError();
                error.rollbackStage = rollbackStage;
                throw error;
            }
        });
        assert.equal(result.ok, false);
        assert.equal(result.rollbackSucceeded, false);
        assert.equal(result.recoveryRequired, true);
        assert.equal(result.rollbackError.rollbackStage, rollbackStage);
        assert.ok(storage.getItem(undoKey));
        assert.deepEqual(JSON.parse(storage.getItem(touchedKey)), { partial:true });
    });
});

if (!process.exitCode) console.log(`Mobile delete storage failure tests: ${passed}/${passed} passed`);
