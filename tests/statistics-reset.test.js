"use strict";
const assert = require("node:assert/strict");
const V = require("../v11-core.js");
let passed=0;
function test(name,fn){try{fn();passed++;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}\n  ${error.stack}`);process.exitCode=1}}
function storage(initial={}){const data=new Map(Object.entries(initial));return{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key),data}}
const anime=[
  {id:"a",title:"完成作",category:"completed",watched:12,currentEpisode:12,totalEpisodes:12,rating:8,platform:"非常非常非常非常非常非常非常非常長的平台名稱",tags:["奇幻"]},
  {id:"b",title:"追番",category:"watching",watched:4,currentEpisode:4,totalEpisodes:12,rating:10,platform:"動畫瘋",tags:["校園"]}
];
const history=Array.from({length:72},(_,index)=>({id:`h${index}`,animeId:"b",title:"追番",delta:1,episode:index+1,at:"2026-07-12T10:00:00.000Z"}));

test("1. 觀看歷史 72 筆可歸零",()=>{const store=storage({[V.HISTORY_KEY]:JSON.stringify(history)});const result=V.resetWatchStatistics(store,"2026-07-12T12:00:00Z");assert.equal(result.clearedCount,72);assert.deepEqual(result.history,[])});
test("2. 重設後 history key 為空陣列",()=>{const store=storage({[V.HISTORY_KEY]:JSON.stringify(history)});V.resetWatchStatistics(store);assert.deepEqual(JSON.parse(store.getItem(V.HISTORY_KEY)),[])});
test("3. anime_list_v8_8 完全不變",()=>{const animeJson=JSON.stringify(anime),store=storage({[V.HISTORY_KEY]:JSON.stringify(history),[V.STORAGE_KEY]:animeJson});V.resetWatchStatistics(store);assert.equal(store.getItem(V.STORAGE_KEY),animeJson)});
test("4. watched／currentEpisode 不變",()=>{const animeJson=JSON.stringify(anime),store=storage({[V.HISTORY_KEY]:JSON.stringify(history),[V.STORAGE_KEY]:animeJson});V.resetWatchStatistics(store);const saved=JSON.parse(store.getItem(V.STORAGE_KEY));assert.deepEqual(saved.map(x=>[x.watched,x.currentEpisode]),[[12,12],[4,4]])});
test("5. 完成作品數量不變",()=>{const before=V.watchStats(history,anime,new Date("2026-07-12T12:00:00Z")),after=V.watchStats([],anime,new Date("2026-07-12T12:00:00Z"));assert.equal(before.completed,after.completed);assert.equal(after.completed,1)});
test("6. 正在觀看數量不變",()=>{assert.equal(V.watchStats([],anime).watching,1)});
test("7. 平均評分不變",()=>{assert.equal(V.watchStats(history,anime).averageRating,V.watchStats([],anime).averageRating);assert.equal(V.watchStats([],anime).averageRating,"9.0")});
test("8. 復原上一次重設恢復 72 筆",()=>{const store=storage({[V.HISTORY_KEY]:JSON.stringify(history)});V.resetWatchStatistics(store);const result=V.restoreWatchStatistics(store);assert.equal(result.restored,true);assert.equal(result.restoredCount,72);assert.equal(JSON.parse(store.getItem(V.HISTORY_KEY)).length,72)});
test("9. 重設兩次只保留最近一次還原點",()=>{const store=storage({[V.HISTORY_KEY]:JSON.stringify(history)});V.resetWatchStatistics(store);const recent=[history[0]];store.setItem(V.HISTORY_KEY,JSON.stringify(recent));V.resetWatchStatistics(store);const point=JSON.parse(store.getItem(V.WATCH_RESET_UNDO_KEY));assert.equal(point.history.length,1);const restored=V.restoreWatchStatistics(store);assert.equal(restored.restoredCount,1)});
test("10. 歸零項目全為 0，清單衍生統計保留",()=>{const stats=V.watchStats([],anime,new Date("2026-07-12T12:00:00Z"));assert.deepEqual([stats.today,stats.week,stats.month,stats.total,stats.streak],[0,0,0,0,0]);assert.deepEqual([stats.completed,stats.watching,stats.averageRating],[1,1,"9.0"])});

if(!process.exitCode)console.log(`\nStatistics reset tests passed: ${passed}/10`);
