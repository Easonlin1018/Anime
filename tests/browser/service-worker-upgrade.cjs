"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require(process.env.POSTER_PLAYWRIGHT || "playwright");
const repo = path.resolve(process.env.POSTER_REPO || path.join(__dirname, "../.."));
const gitRepo = path.resolve(process.env.POSTER_GIT_REPO || repo);
const engine = process.env.POSTER_ENGINE === "webkit" ? "webkit" : "edge";
const legacySha = "53f12d5abca2ee8b29a965a2cede2d6b4421d868";
const previousSha = "e70bb8dba3fff37a6f7828a328e3a508c4ddfb16";
const previous = "poster-fix-4";
const old = "currently-watching-1";
const legacyCache = "anime-tracker-v11-" + old;
const version = "series-identity-1";
const release = "releases/" + version + "/";
const currentCache = "anime-tracker-v11-" + version;
const area = "/Anime/";
const worker = fs.readFileSync(path.join(repo, "sw.js"), "utf8");
const releaseFiles = Object.keys(JSON.parse(worker.match(/^const SHELL_HASHES = (\{[\s\S]*?^\});/m)[1]));
const rootFiles = ["index.html","v11-core.js","v11-ui.js","v11-styles.css","cross-media.js","spotify-themes.js",
    "vendor/opencc-js-1.4.1-full.js","manifest.webmanifest","icons/app-icon.svg"];
const legacySource = file => execFileSync("git",["show",legacySha + ":" + file],{cwd:gitRepo,maxBuffer:8*1024*1024});
const legacyWorker = legacySource("sw.js");
const previousSource = file => execFileSync("git",["show",previousSha + ":" + file],{cwd:gitRepo,maxBuffer:8*1024*1024});
const previousWorker = previousSource("sw.js");
const root = Object.fromEntries(rootFiles.map(file => [file,fs.readFileSync(path.join(repo,file))]));
const immutable = Object.fromEntries(releaseFiles.map(file => [file,fs.readFileSync(path.join(repo,release,file))]));
const previousAssets = Object.fromEntries(releaseFiles.map(file => {
    const name = "releases/" + previous + "/" + file;
    const oldBytes = previousSource(name);
    assert.deepEqual(fs.readFileSync(path.join(repo,name)).toString("utf8").replace(/\r\n/g,"\n"),oldBytes.toString("utf8"));
    return [name,oldBytes];
}));
const digest = value => createHash("sha256").update(value).digest("hex");
const canonicalDigest = bytes => digest(bytes.toString("utf8").replace(/^\uFEFF/u,"").replace(/\r\n/g,"\n"));
for (const file of rootFiles) assert.equal(canonicalDigest(root[file]), canonicalDigest(legacySource(file)), file + " legacy compatibility");
const report = {engine,legacySha,isolation:"loopback synthetic records, temp browser contexts, no external API or profiles",
    sourceSha256:Object.fromEntries([["sw.js",worker],...Object.entries(root),...Object.entries(immutable).map(([file,value])=>[release+file,value])]
        .map(([file,body]) => [file,digest(body)])),cases:[]};
const trace = [];
const events = {meta:{fetchStatus:"success",updatedAt:"2026-11-01T00:00:00Z"},events:[],archive:[],synthetic:"legacy offline event cache"};
let phase = "legacy", fault = "", offline = false, origin, browser;
function mime(file) {
    if (file.endsWith(".html")) return "text/html; charset=utf-8";
    if (file.endsWith(".css")) return "text/css; charset=utf-8";
    if (file.endsWith(".svg")) return "image/svg+xml";
    if (file.endsWith(".webmanifest")) return "application/manifest+json";
    if (file.endsWith(".json")) return "application/json";
    return "text/javascript; charset=utf-8";
}
function respond(res,status,file,body) {
    res.writeHead(status,{"Content-Type":mime(file),"Cache-Control":"no-store"});
    res.end(body);
}
const server = http.createServer((req,res) => {
    if (offline) return req.socket.destroy();
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__probe") return respond(res,200,"index.html","<!doctype html><title>Isolated browser probe</title>");
    if (!url.pathname.startsWith(area)) return respond(res,404,"index.html","not the synthetic app");
    const file = url.pathname.slice(area.length) || "index.html";
    trace.push({phase,fault,file,query:url.search});
    if (file === "sw.js") {
        if (phase === "next" && fault === "worker") return respond(res,503,file,"Synthetic unavailable new worker");
        const source = phase === "legacy" ? legacyWorker : phase === "previous" ? previousWorker : worker;
        return respond(res,200,file,source);
    }
    if (root[file]) return respond(res,200,file,root[file]);
    if (file === "sync-config.js" || file === "spotify-config.js") return respond(res,200,file,"/* empty synthetic config */");
    if (file === "events.json") return fault === "events"
        ? respond(res,503,file,"Synthetic unavailable event feed") : respond(res,200,file,JSON.stringify(events));
    if (previousAssets[file]) return respond(res,200,file,previousAssets[file]);
    if (!file.startsWith(release) || phase !== "next") return respond(res,404,file,"No release fixture");
    const subpath = file.slice(release.length);
    if (subpath === "v11-core.js") {
        if (fault === "disconnect") return req.socket.destroy();
        if (fault === "missing") return respond(res,503,file,"Synthetic unavailable release core");
        if (fault === "stale") return respond(res,200,file,root["v11-core.js"]);
    }
    return immutable[subpath] ? respond(res,200,file,immutable[subpath]) : respond(res,404,file,"Fixture absent");
});

const V = require(path.join(repo,release,"v11-core.js"));
const at = "2026-11-01T00:00:00.000Z";
const record = V.migrateAnime({id:"fixture-one",title:"Synthetic direct upgrade",anilistId:781246,source:"anilist",sourceId:781246,
    category:"watching",categorySource:"manual",categoryManuallyEdited:true,format:"TV",status:"RELEASING",
    episodes:12,totalEpisodes:12,releasedEpisodes:6,watched:3,currentEpisode:3,rating:8,note:"Synthetic retained note",
    poster:"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
    notes:"Synthetic retained note",createdAt:at,addedAt:at,updatedAt:at,lastWatchedAt:at},at);
const mainKey = V.STORAGE_KEY, historyKey = V.HISTORY_KEY, undoKey = "anime_tracker_last_undo_v11";
const app = () => origin + area;
const nav = '[data-v11-page="currently-watching"]';
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(test,label,timeout=15000) {
    const deadline = Date.now()+timeout;
    let last;
    while (Date.now()<deadline) {
        try { if (await test()) return; } catch (error) { last=error; }
        await sleep(100);
    }
    throw Error("Timed out: " + label + (last ? " " + last.message : ""));
}
async function newContext() {
    const context = await browser.newContext({serviceWorkers:"allow",isMobile:true,hasTouch:true,viewport:{width:390,height:844}});
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.origin === "https://cdn.jsdelivr.net" && url.pathname.includes("supabase-js")) {
            return route.fulfill({status:200,contentType:"text/javascript",body:"/* empty synthetic SDK */"});
        }
        return route.abort();
    });
    await context.addInitScript(({origin,record,mainKey,historyKey,undoKey,at}) => {
        if (location.origin !== origin || !location.pathname.startsWith("/Anime/")) return;
        if (localStorage.getItem(mainKey) === null) {
            localStorage.setItem(mainKey,JSON.stringify([record]));
            localStorage.setItem(historyKey,JSON.stringify([{id:"synthetic-history",animeId:record.id,delta:3,at}]));
            localStorage.setItem(undoKey,JSON.stringify({synthetic:true,at}));
            localStorage.setItem("anime_metadata_sync_v10_1",new Date().toISOString());
        }
        const nativeFetch = window.fetch;
        window.fetch = (input,options) => {
            const url = new URL(typeof input === "string" ? input : input.url,location.href);
            if (url.origin !== origin) return Promise.reject(Error("Synthetic test blocks external fetch"));
            return nativeFetch(input,options);
        };
    },{origin,record,mainKey,historyKey,undoKey,at});
    return context;
}
function snapshot(page) {
    return page.evaluate(keys => keys.map(key=>localStorage.getItem(key)),[mainKey,historyKey,undoKey]);
}
function message(page,type) {
    return page.evaluate(type => new Promise(resolve => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) return resolve(null);
        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener("message",listener); channel.port1.close(); resolve(null); },1000);
        const channel = new MessageChannel();
        function listener(event) {
            if (!["ANIME_SW_CACHE_STATUS","ANIME_SW_STORAGE_CLIENTS"].includes(event.data?.type)) return;
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener("message",listener);
            channel.port1.close();
            resolve(event.data);
        }
        navigator.serviceWorker.addEventListener("message",listener);
        channel.port1.onmessage = listener;
        controller.postMessage({type},[channel.port2]);
    }),type);
}
const getCache = async page => (await message(page,"GET_CACHE_STATUS"))?.cacheVersion;
const safe = async page => (await message(page,"CHECK_STORAGE_CLIENTS"))?.safe;
async function assertShell(page,expected) {
    await page.locator(nav).waitFor({state:"visible"});
    assert.ok(page.url().startsWith(app()));
    const scriptPath = file => expected === old ? file + "?v=" + old : "releases/" + expected + "/" + file;
    const assets = await page.evaluate(() => [...document.querySelectorAll("script[src],link[rel=stylesheet]")]
        .map(node => node.getAttribute("src") || node.getAttribute("href")));
    for (const file of ["v11-core.js","v11-ui.js","cross-media.js","spotify-themes.js","v11-styles.css"]) {
        assert.ok(assets.includes(scriptPath(file)),file + " in " + expected);
    }
    assert.equal(await page.evaluate(() => !!window.AnimeTrackerV11),true);
    await page.locator(nav).click();
    await page.getByText(record.title,{exact:true}).first().waitFor({state:"visible"});
}
async function oldTab(context) {
    const page = await context.newPage();
    await page.goto(app());
    await until(async () => await getCache(page) === legacyCache,"old worker controlling");
    await assertShell(page,old);
    assert.deepEqual(await page.evaluate(()=>fetch("events.json?t=1").then(r=>r.json())),events);
    return page;
}
async function askUpdate(page) {
    return page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        try { await registration.update(); return true; } catch { return false; }
    });
}
async function currentTab(context,previous,activateOffline = false) {
    const monitor = await context.newPage();
    await monitor.goto(origin + "/__probe");
    offline = activateOffline;
    await previous.close();
    await until(() => monitor.evaluate(url => navigator.serviceWorker.getRegistration(url)
        .then(r => r?.active?.state === "activated" && !r.waiting && !r.installing),app()),"new worker activated after old tab closes");
    await monitor.close();
    const page = await context.newPage();
    await page.goto(app());
    await until(async () => await getCache(page) === currentCache,"new worker controlling");
    return page;
}
async function limitQuota(context,page) {
    const cdp = await context.newCDPSession(page);
    const {usage} = await cdp.send("Storage.getUsageAndQuota",{origin});
    await cdp.send("Storage.overrideQuotaForOrigin",{origin,quotaSize:Math.ceil(usage)+1024});
    return async () => { await cdp.send("Storage.overrideQuotaForOrigin",{origin}); await cdp.detach(); };
}
async function assertNetworkLegacy() {
    const response = await fetch(app());
    assert.equal(response.status,200);
    assert.equal(canonicalDigest(Buffer.from(await response.arrayBuffer())),canonicalDigest(root["index.html"]));
    const core = await fetch(app() + "v11-core.js?v=" + old);
    assert.equal(canonicalDigest(Buffer.from(await core.arrayBuffer())),canonicalDigest(root["v11-core.js"]));
}
async function upgrade(context,mode) {
    const page = await oldTab(context);
    const before = await snapshot(page);
    phase = "next";
    fault = mode;
    let removeLimit;
    try {
        if (mode === "quota") removeLimit = await limitQuota(context,page);
        await assertNetworkLegacy();
        const start = trace.length;
        await askUpdate(page);
        await until(() => trace.slice(start).some(item => item.file === (mode==="worker" ? "sw.js" : release+"v11-core.js")),
            "direct update requests arrived");
        await until(() => page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>!r.installing)),"failed update settled");
        assert.equal(await page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)),false);
        assert.equal(await getCache(page),legacyCache);
        assert.ok(!(await page.evaluate(()=>caches.keys())).some(name=>name.startsWith(currentCache+"-shell-")));
        offline = true;
        await page.reload();
        await assertShell(page,old);
        assert.deepEqual(await snapshot(page),before);
        assert.deepEqual(await page.evaluate(()=>fetch("events.json?t=2").then(r=>r.json())),events);
    } finally {
        offline = false;
        fault = "";
        if (removeLimit) await removeLimit();
    }
    await askUpdate(page);
    await until(() => page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)),"new release waiting");
    assert.equal(await getCache(page),legacyCache);
    // The first new-page request must read the old cache, not a refreshed feed.
    fault = "events";
    const latest = await currentTab(context,page,mode === "disconnect");
    await assertShell(latest,version);
    assert.equal(await safe(latest),true);
    assert.deepEqual(await latest.evaluate(()=>fetch("events.json?t=3").then(r=>r.json())),events);
    offline = true;
    await latest.reload();
    await assertShell(latest,version);
    assert.deepEqual(await snapshot(latest),before);
    assert.deepEqual(await latest.evaluate(()=>fetch("events.json?t=3").then(r=>r.json())),events);
    return {mode,legacyOffline:true,newReleaseOffline:true,eventsRetained:true,storageIdentical:true,noBridge:true};
}
async function repair(context) {
    const page = await oldTab(context);
    phase = "next";
    await askUpdate(page);
    await until(() => page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)),"new release waiting");
    const latest = await currentTab(context,page);
    await assertShell(latest,version);
    const before = await snapshot(latest);
    await latest.evaluate(async ({prefix,core})=>{
        const names = (await caches.keys()).filter(name=>name.startsWith(prefix+"-shell-"));
        for (const name of names) await (await caches.open(name)).delete(new URL(core,location.href));
    },{prefix:currentCache,core:release+"v11-core.js"});
    offline = true;
    assert.equal((await latest.reload()).status(),503);
    offline = false;
    fault = "stale";
    assert.equal((await latest.reload()).status(),503);
    fault = "";
    const count = trace.length;
    assert.equal((await latest.reload()).status(),200);
    assert.equal(new Set(trace.slice(count).filter(item=>item.file.startsWith(release)).map(item=>item.file)).size,releaseFiles.length);
    await assertShell(latest,version);
    offline = true;
    await latest.reload();
    await assertShell(latest,version);
    assert.deepEqual(await snapshot(latest),before);
    assert.deepEqual(await latest.evaluate(()=>fetch("events.json?t=3").then(r=>r.json())),events);
    return {offlineIncomplete503:true,wrongResponse503:true,fullVerifiedRepair:true,newOffline:true,storageIdentical:true};
}
async function gate(context) {
    phase = "next";
    const first = await context.newPage();
    await first.goto(app());
    await assertShell(first,old);
    await until(()=>first.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>r?.active?.state==="activated")),"first worker active");
    assert.equal(await first.evaluate(()=>!!navigator.serviceWorker.controller),false);
    const latest = await context.newPage();
    await latest.goto(app());
    await assertShell(latest,version);
    assert.equal(await safe(latest),false);
    await first.close();
    await until(async()=>await safe(latest)===true,"legacy client gone and safety gate open");
    return {firstLegacyNotClaimed:true,blockedWhileUncontrolledLegacyOpen:true,unblockedAfterClose:true};
}
async function upgradeCurrentProduction(context) {
    phase = "previous";
    const starter = await context.newPage();
    await starter.goto(origin + "/__probe");
    await starter.evaluate(releaseVersion => navigator.serviceWorker.register("/Anime/sw.js?v=" + releaseVersion),previous);
    await until(() => starter.evaluate(url => navigator.serviceWorker.getRegistration(url)
        .then(reg => reg?.active?.state === "activated"),app()),"production " + previous + " worker activated");
    await starter.close();
    const prior = await context.newPage();
    await prior.goto(app());
    await assertShell(prior,previous);
    assert.equal(await getCache(prior),"anime-tracker-v11-" + previous);
    const before = await snapshot(prior);
    assert.deepEqual(await prior.evaluate(()=>fetch("events.json?t=1").then(r=>r.json())),events);
    phase = "next";
    fault = "missing";
    const start = trace.length;
    await askUpdate(prior);
    await until(() => trace.slice(start).some(item => item.file === release+"v11-core.js"),version + " requests arrived");
    await until(() => prior.evaluate(()=>navigator.serviceWorker.getRegistration()
        .then(reg=>!reg.installing && !reg.waiting)),"failed " + version + " install settled");
    assert.equal(await getCache(prior),"anime-tracker-v11-" + previous);
    offline = true;
    await prior.reload();
    await assertShell(prior,previous);
    assert.deepEqual(await snapshot(prior),before);
    offline = false;
    fault = "";
    await askUpdate(prior);
    await until(() => prior.evaluate(()=>navigator.serviceWorker.getRegistration().then(reg=>!!reg.waiting)),version + " waiting");
    const latest = await currentTab(context,prior,true);
    await assertShell(latest,version);
    assert.deepEqual(await snapshot(latest),before);
    assert.deepEqual(await latest.evaluate(()=>fetch("events.json?t=2").then(r=>r.json())),events);
    return {previousRelease:previous,currentRelease:version,previousOffline:true,currentOffline:true,
        storageIdentical:true,eventsRetained:true};
}
async function run(name,scenario) {
    phase = "legacy"; fault = ""; offline = false;
    const context = await newContext();
    const result = {name};
    report.cases.push(result);
    try {
        result.details = await scenario(context);
        result.status = "PASS";
    } catch (error) {
        result.status = "FAIL"; result.error = error.stack;
    } finally {
        offline = false;
        await context.close();
    }
    console.log(result.status,name,result.error?.split("\n")[0] || "");
}
(async()=>{
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    origin = "http://127.0.0.1:"+server.address().port;
    browser = engine==="webkit" ? await webkit.launch({headless:true,timeout:10000})
        : await chromium.launch({...(process.env.POSTER_EDGE_EXECUTABLE
            ? { executablePath:process.env.POSTER_EDGE_EXECUTABLE } : { channel:"msedge" }), headless:true, args:["--disable-background-networking","--disable-component-update","--no-first-run"]});
    report.version = browser.version();
    const probe = await browser.newPage();
    await probe.goto("data:text/html,<title>engine probe</title>");
    await probe.close();
    for (const mode of ["disconnect","missing","stale","worker",...(engine === "edge" ? ["quota"] : [])]) {
        await run("Direct upgrade preserves legacy under " + mode,context=>upgrade(context,mode));
    }
    await run("Online recovery after physical cache eviction",repair);
    await run("First-install storage client gate",gate);
    await run("Direct production " + previous + " to " + version + " upgrade preserves offline data on interrupted install",upgradeCurrentProduction);
})().catch(error=>{ report.environmentError = error.stack; }).finally(async()=>{
    await browser?.close().catch(()=>{});
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    report.summary = {pass:report.cases.filter(item=>item.status==="PASS").length,total:report.cases.length};
    if (process.env.POSTER_BROWSER_REPORT) fs.writeFileSync(process.env.POSTER_BROWSER_REPORT,JSON.stringify(report,null,2));
    console.log(JSON.stringify({engine,version:report.version,summary:report.summary,environmentError:report.environmentError?.split("\n")[0]}));
    process.exitCode = report.environmentError || report.summary.pass !== report.summary.total ? 1 : 0;
});
