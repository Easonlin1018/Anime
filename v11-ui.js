(function () {
    "use strict";
    const V = window.AnimeTrackerV11;
    if (!V) return;
    const themeSongsApi = () => window.ThemeSongs || window.SpotifyThemes;
    const parse = (key, fallback) => { try { return JSON.parse((window.getAnimeStartupStoredItem ? window.getAnimeStartupStoredItem(key) : localStorage.getItem(key)) || "") ?? fallback; } catch { return fallback; } };
    const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    const FILTER_KEY = "anime_tracker_filters_v11";
    const UNDO_KEY = "anime_tracker_last_undo_v11";
    const PREFS_KEY = "anime_tracker_preferences_v11";
    const state = { filters: parse(FILTER_KEY, {}), selected: new Set(), batchMode: false, calendarDate: new Date(), calendarView: "month", calendarTypes: new Set(["episode", "movie", "season", "event-start", "event-end"]), installPrompt: null, lastImportRestore: null };
    let watchHistory = parse(V.HISTORY_KEY, []);
    let autoSyncTimer = null;

    function touch(item) { item.updatedAt = new Date().toISOString(); return item; }
    function persistAnime() {
        window.assertAnimeStartupWritable?.();
        animeList = V.migrateList(animeList);
        const presentationMigration = window.migrateExistingAnimeRecords?.(animeList);
        if (Array.isArray(presentationMigration?.list)) animeList = presentationMigration.list;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
        localStorage.setItem("anime_tracker_schema_version", "11");
    }
    function currentSettings() { return { eventSettings, filters: state.filters, animeListSort, notificationPermissionAsked: localStorage.getItem("anime_notification_prompted_v11") === "1" }; }
    function snapshot({ persistedOnly = false, forExport = false } = {}) {
        if (persistedOnly) {
            const stored = (key, fallback) => {
                const raw = forExport && window.getAnimeStartupStoredItem ? window.getAnimeStartupStoredItem(key) : localStorage.getItem(key);
                if (raw === null) {
                    if (key === STORAGE_KEY) {
                        if (forExport) return JSON.parse(JSON.stringify(window.__ANIME_STARTUP_STORAGE__?.originalList || []));
                        throw Error("找不到已儲存的作品清單，未執行上傳。");
                    }
                    return fallback;
                }
                const value = JSON.parse(raw);
                const invalid = Array.isArray(fallback)
                    ? !Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))
                    : !value || typeof value !== "object" || Array.isArray(value);
                if (invalid) throw Error("本機資料無法安全讀取，未執行上傳。");
                return value;
            };
            return {
                animeList:stored(STORAGE_KEY, []), works:stored(V.WORKS_KEY, []),
                mangaReadHistory:stored(V.MANGA_HISTORY_KEY, []),
                eventOverrides:stored(EVENT_OVERRIDES_KEY, {}), eventAnimeOverrides:stored(EVENT_ANIME_OVERRIDES_KEY, {}),
                settings:currentSettings(), watchHistory:stored(V.HISTORY_KEY, []), reminders:{}, preferences:stored(PREFS_KEY, {})
            };
        }
        const media=window.CrossMediaTracker?.snapshot?.()||{works:parse(V.WORKS_KEY,[]),mangaReadHistory:parse(V.MANGA_HISTORY_KEY,[])}; return { animeList: window.__ANIME_STARTUP_STORAGE__?.persisted === false ? JSON.parse(JSON.stringify(window.__ANIME_STARTUP_STORAGE__.originalList || animeList)) : V.migrateList(animeList), works:media.works, mangaReadHistory:media.mangaReadHistory, eventOverrides: { ...eventOverrides }, eventAnimeOverrides:{ ...eventAnimeOverrides }, settings: currentSettings(), watchHistory: [...watchHistory], reminders: {}, preferences: parse(PREFS_KEY, {}) };
    }
    function createRestorePoint(reason) {
        const points = parse(V.RESTORE_KEY, []);
        points.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason, animeCount: animeList.length, data: V.createBackup(snapshot()) });
        save(V.RESTORE_KEY, points.slice(0, 5));
        renderRestorePoints();
    }
    function auxiliaryUndoSnapshot() {
        const media = window.CrossMediaTracker?.snapshot?.() || { works:parse(V.WORKS_KEY, []), mangaReadHistory:parse(V.MANGA_HISTORY_KEY, []) };
        return {
            eventOverrides:{ ...eventOverrides },
            eventAnimeOverrides:{ ...eventAnimeOverrides },
            watchHistory:[...watchHistory],
            works:media.works,
            mangaReadHistory:media.mangaReadHistory,
            themeCache:parse("anime_theme_lookup_cache_v1", {}),
            themeUndo:parse("anime_theme_last_undo_v1", null)
        };
    }
    function restoreAuxiliaryUndo(undo) {
        if (!undo?.auxiliary) return;
        eventOverrides = undo.auxiliary.eventOverrides || {};
        eventAnimeOverrides = undo.auxiliary.eventAnimeOverrides || {};
        watchHistory = undo.auxiliary.watchHistory || [];
        save(EVENT_OVERRIDES_KEY, eventOverrides);
        save(EVENT_ANIME_OVERRIDES_KEY, eventAnimeOverrides);
        save(V.HISTORY_KEY, watchHistory);
        if (Array.isArray(undo.auxiliary.works)) save(V.WORKS_KEY, undo.auxiliary.works);
        if (Array.isArray(undo.auxiliary.mangaReadHistory)) save(V.MANGA_HISTORY_KEY, undo.auxiliary.mangaReadHistory);
        save("anime_theme_lookup_cache_v1", undo.auxiliary.themeCache || {});
        if (undo.auxiliary.themeUndo) save("anime_theme_last_undo_v1", undo.auxiliary.themeUndo);
        else localStorage.removeItem("anime_theme_last_undo_v1");
    }

    function currentDeleteAuxiliaryState() {
        return {
            eventOverrides,
            eventAnimeOverrides,
            watchHistory,
            themeCache:parse("anime_theme_lookup_cache_v1", {}),
            themeUndo:parse("anime_theme_last_undo_v1", null)
        };
    }

    function traceDeleteStep(step) {
        try { window.__ANIME_DELETE_TRACE__?.(step); } catch {}
    }

    function applyCompactAuxiliaryRestore(restoredState, undo) {
        eventOverrides = restoredState.eventOverrides || {};
        eventAnimeOverrides = restoredState.eventAnimeOverrides || {};
        watchHistory = restoredState.watchHistory || [];
        if (undo.external?.crossMedia) window.CrossMediaTracker?.restoreAnimeDeletionSnapshot?.(undo.external.crossMedia);
        save(EVENT_OVERRIDES_KEY, eventOverrides);
        save(EVENT_ANIME_OVERRIDES_KEY, eventAnimeOverrides);
        save(V.HISTORY_KEY, watchHistory);
        if (themeSongsApi()?.restoreAnimeCleanupSnapshot && undo.external?.spotify) {
            themeSongsApi().restoreAnimeCleanupSnapshot(undo.external.spotify);
        } else {
            save("anime_theme_lookup_cache_v1", restoredState.themeCache || {});
            if (restoredState.themeUndo) save("anime_theme_last_undo_v1", restoredState.themeUndo);
            else localStorage.removeItem("anime_theme_last_undo_v1");
        }
    }

    function rollbackCompactDelete(originalList, undo) {
        animeList = originalList;
        const restoredState = V.restoreAnimeAuxiliaryState(currentDeleteAuxiliaryState(), undo.auxiliary, undo.targetId);
        eventOverrides = restoredState.eventOverrides || {};
        eventAnimeOverrides = restoredState.eventAnimeOverrides || {};
        watchHistory = restoredState.watchHistory || [];
        const attempts = [
            { stage:"event-overrides", action:() => save(EVENT_OVERRIDES_KEY, eventOverrides) },
            { stage:"event-anime-overrides", action:() => save(EVENT_ANIME_OVERRIDES_KEY, eventAnimeOverrides) },
            { stage:"history", action:() => save(V.HISTORY_KEY, watchHistory) },
            { stage:"spotify", action:() => themeSongsApi()?.restoreAnimeCleanupSnapshot?.(undo.external?.spotify) },
            { stage:"cross-media", action:() => window.CrossMediaTracker?.restoreAnimeDeletionSnapshot?.(undo.external?.crossMedia) },
            { stage:"storage", action:() => localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList)) },
            { stage:"render", action:() => { renderList(); renderEvents(); refreshV11(); } }
        ];
        const errors = [];
        attempts.forEach(({ stage, action }) => {
            try { action(); }
            catch (error) { errors.push({ stage, error }); }
        });
        if (errors.length) {
            const rollbackError = errors[0].error;
            rollbackError.rollbackStage = errors[0].stage;
            rollbackError.rollbackErrors = errors;
            throw rollbackError;
        }
    }

    function bootstrapAnimeStorage() {
        if (window.__ANIME_STARTUP_STORAGE__?.persisted === false) return;
        // The main startup migration has already persisted its data. Supply only
        // missing display defaults here, preserving every original tracking field.
        animeList = animeList.map(item => ({ ...V.migrateAnime(item), ...item }));
        try {
            if (localStorage.getItem("anime_tracker_schema_version") !== "11") localStorage.setItem("anime_tracker_schema_version", "11");
        } catch (error) { window.warnAnimeStartupStorage?.("v11-schema", error); }
    }
    bootstrapAnimeStorage();

    const originalSaveAndRender = saveAndRender;
    function requestAnimeAutoSync({ persistedOnly = false } = {}) {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = null;
        if (window.__ANIME_STARTUP_STORAGE__?.recoveryPending || localStorage.getItem("anime_tracker_auto_sync_v11") !== "1") return;
        autoSyncTimer = setTimeout(() => {
            autoSyncTimer = null;
            if (window.__ANIME_STARTUP_STORAGE__?.recoveryPending || localStorage.getItem("anime_tracker_auto_sync_v11") !== "1") return;
            void handleSync("upload", { persistedOnly });
        }, 1500);
    }
    window.requestAnimeAutoSync = requestAnimeAutoSync;
    if (window.__ANIME_STARTUP_STORAGE__?.persisted === true
        && Number(window.__ANIME_EXISTING_MEDIA_MIGRATION__?.categoryChanged) > 0) {
        requestAnimeAutoSync({ persistedOnly:true });
    }

    saveAndRender = function (options = {}) {
        if (!options.metadataOnly) {
            animeList = animeList.map(item => touch(V.migrateAnime(item)));
            persistAnime();
        }
        originalSaveAndRender(options);
        refreshV11();
        requestAnimeAutoSync({ persistedOnly:Boolean(options.metadataOnly) });
    };
    const originalMoveCategory = moveCategory;
    moveCategory = function (id, category) { const item = animeList.find(x => String(x.id) === String(id)); if (item) touch(item); originalMoveCategory(id, category); };
    updateProgress = function (id, delta) {
        let result, storedList, isReview, wasCompleted;
        const startup = window.__ANIME_STARTUP_STORAGE__;
        const startupDeferred = startup?.persisted === false;
        const uniqueActiveIndex = list => {
            const matches = list.map((item, index) => ({ item, index })).filter(({ item }) => item
                && String(item.id) === String(id) && !item.deletedAt && item.category !== "_deleted");
            return matches.length === 1 ? matches[0].index : -1;
        };
        const memoryIndex = uniqueActiveIndex(animeList);
        if (memoryIndex < 0) { showToast("找不到要更新的動畫，請重新整理後再試"); return false; }
        try {
            window.assertAnimeStartupWritable?.();
            storedList = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            const storedHistory = JSON.parse(localStorage.getItem(V.HISTORY_KEY) || "[]");
            if (!Array.isArray(storedList) || storedList.some(item => !item || typeof item !== "object" || Array.isArray(item))
                || !Array.isArray(storedHistory) || storedHistory.some(record => !record || typeof record !== "object" || Array.isArray(record))) throw Error("本機資料無法安全讀取");
            const storedIndex = uniqueActiveIndex(storedList);
            if (storedIndex < 0) throw Error("作品的狀態已變更");
            const stored = storedList[storedIndex], memory = animeList[memoryIndex];
            if (V.getAnimeAniListIdentity(stored) !== V.getAnimeAniListIdentity(memory)
                || stored.category !== memory.category
                || (!V.getAnimeAniListIdentity(stored) && stored.title !== memory.title)) throw Error("作品的狀態已變更");
            isReview = stored.category === "review";
            wasCompleted = stored.category === "completed";
            const persistChanges = (writes, originalList) => {
                if (typeof commitAnimeStartupChanges !== "function") throw Error("安全儲存尚未就緒");
                try { commitAnimeStartupChanges(writes, originalList); }
                finally { if (startupDeferred && startup) startup.persisted = false; }
            };
            const commit = isReview ? V.commitAnimeReviewProgress : V.commitAnimeProgress;
            result = commit(localStorage, storedList, storedHistory, id, delta, new Date().toISOString(), persistChanges);
        } catch (error) {
            if (startup?.recoveryPending) {
                startup.persisted = false;
                if (storedList) startup.originalList = JSON.parse(JSON.stringify(storedList));
                if (typeof installAnimeStartupRecoveryGuard === "function") installAnimeStartupRecoveryGuard();
                window.warnAnimeStartupStorage?.("watch-progress-recovery", error);
            } else console.warn("觀看進度尚未儲存", error);
            showToast("觀看進度尚未變更：本機資料暫時無法安全儲存。原始資料與觀看歷史仍保留。", 7000);
            return false;
        }
        if (!result.found) { showToast("找不到要更新的動畫，請重新整理後再試"); return false; }
        if (!result.changed) { showToast(result.reason === "at-total" ? "已達總集數，觀看進度不再增加" : "觀看進度沒有變更"); return false; }
        const next = animeList.slice();
        next[memoryIndex] = { ...next[memoryIndex], ...result.anime };
        animeList = next;
        watchHistory = result.history;
        if (startupDeferred && startup) startup.originalList = JSON.parse(JSON.stringify(result.list));
        renderList();
        refreshV11();
        requestAnimeAutoSync({ persistedOnly:true });
        if (!isReview && !wasCompleted && result.anime.category === "completed") void checkAndAddSequel(result.anime, false);
        return true;
    };
    deleteAnime = function (id, externalIdentity = null) {
        traceDeleteStep("STEP 1 findAnimeRecordIndex");
        const recordIndex = V.findAnimeRecordIndex(animeList, id, externalIdentity);
        const item = recordIndex >= 0 ? animeList[recordIndex] : null;
        if (!item || item.deletedAt) return;
        if (!confirm(`確定刪除「${item.title}」？可使用「復原上一步」恢復。`)) return;
        traceDeleteStep("STEP 2 confirm accepted");
        const targetIdentity = String(externalIdentity || V.getAnimeAniListIdentity(item));
        const now = new Date().toISOString(), originalList = animeList;
        let undo;
        try {
            const external = {
                spotify:themeSongsApi()?.snapshotAnimeCleanup?.(item) || null,
                crossMedia:window.CrossMediaTracker?.snapshotAnimeDeletion?.(item.id) || null
            };
            undo = V.createCompactDeleteUndo(item, targetIdentity, currentDeleteAuxiliaryState(), external, now);
            traceDeleteStep("STEP 3 auxiliaryUndoSnapshot built");
        } catch (error) {
            showToast("無法建立刪除復原點，因此未刪除。");
            return;
        }
        const result = V.runAnimeDeleteTransaction({
            list:animeList,
            id,
            identity:targetIdentity,
            now,
            undo,
            undoKey:UNDO_KEY,
            storage:localStorage,
            trace:step => { if (step !== "STEP 1 findAnimeRecordIndex") traceDeleteStep(step); },
            cleanup:(deleted, compactUndo, nextList) => {
                animeList = nextList;
                const cleaned = cleanupAnimeAuxiliaryReferences(deleted, deleted.deletedAt, watchHistory);
                watchHistory = cleaned.watchHistory;
                return cleaned;
            },
            persist:() => saveAndRender(),
            rollback:() => rollbackCompactDelete(originalList, undo)
        });
        if (!result.ok) {
            if (result.stage === "undo" && result.quotaExceeded) return showToast("儲存空間不足，無法建立刪除復原點，因此未刪除。");
            if (result.recoveryRequired) return showToast("刪除未完整完成，復原資料已保留。請不要繼續修改資料，先重新整理並復原上一步。");
            if (result.quotaExceeded) return showToast("儲存空間不足，刪除交易已取消，原資料已恢復。");
            if (result.stage === "lookup" || result.stage === "mark") return showToast("找不到可刪除的有效作品，請重新整理後再試");
            return showToast("刪除失敗，原資料已恢復。請重新整理後再試。");
        }
        animeList = result.list;
        traceDeleteStep("STEP 9 success toast");
        showToast("🗑️ 已刪除，可在批次工具列復原上一步");
    };

    const originalBuildAnimeItem = buildAnimeItem;
    buildAnimeItem = function (anime) {
        let html = originalBuildAnimeItem(anime);
        const mediaBadges=window.CrossMediaTracker?.mediaBadgesForAnime?.(anime)||'<span class="v11-badge" aria-label="動畫">🎬 動畫</span>';
        html=html.replace('<div class="anime-meta">',`<div class="cross-media-card-badges">${mediaBadges}</div><div class="anime-meta">`);
        const checked = state.selected.has(String(anime.id)) ? "checked" : "";
        return html.replace('<div class="anime-item">', `<div class="anime-item ${checked ? "v11-selected" : ""}" data-anime-id="${escapeHtml(anime.id)}"><input class="v11-batch-check" type="checkbox" aria-label="選取 ${escapeHtml(anime.title)}" data-select-anime="${escapeHtml(anime.id)}" ${state.batchMode ? "" : "hidden"} ${checked}>`);
    };
    const originalRenderList = renderList;
    renderList = function () {
        const full = animeList;
        const mainSource = full.filter(item => !V.isAnimeCurrentlyWatching(item));
        const mainVisible = V.searchFilterSort(mainSource, animeListQuery, state.filters, animeListSort, item => [...eventList, ...eventArchive].some(event => matchingAnime(event).some(match => String(match.id) === String(item.id))));
        const allowed = new Set(mainVisible.map(item => String(item.id)));
        animeList = full.map(item => allowed.has(String(item.id)) ? item : { ...item, category: "_v11_filtered" });
        try { originalRenderList(); }
        finally { animeList = full; }
        const mainCount = full.filter(item => !item.deletedAt && !V.isAnimeCurrentlyWatching(item)).length;
        const summary = document.getElementById("anime-list-summary"); if (summary) summary.textContent = `顯示 ${mainVisible.length}／${mainCount} 部`;
        renderFilterChips();
        window.CrossMediaTracker?.renderSearchResults?.(animeListQuery);
        renderCurrentlyWatching();
    };

    function animeCategoryLabel(category) {
        return ({ watching:"正在連載", backlog:"補番中", waiting:"敲碗中", review:"複習中", completed:"已追完" })[category] || "其他分類";
    }

    function animeCategoryOptions(selected) {
        const categories = ["watching", "backlog", "waiting", "review", "completed"];
        if (selected && !categories.includes(selected)) categories.push(selected);
        return categories.map(category => `<option value="${escapeHtml(category)}"${selected === category ? " selected" : ""}>${escapeHtml(animeCategoryLabel(category))}</option>`).join("");
    }

    function currentlyWatchingPage() {
        return '<section class="section v11-page v11-currently-page" data-v11-page-group="currently-watching" hidden><div class="section-title">▶️ 正在看</div><p class="tiny-note">依實際正常觀看進度顯示；動畫的播出分類維持原狀，複習進度另行計算。</p><div id="v11-currently-summary" class="tiny-note" role="status"></div><div id="v11-currently-list"></div></section>';
    }

    function renderCurrentlyWatching() {
        const box = document.getElementById("v11-currently-list");
        if (!box) return;
        const list = animeList.filter(item => V.isAnimeCurrentlyWatching(item)).slice().sort((a, b) =>
            (Date.parse(b.lastWatchedAt) || 0) - (Date.parse(a.lastWatchedAt) || 0)
            || String(a.title || "").localeCompare(String(b.title || ""), "zh-Hant"));
        const summary = document.getElementById("v11-currently-summary");
        if (summary) summary.textContent = `${list.length} 部正在看`;
        box.innerHTML = list.map(item => {
            const id = escapeHtml(String(item.id));
            const progress = V.getNormalAnimeProgress(item);
            const total = progress.total === null ? "未知" : progress.total;
            const minus = `<button type="button" data-progress-action="decrement" data-anime-id="${id}" aria-label="${escapeHtml(item.title)} 減少 1 集">➖ 減少 1 集</button>`;
            let card = buildAnimeItem(item);
            if (card.includes('data-progress-action="increment"')) card = card.replace(/(<button\b[^>]*data-progress-action="increment")/u, match => minus + match);
            else card = card.replace('<div class="btn-group">', () => `<div class="btn-group">${minus}<button type="button" data-progress-action="increment" data-anime-id="${id}">➕ 看了 1 集</button>`);
            if (window.__ANIME_STARTUP_STORAGE__?.recoveryPending) card = card.replace(/(<button\b[^>]*data-progress-action="(?:increment|decrement)"[^>]*)(>)/gu, "$1 disabled$2");
            const poster = safeUrl(item.poster || item.coverImage || "");
            const cover = poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(item.title)} 封面" loading="lazy" decoding="async">` : '<span aria-label="尚無封面">🎬</span>';
            return `<article class="v11-currently-card"><button type="button" class="v11-currently-cover" data-open-detail="${id}" aria-label="開啟 ${escapeHtml(item.title)} 詳細資料">${cover}</button><div class="v11-currently-body"><div class="v11-currently-progress">觀看進度：${progress.current} / ${escapeHtml(total)} 集 <span class="v11-badge">${escapeHtml(animeCategoryLabel(item.category))}</span></div>${card}</div></article>`;
        }).join("") || '<div class="empty">目前沒有正在看的動畫。正常觀看進度開始後，未看完的作品會自動出現在這裡。</div>';
    }

    function addShell() {
        document.title = "全自動動漫追番基地 v11.0";
        document.querySelector("h1").textContent = "🎬 全自動動漫追番基地 v11.0";
        const container = document.querySelector(".container");
        const nav = document.createElement("nav"); nav.className = "v11-nav"; nav.setAttribute("aria-label", "主導覽");
        nav.innerHTML = [["anime","我的動漫"],["currently-watching","正在看"],["reminders","本週待看"],["planner","行事曆"],["events","活動"],["stats","統計"],["data","資料管理"],["sync","設定／同步"]].map(([id,label],i)=>`<button type="button" data-v11-page="${id}" class="${i===0?"active":""}">${label}</button>`).join("");
        container.insertBefore(nav, container.firstElementChild.nextSibling);
        [...container.children].forEach(element => { if (element.classList.contains("section")) { element.dataset.v11Original = "1"; element.classList.add("v11-page"); element.dataset.v11PageGroup = element.id === "events-section" ? "events" : "anime"; } });
        const pages = document.createElement("div");
        pages.innerHTML = currentlyWatchingPage() + reminderPage() + calendarPage() + statsPage() + dataPage() + syncPage();
        container.append(...pages.children);
        document.body.insertAdjacentHTML("beforeend", detailModal() + importModal() + '<div id="v11-offline" class="v11-offline" role="status">目前離線</div>');
        nav.addEventListener("click", event => { const button = event.target.closest("[data-v11-page]"); if (button) showPage(button.dataset.v11Page); });
        document.addEventListener("click", delegatedClick);
        document.addEventListener("change", delegatedChange);
        document.addEventListener("keydown", event => { if (event.key === "Escape") closeV11Modals(); });
        wireStaticControls();
        enableDebouncedSearch();
        showPage("anime");
    }

    function reminderPage() { return '<section class="section v11-page" data-v11-page-group="reminders" hidden><div class="section-title">🔔 本週待看／提醒中心</div><div class="v11-toolbar"><button id="v11-notifications">開啟瀏覽器通知</button></div><div class="tiny-note">背景提醒能力依瀏覽器與裝置而異；網站關閉後不保證能持續通知。</div><div id="v11-reminders"></div></section>'; }
    function calendarPage() { return '<section class="section v11-page" data-v11-page-group="planner" hidden><div class="section-title">📅 行事曆</div><div class="v11-calendar-head"><button data-cal-nav="-1">上一月</button><button data-cal-today>回到今天</button><button data-cal-nav="1">下一月</button><select id="v11-calendar-view"><option value="month">月視圖</option><option value="week">週視圖</option></select><select id="v11-calendar-filter" multiple aria-label="行事曆類型"><option value="episode" selected>📺 動漫下一集</option><option value="event-start" selected>🎪 活動開始</option><option value="event-end" selected>🏁 活動結束</option><option value="movie" selected>🎬 電影上映</option><option value="season" selected>🌱 新一季</option></select></div><h3 id="v11-calendar-title"></h3><div id="v11-calendar" class="v11-month"></div><div id="v11-day-items"></div></section>'; }
    function statsPage() { return '<section class="section v11-page v11-stats-page" data-v11-page-group="stats" hidden><div class="section-title">📊 觀看統計</div><div class="tiny-note">觀看統計自 v11.0 啟用後開始記錄</div><div class="v11-toolbar"><button type="button" data-stat-action="reset">重設觀看統計</button><button type="button" data-stat-action="restore">復原上一次統計重設</button></div><div id="v11-stats"></div></section>'; }
    function dataPage() { return '<section class="section v11-page" data-v11-page-group="data" hidden><div class="section-title">💾 資料管理</div><div class="v11-toolbar"><button id="v11-export">匯出完整 JSON 備份</button><button id="v11-import">匯入 JSON</button><input id="v11-import-file" type="file" accept="application/json,.json" hidden><button id="v11-undo-import">復原上一次匯入</button></div><div id="v11-restores"></div></section>'; }
    function syncPage() { return '<section class="section v11-page" data-v11-page-group="sync" hidden><div class="section-title">☁️ 設定／同步</div><div id="v11-sync-status" class="event-status">正在檢查同步設定…</div><div class="v11-toolbar"><input id="v11-sync-email" type="email" placeholder="Email"><button data-sync="login">寄送 Magic Link</button><button data-sync="logout">登出</button><button data-sync="upload">手動上傳</button><button data-sync="download">手動下載</button><label><input id="v11-auto-sync" type="checkbox"> 自動同步</label><button id="v11-install" hidden>安裝 App</button></div><div class="tiny-note">資料採 local-first。未設定 Supabase 時，所有本機功能仍可使用。</div></section>'; }
    function detailModal() { return '<div id="v11-detail-modal" class="v11-modal" hidden><div class="v11-modal-panel" role="dialog" aria-modal="true" aria-labelledby="v11-detail-title"><div class="v11-modal-head"><h2 id="v11-detail-title">動漫詳細資料</h2><button data-close-modal aria-label="關閉詳細資料">關閉</button></div><div id="v11-detail-body"></div></div></div>'; }
    function importModal() { return '<div id="v11-import-modal" class="v11-modal" hidden><div class="v11-modal-panel" role="dialog" aria-modal="true"><div class="v11-modal-head"><h2>匯入預覽</h2><button data-close-modal>關閉</button></div><div id="v11-import-preview"></div><div class="v11-toolbar"><button data-import-mode="merge">合併</button><button data-import-mode="replace" class="btn-del">完全覆蓋</button></div></div></div>'; }

    function showPage(page) {
        document.querySelectorAll("[data-v11-page-group]").forEach(element => element.hidden = element.dataset.v11PageGroup !== page);
        document.querySelectorAll("[data-v11-page]").forEach(button => button.classList.toggle("active", button.dataset.v11Page === page));
        if (page === "currently-watching") renderCurrentlyWatching(); if (page === "reminders") renderReminders(); if (page === "planner") renderCalendar(); if (page === "stats") renderStats(); if (page === "data") renderRestorePoints(); if (page === "sync") renderSyncStatus();
        scrollTo({ top: 0, behavior: "smooth" });
    }

    function insertAnimeTools() {
        const toolbar = document.querySelector(".anime-list-toolbar"); if (!toolbar) return;
        toolbar.insertAdjacentHTML("afterend", '<details class="v11-filter-panel"><summary>進階篩選</summary><div class="v11-filter-grid"><label>狀態<select data-filter="status"><option value="">全部</option><option value="watching">正在連載</option><option value="backlog">補番中</option><option value="waiting">等待</option><option value="completed">已完成</option></select></label><label>平台<input data-filter="platform" placeholder="平台"></label><label>標籤<input data-filter="tags" placeholder="標籤"></label><label>年份<input data-filter="year" type="number" min="1900" max="2200"></label><label>季度<select data-filter="season"><option value="">全部</option><option>WINTER</option><option>SPRING</option><option>SUMMER</option><option>FALL</option></select></label><label><input data-filter="unfinished" type="checkbox"> 尚未看完</label><label><input data-filter="stale" type="checkbox"> 30 天未觀看</label><label><input data-filter="hasEvents" type="checkbox"> 有活動</label><label><input data-filter="hasNextSeason" type="checkbox"> 有下一季</label><label><input data-filter="reminder" type="checkbox"> 有提醒</label><label><input data-filter="rated" type="checkbox"> 有評分</label></div><div id="v11-filter-chips"></div><button data-clear-filters>全部清除</button></details><div class="v11-toolbar"><button data-batch-toggle>批次選取模式</button><button data-select-visible>選取目前結果</button><button data-select-all>全選</button><button data-select-none>取消全選</button><select id="v11-batch-action"><option value="status">修改狀態</option><option value="platform">修改平台</option><option value="add-tag">新增標籤</option><option value="remove-tag">移除標籤</option><option value="reminder">啟用／停用提醒</option><option value="complete">移到已看完</option><option value="delete">刪除</option></select><select id="v11-batch-category" aria-label="批次分類">'+animeCategoryOptions("watching")+'</select><input id="v11-batch-value" placeholder="操作值" hidden><button data-run-batch>套用批次操作</button><button data-undo>復原上一步</button></div>');
        document.querySelectorAll("[data-filter]").forEach(input => { const value = state.filters[input.dataset.filter]; if (input.type === "checkbox") input.checked = Boolean(value); else input.value = Array.isArray(value) ? value[0] || "" : value || ""; });
    }

    function enableDebouncedSearch() {
        const input = document.getElementById("anime-list-search");
        if (!input) return;
        const replacement = input.cloneNode(true);
        input.replaceWith(replacement);
        let timer = null;
        replacement.addEventListener("input", event => {
            clearTimeout(timer);
            timer = setTimeout(() => { animeListQuery = event.target.value; renderList(); }, 180);
        });
    }

    function delegatedClick(event) {
        const statisticsButton = event.target.closest("[data-stat-action]");
        if (statisticsButton) return statisticsButton.dataset.statAction === "reset" ? resetWatchStatistics() : restoreLastWatchStatisticsReset();
        const progressButton = event.target.closest("[data-progress-action]");
        if (progressButton) { event.preventDefault(); event.stopPropagation(); return updateProgress(progressButton.dataset.animeId, progressButton.dataset.progressAction === "increment" ? 1 : -1); }
        const themesButton = event.target.closest("[data-open-themes]");
        if (themesButton) { event.preventDefault(); event.stopPropagation(); return openAnimeDetail(themesButton.dataset.openThemes, true); }
        const detailButton = event.target.closest("[data-open-detail]");
        if (detailButton) { event.preventDefault(); event.stopPropagation(); return openAnimeDetail(detailButton.dataset.openDetail, false); }
        if (event.target.id === "anime-list-clear") { const input=document.getElementById("anime-list-search"); if(input)input.value=""; animeListQuery=""; renderList(); }
        const close = event.target.closest("[data-close-modal]"); if (close) return closeV11Modals();
        const card = event.target.closest(".anime-item[data-anime-id]"); if (card && !event.target.closest("button,input,a,select,textarea")) return openAnimeDetail(card.dataset.animeId);
        if (event.target.matches("[data-batch-toggle]")) { state.batchMode = !state.batchMode; renderList(); }
        if (event.target.matches("[data-select-visible]")) V.searchFilterSort(animeList, animeListQuery, state.filters, animeListSort).forEach(x => state.selected.add(String(x.id))), renderList();
        if (event.target.matches("[data-select-all]")) animeList.filter(x => !x.deletedAt).forEach(x => state.selected.add(String(x.id))), renderList();
        if (event.target.matches("[data-select-none]")) state.selected.clear(), renderList();
        if (event.target.matches("[data-run-batch]")) runBatch();
        if (event.target.matches("[data-undo]")) undoLast();
        if (event.target.matches("[data-clear-filters]")) { state.filters = {}; persistViewFilters(); document.querySelectorAll("[data-filter]").forEach(x => x.type === "checkbox" ? x.checked = false : x.value = ""); renderList(); }
        const chip = event.target.closest("[data-remove-filter]"); if (chip) { delete state.filters[chip.dataset.removeFilter]; persistViewFilters(); renderList(); }
        const nav = event.target.closest("[data-cal-nav]"); if (nav) { state.calendarDate.setMonth(state.calendarDate.getMonth() + Number(nav.dataset.calNav)); renderCalendar(); }
        if (event.target.closest("[data-cal-today]")) { state.calendarDate = new Date(); renderCalendar(); }
        const day = event.target.closest("[data-calendar-day]"); if (day) renderDayItems(day.dataset.calendarDay);
        const restore = event.target.closest("[data-restore-id]"); if (restore) restorePoint(restore.dataset.restoreId);
        const sync = event.target.closest("[data-sync]"); if (sync) handleSync(sync.dataset.sync);
    }
    function delegatedChange(event) {
        if (event.target.matches("[data-select-anime]")) { const id = String(event.target.dataset.selectAnime); event.target.checked ? state.selected.add(id) : state.selected.delete(id); event.target.closest(".anime-item")?.classList.toggle("v11-selected", event.target.checked); }
        if (event.target.matches("[data-filter]")) { const key = event.target.dataset.filter, raw = event.target.type === "checkbox" ? event.target.checked : event.target.value.trim(); if (!raw) delete state.filters[key]; else state.filters[key] = ["status","platform","tags"].includes(key) ? [raw] : raw; persistViewFilters(); renderList(); }
        if (event.target.id === "v11-calendar-view") { state.calendarView = event.target.value; renderCalendar(); }
        if (event.target.id === "v11-calendar-filter") { state.calendarTypes = new Set([...event.target.selectedOptions].map(x => x.value)); renderCalendar(); }
        if (event.target.id === "v11-batch-action") {
            const category = event.target.value === "status";
            document.getElementById("v11-batch-category").hidden = !category;
            document.getElementById("v11-batch-value").hidden = category;
        }
    }

    function persistViewFilters() {
        if (window.__ANIME_STARTUP_STORAGE__?.recoveryPending) return false;
        try { save(FILTER_KEY, state.filters); return true; }
        catch (error) { window.warnAnimeStartupStorage?.("view-filters", error); return false; }
    }

    function renderFilterChips() { const box = document.getElementById("v11-filter-chips"); if (!box) return; box.innerHTML = Object.entries(state.filters).map(([key,value]) => `<span class="v11-chip">${escapeHtml(key)}：${escapeHtml(Array.isArray(value)?value.join("、"):value===true?"是":value)}<button data-remove-filter="${escapeHtml(key)}" aria-label="清除 ${escapeHtml(key)}">×</button></span>`).join(""); }
    function runBatch() {
        if (!state.selected.size) return showToast("請先選取動漫");
        const action = document.getElementById("v11-batch-action").value;
        const valueText = action === "status" ? document.getElementById("v11-batch-category").value : document.getElementById("v11-batch-value").value.trim();
        if (action === "delete") { const names = animeList.filter(x => state.selected.has(String(x.id))).map(x => x.title); if (!confirm(`將刪除 ${names.length} 部：\n${names.slice(0,10).join("、")}\n確定繼續？`)) return; }
        const value = action === "reminder" ? /^(1|true|啟用|是)$/i.test(valueText) : valueText;
        save(UNDO_KEY, { type: "batch", at: new Date().toISOString(), before: animeList, auxiliary:auxiliaryUndoSnapshot() });
        if (action === "delete") {
            const deleted = animeList.filter(item => state.selected.has(String(item.id)));
            const results = deleted.map(item => {
                const result = V.markAnimeDeletedById(animeList, item.id, new Date().toISOString(), V.getAnimeAniListIdentity(item));
                animeList = result.list;
                return result;
            });
            results.filter(result => result.changed && result.anime).forEach(result => cleanupAnimeAuxiliaryReferences(result.anime));
        } else animeList = V.applyBatch(animeList, [...state.selected], action, value);
        persistAnime(); state.selected.clear(); renderList(); refreshV11(); showToast("批次操作完成，可復原上一步");
    }
    function undoLast() {
        const undo = parse(UNDO_KEY, null);
        if (undo?.type === "delete-compact" && undo?.record) {
            const restored = V.restoreDeleteUndoState(animeList, currentDeleteAuxiliaryState(), undo, new Date().toISOString());
            if (!restored.restored) return showToast("找不到可復原的刪除資料");
            try {
                animeList = restored.list;
                persistAnime();
                applyCompactAuxiliaryRestore(restored.state, undo);
                localStorage.removeItem(UNDO_KEY);
                renderList(); renderEvents(); refreshV11();
                return showToast("已復原上一步");
            } catch (error) {
                return showToast("復原失敗：本機儲存空間不足，復原點仍保留");
            }
        }
        if (!undo?.before) return showToast("目前沒有可復原操作");
        animeList = V.migrateList(undo.before);
        if (undo.type === "delete" && undo.targetId != null) {
            animeList = V.restoreAnimeById(animeList, undo.targetId, undo.before, new Date().toISOString(), undo.targetIdentity).list;
        }
        restoreAuxiliaryUndo(undo);
        localStorage.removeItem(UNDO_KEY);
        persistAnime();
        if (Array.isArray(undo.auxiliary?.works)) window.CrossMediaTracker?.replaceData?.(undo.auxiliary.works, undo.auxiliary.mangaReadHistory || []);
        else window.CrossMediaTracker?.syncAnimeReferences?.();
        themeSongsApi()?.restoreCacheSnapshot?.(undo.auxiliary?.themeCache || {}, undo.auxiliary?.themeUndo || null);
        renderList(); renderEvents(); refreshV11(); showToast("已復原上一步");
    }

    function openAnimeDetail(id, expandThemes = false) {
        const item = animeList.find(x => String(x.id) === String(id)); if (!item) return;
        const history = watchHistory.filter(x => String(x.animeId) === String(item.id)).slice(-20).reverse();
        document.getElementById("v11-detail-title").textContent = item.title;
        const relatedEvents = [...eventList, ...eventArchive].filter(event => matchingAnime(event).some(match => String(match.id) === String(item.id)));
        document.getElementById("v11-detail-body").innerHTML = `<form id="v11-detail-form" data-id="${escapeHtml(item.id)}"><div class="v11-detail-grid"><div><img class="v11-poster" src="${safeUrl(item.poster) || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='300'%3E%3Crect width='100%25' height='100%25' fill='%230f172a'/%3E%3Ctext x='50%25' y='50%25' fill='%2394a3b8' text-anchor='middle'%3EAnime%3C/text%3E%3C/svg%3E"}" alt="${escapeHtml(item.title)} 海報"></div><div><label>正式名稱<input name="title" value="${escapeHtml(item.title)}"></label><label>別名<input name="aliases" value="${escapeHtml(item.aliases.join("、"))}"></label><label>劇情簡介<textarea name="synopsis">${escapeHtml(item.synopsis)}</textarea></label></div></div><div class="v11-filter-grid"><label>分類<select name="category">${animeCategoryOptions(item.category)}</select></label><label>目前集數<input name="currentEpisode" type="number" value="${item.currentEpisode}"></label><label>總集數<input name="totalEpisodes" type="number" value="${escapeHtml(item.totalEpisodes || "")}"></label><label>平台<input name="platform" value="${escapeHtml(item.platform)}"></label><label>標籤<input name="tags" value="${escapeHtml(item.tags.join("、"))}"></label><label>年份<input name="year" type="number" value="${escapeHtml(item.year || "")}"></label><label>季度<input name="season" value="${escapeHtml(item.season)}"></label><label>評分<input name="rating" type="number" min="0" max="10" step=".1" value="${escapeHtml(item.rating ?? "")}"></label><label>播出星期<input name="broadcastDay" value="${escapeHtml(item.broadcastDay)}"></label><label>播出時間<input name="broadcastTime" type="time" value="${escapeHtml(item.broadcastTime)}"></label><label>下一集時間<input name="nextEpisodeAt" type="datetime-local" value="${item.nextEpisodeAt ? escapeHtml(item.nextEpisodeAt.slice(0,16)) : ""}"></label><label>下一季日期<input name="nextSeasonDate" type="date" value="${escapeHtml(item.nextSeasonDate || "")}"></label><label><input name="reminderEnabled" type="checkbox" ${item.reminderEnabled?"checked":""}> 啟用提醒</label></div><label>筆記<textarea name="notes">${escapeHtml(item.notes)}</textarea></label><div class="v11-toolbar"><button type="button" onclick="updateProgress('${escapeHtml(item.id)}',-1)">減少 1 集</button><button type="button" onclick="updateProgress('${escapeHtml(item.id)}',1)">增加 1 集</button><button type="submit">儲存詳細資料</button></div><div class="tiny-note">建立：${escapeHtml(item.createdAt)}｜最近觀看：${escapeHtml(item.lastWatchedAt || "尚無")}</div><div id="v11-theme-section"></div><h3>相關活動</h3><div>${relatedEvents.map(x=>escapeHtml(x.title)).join("、")||"目前沒有相關活動"}</div><h3>觀看歷史</h3><div>${history.map(x=>`<div>${escapeHtml(x.at)}｜${x.delta>0?"+":""}${x.delta} 集</div>`).join("")||"尚無紀錄"}</div></form>`;
        document.getElementById("v11-detail-form").addEventListener("submit", saveDetail);
        document.getElementById("v11-detail-modal").hidden = false;
        themeSongsApi()?.renderForAnime(item, document.getElementById("v11-theme-section"));
        if (expandThemes) themeSongsApi()?.expand(document.getElementById("v11-theme-section"));
        window.CrossMediaTracker?.enhanceAnimeDetail?.(item, document.getElementById("v11-detail-body"));
    }
    function saveDetail(event) { event.preventDefault(); const form = event.currentTarget, item = animeList.find(x => String(x.id) === form.dataset.id); if (!item) return; const data = new FormData(form), previousTitle = item.title, previousCategory = item.category; ["title","category","platform","synopsis","season","broadcastDay","broadcastTime","notes"].forEach(key => item[key]=String(data.get(key)||"").trim()); if(item.title&&item.title!==previousTitle){item.displayTitle=item.title;item.titleSource="manual";item.titleManuallyEdited=true;} if(item.category&&item.category!==previousCategory){item.categorySource="manual";item.categoryManuallyEdited=true;} item.aliases=String(data.get("aliases")||"").split(/[、,，]/).map(x=>x.trim()).filter(Boolean); item.tags=String(data.get("tags")||"").split(/[、,，]/).map(x=>x.trim()).filter(Boolean); item.currentEpisode=item.watched=Number(data.get("currentEpisode"))||0; item.totalEpisodes=item.episodes=Number(data.get("totalEpisodes"))||null; item.year=Number(data.get("year"))||null; item.rating=data.get("rating")===""?null:Number(data.get("rating")); item.nextEpisodeAt=data.get("nextEpisodeAt")?new Date(data.get("nextEpisodeAt")).toISOString():null; item.nextSeasonDate=data.get("nextSeasonDate")||null; item.reminderEnabled=data.get("reminderEnabled")==="on"; item.note=item.notes; item.customPlatform=item.platform; touch(item); persistAnime(); renderList(); refreshV11(); closeV11Modals(); showToast("詳細資料已儲存"); }
    function closeV11Modals(){ themeSongsApi()?.close(); document.querySelectorAll(".v11-modal").forEach(x=>x.hidden=true); }
    function safeUrl(value){ try{const url=new URL(value,location.href);return ["http:","https:","data:"].includes(url.protocol)?url.href:""}catch{return ""} }

    function renderReminders() { const now=new Date(), week=new Date(now); week.setDate(week.getDate()+7); const list=animeList.filter(x=>!x.deletedAt&&x.reminderEnabled&&x.nextEpisodeAt).sort((a,b)=>Date.parse(a.nextEpisodeAt)-Date.parse(b.nextEpisodeAt)); const box=document.getElementById("v11-reminders");box.innerHTML=list.map(item=>{const date=new Date(item.nextEpisodeAt), diff=date-now, due=diff<=0; const days=Math.floor(Math.abs(diff)/86400000), hours=Math.floor(Math.abs(diff)%86400000/3600000), label=due?"已播出・待看":diff<86400000?"今天更新":diff<172800000?"明天更新":date<=week?"本週更新":"稍後";return `<div class="v11-card"><span class="v11-badge ${due?"danger":"good"}">${label}</span><strong>${escapeHtml(item.title)}</strong><div>下一集：${escapeHtml(date.toLocaleString("zh-TW"))}</div><div>${due?"已過":"剩餘"}：${days} 天 ${hours} 小時</div></div>`}).join("")||'<div class="empty">目前沒有啟用動畫提醒的作品。</div>';window.CrossMediaTracker?.appendMangaReminders?.(box); }
    function renderCalendar(){const box=document.getElementById("v11-calendar");if(!box)return;const date=new Date(state.calendarDate),year=date.getFullYear(),month=date.getMonth();document.getElementById("v11-calendar-title").textContent=`${year} 年 ${month+1} 月`;const items=V.calendarItems(animeList,[...eventList,...eventArchive]).filter(x=>state.calendarTypes.has(x.type));const first=new Date(year,month,1),start=new Date(first);start.setDate(start.getDate()-((start.getDay()+6)%7));const days=state.calendarView==="week"?7:42;if(state.calendarView==="week"){start.setTime(date.getTime());start.setDate(start.getDate()-((start.getDay()+6)%7))}box.innerHTML=Array.from({length:days},(_,i)=>{const day=new Date(start);day.setDate(day.getDate()+i);const key=day.toISOString().slice(0,10),dayItems=items.filter(x=>x.date===key);return `<div class="v11-day ${day.getMonth()!==month?"other":""} ${key===new Date().toISOString().slice(0,10)?"today":""}" data-calendar-day="${key}" tabindex="0"><strong>${day.getDate()}</strong>${dayItems.slice(0,4).map(x=>`<button class="v11-calendar-item" data-calendar-day="${key}">${iconType(x.type)} ${escapeHtml(x.title)}</button>`).join("")}</div>`}).join(""); }
    function iconType(type){return ({episode:"📺",movie:"🎬",season:"🌱","event-start":"🎪","event-end":"🏁"})[type]||"•"}
    function renderDayItems(key){const items=V.calendarItems(animeList,[...eventList,...eventArchive]).filter(x=>x.date===key&&state.calendarTypes.has(x.type));document.getElementById("v11-day-items").innerHTML=`<h3>${escapeHtml(key)}</h3>`+items.map(x=>`<button class="v11-card" ${x.animeId?`onclick="document.querySelector('[data-anime-id=&quot;${escapeHtml(x.animeId)}&quot;]')?.click()"`:""}>${iconType(x.type)} ${escapeHtml(x.label)}｜${escapeHtml(x.title)}</button>`).join("");}
    function renderStats(){const s=V.watchStats(watchHistory,animeList);const labels=[["今天觀看",s.today],["本週觀看",s.week],["本月觀看",s.month],["總觀看",s.total],["完成作品",s.completed],["正在連載",s.watching],["正在看",s.currentlyWatching],["平均評分",s.averageRating],["連續天數",s.streak],["常用平台",s.topPlatform],["常用標籤",s.topTag]];const bars=data=>`<div class="v11-chart-wrap"><div class="v11-trend">${data.map(x=>`<div class="v11-bar" style="height:${Math.max(3,x.count*10)}px" title="${x.date}: ${x.count}"></div>`).join("")}</div></div>`;const box=document.getElementById("v11-stats");box.innerHTML=`<div class="v11-grid v11-stats-grid">${labels.map(([a,b])=>`<div class="v11-card v11-stat">${a}<strong class="v11-stat-value">${escapeHtml(b)}</strong></div>`).join("")}</div><h3>最近 7 天</h3>${bars(s.trend7)}<h3>最近 30 天</h3>${bars(s.trend30)}`;window.CrossMediaTracker?.appendMangaStatistics?.(box);}
    function resetWatchStatistics(){if(!confirm("只會清除觀看歷史與統計，不會修改動漫進度，確定繼續嗎？"))return;V.resetWatchStatistics(localStorage);watchHistory=[];renderStats();showToast("觀看統計已歸零");}
    function restoreLastWatchStatisticsReset(){const result=V.restoreWatchStatistics(localStorage);if(!result.restored)return showToast("目前沒有可復原的統計重設");watchHistory=result.history;renderStats();showToast(`已恢復 ${result.restoredCount} 筆觀看紀錄`);}

    let pendingImport = null;
    function registerAppServiceWorker(){
        if (!("serviceWorker" in navigator)) return;
        const reloadVersion = "theme-songs-native-title-1";
        navigator.serviceWorker.addEventListener("message", event => {
            if (event.data?.type !== "ANIME_SW_CACHE_STATUS") return;
            document.documentElement.dataset.swCacheVersion = String(event.data.cacheVersion || "");
            document.documentElement.dataset.swCacheNames = JSON.stringify(event.data.cacheNames || []);
        });
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (window.__ANIME_STARTUP_STORAGE__?.recoveryPending) return;
            const key = "anime_tracker_sw_reload_version";
            if (sessionStorage.getItem(key) === reloadVersion) return;
            sessionStorage.setItem(key, reloadVersion);
            location.reload();
        });
        navigator.serviceWorker.register(`./sw.js?v=${reloadVersion}`).then(async reg => {
            reg.addEventListener("updatefound",()=>showToast("發現新版本，安裝完成後會自動套用"));
            await reg.update();
            const worker = navigator.serviceWorker.controller || reg.active || reg.waiting || reg.installing;
            document.documentElement.dataset.swScriptUrl = String(worker?.scriptURL || "");
            worker?.postMessage({ type:"GET_CACHE_STATUS" });
        }).catch(error => console.warn("Service Worker 註冊失敗：", error));
    }

    function wireStaticControls(){insertAnimeTools();document.getElementById("v11-export").onclick=exportBackup;document.getElementById("v11-import").onclick=()=>document.getElementById("v11-import-file").click();document.getElementById("v11-import-file").onchange=readImport;document.getElementById("v11-undo-import").onclick=undoImport;document.getElementById("v11-notifications").onclick=requestAnimeNotifications;document.querySelectorAll("[data-import-mode]").forEach(x=>x.onclick=()=>applyImport(x.dataset.importMode));const autoSync=document.getElementById("v11-auto-sync");autoSync.checked=localStorage.getItem("anime_tracker_auto_sync_v11")==="1";autoSync.disabled=Boolean(window.__ANIME_STARTUP_STORAGE__?.recoveryPending);autoSync.onchange=()=>changeAutoSyncSetting(autoSync);window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();state.installPrompt=event;document.getElementById("v11-install").hidden=false});document.getElementById("v11-install").onclick=async()=>{await state.installPrompt?.prompt();state.installPrompt=null};window.addEventListener("online",onlineState);window.addEventListener("offline",onlineState);onlineState();registerAppServiceWorker();}
    function changeAutoSyncSetting(control) {
        const previous = localStorage.getItem("anime_tracker_auto_sync_v11") === "1";
        if (window.__ANIME_STARTUP_STORAGE__?.recoveryPending) {
            control.checked = previous; control.disabled = true;
            return false;
        }
        try {
            window.assertAnimeStartupWritable?.();
            localStorage.setItem("anime_tracker_auto_sync_v11", control.checked ? "1" : "0");
            return true;
        } catch (error) {
            control.checked = previous;
            control.disabled = Boolean(window.__ANIME_STARTUP_STORAGE__?.recoveryPending);
            window.warnAnimeStartupStorage?.("auto-sync-setting", error);
            return false;
        }
    }
    function exportBackup(){
        try {
            const backup = V.createBackup(snapshot({ persistedOnly:true, forExport:true }), { preserveStoredRecords:true });
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type:"application/json" }), link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `anime_tracker_v11_${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (error) {
            console.warn("無法匯出原始備份", error);
            showToast("原始資料暫時無法安全讀取，備份尚未匯出。原有資料仍保留。", 7000);
        }
    }
    function readImport(event){const file=event.target.files[0];event.target.value="";if(!file)return;if(file.size>10*1024*1024)return showToast("匯入檔案不可超過 10 MB");const reader=new FileReader();reader.onload=()=>{try{const validation=V.validateBackup(reader.result);if(!validation.valid)throw Error(validation.error);pendingImport=validation.normalized;const p=validation.preview;document.getElementById("v11-import-preview").textContent=`備份格式：${p.format}｜版本：${p.schemaVersion}｜匯出：${p.exportedAt||"未知"}｜動畫：${p.animeCount} 部｜作品主體：${p.workCount}｜漫畫：${p.mangaCount}｜活動修正：${p.overrideCount}｜觀看紀錄：${p.historyCount}｜漫畫閱讀紀錄：${p.mangaHistoryCount}${p.requiresEmptyConfirmation?"｜⚠️ 備份內沒有任何作品，套用前會再次確認":""}`;document.getElementById("v11-import-modal").hidden=false}catch(error){pendingImport=null;showToast(`匯入失敗：${escapeHtml(error.message)}`)}};reader.onerror=()=>{pendingImport=null;showToast("匯入失敗：無法讀取檔案")};reader.readAsText(file);}
    function applyImport(mode){if(!pendingImport)return;const totalWorks=pendingImport.works.length||pendingImport[V.STORAGE_KEY].length;if(totalWorks===0&&!confirm("此備份包含 0 部作品。確定仍要繼續匯入？"))return;if(mode==="replace"&&!confirm("完全覆蓋會取代目前資料。系統會先建立還原點，確定繼續？"))return;let result;try{result=V.importBackup(snapshot(),pendingImport,mode)}catch(error){showToast(`匯入失敗：${escapeHtml(error.message)}`);return}createRestorePoint("匯入前自動還原點");animeList=result.animeList;eventOverrides=result.eventOverrides;eventAnimeOverrides=result.eventAnimeOverrides;watchHistory=result.watchHistory;state.lastImportRestore=parse(V.RESTORE_KEY,[])[0]?.id;save(V.HISTORY_KEY,watchHistory);save(EVENT_OVERRIDES_KEY,eventOverrides);save(EVENT_ANIME_OVERRIDES_KEY,eventAnimeOverrides);persistAnime();window.CrossMediaTracker?.replaceData?.(result.works,result.mangaReadHistory);renderList();renderEvents();closeV11Modals();showToast(`匯入完成：已處理 ${result.importedAnimeCount} 部動畫、${result.importedWorkCount} 個作品主體`);}
    function renderRestorePoints(){const box=document.getElementById("v11-restores");if(!box)return;const points=parse(V.RESTORE_KEY,[]);box.innerHTML='<h3>最近 5 個本機還原點</h3>'+points.map(x=>`<div class="v11-card">${escapeHtml(new Date(x.createdAt).toLocaleString("zh-TW"))}｜${x.animeCount} 部｜${escapeHtml(x.reason)} <button data-restore-id="${escapeHtml(x.id)}">還原</button></div>`).join("")||"尚無還原點";}
    function restorePoint(id){const point=parse(V.RESTORE_KEY,[]).find(x=>x.id===id);if(!point||!confirm(`確定還原 ${new Date(point.createdAt).toLocaleString("zh-TW")} 的資料？目前資料會先建立還原點。`))return;createRestorePoint("還原前自動備份");const result=V.importBackup(snapshot(),point.data,"replace");animeList=result.animeList;eventOverrides=result.eventOverrides;eventAnimeOverrides=result.eventAnimeOverrides;watchHistory=result.watchHistory;save(V.HISTORY_KEY,watchHistory);save(EVENT_OVERRIDES_KEY,eventOverrides);save(EVENT_ANIME_OVERRIDES_KEY,eventAnimeOverrides);persistAnime();window.CrossMediaTracker?.replaceData?.(result.works,result.mangaReadHistory);renderList();renderEvents();showToast("還原完成");}
    function undoImport(){if(!state.lastImportRestore)return showToast("本次尚未匯入資料");restorePoint(state.lastImportRestore);state.lastImportRestore=null;}
    async function requestAnimeNotifications(){if(window.__ANIME_STARTUP_STORAGE__?.recoveryPending)return;try{window.assertAnimeStartupWritable?.();localStorage.setItem("anime_notification_prompted_v11","1");}catch(error){window.warnAnimeStartupStorage?.("notification-setting",error);return;}if(!("Notification" in window))return showToast("此瀏覽器不支援通知");const permission=await Notification.requestPermission();showToast(permission==="granted"?"通知已開啟":"通知未授權");}
    function onlineState(){const offline=!navigator.onLine;document.getElementById("v11-offline")?.classList.toggle("show",offline);document.getElementById("work-event-btn")?.toggleAttribute("disabled",offline);if(!offline&&typeof loadEvents==="function")loadEvents();}

    function syncConfigured(){return Boolean(window.ANIME_SYNC_CONFIG?.supabaseUrl&&window.ANIME_SYNC_CONFIG?.anonKey&&window.supabase?.createClient)}
    function renderSyncStatus(message){const box=document.getElementById("v11-sync-status");if(!box)return;box.textContent=message||(syncConfigured()?`同步已設定｜最後同步：${localStorage.getItem("anime_tracker_last_sync_v11")||"尚未同步"}`:"尚未設定雲端同步");}
    async function handleSync(action, { persistedOnly = false } = {}) {
        const recoveryBlocked = () => {
            if (!window.__ANIME_STARTUP_STORAGE__?.recoveryPending) return false;
            renderSyncStatus("原始資料復原尚未完成，目前只能查看或匯出備份。");
            return true;
        };
        if (recoveryBlocked()) return;
        if (!syncConfigured()) return renderSyncStatus("尚未設定雲端同步");
        try {
            const client = window.supabase.createClient(window.ANIME_SYNC_CONFIG.supabaseUrl, window.ANIME_SYNC_CONFIG.anonKey);
            if (action === "login") {
                const email = document.getElementById("v11-sync-email").value.trim();
                if (!email) throw Error("請輸入 Email");
                await client.auth.signInWithOtp({ email, options:{ emailRedirectTo:location.href } });
                renderSyncStatus("Magic Link 已寄出");
            } else if (action === "logout") {
                await client.auth.signOut();
                renderSyncStatus("已登出");
            } else {
                const { data:{ user } } = await client.auth.getUser();
                if (recoveryBlocked()) return;
                if (!user) throw Error("請先登入");
                if (action === "upload") {
                    const { error } = await client.from("anime_tracker_payloads").upsert({
                        user_id:user.id,
                        payload:V.createBackup(snapshot({ persistedOnly }), { preserveStoredRecords:persistedOnly }),
                        updated_at:new Date().toISOString()
                    });
                    if (error) throw error;
                    if (recoveryBlocked()) return;
                    localStorage.setItem("anime_tracker_last_sync_v11", new Date().toISOString());
                    renderSyncStatus("上傳完成");
                }
                if (action === "download") {
                    const { data, error } = await client.from("anime_tracker_payloads").select("payload").eq("user_id", user.id).single();
                    if (recoveryBlocked()) return;
                    if (error) throw error;
                    const choice = (prompt("雲端資料處理方式：合併／本機／雲端", "合併") || "合併").trim();
                    if (!["合併", "本機", "雲端"].includes(choice)) throw Error("無效的衝突處理方式");
                    if (choice !== "本機") createRestorePoint("雲端下載前自動還原點");
                    const merged = V.mergeCloudPayload(snapshot(), {
                        animeList:data.payload[V.STORAGE_KEY], works:data.payload.works, mangaReadHistory:data.payload[V.MANGA_HISTORY_KEY],
                        eventOverrides:data.payload.eventOverrides, eventAnimeOverrides:data.payload.eventAnimeOverrides,
                        settings:data.payload.settings, watchHistory:data.payload.watchHistory
                    }, choice === "本機" ? "local" : choice === "雲端" ? "cloud" : "merge");
                    animeList = merged.animeList;
                    eventOverrides = merged.eventOverrides;
                    eventAnimeOverrides = merged.eventAnimeOverrides || {};
                    watchHistory = merged.watchHistory;
                    persistAnime();
                    window.CrossMediaTracker?.replaceData?.(merged.works, merged.mangaReadHistory);
                    save(EVENT_OVERRIDES_KEY, eventOverrides);
                    save(EVENT_ANIME_OVERRIDES_KEY, eventAnimeOverrides);
                    save(V.HISTORY_KEY, watchHistory);
                    renderList(); renderEvents(); renderSyncStatus("下載處理完成");
                }
            }
        } catch (error) { renderSyncStatus(`同步失敗：${error.message}`); }
    }

    function refreshV11(){renderCurrentlyWatching();renderReminders();renderStats();if(!document.querySelector('[data-v11-page-group="planner"]')?.hidden)renderCalendar();}
    window.exportData = exportBackup;
    window.importData = readImport;
    window.openAnimeDetail = openAnimeDetail;
    window.refreshV11 = refreshV11;
    addShell(); renderList(); refreshV11();
})();
