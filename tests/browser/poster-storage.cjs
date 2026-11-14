"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require(process.env.POSTER_PLAYWRIGHT || "playwright");

const repo = path.resolve(process.env.POSTER_TEST_REPO || path.join(__dirname, "../.."));
const release = "legacy-series-1";
const releasePath = "releases/" + release;
const V = require(path.join(repo, releasePath, "v11-core.js"));
const scope = "/Anime/";
const now = "2026-10-07T00:00:00.000Z";
const appFiles = ["index.html","v11-core.js","v11-ui.js","v11-styles.css","cross-media.js","spotify-themes.js",
    "vendor/opencc-js-1.4.1-full.js"];
const files = new Set([...appFiles, ...appFiles.map(file => releasePath + "/" + file),
    "sw.js","manifest.webmanifest","icons/app-icon.svg"]);
const fixture = id => V.migrateAnime({
    id:"fixture-" + id, source:"anilist", sourceId:id, anilistId:id, anilistIdentitySource:"anilist-api",
    title:"Synthetic anime " + id, titleSource:"manual", titleManuallyEdited:true,
    status:"RELEASING", category:"watching", categorySource:"automatic", categoryManuallyEdited:false,
    watched:3, currentEpisode:3, episodes:12, totalEpisodes:12, year:2026, format:"TV",
    poster:"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
    createdAt:now, updatedAt:now, addedAt:now
}, now);

let pending, origin;
const received = [];
function reply(response, status, type, body) {
    response.writeHead(status, { "content-type":type, "cache-control":"no-store" });
    response.end(body);
}
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith(scope)) return reply(res, 404, "text/plain", "");
    const name = url.pathname.slice(scope.length) || "index.html";
    if (name === "__anilist") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (/\bquery AnimeSeriesMetadata\b/u.test(body.query)) {
            return reply(res, 200, "application/json", '{"data":{"Page":{"media":[]}}}');
        }
        received.push(body);
        const request = pending;
        if (!request) return reply(res, 409, "text/plain", "Unexpected synthetic API request");
        request.started(body);
        await request.release;
        return reply(res, 200, "application/json", JSON.stringify({ data:{ Page:{ media:request.media } } }));
    }
    if (name === "events.json") return reply(res, 200, "application/json", '{"events":[],"archive":[]}');
    if (["sync-config.js","spotify-config.js"].includes(name)) return reply(res, 200, "text/javascript", "/* synthetic config */");
    if (!files.has(name)) return reply(res, 404, "text/plain", "Outside synthetic allowlist");
    const type = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css"
        : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".webmanifest") ? "application/manifest+json" : "text/javascript";
    return reply(res, 200, type + "; charset=utf-8", fs.readFileSync(path.join(repo, name)));
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function until(check, label) {
    for (let attempt = 0; attempt < 120; attempt++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error("Timed out: " + label);
}
function prepareReply() {
    const start = deferred(), finish = deferred();
    pending = { started:start.resolve, release:finish.promise, media:[60101,60102,60103].map(id => ({
        id, title:{ native:"Synthetic anime " + id }, episodes:24, format:"TV", status:"RELEASING",
        startDate:{ year:2025, month:1, day:1 },
        coverImage:{ large:"https://images.example.invalid/" + id + ".svg" }
    })) };
    return { requested:start.promise, respond:finish.resolve };
}
async function waitForRequest(network) {
    let timer;
    try {
        return await Promise.race([network.requested, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("Synthetic AniList request did not arrive")), 10000);
        })]);
    } finally { clearTimeout(timer); }
}
const storage = page => page.evaluate(({ main, history }) => ({
    rows:JSON.parse(localStorage.getItem(main) || "[]"), history:JSON.parse(localStorage.getItem(history) || "[]")
}), { main:V.STORAGE_KEY, history:V.HISTORY_KEY });
const get = (data, id) => data.rows.find(row => row.id === "fixture-" + id);
const app = () => origin + scope;
const nav = '[data-v11-page="currently-watching"]';

async function setup(browser, { disableLocks = false, rows = [60101,60102,60103].map(fixture), coverRoutes = new Map() } = {}) {
    const context = await browser.newContext({ viewport:{ width:390,height:844 }, isMobile:true, hasTouch:true });
    await context.route("**/*", route => {
        const target = new URL(route.request().url());
        if (target.origin === origin) return route.continue();
        if (target.origin === "https://cdn.jsdelivr.net" && target.pathname.includes("supabase-js")) {
            return route.fulfill({ contentType:"text/javascript", body:"/* synthetic SDK */" });
        }
        if (target.origin === "https://images.example.invalid") {
            const kind = coverRoutes.get(target.pathname);
            if (kind === "valid") return route.fulfill({ contentType:"image/svg+xml",
                body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"><rect width="20" height="30" fill="red"/></svg>' });
            if (kind === "nonimage") return route.fulfill({ contentType:"text/html", body:"<h1>Synthetic CDN error</h1>" });
            if (kind === "corrupt") return route.fulfill({ contentType:"image/png", body:"Synthetic damaged image bytes" });
            if (kind === "aborted") return route.abort();
            return route.fulfill({ status:404, contentType:"text/plain", body:"Synthetic missing image" });
        }
        return route.abort();
    });
    await context.addInitScript(({ origin, rows, main, history, now, disableLocks }) => {
        if (location.origin !== origin) return;
        if (localStorage.getItem(main) === null) {
            localStorage.setItem(main, JSON.stringify(rows));
            localStorage.setItem(history, JSON.stringify([{ id:"synthetic-history", animeId:"fixture-60101", delta:3, at:now }]));
            localStorage.setItem("anime_metadata_sync_v10_1", new Date().toISOString());
        }
        if (disableLocks) Object.defineProperty(navigator, "locks", { value:undefined });
        const native = window.fetch;
        window.fetch = (resource, options) => {
            const target = new URL(typeof resource === "string" ? resource : resource.url, location.href);
            if (target.hostname === "graphql.anilist.co") return native(origin + "/Anime/__anilist", options);
            if (target.origin !== origin) throw Error("External test fetch blocked");
            return native(resource, options);
        };
    }, { origin, rows, main:V.STORAGE_KEY, history:V.HISTORY_KEY, now, disableLocks });
    const legacy = await context.newPage();
    await legacy.goto(app());
    await until(() => legacy.evaluate(async () =>
        (await navigator.serviceWorker.getRegistration())?.active?.state === "activated"), "initial worker activation");
    return { context, legacy };
}

async function openRelease(context) {
    const page = await context.newPage();
    await page.goto(app());
    await page.locator(nav).waitFor({ state:"visible" });
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="anime-shell-release"]')?.content), release);
    return page;
}

async function twoTabs(context) {
    const a = await openRelease(context), b = await openRelease(context);
    try {
        const network = prepareReply();
        const syncing = a.evaluate(() => syncAnimeMetadata(true));
        try {
            const request = await waitForRequest(network);
            assert.deepEqual(request.variables.ids.sort(), [60101,60102,60103]);
            await b.evaluate(() => openAnimeDetail("fixture-60101"));
            const form = b.locator("#v11-detail-form");
            await form.locator('[name="totalEpisodes"]').fill("17");
            await form.locator('[name="year"]').fill("2019");
            await form.locator('[name="notes"]').fill("Synthetic second-tab note");
            await form.locator('[name="category"]').selectOption("backlog");
            await form.locator('button[type="submit"]').click();
            await b.waitForFunction(key => JSON.parse(localStorage.getItem(key))[0].totalEpisodes === 17, V.STORAGE_KEY);
            assert.equal(await b.evaluate(() => updateProgress("fixture-60101", 1)), true);
            await b.evaluate(() => withAnimeStorageWrite(() => {
                const rows = JSON.parse(localStorage.getItem(STORAGE_KEY));
                rows.find(row => row.id === "fixture-60101").poster = "./synthetic/local.svg";
                localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
            }, { hydrate:false }));
            b.once("dialog", dialog => dialog.accept());
            await b.evaluate(() => deleteAnime("fixture-60103"));
            await b.locator('[data-v11-page="manga"]').click();
            const add = b.locator("#cross-media-add");
            await add.locator('[name="mediaType"]').selectOption("anime");
            await add.locator('[name="title"]').fill("Synthetic concurrently added anime");
            await add.locator('button[type="submit"]').click();
            await b.waitForFunction(key => JSON.parse(localStorage.getItem(key)).some(row => row.title === "Synthetic concurrently added anime"), V.STORAGE_KEY);
            const before = await storage(b);
            assert.ok(get(before,60103).deletedAt);
            network.respond();
            await syncing;
            const after = await storage(b);
            for (const field of ["episodes","totalEpisodes","year","notes","category","poster","watched","currentEpisode"]) {
                assert.deepEqual(get(after,60101)[field], get(before,60101)[field], field);
            }
            assert.equal(get(after,60101).watched,4);
            assert.equal(get(after,60101).category,"backlog");
            assert.equal(get(after,60102).totalEpisodes,24);
            assert.equal(get(after,60102).anilistCover?.id,"60102");
            assert.deepEqual(get(after,60103),get(before,60103));
            assert.deepEqual(after.history,before.history);
            assert.ok(after.rows.some(row => row.title === "Synthetic concurrently added anime"));
        } finally {
            network.respond(); await syncing.catch(() => {}); pending = null;
        }

        const repeat = prepareReply();
        await a.evaluate(() => {
            const safetyCheck = checkAnimeStorageClients;
            window.releaseStorageGate = null;
            checkAnimeStorageClients = async () => {
                await safetyCheck();
                if (!window.releaseStorageGate) await new Promise(resolve => { window.releaseStorageGate = resolve; });
            };
        });
        const syncingAgain = a.evaluate(() => syncAnimeMetadata(true));
        try {
            await waitForRequest(repeat);
            repeat.respond();
            await a.waitForFunction(() => Boolean(window.releaseStorageGate));
            const queued = b.evaluate(() => updateProgress("fixture-60101", 1));
            await until(() => b.evaluate(async () => (await navigator.locks.query()).pending
                .some(lock => lock.name === "anime-tracker-v11-storage")), "second-tab writer queued");
            assert.equal(get(await storage(b),60101).watched,4);
            await a.evaluate(() => window.releaseStorageGate());
            await syncingAgain;
            assert.equal(await queued,true);
            const saved = get(await storage(b),60101);
            assert.equal(saved.watched,5);
            assert.equal(saved.totalEpisodes,17);
            assert.equal(saved.year,2019);
        } finally {
            repeat.respond();
            await a.evaluate(() => window.releaseStorageGate?.()).catch(() => {});
            await syncingAgain.catch(() => {});
            pending = null;
        }
    } finally { await a.close(); await b.close(); }
}

async function recoverFailedSavedCovers(browser) {
    const cover = name => `https://images.example.invalid/${name}`;
    const withSavedCover = (id, large, medium = "", extra = {}) => ({ ...fixture(id), poster:"",
        notes:"Synthetic preserved notes", favorite:true, rating:8,
        anilistCover:{ id:String(id), large:cover(large), medium:medium && cover(medium) }, ...extra });
    const rows = [
        withSavedCover(60111, "404.svg", "", { poster:cover("user.svg") }),
        withSavedCover(60112, "text.svg"),
        withSavedCover(60113, "aborted.svg"),
        withSavedCover(60114, "corrupt.png"),
        withSavedCover(60115, "404.svg", "retained-medium.svg"),
        withSavedCover(60116, "404.svg"),
        withSavedCover(60117, "404.svg"),
        withSavedCover(60120, "text.svg", "", { id:"synthetic-duplicate", aniListId:60117 }),
        { ...fixture(60118), source:"", sourceId:"", anilistId:"", anilistIdentitySource:"",
            poster:cover("404.svg") },
        withSavedCover(60119, "404.svg", "", { deletedAt:new Date().toISOString(), category:"_deleted" })
    ];
    const coverRoutes = new Map([
        ["/user.svg","valid"], ["/text.svg","nonimage"], ["/aborted.svg","aborted"], ["/corrupt.png","corrupt"],
        ["/retained-medium.svg","valid"], ["/new-60111.svg","valid"], ["/new-60112.svg","valid"],
        ["/new-60113.svg","valid"], ["/new-60114.svg","valid"]
    ]);
    const requestCount = received.length;
    const { context, legacy } = await setup(browser, { rows, coverRoutes });
    try {
        await legacy.close();
        const page = await openRelease(context);
        await page.locator(nav).click();
        const button = page.locator('[data-v11-page-group="currently-watching"] [data-v11-recover-covers]');
        const coverImage = id => page.locator(`.v11-currently-cover[data-open-detail="fixture-${id}"] img`);
        const hasDisplayedCover = async (id, url) => coverImage(id).evaluate((image, expected) => {
            image.scrollIntoView({ block:"nearest" });
            return image.currentSrc === expected && image.naturalWidth > 0;
        }, url);
        await until(() => hasDisplayedCover(60115, cover("retained-medium.svg")), "valid old medium fallback");
        const before = await storage(page);
        assert.ok(before.rows.some(row => row.id === "synthetic-duplicate" && V.getAnimeAniListClaims(row).includes("60117")));
        assert.ok(get(before,60119).deletedAt);
        assert.equal(received.length, requestCount, "startup must not query records that already have a URL");
        const requested = deferred();
        pending = { started:requested.resolve, release:Promise.resolve(), media:[60111,60112,60113,60114,60115,60116,60117,60118,60119].map(id => ({
            id, type:"ANIME", coverImage:id === 60112 ? { large:cover("corrupt.png"), medium:cover("new-60112.svg") }
                : { large:cover(id === 60116 ? "text.svg" : `new-${id}.svg`) }
        })) };
        await button.click();
        const request = await waitForRequest({ requested:requested.promise });
        assert.match(request.query, /query AnimeCoverRecovery/);
        assert.deepEqual(request.variables.ids, [60111,60112,60113,60114,60116]);
        await button.waitFor({ state:"visible" });
        await until(() => button.isEnabled(), "manual cover recovery completed");
        assert.equal(received.length, requestCount + 1);
        const after = await storage(page);
        assert.deepEqual(after.history, before.history);
        for (const row of before.rows) {
            const saved = after.rows.find(item => item.id === row.id);
            if ([60111,60112,60113,60114].some(id => row.id === `fixture-${id}`)) {
                const { anilistCover, ...unchanged } = saved;
                const { anilistCover:old, ...original } = row;
                assert.deepEqual(unchanged, original);
                assert.notDeepEqual(anilistCover, old);
                assert.deepEqual(V.getStoredAniListPosterUrls(saved), [cover(`new-${row.anilistId}.svg`)]);
            } else {
                assert.deepEqual(saved, row);
            }
        }
        for (const [id, image] of [[60111,"user.svg"],[60112,"new-60112.svg"],[60113,"new-60113.svg"],
            [60114,"new-60114.svg"],[60115,"retained-medium.svg"]]) {
            await until(() => hasDisplayedCover(id, cover(image)), `displayed synthetic cover ${id}`);
        }
    } finally {
        pending = null;
        await context.close();
    }
}

(async () => {
    await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
    origin = "http://127.0.0.1:" + server.address().port;
    const engine = process.env.POSTER_ENGINE === "webkit" ? webkit : chromium;
    const browser = await engine.launch({ headless:true, ...(engine === chromium && process.env.POSTER_EDGE_EXECUTABLE
        ? { executablePath:process.env.POSTER_EDGE_EXECUTABLE } : {}) });
    try {
        console.log(engine.name() + " " + browser.version());
        const blank = await browser.newPage();
        await blank.goto("data:text/html,<title>Isolated test probe</title>");
        await blank.close();
        const { context, legacy } = await setup(browser);
        try {
            const gated = await openRelease(context);
            const original = await storage(gated);
            assert.equal(await gated.evaluate(() => updateProgress("fixture-60101", 1)),false);
            assert.deepEqual(await storage(gated),original);
            await gated.close();
            await legacy.close();
            console.log("PASS legacy uncontrolled tab blocks new writes");
            await twoTabs(context);
            console.log("PASS real two-tab add, edit, progress, cover, delete, metadata and queued write");
        } finally { await context.close(); }
        const unsupported = await setup(browser, { disableLocks:true });
        try {
            await unsupported.legacy.close();
            const page = await openRelease(unsupported.context);
            const original = await storage(page), count = received.length;
            assert.equal(await page.evaluate(() => updateProgress("fixture-60101", 1)),false);
            await page.evaluate(() => syncAnimeMetadata(true));
            assert.deepEqual(await storage(page),original);
            assert.equal(received.length,count);
            console.log("PASS missing Web Locks fails closed before a write or batch request");
        } finally { await unsupported.context.close(); }
        await recoverFailedSavedCovers(browser);
        console.log("PASS manual recovery validates saved and fresh covers, retains valid images and protects records and history");
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    server.closeAllConnections();
    server.close();
});
