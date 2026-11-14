(function (root, factory) {
    const api = factory(typeof module === "object" && module.exports
        ? require("../../releases/legacy-series-2/v11-core.js") : root.AnimeTrackerV11);
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.PrivateSeriesPreview = api;
})(globalThis, function (V) {
    "use strict";

    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" || typeof value === "number" ? String(value) : "";

    function readBackup(raw) {
        const value = JSON.parse(raw.replace(/^\uFEFF/u, ""));
        if (!Array.isArray(value) && (!object(value) || !own(value, V.STORAGE_KEY))) {
            throw new Error("找不到 Anime Tracker 的動畫清單。");
        }
        const list = Array.isArray(value) ? value : value[V.STORAGE_KEY];
        const records = typeof list === "string" ? JSON.parse(list) : list;
        if (!Array.isArray(records) || records.some(item => !object(item))) {
            throw new Error("動畫紀錄格式不完整，請選取原始 JSON 備份。");
        }
        const history = Array.isArray(value) ? [] : value.watchHistory ?? value[V.HISTORY_KEY] ?? [];
        if (!Array.isArray(history) || history.some(entry => !object(entry))) {
            throw new Error("觀看歷史格式不完整，原副本已保留。");
        }
        return { records, history, works:Array.isArray(value.works) ? value.works : [],
            mediaEntries:Array.isArray(value.mediaEntries) ? value.mediaEntries : [] };
    }

    function verificationRows(copy) {
        return copy.original.records.map((row, index) => ({ ...row, ...copy.edits[index] }));
    }

    function reportSeries(copy) {
        const rows = verificationRows(copy);
        const { list } = V.recoverLegacyAnimeIdentities(rows, copy.original);
        const { projected, reviewByIndex } = V.describeAnimeSeriesProjection(list);
        const local = new Map(), claims = new Map(), suggestions = new Map(), groups = new Map();
        const add = (map, key, index) => {
            if (!key) return;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(index);
        };
        const deleted = row => Boolean(row.deletedAt || row.category === "_deleted");
        const normalized = value => V.normalizeText(V.toTraditionalChinese(text(value)));
        const nameKeys = row => [...new Set([
            row.groupTitle, row.seriesGroupTitle, row.title, row.canonicalTitle,
            ...(Array.isArray(row.aliases) ? row.aliases : [row.aliases]),
            text(row.title).replace(/\s*[（(]\s*(?:19|20)\d{2}\s*[）)]\s*$/u, "")
                .replace(/\s*(?:第\s*[一二三四五六七八九十\d]+[季期]|Season\s*\d+|Part\s*\d+|[（(]劇場版[）)])\s*$/iu, "")
        ].map(normalized).filter(Boolean))];
        rows.forEach((row, index) => {
            add(local, text(row.id), index);
            for (const id of V.getAnimeAniListClaims(list[index])) add(claims,id,index);
            if (deleted(row)) return;
            add(groups, V.getAnimeSeriesKey(projected[index]), index);
            for (const name of nameKeys(row)) add(suggestions, name, index);
        });
        const items = rows.map((row, index) => {
            const id = text(row.id);
            const peers = groups.get(V.getAnimeSeriesKey(projected[index])) || [];
            const candidates = [...new Set(nameKeys(row).flatMap(key => suggestions.get(key) || []))]
                .filter(other => other !== index && !peers.includes(other));
            const providerFields = [row.anilistId, row.aniListId, row.sourceId].filter(value => value != null && value !== "");
            const sources = [row.source, row.dataSource].map(value => text(value).trim().toLowerCase()).filter(Boolean);
            const ids = new Set(providerFields.map(V.normalizeAniListMediaId));
            const warnings = [];
            if (!id || local.get(id).length !== 1) warnings.push("本機 ID 缺漏或重複");
            if (ids.size > 1 || ids.has("") || (providerFields.length && sources.some(source => source !== "anilist"))) {
                warnings.push("來源或作品 ID 有矛盾");
            }
            if (V.getAnimeAniListClaims(list[index]).some(claim => claims.get(claim)?.length > 1)) warnings.push("多筆紀錄使用同一 AniList ID");
            const metadata = V.getAnimeSeriesMetadataReview(list[index]);
            const metadataWarnings = [
                metadata?.titleConflict && !metadata.manualTitle ? "作品名稱與已存 AniList 資料不一致" : "",
                metadata?.dateConflict ? "首播日期與已存 AniList 資料不一致" : "",
                metadata?.formatConflict ? "作品形式與已存 AniList 資料不一致" : ""
            ].filter(Boolean);
            if (peers.some(other => other !== index && normalized(rows[other].title) === normalized(row.title))) {
                warnings.push("同一群組內有同名作品");
            }
            const conflict = warnings.length > 0;
            const manual = row.seriesMembership?.mode === "separate" || row.seriesMembership?.mode === "link";
            const actionable = !manual && reviewByIndex.has(index);
            if (actionable) warnings.push(...reviewByIndex.get(index));
            const optional = !manual && peers.length < 2 && candidates.length > 0;
            if (peers.length > 1 && projected[index].seriesKeySource === "legacy-group") warnings.push("依舊系列欄位與作品資料復原");
            const result = deleted(row) ? "deleted" : conflict ? "conflict" : peers.length > 1 ? "grouped"
                : actionable ? "review" : optional ? "suggestion" : "independent";
            return { index, row, result, warnings, metadataWarnings, candidates, actionable,
                canEdit:!deleted(row) && Boolean(id && local.get(id).length === 1),
                key:V.getAnimeSeriesKey(projected[index]), label:V.getAnimeSeriesDisplayLabel(projected[index]),
                identityRecovered:!V.getConfirmedAnimeAniListId(row) && Boolean(V.getConfirmedAnimeAniListId(list[index])) };
        });
        const automatic = new Map();
        for (const item of items) {
            if (item.result === "grouped" && item.row.seriesMembership?.mode !== "link") {
                automatic.set(item.key, (automatic.get(item.key) || 0) + 1);
            }
        }
        return { items, groups, projected, stats:{
            automatic:[...automatic.values()].filter(count => count > 1).length,
            suggestions:items.filter(item => item.result === "suggestion").length,
            needsReview:items.filter(item => item.result !== "deleted" && (item.result === "conflict" || item.actionable)).length,
            metadata:items.filter(item => item.result !== "deleted" && item.metadataWarnings.length).length
        } };
    }

    function changeCopy(copy, index, action, values, now) {
        const rows = verificationRows(copy);
        const row = rows[index];
        if (!row || row.deletedAt || row.category === "_deleted" || !text(row.id)
            || rows.filter(candidate => text(candidate.id) === text(row.id)).length !== 1) {
            throw new Error("這筆紀錄的 ID 無法唯一確認，請先核對。");
        }
        let change;
        if (action === "save") {
            const notes = String(values.notes);
            const progress = values.progress === "" ? null : Number(values.progress);
            if (progress !== null && (!Number.isSafeInteger(progress) || progress < 0)) {
                throw new Error("請輸入有效的非負整數集數。");
            }
            change = {};
            const before = V.getNormalAnimeProgress(row).current;
            if (notes !== text(row.notes ?? row.note)) change.notes = notes;
            if (progress !== null && progress !== before) {
                change.watched = progress;
                change.currentEpisode = progress;
            }
        } else if (action === "membership") {
            const { membership } = values;
            const anchor = /^link:(\d+)$/u.exec(membership);
            const target = anchor && rows[Number(anchor[1])];
            if (membership !== "auto" && membership !== "separate" && !text(target?.id)) {
                throw new Error("請重新選擇要連結的作品。");
            }
            const setting = V.prepareAnimeSeriesMembership(rows, row.id,
                target ? text(target.id) : membership === "separate" ? null : "", now);
            if (!setting) throw new Error("系列連結有循環、目標已刪除或 ID 重複。");
            change = { seriesMembership:setting };
        } else throw new Error("不支援的操作。");
        return { ...copy, edits:{ ...copy.edits, [index]:{ ...copy.edits[index], ...change } } };
    }

    return { readBackup, reportSeries, verificationRows, changeCopy };
});
