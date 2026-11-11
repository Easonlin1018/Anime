"use strict";

const appSourcePath = require("./release-path.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require(appSourcePath("v11-core.js"));

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const ui = fs.readFileSync(appSourcePath("v11-ui.js"), "utf8");
const at = "2026-11-09T12:00:00.000Z";
const large = "https://covers.example.invalid/large.jpg";
const medium = "https://covers.example.invalid/medium.jpg";
const dataPoster = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a73sAAAAASUVORK5CYII=";
const syncKey = "anime_metadata_sync_v10_1";
const copy = value => JSON.parse(JSON.stringify(value));

function between(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
    return source.slice(first, last);
}

const production = [
    between(html, "const MEDIA_FIELDS", "async function requestAniList"),
    between(html, "function stripDisplayYear", "async function searchWikipedia"),
    between(html, "function normalizeAnimeAliasList", "function deriveAliasVariants"),
    between(html, "function getAniListMediaId", "function getDirectSequelNodes"),
    between(html, "function normalizeStreamingLinks", "function directRelationMediaIds"),
    between(html, "function loadStoredAnime", "function showToast"),
    between(html, "function formatAiringDateTime", "function editAnimeReview"),
    between(ui, "function persistAnime", "function currentSettings"),
    between(ui, "const originalSaveAndRender", "updateProgress = function")
].join("\n");

function anime(id, extra = {}) {
    const title = `Synthetic anime ${id}`;
    return V.migrateAnime({
        id:`local-${id}`, anilistId:id, source:"anilist", sourceId:String(id),
        title, displayTitle:title, canonicalTitle:title, groupTitle:title,
        titleSource:"manual", titleManuallyEdited:true, aliases:[title],
        status:"RELEASING", format:"TV", startDate:{ year:2026, month:10, day:1 },
        category:"backlog", categorySource:"manual", categoryManuallyEdited:true,
        currentEpisode:5, watched:4, progress:5 / 12, reviewWatched:2, totalEpisodes:12,
        rating:8.5, note:"Short note", notes:"Detailed notes", lastWatchedAt:at,
        createdAt:at, addedAt:at, updatedAt:at, ...extra
    }, at);
}

function media(id, coverImage = { large, medium }) {
    return { id, title:{ native:`Synthetic anime ${id}` }, format:"TV", status:"RELEASING",
        episodes:12, startDate:{ year:2026, month:10, day:1 }, coverImage };
}

function runtime(list = [], responses = [], options = {}) {
    const history = JSON.stringify([{ id:"synthetic-history", animeId:"local-101", delta:1, at }]);
    const store = options.store || new Map([[V.STORAGE_KEY, JSON.stringify(list)], [V.HISTORY_KEY, history]]);
    const requests = [], writes = [], errors = [];
    const api = vm.createContext({
        animeList:copy(list), animeSyncing:false, AnimeTrackerV11:V, V,
        assertAnimeStorageAvailable:() => {},
        withAnimeStorageWrite:operation => operation(),
        window:{ AnimeTrackerV11:V }, autoSyncTimer:null,
        STORAGE_KEY:V.STORAGE_KEY, ANIME_SYNC_KEY:syncKey,
        localStorage:{ getItem:key => store.get(key) ?? null,
            setItem(key, value) { writes.push(key); store.set(key, value); } },
        document:{ getElementById:() => null },
        console:{ error:error => errors.push(error), warn:error => errors.push(error) },
        setTimeout:() => { throw Error("Synthetic metadata sync must not schedule cloud sync"); },
        clearTimeout:() => {}, renderList:() => {}, refreshV11:() => {},
        requestAniListMediaPage:async ids => {
            requests.push(Array.from(ids));
            return options.request ? options.request(ids) : responses;
        }
    });
    vm.runInContext(production, api, { filename:"production-poster-metadata.js" });
    return { api, store, history, requests, writes, errors };
}

test("all AniList query paths select large and medium cover URLs", () => {
    const { api } = runtime();
    const queries = vm.runInContext("[SEARCH_QUERY, SINGLE_MEDIA_SEARCH_QUERY, ID_QUERY, ANIME_BATCH_QUERY]", api);
    for (const query of queries) assert.match(query, /coverImage\s*\{\s*large\s+medium\s*\}/u);
});

test("new records prefer the large HTTPS cover, fall back to medium and reject invalid API values", () => {
    const { api } = runtime();
    const record = api.buildAnimeRecordFromMedia(media(101));
    assert.equal(record.poster, large);
    assert.deepEqual(copy(record.anilistCover), { id:"101", large, medium });
    assert.equal(api.buildAnimeRecordFromMedia(media(101, { large:"http://covers.example.invalid/insecure.jpg", medium })).poster, medium);
    assert.equal(api.buildAnimeRecordFromMedia(media(101, { large:"   ", medium:dataPoster })).poster, "");
    assert.equal(api.buildAnimeRecordFromMedia(media(101, large)).poster, "");
});

test("AniList cover metadata requires matching, non-conflicting confirmed identities", () => {
    const { api } = runtime();
    const cover = (record, response) => api.buildMediaMetadataPatch(record, response, at).anilistCover;
    assert.deepEqual(copy(cover(anime(101), media(101))), { id:"101", large, medium });
    assert.deepEqual(copy(cover(anime(101, { anilistId:"101" }), media("101"))), { id:"101", large, medium });
    for (const record of [
        anime(101, { id:102, anilistId:101, aniListId:102 }),
        anime(101, { sourceId:"102" }),
        anime(101, { source:"mal" }),
        anime(101, { source:"anilist", dataSource:"mal" }),
        anime(101, { id:101, anilistId:null, source:null, sourceId:null }),
        anime(101, { anilistId:[101], source:null, sourceId:null }),
        anime(101, { anilistId:null, source:null, sourceId:"101", anilistTitles:{ native:"Synthetic anime 101" } })
    ]) assert.equal(cover(record, media(101)), undefined);
    assert.equal(cover(anime(101, { id:102 }), media(102)), undefined);
    assert.equal(cover(anime(1, { anilistId:true, source:null, sourceId:null }), media(1)), undefined);
    assert.equal(cover(anime(1), media(true)), undefined);
    assert.deepEqual(copy(cover(anime(101, { anilistId:null, source:null, dataSource:"AniList" }), media(101))), { id:"101", large, medium });
});

test("an unmarked legacy title match cannot masquerade as a confirmed AniList ID", async () => {
    const list = [
        anime(101, { source:null, sourceId:null, anilistTitles:{ native:"Synthetic anime 101" } }),
        anime(102, { source:null, sourceId:null, anilistId:null, aniListId:"102" }),
        anime(103, { source:null, sourceId:null, identitySource:"legacy-work-sourceId" }),
        anime(104, { source:null, sourceId:204, aniListId:104 }),
        anime(105)
    ];
    const run = runtime(list, list.map((_, index) => media(index + 101)));
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.requests, [[105]]);
    const saved = JSON.parse(run.store.get(V.STORAGE_KEY));
    assert.deepEqual(saved[0], list[0]);
    assert.deepEqual(saved[1], list[1]);
    assert.deepEqual(saved[2], list[2]);
    assert.deepEqual(saved[3], list[3]);
    assert.equal(saved[4].anilistCover?.id, "105");
});

test("title, year and format inference cannot attach a cover from the same response or a later batch", async () => {
    const legacy = anime(101, { anilistId:null, source:null, sourceId:null, poster:"old" });
    const { api } = runtime();
    assert.equal(api.getExistingAnimeMediaState(media(101), [legacy]).reason, "legacy-title-year-format");
    const automatic = api.addOrRestoreSingleMedia(media(101), [copy(legacy)], { allowLegacyReconcile:false });
    assert.equal(automatic.changed, false);
    assert.deepEqual(copy(automatic.anime), legacy);
    const added = api.addOrRestoreSingleMedia(media(101), [legacy]);
    assert.equal(added.action, "reconciled");
    assert.equal(added.anime.anilistId, 101);
    assert.equal(added.anime.poster, "old");
    assert.equal(added.anime.anilistCover, undefined);
    assert.equal(V.getConfirmedAnimeAniListId(added.anime), "");
    const run = runtime([added.anime], [media(101)]);
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.requests, []);
    assert.deepEqual(run.writes, []);
});

test("valid legacy covers and existing values with an empty API cover are kept", () => {
    const { api } = runtime();
    for (const fields of [
        { poster:"https://covers.example.invalid/custom.jpg" },
        { poster:dataPoster },
        { poster:{ large:"unusable", medium:"https://covers.example.invalid/legacy.jpg" } },
        { poster:"bad cover", coverImage:{ large:"https://covers.example.invalid/legacy.jpg" } }
    ]) {
        const original = anime(101, fields);
        const patched = api.applyMediaMetadata(copy(original), media(101), at);
        assert.deepEqual(patched.poster, original.poster);
        assert.deepEqual(patched.coverImage, original.coverImage);
    }
    const original = anime(101, { poster:"bad cover", anilistCover:{ id:"101", large, medium } });
    const patched = api.applyMediaMetadata(copy(original), media(101, { large:null, medium:" " }), at);
    assert.equal(patched.poster, original.poster);
    assert.deepEqual(patched.anilistCover, original.anilistCover);
});

test("the existing batch backfills only its confirmed active record and preserves user tracking data", async () => {
    const original = V.migrateList([anime(101, { poster:"not a URL" }), anime(102, { poster:dataPoster }),
        anime(103, { poster:"old invalid value" }), anime(104, { deletedAt:at, poster:"" })], at);
    original[0].watched = 4;
    const run = runtime(original, [media(101), media(102), media(103, null), media(104), media(999)]);
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.requests, [[101, 102, 103]]);
    assert.deepEqual(run.writes, [V.STORAGE_KEY, syncKey]);
    const saved = JSON.parse(run.store.get(V.STORAGE_KEY));
    assert.deepEqual(saved.map(item => item.poster), original.map(item => item.poster));
    assert.deepEqual(saved[0].anilistCover, { id:"101", large, medium });
    assert.deepEqual(saved[1].anilistCover, { id:"102", large, medium });
    assert.equal(saved[2].anilistCover, undefined);
    assert.deepEqual(saved[3], original[3]);
    const fields = ["id", "anilistId", "currentEpisode", "watched", "progress", "reviewWatched", "category",
        "categorySource", "categoryManuallyEdited", "rating", "note", "notes", "lastWatchedAt"];
    for (const [index, item] of saved.entries()) {
        for (const field of fields) assert.deepEqual(item[field], original[index][field], field);
    }
    assert.equal(run.store.get(V.HISTORY_KEY), run.history);
});

test("ordinary metadata refresh leaves a stored AniList cover for the dedicated recovery check", async () => {
    const savedCover = { id:"101", large:"https://covers.example.invalid/saved-cover.jpg" };
    const original = V.migrateList([anime(101, { anilistCover:savedCover })], at);
    const run = runtime(original, [{ ...media(101), status:"FINISHED" }]);
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.errors, []);
    const saved = JSON.parse(run.store.get(V.STORAGE_KEY))[0];
    assert.equal(saved.status, "FINISHED");
    assert.deepEqual(saved.anilistCover, savedCover);
});


test("two tabs preserve per-field edits, a tombstone, and history saved during the request", async () => {
    const original = [anime(101, { poster:"./covers/old.jpg" }), anime(102), anime(103)];
    let respond;
    const tabA = runtime(original, [], { request:() => new Promise(resolve => { respond = resolve; }) });
    const tabB = runtime(original, [], { store:tabA.store });
    const syncing = tabA.api.syncAnimeMetadata();
    const editedAt = "2026-11-09T13:00:00.000Z";
    const secondTabList = copy(original);
    Object.assign(secondTabList[0], {
        watched:9, currentEpisode:9, notes:"Another tab's notes",
        totalEpisodes:28, year:2025, category:"waiting", categorySource:"manual",
        poster:{ large:"./covers/latest.jpg", medium:"/covers/thumb.jpg" },
        coverImage:"data:image/png;base64,AA==",
        anilistCover:{ id:"101", large:"https://covers.example.invalid/edited.jpg", medium },
        updatedAt:editedAt
    });
    Object.assign(secondTabList[1], { deletedAt:editedAt, category:"_deleted", updatedAt:editedAt });
    secondTabList.push(anime(104, { id:"new-after-request" }));
    const history = JSON.stringify([{ id:"new-history", animeId:secondTabList[0].id, delta:4, at:editedAt }]);
    tabB.api.localStorage.setItem(V.STORAGE_KEY, JSON.stringify(secondTabList));
    tabB.api.localStorage.setItem(V.HISTORY_KEY, history);
    respond([{ ...media(101), episodes:16, status:"FINISHED", startDate:{ year:2024 } }, media(102), media(103), media(104)]);
    await syncing;

    assert.deepEqual(tabA.errors, []);
    assert.deepEqual(tabA.requests, [[101, 102, 103]]);
    assert.deepEqual(tabA.writes, [V.STORAGE_KEY, syncKey]);
    const saved = JSON.parse(tabA.store.get(V.STORAGE_KEY));
    assert.equal(saved[0].status, "FINISHED", "Unedited metadata on the same record may still update");
    for (const field of ["watched", "currentEpisode", "notes", "poster", "coverImage", "anilistCover", "updatedAt",
        "category", "categorySource", "episodes", "totalEpisodes", "year", "startDate"]) {
        assert.deepEqual(saved[0][field], secondTabList[0][field], field);
    }
    assert.deepEqual(saved[1], secondTabList[1]);
    assert.deepEqual(saved[2].anilistCover, { id:"103", large, medium });
    assert.deepEqual(saved[3], secondTabList[3]);
    assert.equal(tabA.store.get(V.HISTORY_KEY), history);
    assert.deepEqual(copy(tabA.api.animeList), saved);
});

test("explicitly edited totals and years are not replaced by a later batch", async () => {
    const original = [anime(101, { metadataManuallyEdited:{ totalEpisodes:true, year:true },
        episodes:28, totalEpisodes:28, year:2025, startDate:{ year:2025 } })];
    const run = runtime(original, [{ ...media(101), episodes:15, startDate:{ year:2024 } }]);
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.errors, []);
    const saved = JSON.parse(run.store.get(V.STORAGE_KEY));
    for (const field of ["episodes", "totalEpisodes", "year", "startDate", "metadataManuallyEdited"]) {
        assert.deepEqual(saved[0][field], original[0][field], field);
    }
    assert.equal(saved[0].anilistCover.id, "101");
});

test("strict batch IDs include dataSource legacy rows and reject conflicts, wrong sources, duplicates and malformed replies", async () => {
    const list = [
        anime(101, { anilistId:null, source:null, dataSource:"AniList" }),
        anime(102, { aniListId:202 }),
        anime(103, { source:"mal" }),
        anime(104, { anilistId:null, source:null, sourceId:null }),
        anime(105, { id:"duplicate-local" }), anime(106, { id:"duplicate-local" }),
        anime(107), anime(107, { id:"duplicate-media" }),
        anime(108), anime(1)
    ];
    const run = runtime(list, [media("101"), media(102), media(103), media(104),
        media(105), media(106), media(107), media(108), media("108"), media(true)]);
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.requests, [[101, 108, 1]]);
    const saved = JSON.parse(run.store.get(V.STORAGE_KEY));
    assert.deepEqual(saved[0].anilistCover, { id:"101", large, medium });
    assert.deepEqual(saved.slice(1), list.slice(1));
});

test("a separate tombstone's duplicate claim prevents automatic pairing with an active row", async () => {
    const list = [anime(101), anime(101, { id:"other-local", category:"_deleted", deletedAt:at })];
    const run = runtime(list, [media(101)]);
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.requests, []);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(JSON.parse(run.store.get(V.STORAGE_KEY)), list);
});

test("a newly attached identity and a new duplicate after the request cannot accept a response", async () => {
    const list = [anime(101), anime(102), anime(103, { anilistId:null, source:null, sourceId:null })];
    const run = runtime(list, [], { request:() => {
        const latest = copy(list);
        latest[0].deletedAt = at;
        latest[2].anilistId = 101;
        latest.push(anime(102, { id:"new-duplicate" }));
        run.store.set(V.STORAGE_KEY, JSON.stringify(latest, null, 1));
        return [media(101), media(102)];
    } });
    await run.api.syncAnimeMetadata();
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.requests, [[101, 102]]);
    assert.deepEqual(run.writes, [syncKey]);
    const raw = run.store.get(V.STORAGE_KEY);
    assert.match(raw, /^\[\n /u);
    assert.ok(JSON.parse(raw).every(record => !Object.hasOwn(record, "anilistCover")));
});

test("a removed or malformed persisted list is never recreated from memory after a request", async () => {
    for (const raw of [null, "{", "{}", "[null]"]) {
        const run = runtime([anime(101)], [], { request:() => {
            if (raw === null) run.store.delete(V.STORAGE_KEY);
            else run.store.set(V.STORAGE_KEY, raw);
            return [media(101)];
        } });
        await run.api.syncAnimeMetadata();
        assert.equal(run.errors.length, 1);
        assert.deepEqual(run.writes, []);
        assert.equal(run.store.get(V.STORAGE_KEY) ?? null, raw);
        assert.equal(run.store.get(V.HISTORY_KEY), run.history);
    }
});
