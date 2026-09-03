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

function track(trackId, trackName, artistName = "Official Artist") {
    return { trackId, trackName, artistName, kind:"song", trackViewUrl:`https://music.apple.com/jp/song/${trackId}` };
}

function payload(...results) {
    return { resultCount:results.length, results };
}

function loadThemeSongs(seed = {}) {
    const localStorage = memoryStorage(seed);
    const window = { AnimeTrackerV11:V };
    const context = {
        window,
        localStorage,
        navigator:{ onLine:true },
        fetch:async () => response(500),
        AbortController,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        console
    };
    vm.runInNewContext(source, context, { filename:"spotify-themes.js" });
    return { api:window.ThemeSongs, localStorage };
}

function successfulNativeFetch(nativeTitle = "公式の曲名", trackId = 9001) {
    let calls = 0;
    const fetchImpl = async url => {
        calls++;
        assert.match(String(url), /^https:\/\/itunes\.apple\.com\/(?:search|lookup)\?/u);
        return response(200, payload(track(trackId, nativeTitle)));
    };
    fetchImpl.calls = () => calls;
    return fetchImpl;
}

(async () => {
    await test("1. 可信 Japanese native title 以獨立欄位保存", async () => {
        const { api } = loadThemeSongs();
        const fetchImpl = successfulNativeFetch("五等分の気持ち", 1447573390);
        const original = { type:"OP", sequence:1, title:"Gotoubun no Kimochi", artist:"Nakano-ke no Itsutsugo" };
        const result = await api.lookupNativeThemeSongTitle(original, { nativeTitleFetchImpl:fetchImpl });
        assert.equal(result.song.title, "Gotoubun no Kimochi");
        assert.equal(result.song.nativeTitle, "五等分の気持ち");
        assert.equal(result.song.nativeTitleTrackId, "1447573390");
        assert.equal(fetchImpl.calls(), 4);
    });

    await test("2. 找不到 native title 時保留 provider canonical title", async () => {
        const { api } = loadThemeSongs();
        const result = await api.lookupNativeThemeSongTitle({ title:"Canonical Title", artist:"Artist" }, {
            nativeTitleFetchImpl:async () => response(200, payload())
        });
        assert.equal(result.matched, false);
        assert.equal(result.song.title, "Canonical Title");
        assert.equal(result.song.nativeTitle, undefined);
    });

    await test("3. 官方 Latin title 維持原名且不做翻譯", async () => {
        const { api } = loadThemeSongs();
        let calls = 0;
        const result = await api.lookupNativeThemeSongTitle({ title:"Sign", artist:"Official Artist" }, {
            nativeTitleFetchImpl:async () => { calls++; return response(200, payload(track(7, "Sign"))); }
        });
        assert.equal(result.reason, "official-latin");
        assert.equal(result.song.title, "Sign");
        assert.equal(result.song.nativeTitle, undefined);
        assert.equal(calls, 3);
    });

    await test("4. 三路查詢的穩定 trackId 不一致時視為 ambiguous", async () => {
        const { api } = loadThemeSongs();
        const result = await api.lookupNativeThemeSongTitle({ title:"Romanized Song", artist:"Artist" }, {
            nativeTitleFetchImpl:async url => {
                const attribute = new URL(String(url)).searchParams.get("attribute");
                return response(200, payload(track(attribute === "artistTerm" ? 2 : 1, "公式曲")));
            }
        });
        assert.equal(result.reason, "ambiguous");
        assert.equal(result.song.nativeTitle, undefined);
    });

    await test("5. native provider 網路失敗不會讓 OP／ED 消失或形成 negative cache", async () => {
        const { api, localStorage } = loadThemeSongs();
        const song = { title:"Provider Song", artist:"Artist" };
        const result = await api.lookupNativeThemeSongTitle(song, { nativeTitleFetchImpl:async () => { throw new TypeError("offline"); } });
        assert.equal(result.song, song);
        assert.equal(result.failure.transient, true);
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        assert.equal(cache[api.nativeTitleCacheKey(song)], undefined);
    });

    await test("6. malformed response 不污染歌曲且不寫 negative cache", async () => {
        const { api, localStorage } = loadThemeSongs();
        const song = { title:"Provider Song", artist:"Artist" };
        const result = await api.lookupNativeThemeSongTitle(song, { nativeTitleFetchImpl:async () => response(200, { bad:true }) });
        assert.equal(result.song, song);
        assert.equal(result.failure.malformed, true);
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        assert.equal(cache[api.nativeTitleCacheKey(song)], undefined);
    });

    await test("7. manuallyCorrected song 完全不被 enrichment 覆蓋", async () => {
        const { api } = loadThemeSongs();
        let calls = 0;
        const song = { title:"User Title", nativeTitle:"User Native", artist:"User", manuallyCorrected:true };
        const result = await api.lookupNativeThemeSongTitle(song, { nativeTitleFetchImpl:async () => { calls++; return response(200, payload()); } });
        assert.equal(result.song, song);
        assert.equal(result.song.nativeTitle, "User Native");
        assert.equal(calls, 0);
    });

    await test("8. positive cache hit 不重新 request", async () => {
        const { api } = loadThemeSongs();
        const fetchImpl = successfulNativeFetch("公式曲", 18);
        const song = { title:"Romanized Song", artist:"Artist" };
        const first = await api.lookupNativeThemeSongTitle(song, { nativeTitleFetchImpl:fetchImpl });
        const second = await api.lookupNativeThemeSongTitle(song, { nativeTitleFetchImpl:fetchImpl });
        assert.equal(first.song.nativeTitle, "公式曲");
        assert.equal(second.song.nativeTitle, "公式曲");
        assert.equal(second.cached, true);
        assert.equal(fetchImpl.calls(), 4);
    });

    await test("9. definite negative cache 使用短 TTL 並避免重查", async () => {
        const { api, localStorage } = loadThemeSongs();
        let calls = 0;
        const song = { title:"Unknown Song", artist:"Artist" };
        const options = { nativeTitleFetchImpl:async () => { calls++; return response(200, payload()); } };
        await api.lookupNativeThemeSongTitle(song, options);
        const second = await api.lookupNativeThemeSongTitle(song, options);
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
        assert.equal(second.cached, true);
        assert.equal(calls, 3);
        assert.ok(cache[api.nativeTitleCacheKey(song)].ttl > 0);
        assert.ok(cache[api.nativeTitleCacheKey(song)].ttl <= 6 * 60 * 60 * 1000);
    });

    await test("10. retry／lookup 等待中 abort 後不寫 cache、也不再完成 enrichment", async () => {
        const { api, localStorage } = loadThemeSongs();
        const controller = new AbortController();
        const songA = { title:"Late Song A", artist:"Artist A" };
        const pending = api.lookupNativeThemeSongTitle(songA, {
            signal:controller.signal,
            isCurrent:() => true,
            nativeTitleFetchImpl:(_url, options) => new Promise((resolve, reject) => {
                options.signal.addEventListener("abort", () => { const error = new Error("Aborted"); error.name = "AbortError"; reject(error); }, { once:true });
                setTimeout(() => resolve(response(200, payload(track(20, "遲到曲")))), 20);
            })
        });
        controller.abort();
        await assert.rejects(pending, error => error.name === "AbortError");
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        assert.equal(cache[api.nativeTitleCacheKey(songA)], undefined);
    });

    await test("11. Anime A late response 在 current guard 失效後不污染 Anime B", async () => {
        const { api, localStorage } = loadThemeSongs();
        let release;
        let current = true;
        let started = 0;
        const gate = new Promise(resolve => { release = resolve; });
        const songA = { title:"Late Song A", artist:"Artist A" };
        const pending = api.lookupNativeThemeSongTitle(songA, {
            isCurrent:() => current,
            nativeTitleFetchImpl:async () => { started++; await gate; return response(200, payload(track(21, "遲到曲"))); }
        });
        await Promise.resolve();
        assert.equal(started, 3);
        current = false;
        release();
        await assert.rejects(pending, error => error.name === "AbortError");
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        assert.equal(cache[api.nativeTitleCacheKey(songA)], undefined);
    });

    await test("12. AnimeThemes 成功不受 native enrichment 暫時失敗影響", async () => {
        const { api } = loadThemeSongs();
        const result = await api.fetchAnimeThemesThemeSongs({ id:"local-a", anilistId:123 }, {
            fetchImpl:async () => response(200, { anime:[{ name:"Anime", animethemes:[{ type:"OP", sequence:1, song:{ title:"Primary OP", artists:[{ name:"Singer" }] } }] }] }),
            nativeTitleFetchImpl:async () => response(503)
        });
        assert.equal(result.selected, true);
        assert.equal(result.songs.openings[0].title, "Primary OP");
        assert.equal(result.songs.openings[0].nativeTitle, "");
    });

    await test("13. Jikan fallback 不受 native enrichment malformed 影響", async () => {
        const { api } = loadThemeSongs();
        const result = await api.fetchJikanThemeSongs({ id:"local-b", malId:321 }, 321, {
            fetchImpl:async () => response(200, { data:{ theme:{ openings:['"Fallback OP" by Singer'], endings:[] } } }),
            nativeTitleFetchImpl:async () => response(200, { wrong:true })
        });
        assert.equal(result.songs.openings[0].title, "Fallback OP");
        assert.equal(result.songs.openings[0].nativeTitle, "");
    });

    await test("14. UI 使用 nativeTitle || title，Spotify matching 仍使用 canonical title", () => {
        assert.match(source, /song\.nativeTitle \|\| song\.title/u);
        assert.match(source, /normalizeSongTitle\(song\.title\)/u);
        assert.doesNotMatch(source, /normalizeSongTitle\(song\.nativeTitle/u);
    });

    await test("15. normalize／backup 相容層保留 nativeTitle", () => {
        const normalized = V.normalizeThemeSong({ title:"Romanized", nativeTitle:"公式曲", artist:"Artist" }, "OP", 0);
        assert.equal(normalized.title, "Romanized");
        assert.equal(normalized.nativeTitle, "公式曲");
        const migrated = V.migrateAnime({ id:"a", title:"Anime", themeSongs:{ openings:[normalized], endings:[] } });
        assert.equal(migrated.themeSongs.openings[0].nativeTitle, "公式曲");
    });

    await test("16. provider records 同 slot 但不同 title／artist 不會互相覆蓋", () => {
        const jikan = { openings:[{ type:"OP", sequence:1, title:"Song A", artist:"Artist A", sourceName:"MyAnimeList via Jikan" }], endings:[] };
        const primary = { openings:[{ type:"OP", sequence:1, title:"Song B", artist:"Artist B", sourceName:"AnimeThemes" }], endings:[] };
        const merged = V.mergeThemeSongs(jikan, primary);
        assert.equal(merged.openings.length, 2);
        assert.deepEqual(new Set(merged.openings.map(song => song.title)), new Set(["Song A", "Song B"]));
    });

    await test("17. production 沒有作品、歌曲或 AniList ID hardcode", () => {
        assert.doesNotMatch(source, /Gotoubun|五等分|103572|1447573390/u);
        assert.doesNotMatch(source, /if\s*\([^)]*(?:trackId|title)[^)]*===\s*["']/u);
    });

    if (!process.exitCode) console.log(`Theme song native-title tests: ${passed}/${passed} passed`);
})();
