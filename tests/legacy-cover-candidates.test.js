"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const releasePath = require("./release-path.cjs");
const V = require(releasePath("v11-core.js"));

const baseUrl = "https://tracker.example/Anime/";
const legacyCover = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/synthetic.jpg";
const archivedCover = { id:37001, medium:legacyCover };

test("old poster strings and common image objects remain usable without provider identity", () => {
    const row = {
        id:37001,
        poster:{ url:"./covers/old cover.webp" },
        coverImage:{ extraLarge:"//s4.anilist.co/file/anilistcdn/media/anime/cover/medium/synthetic.jpg" }
    };
    const before = structuredClone(row);
    assert.deepEqual(V.getAnimePosterCandidates(row, { baseUrl }), [
        "https://tracker.example/Anime/covers/old%20cover.webp", legacyCover
    ]);
    assert.deepEqual(row,before);
    assert.equal(V.getConfirmedAnimeAniListId(row),"");
});

test("known legacy AniList image URLs use HTTPS and deduplicate against their secure form", () => {
    assert.deepEqual(V.getAnimePosterCandidates({
        poster:legacyCover.replace("https:","http:"),
        coverImage:{ src:legacyCover }
    }, { baseUrl }),[legacyCover]);
    assert.equal(V.resolvePosterUrl(legacyCover.replace("https:","http:"), { httpsOnly:true }),"");
});

test("archived cover IDs accept numeric form while existing poster and coverImage stay first", () => {
    const row = {
        id:"original", source:"anilist", sourceId:"37001", anilistId:37001,
        poster:"./old.jpg", coverImage:{ medium:"./second.jpg" }, anilistCover:archivedCover
    };
    assert.deepEqual(V.getAnimePosterCandidates(row, { baseUrl }), [
        baseUrl+"old.jpg", baseUrl+"second.jpg", legacyCover
    ]);
    const rows = [row, { id:"other", anilistId:37001, category:"_deleted" }];
    assert.equal(V.hasUniqueConfirmedAnimeAniListId(rows,row),false);
    assert.deepEqual(V.getStoredAniListPosterUrls(row),[legacyCover]);
});

test("the same saved explicit ID can display its old cover without granting automatic lookup eligibility", () => {
    const row = { id:"original", aniListId:"37001", anilistCover:archivedCover };
    assert.deepEqual(V.getAnimePosterCandidates(row),[legacyCover]);
    assert.equal(V.getConfirmedAnimeAniListId(row),"");
});

test("a local ID alone or conflicting provider data cannot display an associated AniList cover", () => {
    const variants = [
        { id:37001 },
        { id:"wrong", anilistId:37002 },
        { id:"conflict", anilistId:37001, aniListId:37002 },
        { id:"conflict-source", anilistId:37001, sourceId:37002 },
        { id:"wrong-provider", anilistId:37001, dataSource:"MAL" },
        { id:"guessed", anilistId:37001, identitySource:"legacy-title-year-format" },
        { id:"copied", anilistId:37001, identitySource:"legacy-work-sourceId" }
    ];
    for (const row of variants) {
        assert.deepEqual(V.getStoredAniListPosterUrls({ ...row, anilistCover:archivedCover }),[],row.id);
    }
});

test("expanded legacy shapes still reject executable and deceptive URLs", () => {
    const coverImage = {
        large:"javascript:alert(1)",
        medium:"//s4.anilist.co.evil.example/anime.jpg",
        extraLarge:"https://name:password@example.invalid/anime.jpg",
        url:"data:text/html,<img>",
        src:"./%2e%2e/private.jpg"
    };
    assert.deepEqual(V.getAnimePosterCandidates({ coverImage }, { baseUrl }),[]);
});
