"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const appSourcePath = require("./release-path.cjs");
const V = require(appSourcePath("v11-core.js"));

const at = "2026-11-14T03:00:00.000Z";
const old = (id, title, extra = {}) => ({
    id, title, watched:0, episodes:12, note:"舊版短評", rating:8, favorite:true,
    category:"backlog", airDate:"2020年4月", addedAt:"2020-02-01T00:00:00.000Z", ...extra
});
const edge = (relationType, id, title, format = "TV") => ({ relationType, node:{ id, format, title:{ native:title } } });
const membership = rows => V.projectAnimeSeries(rows).map(row => V.getAnimeSeriesKey(row));

test("v10 numeric local IDs with exact reciprocal relations recover display grouping only", () => {
    const rows = [
        old(43001, "海岸記事", { category:"completed", watched:12, relations:[edge("SEQUEL",43002,"海岸記事 2")] }),
        old(43002, "海岸記事 2", { watched:3, airDate:"2023年7月", relations:[edge("PREQUEL",43001,"海岸記事")] })
    ];
    const before = JSON.stringify(rows);
    const keys = membership(rows);
    assert.equal(keys[0],keys[1]);
    assert.equal(JSON.stringify(rows),before);
    assert.equal(V.getConfirmedAnimeAniListId(rows[0]),"");
    assert.equal(V.getConfirmedAnimeAniListId(rows[1]),"");
    assert.equal(V.isAnimeCurrentlyWatching(rows[1]),true);
    assert.notEqual(...membership([rows[0],{ ...rows[1],title:"另一部電影" }]));
    assert.notEqual(...membership([rows[0],{ ...rows[1],relations:[] }]));
});

test("v11 bare anilistId, missing sourceId and a verified inbound relation retain independent tracking", () => {
    const rows = [
        old("v11-1","航線", { anilistId:43001, source:"anilist", sourceId:43001, relations:[edge("SEQUEL",43002,"航線 第二季")] }),
        old("v11-2","航線 第二季", { anilistId:43002, source:"anilist", watched:3 })
    ];
    const result = V.projectAnimeSeries(rows);
    assert.equal(V.getAnimeSeriesKey(result[0]),V.getAnimeSeriesKey(result[1]));
    assert.equal(V.getConfirmedAnimeAniListId(result[1]),"");
    assert.equal(result[1].watched,3);
    assert.equal(result[1].sourceId,undefined);
    assert.equal(result[1].id,"v11-2");
    const conflicting = { ...rows[1],dataSource:"mal" };
    assert.notEqual(...membership([rows[0],conflicting]));
    assert.notEqual(...membership([rows[0],rows[1],{ ...rows[1],id:"duplicate-claim" }]).slice(0,2));
});

test("explicit legacy group labels corroborated by season and movie separate a homonym and an unrelated manual title", () => {
    const rows = [
        old("orig","雨岸食堂", { groupTitle:"雨岸食堂", category:"completed", watched:12, year:2018 }),
        old("s2","雨岸食堂 第二季", { groupTitle:"雨岸食堂", category:"review", watched:12, reviewWatched:2, year:2023 }),
        old("film","雨岸食堂（劇場版・2024）", { groupTitle:"雨岸食堂", category:"waiting", format:"MOVIE", year:2024 }),
        old("other","雨岸食堂", { year:2025 }),
        old("custom","我的雨岸食堂筆記", { groupTitle:"雨岸食堂", titleSource:"manual" })
    ];
    const result = V.projectAnimeSeries(rows);
    assert.equal(new Set(membership(rows).slice(0,3)).size,1);
    assert.equal(new Set(membership(rows).slice(2)).size,3);
    assert.ok(result.slice(0,3).every(item => V.getAnimeSeriesDisplayLabel(item) === "雨岸食堂"));
    assert.deepEqual(result.map(row => row.category),rows.map(row => row.category));
    assert.equal(result[4].title,rows[4].title);
    assert.deepEqual(V.getAnimeSeriesSuggestions(rows,"custom").map(row => row.id),["orig","s2","film","other"]);
    assert.notEqual(...membership([old("a","海岸記事"),old("b","海岸記事 第二季")]));
});

test("unrelated provider identities cannot be joined by legacy label and a tombstone is never an anchor", () => {
    const rows = [
        old("a","同名", { groupTitle:"同名", anilistId:43001, source:"anilist", sourceId:43001 }),
        old("b","同名 Season 2", { groupTitle:"同名", anilistId:43002, source:"anilist", sourceId:43002 }),
        old("deleted","同名劇場版", { category:"_deleted", format:"MOVIE", groupTitle:"同名", year:2025 })
    ];
    assert.equal(new Set(membership(rows)).size,3);
    assert.equal(V.prepareAnimeSeriesMembership(rows,"b","deleted",at),null);
    assert.equal(V.prepareAnimeSeriesMembership(rows,"b","b",at),null);
});

test("manual link, separation, reset and cross-device merge leave original tracking independent", () => {
    const rows = [old("a","我的筆記", { titleManuallyEdited:true, watched:4 }),
        old("b","動畫", { watched:2, notes:"另一部的筆記", updatedAt:"2026-11-14T04:00:00.000Z" })];
    const link = V.prepareAnimeSeriesMembership(rows,"a","b",at);
    assert.deepEqual(link,{ mode:"link",anchor:"b",updatedAt:at });
    const linked = [{ ...rows[0], seriesMembership:link },rows[1]];
    assert.equal(...membership(linked));
    assert.equal(V.prepareAnimeSeriesMembership(linked,"b","a",at),null);
    assert.notEqual(...membership([{ ...linked[0],seriesMembership:V.prepareAnimeSeriesMembership(linked,"a",null,at) },rows[1]]));
    const merged = V.mergeById([{ ...rows[0], updatedAt:"2026-11-14T04:00:00.000Z" },rows[1]],linked);
    assert.deepEqual(merged[0].seriesMembership,link);
    assert.equal(merged[0].title,"我的筆記");
    assert.equal(merged[0].watched,4);
    assert.equal(merged[1].notes,"另一部的筆記");
    const reset = V.prepareAnimeSeriesMembership(linked,"a","","2026-11-14T05:00:00.000Z");
    assert.deepEqual(V.mergeById(linked,[{ ...rows[0],seriesMembership:reset }])[0].seriesMembership,reset);
});

test("explicit membership storage writes only its field, refusing stale confirmation and quota", async () => {
    const html = fs.readFileSync(appSourcePath("index.html"),"utf8");
    const body = html.slice(html.indexOf("function saveAnimeSeriesMembership"),html.indexOf("function editAnimeReview"));
    const rows = [old("a","第一部",{ category:"review", reviewWatched:2 }),old("b","第二部",{ watched:3 })];
    let stored = structuredClone(rows), fail = false, commits = 0;
    const ctx = vm.createContext({
        AnimeTrackerV11:V, STORAGE_KEY:V.STORAGE_KEY, animeList:rows,
        withAnimeStorageWrite:async operation => operation(),
        readMetadataSyncSnapshot:() => ({ list:structuredClone(stored) }),
        commitAnimeStartupChanges(writes) {
            if (fail) throw Error("quota");
            assert.deepEqual([...writes.map(entry => entry.key)],[V.STORAGE_KEY]);
            stored = JSON.parse(writes[0].value); commits++;
        },
        startupAnimeView:list => list
    });
    vm.runInContext(body,ctx);
    const first = V.animeSeriesMemberStamp(rows[0]), second = V.animeSeriesMemberStamp(rows[1]);
    stored[0].note = "另一分頁先存的筆記";
    const original = structuredClone(stored);
    fail = true;
    await assert.rejects(ctx.saveAnimeSeriesMembership("a",first,"b",second),/quota/u);
    assert.deepEqual(stored,original);
    assert.deepEqual(ctx.animeList,rows);
    fail = false;
    await ctx.saveAnimeSeriesMembership("a",first,"b",second);
    assert.equal(commits,1);
    assert.deepEqual(stored,[{ ...original[0], seriesMembership:stored[0].seriesMembership },original[1]]);
    assert.equal(stored[0].seriesMembership.anchor,"b");
    await assert.rejects(ctx.saveAnimeSeriesMembership("a",first,null,null),/作品或系列已變更/u);
    assert.equal(commits,1);
});

test("legacy, PR8, and current projections separate homonyms and recover date-backed sequels with missing relations", () => {
    const root = require("node:path").resolve(__dirname, "..");
    const oldCore = require(root + "/releases/poster-fix-4/v11-core.js");
    const pr8 = require(root + "/releases/series-identity-1/v11-core.js");
    const pr9 = require(root + "/releases/legacy-series-1/v11-core.js");
    const title = "架空灣日誌";
    const rows = [
        old("original",title,{ groupTitle:title, year:2018, format:"TV", category:"completed", watched:12 }),
        old("sequel",title + " S2",{ seriesGroupTitle:title, year:2021, format:"TV", watched:3 }),
        old("film",title,{ groupTitle:title, year:2023, format:"MOVIE", category:"waiting" }),
        old("subtitle",title + "：北灣篇",{ groupTitle:title, year:2025, format:"TV", category:"review" }),
        old("homonym",title,{ year:2026, format:"TV" }),
        old("other",title,{ year:2017, format:"TV" })
    ];
    const before = JSON.stringify(rows);
    const keys = (core, project) => project(rows).map(core.getAnimeSeriesKey);
    const legacy = keys(oldCore, list => oldCore.assignAnimeSeriesIdentity(list).list);
    const released = keys(pr8, list => pr8.assignAnimeSeriesIdentity(list).list);
    const prior = keys(pr9, pr9.projectAnimeSeries);
    const current = keys(V, V.projectAnimeSeries);
    assert.equal(legacy[0],legacy[4],"legacy label could absorb a homonym");
    assert.equal(new Set(released).size,rows.length);
    assert.ok(new Set(prior.slice(0,4)).size > 1);
    assert.equal(new Set(current.slice(0,4)).size,1);
    assert.equal(new Set([current[0],...current.slice(4)]).size,3);
    assert.equal(JSON.stringify(rows),before);
});

test("one verified anchor can extend through an entire reciprocal legacy chain", () => {
    const rows = [
        old("first","航線前篇",{ source:"anilist", sourceId:43001, anilistId:43001,
            relations:[edge("SEQUEL",43002,"航線續作")] }),
        old("middle","航線續作",{ anilistId:43002, relations:[edge("PREQUEL",43001,"航線前篇"),edge("SEQUEL",43003,"航線終章")] }),
        old("last","航線終章",{ anilistId:43003, relations:[edge("PREQUEL",43002,"航線續作")] })
    ];
    assert.equal(new Set(membership(rows)).size,1);
    assert.equal(V.getConfirmedAnimeAniListId(rows[2]),"");
    const ambiguous = [...rows.slice(0,2), { ...rows[2],relations:[edge("PREQUEL",43002,"航線續作")] },
        old("second-anchor","另一個航線",{ source:"anilist", sourceId:43004, anilistId:43004,
            relations:[edge("SEQUEL",43003,"航線終章")] })];
    const report = V.describeAnimeSeriesProjection(ambiguous);
    assert.notEqual(V.getAnimeSeriesKey(report.projected[0]),V.getAnimeSeriesKey(report.projected[3]));
});

test("verified known sequel IDs supplement missing stored edges and reject a local ID guess", () => {
    const rows = [
        old("s1","戀上換裝娃娃",{ anilistId:132405, format:"TV", year:2022 }),
        old("s2","更衣人偶墜入愛河 第二季",{ anilistId:154768, format:"TV", year:2025 }),
        old(104157,"青春豬頭少年不會夢到懷夢美少女",{ format:"MOVIE",year:2019 }),
        old("tv","青春豬頭少年不會夢見兔女郎學姊",{ source:"anilist", anilistId:101291, sourceId:101291, format:"TV",year:2018 })
    ];
    const keys = membership(rows);
    assert.equal(keys[0],keys[1]);
    assert.notEqual(keys[2],keys[3]);
    assert.equal(V.getConfirmedAnimeAniListId(rows[0]),"");
});
