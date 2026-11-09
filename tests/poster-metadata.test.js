"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "v11-ui.js"), "utf8");
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
    between(html, "function getAniListMediaId", "function getMediaIdentityTitles"),
    between(html, "function normalizeStreamingLinks", "function directRelationMediaIds"),
    between(html, "function loadStoredAnime", "function showToast"),
    between(html, "function formatAiringDateTime", "function editAnimeReview"),
    between(ui, "function touch", "function currentSettings"),
    between(ui, "const originalSaveAndRender", "const originalMoveCategory")
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

function runtime(list = [], responses = []) {
    const history = JSON.stringify([{ id:"synthetic-history", animeId:"local-101", delta:1, at }]);
    const store = new Map([[V.STORAGE_KEY, JSON.stringify(list)], [V.HISTORY_KEY, history]]);
    const requests = [], writes = [], errors = [];
    const api = vm.createContext({
        animeList:copy(list), animeSyncing:false, AnimeTrackerV11:V, V,
        window:{ AnimeTrackerV11:V }, autoSyncTimer:null,
        STORAGE_KEY:V.STORAGE_KEY, ANIME_SYNC_KEY:syncKey,
        localStorage:{ getItem:key => store.get(key) ?? null,
            setItem(key, value) { writes.push(key); store.set(key, value); } },
        document:{ getElementById:() => null },
        console:{ error:error => errors.push(error), warn:error => errors.push(error) },
        setTimeout:() => { throw Error("Synthetic metadata sync must not schedule cloud sync"); },
        clearTimeout:() => {}, renderList:() => {}, refreshV11:() => {},
        requestAniListMediaPage:async ids => { requests.push(Array.from(ids)); return responses; }
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
    assert.equal(api.buildAnimeRecordFromMedia(media(101)).poster, large);
    assert.equal(api.buildAnimeRecordFromMedia(media(101, { large:"http://covers.example.invalid/insecure.jpg", medium })).poster, medium);
    assert.equal(api.buildAnimeRecordFromMedia(media(101, { large:"   ", medium:dataPoster })).poster, "");
    assert.equal(api.buildAnimeRecordFromMedia(media(101, large)).poster, "");
});

test("metadata poster patch requires a confirmed matching AniList ID and never uses title or local ID", () => {
    const { api } = runtime();
    assert.equal(api.buildMediaMetadataPatch(anime(101, { poster:"bad cover" }), media(101), at).poster, large);
    assert.equal(api.buildMediaMetadataPatch(anime(101, { anilistId:"101" }), media("101"), at).poster, large);
    assert.equal(api.buildMediaMetadataPatch(anime(101, { id:102 }), media(102), at).poster, undefined);
    assert.equal(api.buildMediaMetadataPatch(anime(101, { id:101, anilistId:null, source:null, sourceId:null }), media(101), at).poster, undefined);
    assert.equal(api.buildMediaMetadataPatch(anime(101, { anilistId:[101], source:null, sourceId:null }), media(101), at).poster, undefined);
    assert.equal(api.buildMediaMetadataPatch(anime(1, { anilistId:true, source:null, sourceId:null }), media(1), at).poster, undefined);
    assert.equal(api.buildMediaMetadataPatch(anime(1), media(true), at).poster, undefined);
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
    const original = anime(101, { poster:"bad cover" });
    assert.equal(api.applyMediaMetadata(copy(original), media(101, { large:null, medium:" " }), at).poster, original.poster);
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
    assert.deepEqual(saved.map(item => item.poster), [large, dataPoster, "old invalid value", ""]);
    assert.deepEqual(saved[3], original[3]);
    const fields = ["id", "anilistId", "currentEpisode", "watched", "progress", "reviewWatched", "category",
        "categorySource", "categoryManuallyEdited", "rating", "note", "notes", "lastWatchedAt"];
    for (const [index, item] of saved.entries()) {
        for (const field of fields) assert.deepEqual(item[field], original[index][field], field);
    }
    assert.equal(run.store.get(V.HISTORY_KEY), run.history);
});
