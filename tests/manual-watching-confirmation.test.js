"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const at = "2026-10-08T13:00:00.000Z";
const before = "2026-10-01T00:00:00.000Z";
const copy = value => JSON.parse(JSON.stringify(value));

function between(start, end) {
    const first = html.indexOf(start), last = html.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
    return html.slice(first, last);
}

function productionFunction(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing production function: ${name}`);
    const following = /\n(?:async )?function /g;
    following.lastIndex = start;
    const match = following.exec(html);
    assert.ok(match, `Missing production function boundary after ${name}`);
    return html.slice(start, match.index);
}

// Exercise the actual single-record handler, automatic-category policy and card
// renderer. Browser confirmation/storage/render callbacks are observable I/O.
// The raw legacy fixtures deliberately bypass migrations in the action harness.
const production = [
    between("function stripDisplayYear", "async function searchWikipedia"),
    between("function normalizeAnimeAliasList", "function deriveAliasVariants"),
    between("function getAniListMediaId", "function getMediaIdentityTitles"),
    between("function normalizeStreamingLinks", "function buildAnimeRecordFromMedia"),
    productionFunction("escapeHtml"),
    productionFunction("assertAnimeStartupWritable"),
    productionFunction("formatAiringDateTime"),
    productionFunction("confirmAnimeWatching"),
    between("function getAnimeTitlePresentation", "function normalizeAnimeSearchText")
].join("\n");

const actionSelector = "[data-confirm-anime-watching]";
const delegateBody = html.indexOf(`const button = event.target.closest("${actionSelector}")`);
assert.ok(delegateBody >= 0, "Missing production confirmation click delegate");
const delegateStart = html.lastIndexOf('document.addEventListener("click"', delegateBody);
const delegateEnd = html.indexOf("\n});", delegateBody) + "\n});".length;
assert.ok(delegateStart >= 0 && delegateEnd > delegateBody, "Missing production confirmation delegate boundary");
const productionDelegate = html.slice(delegateStart, delegateEnd);

function legacy(identity = 101, extra = {}) {
    const title = `通用確認作品 ${identity}`;
    return {
        id:`local-${identity}`, anilistId:identity, source:"anilist", sourceId:String(identity),
        title, displayTitle:title, canonicalTitle:title, groupTitle:title,
        titleSource:"manual", titleManuallyEdited:true, aliases:[title],
        category:"waiting", format:"TV", status:"RELEASING", episodes:12,
        releasedEpisodes:1, nextEpisode:2, nextAiringAt:Date.parse(at) / 1000 + 6960,
        startDate:{ year:2026, month:10, day:1 }, airDate:"2026年10月",
        // These inconsistent progress fields are deliberate: confirmation must
        // preserve stored values instead of invoking a general normalization.
        watched:2, currentEpisode:7, progress:0.125, reviewWatched:4,
        reviewSessionActive:true, reviewStartedAt:before, reviewCompletedAt:null,
        rating:8.5, note:"保留短筆記", notes:"保留完整筆記", customPlatform:"原本的平台",
        createdAt:before, addedAt:before, updatedAt:before, lastWatchedAt:before,
        lastMetadataSync:before, trackingLifecycleResetAt:before,
        customField:{ deeply:[{ retained:true }] },
        ...extra
    };
}

function storage(list, options = {}) {
    const data = new Map(Object.entries({
        [V.STORAGE_KEY]:JSON.stringify(list),
        [V.HISTORY_KEY]:JSON.stringify([{ id:"history", animeId:"local-101", delta:2, at:before }]),
        [V.MANGA_HISTORY_KEY]:JSON.stringify([{ id:"manga-history", workId:"other", delta:1 }]),
        [V.WORKS_KEY]:JSON.stringify([{ workId:"other", title:"另一本作品", mediaEntries:[] }]),
        [V.RESTORE_KEY]:JSON.stringify([{ id:"backup", data:{ animeList:[{ retained:true }] } }]),
        [V.WATCH_RESET_UNDO_KEY]:JSON.stringify({ history:[{ id:"past", delta:3 }] }),
        anime_tracker_last_undo_v11:JSON.stringify({ type:"delete", targetId:"deleted", before:{ retained:true } }),
        anime_theme_last_undo_v1:JSON.stringify({ animeId:"other", before:{ retained:true } }),
        anime_theme_lookup_cache_v1:JSON.stringify({ "source:other":{ title:"OP" } }),
        anime_event_overrides_v10:JSON.stringify({ event:{ includeAnimeIds:["local-101"] } }),
        anime_event_anime_overrides_v11:JSON.stringify({ event:{ includeAnimeIds:["local-101"] } }),
        unrelated_user_data:"must preserve exact bytes"
    }));
    const operations = [];
    return {
        operations,
        getItem:key => data.get(String(key)) ?? null,
        setItem(key, value) {
            key = String(key); value = String(value);
            operations.push({ kind:"set", key, value });
            const next = new Map(data); next.set(key, value);
            const bytes = [...next].reduce((total, [k, v]) => total + 2 * (k.length + v.length), 0);
            if (options.failKey === key || bytes > (options.limit ?? Infinity)) throw new DOMException("Quota exceeded", "QuotaExceededError");
            data.set(key, value);
        },
        removeItem:key => { operations.push({ kind:"remove", key:String(key) }); data.delete(String(key)); },
        clear:() => { operations.push({ kind:"clear" }); data.clear(); },
        snapshot:() => Object.fromEntries(data)
    };
}

function runtime(list = [legacy()], options = {}) {
    const localStorage = options.storage || storage(list, options);
    const trace = { confirms:[], toasts:[], warnings:[], errors:[], renders:[], refreshes:[], clickHandlers:[], uploads:[], clients:0 };
    const timers = new Map();
    const migratedCalls = [];
    const guardedV = { ...V, migrateList:() => { migratedCalls.push("migrateList"); throw new Error("Confirmation must not migrate unrelated records"); } };
    const context = vm.createContext({
        animeList:copy(list), STORAGE_KEY:V.STORAGE_KEY, localStorage,
        EVENT_OVERRIDES_KEY:"anime_event_overrides_v10", EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11",
        eventOverrides:{}, eventAnimeOverrides:{}, eventSettings:{}, animeListSort:"watching-first",
        AnimeTrackerV11:guardedV, window:{ AnimeTrackerV11:guardedV },
        document:{ addEventListener:(type, handler) => { if (type === "click") trace.clickHandlers.push(handler); } },
        confirm:message => {
            trace.confirms.push(message);
            if (options.onConfirm) options.onConfirm(context, localStorage);
            return options.confirm !== false;
        },
        console:{ warn:(...args) => trace.warnings.push(args), error:(...args) => trace.errors.push(args), info:() => {} },
        showToast:message => trace.toasts.push(message),
        warnAnimeStartupStorage:(...args) => trace.warnings.push(args),
        renderList:() => trace.renders.push({ memory:copy(context.animeList), stored:JSON.parse(localStorage.getItem(V.STORAGE_KEY)) }),
        refreshV11:() => trace.refreshes.push({ memory:copy(context.animeList), stored:JSON.parse(localStorage.getItem(V.STORAGE_KEY)) }),
        saveAndRender:() => { migratedCalls.push("saveAndRender"); throw new Error("Confirmation must not call general saveAndRender"); },
        Date:class extends Date {
            constructor(...args) { super(...(args.length ? args : [options.now || at])); }
            static now() { return Date.parse(options.now || at); }
        }
    });
    context.window.refreshV11 = context.refreshV11;
    vm.runInContext(production, context, { filename:"production-manual-watching-confirmation.js" });
    vm.runInContext(productionDelegate, context, { filename:"production-manual-watching-click.js" });
    if (options.recoveryPending) context.window.__ANIME_STARTUP_STORAGE__ = { persisted:false, recoveryPending:true, originalList:copy(list) };
    const syncStatus = { textContent:"" };
    if (options.enableSync) {
        if (options.autoSync !== false) localStorage.setItem("anime_tracker_auto_sync_v11", "1");
        context.document.getElementById = () => syncStatus;
        context.setTimeout = callback => { const id = Symbol(); timers.set(id, callback); return id; };
        context.clearTimeout = id => timers.delete(id);
        context.window.CrossMediaTracker = { snapshot:() => { throw Error("Confirmation sync must not migrate or persist cross-media data"); } };
        context.window.ANIME_SYNC_CONFIG = { supabaseUrl:"https://example.invalid", anonKey:"synthetic-test-key" };
        context.window.supabase = { createClient:() => {
            trace.clients++;
            return {
                auth:{ getUser:async () => { options.onGetUser?.(context); return { data:{ user:{ id:"synthetic-user" } } }; } },
                from:table => {
                    assert.equal(table, "anime_tracker_payloads");
                    return { upsert:async value => {
                        trace.uploads.push(copy(value)); options.onUpload?.(context);
                        return { error:options.uploadError || null };
                    } };
                }
            };
        } };
        const ui = fs.readFileSync(path.join(__dirname, "..", "v11-ui.js"), "utf8");
        const uiFunction = name => {
            const start = ui.search(new RegExp(`    (?:async )?function ${name}\\(`));
            assert.ok(start >= 0, `Missing UI function ${name}`);
            if (name === "requestAnimeAutoSync") return ui.slice(start, ui.indexOf("\n    window.requestAnimeAutoSync", start));
            const rest = ui.slice(start), match = /\n    (?:async )?function /.exec(rest);
            assert.ok(match, `Missing UI boundary after ${name}`);
            return rest.slice(0, match.index);
        };
        vm.runInContext(ui.slice(0, ui.indexOf("    function bootstrapAnimeStorage")) + "\n"
            + ["requestAnimeAutoSync", "syncConfigured", "renderSyncStatus", "handleSync"].map(uiFunction).join("\n")
            + "\nwindow.requestAnimeAutoSync=requestAnimeAutoSync;\n})();", context);
        localStorage.operations.length = 0;
    }
    return { api:context, localStorage, trace, migratedCalls, syncStatus, timers,
        flushSync:async () => {
            for (const [id, callback] of timers) { timers.delete(id); callback(); }
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

function expectedConfirmed(list, id) {
    return list.map(item => String(item.id) === String(id)
        ? { ...item, category:"watching", categorySource:"manual", categoryManuallyEdited:true, updatedAt:at }
        : item);
}

function successfulConfirmation(run, beforeList, id) {
    const beforeStorage = run.localStorage.snapshot();
    assert.doesNotThrow(() => run.api.confirmAnimeWatching(id));
    const expected = expectedConfirmed(beforeList, id);
    assert.deepEqual(copy(run.api.animeList), expected, "Only category, ownership and the selected record's version timestamp change");
    assert.deepEqual(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)), expected);
    assert.equal(run.trace.confirms.length, 1, "A user confirmation is required before the write");
    assert.match(run.trace.confirms[0], /watching|正在連載/u);
    assert.ok(run.trace.confirms[0].includes(beforeList.find(item => String(item.id) === String(id)).title),
        "The confirmation names the work whose category will change");
    assert.match(run.trace.confirms[0], /進度.*保留/u);
    assert.deepEqual(run.localStorage.operations.map(entry => [entry.kind, entry.key]), [["set", V.STORAGE_KEY]],
        "Only the main list is saved; undo, history, metadata and auxiliary keys are untouched");
    for (const [key, value] of Object.entries(beforeStorage)) if (key !== V.STORAGE_KEY) {
        assert.equal(run.localStorage.getItem(key), value, `${key} must retain its original bytes`);
    }
    assert.deepEqual(run.migratedCalls, []);
    assert.equal(run.trace.renders.length, 1);
    assert.equal(run.trace.refreshes.length, 1);
    for (const state of [...run.trace.renders, ...run.trace.refreshes]) {
        assert.deepEqual(state.memory, expected, "UI only publishes the saved category change");
        assert.deepEqual(state.stored, expected, "Persistence precedes rendering the success state");
    }
    assert.ok(run.trace.toasts.some(message => /watching|正在連載/u.test(message)), "Successful save gives visible feedback");
}

test("legacy waiting without ownership markers has an explicit single-record confirmation preserving every other field", () => {
    const list = [legacy()];
    assert.equal(Object.hasOwn(list[0], "categorySource"), false);
    assert.equal(Object.hasOwn(list[0], "categoryManuallyEdited"), false);
    successfulConfirmation(runtime(list), list, list[0].id);
});

test("confirmation changes only the selected anime and preserves other records, tombstones, history and undo bytes", () => {
    const list = [legacy(), legacy(202, { category:"watching" }), legacy(303),
        legacy(404, { category:"_deleted", deletedAt:before, deletedFromCategory:"waiting" })];
    const run = runtime(list);
    successfulConfirmation(run, list, "local-303");
    for (const original of list.filter(item => item.id !== "local-303")) {
        assert.equal(JSON.stringify(run.api.animeList.find(item => item.id === original.id)), JSON.stringify(original));
    }
    assert.equal(Object.hasOwn(run.api.animeList[0], "categorySource"), false, "Unselected legacy ownership is not guessed");
});

for (const [label, ownership] of [
    ["unknown markers", { categorySource:"legacy-import", categoryManuallyEdited:null }],
    ["partial markers", { categorySource:"automatic" }],
    ["explicit automatic", { categorySource:"automatic", categoryManuallyEdited:false }],
    ["explicit manual waiting", { categorySource:"manual", categoryManuallyEdited:true }]
]) {
    test(`${label}: confirmation respects existing ownership and changes only the eligible legacy record`, () => {
        const list = [legacy(101, ownership)];
        const run = runtime(list);
        if (label.startsWith("explicit")) {
            assert.equal(run.api.confirmAnimeWatching("local-101"), false);
            assert.deepEqual(copy(run.api.animeList), list);
            assert.deepEqual(run.localStorage.operations, []);
            assert.equal(run.trace.confirms.length, 0);
        } else successfulConfirmation(run, list, "local-101");
    });
}

test("cancelling the confirmation performs zero writes and retains memory, history and UI", () => {
    const list = [legacy()], run = runtime(list, { confirm:false }), beforeStorage = run.localStorage.snapshot();
    assert.doesNotThrow(() => run.api.confirmAnimeWatching("local-101"));
    assert.equal(run.trace.confirms.length, 1);
    assert.deepEqual(copy(run.api.animeList), list);
    assert.deepEqual(run.localStorage.snapshot(), beforeStorage);
    assert.deepEqual(run.localStorage.operations, []);
    assert.deepEqual(run.trace.renders, []);
    assert.deepEqual(run.trace.refreshes, []);
    assert.deepEqual(run.trace.toasts, []);
});

test("main-list quota failure gives a warning without publishing success or mutating memory/auxiliary data", () => {
    const list = [legacy(), legacy(202)], run = runtime(list, { failKey:V.STORAGE_KEY });
    const beforeStorage = run.localStorage.snapshot();
    assert.doesNotThrow(() => run.api.confirmAnimeWatching("local-101"));
    assert.equal(run.trace.confirms.length, 1);
    assert.deepEqual(copy(run.api.animeList), list);
    assert.deepEqual(run.localStorage.snapshot(), beforeStorage);
    assert.deepEqual(run.localStorage.operations.map(entry => [entry.kind, entry.key]), [["set", V.STORAGE_KEY]]);
    assert.deepEqual(run.trace.renders, []);
    assert.deepEqual(run.trace.refreshes, []);
    assert.ok(run.trace.toasts.some(message => /未|失敗|不足|无法|無法/u.test(message)), "Failed persistence shows a warning");
    assert.ok(run.trace.toasts.every(message => !/已移至|已移到|已開始|成功/u.test(message)), "Failure cannot claim the action succeeded");
    assert.deepEqual(run.migratedCalls, []);
    const refreshed = runtime(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)), { storage:run.localStorage });
    assert.deepEqual(copy(refreshed.api.animeList), list, "Refreshing after the failure reloads exact original data");
});

for (const [label, list, id] of [
    ["unknown local ID", [legacy()], "missing"],
    ["deleted waiting", [legacy(101, { deletedAt:before })], "local-101"],
    ["non-waiting", [legacy(101, { category:"review" })], "local-101"],
    ["unknown airing evidence", [legacy(101, { status:"", startDate:{}, releasedEpisodes:null, nextEpisode:null })], "local-101"],
    ["not yet aired", [legacy(101, { status:"NOT_YET_RELEASED", startDate:{ year:2027, month:1, day:1 }, releasedEpisodes:0, nextEpisode:1 })], "local-101"],
    ["ambiguous local ID", [legacy(), legacy(202, { id:"local-101" })], "local-101"]
]) {
    test(`${label} cannot confirm an unintended record or create a saved success state`, () => {
        const run = runtime(list), beforeStorage = run.localStorage.snapshot();
        assert.doesNotThrow(() => run.api.confirmAnimeWatching(id));
        assert.deepEqual(copy(run.api.animeList), list);
        assert.deepEqual(run.localStorage.snapshot(), beforeStorage);
        assert.deepEqual(run.localStorage.operations, []);
        assert.equal(run.trace.confirms.length, 0);
        assert.deepEqual(run.trace.renders, []);
        assert.deepEqual(run.trace.refreshes, []);
    });
}

test("pending startup recovery blocks confirmation before any dialog or storage mutation", () => {
    const list = [legacy()], run = runtime(list, { recoveryPending:true }), beforeStorage = run.localStorage.snapshot();
    assert.doesNotThrow(() => run.api.confirmAnimeWatching("local-101"));
    assert.deepEqual(copy(run.api.animeList), list);
    assert.deepEqual(run.localStorage.snapshot(), beforeStorage);
    assert.deepEqual(run.localStorage.operations, []);
    assert.equal(run.trace.confirms.length, 0);
    assert.deepEqual(run.trace.renders, []);
    assert.deepEqual(run.trace.refreshes, []);
    assert.ok(run.trace.warnings.length || run.trace.toasts.length, "Read-only recovery explains why confirmation was blocked");
});

test("a same-ID tombstone makes an unqualified local-ID confirmation ambiguous and preserves both records", () => {
    const list = [legacy(), legacy(202, { id:"local-101", deletedAt:before })], run = runtime(list);
    const original = run.localStorage.snapshot();
    assert.equal(run.api.confirmAnimeWatching("local-101"), false);
    assert.deepEqual(copy(run.api.animeList), list);
    assert.deepEqual(run.localStorage.snapshot(), original);
    assert.deepEqual(run.localStorage.operations, []);
    assert.equal(JSON.stringify(run.api.animeList[1]), JSON.stringify(list[1]));
    assert.equal(JSON.stringify(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[1]), JSON.stringify(list[1]));
});

test("explicit external identity selects exactly one record when a legacy local ID has a collision", () => {
    const list = [legacy(), legacy(202, { id:"local-101" }), legacy(303, { id:"local-101", deletedAt:before })];
    const run = runtime(list), beforeStorage = run.localStorage.snapshot();
    assert.equal(run.api.confirmAnimeWatching("local-101", "202"), true);
    const expected = copy(list);
    expected[1] = { ...expected[1], category:"watching", categorySource:"manual", categoryManuallyEdited:true, updatedAt:at };
    assert.deepEqual(copy(run.api.animeList), expected);
    assert.deepEqual(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)), expected);
    assert.equal(JSON.stringify(run.api.animeList[0]), JSON.stringify(list[0]));
    assert.equal(JSON.stringify(run.api.animeList[2]), JSON.stringify(list[2]));
    for (const [key, value] of Object.entries(beforeStorage)) if (key !== V.STORAGE_KEY) assert.equal(run.localStorage.getItem(key), value);
    assert.deepEqual(run.localStorage.operations.map(entry => [entry.kind, entry.key]), [["set", V.STORAGE_KEY]]);
});

for (const identity of ["999", "303"]) {
    test(`external identity ${identity} cannot select another record by local ID alone`, () => {
        const list = [legacy(), legacy(303, { id:"local-101", deletedAt:before })], run = runtime(list);
        const beforeStorage = run.localStorage.snapshot();
        assert.equal(run.api.confirmAnimeWatching("local-101", identity), false);
        assert.deepEqual(copy(run.api.animeList), list);
        assert.deepEqual(run.localStorage.snapshot(), beforeStorage);
        assert.deepEqual(run.localStorage.operations, []);
        assert.equal(run.trace.confirms.length, 0);
    });
}

for (const [label, replacement] of [
    ["deleted", item => ({ ...item, deletedAt:before })],
    ["no longer waiting", item => ({ ...item, category:"watching" })],
    ["manually kept waiting", item => ({ ...item, categorySource:"manual", categoryManuallyEdited:true })],
    ["no longer known to be airing", item => ({ ...item, status:"", startDate:{}, releasedEpisodes:null, nextEpisode:null })],
    ["different external identity", item => ({ ...item, anilistId:202, sourceId:"202" })]
]) {
    test(`a record ${label} while the dialog is open is rechecked before saving`, () => {
        const list = [legacy()], run = runtime(list, {
            onConfirm:context => { context.animeList = [replacement(context.animeList[0])]; }
        });
        const beforeStorage = run.localStorage.snapshot();
        assert.equal(run.api.confirmAnimeWatching("local-101", "101"), false);
        assert.equal(run.trace.confirms.length, 1);
        assert.deepEqual(copy(run.api.animeList), [replacement(list[0])], "Confirmation cannot undo the concurrent change");
        assert.deepEqual(run.localStorage.snapshot(), beforeStorage);
        assert.deepEqual(run.localStorage.operations, []);
        assert.deepEqual(run.trace.renders, []);
        assert.deepEqual(run.trace.refreshes, []);
    });
}

test("after successful confirmation, refresh/startup migration and future metadata cannot undo manual category ownership", () => {
    const list = [legacy()], run = runtime(list);
    successfulConfirmation(run, list, "local-101");
    const reloaded = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    const refreshed = runtime(reloaded);
    const migrated = refreshed.api.migrateExistingAnimeRecords(V.migrateList(reloaded), at).list;
    assert.equal(migrated[0].category, "watching");
    assert.equal(migrated[0].categorySource, "manual");
    assert.equal(migrated[0].categoryManuallyEdited, true);
    refreshed.api.applyMediaMetadata(migrated[0], { id:101, title:{ native:list[0].title }, status:"NOT_YET_RELEASED",
        startDate:{ year:2027, month:1, day:1 }, releasedEpisodes:0,
        nextAiringEpisode:{ episode:1, airingAt:Date.parse("2027-01-01T13:00:00.000Z") / 1000 } }, at);
    assert.equal(migrated[0].category, "watching");
    assert.equal(migrated[0].categorySource, "manual");
    assert.equal(migrated[0].categoryManuallyEdited, true);
});

test("legacy waiting remains waiting after released episode metadata until the explicit action is confirmed", () => {
    const list = [legacy()], run = runtime(list);
    run.api.applyMediaMetadata(run.api.animeList[0], { id:101, title:{ native:list[0].title }, status:"RELEASING", releasedEpisodes:1,
        nextAiringEpisode:{ episode:2, airingAt:Date.parse(at) / 1000 + 6960, timeUntilAiring:6960 } }, at);
    assert.equal(run.api.animeList[0].category, "waiting");
    assert.equal(Object.hasOwn(run.api.animeList[0], "categorySource"), false);
    assert.equal(Object.hasOwn(run.api.animeList[0], "categoryManuallyEdited"), false);
    assert.deepEqual(run.localStorage.operations, []);
    assert.equal(run.trace.confirms.length, 0);
});

test("real waiting-card renderer exposes the explicit action for generic titles and never shows it on other categories", () => {
    const run = runtime();
    for (const identity of [101, 202, 903]) {
        const record = legacy(identity), markup = run.api.buildAnimeItem(record);
        assert.match(markup, /確認已開播/u);
        assert.ok(markup.includes(`data-confirm-anime-watching="${record.id}"`), "Renderer wires the action to this local record ID");
        assert.ok(markup.includes(`data-confirm-anime-identity="${identity}"`), "Card action carries external identity for legacy ID collisions");
        assert.ok(markup.includes(record.title), "The action is available independently of the work's title");
    }
    for (const category of ["watching", "backlog", "review", "completed"]) {
        const markup = run.api.buildAnimeItem(legacy(101, { category }));
        assert.doesNotMatch(markup, /data-confirm-anime-watching|確認已開播/u);
    }
});

test("confirmation card data safely escapes a local ID containing HTML and quotation characters", () => {
    const id = `local-101'\"<>&`, run = runtime([legacy(101, { id })]);
    const markup = run.api.buildAnimeItem(run.api.animeList[0]);
    assert.ok(markup.includes('data-confirm-anime-watching="local-101&#039;&quot;&lt;&gt;&amp;"'));
    assert.doesNotMatch(markup, /onclick=['"]confirmAnimeWatching/u, "The new action does not embed user-controlled IDs as inline JavaScript");
});

test("the actual delegated waiting-card click carries identity and confirms only its selected record", () => {
    const list = [legacy(), legacy(202, { id:"local-101" })], run = runtime(list);
    assert.equal(run.trace.clickHandlers.length, 1);
    let prevented = false;
    run.trace.clickHandlers[0]({
        target:{ closest:selector => {
            assert.equal(selector, actionSelector);
            return { disabled:false, dataset:{ confirmAnimeWatching:"local-101", confirmAnimeIdentity:"202" } };
        } },
        preventDefault:() => { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.deepEqual(copy(run.api.animeList), [list[0], {
        ...list[1], category:"watching", categorySource:"manual", categoryManuallyEdited:true, updatedAt:at
    }]);
    assert.equal(run.trace.confirms.length, 1);
});

test("pending-recovery card is visibly disabled and the real click delegate refuses disabled controls", () => {
    const list = [legacy()], run = runtime(list, { recoveryPending:true });
    const markup = run.api.buildAnimeItem(run.api.animeList[0]);
    assert.match(markup, /data-confirm-anime-watching="local-101"[^>]*\bdisabled\b/u);
    run.trace.clickHandlers[0]({
        target:{ closest:() => ({ disabled:true, dataset:{ confirmAnimeWatching:"local-101", confirmAnimeIdentity:"101" } }) },
        preventDefault:() => assert.fail("Disabled confirmation cannot dispatch")
    });
    assert.deepEqual(copy(run.api.animeList), list);
    assert.deepEqual(run.localStorage.operations, []);
    assert.equal(run.trace.confirms.length, 0);
});

test("failed-startup display defaults never leak into persisted target or other raw legacy records", () => {
    const raw = [legacy(), legacy(202)];
    for (const item of raw) for (const key of ["createdAt", "addedAt", "updatedAt", "lastWatchedAt", "aliases", "customPlatform"]) delete item[key];
    const view = raw.map(item => ({ ...item, aliases:[item.title], createdAt:at, addedAt:at,
        updatedAt:at, lastWatchedAt:null, customPlatform:"display default", tags:[] }));
    const run = runtime(view, { storage:storage(raw) });
    run.api.window.__ANIME_STARTUP_STORAGE__ = { persisted:false, recoveryPending:false, originalList:copy(raw) };
    assert.equal(run.api.confirmAnimeWatching(raw[0].id), true);
    const expectedRaw = expectedConfirmed(raw, raw[0].id);
    assert.deepEqual(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)), expectedRaw);
    assert.deepEqual(copy(run.api.animeList), expectedConfirmed(view, raw[0].id));
    assert.deepEqual(copy(run.api.window.__ANIME_STARTUP_STORAGE__.originalList), expectedRaw);
    assert.equal(run.api.window.__ANIME_STARTUP_STORAGE__.persisted, false, "Single-record confirmation does not claim unrelated startup migrations completed");
    assert.equal(JSON.stringify(expectedRaw[1]), JSON.stringify(raw[1]));
    for (const key of ["createdAt", "addedAt", "lastWatchedAt"]) assert.equal(Object.hasOwn(expectedRaw[0], key), false);
    assert.equal(expectedRaw[0].updatedAt, at, "Only the confirmation's version timestamp is added");
});

test("confirmation preserves another record's newer persisted edit instead of saving unrelated stale memory", () => {
    const list = [legacy(), legacy(202)];
    const run = runtime(list, { onConfirm:(_context, localStorage) => {
        const stored = JSON.parse(localStorage.getItem(V.STORAGE_KEY));
        stored[1].notes = "newer persisted note";
        localStorage.setItem(V.STORAGE_KEY, JSON.stringify(stored));
    } });
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    assert.deepEqual(saved[0], expectedConfirmed(list, list[0].id)[0]);
    assert.deepEqual(saved[1], { ...list[1], notes:"newer persisted note" });
    assert.deepEqual(copy(run.api.animeList[1]), list[1], "The action changes only its selected memory record");
});

test("real near-capacity ownership growth leaves persisted and visible data unchanged with no success feedback", () => {
    const list = [legacy(), legacy(202)];
    const initial = storage(list).snapshot();
    const limit = Object.entries(initial).reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0);
    const run = runtime(list, { limit });
    assert.equal(run.api.confirmAnimeWatching(list[0].id), false);
    assert.deepEqual(run.localStorage.snapshot(), initial);
    assert.deepEqual(copy(run.api.animeList), list);
    assert.equal(run.trace.renders.length, 0);
    assert.equal(run.trace.refreshes.length, 0);
    assert.ok(run.trace.toasts.every(text => !/已移到|已開始|成功/u.test(text)));
});

for (const [label, value] of [["invalid JSON", "invalid-json"], ["non-array", "{}"],
    ["missing target", JSON.stringify([legacy(202)])], ["changed category", JSON.stringify([legacy(101, { category:"review" })])],
    ["manual waiting ownership", JSON.stringify([legacy(101, { categorySource:"manual", categoryManuallyEdited:true })])],
    ["missing airing evidence", JSON.stringify([legacy(101, { status:"", startDate:{}, releasedEpisodes:null, nextEpisode:null })])]]) {
    test(`unsafe persisted ${label} cannot be overwritten by classification confirmation`, () => {
        const list = [legacy()], localStorage = storage(list);
        localStorage.setItem(V.STORAGE_KEY, value);
        const run = runtime(list, { storage:localStorage }), before = localStorage.snapshot();
        const operations = localStorage.operations.length;
        assert.equal(run.api.confirmAnimeWatching(list[0].id), false);
        assert.deepEqual(localStorage.snapshot(), before);
        assert.equal(localStorage.operations.length, operations);
        assert.deepEqual(copy(run.api.animeList), list);
        assert.equal(run.trace.renders.length, 0);
    });
}

test("recovery becoming read-only while the confirmation dialog is open cannot write a success state", () => {
    const list = [legacy()];
    const run = runtime(list, { onConfirm:context => {
        context.window.__ANIME_STARTUP_STORAGE__ = { persisted:false, recoveryPending:true, originalList:copy(list) };
    } });
    const before = run.localStorage.snapshot();
    assert.equal(run.api.confirmAnimeWatching(list[0].id), false);
    assert.deepEqual(run.localStorage.snapshot(), before);
    assert.deepEqual(run.localStorage.operations, []);
    assert.deepEqual(copy(run.api.animeList), list);
});

test("real startup and v11 bootstrap preserve confirmed raw progress and timestamps across refresh", () => {
    const list = [legacy()], run = runtime(list);
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    const confirmed = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    const reloaded = runtime(confirmed, { storage:run.localStorage });
    Object.assign(reloaded.api, {
        OLD_KEYS:[], EVENT_OVERRIDES_KEY:"anime_event_overrides_v10",
        EVENT_ANIME_OVERRIDES_KEY:"anime_event_anime_overrides_v11",
        eventOverrides:{}, eventAnimeOverrides:{},
        document:{ getElementById:() => ({ hidden:true, textContent:"" }), addEventListener:() => {} }
    });
    vm.runInContext(between("function loadStoredAnime", "function saveAndRender"), reloaded.api);
    reloaded.api.loadStoredAnime();
    const ui = fs.readFileSync(path.join(__dirname, "..", "v11-ui.js"), "utf8");
    vm.runInContext(ui.slice(0, ui.indexOf("const originalSaveAndRender")) + "\n})();", reloaded.api);
    const stored = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0];
    const visible = reloaded.api.animeList[0];
    for (const key of ["watched", "currentEpisode", "progress", "reviewWatched", "rating", "notes",
        "createdAt", "addedAt", "lastWatchedAt", "lastMetadataSync", "reviewStartedAt", "trackingLifecycleResetAt"]) {
        assert.deepEqual(copy(stored[key]), copy(list[0][key]), `Persisted ${key} survives refresh`);
        assert.deepEqual(copy(visible[key]), copy(list[0][key]), `Visible ${key} survives refresh`);
    }
    assert.equal(stored.category, "watching");
    assert.equal(stored.categorySource, "manual");
    assert.equal(stored.categoryManuallyEdited, true);
    assert.equal(stored.updatedAt, at);
    assert.equal(visible.updatedAt, at);
});

test("an omitted external argument still binds the confirmation to the original known identity", () => {
    const list = [legacy()];
    const run = runtime(list, { onConfirm:(context, localStorage) => {
        context.animeList = [legacy(202, { id:list[0].id })];
        localStorage.setItem(V.STORAGE_KEY, JSON.stringify(context.animeList));
    } });
    assert.equal(run.api.confirmAnimeWatching(list[0].id), false);
    assert.equal(run.api.animeList[0].category, "waiting");
    assert.equal(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0].category, "waiting");
    assert.equal(run.localStorage.operations.length, 1, "Only the simulated replacement writes, never the stale confirmation");
    assert.equal(run.trace.renders.length, 0);
});

test("a waiting record without AniList identity can be explicitly confirmed without inventing an automatic owner", () => {
    const record = legacy();
    delete record.anilistId; delete record.source; delete record.sourceId;
    successfulConfirmation(runtime([record]), [record], record.id);
});

test("replacing an identity-less record while its dialog is open cannot confirm the replacement", () => {
    const record = legacy();
    delete record.anilistId; delete record.source; delete record.sourceId;
    const run = runtime([record], { onConfirm:context => {
        context.animeList = [{ ...record, title:"another generic waiting work" }];
    } });
    const original = run.localStorage.snapshot();
    assert.equal(run.api.confirmAnimeWatching(record.id), false);
    assert.deepEqual(run.localStorage.snapshot(), original);
    assert.deepEqual(run.localStorage.operations, []);
});

test("in-place replacement of an identity-less title cannot reuse the original confirmation", () => {
    const record = legacy();
    delete record.anilistId; delete record.source; delete record.sourceId;
    const run = runtime([record], { onConfirm:(context, localStorage) => {
        context.animeList[0].title = "another generic waiting work";
        localStorage.setItem(V.STORAGE_KEY, JSON.stringify(context.animeList));
    } });
    assert.equal(run.api.confirmAnimeWatching(record.id), false);
    assert.equal(run.api.animeList[0].category, "waiting");
    assert.equal(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY))[0].category, "waiting");
    assert.equal(run.localStorage.operations.length, 1, "Only the simulated replacement writes");
    assert.equal(run.trace.renders.length, 0);
});

test("confirmation version wins against a newer pre-confirmation cloud copy on both devices", () => {
    const list = [legacy(), legacy(202)], run = runtime(list);
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    const saved = JSON.parse(run.localStorage.getItem(V.STORAGE_KEY));
    const cloud = copy(list);
    cloud[0].updatedAt = "2026-10-07T00:00:00.000Z";
    cloud[1].notes = "newer note on the other device";
    cloud[1].updatedAt = "2026-10-07T00:00:00.000Z";
    for (const merged of [V.mergeById(saved, cloud), V.mergeById(cloud, saved)]) {
        assert.equal(merged[0].category, "watching");
        assert.equal(merged[0].categorySource, "manual");
        assert.equal(merged[0].categoryManuallyEdited, true);
        assert.equal(merged[0].updatedAt, at);
        assert.equal(merged[1].notes, cloud[1].notes, "The other record still uses its own version");
    }
    for (const merged of [V.mergeCloudPayload({ animeList:saved }, { animeList:cloud }),
        V.mergeCloudPayload({ animeList:cloud }, { animeList:saved })]) {
        assert.equal(merged.animeList[0].category, "watching");
        assert.equal(merged.animeList[0].categorySource, "manual");
        assert.equal(merged.animeList[0].categoryManuallyEdited, true);
        assert.equal(merged.animeList[0].updatedAt, at);
        assert.equal(merged.animeList[1].notes, cloud[1].notes);
    }
    assert.deepEqual(saved, expectedConfirmed(list, list[0].id));
});

test("confirmation timestamp remains strictly newer when the saved row is ahead of the device clock", () => {
    const list = [legacy(101, { updatedAt:"2026-10-20T00:00:00.000Z" }), legacy(202)];
    const run = runtime(list);
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    assert.equal(run.api.animeList[0].updatedAt, "2026-10-20T00:00:00.001Z");
    assert.deepEqual(copy(run.api.animeList[1]), list[1]);
});

test("enabled auto-sync uploads only saved raw records without extra migration or main-list persistence", async () => {
    const list = [legacy(), legacy(202)], run = runtime(list, { enableSync:true });
    const beforeStorage = run.localStorage.snapshot();
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    assert.equal(run.timers.size, 1);
    assert.equal(run.trace.uploads.length, 0);
    assert.deepEqual(run.localStorage.operations.map(op => op.key), [V.STORAGE_KEY]);
    await run.flushSync();
    assert.equal(run.trace.uploads.length, 1);
    const payload = run.trace.uploads[0].payload;
    assert.deepEqual(payload[V.STORAGE_KEY], expectedConfirmed(list, list[0].id));
    assert.deepEqual(payload.watchHistory, JSON.parse(beforeStorage[V.HISTORY_KEY]));
    assert.deepEqual(payload.works, JSON.parse(beforeStorage[V.WORKS_KEY]));
    assert.deepEqual(payload[V.MANGA_HISTORY_KEY], JSON.parse(beforeStorage[V.MANGA_HISTORY_KEY]));
    assert.deepEqual(run.localStorage.operations.map(op => op.key), [V.STORAGE_KEY, "anime_tracker_last_sync_v11"]);
    assert.deepEqual(run.migratedCalls, []);
    assert.equal(run.syncStatus.textContent, "上傳完成");
    for (const [key, value] of Object.entries(beforeStorage)) if (key !== V.STORAGE_KEY)
        assert.equal(run.localStorage.getItem(key), value, `Sync leaves original auxiliary ${key} unchanged`);
});

test("disabled auto-sync leaves confirmation local with no network or timer", async () => {
    const list = [legacy()], run = runtime(list, { enableSync:true, autoSync:false });
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    await run.flushSync();
    assert.equal(run.trace.clients, 0);
    assert.equal(run.trace.uploads.length, 0);
    assert.equal(run.timers.size, 0);
    assert.deepEqual(run.localStorage.operations.map(op => op.key), [V.STORAGE_KEY]);
});

test("failed category persistence never schedules or uploads an automatic sync", async () => {
    const list = [legacy()], run = runtime(list, { enableSync:true, failKey:V.STORAGE_KEY });
    assert.equal(run.api.confirmAnimeWatching(list[0].id), false);
    await run.flushSync();
    assert.equal(run.trace.clients, 0);
    assert.equal(run.timers.size, 0);
    assert.deepEqual(copy(run.api.animeList), list);
});

test("two confirmations reuse the existing debounce and upload both saved rows once", async () => {
    const list = [legacy(), legacy(202)], run = runtime(list, { enableSync:true });
    assert.equal(run.api.confirmAnimeWatching(list[0].id), true);
    assert.equal(run.api.confirmAnimeWatching(list[1].id), true);
    assert.equal(run.timers.size, 1);
    await run.flushSync();
    assert.equal(run.trace.uploads.length, 1);
    assert.deepEqual(run.trace.uploads[0].payload[V.STORAGE_KEY], expectedConfirmed(expectedConfirmed(list, list[0].id), list[1].id));
    assert.equal(run.localStorage.operations.filter(op => op.key === V.STORAGE_KEY).length, 2);
});

for (const label of ["recovery pending", "auto-sync disabled"]) {
    test(`a previously queued sync is skipped when ${label} before its timer fires`, async () => {
        const run = runtime([legacy()], { enableSync:true });
        assert.equal(run.api.confirmAnimeWatching("local-101"), true);
        if (label === "recovery pending") run.api.window.__ANIME_STARTUP_STORAGE__ = { recoveryPending:true };
        else run.localStorage.setItem("anime_tracker_auto_sync_v11", "0");
        const before = run.localStorage.snapshot(), count = run.localStorage.operations.length;
        await run.flushSync();
        assert.equal(run.trace.clients, 0);
        assert.deepEqual(run.localStorage.snapshot(), before);
        assert.equal(run.localStorage.operations.length, count);
    });
}

test("recovery beginning while cloud auth is awaited prevents the upload and local sync marker", async () => {
    const run = runtime([legacy()], { enableSync:true,
        onGetUser:context => { context.window.__ANIME_STARTUP_STORAGE__ = { recoveryPending:true }; } });
    assert.equal(run.api.confirmAnimeWatching("local-101"), true);
    await run.flushSync();
    assert.equal(run.trace.uploads.length, 0);
    assert.equal(run.localStorage.getItem("anime_tracker_last_sync_v11"), null);
    assert.deepEqual(run.localStorage.operations.map(op => op.key), [V.STORAGE_KEY]);
});

test("cloud upload failure preserves the local confirmation and reports sync failure without a success marker", async () => {
    const list = [legacy()], run = runtime(list, { enableSync:true, uploadError:{ message:"synthetic upload failure" } });
    assert.equal(run.api.confirmAnimeWatching("local-101"), true);
    await run.flushSync();
    assert.deepEqual(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)), expectedConfirmed(list, "local-101"));
    assert.equal(run.localStorage.getItem("anime_tracker_last_sync_v11"), null);
    assert.match(run.syncStatus.textContent, /同步失敗/u);
});

test("an upload already in flight cannot write a sync marker after recovery becomes read-only", async () => {
    const run = runtime([legacy()], { enableSync:true,
        onUpload:context => { context.window.__ANIME_STARTUP_STORAGE__ = { recoveryPending:true }; } });
    assert.equal(run.api.confirmAnimeWatching("local-101"), true);
    await run.flushSync();
    assert.equal(run.trace.uploads.length, 1);
    assert.equal(run.localStorage.getItem("anime_tracker_last_sync_v11"), null);
    assert.deepEqual(run.localStorage.operations.map(op => op.key), [V.STORAGE_KEY]);
});

test("quota failure writing the optional last-sync marker cannot undo or repeat the category save", async () => {
    const list = [legacy()], run = runtime(list, { enableSync:true, failKey:"anime_tracker_last_sync_v11" });
    assert.equal(run.api.confirmAnimeWatching("local-101"), true);
    await run.flushSync();
    assert.equal(run.trace.uploads.length, 1);
    assert.equal(run.localStorage.operations.filter(op => op.key === V.STORAGE_KEY).length, 1);
    assert.equal(run.localStorage.getItem("anime_tracker_last_sync_v11"), null);
    assert.deepEqual(JSON.parse(run.localStorage.getItem(V.STORAGE_KEY)), expectedConfirmed(list, "local-101"));
    assert.match(run.syncStatus.textContent, /同步失敗/u);
});

for (const phase of ["before debounce", "while awaiting cloud auth"]) {
    for (const [label, corrupt] of [
        ["malformed main JSON", store => store.setItem(V.STORAGE_KEY, "invalid-json")],
        ["missing main list", store => store.removeItem(V.STORAGE_KEY)],
        ["invalid main record", store => store.setItem(V.STORAGE_KEY, "[null]")],
        ["invalid history shape", store => store.setItem(V.HISTORY_KEY, "{}")]
    ]) {
        test(`${label} ${phase} blocks upload instead of silently replacing cloud records with empty data`, async () => {
            const run = runtime([legacy()], { enableSync:true,
                onGetUser:phase === "while awaiting cloud auth" ? context => corrupt(context.localStorage) : undefined });
            assert.equal(run.api.confirmAnimeWatching("local-101"), true);
            if (phase === "before debounce") corrupt(run.localStorage);
            await run.flushSync();
            assert.equal(run.trace.uploads.length, 0);
            assert.equal(run.localStorage.getItem("anime_tracker_last_sync_v11"), null);
            assert.match(run.syncStatus.textContent, /同步失敗/u);
            assert.equal(run.api.animeList[0].category, "watching", "The independently saved local confirmation remains visible");
            assert.equal(run.localStorage.operations.filter(op => op.key === V.STORAGE_KEY).length,
                label.startsWith("malformed") || label.startsWith("invalid main") || label.startsWith("missing") ? 2 : 1,
                "Only confirmation and the simulated external corruption touch the main list");
        });
    }
}
