"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const titleStart = html.indexOf("function stripDisplayYear");
const titleEnd = html.indexOf("async function searchWikipedia", titleStart);
const migrationStart = html.indexOf("function isMediaClearlyNotYetReleased");
const migrationEnd = html.indexOf("function buildAnimeRecordFromMedia", migrationStart);
const mediaStart = html.indexOf("function normalizeStreamingLinks");
const mediaEnd = html.indexOf("async function manualScanSequels", mediaStart);
for (const position of [titleStart, titleEnd, migrationStart, migrationEnd, mediaStart, mediaEnd]) assert.ok(position >= 0);
const pageApi = Function(`${html.slice(titleStart, titleEnd)}
${html.slice(migrationStart, migrationEnd)}
${html.slice(mediaStart, mediaEnd)}
return { getExistingAnimeMediaState, migrateExistingAnimeRecords };`)();

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`✓ ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.stack}`); }
}

const anime = (id, title, extra = {}) => ({
    id,
    title,
    aliases:[title],
    category:"backlog",
    watched:3,
    currentEpisode:3,
    rating:8,
    notes:"keep",
    customPlatform:"custom",
    createdAt:"2026-01-01T00:00:00.000Z",
    updatedAt:"2026-01-02T00:00:00.000Z",
    ...extra
});
const entry = (id, sourceId, title, extra = {}) => ({
    id,
    sourceId:String(sourceId),
    mediaType:"anime",
    title,
    aliases:[title],
    ...extra
});
const workState = (entries, extra = {}) => ({
    works:[{ workId:"work-1", title:"fixture", aliases:[], mediaEntries:entries }],
    watchHistory:[],
    ...extra
});
const recover = (list, entries, state = {}) => V.recoverLegacyAnimeIdentities(
    list,
    workState(entries, state),
    "2026-08-12T00:00:00.000Z"
);

test("1. numeric local ID alone is never an AniList identity", () => {
    assert.equal(V.getAnimeAniListIdentity(anime(182255, "Legacy")), "");
});

test("2. unique matching work media sourceId safely recovers identity", () => {
    const result = recover([anime(100, "作品")], [entry(100, 200, "作品")]);
    assert.equal(result.recoveredCount, 1);
    assert.equal(result.list[0].anilistId, 200);
    assert.equal(result.list[0].identitySource, "legacy-work-sourceId");
});

test("3. recovery never changes local anime.id", () => {
    const result = recover([anime("uuid-local", "作品")], [entry("uuid-local", 300, "作品")]);
    assert.equal(result.list[0].id, "uuid-local");
    assert.equal(result.list[0].anilistId, 300);
});

test("4. sourceId different from local ID wins without treating local ID as external", () => {
    const result = recover([anime(182255, "五等分の花嫁∬")], [entry(182255, 109261, "五等分の花嫁∬")]);
    assert.equal(V.getAnimeAniListIdentity(result.list[0]), "109261");
});

test("5. existing explicit AniList identity cannot be overridden by work sourceId", () => {
    const original = anime(182255, "五等分の花嫁∬", { anilistId:109261 });
    const result = recover([original], [entry(182255, 182255, "五等分の花嫁∬")]);
    assert.equal(result.recoveredCount, 0);
    assert.equal(result.list[0].anilistId, 109261);
});

test("6. duplicate local IDs are ambiguous and never guessed", () => {
    const result = recover([anime(1, "A"), anime(1, "A")], [entry(1, 101, "A")]);
    assert.equal(result.recoveredCount, 0);
    assert.equal(result.report.reasonCounts["ambiguous-local-id"], 2);
});

test("7. duplicate or conflicting sourceIds are ambiguous", () => {
    const result = recover(
        [anime(1, "A"), anime(2, "B")],
        [entry(1, 101, "A"), entry(2, 101, "B")]
    );
    assert.equal(result.recoveredCount, 0);
    assert.equal(result.report.reasonCounts["ambiguous-source-id"], 2);
});

test("8. title and alias mismatch prevents recovery", () => {
    const result = recover([anime(1, "作品 A")], [entry(1, 101, "完全不同作品")]);
    assert.equal(result.recoveredCount, 0);
    assert.equal(result.report.reasonCounts["title-alias-mismatch"], 1);
});

test("9. tombstone identity is recovered without restoring the record", () => {
    const original = anime(1, "已刪作品", { category:"_deleted", deletedFromCategory:"watching", deletedAt:"2026-08-01T00:00:00.000Z" });
    const result = recover([original], [entry(1, 101, "已刪作品")]);
    const migrated = pageApi.migrateExistingAnimeRecords(result.list, new Date("2026-08-12T00:00:00.000Z")).list[0];
    assert.equal(migrated.anilistId, 101);
    assert.equal(migrated.category, "_deleted");
    assert.equal(migrated.deletedFromCategory, "watching");
    assert.equal(migrated.deletedAt, original.deletedAt);
});

test("10. watchHistory keeps its stable local animeId reference", () => {
    const history = [{ id:"watch-1", animeId:"uuid-local", delta:1 }];
    const result = V.recoverLegacyAnimeIdentities(
        [anime("uuid-local", "作品")],
        workState([entry("uuid-local", 101, "作品")], { watchHistory:history }),
        "2026-08-12T00:00:00.000Z"
    );
    assert.deepEqual(history, [{ id:"watch-1", animeId:"uuid-local", delta:1 }]);
    assert.equal(result.list[0].id, history[0].animeId);
});

test("11. 109261 and 182255 never cross-contaminate", () => {
    const result = recover(
        [anime(109261, "五等分の花嫁∬"), anime("frieren-local", "葬送のフリーレン 第2期")],
        [entry(109261, 109261, "五等分の花嫁∬"), entry("frieren-local", 182255, "葬送のフリーレン 第2期")]
    );
    assert.deepEqual(result.list.map(V.getAnimeAniListIdentity), ["109261", "182255"]);
});

test("12. recovery is idempotent", () => {
    const state = workState([entry(1, 101, "作品")]);
    const first = V.recoverLegacyAnimeIdentities([anime(1, "作品")], state, "2026-08-12T00:00:00.000Z");
    const second = V.recoverLegacyAnimeIdentities(first.list, state, "2026-08-13T00:00:00.000Z");
    assert.equal(first.recoveredCount, 1);
    assert.equal(second.recoveredCount, 0);
    assert.deepEqual(second.list, first.list);
});

test("13. search existing-state uses the recovered explicit identity", () => {
    const result = recover([anime("legacy-local", "作品")], [entry("legacy-local", 101, "作品")]);
    const candidate = { id:101, title:{native:"作品", english:null, romaji:"Work"}, format:"TV", startDate:{year:2026} };
    assert.equal(pageApi.getExistingAnimeMediaState(candidate, result.list).state, "active");
});

test("14. metadata sync ID collection includes recovered active records only", () => {
    const result = recover(
        [anime(1, "Active"), anime(2, "Deleted", { category:"_deleted", deletedAt:"2026-08-01T00:00:00.000Z" })],
        [entry(1, 101, "Active"), entry(2, 102, "Deleted")]
    );
    assert.deepEqual(V.collectActiveAnimeAniListIds(result.list), [101]);
});

test("15. sourceId already owned by another explicit record is not guessed", () => {
    const result = recover(
        [anime("legacy", "Legacy"), anime("known", "Known", { anilistId:101 })],
        [entry("legacy", 101, "Legacy"), entry("known", 202, "Known")]
    );
    assert.equal(result.recoveredCount, 0);
    assert.equal(result.report.reasonCounts["conflicting-explicit-identity"], 1);
    assert.equal(V.getAnimeAniListIdentity(result.list[0]), "");
    assert.equal(V.getAnimeAniListIdentity(result.list[1]), "101");
});

test("16. backup import recovers identity before duplicate reconciliation", () => {
    const backup = {
        schemaVersion:11,
        [V.STORAGE_KEY]:[anime("legacy", "作品")],
        works:workState([entry("legacy", 101, "作品")]).works,
        watchHistory:[]
    };
    const result = V.importBackup({ animeList:[], works:[] }, backup, "replace");
    assert.equal(result.legacyIdentityRecoveryCount, 1);
    assert.equal(V.getAnimeAniListIdentity(result.animeList[0]), "101");
    assert.equal(result.animeList[0].id, "legacy");
});

test("17. cloud payload reconciliation recovers identity safely", () => {
    const payload = {
        animeList:[anime("legacy", "作品")],
        works:workState([entry("legacy", 101, "作品")]).works,
        watchHistory:[]
    };
    const result = V.mergeCloudPayload({}, payload, "cloud");
    assert.equal(result.legacyIdentityRecoveryCount, 1);
    assert.equal(V.getAnimeAniListIdentity(result.animeList[0]), "101");
});

test("18. startup recovery precedes duplicate and metadata migrations and creates one-time backup", () => {
    const recoveryPosition = html.indexOf("AnimeTrackerV11.recoverLegacyAnimeIdentities(animeList, duplicateState)");
    const duplicatePosition = html.indexOf("AnimeTrackerV11.reconcileExistingAnimeDuplicates(animeList, duplicateState)");
    const migrationPosition = html.indexOf("migrateExistingAnimeRecords(animeList)");
    assert.ok(recoveryPosition > 0 && recoveryPosition < duplicatePosition && duplicatePosition < migrationPosition);
    assert.match(html, /anime_tracker_legacy_identity_recovery_backup_v1/);
    assert.match(html, /if \(!localStorage\.getItem\(backupKey\)\)/);
});

function countDuplicates(values) {
    const counts = new Map();
    values.forEach(value => counts.set(String(value), (counts.get(String(value)) || 0) + 1));
    return [...counts.values()].filter(count => count > 1).length;
}

function userProjection(item) {
    return {
        id:item.id,
        watched:item.watched,
        currentEpisode:item.currentEpisode,
        category:item.category,
        rating:item.rating,
        notes:item.notes,
        note:item.note,
        platform:item.platform,
        customPlatform:item.customPlatform,
        addedAt:item.addedAt,
        createdAt:item.createdAt,
        updatedAt:item.updatedAt,
        deletedAt:item.deletedAt,
        aliases:item.aliases,
        relations:item.relations,
        themeSongs:item.themeSongs
    };
}

function runProductionBackupAudit(backupPath) {
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    const normalized = V.normalizeImportedBackup(backup);
    const before = normalized[V.STORAGE_KEY];
    const worksJson = JSON.stringify(normalized.works);
    const historyJson = JSON.stringify(normalized.watchHistory);
    const eventJson = JSON.stringify({ eventOverrides:normalized.eventOverrides, eventAnimeOverrides:normalized.eventAnimeOverrides });
    const state = { ...normalized, animeList:before };
    const recovery = V.recoverLegacyAnimeIdentities(before, state, "2026-08-12T00:00:00.000Z");
    const reconciled = V.reconcileExistingAnimeDuplicates(recovery.list, state);
    const migrated = pageApi.migrateExistingAnimeRecords(reconciled.list, new Date("2026-08-12T00:00:00.000Z"));
    const after = migrated.list;
    const animeEntries = normalized.works.flatMap(work => work.mediaEntries || []).filter(item => item.mediaType === "anime");
    const active = list => list.filter(item => !item.deletedAt);
    const tombstones = list => list.filter(item => item.deletedAt);

    assert.equal(before.length, 136);
    assert.equal(recovery.recoveredCount, 136);
    assert.equal(recovery.skipped.length, 0);
    assert.equal(after.length, 136);
    assert.equal(active(before).length, 128);
    assert.equal(active(after).length, 128);
    assert.equal(tombstones(before).length, 8);
    assert.equal(tombstones(after).length, 8);
    assert.equal(animeEntries.length, 136);
    assert.equal(animeEntries.filter(item => Number.isSafeInteger(Number(item.sourceId)) && Number(item.sourceId) > 0).length, 136);
    assert.equal(countDuplicates(after.map(item => item.id)), 0);
    assert.equal(countDuplicates(after.map(V.getAnimeAniListIdentity)), 0);
    assert.equal(after.filter(item => V.getAnimeAniListIdentity(item)).length, 136);
    assert.deepEqual(after.map(userProjection), before.map(userProjection));
    assert.equal(JSON.stringify(normalized.works), worksJson);
    assert.equal(JSON.stringify(normalized.watchHistory), historyJson);
    assert.equal(JSON.stringify({ eventOverrides:normalized.eventOverrides, eventAnimeOverrides:normalized.eventAnimeOverrides }), eventJson);

    const ids = new Set(after.map(item => String(item.id)));
    assert.equal(normalized.watchHistory.filter(record => !ids.has(String(record.animeId))).length, 0);
    const second = V.recoverLegacyAnimeIdentities(after, state, "2026-08-13T00:00:00.000Z");
    assert.equal(second.recoveredCount, 0);
    for (const id of [103572, 109261, 154587, 182255, 209939]) {
        const media = { id, title:{native:String(id)}, format:"TV", startDate:{} };
        assert.equal(pageApi.getExistingAnimeMediaState(media, after).state, "active");
    }
    assert.equal(pageApi.getExistingAnimeMediaState({ id:151807, title:{native:"我獨自升級"}, format:"TV", startDate:{} }, after).state, "tombstone");
    assert.equal(V.collectActiveAnimeAniListIds(after).length, 128);

    const quint = after.find(item => String(item.id) === "109261");
    const frieren = after.find(item => String(item.id) === "182255");
    assert.equal(V.getAnimeAniListIdentity(quint), "109261");
    assert.equal(V.getAnimeAniListIdentity(frieren), "182255");

    console.log("Production backup isolated audit:", JSON.stringify({
        animeBefore:before.length,
        animeAfter:after.length,
        activeBefore:active(before).length,
        activeAfter:active(after).length,
        tombstoneBefore:tombstones(before).length,
        tombstoneAfter:tombstones(after).length,
        recovered:recovery.recoveredCount,
        ambiguous:recovery.skipped.length,
        externalDuplicates:countDuplicates(after.map(V.getAnimeAniListIdentity)),
        localIdCollisions:countDuplicates(after.map(item => item.id)),
        watchHistoryBefore:normalized.watchHistory.length,
        watchHistoryAfter:normalized.watchHistory.length,
        danglingWatchHistory:normalized.watchHistory.filter(record => !ids.has(String(record.animeId))).length,
        activeMetadataIds:V.collectActiveAnimeAniListIds(after).length,
        secondPassChanges:second.recoveredCount
    }));
}

if (process.argv[2]) runProductionBackupAudit(path.resolve(process.argv[2]));

if (!process.exitCode) console.log(`\nLegacy identity recovery tests passed: ${passed}/18`);
