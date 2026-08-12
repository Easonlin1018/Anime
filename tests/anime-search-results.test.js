"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const titleStart = html.indexOf("function stripDisplayYear");
const titleEnd = html.indexOf("async function searchWikipedia", titleStart);
const normalizeStart = html.indexOf("function normalizeAniListSearchResults");
const normalizeEnd = html.indexOf("async function requestAniListSearchPage", normalizeStart);
const directStart = html.indexOf("function directRelationMediaIds");
const directEnd = html.indexOf("async function buildSingleAnimeSearchEntries", directStart);
const cardStart = html.indexOf("function getSingleAnimeSearchCardView");
const cardEnd = html.indexOf("function renderSingleAnimeSearchCandidate", cardStart);
const findStart = html.indexOf("function findPendingSingleAnimeSearchEntry");
const findEnd = html.indexOf("function addPendingAnimeSearchResult", findStart);
const categoryStart = html.indexOf("function isMediaClearlyNotYetReleased");
const categoryEnd = html.indexOf("function buildAnimeRecordFromMedia", categoryStart);
const mediaStart = html.indexOf("function getAniListMediaId");
const mediaEnd = html.indexOf("async function manualScanSequels", mediaStart);
for (const position of [titleStart,titleEnd,normalizeStart,normalizeEnd,directStart,directEnd,cardStart,cardEnd,findStart,findEnd,categoryStart,categoryEnd,mediaStart,mediaEnd]) assert.ok(position >= 0);

const api = Function(`${html.slice(titleStart,titleEnd)}
${html.slice(normalizeStart,normalizeEnd)}
${html.slice(directStart,directEnd)}
${html.slice(cardStart,cardEnd)}
${html.slice(findStart,findEnd)}
${html.slice(categoryStart,categoryEnd)}
${html.slice(mediaStart,mediaEnd)}
return { normalizeAniListSearchResults, getSingleAnimeSearchCardView, findPendingSingleAnimeSearchEntry, getExistingAnimeMediaState, addOrRestoreSingleMedia };`)();

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.stack}`); }
}

const media = (id, title, year) => ({
    id,
    title:{native:title,english:null,romaji:title},
    format:"TV",
    episodes:year === 2024 ? 12 : 13,
    status:"FINISHED",
    startDate:{year,month:1,day:1},
    relations:{edges:[]}
});
const record = (id, title, year, deletedAt = null) => ({
    id:`local-${id}`,
    anilistId:id,
    title,
    displayTitle:title,
    category:deletedAt ? "_deleted" : "backlog",
    deletedFromCategory:deletedAt ? "watching" : null,
    deletedAt,
    year,
    startDate:{year,month:1,day:1},
    format:"TV",
    watched:4,
    rating:9,
    notes:"keep",
    themeSongs:[{id:"op"}]
});
const build = item => ({title:item.title.native,displayTitle:item.title.native,year:item.startDate.year,format:item.format,episodes:item.episodes});
const view = (entry, list) => api.getSingleAnimeSearchCardView(entry,list,{buildAnimeRecord:build});
const create = item => record(item.id,item.title.native,item.startDate.year);
const refresh = (anime,item) => { anime.format=item.format; anime.episodes=item.episodes; anime.startDate={...item.startDate}; anime.year=item.startDate.year; return anime; };
const add = (item,list) => api.addOrRestoreSingleMedia(item,list,{createAnime:create,applyMetadata:refresh,now:"2026-08-11T00:00:00.000Z"});

const A = media(151807,"我獨自升級",2024);
const B = media(176496,"我獨自升級 第二季",2025);

test("1. A active、B tombstone 時各自顯示已加入與新增", () => {
    const list=[record(A.id,"我獨自升級",2024),record(B.id,"我獨自升級 第二季",2025,"2026-08-10T00:00:00.000Z")];
    assert.equal(view({media:A,context:{}},list).buttonLabel,"已加入");
    assert.equal(view({media:B,context:{}},list).buttonLabel,"新增");
});

test("2. 多結果不會只保留第一筆", () => {
    assert.deepEqual(api.normalizeAniListSearchResults([A,B]).map(item=>item.id),[A.id,B.id]);
});

test("3. 第一筆 ACTIVE 不會阻止第二筆顯示", () => {
    const list=[record(A.id,"我獨自升級",2024)];
    const views=[A,B].map(item=>view({media:item,context:{}},list));
    assert.deepEqual(views.map(item=>item.buttonLabel),["已加入","新增"]);
});

test("4. 點 B 的 identity 只恢復 B", () => {
    const list=[record(A.id,"我獨自升級",2024),record(B.id,"我獨自升級 第二季",2025,"2026-08-10T00:00:00.000Z")];
    const entries=[A,B].map(item=>({media:item,context:{}}));
    const selected=api.findPendingSingleAnimeSearchEntry(String(B.id),entries);
    const result=add(selected.media,list);
    assert.equal(result.action,"restored");
    assert.equal(result.anime.anilistId,B.id);
    assert.equal(list.find(item=>item.anilistId===A.id).updatedAt,undefined);
});

test("5. 加入 B 後 A count 仍 1、B count 變 1", () => {
    const list=[record(A.id,"我獨自升級",2024),record(B.id,"我獨自升級 第二季",2025,"2026-08-10T00:00:00.000Z")];
    add(B,list);
    assert.equal(list.filter(item=>item.anilistId===A.id&&!item.deletedAt).length,1);
    assert.equal(list.filter(item=>item.anilistId===B.id&&!item.deletedAt).length,1);
});

test("6. 再次按 B 為 no-op", () => {
    const list=[record(A.id,"我獨自升級",2024),record(B.id,"我獨自升級 第二季",2025,"2026-08-10T00:00:00.000Z")];
    assert.equal(add(B,list).changed,true);
    assert.equal(add(B,list).changed,false);
    assert.equal(list.length,2);
});

test("7. 十筆結果都保留自己的 AniList ID", () => {
    const results=Array.from({length:10},(_,index)=>media(200000+index,`作品 ${index+1}`,2020+index));
    assert.deepEqual(api.normalizeAniListSearchResults(results).map(item=>item.id),results.map(item=>item.id));
});

test("8. 點第 5 筆不會取到第 1 筆", () => {
    const entries=Array.from({length:10},(_,index)=>({media:media(300000+index,`作品 ${index+1}`,2020),context:{}}));
    assert.equal(api.findPendingSingleAnimeSearchEntry("300004",entries).media.id,300004);
});

test("9. 同標題不同 AniList ID 維持獨立結果", () => {
    const same=[media(401,"同名作品",2024),media(402,"同名作品",2024)];
    assert.deepEqual(api.normalizeAniListSearchResults(same).map(item=>item.id),[401,402]);
});

test("10. 搜尋卡年份使用獨立 year pill 資料", () => {
    const result=view({media:B,context:{}},[]);
    assert.equal(result.title,"我獨自升級 第二季");
    assert.equal(result.year,2025);
    assert.doesNotMatch(result.title,/2025/u);
});

test("11. ACTIVE 卡片 disabled", () => {
    assert.equal(view({media:A,context:{}},[record(A.id,"我獨自升級",2024)]).disabled,true);
});

test("12. TOMBSTONE 與 NOT_ADDED 都顯示相同普通新增", () => {
    const tombstone=[record(B.id,"我獨自升級 第二季",2025,"2026-08-10T00:00:00.000Z")];
    const deletedView=view({media:B,context:{}},tombstone);
    const newView=view({media:B,context:{}},[]);
    assert.deepEqual([deletedView.buttonLabel,deletedView.disabled],["新增",false]);
    assert.deepEqual([newView.buttonLabel,newView.disabled],["新增",false]);
});

test("AniList UI 搜尋使用 Page + SEARCH_MATCH，單筆流程使用獨立 query", () => {
    assert.match(html,/Page\(page: \$page, perPage: \$perPage\)/u);
    assert.match(html,/media\(search: \$search, type: ANIME, sort: SEARCH_MATCH\)/u);
    assert.match(html,/const SINGLE_MEDIA_SEARCH_QUERY/u);
    assert.match(html,/data-add-single-anime-search-result/u);
    assert.doesNotMatch(html.slice(html.indexOf("function addPendingAnimeSearchResult"),html.indexOf("async function searchAnime")),/checkAndAddSequel|walkAniListSequelGraph/u);
});

if (!process.exitCode) console.log(`\nAnime multi-result search tests passed: ${passed}/${passed}`);
