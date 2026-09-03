"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "spotify-themes.js"), "utf8");
const CACHE_KEY = "anime_theme_lookup_cache_v1";
let passed = 0;

async function test(name, fn) {
    try { await fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode = 1; }
}

function memoryStorage(seed = {}) {
    const data = new Map(Object.entries(seed).map(([key, value]) => [String(key), String(value)]));
    return {
        data,
        getItem:key => data.get(String(key)) ?? null,
        setItem:(key, value) => data.set(String(key), String(value)),
        removeItem:key => data.delete(String(key))
    };
}

function response(status, body = {}) {
    return {
        ok:status >= 200 && status < 300,
        status,
        headers:{ get:() => null },
        json:async () => body
    };
}

function theme(type, sequence, title, artists, extra = {}) {
    return { id:sequence, type, sequence, slug:`${type}${sequence}`, song:{ title, artists:artists.map(name => ({ name })) }, ...extra };
}

function animeThemesPayload(themes = [theme("OP", 1, "Opening", ["Singer"])]) {
    return { anime:[{ id:77, name:"Generic Anime", animethemes:themes }] };
}

function jikanPayload(openings = ['"Fallback OP" by Singer'], endings = []) {
    return { data:{ theme:{ openings, endings } } };
}

function loadThemeSongs(fetchImpl, seed = {}) {
    const localStorage = memoryStorage(seed);
    const window = { AnimeTrackerV11:V };
    const routedFetch = (url, options) => String(url).startsWith("https://itunes.apple.com/")
        ? Promise.resolve(response(200, { resultCount:0, results:[] }))
        : fetchImpl(url, options);
    const context = {
        window,
        localStorage,
        navigator:{ onLine:true },
        fetch:routedFetch,
        AbortController,
        URL,
        URLSearchParams,
        setTimeout:(callback => { queueMicrotask(callback); return 1; }),
        clearTimeout:() => {},
        console
    };
    vm.runInNewContext(source, context, { filename:"spotify-themes.js" });
    return { api:window.ThemeSongs, localStorage };
}

(async () => {
    await test("1. 有 AniList identity 時 AnimeThemes 是第一來源", async () => {
        const urls = [];
        const { api } = loadThemeSongs(async url => { urls.push(String(url)); return response(200, animeThemesPayload()); });
        const result = await api.fetchAnimeThemeSongs({ id:"local-a", anilistId:123, malId:456, title:"A" });
        assert.equal(result.provider, "AnimeThemes");
        assert.match(urls[0], /^https:\/\/api\.animethemes\.moe\/anime\?/u);
        assert.equal(new URL(urls[0]).searchParams.get("filter[external_id]"), "123");
    });

    await test("2. 數字 local anime.id 絕不當成 AniList identity", async () => {
        const urls = [];
        const { api } = loadThemeSongs(async url => { urls.push(String(url)); return response(200, jikanPayload()); });
        await api.fetchAnimeThemeSongs({ id:987654, malId:456, title:"Legacy" });
        assert.equal(urls.some(url => url.includes("animethemes.moe")), false);
        assert.equal(urls.filter(url => url.includes("jikan.moe")).length, 1);
    });

    await test("3. AnimeThemes OP 正確 normalize", () => {
        const { api } = loadThemeSongs(async () => response(200));
        const result = api.normalizeAnimeThemesSongs(animeThemesPayload([theme("OP", 1, "Primary OP", ["Artist"]) ]), "2026-01-01T00:00:00.000Z");
        assert.deepEqual({ type:result.songs.openings[0].type, sequence:result.songs.openings[0].sequence, title:result.songs.openings[0].title, artist:result.songs.openings[0].artist, sourceName:result.songs.openings[0].sourceName }, { type:"OP", sequence:1, title:"Primary OP", artist:"Artist", sourceName:"AnimeThemes" });
    });

    await test("4. AnimeThemes ED 正確 normalize", () => {
        const { api } = loadThemeSongs(async () => response(200));
        const result = api.normalizeAnimeThemesSongs(animeThemesPayload([theme("ED", 2, "Primary ED", ["Artist"]) ]));
        assert.equal(result.songs.endings[0].type, "ED");
        assert.equal(result.songs.endings[0].sequence, 2);
    });

    await test("5. 多 OP／ED 保留 native sequence 與 slug sequence", () => {
        const { api } = loadThemeSongs(async () => response(200));
        const themes = [theme("OP", 2, "OP Two", ["A"]), theme("OP", null, "OP Three", ["B"], { slug:"OP3" }), theme("ED", 4, "ED Four", ["C"])];
        const result = api.normalizeAnimeThemesSongs(animeThemesPayload(themes));
        assert.deepEqual(Array.from(result.songs.openings, song => song.sequence), [2, 3]);
        assert.deepEqual(Array.from(result.songs.endings, song => song.sequence), [4]);
    });

    await test("6. 多位 artist 使用頓號組合", () => {
        const { api } = loadThemeSongs(async () => response(200));
        const result = api.normalizeAnimeThemesSongs(animeThemesPayload([theme("OP", 1, "Duet", ["Artist A", "Artist B"]) ]));
        assert.equal(result.songs.openings[0].artist, "Artist A、Artist B");
    });

    await test("7. AnimeThemes 成功時 Jikan request 為 0", async () => {
        let jikan = 0;
        const { api } = loadThemeSongs(async url => { if (String(url).includes("jikan.moe")) jikan++; return response(200, animeThemesPayload()); });
        await api.fetchAnimeThemeSongs({ id:"local-g", anilistId:7, malId:70, title:"G" });
        assert.equal(jikan, 0);
    });

    await test("8. AnimeThemes no result 時 fallback Jikan", async () => {
        const urls = [];
        const { api } = loadThemeSongs(async url => { urls.push(String(url)); return String(url).includes("animethemes.moe") ? response(200, { anime:[] }) : response(200, jikanPayload()); });
        const result = await api.fetchAnimeThemeSongs({ id:"local-h", anilistId:8, malId:80, title:"H" });
        assert.equal(result.provider, "Jikan");
        assert.equal(result.songs.openings[0].title, "Fallback OP");
        assert.equal(urls.length, 2);
    });

    await test("9. 沒有 AniList ID 時略過 AnimeThemes", async () => {
        const urls = [];
        const { api } = loadThemeSongs(async url => { urls.push(String(url)); return response(200, jikanPayload()); });
        await api.fetchAnimeThemeSongs({ id:"uuid-only", malId:90, title:"I" });
        assert.equal(urls.every(url => !url.includes("animethemes.moe")), true);
    });

    await test("10. AnimeThemes 5xx 會 fallback Jikan", async () => {
        const urls = [];
        const { api } = loadThemeSongs(async url => { urls.push(String(url)); return String(url).includes("animethemes.moe") ? response(503) : response(200, jikanPayload()); });
        const result = await api.fetchAnimeThemeSongs({ id:"local-j", anilistId:10, malId:100, title:"J" });
        assert.equal(result.provider, "Jikan");
        assert.equal(result.primaryFailure.status, 503);
    });

    await test("11. AnimeThemes malformed 是 provider failure 並 fallback", async () => {
        let fallbackNotice = 0;
        const { api } = loadThemeSongs(async url => String(url).includes("animethemes.moe") ? response(200, { wrong:true }) : response(200, jikanPayload()));
        const result = await api.fetchAnimeThemeSongs({ id:"local-k", anilistId:11, malId:110, title:"K" }, null, { onProviderFallback:() => fallbackNotice++ });
        assert.equal(result.provider, "Jikan");
        assert.equal(result.primaryFailure.malformed, true);
        assert.equal(fallbackNotice, 1);
    });

    await test("12. AnimeThemes 與 Jikan 都失敗時回報統一最終狀態", async () => {
        const { api } = loadThemeSongs(async url => response(String(url).includes("animethemes.moe") ? 500 : 504));
        await assert.rejects(api.fetchAnimeThemeSongs({ id:"local-l", anilistId:12, malId:120, title:"L" }, null, { sleep:async () => {} }), /主題曲資料來源目前無法使用/u);
    });

    await test("13. AnimeThemes success cache 讓 reload/reopen 不重打", async () => {
        let calls = 0;
        const first = loadThemeSongs(async () => { calls++; return response(200, animeThemesPayload()); });
        await first.api.fetchAnimeThemeSongs({ id:"local-m", anilistId:13, title:"M" });
        const saved = { [CACHE_KEY]:first.localStorage.getItem(CACHE_KEY) };
        const second = loadThemeSongs(async () => { calls++; throw new Error("cache miss"); }, saved);
        const result = await second.api.fetchAnimeThemeSongs({ id:"local-m", anilistId:13, title:"M" });
        assert.equal(result.cached, true);
        assert.equal(calls, 1);
    });

    await test("14. AnimeThemes server failure 不形成 negative cache", async () => {
        let calls = 0;
        const { api, localStorage } = loadThemeSongs(async () => { calls++; return response(503); });
        await assert.rejects(api.fetchAnimeThemesThemeSongs({ id:"local-n", anilistId:14 }, { fetchImpl:async () => { calls++; return response(503); } }));
        await assert.rejects(api.fetchAnimeThemesThemeSongs({ id:"local-n", anilistId:14 }, { fetchImpl:async () => { calls++; return response(503); } }));
        assert.equal(calls, 2);
        assert.equal((JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"))["animethemes:14"], undefined);
    });

    await test("15. 人工修正優先於 AnimeThemes", () => {
        const manual = { openings:[{ type:"OP", sequence:1, title:"Manual", artist:"User", manuallyCorrected:true, updatedAt:"2025-01-01" }], endings:[] };
        const primary = { openings:[{ type:"OP", sequence:1, title:"Primary", artist:"Provider", sourceName:"AnimeThemes", updatedAt:"2026-01-01" }], endings:[] };
        const merged = V.mergeThemeSongs(manual, primary);
        assert.equal(merged.openings.length, 1);
        assert.equal(merged.openings[0].title, "Manual");
    });

    await test("16. AnimeThemes refresh 不重複既有 Jikan theme", () => {
        const jikan = { openings:[{ type:"OP", sequence:1, title:"Same", artist:"Singer", sourceName:"MyAnimeList via Jikan", updatedAt:"2025-01-01" }], endings:[] };
        const primary = { openings:[{ type:"OP", sequence:1, title:"Same", artist:"Singer", sourceName:"AnimeThemes", updatedAt:"2026-01-01" }], endings:[] };
        const merged = V.mergeThemeSongs(jikan, primary);
        assert.equal(merged.openings.length, 1);
        assert.equal(merged.openings[0].sourceName, "AnimeThemes");
    });

    await test("17. Anime A late result 不會污染已切換的 Anime B", async () => {
        let releaseA;
        const lateResponse = new Promise(resolve => { releaseA = resolve; });
        const { api, localStorage } = loadThemeSongs(async () => response(200));
        const animeA = { id:"a", themeSongs:{ openings:[], endings:[] } }, animeB = { id:"b", themeSongs:{ openings:[], endings:[] } };
        const lookupA = api.beginThemeLookup(animeA);
        const pendingA = api.fetchAnimeThemesThemeSongs({ ...animeA, anilistId:1701 }, {
            signal:lookupA.signal,
            isCurrent:() => api.isThemeLookupCurrent(lookupA, animeA),
            fetchImpl:async () => lateResponse
        });
        const lookupB = api.beginThemeLookup(animeB);
        releaseA(response(200, animeThemesPayload()));
        await assert.rejects(pendingA, error => error.name === "AbortError");
        assert.equal(api.applyThemeLookupResult(animeA, { songs:{ openings:[{ title:"Late A" }], endings:[] } }, lookupA), false);
        assert.equal(animeB.themeSongs.openings.length, 0);
        assert.equal((JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"))["animethemes:1701"], undefined);
        assert.equal(api.applyThemeLookupResult(animeB, { songs:{ openings:[{ title:"Current B" }], endings:[] } }, lookupB), true);
        assert.equal(animeB.themeSongs.openings[0].title, "Current B");
    });

    await test("18. Spotify request 不使用 AnimeThemes 或 Jikan helper", () => {
        assert.match(source, /fetch\(`\$\{worker\}\/search\?q=/u);
        assert.doesNotMatch(source, /requestAnimeThemesJson\(`\$\{worker\}/u);
        assert.doesNotMatch(source, /requestJikanJson\(`\$\{worker\}/u);
    });

    await test("19. Mobile delete compact undo 與 provider cache snapshot 相容", () => {
        const { api } = loadThemeSongs(async () => response(200), { [CACHE_KEY]:JSON.stringify({ "animethemes:19":{ value:{ kind:"songs" }, queriedAt:Date.now(), ttl:10000 } }) });
        const snapshot = api.snapshotAnimeCleanup({ id:"local-s", anilistId:19, themeSongs:{ openings:[], endings:[] } });
        assert.equal(snapshot.cacheEntries.length, 1);
        assert.equal(snapshot.cacheEntries[0][0], "animethemes:19");
        assert.match(fs.readFileSync(path.join(root, "tests", "mobile-delete-storage-failure.test.js"), "utf8"), /compact undo/u);
    });

    await test("20. 既有 Jikan retry 仍可 504 後成功", async () => {
        let calls = 0;
        const { api } = loadThemeSongs(async () => response(200));
        const replies = [response(504), response(200, { ok:true })];
        const result = await api.requestJikanJson("https://api.jikan.moe/v4/anime/20", { fetchImpl:async () => replies[calls++], sleep:async () => {} });
        assert.equal(result.ok, true);
        assert.equal(calls, 2);
    });

    await test("21. 搜尋新增紀錄保存明確 AniList identity", () => {
        const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
        const start = html.indexOf("function buildAnimeRecordFromMedia");
        const end = html.indexOf("function directRelationMediaIds", start);
        const builder = html.slice(start, end);
        assert.match(builder, /anilistId:Number\(media\.id\)/u);
        assert.match(builder, /source:"anilist"/u);
        assert.match(builder, /sourceId:Number\(media\.id\)/u);
    });

    if (!process.exitCode) console.log(`AnimeThemes primary/fallback tests: ${passed}/${passed} passed`);
})();
