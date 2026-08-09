"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("function stripDisplayYear");
const end = html.indexOf("async function searchWikipedia", start);
assert.ok(start >= 0 && end > start, "找不到標題產生函式");
const code = html.slice(start, end);
const api = Function(`${code}; return { getCoreTitle, getSeriesGroupTitle, getSmartTitleDetails, generateSmartTitle, isLegacyGeneratedTitle, refreshGeneratedAnimeTitle, compareSeriesMediaByStartDate };`)();
const sequelStart = html.indexOf("function getDirectSequelNodes");
const sequelEnd = html.indexOf("async function manualScanSequels", sequelStart);
assert.ok(sequelStart >= 0 && sequelEnd > sequelStart, "找不到續作 traversal 函式");
const sequelCode = html.slice(sequelStart, sequelEnd);
const sequelApi = Function(`${sequelCode}; return { getDirectSequelNodes, walkAniListSequelGraph };`)();

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

test("renderList 只在系列群組內套用結構化日期排序", () => {
    assert.match(html, /for \(const \[core, series\] of Object\.entries\(seriesMap\)\) \{\s*series\.sort\(compareSeriesMediaByStartDate\)/u);
    assert.doesNotMatch(html, /compareSeriesMediaByStartDate\([^)]*title/u);
});

Promise.all(pending).then(() => {
    if (!process.exitCode) console.log(`\nTitle generation tests passed: ${passed}/${passed}`);
});
