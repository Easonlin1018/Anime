(function () {
    "use strict";
    const V = window.AnimeTrackerV11;
    if (!V) return;
    const parse = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || "") ?? fallback; } catch { return fallback; } };
    const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    const FILTER_KEY = "anime_tracker_filters_v11";
    const UNDO_KEY = "anime_tracker_last_undo_v11";
    const PREFS_KEY = "anime_tracker_preferences_v11";
    const state = { filters: parse(FILTER_KEY, {}), selected: new Set(), batchMode: false, calendarDate: new Date(), calendarView: "month", calendarTypes: new Set(["episode", "movie", "season", "event-start", "event-end"]), installPrompt: null, lastImportRestore: null };
    let watchHistory = parse(V.HISTORY_KEY, []);
    let autoSyncTimer = null;

    function touch(item) { item.updatedAt = new Date().toISOString(); return item; }
    function persistAnime() { animeList = V.migrateList(animeList); localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList)); localStorage.setItem("anime_tracker_schema_version", "11"); }
    function currentSettings() { return { eventSettings, filters: state.filters, animeListSort, notificationPermissionAsked: localStorage.getItem("anime_notification_prompted_v11") === "1" }; }
    function snapshot() { const media=window.CrossMediaTracker?.snapshot?.()||{works:parse(V.WORKS_KEY,[]),mangaReadHistory:parse(V.MANGA_HISTORY_KEY,[])}; return { animeList: V.migrateList(animeList), works:media.works, mangaReadHistory:media.mangaReadHistory, eventOverrides: { ...eventOverrides }, eventAnimeOverrides:{ ...eventAnimeOverrides }, settings: currentSettings(), watchHistory: [...watchHistory], reminders: {}, preferences: parse(PREFS_KEY, {}) }; }
    function createRestorePoint(reason) {
        const points = parse(V.RESTORE_KEY, []);
        points.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason, animeCount: animeList.length, data: V.createBackup(snapshot()) });
        save(V.RESTORE_KEY, points.slice(0, 5));
        renderRestorePoints();
    }

    animeList = V.migrateList(animeList);
    persistAnime();

    const originalSaveAndRender = saveAndRender;
    saveAndRender = function () { animeList = animeList.map(item => touch(V.migrateAnime(item))); persistAnime(); originalSaveAndRender(); refreshV11(); if(localStorage.getItem("anime_tracker_auto_sync_v11")==="1"){clearTimeout(autoSyncTimer);autoSyncTimer=setTimeout(()=>handleSync("upload"),1500);} };
    const originalMoveCategory = moveCategory;
    moveCategory = function (id, category) { const item = animeList.find(x => String(x.id) === String(id)); if (item) touch(item); originalMoveCategory(id, category); };
    updateProgress = function (id, delta) {
        const wasCompleted = animeList.find(item => String(item.id) === String(id))?.category === "completed";
        const result = V.commitAnimeProgress(localStorage, animeList, watchHistory, id, delta);
        if (!result.found) return showToast("找不到要更新的動漫，請重新整理後再試");
        if (!result.changed) return showToast(result.reason === "at-total" ? "已達總集數，觀看進度不再增加" : "觀看進度沒有變更");
        animeList = result.list;
        const updated = result.anime;
        watchHistory = result.history;
        if (Number(delta) > 0 && updated.nextEpisodeAt) {
            const next = new Date(updated.nextEpisodeAt);
            if (next <= new Date() && updated.broadcastDay) next.setDate(next.getDate() + 7);
            updated.nextEpisodeAt = next.toISOString();
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(animeList));
        renderList();
        refreshV11();
        if (!wasCompleted && updated.category === "completed") void checkAndAddSequel(updated, false);
    };
    deleteAnime = function (id) {
        const item = animeList.find(x => String(x.id) === String(id)); if (!item) return;
        if (!confirm(`確定刪除「${item.title}」？可使用「復原上一步」恢復。`)) return;
        save(UNDO_KEY, { type: "delete", at: new Date().toISOString(), before: animeList });
        item.deletedAt = new Date().toISOString(); item.category = "_deleted"; touch(item); saveAndRender(); showToast("🗑️ 已刪除，可在批次工具列復原上一步");
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
        const visible = V.searchFilterSort(full, animeListQuery, state.filters, animeListSort, item => [...eventList, ...eventArchive].some(event => matchingAnime(event).some(match => String(match.id) === String(item.id))));
        const allowed = new Set(visible.map(item => String(item.id)));
        animeList = full.map(item => allowed.has(String(item.id)) ? item : { ...item, category: "_v11_filtered" });
        originalRenderList();
        animeList = full;
        const summary = document.getElementById("anime-list-summary"); if (summary) summary.textContent = `顯示 ${visible.length}／${full.filter(x => !x.deletedAt).length} 部`;
        renderFilterChips();
        window.CrossMediaTracker?.renderSearchResults?.(animeListQuery);
    };

    function addShell() {
        document.title = "全自動動漫追番基地 v11.0";
        document.querySelector("h1").textContent = "🎬 全自動動漫追番基地 v11.0";
        const container = document.querySelector(".container");
        const nav = document.createElement("nav"); nav.className = "v11-nav"; nav.setAttribute("aria-label", "主導覽");
        nav.innerHTML = [["anime","我的動漫"],["reminders","本週待看"],["planner","行事曆"],["events","活動"],["stats","統計"],["data","資料管理"],["sync","設定／同步"]].map(([id,label],i)=>`<button type="button" data-v11-page="${id}" class="${i===0?"active":""}">${label}</button>`).join("");
        container.insertBefore(nav, container.firstElementChild.nextSibling);
        [...container.children].forEach(element => { if (element.classList.contains("section")) { element.dataset.v11Original = "1"; element.classList.add("v11-page"); element.dataset.v11PageGroup = element.id === "events-section" ? "events" : "anime"; } });
        const pages = document.createElement("div");
        pages.innerHTML = reminderPage() + calendarPage() + statsPage() + dataPage() + syncPage();
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
        if (page === "reminders") renderReminders(); if (page === "planner") renderCalendar(); if (page === "stats") renderStats(); if (page === "data") renderRestorePoints(); if (page === "sync") renderSyncStatus();
        scrollTo({ top: 0, behavior: "smooth" });
    }

    function insertAnimeTools() {
        const toolbar = document.querySelector(".anime-list-toolbar"); if (!toolbar) return;
        toolbar.insertAdjacentHTML("afterend", '<details class="v11-filter-panel"><summary>進階篩選</summary><div class="v11-filter-grid"><label>狀態<select data-filter="status"><option value="">全部</option><option value="watching">正在看</option><option value="backlog">補番中</option><option value="waiting">等待</option><option value="completed">已完成</option></select></label><label>平台<input data-filter="platform" placeholder="平台"></label><label>標籤<input data-filter="tags" placeholder="標籤"></label><label>年份<input data-filter="year" type="number" min="1900" max="2200"></label><label>季度<select data-filter="season"><option value="">全部</option><option>WINTER</option><option>SPRING</option><option>SUMMER</option><option>FALL</option></select></label><label><input data-filter="unfinished" type="checkbox"> 尚未看完</label><label><input data-filter="stale" type="checkbox"> 30 天未觀看</label><label><input data-filter="hasEvents" type="checkbox"> 有活動</label><label><input data-filter="hasNextSeason" type="checkbox"> 有下一季</label><label><input data-filter="reminder" type="checkbox"> 有提醒</label><label><input data-filter="rated" type="checkbox"> 有評分</label></div><div id="v11-filter-chips"></div><button data-clear-filters>全部清除</button></details><div class="v11-toolbar"><button data-batch-toggle>批次選取模式</button><button data-select-visible>選取目前結果</button><button data-select-all>全選</button><button data-select-none>取消全選</button><select id="v11-batch-action"><option value="status">修改狀態</option><option value="platform">修改平台</option><option value="add-tag">新增標籤</option><option value="remove-tag">移除標籤</option><option value="reminder">啟用／停用提醒</option><option value="complete">移到已看完</option><option value="delete">刪除</option></select><input id="v11-batch-value" placeholder="操作值"><button data-run-batch>套用批次操作</button><button data-undo>復原上一步</button></div>');
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
        if (event.target.matches("[data-clear-filters]")) { state.filters = {}; save(FILTER_KEY, state.filters); document.querySelectorAll("[data-filter]").forEach(x => x.type === "checkbox" ? x.checked = false : x.value = ""); renderList(); }
        const chip = event.target.closest("[data-remove-filter]"); if (chip) { delete state.filters[chip.dataset.removeFilter]; save(FILTER_KEY, state.filters); renderList(); }
        const nav = event.target.closest("[data-cal-nav]"); if (nav) { state.calendarDate.setMonth(state.calendarDate.getMonth() + Number(nav.dataset.calNav)); renderCalendar(); }
        if (event.target.closest("[data-cal-today]")) { state.calendarDate = new Date(); renderCalendar(); }
        const day = event.target.closest("[data-calendar-day]"); if (day) renderDayItems(day.dataset.calendarDay);
        const restore = event.target.closest("[data-restore-id]"); if (restore) restorePoint(restore.dataset.restoreId);
        const sync = event.target.closest("[data-sync]"); if (sync) handleSync(sync.dataset.sync);
    }
    function delegatedChange(event) {
        if (event.target.matches("[data-select-anime]")) { const id = String(event.target.dataset.selectAnime); event.target.checked ? state.selected.add(id) : state.selected.delete(id); event.target.closest(".anime-item")?.classList.toggle("v11-selected", event.target.checked); }
        if (event.target.matches("[data-filter]")) { const key = event.target.dataset.filter, raw = event.target.type === "checkbox" ? event.target.checked : event.target.value.trim(); if (!raw) delete state.filters[key]; else state.filters[key] = ["status","platform","tags"].includes(key) ? [raw] : raw; save(FILTER_KEY, state.filters); renderList(); }
        if (event.target.id === "v11-calendar-view") { state.calendarView = event.target.value; renderCalendar(); }
        if (event.target.id === "v11-calendar-filter") { state.calendarTypes = new Set([...event.target.selectedOptions].map(x => x.value)); renderCalendar(); }
    }

    function renderFilterChips() { const box = document.getElementById("v11-filter-chips"); if (!box) return; box.innerHTML = Object.entries(state.filters).map(([key,value]) => `<span class="v11-chip">${escapeHtml(key)}：${escapeHtml(Array.isArray(value)?value.join("、"):value===true?"是":value)}<button data-remove-filter="${escapeHtml(key)}" aria-label="清除 ${escapeHtml(key)}">×</button></span>`).join(""); }
    function runBatch() {
        if (!state.selected.size) return showToast("請先選取動漫");
        const action = document.getElementById("v11-batch-action").value, valueText = document.getElementById("v11-batch-value").value.trim();
        if (action === "delete") { const names = animeList.filter(x => state.selected.has(String(x.id))).map(x => x.title); if (!confirm(`將刪除 ${names.length} 部：\n${names.slice(0,10).join("、")}\n確定繼續？`)) return; }
        const value = action === "reminder" ? /^(1|true|啟用|是)$/i.test(valueText) : valueText;
        save(UNDO_KEY, { type: "batch", at: new Date().toISOString(), before: animeList }); animeList = V.applyBatch(animeList, [...state.selected], action, value); persistAnime(); state.selected.clear(); renderList(); refreshV11(); showToast("批次操作完成，可復原上一步");
    }
    function undoLast() { const undo = parse(UNDO_KEY, null); if (!undo?.before) return showToast("目前沒有可復原操作"); animeList = V.migrateList(undo.before); localStorage.removeItem(UNDO_KEY); persistAnime(); renderList(); refreshV11(); showToast("已復原上一步"); }

    function openAnimeDetail(id, expandThemes = false) {
        const item = animeList.find(x => String(x.id) === String(id)); if (!item) return;
        const history = watchHistory.filter(x => String(x.animeId) === String(item.id)).slice(-20).reverse();
        document.getElementById("v11-detail-title").textContent = item.title;
        const relatedEvents = [...eventList, ...eventArchive].filter(event => matchingAnime(event).some(match => String(match.id) === String(item.id)));
        document.getElementById("v11-detail-body").innerHTML = `<form id="v11-detail-form" data-id="${escapeHtml(item.id)}"><div class="v11-detail-grid"><div><img class="v11-poster" src="${safeUrl(item.poster) || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='300'%3E%3Crect width='100%25' height='100%25' fill='%230f172a'/%3E%3Ctext x='50%25' y='50%25' fill='%2394a3b8' text-anchor='middle'%3EAnime%3C/text%3E%3C/svg%3E"}" alt="${escapeHtml(item.title)} 海報"></div><div><label>正式名稱<input name="title" value="${escapeHtml(item.title)}"></label><label>別名<input name="aliases" value="${escapeHtml(item.aliases.join("、"))}"></label><label>劇情簡介<textarea name="synopsis">${escapeHtml(item.synopsis)}</textarea></label></div></div><div class="v11-filter-grid"><label>狀態<input name="category" value="${escapeHtml(item.category)}"></label><label>目前集數<input name="currentEpisode" type="number" value="${item.currentEpisode}"></label><label>總集數<input name="totalEpisodes" type="number" value="${escapeHtml(item.totalEpisodes || "")}"></label><label>平台<input name="platform" value="${escapeHtml(item.platform)}"></label><label>標籤<input name="tags" value="${escapeHtml(item.tags.join("、"))}"></label><label>年份<input name="year" type="number" value="${escapeHtml(item.year || "")}"></label><label>季度<input name="season" value="${escapeHtml(item.season)}"></label><label>評分<input name="rating" type="number" min="0" max="10" step=".1" value="${escapeHtml(item.rating ?? "")}"></label><label>播出星期<input name="broadcastDay" value="${escapeHtml(item.broadcastDay)}"></label><label>播出時間<input name="broadcastTime" type="time" value="${escapeHtml(item.broadcastTime)}"></label><label>下一集時間<input name="nextEpisodeAt" type="datetime-local" value="${item.nextEpisodeAt ? escapeHtml(item.nextEpisodeAt.slice(0,16)) : ""}"></label><label>下一季日期<input name="nextSeasonDate" type="date" value="${escapeHtml(item.nextSeasonDate || "")}"></label><label><input name="reminderEnabled" type="checkbox" ${item.reminderEnabled?"checked":""}> 啟用提醒</label></div><label>筆記<textarea name="notes">${escapeHtml(item.notes)}</textarea></label><div class="v11-toolbar"><button type="button" onclick="updateProgress('${escapeHtml(item.id)}',-1)">減少 1 集</button><button type="button" onclick="updateProgress('${escapeHtml(item.id)}',1)">增加 1 集</button><button type="submit">儲存詳細資料</button></div><div class="tiny-note">建立：${escapeHtml(item.createdAt)}｜最近觀看：${escapeHtml(item.lastWatchedAt || "尚無")}</div><div id="v11-theme-section"></div><h3>相關活動</h3><div>${relatedEvents.map(x=>escapeHtml(x.title)).join("、")||"目前沒有相關活動"}</div><h3>觀看歷史</h3><div>${history.map(x=>`<div>${escapeHtml(x.at)}｜${x.delta>0?"+":""}${x.delta} 集</div>`).join("")||"尚無紀錄"}</div></form>`;
        document.getElementById("v11-detail-form").addEventListener("submit", saveDetail);
        document.getElementById("v11-detail-modal").hidden = false;
        window.SpotifyThemes?.renderForAnime(item, document.getElementById("v11-theme-section"));
        if (expandThemes) window.SpotifyThemes?.expand(document.getElementById("v11-theme-section"));
        window.CrossMediaTracker?.enhanceAnimeDetail?.(item, document.getElementById("v11-detail-body"));
    }
    function saveDetail(event) { event.preventDefault(); const form = event.currentTarget, item = animeList.find(x => String(x.id) === form.dataset.id); if (!item) return; const data = new FormData(form); ["title","category","platform","synopsis","season","broadcastDay","broadcastTime","notes"].forEach(key => item[key]=String(data.get(key)||"").trim()); item.aliases=String(data.get("aliases")||"").split(/[、,，]/).map(x=>x.trim()).filter(Boolean); item.tags=String(data.get("tags")||"").split(/[、,，]/).map(x=>x.trim()).filter(Boolean); item.currentEpisode=item.watched=Number(data.get("currentEpisode"))||0; item.totalEpisodes=item.episodes=Number(data.get("totalEpisodes"))||null; item.year=Number(data.get("year"))||null; item.rating=data.get("rating")===""?null:Number(data.get("rating")); item.nextEpisodeAt=data.get("nextEpisodeAt")?new Date(data.get("nextEpisodeAt")).toISOString():null; item.nextSeasonDate=data.get("nextSeasonDate")||null; item.reminderEnabled=data.get("reminderEnabled")==="on"; item.note=item.notes; item.customPlatform=item.platform; touch(item); persistAnime(); renderList(); refreshV11(); closeV11Modals(); showToast("詳細資料已儲存"); }
    function closeV11Modals(){ window.SpotifyThemes?.close(); document.querySelectorAll(".v11-modal").forEach(x=>x.hidden=true); }
    function safeUrl(value){ try{const url=new URL(value,location.href);return ["http:","https:","data:"].includes(url.protocol)?url.href:""}catch{return ""} }

    function renderReminders() { const now=new Date(), week=new Date(now); week.setDate(week.getDate()+7); const list=animeList.filter(x=>x.reminderEnabled&&x.nextEpisodeAt).sort((a,b)=>Date.parse(a.nextEpisodeAt)-Date.parse(b.nextEpisodeAt)); const box=document.getElementById("v11-reminders");box.innerHTML=list.map(item=>{const date=new Date(item.nextEpisodeAt), diff=date-now, due=diff<=0; const days=Math.floor(Math.abs(diff)/86400000), hours=Math.floor(Math.abs(diff)%86400000/3600000), label=due?"已播出・待看":diff<86400000?"今天更新":diff<172800000?"明天更新":date<=week?"本週更新":"稍後";return `<div class="v11-card"><span class="v11-badge ${due?"danger":"good"}">${label}</span><strong>${escapeHtml(item.title)}</strong><div>下一集：${escapeHtml(date.toLocaleString("zh-TW"))}</div><div>${due?"已過":"剩餘"}：${days} 天 ${hours} 小時</div></div>`}).join("")||'<div class="empty">目前沒有啟用動畫提醒的作品。</div>';window.CrossMediaTracker?.appendMangaReminders?.(box); }
    function renderCalendar(){const box=document.getElementById("v11-calendar");if(!box)return;const date=new Date(state.calendarDate),year=date.getFullYear(),month=date.getMonth();document.getElementById("v11-calendar-title").textContent=`${year} 年 ${month+1} 月`;const items=V.calendarItems(animeList,[...eventList,...eventArchive]).filter(x=>state.calendarTypes.has(x.type));const first=new Date(year,month,1),start=new Date(first);start.setDate(start.getDate()-((start.getDay()+6)%7));const days=state.calendarView==="week"?7:42;if(state.calendarView==="week"){start.setTime(date.getTime());start.setDate(start.getDate()-((start.getDay()+6)%7))}box.innerHTML=Array.from({length:days},(_,i)=>{const day=new Date(start);day.setDate(day.getDate()+i);const key=day.toISOString().slice(0,10),dayItems=items.filter(x=>x.date===key);return `<div class="v11-day ${day.getMonth()!==month?"other":""} ${key===new Date().toISOString().slice(0,10)?"today":""}" data-calendar-day="${key}" tabindex="0"><strong>${day.getDate()}</strong>${dayItems.slice(0,4).map(x=>`<button class="v11-calendar-item" data-calendar-day="${key}">${iconType(x.type)} ${escapeHtml(x.title)}</button>`).join("")}</div>`}).join(""); }
    function iconType(type){return ({episode:"📺",movie:"🎬",season:"🌱","event-start":"🎪","event-end":"🏁"})[type]||"•"}
    function renderDayItems(key){const items=V.calendarItems(animeList,[...eventList,...eventArchive]).filter(x=>x.date===key&&state.calendarTypes.has(x.type));document.getElementById("v11-day-items").innerHTML=`<h3>${escapeHtml(key)}</h3>`+items.map(x=>`<button class="v11-card" ${x.animeId?`onclick="document.querySelector('[data-anime-id=&quot;${escapeHtml(x.animeId)}&quot;]')?.click()"`:""}>${iconType(x.type)} ${escapeHtml(x.label)}｜${escapeHtml(x.title)}</button>`).join("");}
    function renderStats(){const s=V.watchStats(watchHistory,animeList);const labels=[["今天觀看",s.today],["本週觀看",s.week],["本月觀看",s.month],["總觀看",s.total],["完成作品",s.completed],["正在觀看",s.watching],["平均評分",s.averageRating],["連續天數",s.streak],["常用平台",s.topPlatform],["常用標籤",s.topTag]];const bars=data=>`<div class="v11-chart-wrap"><div class="v11-trend">${data.map(x=>`<div class="v11-bar" style="height:${Math.max(3,x.count*10)}px" title="${x.date}: ${x.count}"></div>`).join("")}</div></div>`;const box=document.getElementById("v11-stats");box.innerHTML=`<div class="v11-grid v11-stats-grid">${labels.map(([a,b])=>`<div class="v11-card v11-stat">${a}<strong class="v11-stat-value">${escapeHtml(b)}</strong></div>`).join("")}</div><h3>最近 7 天</h3>${bars(s.trend7)}<h3>最近 30 天</h3>${bars(s.trend30)}`;window.CrossMediaTracker?.appendMangaStatistics?.(box);}
    function resetWatchStatistics(){if(!confirm("只會清除觀看歷史與統計，不會修改動漫進度，確定繼續嗎？"))return;V.resetWatchStatistics(localStorage);watchHistory=[];renderStats();showToast("觀看統計已歸零");}
    function restoreLastWatchStatisticsReset(){const result=V.restoreWatchStatistics(localStorage);if(!result.restored)return showToast("目前沒有可復原的統計重設");watchHistory=result.history;renderStats();showToast(`已恢復 ${result.restoredCount} 筆觀看紀錄`);}

    let pendingImport = null;
    function wireStaticControls(){insertAnimeTools();document.getElementById("v11-export").onclick=exportBackup;document.getElementById("v11-import").onclick=()=>document.getElementById("v11-import-file").click();document.getElementById("v11-import-file").onchange=readImport;document.getElementById("v11-undo-import").onclick=undoImport;document.getElementById("v11-notifications").onclick=requestAnimeNotifications;document.querySelectorAll("[data-import-mode]").forEach(x=>x.onclick=()=>applyImport(x.dataset.importMode));const autoSync=document.getElementById("v11-auto-sync");autoSync.checked=localStorage.getItem("anime_tracker_auto_sync_v11")==="1";autoSync.onchange=()=>localStorage.setItem("anime_tracker_auto_sync_v11",autoSync.checked?"1":"0");window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();state.installPrompt=event;document.getElementById("v11-install").hidden=false});document.getElementById("v11-install").onclick=async()=>{await state.installPrompt?.prompt();state.installPrompt=null};window.addEventListener("online",onlineState);window.addEventListener("offline",onlineState);onlineState();if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").then(reg=>reg.addEventListener("updatefound",()=>showToast("發現新版本，重新整理後套用"))).catch(()=>{});}
    function exportBackup(){const backup=V.createBackup(snapshot()),blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"}),link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`anime_tracker_v11_${new Date().toISOString().slice(0,10)}.json`;link.click();URL.revokeObjectURL(link.href);}
    function readImport(event){const file=event.target.files[0];event.target.value="";if(!file)return;if(file.size>10*1024*1024)return showToast("匯入檔案不可超過 10 MB");const reader=new FileReader();reader.onload=()=>{try{const validation=V.validateBackup(reader.result);if(!validation.valid)throw Error(validation.error);pendingImport=validation.normalized;const p=validation.preview;document.getElementById("v11-import-preview").textContent=`備份格式：${p.format}｜版本：${p.schemaVersion}｜匯出：${p.exportedAt||"未知"}｜動畫：${p.animeCount} 部｜作品主體：${p.workCount}｜漫畫：${p.mangaCount}｜活動修正：${p.overrideCount}｜觀看紀錄：${p.historyCount}｜漫畫閱讀紀錄：${p.mangaHistoryCount}${p.requiresEmptyConfirmation?"｜⚠️ 備份內沒有任何作品，套用前會再次確認":""}`;document.getElementById("v11-import-modal").hidden=false}catch(error){pendingImport=null;showToast(`匯入失敗：${escapeHtml(error.message)}`)}};reader.onerror=()=>{pendingImport=null;showToast("匯入失敗：無法讀取檔案")};reader.readAsText(file);}
    function applyImport(mode){if(!pendingImport)return;const totalWorks=pendingImport.works.length||pendingImport[V.STORAGE_KEY].length;if(totalWorks===0&&!confirm("此備份包含 0 部作品。確定仍要繼續匯入？"))return;if(mode==="replace"&&!confirm("完全覆蓋會取代目前資料。系統會先建立還原點，確定繼續？"))return;let result;try{result=V.importBackup(snapshot(),pendingImport,mode)}catch(error){showToast(`匯入失敗：${escapeHtml(error.message)}`);return}createRestorePoint("匯入前自動還原點");animeList=result.animeList;eventOverrides=result.eventOverrides;eventAnimeOverrides=result.eventAnimeOverrides;watchHistory=result.watchHistory;state.lastImportRestore=parse(V.RESTORE_KEY,[])[0]?.id;save(V.HISTORY_KEY,watchHistory);save(EVENT_OVERRIDES_KEY,eventOverrides);save(EVENT_ANIME_OVERRIDES_KEY,eventAnimeOverrides);persistAnime();window.CrossMediaTracker?.replaceData?.(result.works,result.mangaReadHistory);renderList();renderEvents();closeV11Modals();showToast(`匯入完成：已處理 ${result.importedAnimeCount} 部動畫、${result.importedWorkCount} 個作品主體`);}
    function renderRestorePoints(){const box=document.getElementById("v11-restores");if(!box)return;const points=parse(V.RESTORE_KEY,[]);box.innerHTML='<h3>最近 5 個本機還原點</h3>'+points.map(x=>`<div class="v11-card">${escapeHtml(new Date(x.createdAt).toLocaleString("zh-TW"))}｜${x.animeCount} 部｜${escapeHtml(x.reason)} <button data-restore-id="${escapeHtml(x.id)}">還原</button></div>`).join("")||"尚無還原點";}
    function restorePoint(id){const point=parse(V.RESTORE_KEY,[]).find(x=>x.id===id);if(!point||!confirm(`確定還原 ${new Date(point.createdAt).toLocaleString("zh-TW")} 的資料？目前資料會先建立還原點。`))return;createRestorePoint("還原前自動備份");const result=V.importBackup(snapshot(),point.data,"replace");animeList=result.animeList;eventOverrides=result.eventOverrides;eventAnimeOverrides=result.eventAnimeOverrides;watchHistory=result.watchHistory;save(V.HISTORY_KEY,watchHistory);save(EVENT_OVERRIDES_KEY,eventOverrides);save(EVENT_ANIME_OVERRIDES_KEY,eventAnimeOverrides);persistAnime();window.CrossMediaTracker?.replaceData?.(result.works,result.mangaReadHistory);renderList();renderEvents();showToast("還原完成");}
    function undoImport(){if(!state.lastImportRestore)return showToast("本次尚未匯入資料");restorePoint(state.lastImportRestore);state.lastImportRestore=null;}
    async function requestAnimeNotifications(){localStorage.setItem("anime_notification_prompted_v11","1");if(!("Notification" in window))return showToast("此瀏覽器不支援通知");const permission=await Notification.requestPermission();showToast(permission==="granted"?"通知已開啟":"通知未授權");}
    function onlineState(){const offline=!navigator.onLine;document.getElementById("v11-offline")?.classList.toggle("show",offline);document.getElementById("work-event-btn")?.toggleAttribute("disabled",offline);if(!offline&&typeof loadEvents==="function")loadEvents();}

    function syncConfigured(){return Boolean(window.ANIME_SYNC_CONFIG?.supabaseUrl&&window.ANIME_SYNC_CONFIG?.anonKey&&window.supabase?.createClient)}
    function renderSyncStatus(message){const box=document.getElementById("v11-sync-status");if(!box)return;box.textContent=message||(syncConfigured()?`同步已設定｜最後同步：${localStorage.getItem("anime_tracker_last_sync_v11")||"尚未同步"}`:"尚未設定雲端同步");}
    async function handleSync(action){if(!syncConfigured())return renderSyncStatus("尚未設定雲端同步");const client=window.supabase.createClient(window.ANIME_SYNC_CONFIG.supabaseUrl,window.ANIME_SYNC_CONFIG.anonKey);try{if(action==="login"){const email=document.getElementById("v11-sync-email").value.trim();if(!email)throw Error("請輸入 Email");await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.href}});renderSyncStatus("Magic Link 已寄出")}else if(action==="logout"){await client.auth.signOut();renderSyncStatus("已登出")}else{const {data:{user}}=await client.auth.getUser();if(!user)throw Error("請先登入");if(action==="upload"){await client.from("anime_tracker_payloads").upsert({user_id:user.id,payload:V.createBackup(snapshot()),updated_at:new Date().toISOString()});localStorage.setItem("anime_tracker_last_sync_v11",new Date().toISOString());renderSyncStatus("上傳完成")}if(action==="download"){const {data,error}=await client.from("anime_tracker_payloads").select("payload").eq("user_id",user.id).single();if(error)throw error;const choice=(prompt("雲端資料處理方式：合併／本機／雲端","合併")||"合併").trim();if(!["合併","本機","雲端"].includes(choice))throw Error("無效的衝突處理方式");if(choice!=="本機")createRestorePoint("雲端下載前自動還原點");const merged=V.mergeCloudPayload(snapshot(),{animeList:data.payload[V.STORAGE_KEY],works:data.payload.works,mangaReadHistory:data.payload[V.MANGA_HISTORY_KEY],eventOverrides:data.payload.eventOverrides,eventAnimeOverrides:data.payload.eventAnimeOverrides,settings:data.payload.settings,watchHistory:data.payload.watchHistory},choice==="本機"?"local":choice==="雲端"?"cloud":"merge");animeList=merged.animeList;eventOverrides=merged.eventOverrides;eventAnimeOverrides=merged.eventAnimeOverrides||{};watchHistory=merged.watchHistory;persistAnime();window.CrossMediaTracker?.replaceData?.(merged.works,merged.mangaReadHistory);save(EVENT_OVERRIDES_KEY,eventOverrides);save(EVENT_ANIME_OVERRIDES_KEY,eventAnimeOverrides);save(V.HISTORY_KEY,watchHistory);renderList();renderEvents();renderSyncStatus("下載處理完成")}}}catch(error){renderSyncStatus(`同步失敗：${error.message}`)}}

    function refreshV11(){renderReminders();renderStats();if(!document.querySelector('[data-v11-page-group="planner"]')?.hidden)renderCalendar();}
    window.exportData = exportBackup;
    window.importData = readImport;
    window.openAnimeDetail = openAnimeDetail;
    addShell(); renderList(); refreshV11();
})();
