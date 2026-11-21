"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("./release-path.cjs")("v11-core.js");
const V = require(core);
const audit = require("../tools/private-series-preview/model.js");
const posterFix4 = require("../releases/poster-fix-4/v11-core.js");

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
    assert.deepEqual(items.map(x => x.result),["grouped","grouped","grouped","grouped","suggestion","conflict","independent"]);
    assert.equal(groups.get(items[0].key).length,2);
    assert.equal(groups.get(items[2].key).length,2);
    assert.ok(items[3].warnings.some(text => text.includes("舊系列")));
    assert.deepEqual(items[4].candidates,[2,3]);
    assert.equal(JSON.stringify(copy),previous);
});

test("a title or date mismatch is separate from a grouping decision", () => {
    const row = { ...examples[0], source:"AniList", sourceId:101291,
        seriesMetadata:V.buildVerifiedAnimeSeriesMetadata({
            id:101291, type:"ANIME", title:{ native:rascal }, startDate:{ year:2019 }, format:"TV"
        },101291) };
    const { items, stats } = audit.reportSeries(exampleCopy([row]));
    assert.equal(items[0].result,"independent");
    assert.equal(stats.metadata,1);
    assert.equal(stats.needsReview,0);
});

test("multiple corroborated originals are true review, while matching names alone are optional", () => {
    const name = "小島日誌";
    const copy = exampleCopy([
        { id:"s1a", title:name, groupTitle:name, year:2017 },
        { id:"s1b", title:name, groupTitle:name, year:2018 },
        { id:"s2", title:name + " 第二季", groupTitle:name, year:2020 },
        { id:"noise1", title:"無關同名" },
        { id:"noise2", title:"無關同名" }
    ]);
    const { items, stats } = audit.reportSeries(copy);
    assert.deepEqual(items.map(item => item.result), ["review","review","suggestion","suggestion","suggestion"]);
    assert.deepEqual(stats, { automatic:0, suggestions:3, needsReview:2, metadata:0 });
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

test("A/B baseline uses the original poster-fix-4 keys and shows exact cross-category member differences", () => {
    const rows = [
        ...examples.slice(0,5),
        { id:"archived", title:dress, groupTitle:dress, watched:2, deletedAt:date }
    ];
    const copy = exampleCopy(rows), before = JSON.stringify(copy);
    const { comparison } = audit.reportSeries(copy);
    const old = posterFix4.assignAnimeSeriesIdentity(rows).list;
    const oldRascalKey = posterFix4.getAnimeSeriesKey(old[0]);
    const oldDressKey = posterFix4.getAnimeSeriesKey(old[2]);
    assert.deepEqual(comparison.oldGroups.map(group => [group.key, group.members]), [
        [oldRascalKey, [0,1]], [oldDressKey, [2,3,4]]
    ]);
    assert.deepEqual(comparison.restored.map(group => group.members), [[0,1]]);
    assert.deepEqual(comparison.split.map(group => group.members), [[2,3,4]]);
    assert.deepEqual(comparison.split[0].oldParts.map(part => part.members), [[2,3,4]]);
    assert.deepEqual(comparison.split[0].newParts.map(part => part.members), [[2,3], [4]]);
    assert.deepEqual(comparison.review, []);
    assert.deepEqual(comparison.possibleMerges, []);
    assert.equal(JSON.stringify(copy), before);
});

test("A/B flags a newly joined legacy series for inspection while leaving a verified relation and manual links out of the warning", () => {
    const title = "季度動畫";
    const rows = [
        { id:"a", title, groupTitle:title, year:2017, format:"TV", source:"AniList", sourceId:303001, anilistId:303001 },
        { id:"b", title:title + " 第二季", groupTitle:title, year:2018, format:"TV", source:"AniList", sourceId:303002, anilistId:303002 },
        { id:"id-conflict", title:"有矛盾的作品", source:"AniList", anilistId:303003, sourceId:303004 },
        { id:"other-provider", title:"其他網站作品", source:"MyAnimeList", sourceId:"external-id" }
    ];
    const copy = exampleCopy(rows);
    const { comparison, stats } = audit.reportSeries(copy);
    assert.deepEqual(comparison.possibleMerges.map(group => group.members), [[0,1]]);
    assert.deepEqual(comparison.possibleMerges[0].oldParts.map(part => part.members), [[0],[1]]);
    assert.deepEqual(comparison.possibleMerges[0].newParts.map(part => part.members), [[0,1]]);
    assert.deepEqual(comparison.review.map(item => item.index), [2]);
    assert.match(comparison.review[0].reasons.join(), /ID/u);
    assert.equal(stats.needsReview, 1);
    const manual = audit.changeCopy(copy,1,"membership",{ membership:"link:0" },date);
    assert.deepEqual(audit.reportSeries(manual).comparison.possibleMerges, []);
    const relation = [ { ...rows[0], relations:[edge("SEQUEL",303002,rows[1].title,"TV")] }, rows[1] ];
    assert.deepEqual(audit.reportSeries(exampleCopy(relation)).comparison.possibleMerges, []);
});

test("backup provenance distinguishes regenerated fields, older keys, and unmarked backups", () => {
    const rows = [ { id:"old", title:"輕小說改編", groupTitle:"輕小說改編" },
        { id:"after", title:"輕小說改編 第二季", groupTitle:"輕小說改編" } ];
    const stored = posterFix4.assignAnimeSeriesIdentity(rows).list;
    const first = audit.reportSeries(exampleCopy(stored)).comparison;
    assert.equal(first.provenance.status, "legacy-fields");
    assert.equal(first.provenance.legacyCount, 2);
    const second = audit.reportSeries(exampleCopy([
        stored[0], { ...stored[1], seriesKey:'local-series:"after"', seriesKeySource:"local-record" }
    ])).comparison;
    assert.equal(second.provenance.status, "newer-fields");
    assert.equal(second.provenance.newerCount, 1);
    assert.equal(second.provenance.legacyCount, 1);
    assert.match(second.provenance.warning, /無法還原更新前/u);
    assert.deepEqual(second.oldGroups.map(group => group.members), [[0,1]]);
    assert.equal(audit.reportSeries(exampleCopy(rows)).comparison.provenance.status, "unknown");
});

test("the report counts one verified transitive chain across categories and detects a saved manual split", () => {
    const tracked = (id, title, category, format, relations) => ({
        id:"fixture-work-" + id, title, category, format, relations, source:"AniList", sourceId:id, anilistId:id
    });
    const copy = exampleCopy([
        tracked(993001, "始發", "completed", "TV", [edge("SEQUEL", 993002, "旅程續篇", "OVA")]),
        tracked(993002, "旅程續篇", "backlog", "OVA", [edge("SEQUEL", 993003, "終章", "MOVIE")]),
        tracked(993003, "終章", "review", "MOVIE", [])
    ]);
    const before = JSON.stringify(copy);
    const first = audit.reportSeries(copy);
    assert.deepEqual(first.comparison.chainComplete.map(group => group.members), [[0,1,2]]);
    assert.deepEqual(first.comparison.chainSplits, []);
    assert.deepEqual(first.comparison.unresolved, []);

    const manual = audit.changeCopy(copy,2,"membership",{ membership:"separate" },date);
    const { comparison } = audit.reportSeries(manual);
    assert.deepEqual(comparison.chainComplete, []);
    assert.deepEqual(comparison.chainSplits.map(group => group.members), [[0,1,2]]);
    assert.deepEqual(comparison.chainSplits[0].newParts.map(group => group.members), [[0,1],[2]]);
    assert.deepEqual(comparison.unresolved.map(entry => [entry.id, entry.aniListIds]), [
        ["fixture-work-993001", ["993001"]], ["fixture-work-993002", ["993002"]], ["fixture-work-993003", ["993003"]]
    ]);
    assert.match(comparison.unresolved[2].reasons.join(), /手動/u);
    assert.deepEqual(comparison.review, []);
    assert.equal(JSON.stringify(copy), before);
});

test("unresolved work IDs and reasons distinguish optional names from actual identity conflicts", () => {
    const copy = exampleCopy([
        { id:"full-identifier-unverified-one", title:"僅有同名" },
        { id:"full-identifier-unverified-two", title:"僅有同名" },
        { id:"full-identifier-provider-conflict", title:"提供者資料矛盾", source:"AniList", sourceId:994003,
            anilistId:994004, notes:"保留備註" },
        { id:"full-identifier-deleted", title:"僅有同名", deletedAt:date }
    ]);
    const { comparison, stats } = audit.reportSeries(copy);
    assert.deepEqual(comparison.unresolved.map(entry => entry.id), [
        "full-identifier-unverified-one", "full-identifier-unverified-two", "full-identifier-provider-conflict"
    ]);
    assert.match(comparison.unresolved[0].reasons.join(), /現有證據不足/u);
    assert.deepEqual(comparison.unresolved[2].aniListIds, ["994004","994003"]);
    assert.deepEqual(comparison.review.map(entry => entry.index), [2]);
    assert.equal(stats.needsReview,1);
    assert.equal(stats.suggestions,2);
});

test("a local record claiming an unconfirmed chain ID prevents a partial chain from being counted as complete", () => {
    const copy = exampleCopy([
        { id:"beginning", title:"起點", category:"completed", format:"TV", source:"AniList", sourceId:995001,
            relations:[edge("SEQUEL",995002,"轉折","OVA")] },
        { id:"uncorroborated-middle-record", title:"自訂中篇", titleManuallyEdited:true, anilistId:995002,
            category:"waiting", format:"TV" },
        { id:"ending", title:"終點", category:"review", format:"MOVIE", source:"AniList", sourceId:995003,
            relations:[edge("PREQUEL",995002,"轉折","OVA")] }
    ]);
    const before = JSON.stringify(copy);
    const { items, comparison } = audit.reportSeries(copy);
    assert.equal(items[0].key, items[2].key);
    assert.notEqual(items[0].key, items[1].key);
    assert.deepEqual(comparison.chainComplete, []);
    assert.deepEqual(comparison.chainPending.map(group => group.unconfirmed), [[1]]);
    const unresolved = comparison.unresolved.find(entry => entry.id === "uncorroborated-middle-record");
    assert.deepEqual(unresolved.aniListIds, ["995002"]);
    assert.match(unresolved.reasons.join(), /尚未能唯一核對/u);
    assert.equal(JSON.stringify(copy), before);
});
