"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "..", "spotify-worker.js"), "utf8");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}\n  ${error.stack}`); process.exitCode = 1; } }

test("1. Token 錯誤包含安全階段欄位", () => { assert.match(source,/SpotifyUpstreamError\("token"/); assert.match(source,/stage:\s*error\.stage/); assert.match(source,/spotifyStatus:\s*error\.spotifyStatus/); assert.match(source,/spotifyError:\s*error\.spotifyError/); assert.match(source,/spotifyMessage:\s*error\.spotifyMessage/); });
test("2. Search 錯誤包含 search 階段", () => { assert.match(source,/SpotifyUpstreamError\("search"/); assert.match(source,/Spotify 搜尋失敗/); });
test("3. 使用指定 Spotify Search API", () => { assert.match(source,/new URL\("https:\/\/api\.spotify\.com\/v1\/search"\)/); });
test("4. 搜尋參數為 q、type=track、limit", () => { assert.match(source,/searchParams\.set\("q",\s*query\)/); assert.match(source,/searchParams\.set\("type",\s*"track"\)/); assert.match(source,/searchParams\.set\("limit"/); });
test("5. limit 固定 5 且不超過 10", () => { const match=source.match(/SPOTIFY_SEARCH_LIMIT\s*=\s*(\d+)/); assert.ok(match); assert.equal(Number(match[1]),5); assert.ok(Number(match[1])<=10); assert.match(source,/Math\.min\(SPOTIFY_SEARCH_LIMIT,\s*10\)/); });
test("6. 上游回應先以 text 安全解析", () => { assert.match(source,/await upstreamResponse\.text\(\)/); assert.match(source,/JSON\.parse\(spotifyText\)/); assert.match(source,/spotifyText\.slice\(0,\s*300\)/); });
test("7. 公開錯誤物件不包含敏感欄位", () => { const publicReturn=source.match(/return response\(request, env, \{ error: error\.message, stage:[\s\S]*?\}, 502\)/)?.[0]||""; assert.ok(publicReturn); assert.doesNotMatch(publicReturn,/CLIENT_ID|CLIENT_SECRET|Authorization|access_token|tokenCache/); });
test("8. Worker 不記錄憑證或 token", () => { assert.doesNotMatch(source,/console\.(?:log|error|warn)/); });
test("9. 前端顯示安全的 Spotify 階段與狀態", () => { const frontend=fs.readFileSync(path.resolve(__dirname,"..","spotify-themes.js"),"utf8"); assert.match(frontend,/payload\.stage/); assert.match(frontend,/payload\.spotifyStatus/); assert.match(frontend,/payload\.spotifyError/); assert.match(frontend,/payload\.spotifyMessage/); });

if (!process.exitCode) console.log(`\nSpotify worker tests passed: ${passed}/9`);
