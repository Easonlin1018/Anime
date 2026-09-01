"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V = require("../v11-core.js");

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}\n  ${error.stack}`);
        process.exitCode = 1;
    }
}

const at = "2026-08-31T10:00:00.000Z";
const later = "2026-08-31T11:00:00.000Z";
const fakeStorage = () => {
    const data = new Map();
    return { setItem:(key, value) => data.set(key, String(value)), getItem:key => data.get(key) ?? null };
};
function anime(id, anilistId, title, overrides = {}) {
    return V.migrateAnime({
        id, anilistId, title, displayTitle:title, canonicalTitle:title,
        groupTitle:"通用系列", seriesKey:"anilist:series-generic",
        category:"completed", categorySource:"manual", categoryManuallyEdited:true,
        watched:12, currentEpisode:12, episodes:12, totalEpisodes:12,
        rating:9, notes:"保留", themeSongs:{openings:[], endings:[]},
        createdAt:"2026-01-01T00:00:00.000Z", updatedAt:"2026-08-30T00:00:00.000Z",
        ...overrides
    }, at);
}

test("1. 相同 seriesKey 的第二個 Media 可依 AniList identity 單獨刪除", () => {
    const s1 = anime("local-s1", 1001, "第一季");
    const s2 = anime("local-s2", 1002, "第二季");
    const result = V.markAnimeDeletedById([s1, s2], "stale-local-reference", at, "1002");
    assert.equal(result.changed, true);
    assert.equal(result.anime.anilistId, 1002);
    assert.equal(result.list[0].deletedAt, null);
    assert.equal(result.list[0].category, "completed");
    assert.equal(result.list[0].watched, 12);
    assert.equal(result.list[1].category, "_deleted");
});

test("2. delete → serialize → migrate 後 tombstone 不復活", () => {
    const s1 = anime("local-s1", 1001, "第一季");
    const s2 = anime("local-s2", 1002, "第二季");
    const deleted = V.markAnimeDeletedById([s1, s2], s2.id, at, "1002").list;
    const reloaded = V.migrateList(JSON.parse(JSON.stringify(deleted)), later);
    assert.equal(reloaded.filter(item => !item.deletedAt).length, 1);
    assert.equal(reloaded.find(item => item.anilistId === 1002).category, "_deleted");
});

test("3. 新 tombstone 與舊 active duplicate 合併時 tombstone 優先", () => {
    const staleActive = anime("stale-active", 1002, "第二季", { updatedAt:"2026-08-30T00:00:00.000Z" });
    const deleted = V.markAnimeDeletedById([anime("canonical", 1002, "第二季")], "canonical", at, "1002").list[0];
    const reconciled = V.reconcileExistingAnimeDuplicates([staleActive, deleted]);
    assert.equal(reconciled.list.length, 1);
    assert.ok(reconciled.list[0].deletedAt);
    assert.equal(reconciled.list[0].category, "_deleted");
});

test("4. 明確重新加入後較新的 active 狀態不被舊 tombstone 壓回", () => {
    const oldDeleted = V.markAnimeDeletedById([anime("canonical", 1002, "第二季")], "canonical", at, "1002").list[0];
    const restored = { ...oldDeleted, deletedAt:null, category:"completed", updatedAt:later };
    const reconciled = V.reconcileExistingAnimeDuplicates([oldDeleted, restored]);
    assert.equal(reconciled.list.length, 1);
    assert.equal(reconciled.list[0].deletedAt, null);
    assert.equal(reconciled.list[0].anilistId, 1002);
});

test("5. 明確 restore 只恢復 exact AniList tombstone", () => {
    const before = [anime("local-s1", 1001, "第一季"), anime("local-s2", 1002, "第二季")];
    const deleted = V.markAnimeDeletedById(before, "local-s2", at, "1002").list;
    const restored = V.restoreAnimeById(deleted, "stale-local-reference", before, later, "1002").list;
    assert.equal(restored.find(item => item.anilistId === 1001).deletedAt, null);
    assert.equal(restored.find(item => item.anilistId === 1002).deletedAt, null);
    assert.equal(restored.find(item => item.anilistId === 1002).id, "local-s2");
});

test("6. completed → review 建立 manual category 與新複習 session", () => {
    const original = anime("local-s1", 1001, "第一季");
    const result = V.moveAnimeCategoryById([original], original.id, "review", at);
    assert.equal(result.anime.category, "review");
    assert.equal(result.anime.categorySource, "manual");
    assert.equal(result.anime.categoryManuallyEdited, true);
    assert.equal(result.anime.reviewWatched, 0);
    assert.equal(result.anime.reviewSessionActive, true);
});

test("7. 已在 review 但缺 manual 標記時仍補上人工優先權", () => {
    const legacy = anime("local-s1", 1001, "第一季", { category:"review", categorySource:"automatic", categoryManuallyEdited:false });
    const moved = V.moveAnimeCategoryById([legacy], legacy.id, "review", at).anime;
    assert.equal(moved.category, "review");
    assert.equal(moved.categorySource, "manual");
    assert.equal(moved.categoryManuallyEdited, true);
});

test("8. 複習進度 0 → 1 → 2，不改首次觀看進度", () => {
    const storage = fakeStorage();
    const review = V.moveAnimeCategoryById([anime("local-s1", 1001, "第一季")], "local-s1", "review", at).list;
    const first = V.commitAnimeReviewProgress(storage, review, [], "local-s1", 1, at);
    const second = V.commitAnimeReviewProgress(storage, first.list, first.history, "local-s1", 1, later);
    assert.equal(second.anime.reviewWatched, 2);
    assert.equal(second.anime.watched, 12);
    assert.equal(second.anime.currentEpisode, 12);
    assert.equal(second.history.length, 2);
    assert.ok(second.history.every(record => record.type === "review" && record.review === true));
});

test("9. 複習進度受總集數上限保護但不自動改分類", () => {
    const review = anime("local-s1", 1001, "第一季", { category:"review", reviewWatched:11, reviewSessionActive:true });
    const result = V.updateAnimeReviewProgress([review], review.id, 5, at);
    assert.equal(result.anime.reviewWatched, 12);
    assert.equal(result.anime.category, "review");
    assert.equal(result.anime.watched, 12);
});

test("10. 複習完成只結束 session，首次觀看資料保持", () => {
    const review = anime("local-s1", 1001, "第一季", { category:"review", reviewWatched:12, reviewSessionActive:true });
    const completed = V.moveAnimeCategoryById([review], review.id, "completed", later).anime;
    assert.equal(completed.reviewSessionActive, false);
    assert.equal(completed.reviewWatched, 12);
    assert.equal(completed.watched, 12);
    assert.equal(completed.categorySource, "manual");
});

test("11. 舊資料 reviewWatched migration 可重複執行", () => {
    const first = V.migrateAnime({ id:"legacy", title:"舊作品", category:"review", watched:12, episodes:12 }, at);
    const second = V.migrateAnime(JSON.parse(JSON.stringify(first)), at);
    assert.equal(first.reviewWatched, 0);
    assert.equal(second.reviewWatched, 0);
    assert.deepEqual(second, first);
});

test("12. UI 將 review 進度與一般觀看進度分流並傳遞 external identity", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    const ui = fs.readFileSync(path.resolve(__dirname, "..", "v11-ui.js"), "utf8");
    assert.match(html, /已複習 \$\{Number\(anime\.reviewWatched\)/u);
    assert.match(html, /deleteAnime\(\$\{animeId\},\$\{animeExternalIdentity\}\)/u);
    assert.match(ui, /V\.commitAnimeReviewProgress/u);
    assert.match(ui, /V\.findAnimeRecordIndex\(animeList, id, externalIdentity\)/u);
});

test("13. duplicate reconciliation 保留人工 review 分類優先權", () => {
    const manualReview = anime("manual-review", 8101, "系列", {
        category:"review",
        categorySource:"manual",
        categoryManuallyEdited:true,
        reviewWatched:2,
        updatedAt:"2026-08-01T00:00:00.000Z"
    });
    const newerAutomatic = anime("automatic-copy", 8101, "系列", {
        category:"watching",
        categorySource:"automatic",
        categoryManuallyEdited:false,
        updatedAt:"2026-08-02T00:00:00.000Z"
    });
    const result = V.reconcileExistingAnimeDuplicates([newerAutomatic, manualReview]);
    assert.equal(result.list.length, 1);
    assert.equal(result.list[0].category, "review");
    assert.equal(result.list[0].categorySource, "manual");
    assert.equal(result.list[0].categoryManuallyEdited, true);
    assert.equal(result.list[0].reviewWatched, 2);
});

test("14. completed 第一次進 review 建立新 session 且首次觀看進度不變", () => {
    const original = anime("local-session", 8201, "通用作品", {
        watched:24,
        currentEpisode:24,
        episodes:24,
        totalEpisodes:24,
        reviewWatched:9,
        reviewSessionActive:false,
        reviewStartedAt:"2026-01-01T00:00:00.000Z",
        reviewCompletedAt:"2026-01-02T00:00:00.000Z"
    });
    const review = V.moveAnimeCategoryById([original], original.id, "review", at).anime;
    assert.equal(review.category, "review");
    assert.equal(review.reviewSessionActive, true);
    assert.equal(review.reviewWatched, 0);
    assert.equal(review.reviewStartedAt, at);
    assert.equal(review.reviewCompletedAt, null);
    assert.equal(review.watched, 24);
    assert.equal(review.currentEpisode, 24);
});

test("15. 未完成 session 的 2/24 經 reload、migration 與 metadata reconciliation 後保持", () => {
    const storage = fakeStorage();
    const original = anime("local-session", 8202, "通用作品", {
        watched:24,
        currentEpisode:24,
        episodes:24,
        totalEpisodes:24
    });
    const reviewList = V.moveAnimeCategoryById([original], original.id, "review", at).list;
    const first = V.commitAnimeReviewProgress(storage, reviewList, [], original.id, 1, at);
    const second = V.commitAnimeReviewProgress(storage, first.list, first.history, original.id, 1, later);
    const reloaded = V.migrateList(JSON.parse(JSON.stringify(second.list)), "2026-08-31T12:00:00.000Z");
    const metadataCopy = V.migrateAnime({
        ...reloaded[0],
        id:"metadata-copy",
        category:"watching",
        categorySource:"automatic",
        categoryManuallyEdited:false,
        status:"FINISHED",
        format:"TV",
        updatedAt:"2026-08-31T12:30:00.000Z"
    }, "2026-08-31T12:30:00.000Z");
    const reconciled = V.reconcileExistingAnimeDuplicates([metadataCopy, reloaded[0]]).list[0];
    const reentered = V.moveAnimeCategoryById([reconciled], reconciled.id, "review", "2026-08-31T13:00:00.000Z").anime;
    assert.equal(reentered.category, "review");
    assert.equal(reentered.reviewSessionActive, true);
    assert.equal(reentered.reviewWatched, 2);
    assert.equal(reentered.reviewStartedAt, at);
    assert.equal(reentered.watched, 24);
    assert.equal(reentered.currentEpisode, 24);
});

test("16. 複習完結束 session、記錄完成時間且不改首次觀看進度", () => {
    const review = anime("local-session", 8203, "通用作品", {
        category:"review",
        watched:24,
        currentEpisode:24,
        episodes:24,
        totalEpisodes:24,
        reviewWatched:2,
        reviewSessionActive:true,
        reviewStartedAt:at,
        reviewCompletedAt:null
    });
    const completed = V.moveAnimeCategoryById([review], review.id, "completed", later).anime;
    assert.equal(completed.category, "completed");
    assert.equal(completed.reviewSessionActive, false);
    assert.equal(completed.reviewCompletedAt, later);
    assert.equal(completed.reviewWatched, 2);
    assert.equal(completed.watched, 24);
    assert.equal(completed.currentEpisode, 24);
});

test("17. 已完成 session 再次進 review 會建立全新的零進度 session", () => {
    const completed = anime("local-session", 8204, "通用作品", {
        watched:24,
        currentEpisode:24,
        episodes:24,
        totalEpisodes:24,
        reviewWatched:2,
        reviewSessionActive:false,
        reviewStartedAt:at,
        reviewCompletedAt:later
    });
    const newStartedAt = "2026-09-01T08:00:00.000Z";
    const review = V.moveAnimeCategoryById([completed], completed.id, "review", newStartedAt).anime;
    assert.equal(review.reviewWatched, 0);
    assert.equal(review.reviewSessionActive, true);
    assert.equal(review.reviewStartedAt, newStartedAt);
    assert.equal(review.reviewCompletedAt, null);
    assert.equal(review.watched, 24);
    assert.equal(review.currentEpisode, 24);
});

test("18. 複習完不走一般觀看 progress，也不觸發續作探索", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
    assert.equal(V.shouldDiscoverSequelAfterCategoryMove("review", "completed"), false);
    assert.equal(V.shouldDiscoverSequelAfterCategoryMove("watching", "completed"), true);
    assert.equal(V.shouldDiscoverSequelAfterCategoryMove("completed", "completed"), false);
    assert.match(html, /🎉 複習完<\/button>/u);
    assert.match(html, /moveCategory\(\$\{animeId\},"completed"\)/u);
    assert.match(html, /shouldDiscoverSequelAfterCategoryMove\(previousCategory, category\)/u);
});

if (!process.exitCode) console.log(`\nMedia delete/review workflow tests passed: ${passed}/18`);
