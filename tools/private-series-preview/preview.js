"use strict";

const V = window.AnimeTrackerV11;
const preview = window.PrivateSeriesPreview;
const purge = window.PrivateSeriesPurge;
const picker = document.getElementById("backup-file");
const clear = document.getElementById("clear-copy");
const status = document.getElementById("status");
const summary = document.getElementById("summary");
const offline = document.getElementById("offline");
const search = document.getElementById("search");
const report = document.getElementById("report");
const comparison = document.getElementById("comparison");
const comparisonResults = document.getElementById("comparison-results");
const deletedDiagnostics = document.getElementById("deleted-diagnostics");
const deletedCount = document.getElementById("deleted-count");
const deletedRecords = document.getElementById("deleted-records");
const resultLabels = {
    grouped:"目前分組結果", independent:"維持獨立", suggestion:"可選的分組建議", review:"需要人工確認",
    conflict:"可能的錯誤分組或身分衝突"
};
const categoryLabels = { watching:"正在連載", backlog:"補番中", review:"複習中",
    waiting:"等待中", completed:"已追完", _deleted:"已刪除" };
let db, copy, result, busy = false;
let searchTimer;

function originalTitle(row) {
    return String(row.title || row.canonicalTitle || "未命名");
}

function element(tag, label = "", className = "") {
    const node = document.createElement(tag);
    node.textContent = label;
    if (className) node.className = className;
    return node;
}

function labeled(label, field) {
    const node = element("label", label);
    node.append(field);
    return node;
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("anime-series-private-preview", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("copy");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("請關閉這個驗收網站的其他分頁再重試。"));
    });
}

function transaction(update) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("copy", update ? "readwrite" : "readonly");
        const store = tx.objectStore("copy");
        const active = store.get("active");
        const exclusions = store.get("purged");
        let next, failure;
        exclusions.onsuccess = () => {
            try {
                const markers = exclusions.result ?? [];
                const copy = active.result ? purge.applyMarkers(active.result, markers) : null;
                next = { copy, markers };
                if (!update) return;
                next = update(next);
                if (next.copy) store.put(next.copy, "active");
                else store.delete("active");
                if (next.markers !== markers) store.put(next.markers, "purged");
            } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(next);
        tx.onabort = () => reject(failure || tx.error || new Error("無法完成本機儲存。"));
    });
}

function setCopy(next) {
    copy = next;
    result = next ? preview.reportSeries(next) : null;
    render();
}

async function saveState(operation, message) {
    if (busy) return;
    busy = picker.disabled = clear.disabled = true;
    try {
        const expected = copy?.revision;
        const next = await transaction(current => {
            if (current.copy?.revision !== expected) throw new Error("測試副本已在另一個分頁變更，請重新整理後再試。");
            const value = operation(current);
            return { ...value, copy:value.copy ? { ...value.copy, revision:crypto.randomUUID() } : null };
        });
        setCopy(next.copy);
        status.textContent = message;
    } catch (error) {
        status.textContent = error.name === "QuotaExceededError"
            ? "這台裝置的空間不足，原本的測試副本已保留。"
            : "未儲存。 " + (error.message || "請重新整理後再試。");
    } finally {
        busy = picker.disabled = false;
        clear.disabled = !copy;
    }
}

function save(operation, message) {
    return saveState(current => ({ ...current, copy:operation(current.copy, current.markers) }), message);
}

function permanentDelete(item) {
    if (busy || !purge.canPurge(copy, item.index)) return;
    if (!confirm("要永久刪除這筆已刪除作品的驗收副本及可安全對應的資料嗎？")) return;
    if (!confirm(`再確認一次，永久刪除「${originalTitle(item.row)}」的驗收副本？此操作只影響這個瀏覽器內的驗收資料，無法復原。`)) return;
    void saveState(current => purge.purgeCopy(current.copy, current.markers, item.index), "已永久刪除這筆驗收資料。");
}

function editor(body, item) {
    const { row, index, candidates } = item;
    const note = element("textarea");
    note.name = "notes";
    note.rows = 2;
    note.value = row.notes ?? row.note ?? "";
    const progress = element("input");
    progress.name = "progress";
    progress.type = "number";
    progress.inputMode = "numeric";
    progress.min = 0;
    progress.value = V.getNormalAnimeProgress(row).current;
    const saveDetails = element("button", "儲存進度與筆記");
    saveDetails.type = "button";
    saveDetails.dataset.action = "save";
    saveDetails.onclick = () => save(current => preview.changeCopy(current, index, "save",
        { notes:note.value, progress:progress.value }, new Date().toISOString()), "測試副本已儲存。");
    const membership = element("select");
    membership.name = "membership";
    membership.add(new Option("依資料自動分組", "auto"));
    membership.add(new Option("單獨顯示", "separate"));
    const suggested = new Set(candidates);
    const others = result.items.filter(option => option.canEdit && option.index !== index);
    others.sort((a, b) => Number(suggested.has(b.index)) - Number(suggested.has(a.index)));
    for (const option of others) {
        const { row:other } = option;
        const tags = [other.startDate?.year || other.year, other.format, categoryLabels[other.category]].filter(Boolean);
        const label = (suggested.has(option.index) ? "建議 · " : "") + originalTitle(other)
            + (tags.length ? " · " + tags.join("／") : "") + " · #" + other.id;
        membership.add(new Option(label, "link:" + option.index));
    }
    const link = others.find(option => String(option.row.id) === row.seriesMembership?.anchor);
    if (row.seriesMembership?.mode === "separate") membership.value = "separate";
    if (row.seriesMembership?.mode === "link" && link) membership.value = "link:" + link.index;
    const saveMembership = element("button", "確認系列歸屬");
    saveMembership.type = "button";
    saveMembership.dataset.action = "membership";
    saveMembership.onclick = () => save(current => preview.changeCopy(current, index, "membership",
        { membership:membership.value }, new Date().toISOString()), "系列歸屬已儲存在測試副本。");
    const fields = element("fieldset");
    fields.append(element("legend","測試副本操作"), labeled("觀看集數",progress), labeled("筆記",note),
        saveDetails, labeled("系列歸屬",membership), saveMembership);
    body.append(fields);
}

function renderItem(item, expanded) {
    const { row, index, warnings, identityRecovered } = item;
    const details = element("details", "", "row");
    details.dataset.rowIndex = index;
    const label = element("summary", originalTitle(row));
    const body = element("div", "", "row-body");
    const progress = V.getNormalAnimeProgress(row);
    const category = categoryLabels[row.category] || row.category || "未分類";
    const year = row.startDate?.year || row.year || "";
    body.append(element("p", [year, row.format, category, V.isAnimeCurrentlyWatching(row) ? "正在看" : ""].filter(Boolean).join(" · "),"muted"),
        element("p", `ID ${row.id ?? "缺漏"} · 進度 ${progress.current}／${progress.total ?? "未知"} · 評分 ${row.rating ?? "未填"} · 收藏 ${row.favorite ?? "未填"}`),
        element("p", `筆記 ${row.notes ?? row.note ?? "未填"}`));
    if (identityRecovered) body.append(element("p","使用備份內的作品關聯作為系列佐證。","muted"));
    if (warnings.length) body.append(element("p",warnings.join("。"),"warning"));
    if (item.metadataWarnings.length) body.append(element("p","作品資料核對 · " + item.metadataWarnings.join("。"),"muted"));
    if (item.result === "conflict" && result.groups.get(item.key)?.length > 1) {
        const peers = result.groups.get(item.key).filter(position => position !== index)
            .map(position => originalTitle(result.items[position].row));
        body.append(element("p","目前同組作品 · " + peers.join("、"),"warning"));
    }
    const renderEditor = () => { if (item.canEdit) editor(body,item); };
    if (expanded.has(String(index))) { details.open = true; renderEditor(); }
    else details.addEventListener("toggle", () => { if (details.open) renderEditor(); }, { once:true });
    if (item.result === "deleted" && purge.canPurge(copy, index)) {
        const erase = element("button", "永久刪除這筆驗收副本", "danger");
        erase.type = "button";
        erase.dataset.action = "purge-copy";
        erase.onclick = () => permanentDelete(item);
        body.append(erase);
    }
    details.append(label,body);
    return details;
}

function memberLabel(item) {
    const { row, id, aniListIds } = item;
    return [originalTitle(row), row.startDate?.year || row.year, row.format,
        id ? "作品 ID " + id : "作品 ID 缺漏", aniListIds.length ? "AniList ID " + aniListIds.join("、") : ""]
        .filter(Boolean).join(" · ");
}

const evidenceStatus = { wrong:"確定錯誤", insufficient:"證據不足", confirmed:"已確認正確" };
const relationLabels = {
    PREQUEL:"前作", SEQUEL:"續作", SIDE_STORY:"番外或補篇", PARENT:"本篇",
    ALTERNATIVE:"不同改編版本", CONTINUATION_ROOT:"同一前後作鏈"
};
const seasonLabels = { WINTER:"冬季", SPRING:"春季", SUMMER:"夏季", FALL:"秋季" };

function appendRecordEvidence(node, item) {
    const evidence = item.evidence;
    if (!evidence?.id) {
        node.append(element("p", "現有紀錄尚無足夠證據核實 AniList 身分。", "muted"));
        return;
    }
    const metadata = [`核實 AniList ID ${evidence.id}`,
        evidence.year ? `${evidence.yearVerified ? "AniList 首播" : "備份年份"} ${evidence.year} 年` : "",
        seasonLabels[evidence.season] || evidence.season, evidence.part,
        evidence.format ? `${evidence.formatVerified ? "AniList 形式" : "備份形式"} ${evidence.format}` : ""].filter(Boolean);
    node.append(element("p", metadata.join(" · ")));
    const relations = (evidence.via || []).map(({ id, type, incoming }) =>
        `${relationLabels[type] || type} (${type}) · ${incoming ? "AniList ID " + id + " 指向本作" : "AniList ID " + id}`);
    if (relations.length) node.append(element("p", "關係 · " + relations.join("、"), "muted"));
    else node.append(element("p", "作品身分已核實，這筆紀錄未提供可用的系列關係。", "muted"));
    const year = Number(item.row.startDate?.year || item.row.year);
    const format = String(item.row.format || "").trim().toUpperCase();
    const warnings = [...item.metadataWarnings];
    if (evidence.yearVerified && year && year !== Number(evidence.year)) warnings.push("備份年份與 AniList 首播年份不同。");
    if (evidence.formatVerified && format && format !== evidence.format) warnings.push("備份形式與 AniList 形式不同。");
    for (const warning of warnings) node.append(element("p", warning, "warning"));
}

function renderMembershipSide(title, parts, side) {
    const column = element("div", "", "comparison-side");
    column.dataset.side = side;
    column.append(element("h3", title));
    for (const part of parts) {
        const group = element("div", "", "comparison-part");
        group.append(element("strong", part.label || "未命名系列"));
        const list = element("ul");
        for (const index of part.members) list.append(element("li", memberLabel(result.items[index])));
        group.append(list);
        column.append(group);
    }
    return column;
}

function renderReviewChanges(visible, expanded) {
    const { reviewChanges:changes } = result.comparison;
    const section = element("details", "", "report-section");
    section.dataset.comparison = "review-changes";
    section.open = expanded.has("review-changes");
    section.append(element("summary", `人工確認差異（前次 ${changes.before} 筆，這次 ${changes.after} 筆）`),
        element("p", "兩次結果皆使用目前這份備份重算，前次為 PR #9 的 legacy-series-5。", "muted"));
    const outcomes = [["resolved", "已解除"], ["remaining", "仍需確認"], ["added", "新增需確認"]];
    for (const [key, label] of outcomes) {
        const group = element("div");
        group.dataset.reviewOutcome = key;
        group.append(element("h3", `${label}（${changes[key].length}）`));
        const list = element("ul", "", "comparison-records");
        for (const entry of changes[key].filter(entry => visible(result.items[entry.index]))) {
            const item = element("li");
            item.dataset.evidenceStatus = entry.status;
            const record = result.items[entry.index];
            item.append(element("strong", memberLabel(record)),
                element("p", evidenceStatus[entry.status]),
                element("p", "前次原因 · " + (entry.before.join("。") || "無")),
                element("p", "這次原因 · " + (entry.after.join("。") || "無")));
            if (entry.beforeIds.join() !== entry.afterIds.join()) {
                item.append(element("p", `前次 AniList ID ${entry.beforeIds.join("、") || "無"} · 這次 AniList ID ${entry.afterIds.join("、") || "無"}`));
            }
            if (record.evidence) appendRecordEvidence(item, record);
            list.append(item);
        }
        group.append(list.childElementCount ? list : element("p", "沒有符合的紀錄。", "muted"));
        section.append(group);
    }
    comparisonResults.append(section);
}

function renderGroupingEvidence(visible, expanded) {
    const sections = [["wrong", "merge-error"], ["insufficient", "merge"], ["confirmed", "merge-confirmed"]];
    for (const [status, key] of sections) {
        const entries = result.comparison.groupingEvidence.filter(entry => entry.status === status);
        const section = element("details", "", "report-section");
        section.dataset.comparison = key;
        section.open = expanded.has(key);
        section.append(element("summary", `分組證據 · ${evidenceStatus[status]}（${entries.length}）`));
        const matching = entries.filter(entry => entry.members.some(index => visible(result.items[index])));
        if (!matching.length) section.append(element("p", "沒有符合的紀錄。", "muted"));
        for (const entry of matching) {
            const card = element("details", "", "group");
            card.append(element("summary", `${entry.label || "未命名系列"}（${entry.members.length} 部）`),
                element("p", entry.reasons.join("。"), "muted"));
            const records = element("ul", "", "comparison-records");
            for (const index of entry.members) {
                const row = result.items[index];
                const record = element("li");
                record.append(element("strong", memberLabel(row)));
                appendRecordEvidence(record, row);
                records.append(record);
            }
            card.append(records);
            section.append(card);
        }
        comparisonResults.append(section);
    }
}

function renderComparison(visible) {
    const { oldGroups, restored, split, review, chainComplete, chainSplits, chainPending, unresolved, provenance } = result.comparison;
    document.getElementById("comparison-limitations").textContent = provenance.warning;
    const expanded = new Set([...comparisonResults.querySelectorAll("[data-comparison][open]")]
        .map(section => section.dataset.comparison));
    comparisonResults.replaceChildren();
    renderReviewChanges(visible, expanded);
    renderGroupingEvidence(visible, expanded);
    const sections = [
        ["chain-complete", "備份中的完整 AniList 前後作鏈", chainComplete],
        ["chain-split", "被拆開的 AniList 前後作鏈", chainSplits],
        ["chain-pending", "前後作鏈中有待核對的身分", chainPending],
        ["unresolved", "尚未解決的作品 ID 與原因", unresolved],
        ["restored", "新版恢復或保留的系列", restored],
        ["split", "舊版重算曾同組，新版分到不同組", split],
        ["manual", "需要人工確認的作品", review],
        ["old", "poster-fix-4 依這份備份重算的系列", oldGroups]
    ];
    for (const [key, heading, entries] of sections) {
        const section = element("details", "", "report-section");
        section.dataset.comparison = key;
        section.open = expanded.has(key);
        section.append(element("summary", `${heading}（${entries.length}）`));
        const reasonsOnly = key === "manual" || key === "unresolved";
        const matching = entries.filter(entry => (reasonsOnly ? [entry.index] : [...entry.members, ...(entry.unconfirmed || [])])
            .some(index => visible(result.items[index])));
        if (!matching.length) section.append(element("p", "沒有符合的紀錄。", "muted"));
        const recordList = reasonsOnly ? element("ul", "", "comparison-records") : null;
        for (const entry of matching) {
            if (reasonsOnly) {
                const item = element("li");
                item.append(element("strong", memberLabel(result.items[entry.index])),
                    element("p", entry.reasons.join("。")));
                recordList.append(item);
                continue;
            }
            const container = element("details", "", "group");
            container.append(element("summary", (entry.label || "未命名系列") + `（${entry.members.length} 部）`));
            if (entry.mediaIds?.length) {
                container.append(element("p", "AniList 關聯圖 ID " + entry.mediaIds.join("、"), "muted"));
            }
            if (entry.unconfirmed?.length) {
                const unknown = element("ul");
                for (const index of entry.unconfirmed) unknown.append(element("li", memberLabel(result.items[index])));
                container.append(element("p", "身分待核對"), unknown);
            }
            const membership = element("div", "", "comparison-membership");
            membership.append(renderMembershipSide("poster-fix-4 重算", entry.oldParts, "poster-fix-4"),
                renderMembershipSide("新版", entry.newParts, "updated"));
            container.append(membership);
            section.append(container);
        }
        if (recordList?.childElementCount) section.append(recordList);
        comparisonResults.append(section);
    }
}

function renderDeletedDiagnostics() {
    deletedRecords.replaceChildren();
    const records = result?.items.filter(item => item.result === "deleted") ?? [];
    deletedDiagnostics.hidden = !records.length || Boolean(search.value.trim());
    if (deletedDiagnostics.hidden) { deletedDiagnostics.open = false; return; }
    deletedCount.textContent = `刪除標記診斷（${records.length}）`;
    if (!deletedDiagnostics.open) return;
    deletedRecords.append(element("p", "這些標記用於辨識備份中已刪除的作品。永久刪除只處理這個瀏覽器內的驗收副本。", "muted"));
    const expanded = new Set();
    for (const item of records) deletedRecords.append(renderItem(item, expanded));
}

function render() {
    const expanded = new Set([...report.querySelectorAll("[data-row-index][open]")].map(node => node.dataset.rowIndex));
    report.replaceChildren();
    document.getElementById("search-tools").hidden = !result;
    comparison.hidden = !result;
    renderDeletedDiagnostics();
    if (!result) comparisonResults.replaceChildren();
    clear.disabled = !copy || busy;
    if (!result) { summary.textContent = "尚未匯入任何作品。"; return; }
    const { records, history } = copy.original;
    const counts = Object.fromEntries(Object.keys(resultLabels).map(key => [key,0]));
    for (const item of result.items) if (item.result !== "deleted") counts[item.result]++;
    const { suggestions, needsReview, metadata } = result.stats;
    const { chainComplete, chainSplits, chainPending } = result.comparison;
    summary.textContent = `已匯入 ${records.length} 筆作品、${history.length} 筆觀看歷史。已核對完整前後作鏈 ${chainComplete.length} 組、仍有拆組 ${chainSplits.length} 組。可選建議 ${suggestions} 筆、需要人工處理 ${needsReview} 筆。另有 ${metadata} 筆作品資料可核對。`;
    const needle = V.normalizeText(V.toTraditionalChinese(search.value));
    const visible = item => !needle || V.normalizeText(V.toTraditionalChinese([
        item.label, item.row.title, item.row.id, item.row.groupTitle, item.row.canonicalTitle,
        ...item.aniListIds,
        ...[].concat(item.row.aliases || []), ...[].concat(V.getVerifiedAnimeSeriesMetadata(result.projected[item.index])?.aliases || [])
    ].join(" "))).includes(needle);
    renderComparison(visible);
    const completeKeys = new Set(chainComplete.flatMap(group => group.newKeys));
    const splitKeys = new Set(chainSplits.flatMap(group => group.newKeys));
    const pendingKeys = new Set(chainPending.flatMap(group => group.newKeys));
    const numberOfGroups = new Set(result.items.filter(item => item.result === "grouped").map(item => item.key)).size;
    for (const [key, heading] of Object.entries(resultLabels)) {
        const section = element("details","","report-section");
        section.dataset.result = key;
        section.open = true;
        const entries = result.items.filter(item => item.result === key && visible(item));
        section.append(element("summary", key === "grouped"
            ? `${heading}（${numberOfGroups} 組、${counts[key]} 部）` : `${heading}（${counts[key]}）`));
        if (key === "grouped") {
            const groups = new Map();
            for (const item of entries) {
                if (!groups.has(item.key)) groups.set(item.key, []);
                groups.get(item.key).push(item);
            }
            for (const group of groups.values()) {
                group.sort((a,b) => V.compareAnimeSeriesRelease(result.projected[a.index],result.projected[b.index]));
                const container = element("div","","group");
                const key = group[0].key;
                const label = group.find(item => item.label)?.label || originalTitle(group[0].row);
                const evidence = splitKeys.has(key) ? "前後作鏈跨組"
                    : pendingKeys.has(key) ? "前後作鏈有身分待核對"
                    : completeKeys.has(key) ? "已核對備份中的前後作"
                    : "依本機資料分組，前後作完整性待核對";
                container.append(element("strong",`${label}（${result.groups.get(key).length} 部）`), element("p", evidence, "muted"));
                container.append(...group.map(item => renderItem(item,expanded)));
                section.append(container);
            }
        } else section.append(...entries.map(item => renderItem(item,expanded)));
        if (!entries.length) section.append(element("p","沒有符合的紀錄。","muted"));
        report.append(section);
    }
    const metadataSection = element("details","","report-section");
    metadataSection.dataset.result = "metadata";
    metadataSection.append(element("summary", `作品資料核對（${metadata}）`));
    for (const item of result.items.filter(item => item.result !== "deleted" && item.metadataWarnings.length && visible(item))) {
        metadataSection.append(element("p",originalTitle(item.row) + " · " + item.metadataWarnings.join("。")));
    }
    report.append(metadataSection);
}

picker.addEventListener("change", async () => {
    const file = picker.files[0];
    picker.value = "";
    if (!file || busy) return;
    if (copy && !confirm("要以剛選取的檔案取代這個網站的測試副本嗎？")) return;
    busy = picker.disabled = clear.disabled = true;
    try {
        const original = preview.readBackup(await file.text());
        preview.reportSeries({ original, edits:{} });
        busy = false;
        search.value = "";
        deletedDiagnostics.open = false;
        await save((_copy, markers) => purge.applyMarkers({ original, edits:{} }, markers), "匯入完成。請核對系列驗收報告。");
    } catch {
        status.textContent = "無法讀取這份 Anime Tracker JSON 備份，已保留現有測試副本。";
        busy = picker.disabled = false;
        clear.disabled = !copy;
    }
});
clear.addEventListener("click", () => {
    if (confirm("要清除這個網站的測試副本和測試編輯嗎？防止再次匯入已永久刪除作品的精簡標記會保留。")) {
        void save(() => null,"已清除測試副本。");
    }
});
deletedDiagnostics.addEventListener("toggle", renderDeletedDiagnostics);
search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
});

async function start() {
    try {
        const existing = await navigator.serviceWorker.getRegistration("/");
        if (!existing) await navigator.serviceWorker.register("/sw.js", { updateViaCache:"none" });
        else if (navigator.onLine) void existing.update().catch(() => {});
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
            await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once:true }));
        }
        offline.textContent = "離線資源已就緒。可在飛航模式下匯入或重新開啟此頁。";
        db = await openDatabase();
        setCopy((await transaction()).copy);
        picker.disabled = false;
    } catch {
        offline.textContent = "離線資源或本機儲存無法使用。請在一般 Safari 分頁重新開啟。";
    }
}
void start();
