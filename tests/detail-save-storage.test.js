"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");
const root = path.resolve(__dirname, "..");
const ui = fs.readFileSync(path.join(root, "v11-ui.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const at = "2026-11-08T01:00:00.000Z";

function productionFunction(source, name, indent = "") {
    const start = source.indexOf(`${indent}function ${name}(`);
    assert.ok(start >= 0, `Missing production function ${name}`);
    if (name === "requestAnimeAutoSync") return source.slice(start, source.indexOf("    window.requestAnimeAutoSync =", start));
    const firstLine = source.slice(start, source.indexOf("\n", start));
    if (firstLine.includes("}") && !firstLine.trimEnd().endsWith("{")) return firstLine;
    const boundary = new RegExp(`\\n${indent}(?:async )?function `, "g");
    boundary.lastIndex = start;
    const next = boundary.exec(source);
    assert.ok(next, `Missing production boundary after ${name}`);
    return source.slice(start, next.index);
}

function anime(id = "one", extra = {}) {
    return { id, anilistId:id === "two" ? 202 : 101, title:`Synthetic detail ${id}`, aliases:[], tags:[],
        category:"watching", categorySource:"automatic", categoryManuallyEdited:false,
        currentEpisode:5, watched:5, totalEpisodes:12, episodes:12, status:"RELEASING",
        notes:"preserved long note", note:"different legacy note", rating:8,
        platform:"platform one", customPlatform:"different legacy platform", season:"FALL", year:2026,
        broadcastDay:"星期五", broadcastTime:"23:30", synopsis:"preserved synopsis",
        nextEpisodeAt:"2026-12-01T12:00:30.000Z", nextSeasonDate:null, reminderEnabled:false,
        createdAt:at, updatedAt:at, lastWatchedAt:at, seriesKey:"synthetic-series",
        reviewWatched:3, reviewSessionActive:false, reviewStartedAt:at, reviewCompletedAt:at,
        userExtension:{ arbitrary:["preserved"] }, ...extra };
}

function runtime(list = [anime()], options = {}) {
    const initialHistory = options.history || [{ id:"synthetic-prior", animeId:"one", delta:5, episode:5, at, arbitrary:"preserved" }];
    const data = new Map(Object.entries({
        [V.STORAGE_KEY]:JSON.stringify(list), [V.HISTORY_KEY]:JSON.stringify(initialHistory),
        anime_tracker_last_undo_v11:'{"retained":"undo"}', anime_theme_last_undo_v1:'{"retained":"theme undo"}',
        anime_tracker_restore_points_v1:'[{"retained":"backup"}]', unrelated:"preserved",
        ...(options.autoSync ? { anime_tracker_auto_sync_v11:"1" } : {}), ...(options.seed || {})
    }));
    const writes = [], nodes = new Map(), timers = new Map();
    const traces = { toasts:[], warnings:[], renders:[], uploads:[], closed:0, guards:0, notes:[] };
    const controls = new Map();
    const memory = clone(options.memory || list);
    const item = memory.find(row => row.id === (options.targetId || "one")) || memory[0];
    const textList = value => Array.isArray(value) ? value.join("、") : typeof value === "string" ? value : "";
    for (const [key, value] of Object.entries({
        title:item?.title, aliases:textList(item?.aliases), tags:textList(item?.tags), synopsis:item?.synopsis,
        category:item?.category, currentEpisode:item?.currentEpisode, totalEpisodes:item?.totalEpisodes || "",
        platform:item?.platform, year:item?.year || "", season:item?.season, rating:item?.rating ?? "",
        broadcastDay:item?.broadcastDay, broadcastTime:item?.broadcastTime,
        nextEpisodeAt:item?.nextEpisodeAt?.slice(0, 16) || "", nextSeasonDate:item?.nextSeasonDate || "", notes:item?.notes
    })) controls.set(key, { value:value === undefined ? "" : String(value), disabled:false, readOnly:false });
    controls.set("reminderEnabled", { value:"on", type:"checkbox", checked:!!item?.reminderEnabled, disabled:false });
    const form = {
        dataset:{ id:options.targetId || "one" },
        elements:{ namedItem:key => controls.get(key) },
        addEventListener() {},
        querySelector:() => ({ before:note => traces.notes.push(note.textContent) })
    };
    class TestFormData {
        constructor(target) {
            assert.equal(target, form);
            this.values = new Map([...controls].filter(([, control]) => !control.disabled && (control.type !== "checkbox" || control.checked)).map(([key, control]) => [key, control.value]));
        }
        get(key) { return this.values.get(key) ?? null; }
        [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    }
    const localStorage = {
        getItem:key => data.get(key) ?? null,
        setItem(key, value) {
            writes.push({ action:"set", key, value:String(value) });
            if (key === options.failKey) throw new DOMException("Synthetic storage capacity exhausted", "QuotaExceededError");
            data.set(key, String(value));
        },
        removeItem(key) { writes.push({ action:"remove", key }); data.delete(key); },
        snapshot:() => Object.fromEntries(data)
    };
    const node = id => {
        if (id === "v11-detail-form") return form;
        if (!nodes.has(id)) nodes.set(id, { innerHTML:"", textContent:"", hidden:true });
        return nodes.get(id);
    };
    const context = vm.createContext({
        V, AnimeTrackerV11:V, STORAGE_KEY:V.STORAGE_KEY, animeList:memory,
        EVENT_OVERRIDES_KEY:"anime_event_overrides_v10", EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11",
        watchHistory:clone(initialHistory), eventList:[], eventArchive:[], detailEditSessions:new WeakMap(),
        localStorage, FormData:TestFormData, autoSyncTimer:null,
        window:{ __ANIME_STARTUP_STORAGE__:{ persisted:!options.deferred, recoveryPending:!!options.pending, originalList:clone(list), warnings:[] } },
        document:{ getElementById:node, createElement:() => ({ className:"", textContent:"" }) },
        safeUrl:() => null, animeCategoryOptions:() => "", escapeHtml:value => String(value ?? ""),
        matchingAnime:() => [], themeSongsApi:() => null,
        console:{ warn:(...args) => traces.warnings.push(args) },
        showToast:message => traces.toasts.push(message),
        renderList:() => traces.renders.push({ kind:"main", memory:clone(context.animeList), stored:JSON.parse(localStorage.getItem(V.STORAGE_KEY)) }),
        refreshV11:() => traces.renders.push({ kind:"refresh", memory:clone(context.animeList), stored:JSON.parse(localStorage.getItem(V.STORAGE_KEY)) }),
        closeV11Modals:() => { traces.closed++; },
        installAnimeStartupRecoveryGuard:() => { traces.guards++; },
        setTimeout:callback => { const id=Symbol(); timers.set(id, callback); return id; },
        clearTimeout:id => timers.delete(id),
        handleSync:(action, config) => traces.uploads.push({ action, config:clone(config) })
    });
    context.window.assertAnimeStartupWritable = () => { if (context.window.__ANIME_STARTUP_STORAGE__.recoveryPending) throw Error("Recovery pending"); };
    context.window.warnAnimeStartupStorage = (...args) => traces.warnings.push(args);
    vm.runInContext(["restoreAnimeStartupStorage", "commitAnimeStartupChanges"].map(name => productionFunction(html, name)).join("\n"), context);
    vm.runInContext(["requestAnimeAutoSync", "openAnimeDetail", "saveDetail"].map(name => productionFunction(ui, name, "    ")).join("\n"), context);
    context.openAnimeDetail(form.dataset.id);
    if (options.writerError) context.commitAnimeStartupChanges = () => { throw Error("Synthetic safe writer/journal failure"); };
    if (options.missingWriter) context.commitAnimeStartupChanges = undefined;
    writes.length = 0;
    return {
        api:context, form, controls, localStorage, writes, traces, timers, data, node,
        set:(key, value) => { controls.get(key).value = String(value); },
        save:() => context.saveDetail({ currentTarget:form, preventDefault() {} }),
        flush:() => { for (const [id, fn] of timers) { timers.delete(id); fn(); } }
    };
}

test("actual detail form 5/12 to 12/12 persists only the target and then publishes completed UI", () => {
    const list = [anime(), anime("two", { currentEpisode:0, watched:0 }), anime("deleted", { deletedAt:at, category:"_deleted" })];
    const run = runtime(list, { autoSync:true }), original = run.localStorage.snapshot();
    run.set("currentEpisode", 12);
    assert.equal(run.save(), true);
    const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    assert.equal(saved[0].category, "completed");
    assert.equal(saved[0].currentEpisode, 12);
    assert.deepEqual(saved.slice(1), list.slice(1));
    for (const key of Object.keys(original).filter(key => key !== V.STORAGE_KEY)) assert.equal(run.localStorage.getItem(key), original[key]);
    assert.deepEqual(run.writes.map(write => write.key), [V.STORAGE_KEY], "A correction never writes history, backup, undo or a recovery journal");
    assert.ok(run.traces.renders.every(render => render.memory[0].category === "completed" && render.stored[0].category === "completed"));
    assert.equal(run.traces.closed, 1);
    assert.equal(run.timers.size, 1);
    run.flush();
    assert.deepEqual(run.traces.uploads, [{ action:"upload", config:{ persistedOnly:true } }]);
});

test("actual detail form 0/12 to 5/12 derives currently-watching membership without a separate stored flag", () => {
    const run = runtime([anime("one", { currentEpisode:0, watched:0 })]);
    run.set("currentEpisode", 5);
    assert.equal(run.save(), true);
    const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0];
    assert.equal(V.isAnimeCurrentlyWatching(saved), true);
    assert.equal(saved.category, "watching");
    assert.equal(Object.hasOwn(saved, "currentlyWatching"), false);
});

for (const options of [{ failKey:V.STORAGE_KEY }, { writerError:true }, { missingWriter:true }]) {
    test(`detail storage failure cannot publish progress, success, sync or lose original data: ${JSON.stringify(options)}`, () => {
        const list = [anime(), anime("two")], run = runtime(list, { ...options, autoSync:true });
        const before = run.localStorage.snapshot(), memory = clone(run.api.animeList);
        run.set("currentEpisode", 12);
        assert.equal(run.save(), false);
        assert.deepEqual(run.localStorage.snapshot(), before);
        assert.deepEqual(clone(run.api.animeList), memory);
        assert.equal(run.traces.renders.length, 0);
        assert.equal(run.traces.closed, 0);
        assert.equal(run.timers.size, 0);
        assert.ok(run.traces.toasts.every(message => !message.includes("詳細資料已儲存")));
        assert.ok(run.traces.toasts.some(message => message.includes("尚未儲存")));
    });
}

test("detail correction needs no new history or journal write when those keys cannot accept writes", () => {
    for (const failKey of [V.HISTORY_KEY, "anime_tracker_startup_pending_v1"]) {
        const run = runtime([anime()], { failKey }), before = run.localStorage.snapshot();
        run.set("currentEpisode", 12);
        assert.equal(run.save(), true);
        assert.equal(run.localStorage.getItem(V.HISTORY_KEY), before[V.HISTORY_KEY]);
        assert.deepEqual(run.writes.map(write => write.key), [V.STORAGE_KEY]);
    }
});

test("failed detail save can reload the original data and retry successfully without losing history", () => {
    const list = [anime()], failed = runtime(list, { failKey:V.STORAGE_KEY });
    const before = failed.localStorage.snapshot();
    failed.set("currentEpisode", 12);
    assert.equal(failed.save(), false);
    const reloaded = runtime(JSON.parse(failed.localStorage.getItem(V.STORAGE_KEY)), { seed:failed.localStorage.snapshot() });
    assert.equal(reloaded.api.animeList[0].currentEpisode, 5);
    reloaded.set("currentEpisode", 12);
    assert.equal(reloaded.save(), true);
    const backup = V.createBackup({ animeList:JSON.parse(reloaded.localStorage.getItem(V.STORAGE_KEY)), watchHistory:JSON.parse(reloaded.localStorage.getItem(V.HISTORY_KEY)), works:[] }, { preserveStoredRecords:true });
    assert.equal(backup[V.STORAGE_KEY][0].category, "completed");
    assert.deepEqual(backup.watchHistory, JSON.parse(before[V.HISTORY_KEY]));
});

for (const rawHistory of ["{bad json", "{}", "[null]", "[[]]", '["bad record"]']) {
    test(`invalid persisted history blocks detail edits safely: ${rawHistory}`, () => {
        const run = runtime([anime()], { seed:{ [V.HISTORY_KEY]:rawHistory } }), before = run.localStorage.snapshot();
        run.set("currentEpisode", 12);
        assert.equal(run.save(), false);
        assert.deepEqual(run.localStorage.snapshot(), before);
        assert.equal(run.writes.length, 0);
        assert.equal(run.api.animeList[0].currentEpisode, 5);
    });
}

test("a cloud or other-tab update after form opening cannot be overwritten by a stale detail form", () => {
    const run = runtime(), newer = anime("one", { notes:"newer other-device note", updatedAt:"2026-11-09T00:00:00.000Z" });
    run.data.set(V.STORAGE_KEY, JSON.stringify([newer]));
    const before = run.localStorage.snapshot();
    run.set("currentEpisode", 12);
    assert.equal(run.save(), false);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.equal(run.writes.length, 0);
    assert.ok(run.traces.toasts.some(message => message.includes("作品已更新")));
});

test("a deleted target or ambiguous duplicate IDs cannot be modified through an already-open form", () => {
    for (const next of [[anime("one", { category:"_deleted", deletedAt:at })], [anime(), anime()]]) {
        const run = runtime();
        run.data.set(V.STORAGE_KEY, JSON.stringify(next));
        const before = run.localStorage.snapshot();
        run.set("currentEpisode", 12);
        assert.equal(run.save(), false);
        assert.deepEqual(run.localStorage.snapshot(), before);
        assert.equal(run.writes.length, 0);
    }
});

test("recovery-pending keeps detail viewing available but blocks all attempted saves", () => {
    const run = runtime([anime()], { pending:true, autoSync:true }), before = run.localStorage.snapshot();
    assert.ok(run.api.detailEditSessions.get(run.form), "Read-only original-data viewing can still open the form");
    run.set("currentEpisode", 12);
    assert.equal(run.save(), false);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.equal(run.writes.length, 0);
    assert.equal(run.traces.renders.length, 0);
    assert.equal(run.traces.guards, 1);
    assert.equal(run.timers.size, 0);
});

test("only touched note fields are patched; raw aliases, times and unrelated records are not normalized", () => {
    const raw = anime("one", { currentEpisode:5, watched:2, totalEpisodes:0, episodes:12, notes:undefined, note:"legacy raw note", categorySource:undefined, categoryManuallyEdited:undefined });
    const list = clone([raw, { id:"raw-sibling", arbitrary:"untouched" }, { id:"raw-tombstone", category:"_deleted", deletedAt:at, arbitrary:"untouched" }]);
    const memory = [anime("one", { ...list[0], totalEpisodes:12, notes:"legacy raw note" }), ...list.slice(1)];
    const run = runtime(list, { memory });
    run.set("notes", "explicit new note");
    assert.equal(run.save(), true);
    const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    const expected = { ...list[0], notes:"explicit new note", note:"explicit new note", updatedAt:saved[0].updatedAt };
    assert.deepEqual(saved[0], expected);
    assert.deepEqual(saved.slice(1), list.slice(1));
    assert.equal(saved[0].nextEpisodeAt, raw.nextEpisodeAt, "An unedited minute-precision control cannot truncate stored seconds");
    assert.equal(saved[0].categorySource, undefined);
});

test("an unchanged form does not persist, claim ownership, or normalize any legacy aliases", () => {
    const list = [anime("one", { currentEpisode:12, watched:2, totalEpisodes:0, episodes:12, categorySource:undefined, categoryManuallyEdited:undefined })];
    const run = runtime(list), before = run.localStorage.snapshot();
    assert.equal(run.save(), false);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.equal(run.writes.length, 0);
    assert.ok(run.traces.toasts.includes("詳細資料沒有變更"));
});

test("manual classification stays protected while an explicit new category records ownership", () => {
    for (const manual of [{ categorySource:"manual", categoryManuallyEdited:false }, { categorySource:"automatic", categoryManuallyEdited:true }]) {
        const run = runtime([anime("one", { category:"backlog", ...manual })]);
        run.set("currentEpisode", 12);
        assert.equal(run.save(), true);
        assert.equal(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0].category, "backlog");
    }
    const explicit = runtime([anime("one", { category:"backlog", categorySource:"manual", categoryManuallyEdited:true })]);
    explicit.set("category", "completed");
    assert.equal(explicit.save(), true);
    const saved = JSON.parse(explicit.localStorage.getItem(V.STORAGE_KEY))[0];
    assert.equal(saved.category, "completed");
    assert.equal(saved.categorySource, "manual");
    assert.equal(saved.categoryManuallyEdited, true);
    assert.equal(saved.currentEpisode, 5);
});

test("review form protects category and normal progress while retaining editable notes and review metadata", () => {
    const original = anime("one", { category:"review", reviewSessionActive:true, currentEpisode:12, watched:12 });
    const run = runtime([original]);
    assert.equal(run.controls.get("category").disabled, true);
    assert.equal(run.controls.get("currentEpisode").readOnly, true);
    assert.equal(run.controls.get("totalEpisodes").readOnly, true);
    assert.ok(run.traces.notes.some(message => message.includes("不變更正常觀看進度與分類")));
    run.set("currentEpisode", 1);
    run.set("totalEpisodes", 24);
    run.set("notes", "review note correction");
    assert.equal(run.save(), true);
    const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0];
    assert.deepEqual(saved, { ...original, notes:"review note correction", note:"review note correction", updatedAt:saved.updatedAt });
});

test("deferred startup retains a raw backup view after successful detail correction", () => {
    const run = runtime([anime()], { deferred:true });
    run.set("currentEpisode", 12);
    assert.equal(run.save(), true);
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__.persisted, false);
    assert.deepEqual(clone(run.api.window.__ANIME_STARTUP_STORAGE__.originalList), JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)));
});

for (const [aliases, tags] of [[null, null], ["Synthetic legacy alias", "Synthetic legacy tag"]]) {
    test(`raw legacy aliases/tags remain readable after saving and reopening details: ${JSON.stringify([aliases, tags])}`, () => {
        const raw = anime("one", { aliases, tags });
        const run = runtime([raw], { memory:[V.migrateAnime(raw)] });
        run.set("notes", "explicit updated note");
        assert.equal(run.save(), true);
        const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0];
        assert.equal(saved.aliases, aliases);
        assert.equal(saved.tags, tags);
        const before = run.localStorage.snapshot();
        run.writes.length = 0;
        assert.doesNotThrow(() => run.api.openAnimeDetail("one"));
        const markup = run.node("v11-detail-body").innerHTML;
        assert.ok(markup.includes(`name="aliases" value="${aliases ?? ""}"`));
        assert.ok(markup.includes(`name="tags" value="${tags ?? ""}"`));
        assert.deepEqual(run.localStorage.snapshot(), before);
        assert.equal(run.writes.length, 0, "Reopening a legacy record never normalizes persistent fields");
    });
}
