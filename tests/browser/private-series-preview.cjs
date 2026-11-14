"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { chromium, webkit } = require(process.env.POSTER_PLAYWRIGHT || "playwright");

const at = "2026-08-12T10:00:00.000Z";
const privateMarker = "LOCAL-REVIEW-ONLY-7d83f9";
const externalImage = `https://private-preview.invalid/${privateMarker}.svg`;
const entry = new URL(process.argv[2] || process.env.PRIVATE_SERIES_PREVIEW_URL || "http://127.0.0.1:43217/");
assert.ok((entry.protocol === "https:" && entry.hostname.endsWith(".trycloudflare.com"))
    || (entry.protocol === "http:" && ["127.0.0.1","localhost"].includes(entry.hostname)),
    "Set a loopback or Cloudflare tunnel URL for the isolated preview");
const engine = process.env.POSTER_ENGINE === "webkit" ? webkit : chromium;
const backupFile = {
    name:"anonymized-production-backup.json",
    mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify(makeBackup()))
};

function makeBackup() {
    const anime = (id, title, groupTitle, year, category, watched, extra = {}) => ({
        id, title, groupTitle, year, category, watched, episodes:12,
        note:`${privateMarker} ${id}`, rating:8.5, favorite:true, addedAt:at,
        poster:externalImage, ...extra
    });
    const rascal = "青春豬頭少年";
    const darling = "戀上換裝娃娃";
    const rows = [
        anime(101291, "青春豬頭少年不會夢見兔女郎學姊", rascal, 2018, "completed", 12, {
            anilistId:101291, relations:[{ relationType:"SEQUEL", node:{ id:104157, type:"ANIME", format:"MOVIE" } }]
        }),
        anime("legacy-film", "青春豬頭少年不會夢到懷夢美少女", rascal, 2019, "backlog", 0, {
            anilistId:104157, episodes:1, format:"MOVIE",
            relations:[{ relationType:"PREQUEL", node:{ id:101291, type:"ANIME", format:"TV" } }]
        }),
        anime("dress-original", darling, darling, 2022, "completed", 12),
        anime("dress-season-2", `${darling} 第二季`, darling, 2025, "backlog", 3, {
            notes:`<img src="${externalImage}">`, aliases:["更衣人偶墜入愛河 第二季"], rating:7, currentEpisode:3
        }),
        anime("dress-ambiguous", "我的換裝筆記", darling, 2025, "review", 12, {
            titleSource:"manual", titleManuallyEdited:true, reviewWatched:2
        }),
        anime("duplicate-one", "同名無關作品", "", 2018, "completed", 12),
        anime("duplicate-two", "同名無關作品", "", 2025, "waiting", 0),
        anime("deleted", "已刪除記錄", darling, 2021, "_deleted", 1, { deletedAt:at }),
        anime("conflicting-provider", "同名無關作品", "", 2026, "waiting", 0, {
            source:"anilist", dataSource:"mal", anilistId:333333, sourceId:333333
        }),
        anime("isolated", "無關獨立作品", "", 2024, "review", 8)
    ];
    return {
        schemaVersion:11, exportedAt:at, anime_list_v8_8:rows,
        works:[{ workId:"legacy-source-work", title:"原始跨媒體記錄", mediaEntries:[
            { mediaType:"anime", id:"dress-season-2", sourceId:"154768", relationLocked:true }
        ] }],
        watchHistory:[
            { id:"private-history", animeId:101291, delta:12, at, note:privateMarker },
            { id:"dress-history", animeId:"dress-season-2", delta:3, at }
        ],
        settings:{ autoSync:true, email:`${privateMarker}@example.invalid` }
    };
}

function trackRequests(context) {
    const requests = [];
    const record = request => {
        const url = new URL(request.url());
        if (url.protocol !== "https:" && url.protocol !== "http:") return;
        requests.push({ method:request.method(), url:url.href, body:request.postData() });
    };
    context.on("request", record);
    return requests;
}

function assertPrivateTransport(requests) {
    assert.ok(requests.every(request => new URL(request.url).origin === entry.origin), JSON.stringify(requests));
    assert.ok(requests.every(request => request.method === "GET" || request.method === "HEAD"), JSON.stringify(requests));
    assert.ok(requests.every(request => !request.body && !request.url.includes(privateMarker)), JSON.stringify(requests));
}

function expectedOriginal() {
    const backup = makeBackup();
    return { records:backup.anime_list_v8_8, history:backup.watchHistory, works:backup.works, mediaEntries:[] };
}

function checksum(file) {
    return createHash("sha256").update(file.buffer).digest("hex");
}

const row = (page, index) => page.locator(`#report [data-row-index="${index}"]`);
const storedCopy = page => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("anime-series-private-preview");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("copy")) {
            database.close();
            resolve(null);
            return;
        }
        const read = database.transaction("copy", "readonly").objectStore("copy").get("active");
        read.onerror = () => { database.close(); reject(read.error); };
        read.onsuccess = () => { database.close(); resolve(read.result ?? null); };
    };
}));
const keysInUse = page => page.evaluate(() => Object.keys(localStorage).sort());

async function boot(page) {
    const downloads = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    const response = await page.goto(entry.href, { waitUntil:"domcontentloaded", timeout:30000 });
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-type"],"text/html; charset=utf-8");
    assert.equal(response.headers()["content-disposition"],"inline");
    await page.locator("#backup-file").waitFor({ state:"attached" });
    await page.locator("#offline").filter({ hasText:"離線資源已就緒" }).waitFor({ timeout:30000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout:30000 });
    await page.waitForFunction(() => !document.getElementById("backup-file").disabled, undefined, { timeout:30000 });
    assert.deepEqual(downloads,[]);
    return response;
}

async function expectBucket(page, index, result) {
    await page.locator(`#report [data-result="${result}"] [data-row-index="${index}"]`).first().waitFor({ state:"attached" });
}

async function openRecord(page, index) {
    const record = row(page, index);
    await record.evaluate(element => {
        for (let current = element; current; current = current.parentElement) {
            if (current.tagName === "DETAILS") current.open = true;
        }
    });
    return record;
}

async function main() {
    const executablePath = process.env.POSTER_EDGE_EXECUTABLE;
    const browser = await engine.launch({
        headless:true,
        ...(engine === chromium ? executablePath ? { executablePath } : { channel:"msedge" } : {})
    });
    const context = await browser.newContext({
        viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true
    });
    context.setDefaultTimeout(8000);
    const requests = trackRequests(context);
    try {
        const page = await context.newPage();
        const online = await boot(page);
        assert.match(online.headers()["content-security-policy"] || "", /(?:^|;)\s*connect-src 'none'\s*(?:;|$)/u);
        assert.deepEqual(await keysInUse(page), []);
        assert.equal(await row(page, 0).count(), 0);
        assert.equal(await storedCopy(page), null);
        const reloaded = await page.reload({ waitUntil:"domcontentloaded" });
        assert.equal(reloaded.status(),200);
        assert.equal(reloaded.headers()["content-type"],"text/html; charset=utf-8");
        assert.equal(reloaded.headers()["content-disposition"],"inline");
        await page.waitForFunction(() => !document.getElementById("backup-file").disabled);
        await page.evaluate(() => localStorage.setItem("private-preview-test-sentinel", "leave this key alone"));

        // Import and all work with the backup must succeed behind a complete
        // network outage. The hostile cover and note check rendering safety
        // again after the browser is back online.
        await context.setOffline(true);
        const digest = checksum(backupFile);
        const file = page.locator("#backup-file");
        await file.setInputFiles(backupFile);
        await expectBucket(page, 0, "grouped");
        await expectBucket(page, 1, "grouped");
        await expectBucket(page, 2, "grouped");
        await expectBucket(page, 3, "grouped");
        await expectBucket(page, 4, "suggestion");
        await expectBucket(page, 7, "deleted");
        await expectBucket(page, 8, "conflict");
        await expectBucket(page, 9, "independent");
        assert.equal(await page.locator("#report [data-row-index]").count(), makeBackup().anime_list_v8_8.length);
        const copy = await storedCopy(page);
        assert.deepEqual(copy.original, expectedOriginal());
        assert.ok(!JSON.stringify(copy).includes(`${privateMarker}@example.invalid`));
        assert.equal(checksum(backupFile), digest);
        assert.deepEqual(await keysInUse(page), ["private-preview-test-sentinel"]);
        const initialDress = await openRecord(page, 3);
        assert.equal(await initialDress.locator('[name="progress"]').inputValue(), "3");
        assert.deepEqual(await initialDress.locator('[name="notes"]').inputValue(), `<img src="${externalImage}">`);

        const search = page.locator("#search");
        await search.fill("更衣人偶墜入愛河");
        await row(page, 0).waitFor({ state:"detached" });
        assert.equal(await row(page, 3).count(), 1);
        await search.fill("");
        await expectBucket(page, 0, "grouped");

        const stale = await context.newPage();
        await boot(stale);
        await expectBucket(stale, 3, "grouped");
        const edited = "只改驗收副本的筆記";
        const dressSecondSeason = await openRecord(page, 3);
        await dressSecondSeason.locator('[name="notes"]').fill(edited);
        await dressSecondSeason.locator('[name="progress"]').fill("4");
        await dressSecondSeason.locator('[data-action="save"]').click();
        await waitForEdits(page, edited);
        const possibleMatch = await openRecord(page, 4);
        await possibleMatch.locator('[name="membership"]').selectOption("link:2");
        await possibleMatch.locator('[data-action="membership"]').click();
        await expectBucket(page, 4, "grouped");
        assert.deepEqual((await storedCopy(page)).original, copy.original);
        const unsynced = await openRecord(stale, 3);
        await unsynced.locator('[name="notes"]').fill("較舊分頁不應覆蓋進度");
        await unsynced.locator('[data-action="save"]').click();
        await stale.locator("#status").filter({ hasText:"另一個分頁變更" }).waitFor();
        const currentEdits = (await storedCopy(page)).edits;
        assert.ok(JSON.stringify(currentEdits).includes(edited));
        assert.ok(!JSON.stringify(currentEdits).includes("較舊分頁不應覆蓋進度"));
        await stale.close();

        await page.close();
        const reopened = await context.newPage();
        const offline = await boot(reopened);
        assert.equal(offline.fromServiceWorker(), true);
        await expectBucket(reopened, 3, "grouped");
        await expectBucket(reopened, 4, "grouped");
        const reopenedDress = await openRecord(reopened, 3);
        assert.equal(await reopenedDress.locator('[name="notes"]').inputValue(), edited);
        assert.equal(await reopenedDress.locator('[name="progress"]').inputValue(), "4");
        assert.deepEqual((await storedCopy(reopened)).original, copy.original);

        await context.setOffline(false);
        await reopened.reload({ waitUntil:"domcontentloaded" });
        await expectBucket(reopened, 4, "grouped");
        assert.equal(await reopened.locator('[src*="private-preview.invalid"]').count(), 0);
        const blocked = await reopened.evaluate(async marker => {
            try {
                await fetch(location.pathname + "?should-not-send=" + marker);
                return false;
            } catch { return true; }
        }, privateMarker);
        assert.equal(blocked, true, "CSP must block browser-side same-origin fetch too");
        assertPrivateTransport(requests);
        await answerConfirmation(reopened, true, () => reopened.locator("#backup-file").setInputFiles({
            name:"invalid.json", mimeType:"application/json", buffer:Buffer.from('{"anime_list_v8_8":null}')
        }));
        await reopened.locator("#status").filter({ hasText:"無法讀取這份 Anime Tracker JSON 備份" }).waitFor();
        assert.deepEqual((await storedCopy(reopened)).original, copy.original);

        const replace = makeBackup();
        replace.watchHistory = [];
        await answerConfirmation(reopened, false, () => reopened.locator("#backup-file").setInputFiles({
            name:"different-backup.json", mimeType:"application/json", buffer:Buffer.from(JSON.stringify(replace))
        }));
        assert.deepEqual((await storedCopy(reopened)).original, copy.original);

        await confirmClear(reopened, false);
        assert.deepEqual((await storedCopy(reopened)).original, copy.original);
        await confirmClear(reopened, true);
        await row(reopened, 3).waitFor({ state:"detached" });
        assert.equal(await storedCopy(reopened), null);
        assert.deepEqual(await keysInUse(reopened), ["private-preview-test-sentinel"]);
        await context.setOffline(true);
        await boot(reopened);
        assert.equal(await row(reopened, 0).count(), 0);
        assert.equal(await storedCopy(reopened), null);
        assertPrivateTransport(requests);
        console.log(JSON.stringify({ engine:browser.version(), backupUnchanged:true, isolatedEdits:true,
            realShapeGrouping:true, offlineImportAndRestart:true, clearedOnlyPreview:true,
            capturedRequests:requests.length, outboundPrivateRequests:0 }));
    } finally {
        await browser.close();
    }
}

async function waitForEdits(page, value) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (JSON.stringify((await storedCopy(page))?.edits || {}).includes(value)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail("Timed out waiting for local edits to commit");
}

async function confirmClear(page, accept) {
    await answerConfirmation(page, accept, () => page.locator("#clear-copy").click());
}

async function answerConfirmation(page, accept, action) {
    const timeout = AbortSignal.timeout(6000);
    const answered = once(page, "dialog", { signal:timeout }).then(([dialog]) => {
        assert.equal(dialog.type(), "confirm");
        return accept ? dialog.accept() : dialog.dismiss();
    });
    await Promise.all([answered, action()]);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
