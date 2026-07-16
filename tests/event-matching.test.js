"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode = 1; }
}

const anime = {
    id:"anime-friendship",
    title:"男女之間存在純友情嗎？（不，不存在！）",
    aliases:["男女之間存在純友情嗎", "Can a Boy-Girl Friendship Survive?"]
};
const unrelated = {
    id:"event-bocchi",
    title:"台中《孤獨搖滾！動畫展》7/20降臨中友百貨",
    summary:"本週也推薦男女之間存在純友情嗎？（不，不存在！）",
    searchCorpus:"孤獨搖滾 動畫展 男女之間存在純友情嗎",
    relatedAnimeIds:[anime.id]
};

test("1. 查活動 API 回傳不相關活動時前端最終過濾掉", () => {
    assert.deepEqual(V.filterEventsForAnime([unrelated], anime), []);
});
test("2. 標題是其他作品、摘要含目前作品仍排除", () => {
    const result = V.matchEventToAnime(unrelated, anime);
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes("ignored-secondary-text-only-match"));
});
test("3. 新聞導流 sourceTitle 不可成為強匹配", () => {
    const event = { id:"news", title:"本週動漫活動整理", sourceTitle:`${anime.title} 最新消息`, sourceType:"news" };
    const result = V.matchEventToAnime(event, anime);
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes("ignored-non-official-source-title"));
});
test("4. 舊 relatedAnimeIds／matchedAnimeIds／animeIds 不直接信任", () => {
    for (const field of ["relatedAnimeIds", "matchedAnimeIds", "animeIds"]) {
        const result = V.matchEventToAnime({ id:field, title:"完全不同的活動", [field]:[anime.id] }, anime);
        assert.equal(result.matched, false, field);
        assert.ok(result.reasons.includes("ignored-legacy-auto-relation"), field);
    }
});
test("5. 人工 includeAnimeIds 可保留", () => {
    const result = V.matchEventToAnime({ id:"manual", title:"聯合活動" }, anime, { includeAnimeIds:[anime.id] });
    assert.deepEqual([result.matched, result.confidence, result.score], [true, "high", 100]);
});
test("6. 人工 excludeAnimeIds 永遠優先", () => {
    const result = V.matchEventToAnime({ id:"blocked", title:`${anime.title} 官方展覽` }, anime, { includeAnimeIds:[anime.id], excludeAnimeIds:[anime.id] });
    assert.equal(result.matched, false);
    assert.ok(result.reasons.includes("manual-exclude"));
});
test("7. 舊版活動搜尋快取 key 已不再使用", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    assert.doesNotMatch(html, /anime_work_alias_cache_v10_4|anime_live_search_pending_v10_4/);
    assert.match(html, /anime_work_alias_cache_v11_1/);
    assert.match(html, /anime_live_search_pending_v11_1/);
});
test("8. 活動標題完整包含正式名稱時高信心顯示", () => {
    const result = V.matchEventToAnime({ id:"correct", title:`《${anime.title}》期間限定展` }, anime);
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "high");
    assert.ok(result.score >= 80);
});
test("9. 過濾不會刪除或修改 events.json 原始資料", () => {
    const source = [unrelated, { id:"correct", title:`《${anime.title}》期間限定展` }];
    const before = JSON.stringify(source);
    assert.equal(V.filterEventsForAnime(source, anime).length, 1);
    assert.equal(source.length, 2);
    assert.equal(JSON.stringify(source), before);
});
test("10. 活動總頁保留完整來源，特定動漫頁只取高信心結果", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    const allEvents = [unrelated, { id:"correct", title:`《${anime.title}》期間限定展` }];
    assert.equal(allEvents.length, 2);
    assert.equal(V.filterEventsForAnime(allEvents, anime).length, 1);
    assert.match(html, /const source = activeAnime \? filterEventsForAnime\(overriddenSource, activeAnime\) : overriddenSource/);
});
test("11. 官方 sourceTitle 可作為強匹配", () => {
    const result = V.matchEventToAnime({ id:"official", title:"官方聯合企劃", sourceTitle:`《${anime.title}》官方活動`, sourceTitleOfficial:true }, anime);
    assert.equal(result.matched, true);
    assert.equal(result.confidence, "high");
    assert.ok(result.score >= 80);
});
test("12. 最終過濾器逐筆套用門檻且不接受 medium", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    assert.match(source, /result\.matched === true && result\.confidence === "high" && result\.score >= 80/);
    assert.match(source, /const result = matchEventToAnime\(event, anime\)/);
});

if (!process.exitCode) console.log(`\nEvent matching tests passed: ${passed}/12`);
