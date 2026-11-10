"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const V = require(appSourcePath("v11-core.js"));

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const ui = fs.readFileSync(appSourcePath("v11-ui.js"), "utf8");
const at = "2026-10-10T00:00:00.000Z";
const record = (id, fields = {}) => ({
    id, title:"Synthetic title", category:"watching", currentEpisode:4, watched:4, totalEpisodes:12,
    year:2025, notes:"Synthetic note", poster:{ medium:"./fixtures/old.png" },
    createdAt:at, updatedAt:at, ...fields
});
const workWith = (...mediaEntries) => ({ workId:"synthetic-work", mediaEntries });
const entry = (id, fields = {}) => ({ ...record(id, fields), mediaType:"anime" });
const section = (text, start, end) => {
    const first = text.indexOf(start);
    const last = text.indexOf(end, first + 1);
    assert.ok(first >= 0 && last > first, `Missing production section ${start}`);
    return text.slice(first, last);
};

test("GraphQL AniList IDs are positive signed-Int values with no coercion", () => {
    for (const value of [0, -1, 1.2, 2147483648, Date.now(), true, [17], { id:17 }, "1e3", "+7", "17.0", ""]) {
        assert.equal(V.normalizeAniListMediaId(value), "");
    }
    assert.equal(V.normalizeAniListMediaId("00017"), "17");
    assert.equal(V.normalizeAniListMediaId(2147483647), "2147483647");
});

test("work migration never writes the local ID as a source ID or coerces malformed identity fields", () => {
    const works = V.migrateWorks([record(412), record(Date.now()), record("uuid"), record("invalid", {
        source:"anilist", sourceId:[412]
    })], [], at);
    const entries = works.flatMap(work => work.mediaEntries);
    assert.deepEqual(entries.slice(0, 3).map(item => item.sourceId), ["", "", ""]);
    assert.deepEqual(entries[3].sourceId, [412]);
    assert.ok(entries.every(item => V.getConfirmedAnimeAniListId(item) === ""));
    const previous = workWith(entry(412, { sourceId:"412" }));
    const refreshed = V.migrateWorks([record(412, { source:"anilist" })], [previous], at)[0].mediaEntries[0];
    assert.equal(refreshed.source, undefined);
    assert.equal(refreshed.sourceId, "412");
    assert.equal(V.getConfirmedAnimeAniListId(refreshed), "");
});

test("copied local IDs, old recovery labels, title guesses and wrong sources are ineligible", () => {
    const list = [
        record(412, { source:"anilist", sourceId:"412" }),
        record(413, { anilistId:413, identitySource:"legacy-work-sourceId" }),
        record("guessed", { source:"anilist", anilistId:421, identitySource:"legacy-title-year-format" }),
        record("historical-guess", { source:"anilist", anilistId:428 }),
        record("bare", { aniListId:429 }),
        record("provider-conflict", { source:"anilist", dataSource:"MAL", anilistId:430 }),
        record("number-conflict", { source:"anilist", sourceId:"431", anilistId:430 })
    ];
    assert.ok(list.every(item => V.getConfirmedAnimeAniListId(item) === ""));
    const entries = [
        entry(412, { source:"anilist", sourceId:"412" }),
        entry(413, { sourceId:"413" }),
        entry("guessed", { source:"anilist", sourceId:"421", identitySource:"legacy-title-year-format" }),
        entry("bare", { sourceId:"429" }),
        entry("provider-conflict", { source:"anilist", anilistId:430 }),
        entry("number-conflict", { source:"anilist", anilistId:430 })
    ];
    const result = V.recoverLegacyAnimeIdentities(list, { works:[workWith(...entries)] }, at);
    assert.equal(result.recoveredCount, 0);
    assert.deepEqual(result.list, list);
});

test("only independently sourced AniList IDs may be recovered from a unique work", () => {
    const list = [record("accepted"), record("same-as-local-copy"), record("conflict")];
    const entries = [
        entry("accepted", { dataSource:"AniList", sourceId:"444" }),
        entry("same-as-local-copy", { sourceId:"445" }),
        entry("conflict", { source:"anilist", anilistId:446, sourceId:"447" })
    ];
    const result = V.recoverLegacyAnimeIdentities(list, { works:[workWith(...entries)] }, at);
    assert.equal(result.recoveredCount, 1);
    assert.equal(result.list[0].identitySource, "verified-work-anilist");
    assert.equal(V.getConfirmedAnimeAniListId(result.list[0]), "444");
    assert.deepEqual(result.list.slice(1), list.slice(1));
    assert.equal(V.getConfirmedAnimeAniListId(record(444, { source:"anilist", sourceId:"444", anilistId:444 })), "444");
});

test("a shared work source ID cannot merge two different local anime records", () => {
    const newer = entry("provider", { source:"anilist", anilistId:412, sourceId:"412", notes:"Remote note" });
    for (const old of [entry(412, { sourceId:"412" }), entry(412, { source:"anilist", sourceId:"412", anilistId:412 })]) {
        const merged = V.mergeWorks([workWith(old)], [workWith(newer)])[0].mediaEntries;
        assert.equal(merged.length, 2);
        assert.equal(merged.find(item => item.id === 412).notes, old.notes);
        assert.equal(merged.find(item => item.id === "provider").notes, newer.notes);
    }
});

test("malformed GraphQL IDs are omitted before a mixed batch leaves the application", async () => {
    const bodies = [];
    const runtime = vm.createContext({ AnimeTrackerV11:V, fetchWithTimeout:async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return { json:async () => ({ data:{ Page:{ media:[] } } }) };
    } });
    vm.runInContext(section(html, "const MEDIA_FIELDS", "function normalizeStreamingLinks")
        + "\nthis.idQuery = ID_QUERY;", runtime);
    await runtime.requestAniListMediaPage([2147483648, "17", 17, [22], 0, 2147483647, Date.now()]);
    await runtime.requestAniListMediaPage([Date.now(), [17]]);
    await runtime.requestAniList(runtime.idQuery, { id:2147483648 });
    assert.deepEqual(bodies.map(body => body.variables), [{ ids:[17, 2147483647] }]);
});

test("ambiguously claimed AniList IDs block even otherwise confirmed rows", () => {
    const getTargets = Function("AnimeTrackerV11",
        section(html, "function getMetadataSyncTargets", "function filterMetadataSyncPatch") + "\nreturn getMetadataSyncTargets;")(V);
    const targets = getTargets([
        record("confirmed-412", { source:"anilist", sourceId:412, anilistId:412 }),
        record("ambiguous", { source:"anilist", anilistId:412, sourceId:"413" }),
        record("confirmed-414", { source:"anilist", sourceId:414, anilistId:414 }),
        record("timestamp", { source:"anilist", anilistId:Date.now() }),
        record("old-copy", { anilistId:415, identitySource:"legacy-work-sourceId" }),
        record("confirmed-415", { source:"anilist", sourceId:415, anilistId:415 }),
        record("confirmed-416", { source:"anilist", sourceId:416, anilistId:416 }),
        record("tombstone-416", { source:"anilist", sourceId:416, anilistId:416, deletedAt:at, category:"_deleted" })
    ]);
    assert.deepEqual([...targets.keys()], ["confirmed-414"]);
});

test("explicit confirmation can resolve one duplicate without changing its other claimant", () => {
    const left = record("first", { source:"anilist", sourceId:412, anilistId:412 });
    const right = record("second", { source:"anilist", sourceId:412, anilistId:412 });
    const rows = [left,right];
    assert.equal(V.hasUniqueConfirmedAnimeAniListId(rows, left), false);
    const snapshot = V.animeAniListIdentitySnapshot(left);
    assert.equal(V.confirmAnimeAniListIdentity(rows, left.id, snapshot, 412, at).reason, "identity-already-claimed");
    const resolved = V.confirmAnimeAniListIdentity(rows, left.id, snapshot, 499, at);
    assert.equal(V.getConfirmedAnimeAniListId(resolved.anime), "499");
    assert.deepEqual(resolved.anime.poster, left.poster);
    assert.equal(resolved.list[1], right);
});

test("automatic reconciliation and import preserve duplicated and title-matched local records", () => {
    const rows = [
        record("first", { source:"anilist", sourceId:412, anilistId:412, notes:"First local note" }),
        record("second", { source:"anilist", sourceId:412, anilistId:412, notes:"Second local note" }),
        record("shadow", { notes:"Unconfirmed shadow note", year:2025, format:"TV" }),
        record("conflict", { source:"anilist", anilistId:412, sourceId:413, notes:"Conflicting source note" })
    ];
    const direct = V.reconcileExistingAnimeDuplicates(rows, {}, { preserveAmbiguous:true });
    const imported = V.importBackup({ animeList:[], works:[] }, {
        schemaVersion:11, [V.STORAGE_KEY]:rows, works:[]
    }, "replace");
    for (const result of [direct.list, imported.animeList]) {
        assert.deepEqual(result.map(row => [row.id, row.notes]), rows.map(row => [row.id, row.notes]));
        assert.equal(result.find(row => row.id === "shadow").anilistId, undefined);
        assert.equal(result.find(row => row.id === "conflict").sourceId, 413);
    }
});

function wireConfirmation(initial, response, failLock = false) {
    const inputs = new Map();
    for (const selector of ["input", "[data-v11-anilist-lookup]", "[data-v11-anilist-confirm]", "[role='status']"]) {
        const actions = new Map();
        inputs.set(selector, {
            actions, value:"", textContent:"", hidden:true, disabled:false,
            addEventListener(type, fn) { actions.set(type, fn); }
        });
    }
    const input = inputs.get("input");
    const lookup = inputs.get("[data-v11-anilist-lookup]");
    const confirm = inputs.get("[data-v11-anilist-confirm]");
    const status = inputs.get("[role='status']");
    let rows = initial;
    let lockHeld = false;
    const queries = [], writes = [];
    const runtime = vm.createContext({
        V, STORAGE_KEY:V.STORAGE_KEY, animeList:initial, ID_QUERY:"exact-query",
        localStorage:{ getItem:() => JSON.stringify(rows) },
        requestAniList:async (query, variables) => {
            queries.push([query, variables.id]);
            return typeof response === "function" ? response() : response;
        },
        window:{ withAnimeStorageWrite:async operation => {
            if (failLock) throw new Error("Synthetic unavailable lock");
            lockHeld = true;
            try { return operation(); }
            finally { lockHeld = false; }
        } },
        commitAnimeStartupChanges(changes) {
            assert.equal(lockHeld, true);
            assert.equal(changes.length, 1);
            assert.equal(changes[0].key, V.STORAGE_KEY);
            rows = JSON.parse(changes[0].value);
            writes.push(rows);
        },
        renderList() {}, refreshV11() {}, requestAnimeAutoSync() {}
    });
    vm.runInContext(section(ui, "    function wireAnimeAniListIdentity", "    function openAnimeDetail"), runtime);
    runtime.wireAnimeAniListIdentity({ querySelector:selector => inputs.get(selector) }, initial[0].id);
    return {
        input, lookup, confirm, status, queries, writes,
        lookupClick:() => lookup.actions.get("click")(), confirmClick:() => confirm.actions.get("click")(),
        getRows:() => rows, setRows:value => { rows = value; }
    };
}

test("manual exact-ID preview is read-only, then confirmation preserves the latest poster and tracking fields", async () => {
    const first = record("local-legacy", { source:"old-provider", sourceId:"301", anilistId:999 });
    const other = record("local-other");
    const run = wireConfirmation([first, other], { id:432, type:"ANIME", title:{ native:"Synthetic remote" } });
    run.input.value = "432";
    await run.lookupClick();
    assert.deepEqual(run.queries, [["exact-query", 432]]);
    assert.equal(run.writes.length, 0);
    assert.equal(run.confirm.hidden, false);
    assert.match(run.status.textContent, /Synthetic remote.*432/u);
    const recent = { ...first, watched:5, currentEpisode:5, notes:"Changed in other tab", poster:"./fixtures/current.png" };
    run.setRows([recent, other]);
    await run.confirmClick();
    assert.equal(run.writes.length, 1);
    const [updated, unaffected] = run.getRows();
    assert.equal(V.getConfirmedAnimeAniListId(updated), "432");
    assert.equal(updated.identitySource, "user-confirmed-anilist");
    assert.deepEqual(updated.previousUnconfirmedIdentity, { source:"old-provider", sourceId:"301", anilistId:999 });
    for (const key of ["id", "title", "notes", "poster", "category", "currentEpisode", "watched", "totalEpisodes", "year", "createdAt"]) {
        assert.deepEqual(updated[key], recent[key], key);
    }
    assert.equal(updated.anilistCover, undefined);
    assert.deepEqual(unaffected, other);
});

test("a mismatched or malformed AniList result never enables confirmation", async () => {
    for (const response of [
        { id:433, type:"ANIME", title:{ native:"Wrong record" } },
        { id:432, type:"MANGA", title:{ native:"Wrong media type" } },
        { id:432, type:"ANIME", title:{} }
    ]) {
        const run = wireConfirmation([record("legacy")], response);
        run.input.value = "432";
        await run.lookupClick();
        assert.equal(run.confirm.hidden, true);
        await run.confirmClick();
        assert.equal(run.writes.length, 0);
    }
});

test("confirmation cannot overwrite a duplicate claim, deletion or unavailable transaction", async () => {
    const first = record("legacy");
    const response = { id:432, type:"ANIME", title:{ native:"Synthetic remote" } };
    for (const [changed, failLock] of [
        [[first, record("ambiguous", { source:"anilist", anilistId:432, sourceId:433 })], false],
        [[{ ...first, deletedAt:at }], false],
        [[{ ...first, source:"anilist", sourceId:444 }], false],
        [[first], true]
    ]) {
        const run = wireConfirmation([first], response, failLock);
        run.input.value = "432";
        await run.lookupClick();
        run.setRows(changed);
        await run.confirmClick();
        assert.equal(run.writes.length, 0);
        assert.deepEqual(run.getRows(), changed);
        assert.match(run.status.textContent, /尚未連結/u);
    }
});
