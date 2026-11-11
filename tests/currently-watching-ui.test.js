"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require(appSourcePath("v11-core.js"));
const root = path.resolve(__dirname, "..");
const ui = fs.readFileSync(appSourcePath("v11-ui.js"), "utf8");
const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const at = "2026-11-08T01:00:00.000Z";

function between(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `Missing production block ${start}`);
    return source.slice(a, b);
}
function productionFunction(source, name, indent = "") {
    const start = source.indexOf(`${indent}function ${name}(`);
    assert.ok(start >= 0, `Missing function ${name}`);
    const firstLine = source.slice(start, source.indexOf("\n", start));
    if (firstLine.includes("}") && !firstLine.trimEnd().endsWith("{")) return firstLine;
    const re = new RegExp(`\\n${indent}(?:async )?function `, "g"); re.lastIndex = start;
    const next = re.exec(source);
    assert.ok(next, `Missing boundary after ${name}`);
    return source.slice(start, next.index);
}
function anime(id = "one", extra = {}) {
    return { id, anilistId:id === "two" ? 202 : 101, title:`Synthetic ${id}`, aliases:[],
        category:"watching", currentEpisode:1, watched:1, totalEpisodes:12, episodes:12,
        status:"RELEASING", groupTitle:"Same series", reviewWatched:0, notes:"retained note", rating:8,
        updatedAt:at, lastWatchedAt:at, nextEpisodeAt:"2026-12-01T12:00:00Z", broadcastDay:"星期五",
        ...extra };
}
function storage(list, options = {}) {
    const data = new Map(Object.entries({
        [V.STORAGE_KEY]:JSON.stringify(list), [V.HISTORY_KEY]:JSON.stringify([{ id:"prior", animeId:"other", delta:1, at }]),
        anime_tracker_schema_version:"11", anime_tracker_last_undo_v11:'{"retained":true}',
        anime_theme_last_undo_v1:'{"retained":true}', unrelated:"must remain",
        ...(options.autoSync ? { anime_tracker_auto_sync_v11:"1" } : {}),
        ...(options.seed || {})
    }));
    const trace = [], initialMain = data.get(V.STORAGE_KEY);
    let mainSaved = false;
    return {
        trace, getItem:key => data.get(key) ?? null,
        setItem(key, value) {
            value = String(value); trace.push({ action:"set", key, value });
            if (key === options.failKey || (options.failRollback && key === V.STORAGE_KEY && mainSaved && value === initialMain))
                throw new DOMException("Synthetic quota failure", "QuotaExceededError");
            data.set(key, value); if (key === V.STORAGE_KEY) mainSaved = true;
        },
        removeItem(key) { trace.push({ action:"remove", key }); data.delete(key); },
        snapshot:() => Object.fromEntries(data)
    };
}
function runtime(list = [], options = {}) {
    const localStorage = storage(list, options), nodes = new Map(), timers = new Map();
    const traces = { mainRenders:[], uploads:[], toasts:[], warnings:[], sequel:[], guardInstalled:0 };
    const pageIds = ["anime", "currently-watching", "reminders", "planner", "events", "manga", "stats", "data", "sync"];
    const pages = pageIds.map(id => ({ dataset:{ v11PageGroup:id }, hidden:id !== "anime" }));
    const buttons = pageIds.map(id => { const value={ dataset:{ v11Page:id }, active:false };value.classList={ toggle:(_name, active) => { value.active=active; } };return value; });
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { innerHTML:"", textContent:"", value:"", hidden:false });
        return nodes.get(id);
    };
    const context = vm.createContext({
        V, AnimeTrackerV11:V, animeList:clone(list), STORAGE_KEY:V.STORAGE_KEY,
        EVENT_OVERRIDES_KEY:"anime_event_overrides_v10", EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11",
        eventOverrides:{}, eventAnimeOverrides:{}, eventSettings:{}, animeListSort:"watching-first", animeListQuery:options.query || "",
        eventList:[], eventArchive:[], localStorage, location:{ href:"http://localhost/isolated/" }, URL, Date, Intl, Set,
        window:{ AnimeTrackerV11:V, __ANIME_STARTUP_STORAGE__:{ persisted:!options.deferred, recoveryPending:!!options.pending, warnings:[], originalList:clone(list) },
            __ANIME_EXISTING_MEDIA_MIGRATION__:{ categoryChanged:options.categoryChanged || 0 } },
        document:{ getElementById:node, querySelectorAll:selector => selector === "[data-v11-page-group]" ? pages : selector === "[data-v11-page]" ? buttons : [],
            querySelector:selector => selector.includes('"planner"') ? pages.find(page => page.dataset.v11PageGroup === "planner") : null },
        console:{ warn:(...args) => traces.warnings.push(args) }, scrollTo:() => {},
        setTimeout:callback => { const id=Symbol();timers.set(id, callback);return id; }, clearTimeout:id => timers.delete(id),
        showToast:message => traces.toasts.push(message), matchingAnime:() => [],
        renderList:() => { traces.mainRenders.push(clone(context.animeList.filter(item => item.category !== "_v11_filtered"))); if (options.renderFailure) throw Error("Synthetic render failure"); },
        renderReminders:() => {}, renderCalendar:() => {}, renderRestorePoints:() => {}, renderSyncStatus:() => {},
        saveAndRender:() => {}, updateProgress:() => {},
        handleSync:(action, config) => traces.uploads.push({ action, config:clone(config) }),
        checkAndAddSequel:item => traces.sequel.push(item.id), canConfirmAnimeWatching:() => false,
        getSeriesGroupTitle:item => item.groupTitle || item.title,
        installAnimeStartupRecoveryGuard:() => { traces.guardInstalled++; },
        warnAnimeStartupStorage:(...args) => traces.warnings.push(args)
    });
    context.window.runAnimeStorageWrite = operation => operation();
    context.window.assertAnimeStartupWritable = () => { if (context.window.__ANIME_STARTUP_STORAGE__.recoveryPending) throw Error("Recovery pending"); };
    context.window.warnAnimeStartupStorage = context.warnAnimeStartupStorage;
    const indexFunctions = ["escapeHtml", "getAniListMediaId", "getAnimeTitlePresentation", "formatAiringDateTime", "buildAnimeItem",
        "restoreAnimeStartupStorage", "isAnimeStartupSnapshot", "commitAnimeStartupChanges"].map(name => productionFunction(html, name));
    vm.runInContext(indexFunctions.join("\n"), context);
    const prefix = ui.slice(0, ui.indexOf("    const originalSaveAndRender"));
    const uiFunctions = ["animeCategoryLabel", "animeCategoryOptions", "currentlyWatchingPage", "renderCurrentlyWatching", "showPage", "renderFilterChips", "renderStats"].map(name => productionFunction(ui, name, "    "));
    const poster = between(ui, "    const ANIME_POSTER_PLACEHOLDER", "    function renderReminders");
    const progress = between(ui, "    updateProgress = function", "    deleteAnime = function");
    const wrappers = between(ui, "    const originalBuildAnimeItem", "    function animeCategoryLabel");
    const syncAndSave = between(ui, "    const originalSaveAndRender", "    updateProgress = function");
    const refresh = productionFunction(ui, "refreshV11", "    ");
    vm.runInContext(prefix + "\n" + uiFunctions.join("\n") + "\n" + poster + "\n" + syncAndSave + "\n" + wrappers + "\n" + progress + "\n" + refresh
        + "\nwindow.__ui={renderCurrentlyWatching,currentlyWatchingPage,showPage,animeCategoryOptions,handleAnimePosterError,getHistory:()=>watchHistory};\n})();", context);
    localStorage.trace.length = 0;
    return { api:context, localStorage, node, pages, buttons, timers, traces,
        flush:() => { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}

test("the main navigation contains a true currently-watching page alongside every existing page", () => {
    const nav = between(ui, "nav.innerHTML =", "container.insertBefore");
    for (const name of ["anime", "currently-watching", "reminders", "planner", "events", "stats", "data", "sync"]) assert.ok(nav.includes(`"${name}"`));
    const run = runtime();
    assert.match(run.api.window.__ui.currentlyWatchingPage(), /data-v11-page-group="currently-watching"/);
    run.api.window.__ui.showPage("currently-watching");
    assert.deepEqual(run.pages.filter(page => !page.hidden).map(page => page.dataset.v11PageGroup), ["currently-watching"]);
    assert.equal(run.buttons.find(button => button.dataset.v11Page === "currently-watching").active, true);
    run.api.window.__ui.showPage("manga");
    assert.deepEqual(run.pages.filter(page => !page.hidden).map(page => page.dataset.v11PageGroup), ["manga"]);
});

test("legacy in-progress entries render individually with posters, titles, progress and direct +/- actions", () => {
    const list = [anime("one", { poster:"https://example.invalid/poster.png" }), anime("two", { currentEpisode:5, watched:5 }), anime("movie", { currentEpisode:0, watched:0 })];
    const run = runtime(list), before = run.localStorage.snapshot();
    run.api.window.__ui.renderCurrentlyWatching();
    const markup = run.node("v11-currently-list").innerHTML;
    assert.equal((markup.match(/<article/g) || []).length, 2);
    assert.match(markup, /poster\.png/); assert.match(markup, /Synthetic one/); assert.match(markup, /觀看進度：5 \/ 12 集/);
    assert.match(markup, /data-progress-action="increment"/); assert.match(markup, /data-progress-action="decrement"/);
    assert.doesNotMatch(markup, /Synthetic movie/);
    assert.deepEqual(run.localStorage.snapshot(), before, "Rendering derives membership without storing another list");
    assert.deepEqual(run.localStorage.trace, []);
});

test("legacy relative cover paths stay same-origin and unsafe paths are rejected", () => {
    const options = { baseUrl:"https://example.invalid/Anime/" };
    assert.deepEqual(V.resolvePosterUrls({
        large:"./covers/one.png",
        medium:"https://example.invalid/Anime/covers/one.png"
    }, options), ["https://example.invalid/Anime/covers/one.png"]);
    assert.equal(V.resolvePosterUrl("/Anime/covers/two.jpg?size=2", options),
        "https://example.invalid/Anime/covers/two.jpg?size=2");
    for (const unsafe of ["//outside.invalid/cover.png", "%2f%2foutside.invalid/cover.png",
        "../cover.png", "covers/%2e%2e/cover.png", "covers\\cover.png", "arbitrary",
        "javascript:cover.png", "https://user:pass@example.invalid/cover.png"]) {
        assert.deepEqual(V.resolvePosterUrls(unsafe, options), [], unsafe);
    }
    assert.equal(V.resolvePosterUrl("./covers/one.png", { ...options, httpsOnly:true }), "");
});

test("currently-watching covers resolve legacy candidates independently and use a local image when absent", () => {
    const dataImage = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
    const rows = [
        anime("one", { title:'Legacy "cover" & <name>', poster:{ large:" ", medium:"https://example.invalid/medium.png?x=1&y=2" } }),
        anime("two", { poster:"not-a-url", coverImage:dataImage }),
        anime("three", { poster:{ large:"javascript:alert(1)", medium:{} }, coverImage:"//outside.invalid/missing.png" })
    ];
    const run = runtime(rows);
    const before = run.localStorage.snapshot();
    run.api.window.__ui.renderCurrentlyWatching();
    const markup = run.node("v11-currently-list").innerHTML;
    assert.match(markup, /data-open-detail="one"[^>]*><img[^>]*src="https:\/\/example\.invalid\/medium\.png\?x=1&amp;y=2" alt="Legacy &quot;cover&quot; &amp; &lt;name&gt; 封面" data-v11-poster="\[\]">/);
    assert.ok(markup.includes('src="' + dataImage + '" alt="Synthetic two 封面" data-v11-poster="[]"'));
    assert.match(markup, /data-open-detail="three"[^>]*><img loading="lazy" decoding="async" src="data:image\/svg\+xml,[^"]+" alt="Synthetic three 封面">/);
    assert.doesNotMatch(markup, /src="[^"]*(not-a-url|missing\.png|\[object Object\]|javascript:)/);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.deepEqual(run.localStorage.trace, []);
});

test("currently-watching orders and deduplicates legacy and confirmed AniList cover candidates", () => {
    const medium = "https://example.invalid/medium.webp?x=1&y=2";
    const remote = "https://example.invalid/anilist.jpg";
    const rows = [
        anime("one", {
            poster:{ large:"./covers/old.png", medium },
            coverImage:{ large:"http://localhost/isolated/covers/old.png", medium },
            source:"anilist", sourceId:101, anilistCover:{ id:"101", large:medium, medium:remote }
        }),
        anime("two", { anilistCover:{ id:"101", large:"https://example.invalid/wrong.jpg" } }),
        anime("three", { anilistId:null, anilistCover:{ id:"101", large:"https://example.invalid/unknown.jpg" } })
    ];
    const run = runtime(rows), before = run.localStorage.snapshot();
    run.api.window.__ui.renderCurrentlyWatching();
    const markup = run.node("v11-currently-list").innerHTML;
    assert.match(markup, /src="http:\/\/localhost\/isolated\/covers\/old\.png" alt="Synthetic one 封面" data-v11-poster="\[&quot;https:\/\/example\.invalid\/medium\.webp\?x=1&amp;y=2&quot;,&quot;https:\/\/example\.invalid\/anilist\.jpg&quot;\]"/);
    assert.doesNotMatch(markup, /wrong\.jpg|unknown\.jpg/);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.deepEqual(run.localStorage.trace, []);
});

test("failed poster loads try each remaining candidate once before the local placeholder", () => {
    const run = runtime([anime()]), before = run.localStorage.snapshot();
    const handler = run.api.window.__ui.handleAnimePosterError;
    const writes = [];
    const candidates = ["https://example.invalid/medium.webp", "https://example.invalid/anilist.jpg"];
    let queue = JSON.stringify(candidates);
    const failed = {
        matches: selector => queue !== null && selector === "img[data-v11-poster]",
        getAttribute: key => { assert.equal(key, "data-v11-poster"); return queue; },
        setAttribute: (key, value) => { assert.equal(key, "data-v11-poster"); queue = value; },
        removeAttribute: key => { assert.equal(key, "data-v11-poster"); queue = null; },
        set src(value) { writes.push(value); }
    };
    for (let i = 0; i < 5; i++) handler({ target:failed });
    handler({ target:{ matches:() => false, set src(_) { assert.fail("Unrelated image changed"); } } });
    assert.equal(queue, null);
    assert.equal(writes.length, 3);
    assert.deepEqual(writes.slice(0, 2), candidates);
    assert.match(decodeURIComponent(writes[2]), /^data:image\/svg\+xml,<svg[^>]* width="200" height="300"/);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.deepEqual(run.localStorage.trace, []);
});

test("unknown-total backlog remains visible while review, completed and deleted entries stay out", () => {
    const list = [anime("one", { category:"backlog", totalEpisodes:null, episodes:"??", currentEpisode:5 }),
        anime("review", { category:"review", reviewWatched:8 }), anime("done", { category:"completed" }), anime("deleted", { deletedAt:at })];
    const run=runtime(list);run.api.window.__ui.renderCurrentlyWatching();const markup=run.node("v11-currently-list").innerHTML;
    assert.match(markup, /Synthetic one/);assert.match(markup, /5 \/ 未知/);assert.match(markup, /補番中/);
    for(const name of ["review","done","deleted"])assert.ok(!markup.includes(`Synthetic ${name}`));
});

test("the standalone page ignores main search/filters and keeps the original category", () => {
    const list=[anime()],run=runtime(list,{query:"not a match",seed:{anime_tracker_filters_v11:JSON.stringify({status:["completed"]})}});
    run.api.renderList();
    assert.equal(run.traces.mainRenders[0].length,0);
    assert.match(run.node("v11-currently-list").innerHTML,/Synthetic one/);
    assert.match(run.node("v11-currently-list").innerHTML,/正在連載/);
    assert.equal(run.api.animeList[0].category,"watching");
});

test("main rendering excludes in-progress entries and restores the unfiltered memory list even on render failure", () => {
    const list=[anime(),anime("two",{watched:0,currentEpisode:0})],run=runtime(list);
    run.api.renderList();assert.deepEqual(run.traces.mainRenders[0].map(item=>item.id),["two"]);
    assert.equal(run.node("anime-list-summary").textContent,"顯示 1／1 部");
    assert.equal(run.api.animeList[0].category,"watching");
    const failed=runtime(list,{renderFailure:true});
    assert.throws(()=>failed.api.renderList(),/Synthetic render failure/);
    assert.equal(failed.api.animeList[0].category,"watching");
    assert.equal(failed.api.animeList[1].category,"watching");
});

test("empty state is explanatory and rendering cannot create storage records", () => {
    const run=runtime([anime("one",{watched:0,currentEpisode:0,lastWatchedAt:at})]);
    run.api.window.__ui.renderCurrentlyWatching();assert.match(run.node("v11-currently-list").innerHTML,/目前沒有正在看的動畫/);
    assert.deepEqual(run.localStorage.trace,[]);
});

test("invalid legacy progress cannot disappear from both pages through filter normalization", () => {
    const list = [anime("one", { currentEpisode:true, watched:true })], run = runtime(list);
    const before = clone(run.api.animeList);
    run.api.renderList();
    assert.deepEqual(run.traces.mainRenders.at(-1).map(item => item.id), ["one"]);
    assert.doesNotMatch(run.node("v11-currently-list").innerHTML, /Synthetic one/u);
    assert.deepEqual(clone(run.api.animeList), before);
    assert.deepEqual(run.localStorage.trace, []);
});

test("normal progress 0->1,1->5,11->12 and1->0 updates membership without changing broadcast timestamps", () => {
    for(const [start,delta,end,member,category] of [[0,1,1,true,"watching"],[1,4,5,true,"watching"],[11,1,12,false,"completed"],[1,-1,0,false,"watching"]]){
        const original=anime("one",{currentEpisode:start,watched:start}),run=runtime([original,anime("two",{currentEpisode:0,watched:0})]);
        assert.equal(run.api.updateProgress("one",delta),true);
        const saved=JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));assert.equal(saved[0].currentEpisode,end);assert.equal(saved[0].category,category);
        assert.equal(V.isAnimeCurrentlyWatching(saved[0]),member);assert.equal(saved[0].nextEpisodeAt,original.nextEpisodeAt);assert.equal(saved[0].notes,original.notes);
        assert.deepEqual(saved[1],anime("two",{currentEpisode:0,watched:0}));
        assert.equal(run.localStorage.trace.filter(op=>op.key===V.STORAGE_KEY&&op.action==="set").length,1);
        assert.equal(JSON.parse(run.localStorage.getItem(V.HISTORY_KEY)).at(-1).delta,end-start);
    }
});

test("review controls change only review progress and never enter the normal watching page", () => {
    const original=anime("one",{category:"review",currentEpisode:12,watched:12,reviewWatched:1}),run=runtime([original]);
    assert.equal(run.api.updateProgress("one",1),true);const saved=JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0];
    assert.equal(saved.reviewWatched,2);assert.equal(saved.currentEpisode,12);assert.equal(saved.category,"review");assert.equal(V.isAnimeCurrentlyWatching(saved),false);
    assert.equal(JSON.parse(run.localStorage.getItem(V.HISTORY_KEY)).at(-1).type,"review");
});

for(const failKey of [V.STORAGE_KEY,V.HISTORY_KEY,"anime_tracker_startup_pending_v1"]){
    test(`quota failure at ${failKey} cannot publish membership or lose history/undo`,()=>{
        const list=[anime("one",{currentEpisode:0,watched:0})],run=runtime(list,{failKey,autoSync:true}),before=run.localStorage.snapshot();
        assert.equal(run.api.updateProgress("one",1),false);assert.deepEqual(run.localStorage.snapshot(),before);
        assert.equal(run.api.animeList[0].currentEpisode,0);assert.equal(run.traces.mainRenders.length,0);assert.equal(run.traces.uploads.length,0);assert.equal(run.timers.size,0);
        assert.ok(run.traces.toasts.some(message=>message.includes("尚未變更")));
    });
}

test("a failed rollback retains the recovery journal and a usable original-data UI",()=>{
    const list=[anime("one",{currentEpisode:0,watched:0})],run=runtime(list,{failKey:V.HISTORY_KEY,failRollback:true});
    assert.equal(run.api.updateProgress("one",1),false);
    const startup=run.api.window.__ANIME_STARTUP_STORAGE__;
    assert.equal(startup.recoveryPending,true);assert.equal(startup.persisted,false);assert.deepEqual(clone(startup.originalList),list);
    assert.deepEqual(clone(startup.recoverySnapshot.originalList),list);assert.ok(run.localStorage.getItem("anime_tracker_startup_pending_v1"));
    assert.equal(run.traces.guardInstalled,1);assert.equal(run.api.animeList[0].currentEpisode,0);
});

test("recovery blocks direct progress calls and visibly disables both new-page progress controls",()=>{
    const run=runtime([anime()],{pending:true}),before=run.localStorage.snapshot();
    run.api.window.__ui.renderCurrentlyWatching();const markup=run.node("v11-currently-list").innerHTML;
    assert.match(markup,/data-progress-action="decrement"[^>]*disabled/);assert.match(markup,/data-progress-action="increment"[^>]*disabled/);
    assert.equal(run.api.updateProgress("one",1),false);assert.deepEqual(run.localStorage.snapshot(),before);
});

test("deferred startup retains raw export data after a successful single-progress save",()=>{
    const list=[anime("one",{watched:0,currentEpisode:0})],run=runtime(list,{deferred:true});
    assert.equal(run.api.updateProgress("one",1),true);
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__.persisted,false);
    assert.deepEqual(clone(run.api.window.__ANIME_STARTUP_STORAGE__.originalList),JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)));
});

test("successful progress reuses the existing debounce with persistedOnly and no second main save",()=>{
    const run=runtime([anime()],{autoSync:true});assert.equal(run.api.updateProgress("one",1),true);assert.equal(run.timers.size,1);
    run.flush();assert.deepEqual(run.traces.uploads,[{action:"upload",config:{persistedOnly:true}}]);
    assert.equal(run.localStorage.trace.filter(op=>op.key===V.STORAGE_KEY&&op.action==="set").length,1);
});

test("only a successfully saved cold-start category transition queues automatic raw sync",()=>{
    const saved=runtime([anime()],{autoSync:true,categoryChanged:1});assert.equal(saved.timers.size,1);saved.flush();
    assert.deepEqual(saved.traces.uploads,[{action:"upload",config:{persistedOnly:true}}]);
    assert.equal(saved.localStorage.trace.filter(op=>op.key===V.STORAGE_KEY).length,0);
    for(const options of [{autoSync:true,categoryChanged:0},{autoSync:true,categoryChanged:1,deferred:true},{autoSync:false,categoryChanged:1}])assert.equal(runtime([anime()],options).timers.size,0);
});

test("all category controls and statistics distinguish broadcast watching from current viewing",()=>{
    const run=runtime();const options=run.api.window.__ui.animeCategoryOptions("watching");
    assert.match(options,/<option value="watching" selected>正在連載<\/option>/);assert.equal(run.api.animeList.length,0);
    assert.match(ui,/\["正在連載",s\.watching\],\["正在看",s\.currentlyWatching\]/);
    assert.match(ui,/<select name="category">\$\{animeCategoryOptions\(item.category\)\}<\/select>/);
    assert.match(ui,/id="v11-batch-category"/);assert.doesNotMatch(ui,/<option value="watching">正在看<\/option>/);
});

test("mobile card controls retain touch targets and source IDs containing dollar replacement syntax",()=>{
    const run=runtime([anime("safe-$&",{currentEpisode:1})]);run.api.window.__ui.renderCurrentlyWatching();
    const markup=run.node("v11-currently-list").innerHTML;
    assert.match(markup,/data-anime-id="safe-\$&amp;"/);assert.equal((markup.match(/data-progress-action="decrement"/g)||[]).length,1);
    const css=fs.readFileSync(appSourcePath("v11-styles.css"),"utf8");assert.match(css,/\.v11-currently-page \.btn-group button \{ min-height:44px/);assert.match(css,/@media\(max-width:480px\)\{\.v11-currently-card/);
});

test("progress saves the latest persisted raw rows without leaking display defaults or unrelated stale edits",()=>{
    const list=[anime("one",{watched:0,currentEpisode:0}),anime("two",{watched:0,currentEpisode:0})];
    for(const item of list)delete item.aliases;
    const run=runtime(list),latest=clone(list);latest[1].notes="newer persisted note";
    run.localStorage.setItem(V.STORAGE_KEY,JSON.stringify(latest));run.localStorage.trace.length=0;
    assert.equal(run.api.updateProgress("one",1),true);
    const saved=JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    assert.equal(Object.hasOwn(saved[0],"aliases"),false);assert.deepEqual(saved[1],latest[1]);
    assert.equal(saved[0].nextEpisodeAt,list[0].nextEpisodeAt);assert.equal(saved[0].rating,list[0].rating);
});

test("malformed persisted history blocks progress before any partial main save",()=>{
    const list=[anime("one",{watched:0,currentEpisode:0})],run=runtime(list,{seed:{[V.HISTORY_KEY]:"{}"}}),before=run.localStorage.snapshot();
    assert.equal(run.api.updateProgress("one",1),false);assert.deepEqual(run.localStorage.snapshot(),before);assert.deepEqual(run.localStorage.trace,[]);
});

test("a replaced external identity cannot be incremented through an old card with the same local ID",()=>{
    const run=runtime([anime()]);run.localStorage.setItem(V.STORAGE_KEY,JSON.stringify([anime("one",{anilistId:999})]));run.localStorage.trace.length=0;
    assert.equal(run.api.updateProgress("one",1),false);assert.deepEqual(run.localStorage.trace,[]);assert.equal(run.api.animeList[0].currentEpisode,1);
});

test("rendered stats show distinct current-viewing and broadcast-category counts",()=>{
    const run=runtime([anime(),anime("two",{watched:0,currentEpisode:0}),anime("finished",{category:"backlog"})]);
    run.api.window.__ui.renderCurrentlyWatching();run.api.updateProgress("two",1);
    const stats=run.node("v11-stats").innerHTML;
    assert.match(stats,/正在連載<strong[^>]*>2<\/strong>/);assert.match(stats,/正在看<strong[^>]*>3<\/strong>/);
});

test("two active seasons sharing a legacy local ID cannot increment whichever record appears first",()=>{
    const list=[anime("same",{anilistId:101}),anime("same",{anilistId:202,title:"Synthetic second season"})];
    const run=runtime(list),before=run.localStorage.snapshot();
    assert.equal(run.api.updateProgress("same",1),false);
    assert.deepEqual(run.localStorage.snapshot(),before);assert.deepEqual(run.localStorage.trace,[]);
    assert.equal(run.api.animeList[0].currentEpisode,1);assert.equal(run.api.animeList[1].currentEpisode,1);
});

test("a collision only in the latest persisted list is rejected without saving or publishing progress",()=>{
    const run=runtime([anime()]);
    run.localStorage.setItem(V.STORAGE_KEY,JSON.stringify([anime(),anime("one",{anilistId:202})]));run.localStorage.trace.length=0;
    const before=run.localStorage.snapshot();assert.equal(run.api.updateProgress("one",1),false);
    assert.deepEqual(run.localStorage.snapshot(),before);assert.deepEqual(run.localStorage.trace,[]);assert.equal(run.api.animeList[0].currentEpisode,1);
});

test("a category-only tombstone cannot be incremented even when deletedAt is missing",()=>{
    const run=runtime([anime("one",{category:"_deleted"})]),before=run.localStorage.snapshot();
    assert.equal(run.api.updateProgress("one",1),false);assert.deepEqual(run.localStorage.snapshot(),before);assert.deepEqual(run.localStorage.trace,[]);
});

for(const badHistory of [[null],[7],[[]]]){
    test(`unsafe history entry ${JSON.stringify(badHistory)} blocks a progress save`,()=>{
        const run=runtime([anime()],{seed:{[V.HISTORY_KEY]:JSON.stringify(badHistory)}}),before=run.localStorage.snapshot();
        assert.equal(run.api.updateProgress("one",1),false);assert.deepEqual(run.localStorage.snapshot(),before);assert.deepEqual(run.localStorage.trace,[]);
    });
}
