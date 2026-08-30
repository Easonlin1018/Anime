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

const api = Function("AnimeTrackerV11", `${html.slice(titleStart,titleEnd)}
${html.slice(normalizeStart,normalizeEnd)}
${html.slice(directStart,cardStart)}
${html.slice(cardStart,cardEnd)}
${html.slice(findStart,findEnd)}
${html.slice(categoryStart,categoryEnd)}
${html.slice(mediaStart,mediaEnd)}
let animeList = [];
const MAX_DISCOVERED_MEDIA = 30;
async function translateText() { return null; }
return {
    normalizeAniListSearchResults,
    buildSingleAnimeSearchEntries,
    getSingleAnimeSearchCardView,
    findPendingSingleAnimeSearchEntry,
    getExistingAnimeMediaState,
    addOrRestoreSingleMedia,
    getExistingChineseSeriesContext,
    setAnimeList(value) { animeList = Array.isArray(value) ? value : []; }
};`)(V);

let passed = 0;
const pendingTests = [];
function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === "function") {
            pendingTests.push(result.then(() => {
                passed++;
                console.log(`✓ ${name}`);
            }).catch(error => {
                process.exitCode = 1;
                console.error(`✗ ${name}\n  ${error.stack}`);
            }));
            return;
        }
        passed++;
        console.log(`✓ ${name}`);
    }
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

test("關聯候選優先沿用既有繁中系列 context，不採低可信機翻母標題", () => {
    const candidate = {
        id:206425,
        title:{
            native:"葬送のフリーレン ～●●の魔法～ 3クール",
            romaji:"Sousou no Frieren: ●● no Mahou Part 3"
        },
        format:"ONA",
        relations:{edges:[]}
    };
    const existing = [{
        id:"local-frieren",
        anilistId:154587,
        title:"葬送的芙莉蓮",
        groupTitle:"葬送的芙莉蓮",
        aliases:["Sousou no Frieren", "Frieren: Beyond Journey's End"],
        category:"completed"
    }];
    assert.equal(api.getExistingChineseSeriesContext(candidate, existing), "葬送的芙莉蓮");
});

test("搜尋 UI 將直接結果與相關動畫分區顯示", () => {
    const renderStart = html.indexOf("function renderSingleAnimeSearchCandidate");
    const renderEnd = html.indexOf("function findPendingSingleAnimeSearchEntry", renderStart);
    const source = html.slice(renderStart, renderEnd);
    assert.match(source, /appendGroup\("直接搜尋結果", directEntries, "direct"\)/u);
    assert.match(source, /appendGroup\("相關動畫", relatedEntries, "relation"\)/u);
    assert.match(source, /data\.discoverySource|dataset\.discoverySource/u);
});

test("相關動畫文案只依 relationType 通用產生", () => {
    const labelStart = html.indexOf("function searchDiscoveryRelationLabel");
    const labelEnd = html.indexOf("function renderSingleAnimeSearchCandidate", labelStart);
    const source = html.slice(labelStart, labelEnd);
    assert.match(source, /PREQUEL:"前傳"/u);
    assert.match(source, /SEQUEL:"續作"/u);
    assert.match(source, /ALTERNATIVE:"其他版本"/u);
    assert.match(source, /SIDE_STORY:"外傳"/u);
    assert.doesNotMatch(source, /堀與宮村|ホリミヤ|Horimiya/u);
});

const localizedDiscoveryFixture = () => {
    const direct = {
        id:14753,
        title:{native:"ホリミヤ",english:"HoriMiya",romaji:"Horimiya"},
        synonyms:[],format:"OVA",startDate:{year:2012},
        relations:{edges:[{relationType:"ALTERNATIVE",node:{id:124080}}]}
    };
    const related = {
        id:124080,
        title:{native:"ホリミヤ",english:"Horimiya",romaji:"Horimiya"},
        synonyms:[],format:"TV",startDate:{year:2021},
        relations:{edges:[{relationType:"SEQUEL",node:{id:163132}}]}
    };
    const relatedWithSuffix = {
        id:163132,
        title:{native:"ホリミヤ -piece-",english:"Horimiya: The Missing Pieces",romaji:"Horimiya: piece"},
        synonyms:[],format:"TV",startDate:{year:2023},relations:{edges:[]}
    };
    return [
        {media:direct,discoverySource:"direct",relationDepth:0},
        {media:related,discoverySource:"relation",relationType:"ALTERNATIVE",relationDepth:1,discoveredFromAniListId:"14753"},
        {media:relatedWithSuffix,discoverySource:"relation",relationType:"SEQUEL",relationDepth:2,discoveredFromAniListId:"124080"}
    ];
};

test("Related result 沿 discovery parent 共用繁中 title pipeline", async () => {
    api.setAnimeList([]);
    const entries = await api.buildSingleAnimeSearchEntries(localizedDiscoveryFixture(), {wikiZhTitle:"堀與宮村"});
    assert.equal(entries.find(entry => entry.media.id === 163132).context.titleDetails.displayTitle, "堀與宮村 -piece-（2023）");
});

test("無可信翻譯的 distinctive suffix 保留原文、主系列維持繁中", async () => {
    api.setAnimeList([]);
    const entries = await api.buildSingleAnimeSearchEntries(localizedDiscoveryFixture(), {wikiZhTitle:"堀與宮村"});
    const title = entries.find(entry => entry.media.id === 163132).context.titleDetails.displayTitle;
    assert.match(title, /^堀與宮村/u);
    assert.match(title, /-piece-/u);
    assert.doesNotMatch(title, /^ホリミヤ/u);
});

test("Related media 有可信繁中 alias 時優先使用 alias", async () => {
    api.setAnimeList([]);
    const fixture = localizedDiscoveryFixture();
    fixture[2].media.synonyms = ["堀與宮村：遺失的篇章"];
    const entries = await api.buildSingleAnimeSearchEntries(fixture, {wikiZhTitle:"堀與宮村"});
    assert.equal(entries.find(entry => entry.media.id === 163132).context.titleDetails.displayTitle, "堀與宮村：遺失的篇章（2023）");
});

test("manual title 仍優先於 Related localized title", async () => {
    const manual = {
        id:"local-manual",anilistId:163132,title:"My Manual Title",displayTitle:"My Manual Title",
        groupTitle:"堀與宮村",titleManuallyEdited:true,titleSource:"manual",category:"backlog"
    };
    api.setAnimeList([manual]);
    const entries = await api.buildSingleAnimeSearchEntries(localizedDiscoveryFixture(), {wikiZhTitle:"堀與宮村"});
    const entry = entries.find(item => item.media.id === 163132);
    assert.equal(api.getSingleAnimeSearchCardView(entry,[manual],{buildAnimeRecord:build}).title,"My Manual Title");
});

test("不同 AniList ID 的 Direct / Related entries 不合併", async () => {
    api.setAnimeList([]);
    const entries = await api.buildSingleAnimeSearchEntries(localizedDiscoveryFixture(), {wikiZhTitle:"堀與宮村"});
    assert.deepEqual(entries.map(entry => entry.media.id),[14753,124080,163132]);
});

test("relation discovery metadata 不寫回 raw media 或 series identity", async () => {
    api.setAnimeList([]);
    const fixture = localizedDiscoveryFixture();
    const before = JSON.stringify(fixture.map(item => item.media));
    const entries = await api.buildSingleAnimeSearchEntries(fixture, {wikiZhTitle:"堀與宮村"});
    assert.equal(JSON.stringify(fixture.map(item => item.media)),before);
    assert.ok(entries.every(entry => !Object.hasOwn(entry.media,"seriesKey") && !Object.hasOwn(entry.media,"discoverySource")));
});

Promise.all(pendingTests).then(() => {
    if (!process.exitCode) console.log(`\nAnime multi-result search tests passed: ${passed}/${passed}`);
});
