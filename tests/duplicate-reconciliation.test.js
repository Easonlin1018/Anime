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

const base = (overrides = {}) => ({
    id:"local-1",
    anilistId:211709,
    title:"五等分的新娘【春夏秋冬】（2026）",
    aliases:["五等分的新娘【春夏秋冬】"],
    year:2026,
    startDate:{year:2026,month:1,day:1},
    format:"SPECIAL",
    category:"waiting",
    watched:0,
    currentEpisode:0,
    episodes:"??",
    createdAt:"2026-01-01T00:00:00.000Z",
    updatedAt:"2026-01-01T00:00:00.000Z",
    ...overrides
});

test("1. 五筆相同 AniList ID 遷移後只保留一筆", () => {
    const list = Array.from({length:5}, (_, index) => base({id:`local-${index + 1}`}));
    const result = V.reconcileExistingAnimeDuplicates(list);
    assert.equal(result.list.length, 1);
    assert.equal(result.mergedCount, 4);
    assert.equal(V.getAnimeAniListIdentity(result.list[0]), "211709");
});

test("2. local ID 不同但 AniList ID 相同仍合併", () => {
    const result = V.reconcileExistingAnimeDuplicates([base({id:"uuid-a"}), base({id:"uuid-b"})]);
    assert.equal(result.list.length, 1);
});

test("3. title 相同但 AniList ID 不同絕不合併", () => {
    const result = V.reconcileExistingAnimeDuplicates([base({id:"one",anilistId:1}), base({id:"two",anilistId:2})]);
    assert.equal(result.list.length, 2);
    assert.equal(result.changed, false);
});

test("4. 合併保留進度、評分、筆記、人工名稱、平台、歌曲與未知欄位", () => {
    const records = [
        base({id:"a",watched:8,currentEpisode:8,rating:9,note:"筆記 A",customFutureField:"keep-me"}),
        base({id:"b",title:"人工名稱",titleSource:"manual",titleManuallyEdited:true,review:"心得 B",customPlatform:"自訂平台",themeSongs:{openings:[{id:"op-1",title:"OP"}],endings:[]}})
    ];
    const merged = V.reconcileExistingAnimeDuplicates(records).list[0];
    assert.equal(merged.currentEpisode, 8);
    assert.equal(merged.watched, 8);
    assert.equal(merged.rating, 9);
    assert.equal(merged.note, "筆記 A");
    assert.equal(merged.review, "心得 B");
    assert.equal(merged.title, "人工名稱");
    assert.equal(merged.titleManuallyEdited, true);
    assert.equal(merged.customPlatform, "自訂平台");
    assert.equal(merged.themeSongs.openings[0].id, "op-1");
    assert.equal(merged.customFutureField, "keep-me");
});

test("5. auxiliary reference 全部遷移到被引用較多的 canonical local ID", () => {
    const state = {
        eventAnimeOverrides:{event:{includeAnimeIds:["preferred","duplicate"]}},
        watchHistory:[
            {id:"h1",animeId:"preferred",delta:1},
            {id:"h2",animeId:"preferred",delta:1},
            {id:"h3",animeId:"preferred",delta:1},
            {id:"h4",animeId:"preferred",delta:1},
            {id:"h5",animeId:"duplicate",delta:1}
        ],
        works:[{workId:"work-1",title:"系列",mediaEntries:[{id:"preferred",mediaType:"anime",title:"A"},{id:"duplicate",mediaType:"anime",title:"A"}]}],
        themeCache:{"source:duplicate":{cached:true}},
        themeUndo:{animeId:"duplicate"}
    };
    const result = V.reconcileExistingAnimeDuplicates([base({id:"preferred"}),base({id:"duplicate"})], state);
    assert.equal(result.list[0].id, "preferred");
    assert.deepEqual(result.state.eventAnimeOverrides.event.includeAnimeIds, ["preferred"]);
    assert.deepEqual(result.state.watchHistory.map(item => item.animeId), ["preferred","preferred","preferred","preferred","preferred"]);
    assert.equal(result.state.works[0].mediaEntries.filter(item => item.mediaType === "anime").length, 1);
    assert.deepEqual(result.state.themeCache["source:preferred"], {cached:true});
    assert.equal(result.state.themeUndo.animeId, "preferred");
});

test("6. migration 可重複執行，第二次為 0 changes", () => {
    const first = V.reconcileExistingAnimeDuplicates([base({id:"a"}),base({id:"b"})]);
    const second = V.reconcileExistingAnimeDuplicates(first.list, first.state);
    assert.equal(second.changed, false);
    assert.equal(second.mergedCount, 0);
    assert.deepEqual(second.list, first.list);
});

test("7. 刪除 canonical 後 active UI count 從 1 變 0", () => {
    const canonical = V.reconcileExistingAnimeDuplicates([base({id:"a"}),base({id:"b"})]).list;
    assert.equal(V.searchFilterSort(canonical).length, 1);
    const deleted = V.markAnimeDeletedById(canonical, canonical[0].id, "2026-02-01T00:00:00.000Z").list;
    assert.equal(V.searchFilterSort(deleted).length, 0);
    assert.equal(V.watchStats([], deleted).watching, 0);
    assert.equal(V.calendarItems(deleted, []).length, 0);
});

test("8. tombstone 保留於 Supabase merge，但不進 render/search/stats/calendar", () => {
    const deleted = V.markAnimeDeletedById([base({id:"stable",nextEpisodeAt:"2026-03-01T00:00:00.000Z"})], "stable", "2026-02-01T00:00:00.000Z").list[0];
    const merged = V.mergeCloudPayload({animeList:[deleted],works:[]},{animeList:[base({id:"stable",updatedAt:"2026-01-01T00:00:00.000Z"})],works:[]});
    assert.ok(merged.animeList[0].deletedAt);
    assert.equal(V.searchFilterSort(merged.animeList).length, 0);
    assert.equal(V.watchStats([], merged.animeList).completed, 0);
    assert.equal(V.calendarItems(merged.animeList, []).length, 0);
});

test("9. serialize / deserialize 不會讓已刪除作品復活", () => {
    const deleted = V.markAnimeDeletedById([base({id:"stable"})], "stable", "2026-02-01T00:00:00.000Z").list;
    const backup = JSON.parse(JSON.stringify(V.createBackup({animeList:deleted,works:[]})));
    const imported = V.importBackup({animeList:[],works:[]}, backup, "replace");
    assert.ok(imported.animeList[0].deletedAt);
    assert.equal(V.searchFilterSort(imported.animeList).length, 0);
});

test("10. 復原 tombstone 只恢復一筆且 identity 與使用者資料不變", () => {
    const original = base({id:"stable",watched:3,currentEpisode:3,rating:8,note:"保留"});
    const deleted = V.markAnimeDeletedById([original], original.id, "2026-02-01T00:00:00.000Z").list;
    const restored = V.restoreAnimeById(deleted, original.id, [original], "2026-02-02T00:00:00.000Z").list;
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, "stable");
    assert.equal(restored[0].anilistId, 211709);
    assert.equal(restored[0].currentEpisode, 3);
    assert.equal(restored[0].rating, 8);
    assert.equal(restored[0].note, "保留");
    assert.equal(restored[0].deletedAt, null);
});

test("11. 年份 badge 使用 startDate.year", () => {
    assert.deepEqual(V.getAnimeTitlePresentation({title:"作品",startDate:{year:2019},year:2020}), {title:"作品",year:2019});
});

test("12. title 已含同年時畫面去除尾端年份，不重複顯示", () => {
    assert.deepEqual(V.getAnimeTitlePresentation({title:"五等分的新娘（2019）",startDate:{year:2019}}), {title:"五等分的新娘",year:2019});
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    assert.match(html, /anime-year-badge/u);
    assert.match(html, /\.filter\(anime => !anime\.deletedAt\)/u);
});

test("13. 人工名稱含不同年份時不改字串也不再加衝突 badge", () => {
    assert.deepEqual(V.getAnimeTitlePresentation({title:"我的剪輯版（2020）",startDate:{year:2019},titleSource:"manual",titleManuallyEdited:true}), {title:"我的剪輯版（2020）",year:null});
});

if (!process.exitCode) console.log(`\nAll duplicate reconciliation tests passed: ${passed}/${passed}`);
