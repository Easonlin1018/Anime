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

function fixture(overrides = {}) {
    return V.migrateAnime({
        id:"local-uuid-1",
        anilistId:100,
        title:"原始名稱",
        aliases:["原名"],
        category:"watching",
        watched:8,
        currentEpisode:8,
        episodes:12,
        totalEpisodes:12,
        rating:9,
        review:"心得",
        note:"筆記",
        notes:"筆記",
        customPlatform:"自訂平台",
        platform:"動畫瘋",
        themeSongs:{openings:[{id:"op-1",type:"OP",sequence:1,title:"Song"}],endings:[]},
        customFutureField:"keep-me",
        createdAt:"2025-01-01T00:00:00.000Z",
        addedAt:"2025-01-01T00:00:00.000Z",
        updatedAt:"2026-01-01T00:00:00.000Z",
        ...overrides
    });
}

test("A. 人工改名保留主題曲、心得、平台與未知欄位", () => {
    const original = fixture();
    const result = V.updateAnimeTitleById([original], original.id, "人工新名稱", "2026-02-01T00:00:00.000Z");
    const renamed = result.anime;
    assert.equal(renamed.id, original.id);
    assert.equal(renamed.anilistId, original.anilistId);
    assert.equal(renamed.currentEpisode, 8);
    assert.equal(renamed.rating, 9);
    assert.equal(renamed.review, "心得");
    assert.equal(renamed.customPlatform, "自訂平台");
    assert.equal(renamed.themeSongs.openings[0].id, "op-1");
    assert.equal(renamed.customFutureField, "keep-me");
    assert.equal(renamed.titleManuallyEdited, true);
});

test("B. 分類移動只更新分類，不重設進度或使用者資料", () => {
    const original = fixture();
    const completed = V.moveAnimeCategoryById([original], original.id, "completed", "2026-02-01T00:00:00.000Z").anime;
    assert.equal(completed.category, "completed");
    for (const key of ["id", "anilistId", "watched", "currentEpisode", "rating", "review", "customPlatform", "themeSongs", "customFutureField"]) {
        assert.deepEqual(completed[key], original[key], key);
    }
});

test("C. UUID 作品補綁 AniList ID 後，本機 reference 與 work media id 不變", () => {
    const withoutExternalId = fixture({anilistId:null});
    const initialWorks = V.migrateWorks([withoutExternalId], [], "2026-01-01T00:00:00.000Z");
    const localAuxiliary = {[withoutExternalId.id]:{wanted:true}};
    const rebound = {...withoutExternalId, anilistId:103572, updatedAt:"2026-02-01T00:00:00.000Z"};
    const refreshedWorks = V.migrateWorks([rebound], initialWorks, "2026-02-01T00:00:00.000Z");
    const entry = refreshedWorks.flatMap(work => work.mediaEntries).find(item => item.id === withoutExternalId.id);
    assert.equal(entry.id, "local-uuid-1");
    assert.equal(entry.sourceId, "103572");
    assert.deepEqual(localAuxiliary[entry.id], {wanted:true});
});

test("D. 刪除只 tombstone 目標並清理其獨立 auxiliary reference", () => {
    const target = fixture();
    const other = fixture({id:"local-uuid-2",anilistId:200,title:"另一部"});
    const deleted = V.markAnimeDeletedById([target, other], target.id, "2026-02-01T00:00:00.000Z");
    assert.equal(deleted.list.length, 2);
    assert.equal(deleted.anime.deletedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(deleted.list[1].deletedAt, null);
    const auxiliary = V.cleanupAnimeAuxiliaryState({
        eventOverrides:{event1:{includeAnimeIds:[target.id,other.id],excludeAnimeIds:[target.id]}},
        eventAnimeOverrides:{event2:{relatedAnimeIds:[target.id,other.id]}},
        watchHistory:[{id:"watch-target",animeId:target.id,delta:1},{id:"watch-other",animeId:other.id,delta:2}],
        themeCache:{[`source:${target.id}`]:{value:1},[`source:${other.id}`]:{value:2},"themes:123":{value:3}},
        themeUndo:{animeId:target.id,themeSongs:target.themeSongs}
    }, target.id);
    assert.deepEqual(auxiliary.eventOverrides.event1.includeAnimeIds, [other.id]);
    assert.deepEqual(auxiliary.eventOverrides.event1.excludeAnimeIds, []);
    assert.deepEqual(auxiliary.eventAnimeOverrides.event2.relatedAnimeIds, [other.id]);
    assert.deepEqual(auxiliary.watchHistory, [{id:"watch-other",animeId:other.id,delta:2}]);
    assert.equal(auxiliary.themeCache[`source:${target.id}`], undefined);
    assert.deepEqual(auxiliary.themeCache[`source:${other.id}`], {value:2});
    assert.deepEqual(auxiliary.themeCache["themes:123"], {value:3});
    assert.equal(auxiliary.themeUndo, null);
});

test("E. 同名但 AniList ID 不同時，改名或刪除其中一部不影響另一部", () => {
    const first = fixture({id:"one",anilistId:1,title:"同名作品"});
    const second = fixture({id:"two",anilistId:2,title:"同名作品"});
    const renamed = V.updateAnimeTitleById([first,second], "one", "第一部新名").list;
    const deleted = V.markAnimeDeletedById(renamed, "one").list;
    assert.equal(deleted.find(item => item.id === "two").title, "同名作品");
    assert.equal(deleted.find(item => item.id === "two").deletedAt, null);
    assert.equal(deleted.find(item => item.id === "two").anilistId, 2);
});

test("F. 改 title 後 Supabase payload merge 仍以本機 id 合併為一筆", () => {
    const local = fixture({title:"舊名",updatedAt:"2026-01-01T00:00:00.000Z"});
    const renamed = V.updateAnimeTitleById([local], local.id, "新名", "2026-02-01T00:00:00.000Z").anime;
    const merged = V.mergeCloudPayload({animeList:[local],works:[]},{animeList:[renamed],works:[]});
    assert.equal(merged.animeList.length, 1);
    assert.equal(merged.animeList[0].id, local.id);
    assert.equal(merged.animeList[0].title, "新名");
});

test("G. 連續改名兩次仍維持同一份 local-id auxiliary data", () => {
    const original = fixture();
    const auxiliary = {[original.id]:{themeOverride:"keep"}};
    const first = V.updateAnimeTitleById([original], original.id, "名稱一").list;
    const second = V.updateAnimeTitleById(first, original.id, "名稱二").anime;
    assert.equal(second.id, original.id);
    assert.equal(Object.keys(auxiliary).length, 1);
    assert.deepEqual(auxiliary[second.id], {themeOverride:"keep"});
});

test("H. 分類來回移動不增加清單長度", () => {
    let list = [fixture()];
    for (const category of ["completed", "backlog", "watching", "completed"]) {
        list = V.moveAnimeCategoryById(list, "local-uuid-1", category).list;
    }
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "local-uuid-1");
    assert.equal(list[0].currentEpisode, 8);
});

test("I. 未知 auxiliary 欄位在改名與分類移動後不遺失", () => {
    const original = fixture({futureAuxiliary:{nested:{value:42}}});
    const renamed = V.updateAnimeTitleById([original], original.id, "新名稱").list;
    const moved = V.moveAnimeCategoryById(renamed, original.id, "backlog").anime;
    assert.deepEqual(moved.futureAuxiliary, {nested:{value:42}});
});

test("刪除作品不再出現在 calendar，cross-media 與 Spotify 有 cleanup hook", () => {
    const deleted = V.markAnimeDeletedById([fixture({nextEpisodeAt:"2026-02-05T12:00:00.000Z"})], "local-uuid-1", "2026-02-01T00:00:00.000Z").anime;
    assert.equal(V.calendarItems([deleted], []).length, 0);
    const deletedWork = V.migrateWorks([deleted], []);
    assert.equal(V.searchWorks(deletedWork).length, 0);
    const crossMedia = fs.readFileSync(path.resolve(__dirname, "..", "cross-media.js"), "utf8");
    const spotify = fs.readFileSync(path.resolve(__dirname, "..", "spotify-themes.js"), "utf8");
    assert.match(crossMedia, /function markAnimeDeleted\(/);
    assert.match(crossMedia, /function activeMediaEntries\(/);
    assert.match(spotify, /function cleanupAnime\(/);
    assert.match(spotify, /themeCacheKeysForAnime\(anime\)\.forEach\(key => delete cache\[key\]\)/);
});

if (!process.exitCode) console.log(`\nAll identity integrity tests passed: ${passed}/${passed}`);
