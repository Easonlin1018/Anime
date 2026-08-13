"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("function stripDisplayYear");
const end = html.indexOf("async function searchWikipedia", start);
assert.ok(start >= 0 && end > start, "找不到標題產生函式");
const code = html.slice(start, end);
const api = Function(`${code}; return { getCoreTitle, getSeriesGroupTitle, getSmartTitleDetails, generateSmartTitle, detectMediaSeasonNumber, isLegacyGeneratedTitle, refreshGeneratedAnimeTitle, compareSeriesMediaByStartDate };`)();
const sequelStart = html.indexOf("function getAniListMediaId");
const sequelEnd = html.indexOf("async function manualScanSequels", sequelStart);
assert.ok(sequelStart >= 0 && sequelEnd > sequelStart, "找不到續作 traversal 函式");
const sequelCode = html.slice(sequelStart, sequelEnd);
const sequelApi = Function(`${code}\n${sequelCode}; return { getAniListMediaId, getExistingAnimeMediaState, addOrRestoreSingleMedia, findExistingAnimeForMedia, attachAniListIdToLegacyAnime, getDirectSequelNodes, walkAniListSequelGraph, reconcileDiscoveredSequelMedia };`)();
const aliasStart = html.indexOf("function normalizeAnimeAliasList");
const aliasEnd = html.indexOf("function deriveAliasVariants", aliasStart);
const metadataStart = html.indexOf("function normalizeStreamingLinks");
const metadataEnd = html.indexOf("async function searchAnime", metadataStart);
assert.ok(aliasStart >= 0 && aliasEnd > aliasStart, "找不到 alias metadata helpers");
assert.ok(metadataStart >= 0 && metadataEnd > metadataStart, "找不到 metadata refresh helpers");
const aliasCode = html.slice(aliasStart, aliasEnd);
const metadataCode = html.slice(metadataStart, metadataEnd);
const metadataApi = Function(`${code}\n${aliasCode}\n${metadataCode}; return { MEDIA_METADATA_MANAGED_FIELDS, buildMediaMetadataPatch, applyMetadataManagedPatch, applyMediaMetadata };`)();

let passed = 0;
const pending = [];
function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === "function") {
            pending.push(result.then(() => {
                passed++;
                console.log(`✓ ${name}`);
            }).catch(error => {
                console.error(`✗ ${name}\n  ${error.stack}`);
                process.exitCode = 1;
            }));
            return;
        }
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}\n  ${error.stack}`);
        process.exitCode = 1;
    }
}

const media = overrides => ({
    title: {},
    synonyms: [],
    format: "TV",
    relationType: "SEQUEL",
    startDate: {},
    ...overrides
});

test("A. 特殊正式續作名不被母作品覆蓋", () => {
    const value = api.generateSmartTitle(media({
        title: { native: "五等分の花嫁＊" },
        format: "SPECIAL",
        startDate: { year: 2024 }
    }), "五等分的花嫁（2019）", "五等分的新娘", "典型的五胞胎*");
    assert.equal(value, "五等分的花嫁＊（2024）");
});

test("B. 明確第二季可整理成中文季數", () => {
    const value = api.generateSmartTitle(media({
        title: { english: "Example 2nd Season", romaji: "Example Season 2" },
        startDate: { year: 2024 }
    }), "範例作品（2022）");
    assert.equal(value, "範例作品 第二季（2024）");
});

test("C. 明確第三季可整理成中文季數", () => {
    const value = api.generateSmartTitle(media({
        title: { native: "範例作品 第3期", english: "Example 3rd Season" },
        startDate: { year: 2025 }
    }), "範例作品（2022）");
    assert.equal(value, "範例作品 第三季（2025）");
});

test("D. 電影版有正式名稱時保留完整名稱", () => {
    const value = api.generateSmartTitle(media({
        title: { traditionalChinese: "電影版 五等分的花嫁", native: "映画 五等分の花嫁" },
        format: "MOVIE",
        startDate: { year: 2022 }
    }), "五等分的花嫁（2019）", null, "電影 典型五胞胎");
    assert.equal(value, "電影版 五等分的花嫁（2022）");
});

test("E. SPECIAL 有正式名稱時保留正式名稱", () => {
    const value = api.generateSmartTitle(media({
        title: { traditionalChinese: "五等分的花嫁∽", native: "五等分の花嫁∽" },
        format: "SPECIAL",
        startDate: { year: 2023 }
    }), "五等分的花嫁（2019）");
    assert.equal(value, "五等分的花嫁∽（2023）");
});

test("F. 沒有年份時不產生空括號", () => {
    const value = api.generateSmartTitle(media({ title: { traditionalChinese: "獨立續作名" } }), "母作品");
    assert.equal(value, "獨立續作名");
    assert.doesNotMatch(value, /undefined|null|[（(][）)]/u);
});

test("G. 完全沒有有效名稱才使用續篇 fallback", () => {
    const details = api.getSmartTitleDetails(media({ title: {}, startDate: { year: 2026 } }), "母作品（2020）");
    assert.equal(details.displayTitle, "母作品（續篇・2026）");
    assert.equal(details.usedFallback, true);
});

test("沒有電影正式名稱時才使用劇場版 fallback", () => {
    const value = api.generateSmartTitle(media({ title: {}, format: "MOVIE", startDate: { year: 2022 } }), "五等分的花嫁（2019）");
    assert.equal(value, "五等分的花嫁（劇場版・2022）");
});

test("顯示年份不影響五等分系列分組", () => {
    const titles = [
        "五等分的花嫁（2019）",
        "五等分的花嫁∬（2021）",
        "電影版 五等分的花嫁（2022）",
        "五等分的花嫁∽（2023）",
        "五等分的花嫁＊（2024）"
    ];
    assert.deepEqual(new Set(titles.map(api.getCoreTitle)), new Set(["五等分的花嫁"]));
});

test("舊泛用續篇名稱可在 metadata 同步時更新", () => {
    const anime = { title: "五等分的花嫁 (續篇 - 2024年)", watched: 7, rating: 9, note: "保留" };
    const changed = api.refreshGeneratedAnimeTitle(anime, media({
        title: { native: "五等分の花嫁＊", english: "The Quintessential Quintuplets Specials 2" },
        format: "SPECIAL",
        startDate: { year: 2024 }
    }));
    assert.equal(changed, true);
    assert.equal(anime.title, "五等分的花嫁＊（2024）");
    assert.deepEqual([anime.watched, anime.rating, anime.note], [7, 9, "保留"]);
});

test("真正人工改名不會被 metadata 覆蓋", () => {
    const anime = { title: "我的自訂名稱", titleSource: "manual", titleManuallyEdited: true };
    const changed = api.refreshGeneratedAnimeTitle(anime, media({
        title: { native: "官方名稱" },
        startDate: { year: 2024 }
    }));
    assert.equal(changed, false);
    assert.equal(anime.title, "我的自訂名稱");
});

test("實際 AniList 五等分 metadata 產生完整正式名稱與共同 groupTitle", () => {
    const parent = "五等分的花嫁（2019）";
    const fixtures = [
        { id: 103572, title: { native: "五等分の花嫁", romaji: "Go-toubun no Hanayome", english: "The Quintessential Quintuplets" }, startDate: { year: 2019 }, format: "TV", google: "典型的五胞胎", expected: "五等分的花嫁（2019）" },
        { id: 109261, title: { native: "五等分の花嫁∬", romaji: "Go-toubun no Hanayome ∬", english: "The Quintessential Quintuplets 2" }, startDate: { year: 2021 }, format: "TV", google: "典型的五胞胎∬", expected: "五等分的花嫁∬（2021）" },
        { id: 131520, title: { native: "映画 五等分の花嫁", romaji: "Go-toubun no Hanayome Movie", english: "The Quintessential Quintuplets Movie" }, startDate: { year: 2022 }, format: "MOVIE", google: "電影 典型五胞胎", expected: "電影版 五等分的花嫁（2022）" },
        { id: 163327, title: { native: "五等分の花嫁∽", romaji: "Go-toubun no Hanayome∽", english: "The Quintessential Quintuplets Specials" }, startDate: { year: 2023 }, format: "SPECIAL", google: "典型的五胞胎∽", expected: "五等分的花嫁∽（2023）" },
        { id: 177191, title: { native: "五等分の花嫁＊", romaji: "Go-toubun no Hanayome *", english: "The Quintessential Quintuplets Specials 2" }, startDate: { year: 2024 }, format: "SPECIAL", google: "典型的五胞胎*", expected: "五等分的花嫁＊（2024）" }
    ];

    const actual = fixtures.map((item, index) => index === 0
        ? api.getSmartTitleDetails(item, null, "五等分的花嫁", item.google)
        : api.getSmartTitleDetails(item, parent, null, item.google));
    assert.deepEqual(actual.map(item => item.displayTitle), fixtures.map(item => item.expected));
    assert.deepEqual(new Set(actual.map(item => item.groupTitle)), new Set(["五等分的花嫁"]));
});

test("語言回歸 A. 中文 parent 不被 romaji sequel 覆蓋", () => {
    const details = api.getSmartTitleDetails(media({
        title: { romaji:"Sousou no Frieren: New Journey" },
        startDate: { year:2025 }
    }), "葬送的芙莉蓮（2023）");
    assert.doesNotMatch(details.displayTitle, /Sousou no Frieren/i);
    assert.match(details.displayTitle, /^葬送的芙莉蓮/u);
});

test("語言回歸 B. 中文 parent 不被 English sequel 覆蓋", () => {
    const details = api.getSmartTitleDetails(media({
        title: { english:"The Quintessential Quintuplets New Animation" },
        startDate: { year:2026 }
    }), "五等分的花嫁（2019）");
    assert.doesNotMatch(details.displayTitle, /Quintessential/i);
    assert.match(details.displayTitle, /^五等分的花嫁/u);
});

test("語言回歸 C. 五等分 Shinsaku OVA 使用中文母作品", () => {
    const details = api.getSmartTitleDetails(media({
        title: { romaji:"Go-toubun no Hanayome (Shinsaku OVA)" },
        format:"OVA",
        startDate: { year:2026 }
    }), "五等分的花嫁（2019）");
    assert.equal(details.displayTitle, "五等分的花嫁（新作 OVA）（2026）");
    assert.equal(details.groupTitle, "五等分的花嫁");
});

test("語言回歸 D. 五等分 Shunkashuutou 使用已確認中文短標記", () => {
    const details = api.getSmartTitleDetails(media({
        title: { romaji:"Go-toubun no Hanayome: Shunkashuutou" }
    }), "五等分的花嫁（2019）");
    assert.equal(details.displayTitle, "五等分的花嫁【春夏秋冬】");
    assert.equal(details.groupTitle, "五等分的花嫁");
});

test("語言回歸 E. 葬送的芙莉蓮 Part 2 保留中文系列名稱", () => {
    const details = api.getSmartTitleDetails(media({
        title: { romaji:"Sousou no Frieren: Beyond Journey's End Part 2" },
        startDate: { year:2025 }
    }), "葬送的芙莉蓮（2023）");
    assert.equal(details.displayTitle, "葬送的芙莉蓮 Part 2（2025）");
    assert.equal(details.groupTitle, "葬送的芙莉蓮");
});

test("芙莉蓮本傳 metadata 無續作證據時保留中文名稱", () => {
    const details = api.getSmartTitleDetails({
        title:{romaji:"Sousou no Frieren: Beyond Journey's End"},
        format:"TV",
        startDate:{year:2023}
    }, "葬送的芙莉蓮");
    assert.equal(details.displayTitle, "葬送的芙莉蓮（2023）");
    assert.equal(details.groupTitle, "葬送的芙莉蓮");
});

test("語言回歸 F. 完全沒有中文 context 才允許 romaji fallback", () => {
    const details = api.getSmartTitleDetails(media({
        title: { romaji:"Original Romaji Sequel" },
        startDate: { year:2027 }
    }), null);
    assert.equal(details.displayTitle, "Original Romaji Sequel（2027）");
});

test("語言回歸 G. 人工英文名稱不被 metadata refresh 改中文", () => {
    const anime = { title:"My Manual English Title", displayTitle:"My Manual English Title", manualTitle:true, titleSource:"anilist", groupTitle:"五等分的花嫁" };
    const changed = api.refreshGeneratedAnimeTitle(anime, media({
        title: { romaji:"Go-toubun no Hanayome (Shinsaku OVA)" },
        format:"OVA"
    }));
    assert.equal(changed, false);
    assert.equal(anime.title, "My Manual English Title");
});

test("語言回歸 H. 中文 displayTitle 不改變 groupTitle", () => {
    const entries = [
        media({ title:{romaji:"Go-toubun no Hanayome (Shinsaku OVA)"}, format:"OVA" }),
        media({ title:{romaji:"Go-toubun no Hanayome: Shunkashuutou"}, format:"SPECIAL" })
    ].map(item => api.getSmartTitleDetails(item, "五等分的花嫁（2019）"));
    assert.deepEqual(new Set(entries.map(item => item.groupTitle)), new Set(["五等分的花嫁"]));
    assert.ok(entries.every(item => !/Go-toubun/i.test(item.displayTitle)));
});

test("未區分續作的中文欄位不會蓋掉官方特殊符號", () => {
    const details = api.getSmartTitleDetails(media({
        title:{traditionalChinese:"五等分的花嫁",native:"五等分の花嫁＊"},
        format:"SPECIAL",
        startDate:{year:2024}
    }), "五等分的花嫁（2019）");
    assert.equal(details.displayTitle, "五等分的花嫁＊（2024）");
});

test("舊 romaji 非人工名稱可在中文 context 下自動升級", () => {
    const anime = { title:"Sousou no Frieren: Beyond Journey's End Part 2（2025）", displayTitle:"Sousou no Frieren: Beyond Journey's End Part 2（2025）", titleSource:"anilist", groupTitle:"葬送的芙莉蓮", aliases:["葬送的芙莉蓮"] };
    const changed = api.refreshGeneratedAnimeTitle(anime, media({
        title:{romaji:"Sousou no Frieren: Beyond Journey's End Part 2"},
        startDate:{year:2025}
    }));
    assert.equal(changed, true);
    assert.equal(anime.title, "葬送的芙莉蓮 Part 2（2025）");
    assert.equal(anime.groupTitle, "葬送的芙莉蓮");
});

test("實際 AniList SEQUEL 鏈跨 TV、SPECIAL、MOVIE 不會中斷", async () => {
    const graph = new Map([
        [103572, { id: 103572, title: "五等分的花嫁（2019）", startDate: { year: 2019, month: 1, day: 11 }, format: "TV", relations: [{ relationType: "SEQUEL", node: { id: 109261, type: "ANIME", format: "TV" } }] }],
        [109261, { id: 109261, title: "五等分的花嫁∬（2021）", startDate: { year: 2021, month: 1, day: 8 }, format: "TV", relations: { edges: [{ relationType: "SEQUEL", node: { id: 163327, type: "ANIME", format: "SPECIAL" } }] } }],
        [163327, { id: 163327, title: "五等分的花嫁∽（2023）", startDate: { year: 2023, month: 9, day: 2 }, format: "SPECIAL", relations: { edges: [{ relationType: "SEQUEL", node: { id: 131520, type: "ANIME", format: "MOVIE" } }] } }],
        [131520, { id: 131520, title: "電影版 五等分的花嫁（2022）", startDate: { year: 2022, month: 5, day: 20 }, format: "MOVIE", relations: { edges: [{ relationType: "SEQUEL", node: { id: 177191, type: "ANIME", format: "SPECIAL" } }] } }],
        [177191, { id: 177191, title: "五等分的花嫁＊（2024）", startDate: { year: 2024, month: 9, day: 20 }, format: "SPECIAL", relations: { edges: [{ relationType: "SEQUEL", node: { id: 211709, type: "ANIME", format: "TV" } }] } }],
        [211709, { id: 211709, title: "五等分的花嫁【春夏秋冬】（1999）", startDate: { year: null, month: null, day: null }, format: "TV", relations: { edges: [] } }]
    ]);
    const result = await sequelApi.walkAniListSequelGraph(graph.get(103572), async id => graph.get(Number(id)), 8);
    assert.deepEqual(result.map(item => item.media.id), [109261, 163327, 131520, 177191, 211709]);
    assert.deepEqual(result.map(item => item.media.format), ["TV", "SPECIAL", "MOVIE", "SPECIAL", "TV"]);

    const displayOrder = [graph.get(103572), ...result.map(item => item.media)]
        .sort(api.compareSeriesMediaByStartDate)
        .map(item => item.id);
    assert.deepEqual(displayOrder, [103572, 109261, 131520, 163327, 177191, 211709]);
    assert.equal(graph.get(211709).title, "五等分的花嫁【春夏秋冬】（1999）", "不可使用標題內年份排序");
});

test("系列同年作品使用 month/day 排序", () => {
    const list = [
        { id: "late", title: "作品＊", startDate: { year: 2024, month: 9, day: 20 } },
        { id: "middle", title: "作品∽", startDate: { year: 2024, month: 1, day: 10 } },
        { id: "early", title: "電影版 作品", startDate: { year: 2024, month: 1, day: 2 } }
    ];
    assert.deepEqual(list.sort(api.compareSeriesMediaByStartDate).map(item => item.id), ["early", "middle", "late"]);
});

test("diamond relation 的共同節點只發現一次", async () => {
    const graph = new Map([
        [1, { id: 1, relations: { edges: [
            { relationType: "SEQUEL", node: { id: 2, type: "ANIME", format: "TV" } },
            { relationType: "SEQUEL", node: { id: 3, type: "ANIME", format: "SPECIAL" } }
        ] } }],
        [2, { id: 2, relations: { edges: [{ relationType: "SEQUEL", node: { id: 4, type: "ANIME", format: "MOVIE" } }] } }],
        [3, { id: 3, relations: { edges: [{ relationType: "SEQUEL", node: { id: "4", type: "ANIME", format: "MOVIE" } }] } }],
        [4, { id: 4, relations: { edges: [] } }]
    ]);
    const result = await sequelApi.walkAniListSequelGraph(graph.get(1), async id => graph.get(Number(id)), 8);
    assert.deepEqual(result.map(item => Number(item.media.id)), [2, 3, 4]);
    assert.equal(result.filter(item => Number(item.media.id) === 4).length, 1);
});

test("circular relation 由 visited set 正常終止", async () => {
    const graph = new Map([
        [1, { id: 1, relations: { edges: [{ relationType: "SEQUEL", node: { id: 2, type: "ANIME" } }] } }],
        [2, { id: 2, relations: { edges: [{ relationType: "SEQUEL", node: { id: 3, type: "ANIME" } }] } }],
        [3, { id: 3, relations: { edges: [{ relationType: "SEQUEL", node: { id: 1, type: "ANIME" } }] } }]
    ]);
    const result = await sequelApi.walkAniListSequelGraph(graph.get(1), async id => graph.get(Number(id)), 8);
    assert.deepEqual(result.map(item => item.media.id), [2, 3]);
});

test("已存在的 AniList ID 只 refresh、不重複新增", async () => {
    const list = [{ id:"local-200", anilistId:200, title: "既有作品", category: "completed", year: 2024, format: "OVA" }];
    let addCalls = 0;
    let refreshCalls = 0;
    const result = await sequelApi.reconcileDiscoveredSequelMedia(
        [{ media: { id: "200", title: { native: "Existing" }, startDate: { year: 2024 }, format: "OVA" } }],
        list,
        {
            addMedia() { addCalls++; return true; },
            refreshMedia(existing) { refreshCalls++; assert.equal(existing.category, "completed"); }
        }
    );
    assert.deepEqual(result, { added: 0, refreshed: 1 });
    assert.equal(addCalls, 0);
    assert.equal(refreshCalls, 1);
    assert.equal(list.length, 1);
});

test("同一 AniList ID 已在其他 category 時不複製", async () => {
    const list = [{ id:"local-300", anilistId:300, title: "跨分類作品", category: "backlog", year: 2023, format: "SPECIAL" }];
    const result = await sequelApi.reconcileDiscoveredSequelMedia(
        [{ media: { id: 300, title: { native: "跨分類作品" }, startDate: { year: 2023 }, format: "SPECIAL" } }],
        list,
        { addMedia() { throw new Error("不得新增重複作品"); } }
    );
    assert.equal(result.added, 0);
    assert.equal(list[0].category, "backlog");
    assert.equal(list.length, 1);
});

test("連續執行兩次 sequel reconcile，第二次新增 0 筆", async () => {
    const list = [];
    const discovered = [
        { media: { id: 401, title: { native: "作品 B" }, startDate: { year: 2024 }, format: "TV" } },
        { media: { id: 402, title: { native: "作品 C" }, startDate: { year: 2025 }, format: "ONA" } }
    ];
    const handlers = {
        addMedia(media) {
            list.push({ id: media.id, title: media.title.native, year: media.startDate.year, format: media.format, category: "waiting" });
            return true;
        }
    };
    const first = await sequelApi.reconcileDiscoveredSequelMedia(discovered, list, handlers);
    const second = await sequelApi.reconcileDiscoveredSequelMedia(discovered, list, handlers);
    assert.equal(first.added, 2);
    assert.equal(second.added, 0);
    assert.equal(list.length, 2);
});

test("舊資料無 AniList ID 時只用 title＋year＋format 保守去重", async () => {
    const legacy = { id: "legacy-uuid", title: "舊作品", aliases: ["Legacy Native"], year: 2022, format: "MOVIE", category: "completed" };
    const list = [legacy];
    const media = { id: 999, title: { native: "Legacy Native" }, startDate: { year: 2022 }, format: "MOVIE" };
    const result = await sequelApi.reconcileDiscoveredSequelMedia(
        [{ media }],
        list,
        { addMedia() { throw new Error("保守 fallback 已匹配，不應新增"); } }
    );
    assert.deepEqual(result, { added: 0, refreshed: 1 });
    assert.equal(legacy.id, "legacy-uuid");
    assert.equal(legacy.anilistId, 999);
    assert.equal(legacy.category, "completed");

    const differentKnownId = { id:"different-local", anilistId:1000, title: "Legacy Native", aliases: ["Legacy Native"], year: 2022, format: "MOVIE" };
    assert.equal(sequelApi.findExistingAnimeForMedia(media, [differentKnownId]), null, "不同 AniList ID 不可因同名合併");
});

test("renderList 只在系列群組內套用結構化日期排序", () => {
    assert.match(html, /for \(const \[seriesKey, group\] of seriesMap\.entries\(\)\) \{[\s\S]*?const series = group\.items;\s*series\.sort\(compareSeriesMediaByStartDate\)/u);
    assert.match(html, /AnimeTrackerV11\.getAnimeSeriesKey\(anime\)/u);
    assert.doesNotMatch(html, /compareSeriesMediaByStartDate\([^)]*title/u);
});

test("searchAnime 與 checkAndAddSequel 共用統一去重流程", () => {
    assert.match(html, /addOrRestoreSingleMedia\(media, animeList/u);
    assert.match(html, /getExistingAnimeMediaState\(media, list\)/u);
    assert.match(html, /reconcileDiscoveredSequelMedia\(chain, animeList/u);
});

test("續作探索明確傳遞 SEQUEL，不把一般 metadata refresh 當續作", () => {
    assert.match(html, /forcedRelationType\s*=\s*null/);
    assert.match(html, /media\s*=\s*\{\s*\.\.\.media,\s*relationType:forcedRelationType\s*\}/);
    assert.match(html, /searchAnime\(null,\s*isQuiet,\s*groupTitle,\s*media\.id,\s*null,\s*"SEQUEL"\)/);
});

function userManagedAnime(overrides = {}) {
    return {
        id: "local-anime-uuid",
        title: "使用者名稱",
        displayTitle: "使用者名稱",
        titleSource: "manual",
        titleManuallyEdited: true,
        manualTitle: "使用者名稱",
        category: "watching",
        watched: 8,
        currentEpisode: 8,
        progress: 8,
        rating: 9,
        score: 9,
        review: "使用者心得",
        note: "使用者筆記",
        notes: "相容筆記",
        memo: "私人備忘",
        customPlatform: "自訂平台",
        customPlatformUrl: "https://example.com/watch",
        eventState: { want: ["event-1"], hidden: ["event-2"] },
        eventOverrides: { "event-1": { venue: "人工場館" } },
        themeSongs: [{ type: "OP", title: "使用者主題曲" }],
        createdAt: "2024-01-01T00:00:00.000Z",
        addedAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-02-01T00:00:00.000Z",
        lastWatchedAt: "2024-01-31T00:00:00.000Z",
        streamingLinks: [{ site: "手動連結", url: "https://example.com/manual" }],
        customFutureField: "keep-me",
        ...overrides
    };
}

function refreshedMedia(overrides = {}) {
    return {
        id: 103572,
        title: {
            native: "五等分の花嫁",
            english: "The Quintessential Quintuplets",
            romaji: "Go-toubun no Hanayome"
        },
        synonyms: ["五等分的新娘"],
        status: "FINISHED",
        format: "TV",
        episodes: 12,
        startDate: { year: 2019, month: 1, day: 11 },
        nextAiringEpisode: null,
        externalLinks: [{ site: "Netflix", type: "STREAMING", url: "https://example.com/netflix" }],
        relations: { edges: [{ relationType: "SEQUEL", node: { id: 109261 } }] },
        ...overrides
    };
}

function userFieldSnapshot(anime) {
    const fields = [
        "id", "category", "watched", "currentEpisode", "progress", "rating", "score",
        "review", "note", "notes", "memo", "title", "displayTitle", "titleSource",
        "titleManuallyEdited", "manualTitle", "customPlatform", "customPlatformUrl", "eventState",
        "eventOverrides", "themeSongs", "createdAt", "addedAt", "updatedAt", "lastWatchedAt",
        "customFutureField"
    ];
    return Object.fromEntries(fields.map(field => [field, anime[field]]));
}

test("metadata refresh preserves watching progress and category", () => {
    const anime = userManagedAnime();
    const before = userFieldSnapshot(anime);
    metadataApi.applyMediaMetadata(anime, refreshedMedia(), "2026-08-09T00:00:00.000Z");
    assert.deepEqual(userFieldSnapshot(anime), before);
    assert.equal(anime.episodes, 12);
    assert.equal(anime.status, "FINISHED");
});

test("metadata refresh preserves every user category", () => {
    for (const category of ["watching", "backlog", "completed", "waiting"]) {
        const anime = userManagedAnime({ category });
        metadataApi.applyMediaMetadata(anime, refreshedMedia({ status: "RELEASING" }), "2026-08-09T00:00:00.000Z");
        assert.equal(anime.category, category);
    }
});

test("metadata refresh preserves completed rating and all note fields", () => {
    const anime = userManagedAnime({ category: "completed", watched: 12, currentEpisode: 12 });
    metadataApi.applyMediaMetadata(anime, refreshedMedia(), "2026-08-09T00:00:00.000Z");
    assert.deepEqual(
        [anime.category, anime.watched, anime.currentEpisode, anime.rating, anime.score, anime.review, anime.note, anime.notes, anime.memo],
        ["completed", 12, 12, 9, 9, "使用者心得", "使用者筆記", "相容筆記", "私人備忘"]
    );
});

test("manual title is never replaced by AniList metadata", () => {
    const anime = userManagedAnime({ title: "我的五等分名稱", displayTitle: "我的五等分名稱" });
    metadataApi.applyMediaMetadata(anime, refreshedMedia(), "2026-08-09T00:00:00.000Z");
    assert.equal(anime.title, "我的五等分名稱");
    assert.equal(anime.displayTitle, "我的五等分名稱");
    assert.equal(anime.titleSource, "manual");
});

test("custom platform and manual streaming data survive partial metadata", () => {
    const anime = userManagedAnime();
    metadataApi.applyMediaMetadata(
        anime,
        refreshedMedia({ externalLinks: undefined, nextAiringEpisode: undefined }),
        "2026-08-09T00:00:00.000Z"
    );
    assert.equal(anime.customPlatform, "自訂平台");
    assert.equal(anime.customPlatformUrl, "https://example.com/watch");
    assert.deepEqual(anime.streamingLinks, [{ site: "手動連結", url: "https://example.com/manual" }]);
});

test("adding AniList ID preserves local ID and every user field", () => {
    const anime = userManagedAnime();
    const before = userFieldSnapshot(anime);
    sequelApi.attachAniListIdToLegacyAnime(anime, refreshedMedia());
    metadataApi.applyMediaMetadata(anime, refreshedMedia(), "2026-08-09T00:00:00.000Z");
    assert.equal(anime.id, "local-anime-uuid");
    assert.equal(anime.anilistId, 103572);
    assert.deepEqual(userFieldSnapshot(anime), before);
});

test("null or undefined metadata never clears existing user data", () => {
    const anime = userManagedAnime({ status: "RELEASING", format: "TV", episodes: 24 });
    const before = userFieldSnapshot(anime);
    metadataApi.applyMediaMetadata(anime, {
        id: 103572,
        title: null,
        status: null,
        format: undefined,
        episodes: null,
        startDate: null,
        externalLinks: undefined,
        nextAiringEpisode: undefined,
        relations: undefined
    }, "2026-08-09T00:00:00.000Z");
    assert.deepEqual(userFieldSnapshot(anime), before);
    assert.deepEqual(anime.streamingLinks, [{ site: "手動連結", url: "https://example.com/manual" }]);
    assert.equal(anime.episodes, 24);
});

test("unknown future fields survive metadata refresh", () => {
    const anime = userManagedAnime({ customFutureObject: { nested: [1, 2, 3] } });
    metadataApi.applyMediaMetadata(anime, refreshedMedia(), "2026-08-09T00:00:00.000Z");
    assert.equal(anime.customFutureField, "keep-me");
    assert.deepEqual(anime.customFutureObject, { nested: [1, 2, 3] });
});

test("localStorage and Supabase style serialization preserves user-managed fields", () => {
    const anime = JSON.parse(JSON.stringify(userManagedAnime()));
    const before = userFieldSnapshot(anime);
    metadataApi.applyMediaMetadata(anime, refreshedMedia(), "2026-08-09T00:00:00.000Z");
    const serialized = JSON.parse(JSON.stringify([anime]))[0];
    assert.deepEqual(userFieldSnapshot(serialized), before);
    assert.equal(serialized.customFutureField, "keep-me");
});

test("repeated metadata refresh is idempotent", () => {
    const anime = userManagedAnime({ titleSource: "legacy", titleManuallyEdited: false, title: "五等分的新娘（續篇・2019）" });
    const media = refreshedMedia();
    metadataApi.applyMediaMetadata(anime, media, "2026-08-09T00:00:00.000Z");
    const once = JSON.parse(JSON.stringify(anime));
    metadataApi.applyMediaMetadata(anime, media, "2026-08-09T00:00:00.000Z");
    assert.deepEqual(anime, once);
});

test("metadata whitelist excludes all user-managed fields", () => {
    const managed = new Set(metadataApi.MEDIA_METADATA_MANAGED_FIELDS);
    for (const field of ["id", "category", "watched", "currentEpisode", "rating", "score", "review", "note", "notes", "memo", "manualTitle", "customPlatform", "themeSongs", "createdAt", "addedAt", "updatedAt", "lastWatchedAt", "customFutureField"]) {
        assert.equal(managed.has(field), false, `${field} must remain user-managed`);
    }
});

test("metadata sync resolves AniList ID without replacing the local ID", () => {
    assert.match(html, /AnimeTrackerV11\.collectActiveAnimeAniListIds\(animeList\)/u);
    assert.equal(typeof V.collectActiveAnimeAniListIds, "function");
    assert.match(html, /animeList\.find\(item => getAniListMediaId\(item\) === String\(media\.id\)\)/u);
    assert.match(html, /requestAniList\(ID_QUERY, \{ id: Number\(animeMediaId\) \}\)/u);
});

test("numeric local IDs never override explicit AniList identity", () => {
    const quintuplets = {
        id: 182255,
        anilistId: 109261,
        sourceId: "109261",
        source: "anilist",
        title: "五等分的新娘∬（2021）",
        canonicalTitle: "五等分の花嫁∬",
        groupTitle: "五等分的新娘",
        format: "TV",
        year: 2021,
        startDate: { year: 2021, month: 1, day: 8 },
        category: "completed",
        watched: 12,
        currentEpisode: 12,
        rating: 9
    };
    const frieren = {
        id: "60874ec5-271a-44ea-9d9d-9f15cc4f1979",
        anilistId: 182255,
        sourceId: "182255",
        source: "anilist",
        title: "葬送的芙莉蓮 第二季（2026）",
        canonicalTitle: "葬送のフリーレン 第2期",
        groupTitle: "葬送的芙莉蓮",
        format: "TV",
        year: 2026,
        startDate: { year: 2026, month: 1, day: 16 },
        category: "backlog",
        watched: 0,
        currentEpisode: 0,
        rating: null
    };

    metadataApi.applyMediaMetadata(quintuplets, refreshedMedia({
        id: 109261,
        title: { native: "五等分の花嫁∬", romaji: "Go-toubun no Hanayome ∬", english: "The Quintessential Quintuplets 2" },
        startDate: { year: 2021, month: 1, day: 8 }
    }), "2026-08-12T00:00:00.000Z");
    metadataApi.applyMediaMetadata(frieren, refreshedMedia({
        id: 182255,
        title: { native: "葬送のフリーレン 第2期", romaji: "Sousou no Frieren 2nd Season", english: "Frieren: Beyond Journey's End Season 2" },
        episodes: 10,
        startDate: { year: 2026, month: 1, day: 16 }
    }), "2026-08-12T00:00:00.000Z");

    const serialized = JSON.parse(JSON.stringify([quintuplets, frieren]));
    const reconciled = V.reconcileExistingAnimeDuplicates(serialized).list;
    assert.equal(reconciled.length, 2);
    const byLocalId = new Map(reconciled.map(item => [String(item.id), item]));
    assert.equal(V.getAnimeAniListIdentity(byLocalId.get("182255")), "109261");
    assert.equal(V.getAnimeAniListIdentity(byLocalId.get("60874ec5-271a-44ea-9d9d-9f15cc4f1979")), "182255");
    assert.equal(byLocalId.get("182255").watched, 12);
    assert.equal(byLocalId.get("60874ec5-271a-44ea-9d9d-9f15cc4f1979").episodes, 10);
    assert.equal(V.getAnimeAniListIdentity({ id: 153554, title: "legacy record without external identity" }), "");
});

test("芙莉蓮迷你動畫保留可辨識副標題，不退化成泛用 ONA", () => {
    const value = api.generateSmartTitle(media({
        id: 170068,
        title: {
            native: "葬送のフリーレン ～●●の魔法～",
            romaji: "Sousou no Frieren: ●● no Mahou",
            english: null
        },
        synonyms: ["Sousou no Frieren Mini Anime"],
        format: "ONA",
        startDate: { year: 2023, month: 10, day: 11 }
    }), "葬送的芙莉蓮");
    assert.equal(value, "葬送的芙莉蓮【●●の魔法】（2023）");
    assert.doesNotMatch(value, /（ONA）/u);
});

test("芙莉蓮迷你動畫 Part 2 保留原副標題，不退化成泛用 Part 2", () => {
    const value = api.generateSmartTitle(media({
        id: 189513,
        title: {
            native: "葬送のフリーレン ～●●の魔法～ 2クール",
            romaji: "Sousou no Frieren: ●● no Mahou Part 2",
            english: null
        },
        synonyms: ["Frieren: Beyond Journey's End Mini Anime"],
        format: "ONA",
        startDate: { year: 2025, month: 4, day: 2 }
    }), "葬送的芙莉蓮");
    assert.equal(value, "葬送的芙莉蓮【●●の魔法 2クール】（2025）");
    assert.notEqual(value, "葬送的芙莉蓮 Part 2（2025）");
});

test("ONA synonym 的 2nd Season Mini Anime 不可成為媒體季數", () => {
    const value = media({
        id: 206425,
        title: {
            native: "葬送のフリーレン ～●●の魔法～ 3クール",
            romaji: "Sousou no Frieren: ●● no Mahou Part 3",
            english: null
        },
        synonyms: ["Sousou no Frieren 2nd Season Mini Anime", "Frieren: Beyond Journey's End Season 2 Mini Anime"],
        format: "ONA",
        startDate: { year: 2026, month: 1, day: 19 }
    });
    assert.equal(api.detectMediaSeasonNumber(value), null);
    assert.equal(api.generateSmartTitle(value, "葬送的芙莉蓮"), "葬送的芙莉蓮【●●の魔法 3クール】（2026）");
});

test("芙莉蓮 TV 第二季與 ONA 第三批維持不同 identity 與標題", () => {
    const tv = media({
        id: 182255,
        title: { native: "葬送のフリーレン 第2期", romaji: "Sousou no Frieren 2nd Season", english: "Frieren: Beyond Journey's End Season 2" },
        format: "TV",
        episodes: 10,
        startDate: { year: 2026, month: 1, day: 16 }
    });
    const ona = media({
        id: 206425,
        title: { native: "葬送のフリーレン ～●●の魔法～ 3クール", romaji: "Sousou no Frieren: ●● no Mahou Part 3" },
        synonyms: ["Sousou no Frieren 2nd Season Mini Anime"],
        format: "ONA",
        startDate: { year: 2026, month: 1, day: 19 }
    });
    assert.equal(api.generateSmartTitle(tv, "葬送的芙莉蓮"), "葬送的芙莉蓮 第二季（2026）");
    assert.equal(api.generateSmartTitle(ona, "葬送的芙莉蓮"), "葬送的芙莉蓮【●●の魔法 3クール】（2026）");
    const reconciled = V.reconcileExistingAnimeDuplicates([
        { id: "tv-local", anilistId: 182255, title: api.generateSmartTitle(tv, "葬送的芙莉蓮"), format: "TV", year: 2026 },
        { id: "ona-local", anilistId: 206425, title: api.generateSmartTitle(ona, "葬送的芙莉蓮"), format: "ONA", year: 2026 }
    ]).list;
    assert.equal(reconciled.length, 2);
});

test("芙莉蓮 TV 第三季仍維持第三季名稱", () => {
    const value = media({
        id: 209939,
        title: { native: "葬送のフリーレン 第3期", romaji: "Sousou no Frieren 3rd Season" },
        format: "TV",
        status: "NOT_YET_RELEASED",
        startDate: { year: 2027, month: 10 }
    });
    assert.equal(api.generateSmartTitle(value, "葬送的芙莉蓮"), "葬送的芙莉蓮 第三季（2027）");
});

Promise.all(pending).then(() => {
    if (!process.exitCode) console.log(`\nTitle generation tests passed: ${passed}/${passed}`);
});
