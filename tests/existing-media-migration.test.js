"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const titleStart = html.indexOf("function stripDisplayYear");
const titleEnd = html.indexOf("async function searchWikipedia", titleStart);
const migrationStart = html.indexOf("function isMediaClearlyNotYetReleased");
const migrationEnd = html.indexOf("function buildAnimeRecordFromMedia", migrationStart);
const identityStart = html.indexOf("function getAniListMediaId");
const identityEnd = html.indexOf("function getMediaIdentityTitles", identityStart);
for (const position of [titleStart, titleEnd, migrationStart, migrationEnd, identityStart, identityEnd]) {
    assert.ok(position >= 0, "找不到 existing media migration 相依函式");
}

const api = Function(`${html.slice(titleStart, titleEnd)}
${html.slice(identityStart, identityEnd)}
${html.slice(migrationStart, migrationEnd)}
return { stripDisplayYear, migrateExistingAnimeRecords, applyAutomaticCategoryFromMedia };`)();

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.stack}`); }
}

const parentRelation = {
    relationType:"PARENT",
    node:{
        id:154587,
        type:"ANIME",
        format:"TV",
        title:{ native:"葬送のフリーレン", english:"Frieren: Beyond Journey’s End", romaji:"Sousou no Frieren" },
        synonyms:["葬送的芙莉蓮"]
    }
};

function legacyStorageRecords() {
    return [
        {
            id:170068,
            anilistId:170068,
            title:"葬送的芙莉蓮（ONA）（2023）",
            displayTitle:"葬送的芙莉蓮（ONA）（2023）",
            canonicalTitle:"葬送的芙莉蓮（ONA）",
            groupTitle:"葬送的芙莉蓮",
            titleSource:"generated",
            titleManuallyEdited:false,
            anilistTitles:{ native:"葬送のフリーレン ～●●の魔法～", english:"", romaji:"Sousou no Frieren: ●● no Mahou" },
            aliases:["Sousou no Frieren Mini Anime"],
            relations:[parentRelation],
            format:"ONA",
            status:"FINISHED",
            startDate:{year:2023,month:10,day:11},
            year:2023,
            category:"backlog",
            unknownUserField:"keep-170068"
        },
        {
            id:189513,
            anilistId:189513,
            title:"葬送的芙莉蓮 Part 2（2025）",
            displayTitle:"葬送的芙莉蓮 Part 2（2025）",
            canonicalTitle:"葬送的芙莉蓮 Part 2",
            groupTitle:"葬送的芙莉蓮",
            titleSource:"generated",
            titleManuallyEdited:false,
            anilistTitles:{ native:"葬送のフリーレン ～●●の魔法～ 2クール", english:"", romaji:"Sousou no Frieren: ●● no Mahou Part 2" },
            aliases:["Frieren: Beyond Journey’s End Mini Anime"],
            relations:[parentRelation],
            format:"ONA",
            status:"FINISHED",
            startDate:{year:2025,month:4,day:2},
            year:2025,
            category:"backlog",
            unknownUserField:"keep-189513"
        },
        {
            id:209939,
            anilistId:209939,
            title:"葬送的芙莉蓮 第三季（2027）",
            displayTitle:"葬送的芙莉蓮 第三季（2027）",
            canonicalTitle:"葬送的芙莉蓮 第三季",
            groupTitle:"葬送的芙莉蓮",
            titleSource:"generated",
            titleManuallyEdited:false,
            anilistTitles:{ native:"葬送のフリーレン 第3期", english:"", romaji:"Sousou no Frieren 3rd Season" },
            aliases:["葬送的芙莉蓮"],
            relations:[],
            format:"TV",
            status:"NOT_YET_RELEASED",
            startDate:{year:2027,month:10,day:null},
            year:2027,
            category:"backlog",
            categorySource:"automatic",
            categoryManuallyEdited:false,
            unknownUserField:"keep-209939"
        },
        {
            id:206425,
            anilistId:206425,
            title:"葬送的芙莉蓮 第二季（2026）",
            displayTitle:"葬送的芙莉蓮 第二季（2026）",
            canonicalTitle:"葬送的芙莉蓮 第二季",
            groupTitle:"葬送的芙莉蓮",
            titleManuallyEdited:false,
            anilistTitles:{ native:"葬送のフリーレン ～●●の魔法～ 3クール", english:"", romaji:"Sousou no Frieren: ●● no Mahou Part 3" },
            aliases:["Sousou no Frieren 2nd Season Mini Anime", "Frieren: Beyond Journey's End Season 2 Mini Anime"],
            relations:[parentRelation],
            format:"ONA",
            status:"RELEASING",
            startDate:{year:2026,month:1,day:19},
            year:2026,
            category:"backlog",
            unknownUserField:"keep-206425"
        }
    ];
}

test("startup 使用真實 existing-record migration 路徑", () => {
    const loadSource = html.slice(html.indexOf("function loadStoredAnime"), html.indexOf("function saveAndRender"));
    assert.match(loadSource, /migrateExistingAnimeRecords\(animeList\)/u);
    assert.match(loadSource, /anime_tracker_existing_media_migration_backup_v1/u);
});

test("舊 storage 三筆資料一次升級標題與 waiting category", () => {
    const storage = JSON.stringify(legacyStorageRecords());
    const first = api.migrateExistingAnimeRecords(JSON.parse(storage), new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(first.changed, true);
    assert.equal(first.report.titleChanged, 3);
    assert.equal(first.report.categoryChanged, 1);
    const byId = Object.fromEntries(first.list.map(item => [String(item.anilistId), item]));
    assert.equal(api.stripDisplayYear(byId["170068"].title), "葬送的芙莉蓮【●●の魔法】");
    assert.equal(api.stripDisplayYear(byId["189513"].title), "葬送的芙莉蓮【●●の魔法 2クール】");
    assert.equal(byId["170068"].groupTitle, "葬送的芙莉蓮");
    assert.equal(byId["189513"].groupTitle, "葬送的芙莉蓮");
    assert.equal(byId["209939"].category, "waiting");
    assert.equal(byId["209939"].categorySource, "automatic");
    assert.equal(byId["209939"].unknownUserField, "keep-209939");
    assert.equal(api.stripDisplayYear(byId["206425"].title), "葬送的芙莉蓮【●●の魔法 3クール】");
    assert.equal(byId["206425"].format, "ONA");
    assert.equal(byId["206425"].unknownUserField, "keep-206425");
});

test("第二次 startup migration 為 0 changes 且資料完全相同", () => {
    const first = api.migrateExistingAnimeRecords(legacyStorageRecords(), new Date("2026-08-11T00:00:00.000Z"));
    const serialized = JSON.parse(JSON.stringify(first.list));
    const second = api.migrateExistingAnimeRecords(serialized, new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(second.changed, false);
    assert.deepEqual(second.report, { titleChanged:0, categoryChanged:0, metadataChanged:0, totalChanged:0, changes:[] });
    assert.deepEqual(second.list, serialized);
});

test("人工標題與人工分類不被 existing migration 覆蓋", () => {
    const records = legacyStorageRecords();
    records[0].title = records[0].displayTitle = "My Manual ONA";
    records[0].titleSource = "manual";
    records[0].titleManuallyEdited = true;
    records[2].category = "backlog";
    records[2].categorySource = "manual";
    records[2].categoryManuallyEdited = true;
    const result = api.migrateExistingAnimeRecords(records, new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(result.list[0].title, "My Manual ONA");
    assert.equal(result.list[2].category, "backlog");
});

test("metadata refresh 共用 automatic waiting 修正", () => {
    const anime = { category:"backlog", categorySource:"automatic", categoryManuallyEdited:false };
    const changed = api.applyAutomaticCategoryFromMedia(anime, {
        status:"NOT_YET_RELEASED",
        startDate:{year:2027,month:10,day:null}
    }, new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(changed, true);
    assert.equal(anime.category, "waiting");
});

test("可靠 relation parent 優先於歷史錯誤 groupTitle", () => {
    const record = {
        id:182255,
        anilistId:109261,
        title:"葬送的芙莉蓮 第二季（2021）",
        displayTitle:"葬送的芙莉蓮 第二季（2021）",
        canonicalTitle:"葬送的芙莉蓮 第二季",
        groupTitle:"葬送的芙莉蓮",
        titleSource:"generated",
        titleManuallyEdited:false,
        anilistTitles:{ native:"五等分の花嫁∬", english:"The Quintessential Quintuplets 2", romaji:"Go-toubun no Hanayome ∬" },
        aliases:["葬送的芙莉蓮 第二季", "五等分的新娘∬"],
        relations:[{
            relationType:"PREQUEL",
            node:{ title:{native:"五等分の花嫁"}, synonyms:["五等分的新娘"] }
        }],
        format:"TV",
        status:"FINISHED",
        startDate:{year:2021,month:1,day:8},
        year:2021,
        category:"backlog"
    };
    const result = api.migrateExistingAnimeRecords([record], new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(result.changed, true);
    assert.equal(result.list[0].title, "五等分的新娘∬（2021）");
    assert.equal(result.list[0].groupTitle, "五等分的新娘");
});

test("已完結且 releasedEpisodes 已知時修復未知總集數", () => {
    const record = {
        id:"frieren-local-uuid",
        anilistId:182255,
        sourceId:"182255",
        title:"葬送的芙莉蓮 第二季（2026）",
        displayTitle:"葬送的芙莉蓮 第二季（2026）",
        canonicalTitle:"葬送的芙莉蓮 第二季",
        groupTitle:"葬送的芙莉蓮",
        titleSource:"alias",
        titleManuallyEdited:false,
        anilistTitles:{native:"葬送のフリーレン 第2期",english:"Frieren: Beyond Journey’s End Season 2",romaji:"Sousou no Frieren 2nd Season"},
        aliases:["葬送的芙莉蓮 第二季"],
        relations:[parentRelation],
        format:"TV",
        status:"FINISHED",
        episodes:"??",
        totalEpisodes:"??",
        releasedEpisodes:10,
        startDate:{year:2026,month:1,day:16},
        year:2026,
        category:"backlog",
        watched:0,
        currentEpisode:0
    };
    const first = api.migrateExistingAnimeRecords([record], new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(first.list[0].episodes, 10);
    assert.equal(first.list[0].totalEpisodes, 10);
    assert.equal(first.list[0].watched, 0);
    assert.equal(first.report.metadataChanged, 1);
    const second = api.migrateExistingAnimeRecords(JSON.parse(JSON.stringify(first.list)), new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(second.changed, false);
    assert.deepEqual(second.list, first.list);
});

if (!process.exitCode) console.log(`\nExisting media migration integration tests passed: ${passed}/${passed}`);
