"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");
const ui = fs.readFileSync(path.join(__dirname, "..", "v11-ui.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const at = "2026-11-08T01:00:00.000Z";
const clone = value => JSON.parse(JSON.stringify(value));

function block(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `Missing production block ${start}`);
    return source.slice(a, b);
}
function productionFunction(source, name, indent = "") {
    const start = source.indexOf(`${indent}function ${name}(`);
    assert.ok(start >= 0, `Missing production function ${name}`);
    const firstLine = source.slice(start, source.indexOf("\n", start));
    if (firstLine.includes("}") && !firstLine.trimEnd().endsWith("{")) return firstLine;
    const re = new RegExp(`\\n${indent}(?:async )?function `, "g"); re.lastIndex = start;
    const next = re.exec(source);
    assert.ok(next, `Missing boundary after ${name}`);
    return source.slice(start, next.index);
}
function anime(id, extra = {}) {
    return V.migrateAnime({ id, anilistId:id.length + 100, title:`Synthetic ${id}`, category:"waiting",
        watched:0, currentEpisode:0, episodes:12, totalEpisodes:12, notes:"keep notes", rating:8,
        updatedAt:at, categorySource:"manual", categoryManuallyEdited:true, ...extra }, at);
}
function runtime(list, options = {}) {
    const data = new Map(Object.entries({ [V.STORAGE_KEY]:JSON.stringify(list),
        [V.HISTORY_KEY]:JSON.stringify(list.map(item => ({ id:`history-${item.id}`, animeId:item.id, delta:1, at }))),
        anime_tracker_schema_version:"11", anime_tracker_last_undo_v11:JSON.stringify({ previous:"retained" }),
        unrelated:"keep this value", ...(options.seed || {}) }));
    const trace = [], toasts = [], nodes = new Map(), rendered = [], confirms = [];
    const pages = ["anime", "currently-watching", "stats"].map(page => ({ dataset:{ v11PageGroup:page }, hidden:page !== "anime" }));
    const node = id => { if (!nodes.has(id)) nodes.set(id, { value:"", hidden:false, innerHTML:"", textContent:"" }); return nodes.get(id); };
    const originalMain=data.get(V.STORAGE_KEY); let mainSaved=false;
    const localStorage = { getItem:key => data.get(key) ?? null,
        setItem(key, value) { if (key === options.failKey || (options.failRollback && mainSaved && key===V.STORAGE_KEY && String(value)===originalMain)) throw new DOMException("Synthetic quota", "QuotaExceededError"); trace.push({ key, value:String(value) }); data.set(key, String(value)); if(key===V.STORAGE_KEY)mainSaved=true; },
        removeItem:key => data.delete(key) };
    const context = vm.createContext({
        V, AnimeTrackerV11:V, animeList:clone(list), animeListQuery:options.query || "", animeListSort:"name",
        eventList:[], eventArchive:[], eventOverrides:{}, eventAnimeOverrides:{}, eventSettings:{},
        STORAGE_KEY:V.STORAGE_KEY, EVENT_OVERRIDES_KEY:"anime_event_overrides_v10", EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11",
        window:{ AnimeTrackerV11:V, __ANIME_STARTUP_STORAGE__:{ persisted:true, warnings:[], recoveryPending:!!options.pending } },
        document:{ getElementById:node, querySelectorAll:selector => selector === "[data-v11-page-group]" ? pages : [], querySelector:() => null },
        localStorage, console:{ warn:() => {} }, Date, Set, URL, scrollTo:() => {}, matchingAnime:() => [],
        showToast:message => toasts.push(message), setTimeout:() => 1, clearTimeout:() => {},
        confirm:message => { confirms.push(message); options.onConfirm?.(context); return true; },
        buildAnimeItem:item => `<div class="anime-item"><div class="anime-meta">${item.title}</div></div>`,
        renderList:() => rendered.push(context.animeList.filter(item => item.category !== "_v11_filtered").map(item => item.id)),
        renderCurrentlyWatching:() => {}, renderEvents:() => {}, refreshV11:() => {},
        renderReminders:() => {}, renderCalendar:() => {}, renderStats:() => {}, renderRestorePoints:() => {}, renderSyncStatus:() => {},
        openAnimeDetail:() => {}, activeWorkSearch:{ animeId:"" },
        saveEventLocalData:() => { localStorage.setItem("anime_event_overrides_v10", JSON.stringify(context.eventOverrides)); localStorage.setItem("anime_event_anime_overrides_v11", JSON.stringify(context.eventAnimeOverrides)); }
    });
    context.window.assertAnimeStartupWritable = () => { if (context.window.__ANIME_STARTUP_STORAGE__.recoveryPending) throw Error("Recovery pending"); };
    const indexFunctions = ["escapeHtml", "cleanupAnimeAuxiliaryReferences", "restoreAnimeStartupStorage", "isAnimeStartupSnapshot", "commitAnimeStartupChanges"].map(name => productionFunction(html, name));
    vm.runInContext(indexFunctions.join("\n"), context);
    const prefix = ui.slice(0, ui.indexOf("    const originalSaveAndRender"));
    const wrappers = block(ui, "    const originalBuildAnimeItem", "    function animeCategoryLabel");
    const functions = ["delegatedClick", "delegatedChange", "persistViewFilters", "renderFilterChips", "batchStorageFields", "batchMutationTimestamp", "readBatchStoredState", "commitBatchState", "publishBatchState", "reportBatchStorageFailure", "runBatch", "undoScopedBatch", "undoLast", "showPage"].map(name => productionFunction(ui, name, "    "));
    vm.runInContext(prefix + "\n" + wrappers + "\n" + functions.join("\n")
        + "\nwindow.__selection={state,delegatedClick,delegatedChange,showPage,runBatch,undoLast,getVisibleMainAnime};\n})();", context);
    node("v11-batch-action").value = "delete"; node("v11-batch-category").value = "backlog";
    context.renderList(); trace.length = 0;
    const target = (selector, values = {}) => ({ dataset:{}, ...values,
        matches:query => query === selector, closest:query => query === selector ? target : null });
    const click = selector => context.window.__selection.delegatedClick({ target:target(selector), preventDefault:() => {}, stopPropagation:() => {} });
    const change = (selector, values) => { const input=target(selector, values); context.window.__selection.delegatedChange({ target:input }); return input; };
    return { context, localStorage, trace, toasts, node, rendered, confirms, click, change, options, snapshot:()=>Object.fromEntries(data),
        api:context.window.__selection, selected:() => [...context.window.__selection.state.selected].sort(),
        stored:() => JSON.parse(localStorage.getItem(V.STORAGE_KEY)), history:() => JSON.parse(localStorage.getItem(V.HISTORY_KEY)) };
}

test("select current results shares the main renderer's raw currently-watching split and search scope", () => {
    const run = runtime([anime("visible"), anime("other"), anime("current", { category:"watching", watched:5, currentEpisode:5 })], { query:"visible" });
    run.click("[data-select-visible]");
    assert.deepEqual(run.selected(), ["visible"]);
    assert.deepEqual(Array.from(run.rendered.at(-1)), ["visible"]);
    assert.deepEqual(run.trace, []);
});

test("all selection is explicitly scoped to the currently filtered main-page results", () => {
    assert.match(ui, /data-select-all>全選目前主頁結果<\/button>/);
    assert.match(ui, /選取及批次操作僅限「我的動漫」目前顯示結果/);
    const run=runtime([anime("visible"), anime("other"), anime("current", { watched:1, currentEpisode:1 })], { query:"visible" });
    run.click("[data-select-all]");
    assert.deepEqual(run.selected(), ["visible"]);
});

test("changing a filter removes hidden selections before any batch action", () => {
    const run=runtime([anime("waiting"), anime("backlog", { category:"backlog" })]);
    run.click("[data-select-visible]");
    assert.deepEqual(run.selected(), ["backlog", "waiting"]);
    run.change("[data-filter]", { dataset:{ filter:"status" }, type:"select-one", value:"waiting" });
    assert.deepEqual(run.selected(), ["waiting"]);
    run.node("v11-batch-action").value="status";
    run.click("[data-run-batch]");
    assert.equal(run.stored().find(item=>item.id==="waiting").category,"backlog");
    assert.equal(run.stored().find(item=>item.id==="backlog").updatedAt,at);
});

test("a changed search, cleared selection mode and newly started progress cannot leave hidden selections", () => {
    const run=runtime([anime("one"), anime("two")]);
    run.click("[data-select-visible]");
    run.context.animeListQuery="one"; run.context.renderList();
    assert.deepEqual(run.selected(), ["one"]);
    run.context.animeList.find(item=>item.id==="one").currentEpisode=1;
    run.context.animeList.find(item=>item.id==="one").watched=1;
    run.context.renderList(); assert.deepEqual(run.selected(), []);
    run.context.animeListQuery="two"; run.click("[data-batch-toggle]"); run.click("[data-select-visible]");
    run.click("[data-batch-toggle]"); assert.deepEqual(run.selected(), []);
});

test("switching sections clears selection and rejects a forged checkbox on the independent page", () => {
    const run=runtime([anime("one"), anime("current", { watched:1, currentEpisode:1 })]);
    run.click("[data-select-visible]"); run.api.showPage("currently-watching");
    assert.deepEqual(run.selected(), []);
    const checkbox=run.change("[data-select-anime]", { dataset:{ selectAnime:"one" }, checked:true });
    assert.equal(checkbox.checked,false); assert.deepEqual(run.selected(), []);
    run.click("[data-select-all]"); assert.deepEqual(run.selected(), []);
    run.api.showPage("anime"); assert.deepEqual(run.selected(), []);
});

test("current-page cards cannot expose an active batch checkbox", () => {
    const current=anime("current", { watched:1, currentEpisode:1 }), run=runtime([anime("one"),current]);
    run.click("[data-batch-toggle]");
    assert.match(run.context.buildAnimeItem(current), /data-select-anime="current" hidden disabled/);
    assert.doesNotMatch(run.context.buildAnimeItem(run.context.animeList[0]), /data-select-anime="one" hidden disabled/);
});

test("duplicate active IDs and category-only tombstones are not batch-selectable", () => {
    const run=runtime([anime("duplicate"), anime("duplicate", { anilistId:999, watched:1, currentEpisode:1 }), anime("tombstone", { category:"_deleted" }), anime("safe")]);
    run.click("[data-select-visible]");
    assert.deepEqual(run.selected(), ["safe"]);
    assert.ok(!run.rendered.at(-1).includes("tombstone"));
    assert.equal(run.rendered.at(-1).filter(id=>id==="duplicate").length,1);
    const forged=run.change("[data-select-anime]", { dataset:{ selectAnime:"duplicate" }, checked:true });
    assert.equal(forged.checked,false);
});

test("batch deletion and undo preserve a hidden current-viewing season and its history", () => {
    const list=[anime("visible"), anime("current", { watched:5, currentEpisode:5, notes:"hidden note", rating:9 })], run=runtime(list);
    const hiddenBefore=clone(run.context.animeList[1]), historyBefore=clone(run.history());
    run.click("[data-select-visible]");
    run.api.state.selected.add("current"); // A stale selection from an older rendering must be rejected at execution.
    run.click("[data-run-batch]");
    assert.equal(run.stored().find(item=>item.id==="visible").category,"_deleted");
    assert.deepEqual(run.stored().find(item=>item.id==="current"), hiddenBefore);
    assert.deepEqual(run.history().filter(item=>item.animeId==="current"), historyBefore.filter(item=>item.animeId==="current"));
    assert.match(run.confirms[0], /將刪除 1 部/); assert.doesNotMatch(run.confirms[0], /Synthetic current/);
    run.click("[data-undo]");
    assert.equal(run.stored().find(item=>item.id==="visible").category,"waiting");
    assert.deepEqual(run.stored().find(item=>item.id==="current"),hiddenBefore);
    assert.deepEqual(run.history(),historyBefore); assert.deepEqual(run.selected(),[]);
});

test("no visible result and off-page batch execution cannot mutate any work or create an undo", () => {
    const run=runtime([anime("current", { watched:1, currentEpisode:1 })]);
    run.api.state.selected.add("current"); run.click("[data-run-batch]");
    assert.deepEqual(run.trace,[]); assert.deepEqual(run.selected(),[]);
    run.api.showPage("stats"); run.api.state.selected.add("current"); run.click("[data-run-batch]");
    assert.deepEqual(run.trace,[]);
});

test("a result that becomes hidden during delete confirmation is not deleted", () => {
    const run=runtime([anime("one")], { onConfirm:context => { context.animeListQuery="no longer visible"; } });
    run.click("[data-select-visible]"); run.click("[data-run-batch]");
    assert.deepEqual(run.trace,[]); assert.equal(run.stored()[0].category,"waiting");
    assert.deepEqual(run.selected(),[]);
});

test("batch status projects only its required fields and preserves raw progress, review and user metadata", () => {
    const target={...anime("one"),currentEpisode:true,watched:true,reviewWatched:"7",createdAt:"legacy date",customField:{ keep:true }};
    const hidden=anime("current", { currentEpisode:5, watched:5, reviewWatched:"4", customField:{ untouched:true } });
    const run=runtime([target,hidden]), before=clone(run.stored());
    run.node("v11-batch-action").value="status"; run.click("[data-select-visible]"); run.click("[data-run-batch]");
    const changed=run.stored()[0];
    for(const key of ["currentEpisode","watched","reviewWatched","createdAt","customField","notes","rating","lastWatchedAt","nextEpisodeAt"])assert.deepEqual(changed[key],before[0][key],key);
    assert.deepEqual(run.stored()[1],before[1]); assert.equal(changed.category,"backlog");
    assert.equal(changed.categorySource,"manual"); assert.equal(changed.categoryManuallyEdited,true);
});

test("batch undo preserves newer hidden work data, source cache, theme undo, cross-media entries and watch history", () => {
    const works=[{ workId:"work", title:"Synthetic", aliases:[], updatedAt:at, mediaEntries:[{ id:"one", mediaType:"anime", sourceId:"103", notes:"selected" }, { id:"current", mediaType:"anime", sourceId:"107", notes:"hidden" }] }];
    const run=runtime([anime("one"),anime("current",{ currentEpisode:5,watched:5 })],{ seed:{
        [V.WORKS_KEY]:JSON.stringify(works), anime_theme_lookup_cache_v1:JSON.stringify({"source:one":{old:true}}),
        anime_theme_last_undo_v1:JSON.stringify({animeId:"one",before:{old:true}}) } });
    run.click("[data-select-visible]"); run.click("[data-run-batch]");
    const list=run.stored();list[1].notes="new hidden note";list[1].currentEpisode=list[1].watched=6;
    run.localStorage.setItem(V.STORAGE_KEY,JSON.stringify(list));
    run.localStorage.setItem("anime_theme_lookup_cache_v1",JSON.stringify({"source:one":{newer:true},"source:current":{keep:true}}));
    const newerUndo={animeId:"current",before:{newer:true}};run.localStorage.setItem("anime_theme_last_undo_v1",JSON.stringify(newerUndo));
    const newWorks=JSON.parse(run.localStorage.getItem(V.WORKS_KEY));newWorks[0].mediaEntries[1].notes="new manga-side note";
    run.localStorage.setItem(V.WORKS_KEY,JSON.stringify(newWorks));
    const newHistory=[...run.history(),{id:"later",animeId:"current",delta:1,at:"2026-11-09T00:00:00Z"}];run.localStorage.setItem(V.HISTORY_KEY,JSON.stringify(newHistory));
    run.click("[data-undo]");
    assert.deepEqual(run.stored()[1],list[1]); assert.equal(run.stored()[0].category,"waiting");
    assert.deepEqual(JSON.parse(run.localStorage.getItem("anime_theme_lookup_cache_v1")),{"source:one":{newer:true},"source:current":{keep:true}});
    assert.deepEqual(JSON.parse(run.localStorage.getItem("anime_theme_last_undo_v1")),newerUndo);
    assert.equal(JSON.parse(run.localStorage.getItem(V.WORKS_KEY))[0].mediaEntries[1].notes,"new manga-side note");
    assert.ok(run.history().some(item=>item.id==="later")); assert.ok(run.history().some(item=>item.id==="history-one"));
});

test("undo safely refuses to overwrite later notes or progress on a selected work and retains its undo", () => {
    for(const later of [{notes:"newer selected note"},{watched:5,currentEpisode:5}]) {
        const run=runtime([anime("one")]);run.node("v11-batch-action").value="status";
        run.click("[data-select-visible]");run.click("[data-run-batch]");
        const list=run.stored();Object.assign(list[0],later);run.localStorage.setItem(V.STORAGE_KEY,JSON.stringify(list));
        const before=run.snapshot();run.trace.length=0;run.click("[data-undo]");
        assert.deepEqual(run.snapshot(),before);assert.deepEqual(run.trace,[]);
        assert.match(run.toasts.at(-1),/尚未完成/);
    }
});

test("multiple selected histories retain their original interleaving with hidden work history after delete and undo", () => {
    const history=[{id:"a1",animeId:"aaa"},{id:"b1",animeId:"bbb"},{id:"a2",animeId:"aaa"},{id:"b2",animeId:"bbb"},{id:"h",animeId:"current"}];
    const run=runtime([anime("aaa"),anime("bbb"),anime("current",{currentEpisode:1,watched:1})],{seed:{[V.HISTORY_KEY]:JSON.stringify(history)}});
    run.click("[data-select-visible]");run.click("[data-run-batch]");run.click("[data-undo]");
    assert.deepEqual(run.history(),history);
});

test("batch changes and undo use increasing update versions even with a future stored timestamp", () => {
    const future="2030-01-01T00:00:00.000Z",run=runtime([anime("one",{updatedAt:future})]);
    run.node("v11-batch-action").value="status";run.click("[data-select-visible]");run.click("[data-run-batch]");
    const after=run.stored()[0].updatedAt;assert.ok(Date.parse(after)>Date.parse(future));
    run.click("[data-undo]");assert.ok(Date.parse(run.stored()[0].updatedAt)>Date.parse(after));
});

for(const failKey of ["anime_tracker_startup_pending_v1","anime_tracker_last_undo_v11",V.STORAGE_KEY,V.HISTORY_KEY,"anime_event_overrides_v10",V.WORKS_KEY,"anime_theme_lookup_cache_v1","anime_theme_last_undo_v1"]) {
    test(`batch delete failure at ${failKey} retains memory, raw storage, history and prior undo`,()=>{
        const run=runtime([anime("one"),anime("current",{currentEpisode:1,watched:1})],{failKey,seed:{
            anime_event_overrides_v10:JSON.stringify({event:{includeAnimeIds:["one","current"]}}),
            [V.WORKS_KEY]:JSON.stringify([{workId:"work",mediaEntries:[{id:"one",mediaType:"anime"}]}]),
            anime_theme_lookup_cache_v1:JSON.stringify({"source:one":{keep:true}}),
            anime_theme_last_undo_v1:JSON.stringify({animeId:"one",before:{keep:true}}) }});
        const before=run.snapshot(),memory=clone(run.context.animeList);
        run.click("[data-select-visible]");assert.doesNotThrow(()=>run.click("[data-run-batch]"));
        assert.deepEqual(run.snapshot(),before);assert.deepEqual(clone(run.context.animeList),memory);
        assert.ok(!run.toasts.includes("批次操作完成，可復原上一步"));
    });
}

for(const failKey of ["anime_tracker_startup_pending_v1","anime_tracker_last_undo_v11",V.STORAGE_KEY,V.HISTORY_KEY]) {
    test(`batch undo failure at ${failKey} keeps the successful deletion and its usable undo`,()=>{
        const run=runtime([anime("one"),anime("current",{currentEpisode:1,watched:1})]);
        run.click("[data-select-visible]");run.click("[data-run-batch]");
        const before=run.snapshot(),memory=clone(run.context.animeList);run.options.failKey=failKey;
        assert.doesNotThrow(()=>run.click("[data-undo]"));
        assert.deepEqual(run.snapshot(),before);assert.deepEqual(clone(run.context.animeList),memory);
        assert.notEqual(run.toasts.at(-1),"已復原上一步");
        run.options.failKey="";run.click("[data-undo]");assert.equal(run.stored()[0].category,"waiting");
    });
}

test("cross-media hydrate supplies legacy display defaults without changing or saving the raw works", () => {
    const source=fs.readFileSync(path.join(__dirname,"..","cross-media.js"),"utf8");
    const context=vm.createContext({V,animeList:[],works:[],mangaHistory:[],localStorage:{setItem:()=>{throw Error("Unexpected storage write");}}});
    vm.runInContext(productionFunction(source,"applyPersistedSnapshot","    "),context);
    const raw=[{workId:"legacy",title:"Legacy",mediaEntries:[{id:"legacy-anime",mediaType:"anime",title:"Legacy anime"},{id:"manga",mediaType:"manga",title:"Legacy manga"}]}],before=clone(raw);
    context.applyPersistedSnapshot(raw,[]);
    assert.deepEqual(raw,before);assert.doesNotThrow(()=>V.searchWorks(context.works,"Legacy"));
    assert.doesNotThrow(()=>V.mangaStats(context.mangaHistory,context.works));
    assert.ok(Array.isArray(context.works[0].aliases));assert.ok(Array.isArray(context.works[0].mediaEntries[0].aliases));
});

test("batch rollback failure retains a valid journal whose originals stay readable on repeated startup", () => {
    const run=runtime([anime("one"),anime("current",{currentEpisode:1,watched:1})],{failKey:V.HISTORY_KEY,failRollback:true});
    const before=run.snapshot(),memory=clone(run.context.animeList);
    run.click("[data-select-visible]");run.click("[data-run-batch]");
    assert.deepEqual(clone(run.context.animeList),memory);assert.equal(run.context.window.__ANIME_STARTUP_STORAGE__.recoveryPending,true);
    const pending=JSON.parse(run.localStorage.getItem("anime_tracker_startup_pending_v1"));
    assert.equal(run.context.isAnimeStartupSnapshot(pending),true);
    assert.equal(pending.originals.anime_tracker_last_undo_v11,before.anime_tracker_last_undo_v11);
    const production=[block(html,"function stripDisplayYear","async function searchWikipedia"),block(html,"function normalizeAnimeAliasList","function deriveAliasVariants"),
        block(html,"function getAniListMediaId","function getMediaIdentityTitles"),block(html,"function normalizeStreamingLinks","function buildAnimeRecordFromMedia"),
        block(html,"function loadStoredAnime","function delay"),block(html,"function formatAiringDateTime","async function syncAnimeMetadata")].join("\n");
    for(let attempt=0;attempt<2;attempt++) {
        const boot=vm.createContext({window:{AnimeTrackerV11:V},AnimeTrackerV11:V,localStorage:run.localStorage,Date,
            animeList:[],STORAGE_KEY:V.STORAGE_KEY,OLD_KEYS:["anime_list_v8_7"],ANIME_SYNC_KEY:"anime_metadata_sync_v10_1",
            EVENT_OVERRIDES_KEY:"anime_event_overrides_v10",EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11",
            eventOverrides:{},eventAnimeOverrides:{},document:{getElementById:()=>({style:{}}),querySelectorAll:()=>[],addEventListener:()=>{}},
            console:{warn:()=>{}},setTimeout:()=>1,clearTimeout:()=>{}});
        vm.runInContext(production,boot);assert.doesNotThrow(()=>boot.loadStoredAnime());
        assert.deepEqual(clone(boot.animeList),JSON.parse(before[V.STORAGE_KEY]));
        assert.equal(boot.window.__ANIME_STARTUP_STORAGE__.recoveryPending,true);
        assert.equal(boot.getAnimeStartupStoredItem("anime_tracker_last_undo_v11"),before.anime_tracker_last_undo_v11);
    }
});

test("batch publication keeps legacy aliases and tags usable in memory without rewriting their raw values or progress", () => {
    const raw={...anime("one"),aliases:null,tags:"old tag text",currentEpisode:true,watched:true},run=runtime([raw]);
    run.node("v11-batch-action").value="status";run.click("[data-select-visible]");run.click("[data-run-batch]");
    assert.doesNotThrow(()=>run.context.animeList[0].aliases.join("、"));
    assert.doesNotThrow(()=>run.context.animeList[0].tags.join("、"));
    assert.equal(run.context.animeList[0].currentEpisode,true);
    assert.equal(run.stored()[0].aliases,null);assert.equal(run.stored()[0].tags,"old tag text");
    assert.equal(run.stored()[0].currentEpisode,true);assert.equal(run.stored()[0].watched,true);
});

test("batch undo refuses a newer cross-media deletion state and retains its original recovery record", () => {
    const run=runtime([anime("one")],{seed:{[V.WORKS_KEY]:JSON.stringify([{workId:"work",mediaEntries:[{id:"one",mediaType:"anime",sourceId:"103"}]}])}});
    run.click("[data-select-visible]");run.click("[data-run-batch]");
    const works=JSON.parse(run.localStorage.getItem(V.WORKS_KEY));works[0].mediaEntries[0].deletedAt="2030-01-01T00:00:00Z";
    run.localStorage.setItem(V.WORKS_KEY,JSON.stringify(works));
    const before=run.snapshot();run.trace.length=0;run.click("[data-undo]");
    assert.deepEqual(run.snapshot(),before);assert.deepEqual(run.trace,[]);
    assert.notEqual(run.toasts.at(-1),"已復原上一步");
});

test("Theme Songs hydrate reads a committed cache, closes a deleted selection and performs no storage write", () => {
    const source=fs.readFileSync(path.join(__dirname,"..","spotify-themes.js"),"utf8");
    let closes=0;
    const context=vm.createContext({cache:{old:{keep:true}},currentAnime:{id:"one"},Set,
        close:()=>closes++,localStorage:{setItem:()=>{throw Error("Unexpected storage write");}}});
    vm.runInContext(block(source,"    function applyPersistedSnapshot(","    const api ="),context);
    const next={"source:one":{value:{title:"updated"}}};
    context.applyPersistedSnapshot(next,new Set(["one"]));
    assert.deepEqual(clone(context.cache),next);assert.equal(closes,1);
});
