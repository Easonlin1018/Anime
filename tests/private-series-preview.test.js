"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("./release-path.cjs")("v11-core.js");
const V = require(core);
const audit = require("../tools/private-series-preview/model.js");

const rascal = "青春豬頭少年不會夢見兔女郎學姊";
const movie = "青春豬頭少年不會夢到懷夢美少女";
const dress = "戀上換裝娃娃";
const date = "2026-11-14T02:30:00.000Z";
const edge = (relationType, id, title, format) => ({ relationType, node:{ id, type:"ANIME", format, title:{ native:title } } });
const examples = [
    { id:4150, title:rascal, category:"completed", anilistId:101291, year:2018, watched:13, note:"初季筆記", favorite:true,
        relations:[edge("SEQUEL",104157,movie,"MOVIE")], format:"TV", rating:9 },
    { id:"local-movie", title:movie, category:"backlog", anilistId:104157, year:2019, watched:0, format:"MOVIE",
        relations:[edge("PREQUEL",101291,rascal,"TV")], rating:null },
    { id:"dress1", title:dress, groupTitle:dress, category:"completed", watched:12, year:2022, rating:7.5 },
    { id:"dress2", title:dress + " 第二季", groupTitle:dress, category:"review", progress:3,
        aliases:["更衣人偶墜入愛河"], year:2025, favorite:true },
    { id:"ask", title:"我的自訂標題", groupTitle:dress, year:2025, notes:"<img src='https://fixture.invalid/private-note'>", titleManuallyEdited:true },
    { id:"conflict", title:"來源矛盾", anilistId:154768, sourceId:10, source:"anilist" },
    { id:"unrelated", title:"不同系列" }
];
const history = [{ animeId:4150, delta:1, at:date, unrecognizedField:true }];

function exampleCopy(records = examples) {
    return { original:audit.readBackup(JSON.stringify({ [V.STORAGE_KEY]:records, watchHistory:history })), edits:{} };
}

test("backup parser retains exact records, ID types, history and relationship evidence across supported legacy formats", () => {
    for (const records of [examples, JSON.stringify(examples)]) {
        const evidence = [{ workId:"work-a", mediaEntries:[{ mediaType:"anime", id:4150 }] }];
        const backup = { [V.STORAGE_KEY]:records, watchHistory:history, works:evidence,
            settings:{ email:"PRIVATE-IN-SETTINGS", token:"PRIVATE-TOKEN" } };
        const data = audit.readBackup("\uFEFF" + JSON.stringify(backup));
        assert.deepEqual(data,{ records:examples, history, works:evidence, mediaEntries:[] });
    }
    assert.deepEqual(audit.readBackup(JSON.stringify(examples)),{ records:examples, history:[], works:[], mediaEntries:[] });
    assert.deepEqual(audit.readBackup(JSON.stringify({ [V.STORAGE_KEY]:[], [V.HISTORY_KEY]:history })).history,history);
    for (const value of ["bad json", "{}", "[null]", JSON.stringify({ [V.STORAGE_KEY]:[], watchHistory:[null] })]) {
        assert.throws(() => audit.readBackup(value));
    }
});

test("the audit reports both series from raw legacy records and retains ambiguity", () => {
    const copy = exampleCopy(), previous = JSON.stringify(copy);
    const { items, groups } = audit.reportSeries(copy);
    assert.deepEqual(items.map(x => x.result),["grouped","grouped","grouped","grouped","review","conflict","independent"]);
    assert.equal(groups.get(items[0].key).length,2);
    assert.equal(groups.get(items[2].key).length,2);
    assert.ok(items[3].warnings.some(text => text.includes("舊系列")));
    assert.deepEqual(items[4].candidates,[2,3]);
    assert.equal(JSON.stringify(copy),previous);
});

test("verified relationships from the backup are evaluated without reassigning IDs in the original", () => {
    const rows = [examples[0],{ ...examples[1], anilistId:undefined, relations:[] }];
    const evidence = { mediaType:"anime", id:"local-movie", title:movie, source:"AniList", sourceId:104157, anilistId:104157 };
    const copy = exampleCopy(rows);
    copy.original.works = [{ workId:"known", mediaEntries:[evidence] }];
    const { items, projected } = audit.reportSeries(copy);
    assert.ok(items[1].identityRecovered);
    assert.equal(V.getConfirmedAnimeAniListId(projected[1]),"104157");
    assert.equal(copy.original.records[1].anilistId,undefined);
    assert.equal(copy.original.records[1].id,"local-movie");
});

test("duplicate IDs and tombstones are retained but cannot be edited", () => {
    const rows = [{ ...examples[0] }, { ...examples[1],id:"4150" }, { ...examples[6], category:"_deleted" }];
    const copy = exampleCopy(rows);
    const { items } = audit.reportSeries(copy);
    assert.deepEqual(items.map(x => x.result),["conflict","conflict","deleted"]);
    for (const item of items) {
        assert.equal(item.canEdit,false);
        assert.throws(() => audit.changeCopy(copy,item.index,"membership",{ membership:"auto" },date));
    }
    assert.deepEqual(copy.original.records,rows);
});

test("progress and series edits are copy-only and never rewrite the raw record or history", () => {
    const copy = exampleCopy();
    const changed = audit.changeCopy(copy,4,"save",{ notes:"新筆記", progress:"4" },date);
    const confirmed = audit.changeCopy(changed,4,"membership",{ membership:"link:2" },date);
    assert.equal(copy.edits[4],undefined);
    assert.deepEqual(confirmed.original,copy.original);
    const result = audit.reportSeries(confirmed);
    assert.deepEqual(result.items[4].row,{ ...examples[4], notes:"新筆記", watched:4, currentEpisode:4,
        seriesMembership:{ mode:"link", anchor:"dress1", updatedAt:date } });
    assert.equal(result.items[4].key,result.items[2].key);
    assert.throws(() => audit.changeCopy(confirmed,2,"membership",{ membership:"link:4" },date));
    assert.throws(() => audit.changeCopy(confirmed,4,"save",{ notes:"", progress:"-1" },date));
});
