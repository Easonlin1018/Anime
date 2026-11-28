"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const V = require(require("./release-path.cjs")("v11-core.js"));
const { canPurge, purgeCopy, applyMarkers } = require("../tools/private-series-preview/purge.js");

const seeded = () => ({
    revision:"original-revision",
    original:{
        records:[
            {id:100, title:"作品甲", deletedAt:"2026-08-02", category:"_deleted", notes:"removed note",
                source:"anilist", sourceId:830021, anilistId:830021},
            {id:"sibling", title:"保留作品", watched:6, rating:9, notes:"kept note",
                seriesMembership:{mode:"link", anchor:"100"}},
            {id:"legacy-tombstone", title:"舊版作品", category:"_deleted", createdAt:"2025-01-01"}
        ],
        history:[{id:"removed-watch",animeId:"100"},{id:"kept-watch",animeId:"sibling"}],
        mediaEntries:[{id:100,mediaType:"anime"},{id:100,mediaType:"manga"}],
        works:[
            {workId:"anime-work",mediaEntries:[{id:"100",mediaType:"anime"}]},
            {workId:"shared-work",mediaEntries:[{id:"100",mediaType:"anime"},{id:"100",mediaType:"manga"}]},
            {workId:"keep-work",mediaEntries:[]}
        ]
    },
    edits:{0:{notes:"old edit"}, 1:{watched:7,notes:"kept edit",seriesMembership:{mode:"link",anchor:100}}}
});

test("preview purges only the selected deleted record, its related data and stale anchors", () => {
    const copy = seeded();
    const original = structuredClone(copy);
    const result = purgeCopy(copy, [], 0);
    assert.deepEqual(copy, original);
    assert.deepEqual(result.copy.original.records, [
        {id:"sibling",title:"保留作品",watched:6,rating:9,notes:"kept note"},original.original.records[2]
    ]);
    assert.deepEqual(result.copy.edits,{0:{watched:7,notes:"kept edit"}});
    assert.deepEqual(result.copy.original.history,[original.original.history[1]]);
    assert.deepEqual(result.copy.original.mediaEntries,[original.original.mediaEntries[1]]);
    assert.deepEqual(result.copy.original.works,[
        {workId:"shared-work",mediaEntries:[{id:"100",mediaType:"manga"}]},original.original.works[2]
    ]);
    assert.deepEqual(result.markers,[{id:"100",providerId:"830021",created:null}]);
});

test("an older backup cannot reintroduce purged active records or orphaned history", () => {
    const copy = seeded();
    const { markers } = purgeCopy(copy, [], 0);
    delete copy.original.records[0].deletedAt;
    copy.original.records[0].category = "completed";
    const next = applyMarkers(copy, markers);
    assert.equal(next.original.records.some(row => String(row.id) === "100"), false);
    assert.equal(next.original.history.some(event => String(event.animeId) === "100"), false);
    copy.original.records.shift();
    assert.equal(applyMarkers(copy, markers).original.history.length, 1);
    assert.equal(applyMarkers(next, markers), next);
});

test("preview refuses active, ambiguous IDs and older copies with a conflicting identity", () => {
    const copy = seeded();
    assert.equal(canPurge(copy,1), false);
    const { markers } = purgeCopy(copy, [], 0);
    const conflict = seeded();
    conflict.original.records[0].anilistId = conflict.original.records[0].sourceId = 830022;
    assert.throws(() => applyMarkers(conflict, markers), /不同作品/u);
    copy.original.records.push({ ...copy.original.records[0],id:"100" });
    assert.equal(canPurge(copy,0), false);
    assert.throws(() => applyMarkers(copy, markers), /重複/u);
});

test("legacy deletion marker prevents revival but protects records with reused IDs", () => {
    const copy = seeded();
    const { markers } = purgeCopy(copy, [], 2);
    assert.equal(applyMarkers(copy, markers).original.records.length, 2);
    const other = seeded();
    other.original.records[2].createdAt = "2026-03-01";
    assert.throws(() => applyMarkers(other, markers), /不同作品/u);
});

test("normal collection search hides timestamp and category-only tombstones without replacing the stored rows", () => {
    const ordinary = {id:"active",title:"作品搜尋"};
    const rows = [...seeded().original.records, ordinary];
    const original = structuredClone(rows);
    assert.deepEqual(V.searchFilterSort(rows,"作品").map(row => row.id).sort(), ["active","sibling"]);
    assert.deepEqual(V.searchFilterSort(rows,"",{status:["_deleted"]}), []);
    assert.deepEqual(rows, original);
});
