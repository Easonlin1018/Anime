"use strict";

const V = window.AnimeTrackerV11;
const preview = window.PrivateSeriesPreview;
const picker = document.getElementById("backup-file");
const clear = document.getElementById("clear-copy");
const status = document.getElementById("status");
const summary = document.getElementById("summary");
const offline = document.getElementById("offline");
const search = document.getElementById("search");
const report = document.getElementById("report");
const resultLabels = {
    grouped:"成功分組", independent:"維持獨立", review:"需要人工確認",
    conflict:"可能的錯誤分組或身分衝突", deleted:"備份中的已刪除紀錄"
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
        const request = store.get("active");
        let next, failure;
        request.onsuccess = () => {
            try {
                next = request.result || null;
                if (!update) return;
                next = update(next);
                if (next) store.put(next, "active");
                else store.delete("active");
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

async function save(operation, message) {
    if (busy) return;
    busy = picker.disabled = clear.disabled = true;
    try {
        const expected = copy?.revision;
        const next = await transaction(current => {
            if (current?.revision !== expected) throw new Error("測試副本已在另一個分頁變更，請重新整理後再試。");
            const value = operation(current);
            return value ? { ...value, revision:crypto.randomUUID() } : null;
        });
        setCopy(next);
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
    if (item.result === "conflict" && result.groups.get(item.key)?.length > 1) {
        const peers = result.groups.get(item.key).filter(position => position !== index)
            .map(position => originalTitle(result.items[position].row));
        body.append(element("p","目前同組作品 · " + peers.join("、"),"warning"));
    }
    const renderEditor = () => { if (item.canEdit) editor(body,item); };
    if (expanded.has(String(index))) { details.open = true; renderEditor(); }
    else details.addEventListener("toggle", () => { if (details.open) renderEditor(); }, { once:true });
    details.append(label,body);
    return details;
}

function render() {
    const expanded = new Set([...report.querySelectorAll("[data-row-index][open]")].map(node => node.dataset.rowIndex));
    report.replaceChildren();
    document.getElementById("search-tools").hidden = !result;
    clear.disabled = !copy || busy;
    if (!result) { summary.textContent = "尚未匯入任何作品。"; return; }
    const { records, history } = copy.original;
    const counts = Object.fromEntries(Object.keys(resultLabels).map(key => [key,0]));
    for (const item of result.items) counts[item.result]++;
    const grouped = [...result.groups.values()].filter(indexes => indexes.length > 1).length;
    summary.textContent = `已匯入 ${records.length} 筆作品、${history.length} 筆觀看歷史。副本保留 ${result.items.length} 筆作品及原始 ID。找到 ${grouped} 個系列。`;
    const needle = V.normalizeText(V.toTraditionalChinese(search.value));
    const visible = item => !needle || V.normalizeText(V.toTraditionalChinese([
        item.label, item.row.title, item.row.id, item.row.groupTitle, item.row.canonicalTitle,
        ...[].concat(item.row.aliases || []), ...[].concat(V.getVerifiedAnimeSeriesMetadata(result.projected[item.index])?.aliases || [])
    ].join(" "))).includes(needle);
    for (const [key, heading] of Object.entries(resultLabels)) {
        const section = element("details","","report-section");
        section.dataset.result = key;
        section.open = key !== "deleted";
        const entries = result.items.filter(item => item.result === key && visible(item));
        section.append(element("summary", `${heading}（${counts[key]}）`));
        if (key === "grouped") {
            const groups = new Map();
            for (const item of entries) {
                if (!groups.has(item.key)) groups.set(item.key, []);
                groups.get(item.key).push(item);
            }
            for (const group of groups.values()) {
                group.sort((a,b) => V.compareAnimeSeriesRelease(result.projected[a.index],result.projected[b.index]));
                const container = element("div","","group");
                container.append(element("strong",`${group.find(item => item.label)?.label || originalTitle(group[0].row)}（${result.groups.get(group[0].key).length} 部）`));
                container.append(...group.map(item => renderItem(item,expanded)));
                section.append(container);
            }
        } else section.append(...entries.map(item => renderItem(item,expanded)));
        if (!entries.length) section.append(element("p","沒有符合的紀錄。","muted"));
        report.append(section);
    }
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
        await save(() => ({ original, edits:{} }), "匯入完成。請核對系列驗收報告。");
    } catch {
        status.textContent = "無法讀取這份 Anime Tracker JSON 備份，已保留現有測試副本。";
        busy = picker.disabled = false;
        clear.disabled = !copy;
    }
});
clear.addEventListener("click", () => {
    if (confirm("要清除這個網站的測試副本和測試編輯嗎？")) void save(() => null,"已清除測試副本。");
});
search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
});

async function start() {
    try {
        if (!(await navigator.serviceWorker.getRegistration("/"))) {
            await navigator.serviceWorker.register("/sw.js", { updateViaCache:"none" });
        }
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
            await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once:true }));
        }
        offline.textContent = "離線資源已就緒。可在飛航模式下匯入或重新開啟此頁。";
        db = await openDatabase();
        setCopy(await transaction());
        picker.disabled = false;
    } catch {
        offline.textContent = "離線資源或本機儲存無法使用。請在一般 Safari 分頁重新開啟。";
    }
}
void start();
