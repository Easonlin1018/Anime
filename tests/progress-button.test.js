"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode = 1; } }
const at = "2026-07-12T12:34:56.000Z";
const fakeStorage = () => { const data=new Map(); return { setItem:(key,value)=>data.set(key,String(value)), getItem:key=>data.get(key)??null, data }; };

test("1. watched 0 點一次變 1", () => { const result=V.updateAnimeProgress([{id:1,title:"A",watched:0,episodes:12}],1,1,at); assert.equal(result.anime.watched,1); assert.equal(result.anime.currentEpisode,1); });
test("2. currentEpisode 0 點一次變 1", () => { const result=V.updateAnimeProgress([{id:"a",title:"A",currentEpisode:0,totalEpisodes:12}],"a",1,at); assert.equal(result.anime.currentEpisode,1); assert.equal(result.anime.watched,1); });
test("3. 舊資料只有 watched 可升級", () => { const item=V.migrateAnime({id:"a",title:"A",watched:4,episodes:12}); assert.equal(item.currentEpisode,4); assert.equal(item.watched,4); });
test("4. 新資料只有 currentEpisode 可增加", () => { const result=V.updateAnimeProgress([{id:"a",title:"A",currentEpisode:5,totalEpisodes:12}],"a",1,at); assert.equal(result.anime.currentEpisode,6); assert.equal(result.anime.watched,6); });
test("5. 數字 ID 可找到", () => { const result=V.updateAnimeProgress([{id:123,title:"A",watched:0}],123,1,at); assert.equal(result.found,true); assert.equal(result.anime.id,123); });
test("6. 字串 UUID 可找到", () => { const id="550e8400-e29b-41d4-a716-446655440000"; const result=V.updateAnimeProgress([{id,title:"A",watched:0}],id,1,at); assert.equal(result.found,true); assert.equal(result.anime.id,id); });
test("7. 未知總集數仍可增加", () => { const result=V.updateAnimeProgress([{id:"a",title:"A",watched:7,episodes:"??"}],"a",1,at); assert.equal(result.anime.watched,8); assert.equal(result.total,null); });
test("8. 已達總集數不可超過", () => { const result=V.updateAnimeProgress([{id:"a",title:"A",watched:12,episodes:12}],"a",1,at); assert.equal(result.changed,false); assert.equal(result.reason,"at-total"); assert.equal(result.anime.watched,12); });
test("9. localStorage 保存主資料且時間更新", () => { const storage=fakeStorage(); const result=V.commitAnimeProgress(storage,[{id:"a",title:"A",watched:0,episodes:12}],[],"a",1,at); const stored=JSON.parse(storage.getItem(V.STORAGE_KEY)); assert.equal(stored[0].watched,1); assert.equal(stored[0].currentEpisode,1); assert.equal(stored[0].lastWatchedAt,at); assert.equal(stored[0].updatedAt,at); assert.equal(result.changed,true); });
test("10. 觀看歷史正確新增", () => { const storage=fakeStorage(); const result=V.commitAnimeProgress(storage,[{id:"a",title:"A",watched:0}],[],"a",1,at); const history=JSON.parse(storage.getItem(V.HISTORY_KEY)); assert.equal(history.length,1); assert.equal(history[0].animeId,"a"); assert.equal(history[0].delta,1); assert.equal(history[0].episode,1); assert.deepEqual(result.history,history); });
test("11. 重新 render／序列化後仍可再次操作", () => { const first=V.updateAnimeProgress([{id:"uuid-a",title:"A",watched:0}],"uuid-a",1,at); const rendered=JSON.parse(JSON.stringify(first.list)); const second=V.updateAnimeProgress(rendered,"uuid-a",1,"2026-07-12T12:35:56.000Z"); assert.equal(second.anime.watched,2); const html=fs.readFileSync(path.resolve(__dirname,"..","index.html"),"utf8"),ui=fs.readFileSync(path.resolve(__dirname,"..","v11-ui.js"),"utf8"); assert.match(html,/data-progress-action="increment"/); assert.match(ui,/closest\("\[data-progress-action\]"\)/); });
test("12. 其他卡片按鈕維持原功能", () => { const html=fs.readFileSync(path.resolve(__dirname,"..","index.html"),"utf8"); assert.match(html,/moveCategory\(\$\{animeId\}/); assert.match(html,/editAnimeReview\(\$\{animeId\}/); assert.match(html,/searchEventsByWork/); assert.match(html,/editTitle\(\$\{animeId\}/); assert.match(html,/deleteAnime\(\$\{animeId\}/); assert.doesNotMatch(html,/onclick=['"]updateProgress/); });

if (!process.exitCode) console.log(`\nProgress button tests passed: ${passed}/12`);
