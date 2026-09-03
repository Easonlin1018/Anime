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

function response(status, body = {}, retryAfter = "") {
    return {
        ok:status >= 200 && status < 300,
        status,
        headers:{ get:name => String(name).toLowerCase() === "retry-after" ? retryAfter : null },
        json:async () => body
    };
}

function abortError() {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
}

function loadThemeSongs(fetchImpl, cache = {}) {
    const localStorage = memoryStorage({ [CACHE_KEY]:JSON.stringify(cache) });
    const scheduledDelays = [];
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
        setTimeout:(callback, delay) => { scheduledDelays.push(delay); queueMicrotask(callback); return scheduledDelays.length; },
        clearTimeout:() => {},
        console
    };
    vm.runInNewContext(source, context, { filename:"spotify-themes.js" });
    return { api:window.ThemeSongs, localStorage, scheduledDelays };
}

(async () => {
    await test("1. HTTP 200 第一次成功只 request 一次", async () => {
        let calls = 0;
        const { api } = loadThemeSongs(async () => { calls++; return response(200, { ok:true }); });
        const result = await api.requestJikanJson("https://api.jikan.moe/v4/anime/1", { sleep:async () => {} });
        assert.equal(result.ok, true);
        assert.equal(calls, 1);
    });

    await test("2. HTTP 504 → 200 重試一次並保存歌曲 cache", async () => {
        let calls = 0;
        const replies = [response(504), response(200, { data:{ theme:{ openings:['"OP" by Singer'], endings:[] } } })];
        const { api, localStorage } = loadThemeSongs(async () => replies[calls++]);
        const result = await api.fetchAnimeThemeSongs({ id:"local-2", malId:2, title:"Generic" });
        assert.equal(calls, 2);
        assert.equal(result.songs.openings[0].title, "OP");
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
        assert.equal(cache["themes:2"].value.openings[0].title, "OP");
    });

    await test("3. HTTP 503 → 504 → 200 最多三次後成功", async () => {
        let calls = 0;
        const delays = [];
        const replies = [response(503), response(504), response(200, { done:true })];
        const { api } = loadThemeSongs(async () => response(200));
        const result = await api.requestJikanJson("https://api.jikan.moe/v4/anime/3", {
            fetchImpl:async () => replies[calls++],
            sleep:async delay => delays.push(delay)
        });
        assert.equal(result.done, true);
        assert.equal(calls, 3);
        assert.deepEqual(delays, [800, 1600]);
    });

    await test("4. 三次 HTTP 504 後停止且不形成 negative cache", async () => {
        let calls = 0;
        const { api, localStorage } = loadThemeSongs(async () => response(200));
        await assert.rejects(
            api.requestJikanJson("https://api.jikan.moe/v4/anime/4", {
                fetchImpl:async () => { calls++; return response(504); },
                sleep:async () => {}
            }),
            error => error.status === 504
        );
        assert.equal(calls, 3);
        assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)), {});
    });

    await test("5. HTTP 404 不 retry", async () => {
        let calls = 0;
        const { api } = loadThemeSongs(async () => response(200));
        await assert.rejects(
            api.requestJikanJson("https://api.jikan.moe/v4/anime/404", {
                fetchImpl:async () => { calls++; return response(404); },
                sleep:async () => { throw new Error("404 must not sleep"); }
            }),
            error => error.status === 404
        );
        assert.equal(calls, 1);
    });

    await test("6. HTTP 429 尊重 Retry-After 並限制最多 5 秒", async () => {
        let calls = 0;
        const delays = [];
        const replies = [response(429, {}, "99"), response(200, { ok:true })];
        const { api } = loadThemeSongs(async () => response(200));
        await api.requestJikanJson("https://api.jikan.moe/v4/anime/6", {
            fetchImpl:async () => replies[calls++],
            sleep:async delay => delays.push(delay)
        });
        assert.equal(calls, 2);
        assert.deepEqual(delays, [5000]);
        assert.equal(api.parseRetryAfterMs(response(429, {}, "0.7")), 700);
    });

    await test("7. 網路層暫時性 fetch failure 會有限重試", async () => {
        let calls = 0;
        const delays = [];
        const { api } = loadThemeSongs(async () => response(200));
        const result = await api.requestJikanJson("https://api.jikan.moe/v4/anime/network", {
            fetchImpl:async () => {
                calls++;
                if (calls === 1) throw new TypeError("temporary network failure");
                return response(200, { ok:true });
            },
            sleep:async delay => delays.push(delay)
        });
        assert.equal(result.ok, true);
        assert.equal(calls, 2);
        assert.deepEqual(delays, [800]);
    });

    await test("8. retry delay 中 abort 後不再 request、cache 或顯示最終錯誤", async () => {
        let calls = 0;
        const notifications = [];
        const abortController = new AbortController();
        const { api, localStorage } = loadThemeSongs(async () => response(200));
        const pending = api.requestJikanJson("https://api.jikan.moe/v4/anime/7", {
            signal:abortController.signal,
            fetchImpl:async () => { calls++; return response(504); },
            onRetry:info => { notifications.push(info.retry); abortController.abort(); },
            sleep:async (_delay, signal) => { if (signal.aborted) throw abortError(); }
        });
        await assert.rejects(pending, error => error.name === "AbortError");
        assert.equal(calls, 1);
        assert.deepEqual(notifications, [1]);
        assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)), {});
        assert.match(source, /if \(error\.name !== "AbortError" && isThemeLookupCurrent/u);
    });

    await test("9. 有效 TTL cache 時 request 0 次", async () => {
        let calls = 0;
        const cachedSongs = { openings:[{ title:"Cached OP" }], endings:[] };
        const cache = { "themes:8":{ value:cachedSongs, queriedAt:Date.now(), ttl:86400000 } };
        const { api } = loadThemeSongs(async () => { calls++; return response(500); }, cache);
        const result = await api.fetchAnimeThemeSongs({ id:"local-8", malId:8, title:"Cached" });
        assert.equal(calls, 0);
        assert.equal(result.songs.openings[0].title, "Cached OP");
    });

    await test("10. 手動 refresh 清除 cache 後仍使用有限 retry", async () => {
        let calls = 0;
        const cache = { "themes:9":{ value:{ openings:[{ title:"Old" }], endings:[] }, queriedAt:Date.now(), ttl:86400000 } };
        const replies = [response(503), response(200, { data:{ theme:{ openings:['"Fresh" by Singer'], endings:[] } } })];
        const { api } = loadThemeSongs(async () => replies[calls++], cache);
        const anime = { id:"local-9", malId:9, title:"Refresh" };
        assert.equal((await api.fetchAnimeThemeSongs(anime)).songs.openings[0].title, "Old");
        api.invalidateThemeLookupCache(anime);
        const refreshed = await api.fetchAnimeThemeSongs(anime);
        assert.equal(calls, 2);
        assert.equal(refreshed.songs.openings[0].title, "Fresh");
    });

    await test("11. Jikan retry 不改變 Spotify search request", () => {
        assert.match(source, /requestJikanJson\(url/u);
        assert.match(source, /fetch\(`\$\{worker\}\/search\?q=/u);
        assert.doesNotMatch(source, /requestJikanJson\(`\$\{worker\}/u);
    });

    await test("12. retry status 依序提供 1／2 與 2／2", async () => {
        let calls = 0;
        const retries = [];
        const replies = [response(502), response(503), response(200, { ok:true })];
        const { api } = loadThemeSongs(async () => response(200));
        await api.requestJikanJson("https://api.jikan.moe/v4/anime/11", {
            fetchImpl:async () => replies[calls++],
            onRetry:info => retries.push(`${info.retry}/${info.maxRetries}`),
            sleep:async () => {}
        });
        assert.deepEqual(retries, ["1/2", "2/2"]);
        assert.match(source, /主題曲資料來源暫時無回應，正在重試/u);
    });

    if (!process.exitCode) console.log(`Theme Songs Jikan retry tests: ${passed}/${passed} passed`);
})();
