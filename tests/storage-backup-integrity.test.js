"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const V = require(require("./release-path.cjs")("v11-core.js"));

const time = "2023-02-08T14:30:00.000Z";
const oldAnime = { id:10081, title:"測試港灣", category:"review", watched:7, episodes:24,
    reviewWatched:3, note:"舊筆記", rating:8.5, addedAt:time, favorite:true };
const oldEvent = { id:"event-legacy", animeId:10081, delta:1, at:time, extra:{ source:"manual", flags:[1,2] } };

test("backup verification counts IDs, tombstones, history and works without changing the raw backup", () => {
    const raw = {
        schemaVersion:11, exportedAt:time,
        [V.STORAGE_KEY]:[oldAnime, { ...oldAnime,id:"10081",deletedAt:time }, { title:"暫無 ID" }],
        works:[{ workId:"w1", mediaEntries:[{ id:10081, mediaType:"anime" }] }],
        watchHistory:[oldEvent]
    };
    const saved = structuredClone(raw);
    const result = V.verifyAnimeBackup(raw);
    assert.equal(result.valid, true);
    assert.deepEqual(result.preview, {
        format:"完整備份", schemaVersion:11, exportedAt:time, animeCount:3,
        distinctIdCount:1, missingIdCount:1, duplicateIdCount:1, tombstoneCount:1,
        hasWorks:true, hasWatchHistory:true, workCount:1, mangaCount:0, mangaHistoryCount:0,
        overrideCount:0, historyCount:1, requiresEmptyConfirmation:false
    });
    assert.deepEqual(raw, saved);
    assert.equal(Object.hasOwn(result,"normalized"),false);
});

test("backup verification distinguishes omitted history and works from empty arrays", () => {
    const legacy = V.verifyAnimeBackup("\uFEFF" + JSON.stringify([oldAnime]));
    assert.equal(legacy.valid, true);
    assert.equal(legacy.preview.animeCount, 1);
    assert.equal(legacy.preview.hasWorks, false);
    assert.equal(legacy.preview.hasWatchHistory, false);
    const wrapped = V.verifyAnimeBackup({ [V.STORAGE_KEY]:JSON.stringify([oldAnime]), works:[], watchHistory:[] });
    assert.equal(wrapped.valid, true);
    assert.equal(wrapped.preview.hasWorks, true);
    assert.equal(wrapped.preview.hasWatchHistory, true);
    assert.equal(wrapped.preview.historyCount, 0);
    const oldHistoryKey = { [V.STORAGE_KEY]:[oldAnime], [V.HISTORY_KEY]:[oldEvent] };
    assert.equal(V.verifyAnimeBackup(oldHistoryKey).preview.historyCount, 1);
    assert.deepEqual(V.importBackup({ animeList:[] }, oldHistoryKey, "replace").watchHistory,[oldEvent]);
});

test("broken history, anime or nested works cannot preview or import as valid empty data", () => {
    const malformed = [
        "[", [null], { [V.STORAGE_KEY]:[oldAnime], watchHistory:{} },
        { [V.STORAGE_KEY]:[oldAnime], works:[{ mediaEntries:[null] }] },
        { [V.STORAGE_KEY]:[oldAnime], [V.MANGA_HISTORY_KEY]:["incomplete"] }
    ];
    for (const input of malformed) {
        assert.equal(V.verifyAnimeBackup(input).valid,false);
        assert.equal(V.validateBackup(input).valid,false);
        assert.throws(() => V.importBackup({ animeList:[oldAnime] },input,"replace"));
    }
});

test("repeated backup import does not double matching event IDs but preserves ambiguities and existing multiplicity", () => {
    const localManga = { id:"reading-1", workId:"manga-work", deltaChapters:3, timestamp:time };
    const legacyWithoutId = { animeId:10081, delta:1, at:time };
    const differentlyOrdered = { extra:{ flags:[1,2],source:"manual" }, at:time, delta:1, animeId:10081, id:oldEvent.id };
    const conflicting = { ...oldEvent,delta:2 };
    const current = { animeList:[oldAnime], watchHistory:[oldEvent,oldEvent,legacyWithoutId], mangaReadHistory:[localManga] };
    const incoming = { [V.STORAGE_KEY]:[oldAnime], watchHistory:[differentlyOrdered,conflicting,legacyWithoutId],
        [V.MANGA_HISTORY_KEY]:[localManga] };
    const merged = V.importBackup(current,incoming,"merge");
    assert.deepEqual(merged.watchHistory,[oldEvent,oldEvent,legacyWithoutId,conflicting,legacyWithoutId]);
    assert.deepEqual(merged.mangaReadHistory,[localManga]);

    const backup = V.createBackup({ animeList:[oldAnime], watchHistory:[oldEvent], mangaReadHistory:[localManga] });
    const first = V.importBackup({ animeList:[] },backup,"merge");
    const repeat = V.importBackup(first,backup,"merge");
    assert.deepEqual(repeat.watchHistory,[oldEvent]);
    assert.deepEqual(repeat.mangaReadHistory,[localManga]);
    assert.deepEqual(V.importBackup(current,incoming,"replace").watchHistory,incoming.watchHistory);
});
