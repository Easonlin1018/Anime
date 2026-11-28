"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require(process.env.POSTER_PLAYWRIGHT || "playwright");

const repo = path.resolve(__dirname, "../..");
const compareLegacy = process.argv.includes("--legacy-baseline");
const read = relative => compareLegacy
    ? execFileSync("git", ["show","b5c43d73500df5971f4c42165871d19939a83487:" + relative], {
        cwd:repo,maxBuffer:8*1024*1024
    })
    : fs.readFileSync(path.join(repo,relative));
const worker = read("sw.js").toString();
const release = worker.match(/^const SHELL_RELEASE = "([a-z0-9-]+)";/m)[1];
const releasePath = "releases/" + release;
const V = require(path.join(repo, releasePath, "v11-core.js"));
const area = "/Anime/";
const shellFiles = Object.keys(JSON.parse(worker.match(/^const SHELL_HASHES = (\{[\s\S]*?^\});/m)[1]));
const files = new Map();
for (const file of [...shellFiles, "sw.js", "manifest.webmanifest", "icons/app-icon.svg"]) {
    const fullPath = path.join(repo, file);
    if (fs.existsSync(fullPath)) files.set(file, read(file));
}
for (const file of shellFiles) {
    const versioned = releasePath + "/" + file;
    files.set(versioned, read(versioned));
}
const main = V.STORAGE_KEY;
const historyKey = V.HISTORY_KEY;
const restores = V.RESTORE_KEY;
const pending = "anime_tracker_startup_pending_v1";
const undo = "anime_tracker_last_undo_v11";
const at = "2025-10-01T00:00:00.000Z";

// These fields intentionally model the old format without currentEpisode, aliases,
// notes, category ownership, or newer AniList fields.
const oldRows = Array.from({ length:12 }, (_, index) => ({
    id:730000 + index,
    title:index === 0 ? "合成動漫 月下行程" : "合成舊作品 " + index,
    watched:index === 0 ? 2 : 0, episode:0, episodes:12,
    category:"backlog", note:"合成原筆記 " + index, rating:8, favorite:true,
    createdAt:at, updatedAt:at
}));
oldRows.at(-1).deletedAt = at;
const oldHistory = Array.from({ length:900 }, (_, index) => ({
    id:"legacy-history-" + index, animeId:oldRows[0].id, episode:index % 12 + 1,
    at, delta:1, type:"normal", note:"Synthetic historical data " + index
}));
const oldRestore = [1, 2, 3].map(index => ({
    id:"legacy-restore-" + index, createdAt:at, reason:"合成舊還原點 " + index,
    animeCount:oldRows.length, data:V.createBackup({
        animeList:oldRows, works:[], watchHistory:oldHistory
    }, { preserveStoredRecords:true })
}));
const newRows = [{ ...oldRows[0], watched:4, note:"匯入的合成筆記", updatedAt:"2026-09-25T10:00:00.000Z" },
    { ...oldRows[1], id:735099, title:"合成匯入作品", updatedAt:"2026-09-25T10:00:00.000Z" }];
const newHistory = Array.from({ length:1600 }, (_, index) => ({
    id:"import-history-" + index, animeId:oldRows[0].id, episode:index % 12 + 1, at,
    delta:1, type:"normal", note:"Fictional imported history only " + index
}));
const backupFile = {
    name:"anime-synthetic-legacy-backup.json",mimeType:"application/json",
    buffer:Buffer.from(JSON.stringify({ [main]:newRows, watchHistory:newHistory, works:[], schemaVersion:11 }))
};
const oversizedHistory = newHistory.map(entry => ({ ...entry, id:"oversized-" + entry.id }));
const oversizedBackupFile = {
    ...backupFile, name:"anime-synthetic-oversized-backup.json",
    buffer:Buffer.from(JSON.stringify({ [main]:newRows, watchHistory:oversizedHistory, works:[], schemaVersion:11 }))
};
const originals = {
    [main]:JSON.stringify(oldRows), [historyKey]:JSON.stringify(oldHistory), [restores]:JSON.stringify(oldRestore),
    [undo]:JSON.stringify({ type:"delete", at, items:[oldRows.at(-1)] }),
    "anime_metadata_sync_v10_1":new Date().toISOString(), "anime-quota-test-sentinel":"unrelated local data"
};
const mime = file => file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css"
    : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".json") ? "application/json"
        : file.endsWith(".webmanifest") ? "application/manifest+json" : "text/html";

let origin;
const server = http.createServer((req,res) => {
    const url = new URL(req.url,origin);
    let body = "";
    let name = url.pathname.slice(area.length) || "index.html";
    if (req.method !== "GET") { res.statusCode=405; return res.end(); }
    if (url.pathname === "/__probe") { name="index.html"; body="<!doctype html><title>Loopback probe</title>"; }
    else if (!url.pathname.startsWith(area)) { res.statusCode=404; return res.end(); }
    else if (name === "events.json") body='{"events":[],"archive":[],"meta":{"fetchStatus":"success"}}';
    else if (["sync-config.js", "spotify-config.js"].includes(name)) body="/* synthetic profile: no remote configuration */";
    else if (files.has(name)) body=files.get(name);
    else { res.statusCode=404; return res.end(); }
    res.writeHead(200, { "Content-Type":mime(name) + "; charset=utf-8", "Cache-Control":"no-store" });
    res.end(body);
});

async function retry(check,label) {
    for (let i=0;i<160;i++) {
        if (await check()) return;
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error("Timed out: " + label);
}

async function openApp(context) {
    const page = await context.newPage();
    const response = await page.goto(origin+area, { waitUntil:"domcontentloaded" });
    assert.equal(response.status(),200);
    await page.locator('[data-v11-page="data"]').waitFor({state:"visible"});
    await retry(() => page.evaluate(() => document.querySelector('meta[name="anime-shell-release"]')?.content)
        .then(active => active === release), "production release");
    return { page,response };
}

async function prepareProfile(browser, { failArchive = false, nativeQuota = false } = {}) {
    const context = await browser.newContext({
        serviceWorkers:"allow",isMobile:true,hasTouch:true,viewport:{ width:390,height:844 },acceptDownloads:true
    });
    const outside = [];
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.href === "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2") {
            return route.fulfill({ contentType:"text/javascript", body:"/* synthetic SDK */" });
        }
        outside.push(url.origin);
        return route.abort();
    });
    await context.addInitScript(({ origin, area }) => {
        if (location.origin !== origin || !location.pathname.startsWith(area)) return;
        const originalFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = (input, options) => {
            const url = new URL(typeof input === "string" ? input : input.url,location.href);
            if (url.origin !== origin) return Promise.reject(Error("External access blocked in synthetic profile"));
            return originalFetch(input,options);
        };
        for (const method of ["add","put"]) {
            const native = IDBObjectStore.prototype[method];
            IDBObjectStore.prototype[method] = function (...args) {
                if (localStorage.getItem("quota-test-fail-vault") === "1" && this.name === "entries") {
                    throw new DOMException("Synthetic IndexedDB quota failure","QuotaExceededError");
                }
                return native.apply(this,args);
            };
        }
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key,value) {
            if (this === localStorage) {
                const forcedKey = sessionStorage.getItem("quota-test-fail-key");
                if (key === forcedKey) {
                    sessionStorage.removeItem("quota-test-fail-key");
                    throw new DOMException("Synthetic targeted storage pressure","QuotaExceededError");
                }
                const maximum = Number(localStorage.getItem("quota-test-limit") || Infinity);
                let units = key.length + String(value).length;
                for (let index=0;index<this.length;index++) {
                    const name=this.key(index);
                    if (name !== key) units += name.length + this.getItem(name).length;
                }
                if (units > maximum) throw new DOMException("Synthetic origin quota reached","QuotaExceededError");
            }
            return write.call(this,key,value);
        };
    }, { origin,area });
    const starter = await context.newPage();
    await starter.goto(origin+area);
    await retry(() => starter.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated"),
        "service worker became active");
    await starter.close();
    const seed = await context.newPage();
    await seed.goto(origin+"/__probe");
    const nativePadding = await seed.evaluate(({ values,failArchive,nativeQuota }) => {
        for (const [key,value] of Object.entries(values)) localStorage.setItem(key,value);
        if (failArchive) localStorage.setItem("quota-test-fail-vault","1");
        if (nativeQuota) {
            const key = "quota-test-native-filler";
            const fits = length => {
                try { localStorage.setItem(key,"x".repeat(length)); return true; }
                catch (error) { if (error.name === "QuotaExceededError") return false; throw error; }
            };
            let low = 0, high = 16 * 1024 * 1024;
            if (fits(high)) throw Error("The native browser did not impose a localStorage quota within 16 MiB");
            while (high - low > 1024) {
                const middle = (low + high) >>> 1;
                if (fits(middle)) low = middle;
                else high = middle;
            }
            if (low < 12000 || !fits(low - 12000)) throw Error("Could not seed the native quota profile");
            return low - 12000;
        }
        let units=0;
        for (let index=0;index<localStorage.length;index++) {
            const key=localStorage.key(index);
            units+=key.length+localStorage.getItem(key).length;
        }
        // Small headroom for normal progress and notes, but the previous full
        // history + restore snapshot cannot fit in this budget.
        localStorage.setItem("quota-test-limit", String(units+12000));
    }, { values:originals,failArchive,nativeQuota });
    await seed.close();
    return { context,outside,nativePadding };
}

async function copyExport(page) {
    await page.evaluate(() => {
        window.quotaSyntheticExport=null;
        if (window.quotaSyntheticExportReady) return;
        window.quotaSyntheticExportReady=true;
        const nativeCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            window.quotaSyntheticExport = blob.text();
            return nativeCreate(blob);
        };
        const nativeClick=HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click=function () {
            if (this.download && this.href.startsWith("blob:")) return;
            return nativeClick.call(this);
        };
    });
    await page.locator('[data-v11-page="data"]').click();
    await page.locator("#v11-export").click();
    await retry(() => page.evaluate(() => window.quotaSyntheticExport !== null), "persisted backup export");
    return page.evaluate(async () => JSON.parse(await window.quotaSyntheticExport));
}

async function clickProgress(page) {
    await page.locator('[data-v11-page="currently-watching"]').click();
    await page.locator('[data-progress-action="increment"][data-anime-id="' + oldRows[0].id + '"]').click();
}

async function editNote(page,value) {
    await page.locator('[data-v11-page="currently-watching"]').click();
    await page.locator('.v11-currently-cover[data-open-detail="' + oldRows[0].id + '"]').click();
    await page.locator('#v11-detail-form [name="notes"]').fill(value);
    await page.locator('#v11-detail-form button[type="submit"]').click();
}

async function importBackup(page, file = backupFile) {
    await page.locator('[data-v11-page="data"]').click();
    await page.locator("#v11-import-file").setInputFiles(file);
    await page.locator("#v11-import-preview").filter({ hasText:/1,?600/ }).waitFor();
    await page.locator('[data-import-mode="merge"]').click();
}

async function recordExistsInVault(page, value) {
    return page.evaluate(expected => new Promise((resolve,reject) => {
        function contains(record) {
            if (typeof record === "string") {
                if (record === expected) return true;
                try { return contains(JSON.parse(record)); } catch { return false; }
            }
            return record && typeof record === "object" &&
                (JSON.stringify(record) === expected || Object.values(record).some(contains));
        }
        const open = indexedDB.open("anime-tracker-storage-vault-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("entries")) {
                db.close();
                return resolve(false);
            }
            const read = db.transaction("entries","readonly").objectStore("entries").getAll();
            read.onerror = () => { db.close(); reject(read.error); };
            read.onsuccess = () => { db.close(); resolve(read.result.some(contains)); };
        };
    }),value);
}

async function verifyBackupWithoutWriting(page, prior) {
    await page.locator('[data-v11-page="data"]').click();
    await page.locator("#v11-storage-diagnostics").waitFor({state:"visible"});
    await page.locator("#v11-backup-verify").setInputFiles(backupFile);
    const hash = createHash("sha256").update(backupFile.buffer).digest("hex");
    const result = page.locator("#v11-backup-report").filter({hasText:hash});
    await result.waitFor();
    assert.match(await result.innerText(), /2 筆動畫.*觀看歷史 1600 筆/);
    assert.deepEqual(await snapshot(page),prior);
}

const row = backup => backup[main].find(item => String(item.id) === String(oldRows[0].id));

async function snapshot(page) {
    return page.evaluate(keys => Object.fromEntries(keys.map(key => [key,localStorage.getItem(key)])),
        [main,historyKey,restores,pending,undo,"anime-quota-test-sentinel"]);
}

async function validate(browser) {
    const { context,outside } = await prepareProfile(browser);
    try {
        const { page } = await openApp(context);
        assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),true);
        const before = await copyExport(page);
        assert.equal(before[main].length,oldRows.length);
        assert.equal(row(before).watched,2);
        assert.equal(before.watchHistory.length,oldHistory.length);
        if (compareLegacy) {
            const disk=await snapshot(page);
            assert.equal(disk[restores],originals[restores]);
            await clickProgress(page);
            await page.locator("#toast-msg").filter({hasText:"觀看進度尚未變更"}).waitFor();
            assert.deepEqual(await snapshot(page),disk);
            await importBackup(page);
            await page.locator("#toast-msg").filter({hasText:"資料尚未儲存"}).waitFor();
            assert.deepEqual(await snapshot(page),disk);
            assert.deepEqual(outside,[]);
            return { release, legacyProgressQuotaReproduced:true, legacyImportQuotaReproduced:true };
        }
        await retry(async () => (await snapshot(page))[restores] === null, "verified archival frees localStorage");
        assert.ok(await recordExistsInVault(page,originals[restores]));
        await verifyBackupWithoutWriting(page,await snapshot(page));

        await clickProgress(page);
        await retry(async () => row(await copyExport(page)).watched === 3, "near-limit progress write");
        const progress = await copyExport(page);
        assert.equal(progress.watchHistory.length,before.watchHistory.length+1);
        assert.equal(row(progress).favorite, true);

        const note = "合成更新筆記，應在離線重啟後保留";
        await editNote(page,note);
        await retry(async () => row(await copyExport(page)).notes === note, "near-limit note write");
        const preImport = await snapshot(page);

        // A genuine multi-key save fault should neither publish a partial
        // collection nor erase the historic points.
        await page.evaluate(key => sessionStorage.setItem("quota-test-fail-key",key),historyKey);
        await importBackup(page);
        await page.locator("#toast-msg").filter({hasText:"資料尚未儲存"}).waitFor();
        assert.equal(await page.evaluate(() => sessionStorage.getItem("quota-test-fail-key")),null);
        assert.deepEqual(await snapshot(page),preImport);
        await page.reload({waitUntil:"domcontentloaded"});
        assert.deepEqual(await snapshot(page),preImport);

        await importBackup(page);
        await retry(async () => (await copyExport(page)).watchHistory.length >= oldHistory.length+newHistory.length, "large import persisted");
        const imported=await copyExport(page);
        assert.ok(imported[main].some(item => String(item.id) === String(newRows[1].id)));
        assert.ok(imported.watchHistory.some(entry => entry.id === "import-history-1599"));
        assert.ok(imported.watchHistory.some(entry => entry.id === "legacy-history-899"));
        assert.equal(row(imported).notes,note);
        assert.equal(imported[main].find(item => item.id === oldRows.at(-1).id)?.deletedAt,at);
        const stillStored = await snapshot(page);
        assert.equal(stillStored["anime-quota-test-sentinel"],originals["anime-quota-test-sentinel"]);
        assert.equal(stillStored[undo],originals[undo]);

        const originalLimit = await page.evaluate(() => {
            const limit = localStorage.getItem("quota-test-limit");
            let units = 0;
            for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index);
                units += key.length + localStorage.getItem(key).length;
            }
            localStorage.setItem("quota-test-limit", String(units + 1024));
            return limit;
        });
        await importBackup(page,oversizedBackupFile);
        await page.locator("#toast-msg").filter({hasText:"資料尚未儲存"}).waitFor();
        assert.deepEqual(await snapshot(page),stillStored);
        await page.evaluate(limit => localStorage.setItem("quota-test-limit",limit),originalLimit);

        await page.close();
        await context.setOffline(true);
        const reopened = await openApp(context);
        assert.ok(reopened.response.fromServiceWorker());
        const offline=await copyExport(reopened.page);
        assert.deepEqual(offline[main],imported[main]);
        assert.deepEqual(offline.watchHistory,imported.watchHistory);
        assert.deepEqual(outside,[]);
        assert.ok(await recordExistsInVault(reopened.page,originals[restores]));
        return { release, archivePreserved:true, backupVerified:true, progress:true, notes:true,
            rollbackAfterQuota:true, largeImport:true, oversizedImportProtected:true, offlineRestart:true };
    } finally { await context.close(); }
}

async function checkArchiveFailure(browser) {
    const { context,outside } = await prepareProfile(browser,{ failArchive:true });
    try {
        const { page } = await openApp(context);
        const exported = await copyExport(page);
        assert.equal(row(exported).watched,2);
        assert.equal(exported.watchHistory.length,oldHistory.length);
        assert.equal((await snapshot(page))[restores],originals[restores]);
        await page.evaluate(() => localStorage.removeItem("quota-test-fail-vault"));
        await page.reload({ waitUntil:"domcontentloaded" });
        await page.locator('[data-v11-page="data"]').waitFor({state:"visible"});
        await retry(async () => (await snapshot(page))[restores] === null, "archive retried after quota");
        assert.ok(await recordExistsInVault(page,originals[restores]));
        const recovered=await copyExport(page);
        assert.equal(row(recovered).watched,2);
        assert.deepEqual(recovered.watchHistory,exported.watchHistory);
        await clickProgress(page);
        await retry(async () => row(await copyExport(page)).watched === 3, "progress before restoring an archived point");
        await page.locator('[data-v11-page="data"]').click();
        page.once("dialog",dialog => dialog.accept());
        await page.locator('[data-restore-id="legacy-restore-1"]').click();
        await page.locator("#toast-msg").filter({hasText:"還原完成"}).waitFor();
        const restored = await copyExport(page);
        assert.equal(row(restored).watched,2);
        assert.deepEqual(restored.watchHistory,exported.watchHistory);
        assert.deepEqual(outside,[]);
        return { vaultFailurePreservedOriginal:true, archiveRetry:true, oldRestorePointUsable:true };
    } finally { await context.close(); }
}

async function checkNativePressure(browser) {
    const { context,outside,nativePadding } = await prepareProfile(browser,{ nativeQuota:true });
    try {
        const { page } = await openApp(context);
        await retry(async () => (await snapshot(page))[restores] === null, "archive under native browser quota");
        assert.ok(await recordExistsInVault(page,originals[restores]));
        await clickProgress(page);
        await retry(async () => row(await copyExport(page)).watched === 3, "progress under native browser quota");
        const preserved = await page.evaluate(length => localStorage.getItem("quota-test-native-filler") === "x".repeat(length),nativePadding);
        assert.equal(preserved,true);
        assert.deepEqual(outside,[]);
        return { nativeQuotaRecovered:true, nativePaddingCodeUnits:nativePadding };
    } finally { await context.close(); }
}

(async () => {
    const engine=process.env.POSTER_ENGINE === "webkit" ? webkit : chromium;
    let browser;
    try {
        await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
        origin="http://127.0.0.1:"+server.address().port;
        browser=await engine.launch({ headless:true,...(engine === chromium ? { channel:"msedge" } : {}) });
        const report=await validate(browser);
        if (!compareLegacy) Object.assign(report,await checkArchiveFailure(browser),await checkNativePressure(browser));
        console.log(JSON.stringify({ engine:browser.version(),...report }));
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode=1; });
