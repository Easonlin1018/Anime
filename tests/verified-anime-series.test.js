"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const V = require(require("./release-path.cjs")("v11-core.js"));

// AniList IDs, formats and Japanese premiere dates. Watch data is synthetic.
const rascal = [
    [101291, "青春豬頭少年不會夢見兔女郎學姊", "Rascal Does Not Dream of Bunny Girl Senpai", "TV", 2018, 10, 4],
    [104157, "青春豬頭少年不會夢到懷夢美少女", "Rascal Does Not Dream of a Dreaming Girl", "MOVIE", 2019, 6, 15],
    [154967, "青春豬頭少年不會夢到嬌憐外出妹", "Rascal Does Not Dream of a Sister Venturing Out", "MOVIE", 2023, 6, 23],
    [161474, "青春豬頭少年不會夢到紅書包女孩", "Rascal Does Not Dream of a Knapsack Kid", "MOVIE", 2023, 12, 1],
    [171046, "青春豬頭少年不會夢到聖誕服女郎", "Rascal Does Not Dream of Santa Claus", "TV", 2025, 7, 5],
    [199340, "青春豬頭少年不會夢到親愛好朋友", "Rascal Does Not Dream of a Dear Friend", "MOVIE", 2026, 10, 16]
];
const darling = [
    [132405, "戀上換裝娃娃", "My Dress-Up Darling", "TV", 2022, 1, 9],
    [154768, "戀上換裝娃娃 第二季", "My Dress-Up Darling Season 2", "TV", 2025, 7, 6]
];

const relation = (relationType, [id, , english, format, year, month, day], type = "ANIME") => ({
    relationType,
    node:{ id, type, format, startDate:{ year, month, day }, title:{ english } }
});

function providerMedia(family, index) {
    const [id, , english, format, year, month, day] = family[index];
    const edges = [relation("ADAPTATION", [91170, "", "Source novel", "NOVEL", 2014, 4, 10], "MANGA")];
    if (index > 0) edges.push(relation("PREQUEL", family[index - 1]));
    if (index < family.length - 1) edges.push(relation("SEQUEL", family[index + 1]));
    return {
        id, type:"ANIME", format, startDate:{ year, month, day },
        title:{ english }, synonyms:[],
        relations:{ edges }
    };
}

function localRecord(family, index, extra = {}) {
    const [id, title, , format, year, month, day] = family[index];
    const watched = format === "MOVIE" ? index % 2 : index + 1;
    return {
        id:`local-${id}`,
        anilistId:id, sourceId:String(id), source:"anilist", identitySource:"user-confirmed-anilist",
        title, format, year, startDate:{ year, month, day },
        category:["backlog", "completed", "review", "waiting", "watching"][index % 5],
        episodes:format === "MOVIE" ? 1 : 13,
        watched, currentEpisode:watched, reviewWatched:2, notes:`測試筆記 ${id}`,
        rating:8, favorite:true, watchHistory:[{ episode:1 }], updatedAt:"2026-01-09T02:00:00.000Z",
        ...extra
    };
}

function verifiedRecord(family, index, extra) {
    const media = providerMedia(family, index);
    return localRecord(family, index, {
        seriesMetadata:V.buildVerifiedAnimeSeriesMetadata(media, String(media.id)),
        ...extra
    });
}

const trackingFields = [
    "id", "anilistId", "sourceId", "watched", "currentEpisode", "reviewWatched",
    "notes", "rating", "favorite", "watchHistory", "category"
];
const tracking = record => Object.fromEntries(trackingFields.map(field => [field, record[field]]));

test("verified AniList IDs use the exact localized title, format and premiere of each work", () => {
    for (const [family, groupTitle] of [[rascal, "青春豬頭少年"], [darling, "戀上換裝娃娃"]]) {
        for (const [index, [id, title, , format, year, month, day]] of family.entries()) {
            const media = providerMedia(family, index);
            const metadata = V.buildVerifiedAnimeSeriesMetadata(media, String(id));
            assert.ok(metadata, String(id));
            assert.equal(metadata.source, "anilist");
            assert.equal(metadata.id, String(id));
            assert.equal(metadata.title, title);
            assert.equal(metadata.groupTitle, groupTitle);
            assert.equal(metadata.format, format);
            assert.deepEqual(metadata.startDate, { year, month, day });
            assert.ok(!metadata.relations.some(edge => edge.node?.type === "MANGA"));
            assert.ok(!V.buildVerifiedAnimeSeriesMetadata(media, String(id + 1)));
        }
    }
});

test("verified relations group cross-category seasons and movies without merging tracking records", () => {
    const rows = [
        ...rascal.map((_, index) => verifiedRecord(rascal, index)),
        ...darling.map((_, index) => verifiedRecord(darling, index))
    ];
    const assigned = V.assignAnimeSeriesIdentity(rows);
    assert.equal(assigned.list.length, rows.length);
    assert.deepEqual(assigned.list.map(tracking), rows.map(tracking));
    const entries = V.buildAnimeSeriesIdentity(assigned.list).entries;
    const rascalKeys = new Set(entries.slice(0, rascal.length).map(entry => entry.seriesKey));
    const darlingKeys = new Set(entries.slice(rascal.length).map(entry => entry.seriesKey));
    assert.equal(rascalKeys.size, 1);
    assert.equal(darlingKeys.size, 1);
    assert.notEqual([...rascalKeys][0], [...darlingKeys][0]);
});

test("one-sided verified relations recover a missing graph without trusting similar legacy titles", () => {
    const first = localRecord(darling, 0, { title:"更衣人偶墜入愛河", relations:undefined });
    const second = verifiedRecord(darling, 1, { title:"更衣人偶墜入愛河 第二季" });
    const unrelated = [
        { id:"no-provider-one", title:"戀上換裝娃娃", groupTitle:"戀上換裝娃娃" },
        { id:"no-provider-two", title:"戀上換裝娃娃 第二季", groupTitle:"戀上換裝娃娃" },
        { ...localRecord(darling, 0), id:"wrong-provider", source:"manual", sourceId:"990001", anilistId:990001,
            relations:[relation("SEQUEL", darling[1])] }
    ];
    const { entries } = V.buildAnimeSeriesIdentity([first, second, ...unrelated]);
    assert.equal(entries[0].seriesKey, entries[1].seriesKey);
    assert.equal(new Set(entries.slice(1).map(entry => entry.seriesKey)).size, 4);
});

test("generic exact AniList relations also group arbitrary works with different names", () => {
    const family = [
        [990003, "完全不同的第一個名稱", "First original title", "TV", 2004, 2, 7],
        [990004, "另一個電影名稱", "Second title", "MOVIE", 2007, 9, 8]
    ];
    const media = providerMedia(family, 1);
    const first = localRecord(family, 0, { relations:undefined });
    const second = localRecord(family, 1, {
        seriesMetadata:V.buildVerifiedAnimeSeriesMetadata(media, String(media.id))
    });
    const { entries } = V.buildAnimeSeriesIdentity([first, second]);
    assert.equal(entries[0].seriesKey, entries[1].seriesKey);
});

test("the two 2023 Rascal movies sort by the verified month and day", () => {
    const ordered = [3, 2, 1, 4, 0, 5].map(index => verifiedRecord(rascal, index))
        .sort(V.compareAnimeSeriesRelease);
    assert.deepEqual(ordered.map(record => record.anilistId), rascal.map(([id]) => id));
    assert.equal(V.getAnimeTitlePresentation(ordered[2]).title, rascal[2][1]);
    assert.equal(V.getAnimeTitlePresentation(ordered[3]).title, rascal[3][1]);
});

test("same-year title conflict and incorrect premiere or format require explicit confirmation", () => {
    const titleConflict = verifiedRecord(rascal, 2, { title:rascal[3][1] });
    const datedConflict = verifiedRecord(rascal, 1, {
        title:rascal[2][1], year:2023, startDate:{ year:2023, month:6, day:23 }, format:"TV"
    });
    const original = structuredClone(datedConflict);
    assert.ok(V.getAnimeSeriesMetadataReview(titleConflict)?.titleConflict);
    const review = V.getAnimeSeriesMetadataReview(datedConflict);
    assert.ok(review?.titleConflict);
    assert.ok(review?.dateConflict);
    assert.ok(review?.formatConflict);
    assert.equal(V.getAnimeTitlePresentation(datedConflict).title, original.title);
    assert.deepEqual(datedConflict, original);
    const confirmed = V.applyConfirmedAnimeSeriesMetadata(datedConflict);
    assert.deepEqual(datedConflict, original);
    assert.deepEqual(tracking(confirmed), tracking(original));
    assert.equal(V.getAnimeTitlePresentation(confirmed).title, rascal[1][1]);
    assert.equal(V.getAnimeTitlePresentation(confirmed).year, 2019);
    assert.equal(confirmed.format, "MOVIE");
    assert.ok(!V.getAnimeSeriesMetadataReview(confirmed)?.dateConflict);
    const watchHistory = [{ id:"movie-progress", animeId:datedConflict.id, delta:1, at:"2026-01-09T02:00:00.000Z" }];
    const backup = V.createBackup({ animeList:[confirmed, titleConflict], watchHistory }, { preserveStoredRecords:true });
    assert.deepEqual(backup.watchHistory, watchHistory);
    assert.deepEqual(backup[V.STORAGE_KEY].map(tracking), [tracking(datedConflict), tracking(titleConflict)]);
});

test("confirmed metadata cannot change a manually edited title", () => {
    const record = verifiedRecord(darling, 1, {
        title:"我的手動標題", titleSource:"manual", titleManuallyEdited:true,
        year:2024, startDate:{ year:2024, month:1, day:1 }
    });
    assert.ok(V.getAnimeSeriesMetadataReview(record)?.dateConflict);
    const confirmed = V.applyConfirmedAnimeSeriesMetadata(record);
    assert.equal(confirmed.title, record.title);
    assert.equal(confirmed.titleSource, record.titleSource);
    assert.equal(confirmed.titleManuallyEdited, true);
    assert.equal(V.getAnimeTitlePresentation(confirmed).title, record.title);
    assert.deepEqual(tracking(confirmed), tracking(record));
});

test("the previous translation is searchable for both verified Dress-Up Darling seasons", () => {
    const rows = darling.map((_, index) => verifiedRecord(darling, index));
    assert.deepEqual(rows.map(row => V.getAnimeTitlePresentation(row).title), darling.map(row => row[1]));
    const result = V.searchFilterSort(rows, "更衣人偶墜入愛河");
    assert.deepEqual(result.map(row => row.anilistId).sort(), darling.map(row => row[0]).sort());
});
