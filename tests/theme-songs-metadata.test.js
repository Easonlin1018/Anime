"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "spotify-themes.js"), "utf8");
let passed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}\n  ${error.stack}`);
        process.exitCode = 1;
    }
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

function loadThemeSongs(fetchImpl, { online = true, cache = {} } = {}) {
    const localStorage = memoryStorage({ anime_theme_lookup_cache_v1:JSON.stringify(cache) });
    const window = { AnimeTrackerV11:V };
    const routedFetch = (url, options) => String(url).startsWith("https://itunes.apple.com/")
        ? Promise.resolve(okJson({ resultCount:0, results:[] }))
        : fetchImpl(url, options);
    const context = {
        window,
        localStorage,
        navigator:{ onLine:online },
        fetch:routedFetch,
        AbortController,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        console
    };
    vm.runInNewContext(source, context, { filename:"spotify-themes.js" });
    return { api:window.ThemeSongs, compatibilityApi:window.SpotifyThemes, localStorage };
}

function okJson(value) {
    return { ok:true, status:200, json:async () => value };
}

(async () => {
    await test("1. 沒有 Spotify config 時仍由 Jikan 取得 OP／ED metadata", async () => {
        const calls = [];
        const fetchImpl = async url => {
            calls.push(String(url));
            if (String(url).includes("/anime?")) return okJson({ data:[{
                mal_id:501, title:"Generic Anime", title_english:"Generic Anime", title_japanese:"作品",
                title_synonyms:[], year:2026, type:"TV", episodes:12
            }] });
            return okJson({ data:{ theme:{ openings:['"Opening One" by Singer A'], endings:['"Ending One" by Singer B'] } } });
        };
        const { api, compatibilityApi } = loadThemeSongs(fetchImpl);
        const result = await api.fetchAnimeThemeSongs({ id:"local-a", title:"Generic Anime", aliases:[], year:2026, format:"TV", totalEpisodes:12 });
        assert.equal(api, compatibilityApi);
        assert.equal(result.malId, 501);
        assert.equal(result.songs.openings[0].title, "Opening One");
        assert.equal(result.songs.endings[0].artist, "Singer B");
        assert.equal(calls.length, 2);
    });

    await test("2. 多 OP／ED 全部保留並依 sequence 排序", async () => {
        const { api } = loadThemeSongs(async url => String(url).includes("/full")
            ? okJson({ data:{ theme:{ openings:['"OP A" by A','"OP B" by B','"OP C" by C'], endings:['"ED A" by D','"ED B" by E'] } } })
            : okJson({ data:[] }));
        const result = await api.fetchAnimeThemeSongs({ id:"local-b", malId:502, title:"B" });
        assert.deepEqual(Array.from(result.songs.openings, song => song.sequence), [1, 2, 3]);
        assert.deepEqual(Array.from(result.songs.endings, song => song.sequence), [1, 2]);
        assert.deepEqual(Array.from(result.songs.openings, song => song.title), ["OP A", "OP B", "OP C"]);
    });

    await test("3. artist、sourceName 與 sourceUrl 完整保存", async () => {
        const { api } = loadThemeSongs(async () => okJson({ data:{ theme:{ openings:['"Song" by Artist feat. Guest'], endings:[] } } }));
        const result = await api.fetchAnimeThemeSongs({ id:"local-c", malId:503, title:"C" });
        const song = result.songs.openings[0];
        assert.equal(song.artist, "Artist feat. Guest");
        assert.equal(song.sourceName, "MyAnimeList via Jikan");
        assert.equal(song.sourceUrl, "https://myanimelist.net/anime/503");
    });

    await test("4. 已有 themeSongs 不會取得 automatic lookup claim", () => {
        const { api } = loadThemeSongs(async () => { throw new Error("fetch should not run"); });
        const anime = { id:"local-d", themeSongs:{ openings:[{ title:"Saved OP" }], endings:[] } };
        assert.equal(api.hasThemeSongData(anime), true);
        assert.equal(api.claimAutomaticLookup(anime, true), false);
    });

    await test("5. 空資料第一次展開只取得一次 automatic lookup claim", () => {
        const { api } = loadThemeSongs(async () => okJson({ data:[] }));
        const anime = { id:"local-e", themeSongs:{ openings:[], endings:[] } };
        assert.equal(api.claimAutomaticLookup(anime, true), true);
        assert.equal(api.claimAutomaticLookup(anime, true), false);
    });

    await test("6. Jikan ambiguity 回傳候選且不默默抓取 full metadata", async () => {
        const calls = [];
        const { api } = loadThemeSongs(async url => {
            calls.push(String(url));
            return okJson({ data:[
                { mal_id:601, title:"Same", title_english:"Same", title_japanese:"同名", title_synonyms:[], year:2026, type:"TV", episodes:12 },
                { mal_id:602, title:"Same", title_english:"Same", title_japanese:"同名", title_synonyms:[], year:2026, type:"TV", episodes:12 }
            ] });
        });
        const result = await api.fetchAnimeThemeSongs({ id:"local-f", title:"Same", year:2026, format:"TV", totalEpisodes:12 });
        assert.equal(result.selected, null);
        assert.equal(result.confident, false);
        assert.deepEqual(Array.from(result.candidates, item => item.mal_id), [601, 602]);
        assert.equal(calls.some(url => url.includes("/full")), false);
    });

    await test("7. Jikan cache／TTL 避免 reload 或重複展開時再次 request", async () => {
        let calls = 0;
        const { api } = loadThemeSongs(async () => { calls++; return okJson({ data:{ theme:{ openings:[], endings:[] } } }); });
        const anime = { id:"local-g", malId:701, title:"G", status:"FINISHED" };
        await api.fetchAnimeThemeSongs(anime);
        await api.fetchAnimeThemeSongs(anime);
        assert.equal(calls, 1);
    });

    await test("8. manuallyCorrected song 不被 Jikan refresh 覆蓋", () => {
        const manual = V.normalizeThemeSong({ id:"theme-op", type:"OP", sequence:1, title:"人工名稱", artist:"人工歌手", manuallyCorrected:true, updatedAt:"2026-01-01" }, "OP", 0);
        const jikan = V.normalizeThemeSong({ id:"theme-op", type:"OP", sequence:1, title:"來源名稱", artist:"來源歌手", sourceName:"MyAnimeList via Jikan", updatedAt:"2026-09-01" }, "OP", 0);
        const merged = V.mergeThemeSongs({ openings:[manual], endings:[] }, { openings:[jikan], endings:[] });
        assert.equal(merged.openings[0].title, "人工名稱");
        assert.equal(merged.openings[0].artist, "人工歌手");
    });

    await test("9. unavailableOnSpotify 不影響歌曲 metadata 有效性", () => {
        const { api } = loadThemeSongs(async () => okJson({ data:[] }));
        const anime = { id:"local-h", themeSongs:{ openings:[{ title:"Visible OP", unavailableOnSpotify:true }], endings:[] } };
        assert.equal(api.hasThemeSongData(anime), true);
        assert.equal(api.themeSongStatus(anime, true), "已載入 1 首主題曲");
    });

    await test("10. offline 顯示已儲存資料且不取得 automatic lookup claim", () => {
        const { api } = loadThemeSongs(async () => { throw new Error("offline fetch"); }, { online:false });
        const anime = { id:"local-i", themeSongs:{ openings:[{ title:"Cached OP" }], endings:[] } };
        assert.equal(api.themeSongStatus(anime, false), "目前離線，顯示已儲存的主題曲資料");
        assert.equal(api.claimAutomaticLookup({ id:"empty", themeSongs:{ openings:[], endings:[] } }, false), false);
    });

    await test("11. UI 主狀態與操作不再依賴 Spotify 設定", () => {
        assert.match(source, /尚未載入主題曲資料/u);
        assert.match(source, /正在尋找此作品的 OP／ED/u);
        assert.match(source, /重新搜尋主題曲/u);
        assert.match(source, /void maybeAutoLoadThemeSongs\(\)/u);
        assert.doesNotMatch(source, /展開後才載入 Spotify 播放器/u);
        assert.doesNotMatch(source, /Spotify 搜尋尚未設定；仍可人工貼入歌曲網址/u);
    });

    await test("12. 無 Spotify config／track 時主卡不建立 provider controls", () => {
        assert.match(source, /if \(!hasTrack && !spotifyProviderConfigured\(\)\) return null/u);
        assert.match(source, /actions\.append\(button\("編輯"/u);
        assert.match(source, /const spotify = renderSpotifyEnhancement\(song\)/u);
    });

    await test("13. reload／備份與 compact delete safety 仍保留 themeSongs", () => {
        const anime = V.migrateAnime({ id:"local-j", title:"J", themeSongs:{ openings:[{ title:"Saved" }], endings:[] } });
        const roundTrip = V.importBackup({ animeList:[] }, V.createBackup({ animeList:[anime] }), "replace").animeList[0];
        assert.equal(roundTrip.themeSongs.openings[0].title, "Saved");
        const deleteTests = fs.readFileSync(path.join(root, "tests", "mobile-delete-storage-failure.test.js"), "utf8");
        assert.match(deleteTests, /compact undo/u);
        assert.match(deleteTests, /recoveryRequired/u);
    });

    if (!process.exitCode) console.log(`Theme Songs metadata tests: ${passed}/${passed} passed`);
})();
