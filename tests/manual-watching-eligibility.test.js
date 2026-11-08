"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const at = "2026-10-08T13:00:00.000Z";
const seconds = value => Date.parse(value) / 1000;
const copy = value => JSON.parse(JSON.stringify(value));

function between(start, end) {
    const first = html.indexOf(start), last = html.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
    return html.slice(first, last);
}

function productionFunction(name) {
    const first = html.indexOf(`function ${name}(`);
    const following = /\n(?:async )?function /g;
    following.lastIndex = first;
    const next = following.exec(html);
    assert.ok(first >= 0 && next, `Missing production function: ${name}`);
    return html.slice(first, next.index);
}

const production = [
    between("function stripDisplayYear", "async function searchWikipedia"),
    between("function normalizeAnimeAliasList", "function deriveAliasVariants"),
    between("function getAniListMediaId", "function getMediaIdentityTitles"),
    between("function normalizeStreamingLinks", "function buildAnimeRecordFromMedia"),
    productionFunction("escapeHtml"),
    productionFunction("formatAiringDateTime"),
    between("function getAnimeTitlePresentation", "function normalizeAnimeSearchText")
].join("\n");

function runtime(options = {}) {
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [at])); }
        static now() { return Date.parse(at); }
    }
    const context = vm.createContext({
        AnimeTrackerV11:V, Date:Clock,
        window:{ __ANIME_STARTUP_STORAGE__:{ recoveryPending:Boolean(options.recoveryPending) } }
    });
    vm.runInContext(production, context);
    return context;
}

function waiting(extra = {}) {
    return {
        id:"generic-local", anilistId:321, source:"anilist", sourceId:"321",
        title:"通用待播作品", displayTitle:"通用待播作品", titleSource:"manual", titleManuallyEdited:true,
        category:"waiting", format:"TV", status:"UNKNOWN", episodes:12,
        releasedEpisodes:0, watched:2, currentEpisode:7, reviewWatched:3,
        notes:"保留筆記", rating:8, nextEpisode:null, nextAiringAt:null,
        startDate:{ year:null, month:null, day:null }, airDate:"未定",
        ...extra
    };
}

const eligibleCases = [
    ["missing ownership and an explicit RELEASING status", { status:"RELEASING" }],
    ["stale not-yet status with a validated past aired episode", { status:"NOT_YET_RELEASED", airedEpisode:{ episode:1, airingAt:seconds("2026-10-01T13:00:00Z") } }],
    ["released count one with numbered next episode two", { releasedEpisodes:1, nextEpisode:2, nextAiringAt:seconds("2026-10-08T14:56:00Z") }],
    ["past explicit premiere day and a validated numbered next episode", { startDate:{ year:2026, month:10, day:1 }, nextEpisode:2, nextAiringAt:seconds("2026-10-08T14:56:00Z") }],
    ["partial automatic source lacking an explicit ownership flag", { status:"RELEASING", categorySource:"automatic" }],
    ["false manual flag without an ownership source", { status:"RELEASING", categoryManuallyEdited:false }],
    ["unrecognized legacy source without a manual marker", { status:"RELEASING", categorySource:"legacy-import", categoryManuallyEdited:null }]
];

for (const [label, extra] of eligibleCases) {
    test(`confirmation is offered only with evidence: ${label}`, () => {
        const api = runtime(), record = waiting(extra), original = copy(record);
        assert.equal(api.canConfirmAnimeWatching(record), true);
        const card = api.buildAnimeItem(record);
        assert.match(card, /data-confirm-anime-watching="generic-local"/);
        assert.match(card, /data-open-detail="generic-local"/);
        assert.deepEqual(record, original, "Checking eligibility and rendering do not assign ownership or mutate progress");
    });
}

const ineligibleCases = [
    ["unknown status without episode evidence", {}],
    ["a past premiere month alone", { startDate:{ year:2026, month:10, day:null } }],
    ["a past premiere date alone", { startDate:{ year:2026, month:10, day:1 } }],
    ["a future premiere and pending first episode", { status:"NOT_YET_RELEASED", startDate:{ year:2026, month:11, day:1 }, nextEpisode:1, nextAiringAt:seconds("2026-11-01T13:00:00Z") }],
    ["future premiere contradicting a cached released count", { releasedEpisodes:1, startDate:{ year:2026, month:11, day:1 }, nextEpisode:2, nextAiringAt:seconds("2026-11-08T13:00:00Z") }],
    ["pending first episode contradicting cached count one", { releasedEpisodes:1, nextEpisode:1, nextAiringAt:seconds("2026-10-08T14:56:00Z") }],
    ["a future second episode without premiere or aired evidence", { nextEpisode:2, nextAiringAt:seconds("2026-10-08T14:56:00Z") }],
    ["an invalid fractional aired episode", { airedEpisode:{ episode:1.5, airingAt:seconds("2026-10-01T13:00:00Z") } }],
    ["a fractional cached released count", { releasedEpisodes:0.5 }],
    ["manual source even when its other marker is missing", { status:"RELEASING", categorySource:"manual" }],
    ["manual flag even when its source is missing", { status:"RELEASING", categoryManuallyEdited:true }],
    ["explicit manual waiting", { status:"RELEASING", categorySource:"manual", categoryManuallyEdited:true }],
    ["contradictory automatic source with explicit manual flag", { status:"RELEASING", categorySource:"automatic", categoryManuallyEdited:true }],
    ["a fully owned automatic waiting record", { status:"RELEASING", categorySource:"automatic", categoryManuallyEdited:false }],
    ["a finished series whose existing transition policy suggests backlog", { status:"FINISHED", releasedEpisodes:12 }],
    ["a cancelled series", { status:"CANCELLED" }],
    ["a deleted waiting record", { status:"RELEASING", deletedAt:"2026-10-01T00:00:00Z" }],
    ["an already watching record", { status:"RELEASING", category:"watching" }]
];

for (const [label, extra] of ineligibleCases) {
    test(`confirmation is withheld for ${label}`, () => {
        const api = runtime(), record = waiting(extra), original = copy(record);
        assert.equal(api.canConfirmAnimeWatching(record), false);
        const card = api.buildAnimeItem(record);
        assert.doesNotMatch(card, /data-confirm-anime-watching=/);
        assert.match(card, /data-open-detail="generic-local"/, "Withholding confirmation does not block viewing the original work");
        assert.deepEqual(record, original);
    });
}

test("an otherwise eligible waiting action remains disabled while recovery is pending", () => {
    const api = runtime({ recoveryPending:true });
    const card = api.buildAnimeItem(waiting({ status:"RELEASING" }));
    assert.match(card, /data-confirm-anime-watching="generic-local"[^>]* disabled/);
    assert.match(card, /data-open-detail="generic-local"/);
});

test("eligibility uses its supplied reference time instead of treating future episode evidence as aired", () => {
    const api = runtime();
    const record = waiting({ airedEpisode:{ episode:1, airingAt:seconds("2026-10-08T14:00:00Z") } });
    assert.equal(api.canConfirmAnimeWatching(record, new Date(at)), false);
    assert.equal(api.canConfirmAnimeWatching(record, new Date("2026-10-08T15:00:00Z")), true);
});

test("missing records cannot acquire eligibility", () => {
    const api = runtime();
    assert.equal(api.canConfirmAnimeWatching(null), false);
    assert.equal(api.canConfirmAnimeWatching(undefined), false);
});
