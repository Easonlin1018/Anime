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
    try { await fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.stack}`); }
}

function memoryStorage() {
    const data = new Map();
    return {
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

function animeThemesPayload() {
    return {
        anime:[{
            id:1,
            name:"Generic",
            animethemes:[{ type:"OP", sequence:1, slug:"OP1", song:{ title:"Opening", artists:[{ name:"Singer" }] } }]
        }]
    };
}

function jikanPayload() {
    return { data:{ theme:{ openings:['"Fallback" by Singer'], endings:[] } } };
}

function loadThemeSongs(globalFetch = async () => response(200, { resultCount:0, results:[] })) {
    const window = { AnimeTrackerV11:V };
    const context = {
        window,
        localStorage:memoryStorage(),
        navigator:{ onLine:true },
        fetch:globalFetch,
        AbortController,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        console
    };
    vm.runInNewContext(source, context, { filename:"spotify-themes.js" });
    return window.ThemeSongs;
}

(async () => {
    await test("1. missing AniList identity 會傳到最終診斷", async () => {
        const api = loadThemeSongs();
        await assert.rejects(
            api.fetchAnimeThemeSongs({ id:"local-only", malId:10, title:"Generic" }, null, {
                maxRetries:0,
                fetchImpl:async () => response(504)
            }),
            error => {
                assert.equal(error.providerDiagnostics.anilistId, null);
                assert.equal(error.providerDiagnostics.animeThemes.outcome, "skipped");
                assert.equal(error.providerDiagnostics.animeThemes.reason, "missing-anilist-id");
                assert.match(api.formatThemeProviderDiagnostics(error.providerDiagnostics), /AniList ID: missing/u);
                assert.match(api.formatThemeProviderDiagnostics(error.providerDiagnostics), /AnimeThemes: skipped - missing-anilist-id/u);
                return true;
            }
        );
    });

    await test("2. AnimeThemes network TypeError 保留安全的 name 與短 message", async () => {
        const api = loadThemeSongs();
        const result = await api.fetchAnimeThemeSongs({ id:"local-a", anilistId:101, malId:11, title:"Generic" }, null, {
            maxRetries:0,
            fetchImpl:async url => {
                if (String(url).includes("animethemes.moe")) throw new TypeError("Load failed");
                return response(200, jikanPayload());
            }
        });
        assert.equal(result.providerDiagnostics.animeThemes.outcome, "network-error");
        assert.equal(result.providerDiagnostics.animeThemes.errorName, "TypeError");
        assert.equal(result.providerDiagnostics.animeThemes.message, "Load failed");
        assert.match(api.formatThemeProviderDiagnostics(result.providerDiagnostics), /AnimeThemes: network error - TypeError: Load failed/u);
    });

    await test("3. AnimeThemes HTTP 5xx 保留正確 status", async () => {
        const api = loadThemeSongs();
        const result = await api.fetchAnimeThemeSongs({ id:"local-b", anilistId:102, malId:12, title:"Generic" }, null, {
            maxRetries:0,
            fetchImpl:async url => String(url).includes("animethemes.moe") ? response(503) : response(200, jikanPayload())
        });
        assert.equal(result.providerDiagnostics.animeThemes.outcome, "http-error");
        assert.equal(result.providerDiagnostics.animeThemes.httpStatus, 503);
        assert.match(api.formatThemeProviderDiagnostics(result.providerDiagnostics), /AnimeThemes: HTTP 503/u);
    });

    await test("4. AnimeThemes malformed response 正確標記", async () => {
        const api = loadThemeSongs();
        const result = await api.fetchAnimeThemeSongs({ id:"local-c", anilistId:103, malId:13, title:"Generic" }, null, {
            maxRetries:0,
            fetchImpl:async url => String(url).includes("animethemes.moe") ? response(200, { wrong:true }) : response(200, jikanPayload())
        });
        assert.equal(result.providerDiagnostics.animeThemes.outcome, "malformed");
        assert.match(api.formatThemeProviderDiagnostics(result.providerDiagnostics), /AnimeThemes: malformed/u);
    });

    await test("5. AnimeThemes definite not-found 不會誤標 network error", async () => {
        const api = loadThemeSongs();
        const result = await api.fetchAnimeThemeSongs({ id:"local-d", anilistId:104, title:"Generic", aliases:[] }, null, {
            maxRetries:0,
            fetchImpl:async url => String(url).includes("animethemes.moe") ? response(404) : response(200, { data:[] })
        });
        assert.equal(result.providerDiagnostics.animeThemes.outcome, "not-found");
        assert.equal(result.providerDiagnostics.jikan.outcome, "no-confident-match");
        assert.doesNotMatch(api.formatThemeProviderDiagnostics(result.providerDiagnostics), /AnimeThemes: network error/u);
    });

    await test("6. Jikan HTTP 504 與兩來源失敗會保留 generic message 和診斷", async () => {
        const api = loadThemeSongs();
        await assert.rejects(
            api.fetchAnimeThemeSongs({ id:"local-e", anilistId:105, malId:15, title:"Generic" }, null, {
                maxRetries:0,
                fetchImpl:async url => response(String(url).includes("animethemes.moe") ? 500 : 504)
            }),
            error => {
                assert.equal(error.message, "主題曲資料來源目前無法使用，請稍後再試");
                assert.equal(error.providerDiagnostics.jikan.outcome, "http-error");
                assert.equal(error.providerDiagnostics.jikan.httpStatus, 504);
                const model = api.themeStatusModel(error.message, error.providerDiagnostics);
                assert.equal(model.message, error.message);
                assert.match(model.diagnosticLines.join("\n"), /Jikan: HTTP 504/u);
                return true;
            }
        );
    });

    await test("7. Jikan malformed response 正確標記", async () => {
        const api = loadThemeSongs();
        const result = await api.fetchAnimeThemeSongs({ id:"local-f", anilistId:106, title:"Generic", aliases:[] }, null, {
            maxRetries:0,
            fetchImpl:async url => String(url).includes("animethemes.moe") ? response(500) : response(200, { wrong:true })
        });
        assert.equal(result.providerDiagnostics.jikan.outcome, "malformed");
    });

    await test("8. 成功時 status model 不顯示 failure diagnostic", async () => {
        const api = loadThemeSongs();
        const result = await api.fetchAnimeThemeSongs({ id:"local-g", anilistId:107, title:"Generic" }, null, {
            fetchImpl:async () => response(200, animeThemesPayload())
        });
        assert.equal(result.providerDiagnostics.animeThemes.outcome, "success");
        const model = api.themeStatusModel("已載入 1 首主題曲", null);
        assert.equal(model.message, "已載入 1 首主題曲");
        assert.equal(model.diagnosticLines.length, 0);
        assert.match(source, /songCount \? null : result\.providerDiagnostics/u);
    });

    if (!process.exitCode) console.log(`Theme Songs mobile diagnostics tests: ${passed}/${passed} passed`);
})();
