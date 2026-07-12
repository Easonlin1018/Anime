"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");
const root = path.resolve(__dirname, "..");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode = 1; } }

test("1. v8.8 舊資料遷移至 v11", () => { const item = V.migrateAnime({ title:"作品", watched:3, episodes:12, category:"watching", note:"筆記" }); assert.equal(item.currentEpisode,3); assert.equal(item.totalEpisodes,12); assert.equal(item.notes,"筆記"); assert.equal(item.category,"watching"); });
test("2. 缺少 id、addedAt、updatedAt 時穩定補齊", () => { const item=V.migrateAnime({title:"A"},"2026-01-01T00:00:00.000Z"); assert.ok(item.id); assert.equal(item.addedAt,"2026-01-01T00:00:00.000Z"); assert.equal(item.updatedAt,"2026-01-01T00:00:00.000Z"); const again=V.migrateAnime(item); assert.equal(again.id,item.id); });
test("3. 合法備份可驗證與匯入", () => { const backup=V.createBackup({animeList:[{id:"a",title:"A"}],eventOverrides:{x:{}},watchHistory:[{delta:1}]}); const result=V.validateBackup(backup); assert.equal(result.valid,true); assert.equal(result.preview.animeCount,1); assert.equal(V.importBackup({animeList:[]},backup,"replace").animeList.length,1); });
test("4. 損壞備份遭拒", () => { assert.equal(V.validateBackup({schemaVersion:11}).valid,false); assert.throws(()=>V.importBackup({animeList:[]},{},"merge")); });
test("5. 合併與覆蓋模式", () => { const base={animeList:[{id:"a",title:"old",updatedAt:"2026-01-01"}]}; const backup=V.createBackup({animeList:[{id:"b",title:"new"}]}); assert.equal(V.importBackup(base,backup,"merge").animeList.length,2); assert.equal(V.importBackup(base,backup,"replace").animeList.length,1); });
test("6. 搜尋、排序與多條件篩選", () => { const list=[{id:"1",title:"Beta",category:"watching",platform:"Netflix",tags:["奇幻"],year:2026,currentEpisode:4,totalEpisodes:12},{id:"2",title:"Alpha",category:"backlog",platform:"動畫瘋",tags:["校園"],year:2025}]; const out=V.searchFilterSort(list,"bet",{status:["watching"],platform:["net"],tags:["奇幻"],year:2026},"name"); assert.deepEqual(out.map(x=>x.id),["1"]); });
test("7. 批次操作與復原資料可保留", () => { const before=[{id:"1",title:"A",tags:[]}]; const after=V.applyBatch(before,["1"],"add-tag","新標籤"); assert.deepEqual(after[0].tags,["新標籤"]); assert.deepEqual(V.migrateList(before)[0].tags,[]); });
test("8. 觀看歷史與統計", () => { const now=new Date("2026-07-12T12:00:00Z"); const anime=V.migrateAnime({id:"1",title:"A",platform:"P",tags:["T"],category:"watching",rating:8}); const history=[V.createWatchRecord({...anime,currentEpisode:2},2,now.toISOString()),V.createWatchRecord(anime,-1,now.toISOString())]; const stats=V.watchStats(history,[anime],now); assert.equal(stats.today,2); assert.equal(stats.total,2); assert.equal(stats.watching,1); });
test("9. 行事曆日期整理", () => { const items=V.calendarItems([{id:"1",title:"A",nextEpisodeAt:"2026-07-12T10:00:00Z",releaseDate:"2026-08-01"}],[{id:"e",title:"活動",eventStartDate:"2026-07-13",eventEndDate:"2026-07-15"}]); assert.deepEqual(items.map(x=>x.type),["episode","event-start","event-end","movie"]); });
test("10. 活動重複偵測保留來源", () => { const merged=V.mergeDuplicateEvents([{title:"2026 動漫展",eventStartDate:"2026-07-12",venue:"世貿一館",url:"https://a.example/x"},{title:"動漫展",eventStartDate:"2026-07-13",venue:"世貿一館",url:"https://b.example/x"}]); assert.equal(merged.length,1); assert.equal(merged[0].duplicateSources.length,2); });

const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("const BROAD_EVENT_LOCATIONS");
const end=html.indexOf("function eventTransportHint",start);
const mapCode=html.slice(start,end);
const mapApi=Function(`${mapCode}; return {getEventMapDestination,eventMapUrl,eventDirectionsUrl}`)();
test("11. 活動地圖 7 個案例", () => { const cases=[[{title:"展",venue:"台北世貿一館",address:"台北市信義區信義路五段5號",locations:["台北"]},"台北市信義區信義路五段5號"],[{venue:"中友百貨"},"中友百貨"],[{address:"台中市北區三民路三段161號"},"台中市北區三民路三段161號"],[{locations:["台北"]},""],[{},""],[{address:"台北市中正區八德路一段1號"},"台北市中正區八德路一段1號"],[{title:"台北世貿一館 漫畫博覽會",locations:["台北"]},""]]; cases.forEach(([event,expected])=>{assert.equal(mapApi.getEventMapDestination(event),expected); if(expected)assert.ok(mapApi.eventMapUrl(event).includes(encodeURIComponent(expected)));else assert.equal(mapApi.eventDirectionsUrl(event),"");}); });
test("12. 本機／雲端資料依 updatedAt 合併", () => { const result=V.mergeCloudPayload({animeList:[{id:"a",title:"本機",updatedAt:"2026-01-01"}]},{animeList:[{id:"a",title:"雲端",updatedAt:"2026-02-01"}]}); assert.equal(result.animeList[0].title,"雲端"); });
test("13. tombstone 保留 30 天並可清理", () => { const recent=new Date(Date.now()-10*86400000).toISOString(),old=new Date(Date.now()-40*86400000).toISOString(); assert.equal(V.pruneTombstones([{id:"a",title:"A",deletedAt:recent},{id:"b",title:"B",deletedAt:old}]).length,1); });
test("14. 缺少 Supabase 設定時安全降級", () => { assert.match(fs.readFileSync(path.join(root,"sync-config.js"),"utf8"),/\|\| null/); assert.ok(V.mergeCloudPayload({animeList:[]},{animeList:[]}).animeList); });
test("15. Service Worker 不快取登入與同步 API", () => { const sw=fs.readFileSync(path.join(root,"sw.js"),"utf8"); assert.equal(V.shouldCacheRequest("https://x.supabase.co/auth/v1/token"),false); assert.equal(V.shouldCacheRequest("https://site.example/index.html"),true); assert.match(sw,/auth\\\/v1/); assert.match(sw,/events\.json/); });

console.log("\nLegacy backup import compatibility:");
test("匯入 1. 純陣列 2 筆", () => { const normalized=V.normalizeImportedBackup([{title:"一"},{title:"二"}]); assert.equal(normalized[V.STORAGE_KEY].length,2); assert.equal(normalized.backupFormat,"舊版純陣列"); assert.equal(V.importBackup({animeList:[]},normalized,"replace").animeList.length,2); });
test("匯入 2. 純陣列 111 筆", () => { const input=Array.from({length:111},(_,i)=>({id:i+1,title:`作品 ${i+1}`})); const validation=V.validateBackup(input); assert.equal(validation.valid,true); assert.equal(validation.preview.animeCount,111); assert.equal(V.importBackup({animeList:[]},input,"replace").importedAnimeCount,111); });
test("匯入 3. 包裝格式 anime_list_v8_8", () => { const normalized=V.normalizeImportedBackup({schemaVersion:8,[V.STORAGE_KEY]:[{title:"A"}]}); assert.equal(normalized.schemaVersion,8); assert.equal(normalized[V.STORAGE_KEY].length,1); assert.equal(normalized.backupFormat,"完整備份"); });
test("匯入 4. localStorage JSON 字串陣列", () => { const normalized=V.normalizeImportedBackup({[V.STORAGE_KEY]:JSON.stringify([{title:"A"}])}); assert.equal(normalized[V.STORAGE_KEY][0].title,"A"); });
test("匯入 5. 空陣列可辨識並要求確認旗標", () => { const validation=V.validateBackup([]); assert.equal(validation.valid,true); assert.equal(validation.preview.animeCount,0); assert.equal(validation.preview.requiresEmptyConfirmation,true); });
test("匯入 6. 無效 JSON 被拒絕", () => { const validation=V.validateBackup("not-json"); assert.equal(validation.valid,false); assert.match(validation.error,/有效的 JSON/); });
test("匯入 7. 根物件缺少主資料 key 被拒絕", () => { const validation=V.validateBackup({aliases:[],relations:[]}); assert.equal(validation.valid,false); assert.match(validation.error,/缺少 anime_list_v8_8/); });
test("匯入 8. 主資料不是陣列或合法陣列字串時拒絕", () => { assert.equal(V.validateBackup({[V.STORAGE_KEY]:{title:"A"}}).valid,false); assert.equal(V.validateBackup({[V.STORAGE_KEY]:"{bad"}).valid,false); assert.equal(V.validateBackup({[V.STORAGE_KEY]:JSON.stringify({title:"A"})}).valid,false); });
test("匯入 9. aliases／relations 不會被誤認為動漫清單", () => { const result=V.validateBackup({aliases:[{title:"錯誤"}],relations:[{title:"錯誤"}]}); assert.equal(result.valid,false); });
test("匯入 10. 匯入失敗不改變原資料", () => { const current={animeList:[{id:"keep",title:"保留",unknown:"x"}]}; const before=JSON.stringify(current); assert.throws(()=>V.importBackup(current,{aliases:[]},"replace")); assert.equal(JSON.stringify(current),before); });
test("匯入 11. 合併模式保留原資料", () => { const current={animeList:[{id:"old",title:"原資料",updatedAt:"2026-01-01"}]}; const result=V.importBackup(current,[{id:"new",title:"新資料"}],"merge"); assert.deepEqual(new Set(result.animeList.map(x=>x.id)),new Set(["old","new"])); });
test("匯入 12. 完全覆蓋前可建立完整還原點", () => { const current={animeList:[{id:"old",title:"原資料"}],eventOverrides:{a:{venue:"場館"}},watchHistory:[{delta:1}]}; const restore=V.createBackup(current); const replaced=V.importBackup(current,[{id:"new",title:"新資料"}],"replace"); assert.equal(restore[V.STORAGE_KEY][0].id,"old"); assert.equal(replaced.animeList[0].id,"new"); });
test("匯入 13. 未知欄位保留", () => { const result=V.importBackup({animeList:[]},[{id:"a",title:"A",futureField:{enabled:true}}],"replace"); assert.deepEqual(result.animeList[0].futureField,{enabled:true}); });
test("匯入 14. 舊觀看欄位不遺失", () => { const legacy={id:9,title:"舊作",watched:7,episodes:24,category:"backlog",rating:9,note:"好看",customPlatform:"動畫瘋",aliases:["別名"],relations:[{id:1}],streamingLinks:[{site:"動畫瘋",url:"https://example.com"}]}; const item=V.importBackup({animeList:[]},[legacy],"replace").animeList[0]; for(const key of ["watched","episodes","category","rating","note","customPlatform","relations","streamingLinks"])assert.deepEqual(item[key],legacy[key]); assert.ok(item.aliases.includes("別名")); });
test("匯入 15. 重複遷移不更換既有 ID", () => { const first=V.migrateAnime({title:"A"}); const second=V.migrateAnime(first); const third=V.migrateAnime(second); assert.equal(second.id,first.id); assert.equal(third.id,first.id); });

if (!process.exitCode) console.log(`\nAll tests passed: ${passed}/${passed}`);
