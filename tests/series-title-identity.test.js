"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const titleStart = html.indexOf("function stripDisplayYear");
const titleEnd = html.indexOf("async function searchWikipedia", titleStart);
assert.ok(titleStart >= 0 && titleEnd > titleStart, "找不到標題解析程式");
const titleApi = Function(`${html.slice(titleStart, titleEnd)}; return { getSmartTitleDetails, refreshGeneratedAnimeTitle, getCoreTitle, resolveTraditionalChineseDisplayTitle, detectMediaSeasonNumber, trustedChineseAlias };`)();

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.stack}`); }
}

function relation(relationType, id, format = "TV") {
    return { relationType, node:{ id, format, type:"ANIME", title:{} } };
}

test("1. 完整 OpenCC 將簡體作品名轉成臺灣繁體", () => {
    assert.equal(V.toTraditionalChinese("86－不存在的战区－"), "86－不存在的戰區－");
    assert.equal(V.toTraditionalChinese("辉夜大小姐想让我告白"), "輝夜大小姐想讓我告白");
});

test("2. 原本繁體名稱維持不變", () => {
    assert.equal(V.toTraditionalChinese("葬送的芙莉蓮"), "葬送的芙莉蓮");
});

test("3. 人工簡體名稱不被 migration 改寫", () => {
    const migrated = V.migrateAnime({ id:"manual", title:"进击的巨人", titleManuallyEdited:true, titleSource:"manual" });
    assert.equal(migrated.title, "进击的巨人");
});

test("4. 同一 AniList Media ID 不因語言別名產生第二 identity", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        { id:"a", anilistId:1, title:"進擊的巨人" },
        { id:"b", anilistId:1, title:"进击的巨人" }
    ]);
    assert.equal(result.list.length, 1);
});

test("5. 不同 AniList ID 即使標題相同也不合併", () => {
    const result = V.reconcileExistingAnimeDuplicates([
        { id:"a", anilistId:10, title:"同名作品" },
        { id:"b", anilistId:11, title:"同名作品" }
    ]);
    assert.equal(result.list.length, 2);
});

test("6. PREQUEL／SEQUEL 關聯的不同 Media 共用 seriesKey", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"a", anilistId:100, title:"第一季", relations:[relation("SEQUEL", 101)] },
        { id:"b", anilistId:101, title:"第二季", relations:[relation("PREQUEL", 100)] }
    ]);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
    assert.equal(result.list[0].seriesKey, "anilist-series:100");
    assert.equal(result.list.length, 2);
});

test("7. 簡繁標題不同仍由 relation identity 分在同系列", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"a", anilistId:200, title:"不存在的战区", relations:[relation("SEQUEL", 201)] },
        { id:"b", anilistId:201, title:"不存在的戰區 Part 2", relations:[relation("PREQUEL", 200)] }
    ]);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
});

test("8. 完全不同翻譯但相同 relation graph 仍共用 seriesKey", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"a", anilistId:300, title:"中文譯名", relations:[relation("SEQUEL", 301)] },
        { id:"b", anilistId:301, title:"Entirely Different Title", relations:[relation("PREQUEL", 300)] }
    ]);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
});

test("9. 同名但沒有 relation graph 的不同 AniList Media 不會分組", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"a", anilistId:400, title:"相同名字" },
        { id:"b", anilistId:401, title:"相同名字" }
    ]);
    assert.notEqual(result.list[0].seriesKey, result.list[1].seriesKey);
});

test("10. SIDE_STORY 直接項目加入同一系列 component", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"a", anilistId:500, title:"本傳", relations:[relation("SIDE_STORY", 501)] },
        { id:"b", anilistId:501, title:"外傳" }
    ]);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
    assert.equal(result.list.length, 2);
});

test("10a. ALTERNATIVE 後的深度 SIDE_STORY 共享 seriesKey 且保持三筆 Media", () => {
    const records = [
        { id:"a", anilistId:14753, title:"A", relations:[relation("ALTERNATIVE", 124080, "OVA")] },
        { id:"b", anilistId:124080, title:"B", relations:[relation("SIDE_STORY", 163132)] },
        { id:"c", anilistId:163132, title:"C" }
    ];
    const result = V.assignAnimeSeriesIdentity(records);
    const shuffled = V.assignAnimeSeriesIdentity([records[2], records[0], records[1]]);
    const second = V.assignAnimeSeriesIdentity(JSON.parse(JSON.stringify(result.list)));
    assert.equal(new Set(result.list.map(item => item.seriesKey)).size, 1);
    assert.equal(result.list[0].seriesKey, "anilist-series:14753");
    assert.deepEqual(result.list.map(item => String(item.anilistId)).sort(), ["124080", "14753", "163132"].sort());
    assert.deepEqual(
        new Map(shuffled.list.map(item => [String(item.anilistId), item.seriesKey])),
        new Map(result.list.map(item => [String(item.anilistId), item.seriesKey]))
    );
    assert.equal(second.changedCount, 0);
});

test("10b. SIDE_STORY target 是 collect-only，不沿 target 關聯擴散", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"a", anilistId:1000, title:"A", relations:[relation("ALTERNATIVE", 1001)] },
        { id:"b", anilistId:1001, title:"B", relations:[relation("SIDE_STORY", 1002)] },
        { id:"c", anilistId:1002, title:"C", relations:[relation("SEQUEL", 1003)] },
        { id:"d", anilistId:1003, title:"D" }
    ]);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
    assert.equal(result.list[1].seriesKey, result.list[2].seriesKey);
    assert.notEqual(result.list[2].seriesKey, result.list[3].seriesKey);
});

test("10c. SPIN_OFF／CHARACTER／ADAPTATION 不建立 series identity edge", () => {
    for (const relationType of ["SPIN_OFF", "CHARACTER", "ADAPTATION"]) {
        const result = V.assignAnimeSeriesIdentity([
            { id:`a-${relationType}`, anilistId:1100, title:"A", relations:[relation(relationType, 1101)] },
            { id:`b-${relationType}`, anilistId:1101, title:"B" }
        ]);
        assert.notEqual(result.list[0].seriesKey, result.list[1].seriesKey);
    }
});

test("10d. traverse relation cycle 由 visited Set 正常結束", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"cycle-a", anilistId:1200, title:"A", relations:[relation("ALTERNATIVE", 1201)] },
        { id:"cycle-b", anilistId:1201, title:"B", relations:[relation("SEQUEL", 1202)] },
        { id:"cycle-c", anilistId:1202, title:"C", relations:[relation("PREQUEL", 1200)] }
    ]);
    assert.equal(result.list.length, 3);
    assert.equal(new Set(result.list.map(item => item.seriesKey)).size, 1);
});

test("11. 無 external ID 的 legacy 簡繁變體可保守共用 fallback key", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"legacy-a", title:"辉夜大小姐想让我告白" },
        { id:"legacy-b", title:"輝夜大小姐想讓我告白 第二季" }
    ]);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
    assert.equal(result.list[0].seriesKeySource, "legacy-title");
});

test("12. 86 本傳與 Part 2 保留兩筆但共用系列 identity", () => {
    const result = V.assignAnimeSeriesIdentity([
        { id:"86-a", anilistId:116589, title:"86－不存在的戰區－", relations:[relation("SEQUEL", 131586)] },
        { id:"86-b", anilistId:131586, title:"86－不存在的戰區－ Part 2", relations:[relation("PREQUEL", 116589)] }
    ]);
    assert.equal(result.list.length, 2);
    assert.equal(result.list[0].seriesKey, result.list[1].seriesKey);
});

test("13. 五等分第二季 legacy 泛用名稱可升級為官方符號", () => {
    const anime = { title:"五等分的新娘（續篇・2021）", titleSource:"legacy", aliases:["五等分的新娘"], groupTitle:"五等分的新娘" };
    const changed = titleApi.refreshGeneratedAnimeTitle(anime, {
        id:109261,
        title:{ native:"五等分の花嫁∬", romaji:"5-toubun no Hanayome ∬" },
        startDate:{ year:2021 },
        format:"TV",
        relations:{ edges:[relation("PREQUEL", 103572)] }
    });
    assert.equal(changed, true);
    assert.equal(anime.title, "五等分的新娘∬（2021）");
});

test("14. 206425 使用中文母作品加辨識性副標題", () => {
    const title = titleApi.resolveTraditionalChineseDisplayTitle({
        id:206425,
        title:{ native:"葬送のフリーレン ～●●の魔法～ 3クール", romaji:"Sousou no Frieren: ●● no Mahou Part 3" },
        synonyms:["Frieren: Beyond Journey's End Season 2 Mini Anime"],
        format:"ONA",
        startDate:{ year:2026 }
    }, { parentChineseTitle:"葬送的芙莉蓮" });
    assert.equal(title, "葬送的芙莉蓮【●●の魔法 3クール】（2026）");
});

test("15. 182255 仍顯示 TV 第二季", () => {
    const title = titleApi.resolveTraditionalChineseDisplayTitle({
        id:182255,
        title:{ native:"葬送のフリーレン 第2期", romaji:"Sousou no Frieren 2nd Season" },
        format:"TV",
        episodes:10,
        startDate:{ year:2026 }
    }, { parentChineseTitle:"葬送的芙莉蓮" });
    assert.equal(title, "葬送的芙莉蓮 第二季（2026）");
});

test("16. 209939 第三季與 waiting identity 不受影響", () => {
    const title = titleApi.resolveTraditionalChineseDisplayTitle({
        id:209939,
        title:{ native:"葬送のフリーレン 第3期", romaji:"Sousou no Frieren 3rd Season" },
        format:"TV",
        status:"NOT_YET_RELEASED",
        startDate:{ year:2027 }
    }, { parentChineseTitle:"葬送的芙莉蓮" });
    assert.equal(title, "葬送的芙莉蓮 第三季（2027）");
});

test("17. series identity migration 可重複執行", () => {
    const records = [
        { id:"a", anilistId:600, title:"第一季", relations:[relation("SEQUEL", 601)] },
        { id:"b", anilistId:601, title:"第二季", relations:[relation("PREQUEL", 600)] }
    ];
    const first = V.assignAnimeSeriesIdentity(records);
    const second = V.assignAnimeSeriesIdentity(JSON.parse(JSON.stringify(first.list)));
    assert.equal(first.changedCount, 2);
    assert.equal(second.changedCount, 0);
    assert.deepEqual(second.list, first.list);
});

test("18. local ID、進度與使用者欄位在 series migration 後不變", () => {
    const original = { id:"uuid-keep", anilistId:700, title:"作品", watched:8, currentEpisode:8, rating:9, notes:"keep", customPlatform:"自訂", unknownField:"keep" };
    const migrated = V.assignAnimeSeriesIdentity([original]).list[0];
    for (const key of ["id", "anilistId", "watched", "currentEpisode", "rating", "notes", "customPlatform", "unknownField"]) {
        assert.deepEqual(migrated[key], original[key]);
    }
});

test("19. tombstone 狀態在 series migration 後保持", () => {
    const deletedAt = "2026-08-01T00:00:00.000Z";
    const migrated = V.assignAnimeSeriesIdentity([{ id:"deleted", anilistId:800, title:"作品", deletedAt }]).list[0];
    assert.equal(migrated.deletedAt, deletedAt);
});

test("20. Service Worker 離線快取固定版 OpenCC 與 series graph cache", () => {
    const sw = fs.readFileSync(path.resolve(__dirname, "..", "sw.js"), "utf8");
    const ui = fs.readFileSync(path.resolve(__dirname, "..", "v11-ui.js"), "utf8");
    assert.match(sw, /anime-tracker-v11-theme-songs-native-title-1/u);
    assert.match(sw, /vendor\/opencc-js-1\.4\.1-full\.js\?v=1\.4\.1/u);
    assert.match(sw, /v11-core\.js\?v=theme-songs-native-title-1/u);
    assert.match(ui, /reloadVersion = "theme-songs-native-title-1"/u);
});

test("21. TV 可從安全 synonym 辨識季數", () => {
    assert.equal(titleApi.detectMediaSeasonNumber({
        format:"TV",
        title:{ native:"架空作品" },
        synonyms:["Example Anime 3rd Season"]
    }), 3);
});

test("22. ONA 的 Mini Anime synonym 不可誤判成 TV 季數", () => {
    assert.equal(titleApi.detectMediaSeasonNumber({
        format:"ONA",
        title:{ romaji:"Example: Mini Anime Part 3" },
        synonyms:["Example Anime 2nd Season Mini Anime"]
    }), null);
});

test("23. relation node 的同媒體中文別名可作為正式顯示名", () => {
    const media = {
        format:"TV",
        title:{ native:"青春ブタ野郎はサンタクロースの夢を見ない" },
        relations:{ edges:[{
            relationType:"ADAPTATION",
            node:{
                title:{ native:"青春ブタ野郎はサンタクロースの夢を見ない" },
                synonyms:["青春豬頭少年不會夢到聖誕服女郎"]
            }
        }]}
    };
    assert.equal(titleApi.trustedChineseAlias(media), "青春豬頭少年不會夢到聖誕服女郎");
});

test("24. 官方雙積分與全形星號後綴會保留媒體辨識力", () => {
    const sequel = titleApi.getSmartTitleDetails({
        format:"TV",
        title:{ native:"五等分の花嫁∫∫" },
        startDate:{ year:2021 }
    }, "五等分的新娘");
    const special = titleApi.getSmartTitleDetails({
        format:"SPECIAL",
        title:{ native:"五等分の花嫁*" },
        startDate:{ year:2024 }
    }, "五等分的新娘");
    assert.equal(sequel.displayTitle, "五等分的新娘∬（2021）");
    assert.equal(special.displayTitle, "五等分的新娘＊（2024）");
});

test("25. relation graph 輸入順序不同仍產生相同 deterministic root", () => {
    const records = [
        { id:"a", anilistId:900, title:"共同標題", relations:[relation("SEQUEL", 901)] },
        { id:"b", anilistId:901, title:"第二部", relations:[relation("PREQUEL", 900), relation("SEQUEL", 902)] },
        { id:"c", anilistId:902, title:"第三部", relations:[relation("PREQUEL", 901)] },
        { id:"d", anilistId:999, title:"共同標題", relations:[] }
    ];
    const forward = V.assignAnimeSeriesIdentity(records).list;
    const shuffled = V.assignAnimeSeriesIdentity([records[2], records[0], records[3], records[1]]).list;
    const forwardKeys = new Map(forward.map(item => [String(item.anilistId), item.seriesKey]));
    const shuffledKeys = new Map(shuffled.map(item => [String(item.anilistId), item.seriesKey]));
    assert.deepEqual(shuffledKeys, forwardKeys);
    assert.equal(forwardKeys.get("900"), "anilist-series:900");
    assert.equal(forwardKeys.get("901"), "anilist-series:900");
    assert.equal(forwardKeys.get("902"), "anilist-series:900");
    assert.equal(forwardKeys.get("999"), "anilist-media:999");
});

process.on("beforeExit", () => {
    if (process.exitCode) return;
    console.log(`\nSeries/title identity tests passed: ${passed}/29`);
});
