"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");
const root = path.resolve(__dirname, "..");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode = 1; } }
const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC";

test("1. 舊資料補上空 themeSongs", () => { const item=V.migrateAnime({id:"a",title:"A"}); assert.deepEqual(item.themeSongs,{openings:[],endings:[]}); });
test("2. 多次遷移不重複歌曲且 ID 穩定", () => { const input={id:"a",title:"A",themeSongs:{openings:[{type:"OP",sequence:1,title:"Song",artist:"Artist"}],endings:[]}}; const first=V.migrateAnime(input),second=V.migrateAnime(first),third=V.migrateAnime(second); assert.equal(third.themeSongs.openings.length,1); assert.equal(first.themeSongs.openings[0].id,third.themeSongs.openings[0].id); });
test("3. OP 文字解析", () => { const song=V.parseThemeSongText('"Brave Shine" by Aimer',"OP",1); assert.equal(song.type,"OP"); assert.equal(song.title,"Brave Shine"); assert.equal(song.artist,"Aimer"); });
test("4. ED 文字解析", () => { const song=V.parseThemeSongText('「Stay Alive」 by Emilia',"ED",2); assert.equal(song.type,"ED"); assert.equal(song.sequence,2); assert.equal(song.title,"Stay Alive"); });
test("5. 集數範圍解析", () => { assert.equal(V.parseThemeSongText('"Song" by Artist (eps 1-12)',"OP",1).episodeRange,"1–12"); assert.equal(V.parseThemeSongText('"Song" by Artist (ep 3)',"OP",1).episodeRange,"3"); });
test("6. feat. 歌手完整保留", () => { const song=V.parseThemeSongText('"Song" by Artist feat. Guest',"OP",1); assert.equal(song.artist,"Artist feat. Guest"); });
test("7. Spotify URL 解析", () => { assert.equal(V.extractSpotifyTrackId(`https://open.spotify.com/track/${TRACK_ID}?si=test`),TRACK_ID); });
test("8. Spotify URI 解析", () => { assert.equal(V.extractSpotifyTrackId(`spotify:track:${TRACK_ID}`),TRACK_ID); });
test("9. 拒絕非 Spotify 或不合法網址", () => { assert.equal(V.extractSpotifyTrackId(`https://example.com/track/${TRACK_ID}`),""); assert.equal(V.extractSpotifyTrackId("javascript:alert(1)"),""); assert.equal(V.extractSpotifyTrackId("https://open.spotify.com/track/short"),""); });
test("10. 歌名正規化", () => { assert.equal(V.normalizeSongTitle('「Brave Shine」 (TV Size)'),V.normalizeSongTitle("brave shine")); });
test("11. 歌手正規化", () => { assert.equal(V.normalizeArtistName("Aimer feat. Guest"),V.normalizeArtistName("aimer")); });
test("12. 正確原曲分數高於 Cover", () => { const song={title:"Brave Shine",artist:"Aimer"}; const original=V.calculateSpotifyMatchScore(song,{name:"Brave Shine",artists:["Aimer"],album:"Single"}); const cover=V.calculateSpotifyMatchScore(song,{name:"Brave Shine Cover",artists:["Other"],album:"Anime Cover"}); assert.ok(original>cover); assert.ok(original>=75); });
test("13. 正確原曲分數高於 Karaoke", () => { const song={title:"Song",artist:"Artist"}; assert.ok(V.calculateSpotifyMatchScore(song,{name:"Song",artists:["Artist"],album:"Original"})>V.calculateSpotifyMatchScore(song,{name:"Song Karaoke",artists:["Artist"],album:"Karaoke"})); });
test("14. 低可信度不自動配對", () => { const result=V.selectSpotifyMatch({title:"Wanted",artist:"Singer"},[{id:TRACK_ID,name:"Different",artists:["Other"],spotifyUrl:`https://open.spotify.com/track/${TRACK_ID}`}]); assert.equal(result.matched,false); assert.equal(result.song.spotifyTrackId,undefined); });
test("15. 人工配對不被自動同步覆蓋", () => { const song={title:"Song",artist:"Artist",manuallyCorrected:true,spotifyTrackId:TRACK_ID}; const result=V.selectSpotifyMatch(song,[{id:"0".repeat(22),name:"Song",artists:["Artist"]}]); assert.equal(result.preservedManual,true); assert.equal(result.song.spotifyTrackId,TRACK_ID); });
test("16. 特別篇不自動繼承本傳歌曲", () => { const special=V.migrateAnime({id:"s",title:"Special",mediaType:"Special",relations:[{id:"main",themeSongs:{openings:[{title:"Main OP"}]}}]}); assert.equal(V.isSpecialMediaType(special),true); assert.equal(special.themeSongs.openings.length,0); });
test("17. 未設定 Worker 時安全降級", () => { const config=fs.readFileSync(path.join(root,"spotify-config.js"),"utf8"); assert.match(config,/workerUrl:\s*""/); assert.doesNotMatch(config,/CLIENT_SECRET|access_token/i); });
test("18. 備份及匯入保留 themeSongs", () => { const anime=V.migrateAnime({id:"a",title:"A",themeSongs:{openings:[{title:"OP",artist:"Singer"}],endings:[]}}); const backup=V.createBackup({animeList:[anime]}); const imported=V.importBackup({animeList:[]},backup,"replace").animeList[0]; assert.equal(imported.themeSongs.openings[0].title,"OP"); });
test("19. Supabase 合併保留較新 themeSongs 與人工修正", () => { const oldSong=V.normalizeThemeSong({id:"theme-1",title:"OP",artist:"A",spotifyTrackId:TRACK_ID,manuallyCorrected:true,updatedAt:"2026-01-01"},"OP",0); const newSong=V.normalizeThemeSong({id:"theme-1",title:"OP",artist:"A",spotifyTrackId:"0".repeat(22),updatedAt:"2026-02-01"},"OP",0); const merged=V.mergeCloudPayload({animeList:[{id:"a",title:"A",updatedAt:"2026-01-01",themeSongs:{openings:[oldSong],endings:[]}}]},{animeList:[{id:"a",title:"A",updatedAt:"2026-02-01",themeSongs:{openings:[newSong],endings:[]}}]}); assert.equal(merged.animeList[0].themeSongs.openings[0].spotifyTrackId,TRACK_ID); });
test("20. Service Worker 不快取 Spotify 與主題曲 API", () => { const sw=fs.readFileSync(path.join(root,"sw.js"),"utf8"); assert.equal(V.shouldCacheRequest("https://api.spotify.com/v1/search"),false); assert.equal(V.shouldCacheRequest("https://accounts.spotify.com/api/token"),false); assert.equal(V.shouldCacheRequest("https://open.spotify.com/embed/track/x"),false); assert.equal(V.shouldCacheRequest("https://api.jikan.moe/v4/anime/1/full"),false); assert.match(sw,/spotify\\\.com|spotify\.com/); assert.match(sw,/jikan/); });
test("21. 外部 URL 使用安全新分頁屬性", () => { const source=fs.readFileSync(path.join(root,"spotify-themes.js"),"utf8"); assert.match(source,/target\s*=\s*"_blank"/); assert.match(source,/rel\s*=\s*"noopener noreferrer"/); assert.match(source,/safeUrl/); });
test("22. 關閉詳細頁會取消請求並移除 iframe", () => { const source=fs.readFileSync(path.join(root,"spotify-themes.js"),"utf8"); assert.match(source,/function close\(\).*abortPending/s); assert.match(source,/querySelectorAll\("iframe"\).*remove/s); assert.match(source,/details\.addEventListener\("toggle"/); });
test("23. 卡片包含標題詳細頁與主題曲入口", () => { const source=fs.readFileSync(path.join(root,"index.html"),"utf8"); assert.match(source,/data-open-detail=/); assert.match(source,/data-open-themes=/); assert.match(source,/🎵 主題曲/); });
test("24. 入口由單一事件委派處理", () => { const source=fs.readFileSync(path.join(root,"v11-ui.js"),"utf8"); assert.match(source,/document\.addEventListener\("click",\s*delegatedClick\)/); assert.match(source,/closest\("\[data-open-themes\]\"\)/); assert.match(source,/stopPropagation\(\)/); });
test("25. 主題曲入口開啟 Modal 後呼叫實際展開函式", () => { const source=fs.readFileSync(path.join(root,"v11-ui.js"),"utf8"); assert.match(source,/openAnimeDetail\([^)]*expandThemes/); assert.match(source,/SpotifyThemes\?\.expand/); const theme=fs.readFileSync(path.join(root,"spotify-themes.js"),"utf8"); assert.match(theme,/function expand\([^)]*\).*details\.theme-details/s); });
test("26. 無歌曲仍顯示提示與新增按鈕", () => { const source=fs.readFileSync(path.join(root,"spotify-themes.js"),"utf8"); assert.match(source,/尚未找到此作品的 OP／ED/); assert.match(source,/人工新增/); assert.match(source,/自動尋找 OP／ED/); });
test("27. Worker 未設定提示存在", () => { const source=fs.readFileSync(path.join(root,"spotify-themes.js"),"utf8"); assert.match(source,/Spotify 搜尋尚未設定/); });

if (!process.exitCode) console.log(`\nSpotify/theme tests passed: ${passed}/27`);
