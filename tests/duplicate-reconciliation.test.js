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

test("14. 相同 local ID 與相同 AniList ID 會合併成一筆", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        base({id:"collision",anilistId:209939,title:"葬送的芙莉蓮 第三季"}),
        base({id:"collision",anilistId:209939,title:"葬送的芙莉蓮 第三季"})
    ]);
    assert.equal(result.list.length, 1);
    assert.equal(result.mergedCount, 1);
    assert.equal(result.reassignedCount, 0);
});

test("15. 相同 local ID 但不同 AniList ID 保留兩筆並重新編號", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        base({id:"collision",anilistId:209939,title:"葬送的芙莉蓮 第三季"}),
        base({id:"collision",anilistId:170068,title:"葬送的小劇場"})
    ]);
    assert.equal(result.list.length, 2);
    assert.equal(new Set(result.list.map(item => String(item.id))).size, 2);
    assert.equal(result.mergedCount, 0);
    assert.equal(result.reassignedCount, 1);
});

test("16. tombstone 排在 active 前面時仍能刪除 active record", () => {
    const list = [
        base({id:"collision",anilistId:1,deletedAt:"2026-01-01T00:00:00.000Z",category:"_deleted"}),
        base({id:"collision",anilistId:2,deletedAt:null,category:"waiting"})
    ];
    const result = V.markAnimeDeletedById(list, "collision", "2026-02-01T00:00:00.000Z");
    assert.equal(result.changed, true);
    assert.equal(result.anime.anilistId, 2);
    assert.ok(result.list[1].deletedAt);
});

test("17. 兩張相同卡片可連續刪到 active count 0", () => {
    let list = V.reconcileExistingAnimeDuplicates([
        base({id:"collision",anilistId:209939,title:"葬送的芙莉蓮 第三季"}),
        base({id:"collision",anilistId:200001,title:"葬送的芙莉蓮 第三季"})
    ]).list;
    assert.equal(V.searchFilterSort(list).length, 2);
    list = V.markAnimeDeletedById(list, list[0].id, "2026-02-01T00:00:00.000Z", "209939").list;
    assert.equal(V.searchFilterSort(list).length, 1);
    const remaining = list.find(item => !item.deletedAt);
    list = V.markAnimeDeletedById(list, remaining.id, "2026-02-02T00:00:00.000Z", V.getAnimeAniListIdentity(remaining)).list;
    assert.equal(V.searchFilterSort(list).length, 0);
});

test("18. delete 後 serialize / reload 不會復活", () => {
    let list = V.reconcileExistingAnimeDuplicates([
        base({id:"collision",anilistId:209939}),
        base({id:"collision",anilistId:200001})
    ]).list;
    for (const item of [...list]) {
        list = V.markAnimeDeletedById(list, item.id, "2026-02-01T00:00:00.000Z", V.getAnimeAniListIdentity(item)).list;
    }
    const reloaded = V.migrateList(JSON.parse(JSON.stringify(list)));
    assert.equal(V.searchFilterSort(reloaded).length, 0);
});

test("19. restore 依 AniList identity 只恢復正確 record", () => {
    const before = [
        base({id:"collision",anilistId:1,title:"A"}),
        base({id:"collision",anilistId:2,title:"B"})
    ];
    const deleted = V.markAnimeDeletedById(before, "collision", "2026-02-01T00:00:00.000Z", "2").list;
    const restored = V.restoreAnimeById(deleted, "collision", before, "2026-02-02T00:00:00.000Z", "2").list;
    assert.equal(restored.find(item => item.anilistId === 2).deletedAt, null);
    assert.equal(restored.find(item => item.anilistId === 1).title, "A");
});

test("20. local ID migration 可重複執行且第二次不再換 ID", () => {
    const first = V.reconcileExistingAnimeDuplicates([
        base({id:"collision",anilistId:1}),
        base({id:"collision",anilistId:2})
    ]);
    const ids = first.list.map(item => item.id);
    const second = V.reconcileExistingAnimeDuplicates(first.list, first.state);
    assert.equal(second.changed, false);
    assert.equal(second.reassignedCount, 0);
    assert.deepEqual(second.list.map(item => item.id), ids);
});

test("21. 可辨識 AniList identity 的 auxiliary reference 會跟隨新 local ID", () => {
    const state = {
        works:[{workId:"work-1",mediaEntries:[{id:"collision",mediaType:"anime",anilistId:2,title:"B"}]}],
        watchHistory:[{id:"history-1",animeId:"collision",anilistId:2,delta:1}],
        themeUndo:{animeId:"collision",anilistId:2}
    };
    const result = V.ensureUniqueLocalAnimeIds([
        base({id:"collision",anilistId:1,title:"A"}),
        base({id:"collision",anilistId:2,title:"B"})
    ], state, {idFactory:() => "new-local-id", now:"2026-02-01T00:00:00.000Z"});
    assert.equal(result.state.works[0].mediaEntries[0].id, "new-local-id");
    assert.equal(result.state.watchHistory[0].animeId, "new-local-id");
    assert.equal(result.state.themeUndo.animeId, "new-local-id");
});

test("22. 相同 title 與不同 AniList ID 不會因 local ID collision 合併", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        base({id:"collision",anilistId:209939,title:"葬送的芙莉蓮 第三季",canonicalTitle:"葬送のフリーレン 第3期"}),
        base({id:"collision",anilistId:170068,title:"葬送的芙莉蓮 第三季",canonicalTitle:"葬送のフリーレン ミニアニメ"})
    ]);
    assert.equal(result.list.length, 2);
    assert.deepEqual(new Set(result.list.map(item => item.anilistId)), new Set([209939,170068]));
    assert.equal(new Set(result.list.map(item => item.id)).size, 2);
});

test("23. 不同 AniList Media 的同 display title 保留為兩筆且正式 metadata 各自保留", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        base({id:"a",anilistId:209939,title:"葬送的芙莉蓮 第三季",displayTitle:"葬送的芙莉蓮 第三季",canonicalTitle:"葬送のフリーレン 第3期"}),
        base({id:"b",anilistId:170068,title:"葬送的芙莉蓮 第三季",displayTitle:"葬送的芙莉蓮 第三季",canonicalTitle:"葬送のフリーレン ミニアニメ"})
    ]);
    assert.equal(result.list.length, 2);
    assert.notEqual(result.list[0].canonicalTitle, result.list[1].canonicalTitle);
});

function frierenSecond(overrides = {}) {
    return base({
        id:"frieren-known",
        anilistId:182255,
        sourceId:"182255",
        title:"葬送的芙莉蓮 第二季（2026）",
        displayTitle:"葬送的芙莉蓮 第二季（2026）",
        canonicalTitle:"葬送的芙莉蓮 第二季",
        groupTitle:"葬送的芙莉蓮",
        aliases:["葬送的芙莉蓮 第二季", "葬送のフリーレン 第2期", "Sousou no Frieren 2nd Season"],
        anilistTitles:{native:"葬送のフリーレン 第2期",english:"Frieren: Beyond Journey’s End Season 2",romaji:"Sousou no Frieren 2nd Season"},
        year:2026,
        startDate:{year:2026,month:1,day:16},
        format:"TV",
        status:"FINISHED",
        episodes:10,
        totalEpisodes:10,
        releasedEpisodes:10,
        ...overrides
    });
}

test("24. 有 AniList ID 與保守吻合的 legacy no-ID shadow 會補綁後合併", () => {
    const legacy = frierenSecond({
        id:"legacy-shadow",
        anilistId:undefined,
        sourceId:undefined,
        episodes:"??",
        totalEpisodes:"??"
    });
    const result = V.reconcileExistingAnimeDuplicates([frierenSecond(), legacy]);
    assert.equal(result.list.length, 1);
    assert.equal(result.mergedCount, 1);
    assert.equal(result.legacyBoundCount, 1);
    assert.equal(result.list[0].id, "frieren-known");
    assert.equal(result.list[0].anilistId, 182255);
    assert.equal(result.list[0].episodes, 10);
    assert.equal(result.list[0].totalEpisodes, 10);
});

test("25. legacy shadow 上的使用者資料與 auxiliary reference 合併後完整保留", () => {
    const legacy = frierenSecond({
        id:"legacy-shadow",
        anilistId:undefined,
        sourceId:undefined,
        watched:7,
        currentEpisode:7,
        rating:9,
        review:"legacy review",
        note:"legacy note",
        customPlatform:"自訂平台",
        customFutureField:"keep-me",
        themeSongs:{openings:[{id:"op-legacy",title:"Legacy OP"}],endings:[]}
    });
    const state = { watchHistory:[{id:"h1",animeId:"legacy-shadow",delta:1}] };
    const result = V.reconcileExistingAnimeDuplicates([frierenSecond(), legacy], state);
    const merged = result.list[0];
    assert.equal(merged.currentEpisode, 7);
    assert.equal(merged.rating, 9);
    assert.equal(merged.review, "legacy review");
    assert.equal(merged.note, "legacy note");
    assert.equal(merged.customPlatform, "自訂平台");
    assert.equal(merged.customFutureField, "keep-me");
    assert.equal(merged.themeSongs.openings[0].id, "op-legacy");
    assert.equal(result.state.watchHistory[0].animeId, "frieren-known");
});

test("26. 相同 title/year/format 但不同已知 AniList ID 絕不合併", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        frierenSecond({id:"known-a",anilistId:182255}),
        frierenSecond({id:"known-b",anilistId:109261})
    ]);
    assert.equal(result.list.length, 2);
    assert.equal(result.mergedCount, 0);
    assert.equal(result.legacyBoundCount, 0);
});

test("27. legacy shadow reconciliation 第二次執行為 0 changes", () => {
    const first = V.reconcileExistingAnimeDuplicates([
        frierenSecond(),
        frierenSecond({id:"legacy-shadow",anilistId:undefined,sourceId:undefined,episodes:"??",totalEpisodes:"??"})
    ]);
    const second = V.reconcileExistingAnimeDuplicates(JSON.parse(JSON.stringify(first.list)), first.state);
    assert.equal(second.changed, false);
    assert.equal(second.mergedCount, 0);
    assert.equal(second.legacyBoundCount, 0);
    assert.deepEqual(second.list, first.list);
});

test("28. serialize / deserialize 後不會重新產生 shadow duplicate", () => {
    const first = V.reconcileExistingAnimeDuplicates([
        frierenSecond(),
        frierenSecond({id:"legacy-shadow",anilistId:undefined,sourceId:undefined})
    ]);
    const reloaded = V.reconcileExistingAnimeDuplicates(JSON.parse(JSON.stringify(first.list)), first.state);
    assert.equal(reloaded.list.length, 1);
    assert.equal(reloaded.list.filter(item => V.getAnimeAniListIdentity(item) === "182255").length, 1);
});

test("29. legacy fallback 缺少相同 group context 時不得合併", () => {
    const legacy = frierenSecond({id:"legacy-shadow",anilistId:undefined,sourceId:undefined,groupTitle:"其他系列"});
    const result = V.reconcileExistingAnimeDuplicates([frierenSecond(), legacy]);
    assert.equal(result.list.length, 2);
    assert.equal(result.legacyBoundCount, 0);
});

if (!process.exitCode) console.log(`\nAll duplicate reconciliation tests passed: ${passed}/${passed}`);
