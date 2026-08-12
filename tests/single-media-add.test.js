"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const titleStart = html.indexOf("function stripDisplayYear");
const titleEnd = html.indexOf("async function searchWikipedia", titleStart);
const mediaStart = html.indexOf("function normalizeStreamingLinks");
const mediaEnd = html.indexOf("async function manualScanSequels", mediaStart);
assert.ok(titleStart >= 0 && titleEnd > titleStart && mediaStart >= 0 && mediaEnd > mediaStart);
const api = Function(`${html.slice(titleStart, titleEnd)}\n${html.slice(mediaStart, mediaEnd)}; return { getAniListMediaId, getExistingAnimeMediaState, addOrRestoreSingleMedia, reconcileDiscoveredSequelMedia, isMediaClearlyNotYetReleased, resolveAutomaticMediaCategory, restoredAnimeCategory };`)();

let passed = 0;
const pending = [];
function test(name, fn) {
    try {
        const result = fn();
        if (result?.then) {
            pending.push(result.then(() => { passed++; console.log(`✓ ${name}`); }).catch(error => { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.stack}`); }));
        } else {
            passed++;
            console.log(`✓ ${name}`);
        }
    } catch (error) {
        process.exitCode = 1;
        console.error(`✗ ${name}\n  ${error.stack}`);
    }
}

const media = (id, title, year = 2025, format = "TV") => ({ id, title:{native:title,romaji:title,english:null}, startDate:{year,month:1,day:1}, format, status:"FINISHED", episodes:12, relations:{edges:[]} });
const anime = (id, title, category = "backlog", extra = {}) => ({ id, anilistId:id, title, aliases:[title], year:extra.year || 2025, startDate:{year:extra.year || 2025,month:1,day:1}, format:extra.format || "TV", category, watched:extra.watched || 0, currentEpisode:extra.watched || 0, createdAt:"2025-01-01T00:00:00.000Z", addedAt:"2025-01-01T00:00:00.000Z", updatedAt:"2025-01-01T00:00:00.000Z", ...extra });
const create = item => anime(Number(item.id), item.title.native, item.status === "NOT_YET_RELEASED" ? "waiting" : "backlog", {year:item.startDate.year,format:item.format});
const refresh = (record, item, now) => { record.status=item.status; record.format=item.format; record.episodes=item.episodes; record.startDate={...item.startDate}; record.year=item.startDate.year; record.updatedAt=now; return record; };
const add = (item, list, options = {}) => api.addOrRestoreSingleMedia(item, list, {createAnime:create,applyMetadata:refresh,now:"2026-08-11T00:00:00.000Z",...options});
const active = list => list.filter(item => !item.deletedAt);

test("1. A/B/C 三季只刪 B 後 active 為 A + C", () => {
    const list=[anime(1,"A"),anime(2,"B","watching"),anime(3,"C")];
    const deleted=V.markAnimeDeletedById(list,2,"2026-08-10T00:00:00.000Z","2").list;
    assert.deepEqual(active(deleted).map(item=>item.anilistId),[1,3]);
});

test("2. 刪除 B 後搜尋 identity 仍回傳可新增 tombstone", () => {
    const list=V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list;
    assert.equal(api.getExistingAnimeMediaState(media(2,"B"),list).state,"tombstone");
});

test("3. 搜尋候選 UI 不顯示恢復、已刪除或 tombstone", () => {
    const stateStart=html.indexOf("function getSingleAnimeSearchCardView");
    const start=html.indexOf("function renderSingleAnimeSearchCandidate");
    const end=html.indexOf("function addPendingAnimeSearchResult",start);
    const source=html.slice(start,end);
    assert.match(html.slice(stateStart,start),/state\.reason === "legacy-title-year-format" \? "更新資料" : "已加入"/u);
    assert.doesNotMatch(source,/恢復|已刪除|tombstone/u);
});

test("4. 新增 B 復用 tombstone 且不建立第二 object", () => {
    const original=V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list[0];
    const list=[original],result=add(media(2,"B"),list);
    assert.equal(result.action,"restored");
    assert.equal(list.length,1);
    assert.equal(result.anime.id,original.id);
});

test("5. 恢復 B 後 active count 2 → 3", () => {
    const list=[anime(1,"A"),...V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list,anime(3,"C")];
    assert.equal(active(list).length,2);add(media(2,"B"),list);assert.equal(active(list).length,3);
});

test("6. 恢復後 A/B/C 各只有一筆", () => {
    const list=[anime(1,"A"),...V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list,anime(3,"C")];add(media(2,"B"),list);
    assert.deepEqual([...new Map(list.map(item=>[item.anilistId,(list.filter(x=>x.anilistId===item.anilistId).length)])).values()],[1,1,1]);
});

test("7. 普通新增函式完全不呼叫 sequel traversal", () => {
    const start=html.indexOf("function addPendingAnimeSearchResult");const end=html.indexOf("async function searchAnime",start);const source=html.slice(start,end);
    assert.doesNotMatch(source,/checkAndAddSequel|walkAniListSequelGraph/u);
});

test("8. 新增 B 不增加 A 或 C", () => {
    const list=[anime(1,"A"),...V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list,anime(3,"C")];add(media(2,"B"),list);
    assert.equal(list.filter(x=>x.anilistId===1).length,1);assert.equal(list.filter(x=>x.anilistId===3).length,1);
});

test("9. 連續新增 B 兩次仍只有三筆 active", () => {
    const list=[anime(1,"A"),...V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list,anime(3,"C")];
    assert.equal(add(media(2,"B"),list).changed,true);assert.equal(add(media(2,"B"),list).changed,false);assert.equal(active(list).length,3);
});

test("10. ACTIVE B + tombstone B reconciliation 後新增 no-op", () => {
    const deleted=V.markAnimeDeletedById([anime("old", "B", "backlog", {anilistId:2})],"old","2026-08-10T00:00:00.000Z","2").list[0];
    const reconciled=V.reconcileExistingAnimeDuplicates([anime("active","B","backlog",{anilistId:2}),deleted]).list;
    const result=add(media(2,"B"),reconciled);assert.equal(result.action,"active");assert.equal(reconciled.length,1);
});

test("11. 兩個 tombstone B reconciliation 後只剩 canonical identity", () => {
    const first=V.markAnimeDeletedById([anime("one","B","backlog",{anilistId:2})],"one","2026-08-10T00:00:00.000Z","2").list[0];
    const second=V.markAnimeDeletedById([anime("two","B","backlog",{anilistId:2})],"two","2026-08-10T00:00:00.000Z","2").list[0];
    assert.equal(V.reconcileExistingAnimeDuplicates([first,second]).list.length,1);
});

test("12. 相同 title、不同 AniList ID 只恢復指定 ID", () => {
    const b=V.markAnimeDeletedById([anime(2,"同名")],2,"2026-08-10T00:00:00.000Z","2").list[0];
    const c=V.markAnimeDeletedById([anime(3,"同名")],3,"2026-08-10T00:00:00.000Z","3").list[0];const list=[b,c];add(media(2,"同名"),list);
    assert.equal(list.find(x=>x.anilistId===2).deletedAt,null);assert.ok(list.find(x=>x.anilistId===3).deletedAt);
});

test("13. watching 刪除後普通新增仍恢復 watching", () => {
    const list=V.markAnimeDeletedById([anime(2,"B","watching")],2,"2026-08-10T00:00:00.000Z","2").list;assert.equal(add(media(2,"B"),list).anime.category,"watching");
});

test("14. completed 使用者資料 delete → add 全部保留", () => {
    const original=anime(2,"B","completed",{watched:12,rating:9,note:"note",notes:"notes",review:"review",memo:"memo",themeSongs:{openings:[{id:"op",title:"OP"}],endings:[]},customPlatform:"平台",unknown:"keep"});
    const list=V.markAnimeDeletedById([original],2,"2026-08-10T00:00:00.000Z","2").list;const restored=add(media(2,"B"),list).anime;
    assert.equal(restored.category,"completed");assert.equal(restored.watched,12);assert.equal(restored.rating,9);assert.equal(restored.note,"note");assert.equal(restored.themeSongs.openings[0].id,"op");assert.equal(restored.customPlatform,"平台");assert.equal(restored.unknown,"keep");
});

test("15. manual title delete → add 不被 metadata refresh 覆蓋", () => {
    const original=anime(2,"人工英文名稱","completed",{titleManuallyEdited:true,titleSource:"manual"});const list=V.markAnimeDeletedById([original],2,"2026-08-10T00:00:00.000Z","2").list;
    const result=add(media(2,"官方名稱"),list,{applyMetadata:(record,item,now)=>{refresh(record,item,now);if(!record.titleManuallyEdited)record.title=item.title.native;}});assert.equal(result.anime.title,"人工英文名稱");
});

test("16. UUID local id delete → add 後完全不變", () => {
    const original=anime("uuid-local","B","backlog",{anilistId:2});const list=V.markAnimeDeletedById([original],"uuid-local","2026-08-10T00:00:00.000Z","2").list;assert.equal(add(media(2,"B"),list).anime.id,"uuid-local");
});

test("17. legacy tombstone title + year + format 符合時補綁 AniList ID", () => {
    const legacy={...anime("uuid-legacy","Legacy", "backlog",{year:2024,format:"MOVIE"}),anilistId:undefined};const list=V.markAnimeDeletedById([legacy],"uuid-legacy","2026-08-10T00:00:00.000Z").list;
    const result=add(media(88,"Legacy",2024,"MOVIE"),list);assert.equal(result.action,"restored");assert.equal(result.anime.anilistId,88);assert.equal(result.anime.id,"uuid-legacy");
});

test("18. legacy 同名但年份不同不得錯誤 restore", () => {
    const legacy={...anime("uuid-legacy","Legacy","backlog",{year:2023,format:"MOVIE"}),anilistId:undefined};const list=V.markAnimeDeletedById([legacy],"uuid-legacy","2026-08-10T00:00:00.000Z").list;
    const result=add(media(88,"Legacy",2024,"MOVIE"),list);assert.equal(result.action,"created");assert.equal(list.length,2);assert.ok(list[0].deletedAt);
});

test("19. local ID collision migration 後只恢復指定 Media", () => {
    const collision=[V.markAnimeDeletedById([anime("same","B","backlog",{anilistId:2})],"same","2026-08-10T00:00:00.000Z","2").list[0],anime("same","C","backlog",{anilistId:3})];
    const migrated=V.reconcileExistingAnimeDuplicates(collision).list;const result=add(media(2,"B"),migrated);assert.equal(result.anime.anilistId,2);assert.equal(new Set(migrated.map(x=>x.id)).size,2);assert.equal(migrated.find(x=>x.anilistId===3).title,"C");
});

test("20. reload 後 A/B/C 各一筆", () => {
    const list=[anime(1,"A"),anime(2,"B"),anime(3,"C")];const reloaded=V.reconcileExistingAnimeDuplicates(JSON.parse(JSON.stringify(list))).list;assert.deepEqual(reloaded.map(x=>x.anilistId),[1,2,3]);
});

test("21. serialize / deserialize round-trip 無 duplicate", () => {
    const payload=V.createBackup({animeList:[anime(1,"A"),anime(2,"B"),anime(3,"C")],works:[]});const imported=V.importBackup({animeList:[],works:[]},JSON.parse(JSON.stringify(payload)),"replace");assert.equal(new Set(imported.animeList.map(x=>x.anilistId)).size,3);
});

test("22. Supabase merge round-trip 同 AniList ID 最終一筆", () => {
    const activeB=anime("uuid-b","B","watching",{anilistId:2,updatedAt:"2026-08-11T00:00:00.000Z"});const oldDeleted=V.markAnimeDeletedById([anime("old-b","B","backlog",{anilistId:2})],"old-b","2026-08-10T00:00:00.000Z","2").list[0];
    const merged=V.mergeCloudPayload({animeList:[activeB],works:[]},{animeList:[oldDeleted],works:[]});assert.equal(merged.animeList.filter(x=>x.anilistId===2).length,1);assert.equal(merged.animeList[0].deletedAt,null);
});

test("23. 自動找續作遇 tombstone B 時不自動復活", async () => {
    const list=V.markAnimeDeletedById([anime(2,"B")],2,"2026-08-10T00:00:00.000Z","2").list;let added=0,refreshed=0;
    const result=await api.reconcileDiscoveredSequelMedia([{media:media(2,"B")}],list,{addMedia(){added++;return true;},refreshMedia(){refreshed++;}});
    assert.deepEqual(result,{added:0,refreshed:0});assert.equal(added,0);assert.equal(refreshed,0);assert.ok(list[0].deletedAt);
});

test("24. tombstone purge 後可建立新 record 且 auxiliary 無 orphan", () => {
    const old=V.markAnimeDeletedById([anime("old-local","B","backlog",{anilistId:2})],"old-local","2026-01-01T00:00:00.000Z","2").list[0];
    const purged=V.purgeExpiredTombstones([old],{watchHistory:[{id:"h",animeId:"old-local"}],eventAnimeOverrides:{e:{includeAnimeIds:["old-local"]}},themeCache:{"source:old-local":{x:1}}},Date.parse("2026-08-11T00:00:00.000Z"));
    assert.equal(purged.list.length,0);assert.equal(purged.state.watchHistory.length,0);assert.deepEqual(purged.state.eventAnimeOverrides.e.includeAnimeIds,[]);assert.equal(purged.state.themeCache["source:old-local"],undefined);
    const result=add(media(2,"B"),purged.list);assert.equal(result.action,"created");assert.equal(purged.list.length,1);
});

test("25. NOT_YET_RELEASED 且未來開播自動分類為 waiting", () => {
    const future = media(209939, "葬送のフリーレン 第3期", 2027, "TV");
    future.status = "NOT_YET_RELEASED";
    future.startDate = { year:2027, month:10, day:null };
    assert.equal(api.isMediaClearlyNotYetReleased(future, "2026-08-11T00:00:00.000Z"), true);
    assert.equal(api.resolveAutomaticMediaCategory(future, "2026-08-11T00:00:00.000Z"), "waiting");
});

test("26. tombstone 舊 backlog 在明確未開播 metadata 下恢復為 waiting", () => {
    const future = media(209939, "葬送のフリーレン 第3期", 2027, "TV");
    future.status = "NOT_YET_RELEASED";
    future.startDate = { year:2027, month:10, day:null };
    const tombstone = V.markAnimeDeletedById([anime(209939, "葬送的芙莉蓮 第三季", "backlog", { categorySource:"automatic" })], 209939, "2026-08-10T00:00:00.000Z", "209939").list;
    const result = add(future, tombstone);
    assert.equal(result.action, "restored");
    assert.equal(result.anime.category, "waiting");
    assert.equal(result.anime.categorySource, "automatic");
});

test("27. 已開播作品不會錯誤分類到 waiting", () => {
    const released = media(154587, "葬送のフリーレン", 2023, "TV");
    released.status = "FINISHED";
    released.startDate = { year:2023, month:9, day:29 };
    assert.equal(api.resolveAutomaticMediaCategory(released, "2026-08-11T00:00:00.000Z"), "backlog");
});

test("28. 使用者人工分類標記可保留舊分類", () => {
    const future = media(209939, "葬送のフリーレン 第3期", 2027, "TV");
    future.status = "NOT_YET_RELEASED";
    const manual = anime(209939, "葬送的芙莉蓮 第三季", "backlog", { categorySource:"manual", categoryManuallyEdited:true, deletedFromCategory:"backlog" });
    assert.equal(api.restoredAnimeCategory(manual, future, "2026-08-11T00:00:00.000Z"), "backlog");
});

test("29. 普通單筆新增流程仍不觸發 sequel traversal", () => {
    const start = html.indexOf("function addPendingAnimeSearchResult");
    const end = html.indexOf("async function searchAnime", start);
    assert.doesNotMatch(html.slice(start, end), /checkAndAddSequel|walkAniListSequelGraph/u);
});

test("30. ONA 與 Part 2 的不同 AniList Media 維持兩筆獨立 identity", () => {
    const first = media(170068, "葬送のフリーレン ～●●の魔法～", 2023, "ONA");
    const second = media(189513, "葬送のフリーレン ～●●の魔法～ 2クール", 2025, "ONA");
    const list = [];
    assert.equal(add(first, list).action, "created");
    assert.equal(add(second, list).action, "created");
    assert.deepEqual(list.map(item => item.anilistId), [170068, 189513]);
});

test("31. tombstone 恢復為 waiting 後保留原 local ID 與使用者資料", () => {
    const future = media(209939, "葬送のフリーレン 第3期", 2027, "TV");
    future.status = "NOT_YET_RELEASED";
    const original = anime("uuid-frieren-3", "葬送的芙莉蓮 第三季", "backlog", { anilistId:209939, rating:8, note:"保留", categorySource:"automatic" });
    const list = V.markAnimeDeletedById([original], original.id, "2026-08-10T00:00:00.000Z", "209939").list;
    const restored = add(future, list).anime;
    assert.equal(restored.id, "uuid-frieren-3");
    assert.equal(restored.category, "waiting");
    assert.equal(restored.rating, 8);
    assert.equal(restored.note, "保留");
});

test("32. 一般新增第三季只新增所選 AniList Media", () => {
    const future = media(209939, "葬送のフリーレン 第3期", 2027, "TV");
    future.status = "NOT_YET_RELEASED";
    const list = [];
    const result = add(future, list);
    assert.equal(result.action, "created");
    assert.deepEqual(list.map(item => item.anilistId), [209939]);
});

test("33. 使用者移動或批次修改分類會留下 manual category 標記", () => {
    const original = anime(154587, "葬送的芙莉蓮", "backlog");
    const moved = V.moveAnimeCategoryById([original], original.id, "watching").anime;
    assert.equal(moved.categorySource, "manual");
    assert.equal(moved.categoryManuallyEdited, true);
    const batched = V.applyBatch([original], [original.id], "status", "completed")[0];
    assert.equal(batched.categorySource, "manual");
    assert.equal(batched.categoryManuallyEdited, true);
});

test("34. metadata refresh 對高可信 legacy record 補綁 ID 而不新增 shadow duplicate", () => {
    const legacy = {
        ...anime("legacy-local", "葬送的芙莉蓮 第二季（2026）", "backlog", {year:2026,format:"TV"}),
        anilistId:undefined,
        sourceId:undefined,
        displayTitle:"葬送的芙莉蓮 第二季（2026）",
        canonicalTitle:"葬送的芙莉蓮 第二季",
        groupTitle:"葬送的芙莉蓮",
        aliases:["葬送的芙莉蓮 第二季", "葬送のフリーレン 第2期"]
    };
    const item = media(182255, "葬送のフリーレン 第2期", 2026, "TV");
    item.title.english = "Frieren: Beyond Journey’s End Season 2";
    item.title.romaji = "Sousou no Frieren 2nd Season";
    item.synonyms = ["葬送的芙莉蓮 第二季"];
    item.episodes = 10;
    const list = [legacy];
    const result = add(item, list);
    assert.equal(result.action, "reconciled");
    assert.equal(result.changed, true);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "legacy-local");
    assert.equal(list[0].anilistId, 182255);
    assert.equal(list[0].episodes, 10);
});

Promise.all(pending).then(() => {
    if (!process.exitCode) console.log(`\nSingle media add/restore tests passed: ${passed}/${passed}`);
});
