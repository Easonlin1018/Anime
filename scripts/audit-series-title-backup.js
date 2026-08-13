"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

const backupPath = process.argv[2];
if (!backupPath) throw new Error("Usage: node scripts/audit-series-title-backup.js <backup.json>");
const originalText = fs.readFileSync(backupPath, "utf8");
const originalBackup = JSON.parse(originalText);
const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const titleStart = html.indexOf("function stripDisplayYear");
const titleEnd = html.indexOf("async function searchWikipedia", titleStart);
const identityStart = html.indexOf("function getAniListMediaId");
const identityEnd = html.indexOf("function getMediaIdentityTitles", identityStart);
const migrationStart = html.indexOf("function isMediaClearlyNotYetReleased");
const migrationEnd = html.indexOf("function buildAnimeRecordFromMedia", migrationStart);
for (const position of [titleStart, titleEnd, identityStart, identityEnd, migrationStart, migrationEnd]) {
    assert.ok(position >= 0, "找不到正式 migration 程式");
}
const pageApi = Function(`${html.slice(titleStart, titleEnd)}
${html.slice(identityStart, identityEnd)}
${html.slice(migrationStart, migrationEnd)}
return { migrateExistingAnimeRecords };`)();

function isManual(item) {
    return item?.titleManuallyEdited === true || item?.titleSource === "manual" || item?.manualTitle === true;
}

function titleAudit(records, fields) {
    const result = { simplified:0, japanese:0, latin:0, samples:{ simplified:[], japanese:[], latin:[] } };
    for (const record of records || []) {
        if (isManual(record)) continue;
        const recordKinds = new Set();
        for (const field of fields) {
            const values = Array.isArray(record?.[field]) ? record[field] : [record?.[field]];
            for (const rawValue of values) {
                const value = String(rawValue || "").trim();
                if (!value) continue;
                const hasHan = /\p{Script=Han}/u.test(value);
                const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
                const kind = hasHan && !hasKana && V.toTraditionalChinese(value) !== value
                    ? "simplified"
                    : hasKana
                        ? "japanese"
                        : !hasHan && /[A-Za-z]/u.test(value)
                            ? "latin"
                            : "";
                if (!kind) continue;
                recordKinds.add(kind);
                if (result.samples[kind].length < 5) result.samples[kind].push({ id:record.id || record.workId, field, value });
            }
        }
        for (const kind of recordKinds) result[kind]++;
    }
    return result;
}

function explicitDuplicateCount(list) {
    const counts = new Map();
    for (const item of list) {
        if (item.deletedAt) continue;
        const id = V.getAnimeAniListIdentity(item);
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...counts.values()].filter(count => count > 1).reduce((sum, count) => sum + count - 1, 0);
}

function localCollisionCount(list) {
    const counts = new Map();
    for (const item of list) counts.set(String(item.id), (counts.get(String(item.id)) || 0) + 1);
    return [...counts.values()].filter(count => count > 1).reduce((sum, count) => sum + count - 1, 0);
}

function renderedTitleAudit(list) {
    const activeNonmanual = (list || []).filter(item => !item.deletedAt && !isManual(item));
    const rendered = activeNonmanual.map(item => ({
        item,
        title:String(V.getAnimeTitlePresentation(item).title || "").trim()
    }));
    const isSimplified = value => {
        const text = String(value || "");
        return /\p{Script=Han}/u.test(text)
            && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
            && V.toTraditionalChinese(text) !== text;
    };
    const mainSeriesPart = value => String(value || "").split(/[【（(]/u, 1)[0].trim();
    const isJapaneseMainFallback = value => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(mainSeriesPart(value));
    const isEnglishMainFallback = value => {
        const main = mainSeriesPart(value);
        return !/\p{Script=Han}/u.test(main) && /[A-Za-z]/u.test(main);
    };

    const categoryGroups = new Map();
    for (const item of (list || []).filter(item => !item.deletedAt)) {
        const key = `${String(item.category || "")}:${V.getAnimeSeriesKey(item)}`;
        if (!categoryGroups.has(key)) categoryGroups.set(key, []);
        categoryGroups.get(key).push(item);
    }
    const headers = [...categoryGroups.values()]
        .filter(members => members.length > 1)
        .map(members => String(members[0].groupTitle || members[0].seriesGroupTitle || members[0].title || "").trim());

    return {
        activeNonmanualRenderTitles:rendered.length,
        simplifiedRenderTitles:rendered.filter(entry => isSimplified(entry.title)).length,
        japaneseMainFallbacks:rendered.filter(entry => isJapaneseMainFallback(entry.title)).length,
        englishMainFallbacks:rendered.filter(entry => isEnglishMainFallback(entry.title)).length,
        groupHeaders:headers.length,
        simplifiedGroupHeaders:headers.filter(isSimplified).length,
        japaneseMainGroupHeaders:headers.filter(isJapaneseMainFallback).length,
        englishMainGroupHeaders:headers.filter(isEnglishMainFallback).length,
        simplifiedRenderSamples:rendered.filter(entry => isSimplified(entry.title)).slice(0, 10).map(entry => ({ id:entry.item.id, title:entry.title })),
        simplifiedHeaderSamples:headers.filter(isSimplified).slice(0, 10)
    };
}

const normalized = V.normalizeImportedBackup(originalBackup);
const beforeList = normalized.anime_list_v8_8;
const beforeWorks = normalized.works;
const state = {
    works:beforeWorks,
    watchHistory:normalized.watchHistory,
    mangaReadHistory:normalized.manga_read_history_v1,
    eventOverrides:normalized.eventOverrides,
    eventAnimeOverrides:normalized.eventAnimeOverrides
};
const recovered = V.recoverLegacyAnimeIdentities(beforeList, state, "2026-08-12T00:00:00.000Z");
const reconciled = V.reconcileExistingAnimeDuplicates(recovered.list, state, "2026-08-12T00:00:00.000Z");
const migrated = pageApi.migrateExistingAnimeRecords(reconciled.list, new Date("2026-08-12T00:00:00.000Z"));
const migratedWorks = V.migrateWorks(migrated.list, reconciled.state.works || beforeWorks, "2026-08-12T00:00:00.000Z");
const second = pageApi.migrateExistingAnimeRecords(JSON.parse(JSON.stringify(migrated.list)), new Date("2026-08-12T00:00:00.000Z"));

const beforeByLocalId = new Map(beforeList.map(item => [String(item.id), item]));
const preservedFields = ["id", "watched", "currentEpisode", "rating", "review", "notes", "note", "platform", "customPlatform", "category", "createdAt", "addedAt", "deletedAt"];
let userFieldChanges = 0;
for (const item of migrated.list) {
    const before = beforeByLocalId.get(String(item.id));
    if (!before) continue;
    for (const field of preservedFields) {
        if (JSON.stringify(before[field] ?? null) !== JSON.stringify(item[field] ?? null)) userFieldChanges++;
    }
}

const seriesHeaders = new Map();
for (const item of migrated.list) {
    const key = V.getAnimeSeriesKey(item);
    if (!seriesHeaders.has(key)) seriesHeaders.set(key, new Set());
    seriesHeaders.get(key).add(V.normalizeText(V.toTraditionalChinese(item.groupTitle || item.title)));
}
const splitSeriesKeys = [...seriesHeaders.entries()].filter(([, titles]) => titles.size > 1).map(([key]) => key);
const active = migrated.list.filter(item => !item.deletedAt);
const tombstones = migrated.list.filter(item => item.deletedAt);
const danglingHistory = (normalized.watchHistory || []).filter(record => !migrated.list.some(item => String(item.id) === String(record.animeId))).length;
const beforeTitleAudit = titleAudit(beforeList, ["title", "displayTitle", "canonicalTitle", "groupTitle"]);
const afterTitleAudit = titleAudit(migrated.list, ["title", "displayTitle", "canonicalTitle", "groupTitle"]);
const beforeWorkAudit = titleAudit(beforeWorks, ["title"]);
const afterWorkAudit = titleAudit(migratedWorks, ["title"]);
const beforeAliasAudit = titleAudit(beforeList, ["aliases"]);
const afterAliasAudit = titleAudit(migrated.list, ["aliases"]);
const beforeWorkAliasAudit = titleAudit(beforeWorks, ["aliases"]);
const afterWorkAliasAudit = titleAudit(migratedWorks, ["aliases"]);
const renderAudit = renderedTitleAudit(migrated.list);

const checks = [
    ["anime count", migrated.list.length === 136],
    ["active count", active.length === 128],
    ["tombstone count", tombstones.length === 8],
    ["watch history count", normalized.watchHistory.length === 67],
    ["identity recovered", migrated.list.every(item => V.getAnimeAniListIdentity(item))],
    ["external duplicates", explicitDuplicateCount(migrated.list) === 0],
    ["local ID collisions", localCollisionCount(migrated.list) === 0],
    ["dangling history", danglingHistory === 0],
    ["user fields preserved", userFieldChanges === 0],
    ["second migration", second.changed === false],
    ["series identity stable", second.list.every((item, index) => item.seriesKey === migrated.list[index].seriesKey)],
    ["series headers unified", splitSeriesKeys.length === 0],
    ["nonmanual simplified anime titles removed", afterTitleAudit.simplified === 0],
    ["works count preserved", migratedWorks.length === beforeWorks.length],
    ["nonmanual simplified work titles removed", afterWorkAudit.simplified === 0],
    ["backup text unchanged", fs.readFileSync(backupPath, "utf8") === originalText],
    ["tombstone identities preserved", tombstones.every(item => V.getAnimeAniListIdentity(item))],
    ["manual titles preserved", beforeList.filter(isManual).every(item => migrated.list.find(next => String(next.id) === String(item.id))?.title === item.title)]
];
checks.forEach(([name, ok]) => console.log(`${ok ? "PASS" : "FAIL"} ${name}`));

const report = {
    pass:checks.filter(([, ok]) => ok).length,
    total:checks.length,
    anime:{ before:beforeList.length, after:migrated.list.length, active:active.length, tombstones:tombstones.length },
    watchHistory:normalized.watchHistory.length,
    identityRecovered:`${migrated.list.filter(item => V.getAnimeAniListIdentity(item)).length}/${migrated.list.length}`,
    externalDuplicates:explicitDuplicateCount(migrated.list),
    localIdCollisions:localCollisionCount(migrated.list),
    danglingHistory,
    userFieldChanges,
    migration:migrated.report,
    secondMigrationChanged:second.changed,
    secondMigration:second.report,
    splitSeriesKeys,
    titleFallbacks:{ before:beforeTitleAudit, after:afterTitleAudit, worksBefore:beforeWorkAudit, worksAfter:afterWorkAudit },
    searchableAliases:{ before:beforeAliasAudit, after:afterAliasAudit, worksBefore:beforeWorkAliasAudit, worksAfter:afterWorkAliasAudit },
    renderAudit
};
console.log(JSON.stringify(report, null, 2));
if (report.pass !== report.total) process.exitCode = 1;
