(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(require("../../releases/legacy-series-6/v11-core.js"));
    } else {
        root.PrivateSeriesPurge = factory(root.AnimeTrackerV11);
    }
})(globalThis, function (V) {
    "use strict";

    const localId = value => (typeof value === "number" && Number.isFinite(value))
        || (typeof value === "string" && value.trim()) ? String(value) : "";
    const isDeleted = row => Boolean(row?.deletedAt || row?.category === "_deleted");
    const created = row => Date.parse(row.createdAt) || Date.parse(row.addedAt) || null;

    function canPurge(copy, index) {
        const records = copy?.original?.records;
        const row = records?.[index];
        const id = localId(row?.id);
        return Boolean(id && isDeleted(row) && records.filter(item => localId(item?.id) === id).length === 1);
    }

    function applyMarkers(copy, markers) {
        if (!copy || !markers.length) return copy;
        const { original } = copy;
        const byId = new Map(markers.map(marker => [marker.id, marker]));
        const matching = new Set();
        for (const row of original.records) {
            const id = localId(row.id);
            const marker = byId.get(id);
            if (!marker) continue;
            const providerId = V.getConfirmedAnimeAniListId(row);
            const timestamp = created(row);
            if (matching.has(id) || (marker.providerId && providerId && marker.providerId !== providerId)
                || (!marker.providerId && marker.created && timestamp && marker.created !== timestamp)) {
                throw new Error("備份含有重複或不同作品共用的本機 ID " + id + "。保留目前副本，請核對備份。");
            }
            matching.add(id);
        }

        const removes = id => byId.has(localId(id));
        const unlink = row => {
            if (row?.seriesMembership?.mode !== "link" || !removes(row.seriesMembership.anchor)) return row;
            const { seriesMembership, ...rest } = row;
            return rest;
        };
        const filter = (values, keep) => {
            const remaining = values.filter(keep);
            return remaining.length === values.length ? values : remaining;
        };
        const keepEntry = entry => entry?.mediaType !== "anime" || !removes(entry.id);
        const history = filter(original.history, entry => !removes(entry?.animeId));
        const mediaEntries = filter(original.mediaEntries, keepEntry);
        const works = original.works.flatMap(work => {
            if (!Array.isArray(work?.mediaEntries)) return [work];
            const entries = filter(work.mediaEntries, keepEntry);
            if (entries === work.mediaEntries) return [work];
            return entries.length ? [{ ...work, mediaEntries:entries }] : [];
        });

        const records = [], edits = {};
        let changed = history !== original.history || mediaEntries !== original.mediaEntries
            || works.length !== original.works.length || works.some((work, index) => work !== original.works[index]);
        for (const [index, row] of original.records.entries()) {
            if (removes(row.id)) { changed = true; continue; }
            const record = unlink(row);
            const edit = copy.edits[index];
            if (edit) {
                edits[records.length] = unlink(edit);
                if (edits[records.length] !== edit) changed = true;
            }
            if (record !== row) changed = true;
            records.push(record);
        }
        return changed ? { ...copy, original:{ ...original, records, history, works, mediaEntries }, edits } : copy;
    }

    function purgeCopy(copy, markers, index) {
        if (!canPurge(copy, index)) throw new Error("可永久刪除的紀錄必須已刪除且有唯一的本機 ID。");
        const row = copy.original.records[index];
        const providerId = V.getConfirmedAnimeAniListId(row);
        const next = [...markers, { id:localId(row.id), providerId, created:providerId ? null : created(row) }];
        return { copy:applyMarkers(copy, next), markers:next };
    }

    return { canPurge, applyMarkers, purgeCopy };
});
