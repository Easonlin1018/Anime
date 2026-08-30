"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const candidateStart = html.indexOf("function stripWikipediaDisambiguationSuffix");
const candidateEnd = html.indexOf("const MEDIA_FIELDS", candidateStart);
const searchStart = html.indexOf("async function searchAnime(");
const searchEnd = html.indexOf("function getAniListMediaId", searchStart);
assert.ok(candidateStart >= 0 && candidateEnd > candidateStart, "找不到 AniList search candidate helpers");
assert.ok(searchStart >= 0 && searchEnd > searchStart, "找不到 searchAnime");

const candidateSource = html.slice(candidateStart, candidateEnd);
const searchSource = html.slice(searchStart, searchEnd);
const api = Function(`${candidateSource}
return { stripWikipediaDisambiguationSuffix, buildAniListSearchCandidates, searchAniListCandidates, discoverRelatedAnimeMedia, discoverAnimeSearchResults };`)();

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
                process.exitCode = 1;
                console.error(`✗ ${name}\n  ${error.stack}`);
            }));
            return;
        }
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        process.exitCode = 1;
        console.error(`✗ ${name}\n  ${error.stack}`);
    }
}

test("1. 半形 Wikipedia 消歧義標題保留 exact 並追加 stripped candidate", () => {
    assert.deepEqual(api.buildAniListSearchCandidates({
        originalInput:"原始名稱",
        wikiJaTitle:"作品名 (漫画)"
    }), ["作品名 (漫画)", "作品名", "原始名稱"]);
});

test("2. 全形 Wikipedia 消歧義括號可安全移除", () => {
    assert.deepEqual(api.buildAniListSearchCandidates({
        wikiJaTitle:"作品名（漫画）"
    }), ["作品名（漫画）", "作品名"]);
});

test("3. 沒有括號時不產生重複 candidate", () => {
    assert.deepEqual(api.buildAniListSearchCandidates({
        originalInput:"作品名",
        wikiZhTitle:"作品名",
        wikiJaTitle:"作品名",
        translatedTitle:"作品名"
    }), ["作品名"]);
});

test("4. exact query 有結果時仍查完所有非翻譯 candidates", async () => {
    const requests = [];
    const exact = { id:1 };
    const result = await api.searchAniListCandidates({ wikiJaTitle:"作品名 (漫画)" }, {
        requestSearch:async candidate => {
            requests.push(candidate);
            return candidate === "作品名 (漫画)" ? [exact] : [];
        },
        translate:async () => { throw new Error("不應執行翻譯"); }
    });
    assert.deepEqual(requests, ["作品名 (漫画)", "作品名"]);
    assert.deepEqual(result.results, [exact]);
    assert.equal(result.matchedCandidate, "作品名 (漫画)");
    assert.deepEqual(result.directEntries[0].matchedCandidates, ["作品名 (漫画)"]);
    assert.equal(result.requestCounts.search, 2);
});

test("5. exact 為 0 時依序使用 stripped results", async () => {
    const requests = [];
    const stripped = { id:2 };
    const result = await api.searchAniListCandidates({ wikiJaTitle:"作品名（漫画）" }, {
        requestSearch:async candidate => {
            requests.push(candidate);
            return candidate === "作品名" ? [stripped] : [];
        }
    });
    assert.deepEqual(requests, ["作品名（漫画）", "作品名"]);
    assert.deepEqual(result.results, [stripped]);
    assert.equal(result.matchedCandidate, "作品名");
});

test("6. translation 429 不會阻止 Wikipedia stripped fallback 成功", async () => {
    let translationCalls = 0;
    const result = await api.searchAniListCandidates({
        originalInput:"中文名稱",
        wikiJaTitle:"作品名 (漫画)"
    }, {
        requestSearch:async candidate => candidate === "作品名" ? [{ id:3 }] : [],
        translate:async () => {
            translationCalls++;
            const error = new Error("HTTP 429");
            error.status = 429;
            throw error;
        }
    });
    assert.equal(result.results[0].id, 3);
    assert.equal(translationCalls, 0, "可靠候選成功後不應再依賴翻譯服務");
});

test("7. translation 失敗本身只會得到空結果，不會讓 pipeline reject", async () => {
    const result = await api.searchAniListCandidates({ originalInput:"無結果" }, {
        requestSearch:async () => [],
        translate:async () => { throw Object.assign(new Error("HTTP 429"), { status:429 }); }
    });
    assert.deepEqual(result.results, []);
    assert.equal(result.matchedCandidate, null);
});

test("8. candidate pipeline 不修改輸入或任何 title / identity 欄位", () => {
    const context = {
        originalInput:"顯示名稱",
        wikiZhTitle:"中文頁名",
        wikiJaTitle:"作品名 (アニメ)",
        storedTitle:"使用者名稱",
        displayTitle:"顯示名稱",
        aliases:["別名"],
        anilistId:999,
        seriesKey:"series-999"
    };
    const before = structuredClone(context);
    api.buildAniListSearchCandidates(context);
    assert.deepEqual(context, before);
});

test("9. 實作不包含作品名稱或 AniList ID hardcode", () => {
    assert.doesNotMatch(candidateSource, /徹夜之歌|よふかしのうた|堀與宮村|ホリミヤ|Horimiya|141391|14753|124080|163132/u);
});

test("10. 成功 render 前會先關閉上一輪搜尋 toast", () => {
    const manualStart = searchSource.indexOf("if (isManual) {");
    const initialClose = searchSource.indexOf("closeToast();", manualStart);
    const loading = searchSource.indexOf("setSearchLoading(true);", manualStart);
    const assignment = searchSource.indexOf("pendingSingleAnimeSearch = await buildSingleAnimeSearchEntries");
    const close = searchSource.indexOf("closeToast();", assignment);
    const render = searchSource.indexOf("renderSingleAnimeSearchCandidate(pendingSingleAnimeSearch);", assignment);
    assert.ok(manualStart >= 0 && initialClose > manualStart && loading > initialClose);
    assert.ok(assignment >= 0 && close > assignment && render > close);
    assert.match(html, /getElementById\("search-input"\)\.addEventListener\("input", closeToast\)/u);
});

test("11. native / romaji / english 使用相同通用 candidate pipeline", async () => {
    const resultIds = [11, 12, 13];
    for (const originalInput of ["ネイティブ名", "Romaji Name", "English Name"]) {
        const result = await api.searchAniListCandidates({ originalInput }, {
            requestSearch:async candidate => candidate === originalInput
                ? resultIds.map(id => ({ id }))
                : []
        });
        assert.deepEqual(result.results.map(item => item.id), resultIds);
    }
});

const fullMedia = (id, edges = [], extra = {}) => ({
    id,
    title:{ native:`作品 ${id}`, romaji:`Media ${id}`, english:null },
    format:"TV",
    status:"FINISHED",
    episodes:12,
    startDate:{ year:2024, month:1, day:1 },
    relations:{ edges },
    ...extra
});
const relation = (relationType, node) => ({ relationType, node:{ type:"ANIME", ...node } });

test("12. 所有 direct candidates 聚合後以 AniList ID 去重", async () => {
    const result = await api.searchAniListCandidates({
        originalInput:"中文名稱",
        wikiJaTitle:"日本語名",
        wikiZhTitle:"中文頁名"
    }, {
        requestSearch:async candidate => ({
            "日本語名":[{id:10},{id:11}],
            "中文名稱":[{id:11},{id:12}],
            "中文頁名":[{id:10}]
        })[candidate] || []
    });
    assert.deepEqual(new Set(result.results.map(item => item.id)), new Set([10,11,12]));
    assert.equal(result.results.length, 3);
    const repeated = result.directEntries.find(entry => entry.media.id === 10);
    assert.deepEqual(repeated.matchedCandidates, ["日本語名", "中文頁名"]);
    assert.equal(result.requestCounts.search, 3);
});

test("13. direct discovery evidence 與作品 identity 分離", async () => {
    const media = { id:20, title:{native:"作品"}, category:"keep", seriesKey:"series-keep" };
    const before = structuredClone(media);
    const result = await api.searchAniListCandidates({ originalInput:"作品" }, {
        requestSearch:async () => [media]
    });
    assert.equal(result.directEntries[0].discoverySource, "direct");
    assert.equal(result.directEntries[0].bestCandidateRank, 0);
    assert.deepEqual(media, before);
});

test("14. PREQUEL／SEQUEL／PARENT／ALTERNATIVE 均可遍歷", async () => {
    for (const relationType of ["PREQUEL", "SEQUEL", "PARENT", "ALTERNATIVE"]) {
        const child = fullMedia(31, []);
        const seed = fullMedia(30, [relation(relationType, child)]);
        const result = await api.discoverRelatedAnimeMedia([{media:seed}], { loadMediaById:async () => child });
        assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [31]);
        assert.equal(result.relatedEntries[0].relationType, relationType);
        assert.equal(result.relatedEntries[0].relationDepth, 1);
    }
});

test("15. SIDE_STORY 可收集但不再擴散", async () => {
    const grandchild = fullMedia(42, []);
    const sideStory = fullMedia(41, [relation("SEQUEL", grandchild)]);
    const seed = fullMedia(40, [relation("SIDE_STORY", sideStory)]);
    const result = await api.discoverRelatedAnimeMedia([{media:seed}], {
        loadMediaById:async id => String(id) === "41" ? sideStory : grandchild
    });
    assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [41]);
});

test("16. SPIN_OFF／CHARACTER／ADAPTATION 預設排除", async () => {
    const seed = fullMedia(50, [
        relation("SPIN_OFF", fullMedia(51)),
        relation("CHARACTER", fullMedia(52)),
        relation("ADAPTATION", fullMedia(53))
    ]);
    const result = await api.discoverRelatedAnimeMedia([{media:seed}]);
    assert.deepEqual(result.relatedEntries, []);
});

test("17. 非 ANIME relation node 一律排除", async () => {
    const seed = fullMedia(60, [{ relationType:"SEQUEL", node:{ id:61, type:"MANGA", format:"MANGA" } }]);
    const result = await api.discoverRelatedAnimeMedia([{media:seed}]);
    assert.deepEqual(result.relatedEntries, []);
});

test("18. cycle 由 visited AniList ID Set 終止", async () => {
    const first = fullMedia(70);
    const second = fullMedia(71);
    first.relations.edges = [relation("SEQUEL", second)];
    second.relations.edges = [relation("PREQUEL", first)];
    const result = await api.discoverRelatedAnimeMedia([{media:first}], {
        loadMediaById:async id => String(id) === "71" ? second : first
    });
    assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [71]);
    assert.deepEqual(new Set(result.visitedIds), new Set(["70","71"]));
});

test("19. duplicate relation paths 的共同 Media 只出現一次", async () => {
    const shared = fullMedia(82);
    const first = fullMedia(80, [relation("SEQUEL", shared)]);
    const second = fullMedia(81, [relation("PREQUEL", shared)]);
    const result = await api.discoverRelatedAnimeMedia([{media:first},{media:second}]);
    assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [82]);
});

test("20. 最大深度 2，第三層不加入", async () => {
    const fourth = fullMedia(93);
    const third = fullMedia(92, [relation("SEQUEL", fourth)]);
    const second = fullMedia(91, [relation("SEQUEL", third)]);
    const first = fullMedia(90, [relation("SEQUEL", second)]);
    const map = new Map([[91,second],[92,third],[93,fourth]]);
    const result = await api.discoverRelatedAnimeMedia([{media:first}], { loadMediaById:async id => map.get(Number(id)) });
    assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [91,92]);
});

test("21. direct + related 總結果受 12 筆上限保護", async () => {
    const edges = Array.from({length:20}, (_, index) => relation("ALTERNATIVE", fullMedia(101 + index)));
    const seed = fullMedia(100, edges);
    const result = await api.discoverRelatedAnimeMedia([{media:seed}]);
    assert.equal(result.relatedEntries.length, 11);
    assert.equal(result.visitedIds.length, 12);
});

test("22. relation node metadata 足夠時不重複 detail fetch", async () => {
    const child = fullMedia(131, []);
    const seed = fullMedia(130, [relation("ALTERNATIVE", child)]);
    let detailRequests = 0;
    const result = await api.discoverRelatedAnimeMedia([{media:seed}], {
        loadMediaById:async () => { detailRequests++; return child; }
    });
    assert.equal(detailRequests, 0);
    assert.equal(result.requestCounts.detail, 0);
});

test("23. 有限 relation fixture 發現其他版本與外傳但不合併", async () => {
    const side = fullMedia(163132, []);
    const television = fullMedia(124080, [relation("SIDE_STORY", { id:163132 })]);
    const original = fullMedia(14753, [relation("ALTERNATIVE", { id:124080 })], { format:"OVA" });
    const map = new Map([["124080",television],["163132",side]]);
    const result = await api.discoverRelatedAnimeMedia([{media:original}], {
        loadMediaById:async id => map.get(String(id))
    });
    assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [124080,163132]);
    assert.deepEqual(result.relatedEntries.map(entry => entry.relationType), ["ALTERNATIVE","SIDE_STORY"]);
    assert.equal(new Set([14753,...result.relatedEntries.map(entry => entry.media.id)]).size, 3);
});

test("24. relation discovery 不會將 relation 欄位寫回 media", async () => {
    const child = fullMedia(141, []);
    const seed = fullMedia(140, [relation("SEQUEL", child)]);
    const before = structuredClone(seed);
    await api.discoverRelatedAnimeMedia([{media:seed}]);
    assert.deepEqual(seed, before);
});

test("25. 完整 discovery 回報 search／detail／total request counts", async () => {
    const child = fullMedia(151, []);
    const seed = fullMedia(150, [relation("ALTERNATIVE", { id:151 })]);
    const result = await api.discoverAnimeSearchResults({
        originalInput:"原始名稱",
        wikiJaTitle:"日本語名"
    }, {
        requestSearch:async candidate => candidate === "日本語名" ? [seed] : [],
        loadMediaById:async () => child
    });
    assert.deepEqual(result.directEntries.map(entry => entry.media.id), [150]);
    assert.deepEqual(result.relatedEntries.map(entry => entry.media.id), [151]);
    assert.deepEqual(result.requestCounts, { search:2, detail:1, total:3 });
});

Promise.all(pending).then(() => {
    if (!process.exitCode) console.log(`\nAniList search candidate tests passed: ${passed}/${passed}`);
});
