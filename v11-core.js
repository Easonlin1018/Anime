(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.AnimeTrackerV11 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SCHEMA_VERSION = 11;
    const STORAGE_KEY = "anime_list_v8_8";
    const HISTORY_KEY = "anime_tracker_watch_history_v1";
    const WATCH_RESET_UNDO_KEY = "anime_tracker_watch_history_reset_undo_v1";
    const RESTORE_KEY = "anime_tracker_restore_points_v1";
    const SETTINGS_KEY = "anime_tracker_settings_v11";
    const WORKS_KEY = "anime_tracker_works_v1";
    const MANGA_HISTORY_KEY = "manga_read_history_v1";
    const TOMBSTONE_DAYS = 30;

    const iso = value => {
        const date = value ? new Date(value) : new Date();
        return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    };
    const numberOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const arrayOf = value => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
    const uuid = () => globalThis.crypto?.randomUUID?.() || `anime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const normalizeText = value => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
    const stableHash = value => { let hash = 2166136261; for (const char of String(value)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); };
    let traditionalChineseConverter = null;

    function getOpenCC() {
        if (globalThis.OpenCC?.Converter) return globalThis.OpenCC;
        if (typeof require === "function") {
            try { return require("./vendor/opencc-js-1.4.1-full.js"); }
            catch { return null; }
        }
        return null;
    }

    function toTraditionalChinese(value) {
        const text = String(value ?? "");
        if (!text) return text;
        if (!traditionalChineseConverter) {
            const opencc = getOpenCC();
            traditionalChineseConverter = opencc?.Converter
                ? opencc.Converter({ from:"cn", to:"tw" })
                : input => String(input ?? "");
        }
        try { return traditionalChineseConverter(text); }
        catch { return text; }
    }

    function hasManualAnimeTitle(item) {
        return item?.titleManuallyEdited === true || item?.titleSource === "manual" || item?.manualTitle === true;
    }

    function hasChineseTitleContext(value) {
        const text = String(value || "");
        return /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
    }

    function localizedStoredTitle(value, manual = false) {
        const text = String(value || "");
        return !manual && hasChineseTitleContext(text) ? toTraditionalChinese(text) : text;
    }

    function localizedAliasList(values) {
        const aliases = [];
        const seen = new Set();
        arrayOf(values).flat(Infinity).forEach(value => {
            const text = String(value || "").trim();
            if (!text) return;
            [text, hasChineseTitleContext(text) ? toTraditionalChinese(text) : ""].filter(Boolean).forEach(alias => {
                const key = alias.normalize("NFKC").toLocaleLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                aliases.push(alias);
            });
        });
        return aliases;
    }

    function animeRelationEdges(item) {
        if (Array.isArray(item?.relations)) return item.relations;
        if (Array.isArray(item?.relations?.edges)) return item.relations.edges;
        return [];
    }

    function animeRelationNode(edge) {
        return edge?.node || edge?.media || edge?.entry || {};
    }

    function explicitRelationNodeId(edge) {
        const node = animeRelationNode(edge);
        const values = [node?.anilistId, node?.aniListId, node?.id];
        if (String(node?.source || node?.dataSource || "").toLowerCase() === "anilist") values.push(node?.sourceId);
        for (const value of values) {
            const numeric = Number(value);
            if (Number.isSafeInteger(numeric) && numeric > 0) return String(numeric);
        }
        return "";
    }

    const ANIME_SERIES_TRAVERSAL_RELATIONS = new Set(["PREQUEL", "SEQUEL", "PARENT", "ALTERNATIVE"]);
    const ANIME_SERIES_COLLECT_ONLY_RELATIONS = new Set(["SIDE_STORY"]);

    function animeSeriesRelationMode(edge) {
        const relationType = String(edge?.relationType || edge?.relation_type || edge?.relation || "").toUpperCase();
        if (ANIME_SERIES_TRAVERSAL_RELATIONS.has(relationType)) return "traverse";
        if (ANIME_SERIES_COLLECT_ONLY_RELATIONS.has(relationType)) return "collect-only";
        return "exclude";
    }

    function isSafeAnimeSeriesRelation(edge) {
        if (animeSeriesRelationMode(edge) === "exclude") return false;
        const format = String(animeRelationNode(edge)?.format || "").toUpperCase();
        return !format || ["TV", "TV_SHORT", "MOVIE", "OVA", "ONA", "SPECIAL"].includes(format);
    }

    function legacySeriesTitleIdentity(item) {
        const source = toTraditionalChinese(item?.groupTitle || item?.seriesGroupTitle || item?.title || "")
            .normalize("NFKC")
            .replace(/\s*[（(]\s*(?:19|20)\d{2}\s*年?\s*[）)]\s*$/u, "")
            .replace(/^\s*(?:電影版|劇場版|映画)\s*/iu, "")
            .replace(/\s*(?:第\s*[一二三四五六七八九十百0-9]+\s*[季期]|Season\s*\d+|\d+(?:st|nd|rd|th)\s+Season|Part\s*\d+)\s*$/iu, "")
            .replace(/[∬∽＊*]+\s*$/u, "")
            .trim();
        return normalizeText(source);
    }

    function buildAnimeSeriesIdentity(list) {
        const records = arrayOf(list);
        const graph = new Map();
        const traversalGraph = new Map();
        const collectOnlyGraph = new Map();
        const collectOnlyTargets = new Set();
        const ensureNode = id => {
            if (id && !graph.has(id)) {
                graph.set(id, new Set());
                traversalGraph.set(id, new Set());
                collectOnlyGraph.set(id, new Set());
            }
            return graph.get(id);
        };
        records.forEach(item => {
            const mediaId = getAnimeAniListIdentity(item);
            if (!mediaId) return;
            ensureNode(mediaId);
            animeRelationEdges(item).forEach(edge => {
                if (!isSafeAnimeSeriesRelation(edge)) return;
                const relatedId = explicitRelationNodeId(edge);
                if (!relatedId || relatedId === mediaId) return;
                ensureNode(mediaId).add(relatedId);
                ensureNode(relatedId).add(mediaId);
                if (animeSeriesRelationMode(edge) === "collect-only") {
                    collectOnlyGraph.get(mediaId).add(relatedId);
                    collectOnlyTargets.add(relatedId);
                    return;
                }
                traversalGraph.get(mediaId).add(relatedId);
                traversalGraph.get(relatedId).add(mediaId);
            });
        });

        const rootById = new Map();
        const visited = new Set();
        const numericOrder = (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b));
        const startOrder = [...graph.keys()].sort((a, b) =>
            Number(collectOnlyTargets.has(a)) - Number(collectOnlyTargets.has(b))
            || numericOrder(a, b)
        );
        startOrder.forEach(startId => {
            if (visited.has(startId)) return;
            const component = [];
            const queue = [startId];
            visited.add(startId);
            while (queue.length) {
                const current = queue.shift();
                component.push(current);
                for (const next of traversalGraph.get(current) || []) {
                    if (visited.has(next)) continue;
                    visited.add(next);
                    queue.push(next);
                }
                for (const next of collectOnlyGraph.get(current) || []) {
                    if (visited.has(next)) continue;
                    visited.add(next);
                    component.push(next);
                }
            }
            const rootId = component.slice().sort(numericOrder)[0];
            component.forEach(id => rootById.set(id, { rootId, size:component.length }));
        });

        const entries = records.map((item, index) => {
            const mediaId = getAnimeAniListIdentity(item);
            if (mediaId) {
                const component = rootById.get(mediaId) || { rootId:mediaId, size:1 };
                return {
                    index,
                    mediaId,
                    seriesRootId:component.rootId,
                    seriesKey:component.size > 1 ? `anilist-series:${component.rootId}` : `anilist-media:${mediaId}`,
                    source:component.size > 1 ? "anilist-relations" : "anilist-media"
                };
            }
            const fallback = legacySeriesTitleIdentity(item) || `local-${stableHash(String(item?.id || index))}`;
            return { index, mediaId:"", seriesRootId:null, seriesKey:`legacy-series:${stableHash(fallback)}`, source:"legacy-title" };
        });
        return { entries, graph, traversalGraph, collectOnlyGraph, rootById };
    }

    function assignAnimeSeriesIdentity(list) {
        const source = arrayOf(list);
        const identity = buildAnimeSeriesIdentity(source);
        let changedCount = 0;
        const migrated = source.map((item, index) => {
            const entry = identity.entries[index];
            if (!item || !entry) return item;
            const changed = item.seriesKey !== entry.seriesKey
                || String(item.seriesRootId ?? "") !== String(entry.seriesRootId ?? "")
                || item.seriesKeySource !== entry.source;
            if (!changed) return item;
            changedCount++;
            return { ...item, seriesKey:entry.seriesKey, seriesRootId:entry.seriesRootId, seriesKeySource:entry.source };
        });
        return { list:migrated, changed:changedCount > 0, changedCount, entries:identity.entries };
    }

    function getAnimeSeriesKey(item) {
        if (item?.seriesKey) return String(item.seriesKey);
        const mediaId = getAnimeAniListIdentity(item);
        if (mediaId) return `anilist-media:${mediaId}`;
        const fallback = legacySeriesTitleIdentity(item) || `local-${stableHash(String(item?.id || "unknown"))}`;
        return `legacy-series:${stableHash(fallback)}`;
    }

    function normalizeSongTitle(value) {
        return normalizeText(String(value || "")
            .replace(/\b(?:tv|anime)\s*size\b/gi, "")
            .replace(/\b(?:opening|ending)\s*(?:version|ver\.?)\b/gi, "")
            .replace(/[（(]\s*(?:tv|anime)\s*size\s*[）)]/gi, ""));
    }
    function normalizeArtistName(value) {
        return normalizeText(String(value || "").replace(/\b(?:feat\.?|featuring|ft\.?)\b[\s\S]*$/i, ""));
    }
    function normalizeThemeSong(song, type, index) {
        const normalizedType = String(song?.type || type || "OP").toUpperCase() === "ED" ? "ED" : "OP";
        const sequence = Math.max(1, numberOr(song?.sequence, index + 1));
        const title = String(song?.title || song?.rawText || "").trim();
        const artist = String(song?.artist || "").trim();
        return {
            ...song,
            id: song?.id || `theme-${stableHash(`${normalizedType}|${sequence}|${title}|${artist}`)}`,
            type: normalizedType,
            sequence,
            title,
            artist,
            episodeRange: String(song?.episodeRange || "").trim(),
            spotifyTrackId: String(song?.spotifyTrackId || ""),
            spotifyUrl: String(song?.spotifyUrl || ""),
            spotifyEmbedUrl: String(song?.spotifyEmbedUrl || ""),
            spotifyMatchStatus: song?.spotifyMatchStatus || "unmatched",
            spotifyMatchScore: numberOr(song?.spotifyMatchScore),
            sourceName: String(song?.sourceName || ""),
            sourceUrl: String(song?.sourceUrl || ""),
            manuallyCorrected: Boolean(song?.manuallyCorrected),
            unavailableOnSpotify: Boolean(song?.unavailableOnSpotify),
            updatedAt: iso(song?.updatedAt || new Date().toISOString())
        };
    }
    function normalizeThemeSongs(value) {
        const themes = value && typeof value === "object" ? value : {};
        return {
            openings: arrayOf(themes.openings).map((song, index) => normalizeThemeSong(song, "OP", index)),
            endings: arrayOf(themes.endings).map((song, index) => normalizeThemeSong(song, "ED", index))
        };
    }

    function migrateAnime(item, now = new Date().toISOString()) {
        const currentEpisode = numberOr(item.currentEpisode ?? item.watched, 0);
        const reviewWatched = Math.max(0, numberOr(item.reviewWatched, 0));
        const totalRaw = item.totalEpisodes ?? item.episodes;
        const totalEpisodes = Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : totalRaw || null;
        const platform = item.platform || item.customPlatform || arrayOf(item.streamingLinks).map(link => link?.site).filter(Boolean).join("、");
        const createdAt = iso(item.createdAt || item.addedAt || now);
        const manualTitle = hasManualAnimeTitle(item);
        const localizedTitle = localizedStoredTitle(item.title || "未命名作品", manualTitle);
        return {
            ...item,
            id: item.id || uuid(),
            title: localizedTitle,
            displayTitle:localizedStoredTitle(item.displayTitle || localizedTitle, manualTitle),
            canonicalTitle:localizedStoredTitle(item.canonicalTitle || localizedTitle, manualTitle),
            groupTitle:localizedStoredTitle(item.groupTitle || item.seriesGroupTitle || localizedTitle, false),
            aliases: localizedAliasList([item.title, localizedTitle, ...arrayOf(item.aliases)]),
            status: item.status || item.category || "backlog",
            category: item.category || item.status || "backlog",
            platform,
            customPlatform: item.customPlatform || platform || "",
            tags: arrayOf(item.tags || item.customTags),
            currentEpisode,
            watched: currentEpisode,
            reviewWatched,
            reviewSessionActive:item.reviewSessionActive === true || (item.reviewSessionActive == null && item.category === "review"),
            reviewStartedAt:item.reviewStartedAt ? iso(item.reviewStartedAt) : null,
            reviewCompletedAt:item.reviewCompletedAt ? iso(item.reviewCompletedAt) : null,
            totalEpisodes,
            episodes: totalEpisodes ?? item.episodes ?? "??",
            rating: item.rating ?? null,
            notes: item.notes ?? item.note ?? "",
            note: item.note ?? item.notes ?? "",
            poster: item.poster || item.coverImage || "",
            synopsis: item.synopsis || item.description || "",
            year: item.year || null,
            season: item.season || "",
            broadcastDay: item.broadcastDay || "",
            broadcastTime: item.broadcastTime || "",
            nextEpisodeAt: item.nextEpisodeAt || (item.nextAiringAt ? new Date(Number(item.nextAiringAt) * 1000).toISOString() : null),
            releaseDate: item.releaseDate || null,
            nextSeasonDate: item.nextSeasonDate || null,
            reminderEnabled: Boolean(item.reminderEnabled),
            themeSongs: normalizeThemeSongs(item.themeSongs),
            addedAt: iso(item.addedAt || createdAt),
            createdAt,
            updatedAt: iso(item.updatedAt || createdAt),
            lastWatchedAt: item.lastWatchedAt ? iso(item.lastWatchedAt) : null,
            deletedAt: item.deletedAt || null
        };
    }

    function migrateList(list, now) {
        return assignAnimeSeriesIdentity(arrayOf(list).map(item => migrateAnime(item || {}, now))).list;
    }

    function getAnimeTitlePresentation(anime) {
        const structuredYear = Number(anime?.startDate?.year ?? anime?.year);
        const year = Number.isInteger(structuredYear) && structuredYear > 0 ? structuredYear : null;
        const rawTitle = String(anime?.title || "");
        const trailingYear = rawTitle.match(/\s*[（(]\s*((?:19|20)\d{2})\s*年?\s*[）)]\s*$/u);
        const manual = anime?.titleManuallyEdited === true || anime?.titleSource === "manual" || anime?.manualTitle === true;
        const matchingYear = Boolean(year && trailingYear && Number(trailingYear[1]) === year);
        return {
            title:matchingYear ? rawTitle.slice(0, trailingYear.index).trim() : rawTitle,
            year:year && (!manual || !trailingYear || matchingYear) ? year : null
        };
    }

    function getAnimeAniListIdentity(item) {
        if (!item || typeof item !== "object") return "";
        const values = [item.anilistId, item.aniListId];
        if (String(item.source || item.dataSource || "").toLowerCase() === "anilist") values.push(item.sourceId);
        if (item.anilistTitles && typeof item.anilistTitles === "object") {
            values.push(item.sourceId);
        }
        for (const value of values) {
            const numeric = Number(value);
            if (Number.isSafeInteger(numeric) && numeric > 0) return String(numeric);
        }
        return "";
    }

    function validPositiveIntegerIdentity(value) {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : "";
    }

    function recoverLegacyAnimeIdentities(list, state = {}, now = new Date().toISOString()) {
        const records = arrayOf(list).map((item, index) => ({ item, index }));
        const localIdCounts = new Map();
        records.forEach(({ item }) => {
            const localId = String(item?.id ?? "");
            if (localId) localIdCounts.set(localId, (localIdCounts.get(localId) || 0) + 1);
        });

        const nestedEntries = arrayOf(state?.works).flatMap(work => arrayOf(work?.mediaEntries));
        const availableEntries = nestedEntries.length ? nestedEntries : arrayOf(state?.mediaEntries);
        const animeEntries = availableEntries.filter(entry => String(entry?.mediaType || "").toLowerCase() === "anime");
        const sourceIdCounts = new Map();
        animeEntries.forEach(entry => {
            const sourceId = validPositiveIntegerIdentity(entry?.sourceId);
            if (sourceId) sourceIdCounts.set(sourceId, (sourceIdCounts.get(sourceId) || 0) + 1);
        });

        const explicitOwners = new Map();
        records.forEach(record => {
            const identity = getAnimeAniListIdentity(record.item);
            if (!identity) return;
            if (!explicitOwners.has(identity)) explicitOwners.set(identity, []);
            explicitOwners.get(identity).push(record);
        });

        const recovered = [];
        const skipped = [];
        const skip = (record, reason, details = {}) => skipped.push({
            localId:String(record.item?.id ?? ""),
            reason,
            ...details
        });

        const next = records.map(record => {
            const item = record.item;
            if (!item || typeof item !== "object") return item;
            const explicitIdentity = getAnimeAniListIdentity(item);
            if (explicitIdentity) return item;

            const localId = String(item.id ?? "");
            if (!localId || localIdCounts.get(localId) !== 1) {
                skip(record, "ambiguous-local-id", { matches:localIdCounts.get(localId) || 0 });
                return item;
            }

            const matchingEntries = animeEntries.filter(entry => String(entry?.id ?? "") === localId);
            if (matchingEntries.length !== 1) {
                skip(record, "ambiguous-media-entry", { matches:matchingEntries.length });
                return item;
            }

            const entry = matchingEntries[0];
            const sourceId = validPositiveIntegerIdentity(entry.sourceId);
            if (!sourceId) {
                skip(record, "invalid-source-id");
                return item;
            }
            if (sourceIdCounts.get(sourceId) !== 1) {
                skip(record, "ambiguous-source-id", { sourceId, matches:sourceIdCounts.get(sourceId) || 0 });
                return item;
            }

            const animeTitles = animeIdentityTitles(item);
            const entryTitles = animeIdentityTitles(entry);
            const titleOverlap = [...animeTitles].filter(title => entryTitles.has(title));
            if (!titleOverlap.length) {
                skip(record, "title-alias-mismatch", { sourceId });
                return item;
            }

            const conflictingOwners = arrayOf(explicitOwners.get(sourceId)).filter(owner => owner.index !== record.index);
            if (conflictingOwners.length) {
                skip(record, "conflicting-explicit-identity", {
                    sourceId,
                    conflictingLocalIds:conflictingOwners.map(owner => owner.item?.id)
                });
                return item;
            }

            const updated = {
                ...item,
                anilistId:Number(sourceId),
                identitySource:"legacy-work-sourceId",
                identityRecoveredAt:iso(now)
            };
            recovered.push({
                localId:item.id,
                anilistId:sourceId,
                deleted:Boolean(item.deletedAt),
                titleOverlap
            });
            return updated;
        });

        const reasonCounts = skipped.reduce((counts, item) => {
            counts[item.reason] = (counts[item.reason] || 0) + 1;
            return counts;
        }, {});
        return {
            list:next,
            changed:recovered.length > 0,
            recoveredCount:recovered.length,
            recovered,
            skipped,
            report:{
                total:records.length,
                explicitBefore:records.filter(record => Boolean(getAnimeAniListIdentity(record.item))).length,
                recoveredCount:recovered.length,
                skippedCount:skipped.length,
                reasonCounts,
                recovered
            }
        };
    }

    function collectActiveAnimeAniListIds(list) {
        return [...new Set(arrayOf(list)
            .filter(item => item && !item.deletedAt)
            .map(getAnimeAniListIdentity)
            .filter(Boolean)
            .map(Number)
            .filter(value => Number.isSafeInteger(value) && value > 0))];
    }

    function legacyAnimeIdentityKey(item) {
        if (!item || getAnimeAniListIdentity(item)) return "";
        const startDate = item.startDate && typeof item.startDate === "object" ? item.startDate : {};
        const year = Number(startDate.year ?? item.year);
        const format = String(item.format || item.mediaType || item.type || "").trim().toUpperCase();
        const title = String(item.canonicalTitle || item.displayTitle || item.title || "")
            .normalize("NFKC")
            .toLocaleLowerCase()
            .replace(/\s*[（(]\s*(?:19|20)\d{2}\s*年?\s*[）)]\s*$/u, "")
            .replace(/[\s\p{P}]+/gu, "")
            .trim();
        const group = normalizeText(item.groupTitle || item.seriesTitle || item.title || "");
        return title && group && Number.isInteger(year) && year > 0 && format ? `legacy:${title}|${year}|${format}|${group}` : "";
    }

    function animeIdentityTitles(item) {
        const titles = item?.anilistTitles && typeof item.anilistTitles === "object" ? item.anilistTitles : {};
        return new Set([
            item?.title,
            item?.displayTitle,
            item?.canonicalTitle,
            titles.native,
            titles.english,
            titles.romaji,
            ...arrayOf(item?.aliases)
        ].map(value => normalizeText(String(value || "").replace(/\s*[（(]\s*(?:19|20)\d{2}\s*年?\s*[）)]\s*$/u, ""))).filter(Boolean));
    }

    function isConservativeLegacyShadowMatch(legacy, known) {
        if (!legacy || !known || getAnimeAniListIdentity(legacy) || !getAnimeAniListIdentity(known)) return false;
        const legacyYear = Number(legacy?.startDate?.year ?? legacy?.year);
        const knownYear = Number(known?.startDate?.year ?? known?.year);
        const legacyFormat = String(legacy?.format || legacy?.mediaType || legacy?.type || "").trim().toUpperCase();
        const knownFormat = String(known?.format || known?.mediaType || known?.type || "").trim().toUpperCase();
        if (!Number.isInteger(legacyYear) || legacyYear <= 0 || legacyYear !== knownYear) return false;
        if (!legacyFormat || legacyFormat !== knownFormat) return false;

        const legacyGroup = normalizeText(legacy.groupTitle || legacy.seriesTitle || legacy.title || "");
        const knownGroup = normalizeText(known.groupTitle || known.seriesTitle || known.title || "");
        if (!legacyGroup || legacyGroup !== knownGroup) return false;

        const legacyTitles = animeIdentityTitles(legacy);
        return [...animeIdentityTitles(known)].some(title => legacyTitles.has(title));
    }

    function uniqueMergedArray(values) {
        const seen = new Set();
        return values.flatMap(arrayOf).filter(value => {
            let key;
            try { key = typeof value === "object" ? JSON.stringify(value) : `${typeof value}:${String(value)}`; }
            catch { key = String(value); }
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function mergeTextValues(records, field) {
        return [...new Set(records.map(record => String(record?.[field] || "").trim()).filter(Boolean))].join("\n\n");
    }

    function animeReferenceCount(state, animeId) {
        const target = String(animeId), matches = value => String(value) === target;
        let count = 0;
        for (const store of [state?.eventOverrides, state?.eventAnimeOverrides]) {
            Object.values(store && typeof store === "object" ? store : {}).forEach(value => {
                if (!value || typeof value !== "object") return;
                ANIME_REFERENCE_FIELDS.forEach(field => { count += arrayOf(value[field]).filter(matches).length; });
            });
        }
        count += arrayOf(state?.watchHistory).filter(record => matches(record?.animeId)).length;
        count += arrayOf(state?.works).flatMap(work => arrayOf(work?.mediaEntries)).filter(entry => entry?.mediaType === "anime" && matches(entry?.id)).length;
        if (matches(state?.themeUndo?.animeId)) count++;
        if (state?.themeCache && Object.prototype.hasOwnProperty.call(state.themeCache, `source:${target}`)) count++;
        return count;
    }

    function chooseCanonicalDuplicate(records, state) {
        return records.slice().sort((a, b) =>
            Number(Boolean(a.legacyIdentityBound)) - Number(Boolean(b.legacyIdentityBound))
            || animeReferenceCount(state, b.item.id) - animeReferenceCount(state, a.item.id)
            || Number(!b.item.deletedAt) - Number(!a.item.deletedAt)
            || Number(Boolean(b.item.titleManuallyEdited || b.item.titleSource === "manual" || b.item.manualTitle === true))
                - Number(Boolean(a.item.titleManuallyEdited || a.item.titleSource === "manual" || a.item.manualTitle === true))
            || Date.parse(a.item.createdAt || a.item.addedAt || 0) - Date.parse(b.item.createdAt || b.item.addedAt || 0)
            || a.index - b.index
        )[0];
    }

    function mergeDuplicateAnimeRecords(records, canonicalRecord) {
        const ordered = records.map(record => record.item);
        const canonical = canonicalRecord.item;
        const merged = { ...canonical };
        for (const item of ordered) {
            Object.entries(item).forEach(([key, value]) => {
                if ((merged[key] === undefined || merged[key] === null || merged[key] === "") && value !== undefined && value !== null && value !== "") merged[key] = value;
            });
        }

        const manual = ordered
            .filter(item => item.titleManuallyEdited === true || item.titleSource === "manual" || item.manualTitle === true)
            .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
        if (manual) {
            merged.title = manual.title;
            merged.displayTitle = manual.displayTitle || manual.title;
            merged.titleSource = "manual";
            merged.titleManuallyEdited = true;
            if (manual.manualTitle === true) merged.manualTitle = true;
        }

        merged.aliases = uniqueMergedArray(ordered.flatMap(item => [item.title, item.displayTitle, item.canonicalTitle, ...arrayOf(item.aliases)])).filter(Boolean);
        for (const field of ["tags", "customTags", "relations", "streamingLinks"]) merged[field] = uniqueMergedArray(ordered.map(item => item[field]));
        merged.themeSongs = ordered.reduce((songs, item) => mergeThemeSongs(songs, item.themeSongs), { openings:[], endings:[] });

        const resetTimes = ordered
            .map(item => Date.parse(item.trackingLifecycleResetAt || ""))
            .filter(Number.isFinite);
        const latestResetTime = resetTimes.length ? Math.max(...resetTimes) : null;
        const lifecycleRecords = latestResetTime === null
            ? ordered
            : ordered.filter(item => Date.parse(item.trackingLifecycleResetAt || "") === latestResetTime);
        const progress = Math.max(...lifecycleRecords.map(item => numberOr(item.currentEpisode ?? item.watched)));
        merged.currentEpisode = progress;
        merged.watched = progress;
        merged.reviewWatched = Math.max(...lifecycleRecords.map(item => Math.max(0, numberOr(item.reviewWatched))));
        if (latestResetTime !== null) {
            const lifecycleOwner = lifecycleRecords.slice().sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
            merged.trackingLifecycleResetAt = new Date(latestResetTime).toISOString();
            merged.progress = numberOr(lifecycleOwner?.progress ?? lifecycleOwner?.currentEpisode ?? lifecycleOwner?.watched);
            merged.lastWatchedAt = lifecycleOwner?.lastWatchedAt || null;
            merged.reviewSessionActive = lifecycleOwner?.reviewSessionActive === true;
            merged.reviewStartedAt = lifecycleOwner?.reviewStartedAt || null;
            merged.reviewCompletedAt = lifecycleOwner?.reviewCompletedAt || null;
        }
        for (const field of ["review", "note", "notes", "memo"]) {
            const value = mergeTextValues(ordered, field);
            if (value) merged[field] = value;
        }
        const platforms = [...new Set(ordered.map(item => String(item.customPlatform || "").trim()).filter(Boolean))];
        if (platforms.length) merged.customPlatform = platforms.join("、");
        if (merged.rating == null) merged.rating = ordered.find(item => item.rating != null)?.rating ?? null;

        const active = ordered.filter(item => !item.deletedAt);
        const tombstones = ordered.filter(item => item.deletedAt);
        const preferredActive = active.slice().sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
        const preferredManualCategory = active
            .filter(item => item.categorySource === "manual" || item.categoryManuallyEdited === true)
            .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
        const latestDeletion = tombstones.slice().sort((a, b) => Date.parse(b.deletedAt || b.updatedAt || 0) - Date.parse(a.deletedAt || a.updatedAt || 0))[0];
        const deletionIsNewest = latestDeletion && (!preferredActive
            || Date.parse(latestDeletion.deletedAt || latestDeletion.updatedAt || 0) >= Date.parse(preferredActive.updatedAt || 0));
        if (active.length && !deletionIsNewest) {
            const categoryOwner = preferredManualCategory || preferredActive;
            merged.deletedAt = null;
            merged.category = categoryOwner.category === "_deleted" ? "backlog" : categoryOwner.category;
            if (preferredManualCategory) merged.categorySource = "manual";
            else if (categoryOwner.categorySource !== undefined) merged.categorySource = categoryOwner.categorySource;
            else delete merged.categorySource;
            merged.categoryManuallyEdited = preferredManualCategory ? true : categoryOwner.categoryManuallyEdited === true;
        } else {
            merged.deletedAt = latestDeletion?.deletedAt || latestDeletion?.updatedAt || null;
            merged.category = "_deleted";
            if (latestDeletion?.deletedFromCategory) merged.deletedFromCategory = latestDeletion.deletedFromCategory;
        }

        const createdTimes = ordered.map(item => Date.parse(item.createdAt || item.addedAt || "")).filter(Number.isFinite);
        const addedTimes = ordered.map(item => Date.parse(item.addedAt || item.createdAt || "")).filter(Number.isFinite);
        const updatedTimes = ordered.map(item => Date.parse(item.updatedAt || "")).filter(Number.isFinite);
        if (createdTimes.length) merged.createdAt = new Date(Math.min(...createdTimes)).toISOString();
        if (addedTimes.length) merged.addedAt = new Date(Math.min(...addedTimes)).toISOString();
        if (updatedTimes.length) merged.updatedAt = new Date(Math.max(...updatedTimes)).toISOString();
        merged.id = canonical.id;
        return migrateAnime(merged, merged.updatedAt);
    }

    function remapReferenceArray(value, idMap) {
        return [...new Set(arrayOf(value).map(id => idMap.get(String(id)) ?? id))];
    }

    function remapOverrideReferences(overrides, idMap, workIdMap = new Map()) {
        const result = {};
        Object.entries(overrides && typeof overrides === "object" ? overrides : {}).forEach(([key, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) { result[key] = value; return; }
            const next = { ...value };
            ANIME_REFERENCE_FIELDS.forEach(field => { if (Array.isArray(next[field])) next[field] = remapReferenceArray(next[field], idMap); });
            ["includeWorkIds", "excludeWorkIds"].forEach(field => { if (Array.isArray(next[field])) next[field] = remapReferenceArray(next[field], workIdMap); });
            result[key] = next;
        });
        return result;
    }

    function remapWorksForDuplicateAnime(works, idMap) {
        const next = arrayOf(works).map(work => ({ ...work, mediaEntries:arrayOf(work?.mediaEntries).map(entry => ({ ...entry })) }));
        const ownerById = new Map(), workIdMap = new Map();
        next.forEach(work => {
            const uniqueEntries = new Map();
            work.mediaEntries.forEach(entry => {
                const originalId = String(entry.id);
                const mappedId = entry.mediaType === "anime" ? idMap.get(originalId) : null;
                const updated = mappedId ? { ...entry, id:mappedId } : entry;
                const key = `${updated.mediaType || "anime"}:${String(updated.id)}`;
                const old = uniqueEntries.get(key);
                uniqueEntries.set(key, old ? { ...updated, ...old, aliases:uniqueMergedArray([old.aliases, updated.aliases]) } : updated);
            });
            work.mediaEntries = [...uniqueEntries.values()];
        });
        next.forEach(work => {
            work.mediaEntries = work.mediaEntries.filter(entry => {
                if (entry.mediaType !== "anime") return true;
                const id = String(entry.id), owner = ownerById.get(id);
                if (!owner) { ownerById.set(id, work); return true; }
                workIdMap.set(String(work.workId), String(owner.workId));
                owner.aliases = uniqueMergedArray([owner.aliases, work.aliases, entry.aliases, entry.title]).filter(Boolean);
                return false;
            });
        });
        return { works:next.filter(work => work.mediaEntries.length > 0), workIdMap };
    }

    function remapAnimeAuxiliaryState(state, idMap) {
        const worksResult = remapWorksForDuplicateAnime(state?.works, idMap);
        const workIdMap = worksResult.workIdMap;
        const themeCache = { ...(state?.themeCache || {}) };
        idMap.forEach((canonicalId, duplicateId) => {
            if (String(canonicalId) === String(duplicateId)) return;
            const oldKey = `source:${duplicateId}`, canonicalKey = `source:${canonicalId}`;
            if (Object.prototype.hasOwnProperty.call(themeCache, oldKey) && !Object.prototype.hasOwnProperty.call(themeCache, canonicalKey)) themeCache[canonicalKey] = themeCache[oldKey];
            delete themeCache[oldKey];
        });
        return {
            ...(state || {}),
            eventOverrides:remapOverrideReferences(state?.eventOverrides, idMap, workIdMap),
            eventAnimeOverrides:remapOverrideReferences(state?.eventAnimeOverrides, idMap, workIdMap),
            watchHistory:arrayOf(state?.watchHistory).map(record => ({ ...record, animeId:idMap.get(String(record?.animeId)) ?? record?.animeId })),
            works:worksResult.works,
            mangaReadHistory:arrayOf(state?.mangaReadHistory).map(record => ({ ...record, workId:workIdMap.get(String(record?.workId)) ?? record?.workId })),
            themeCache,
            themeUndo:state?.themeUndo?.animeId != null ? { ...state.themeUndo, animeId:idMap.get(String(state.themeUndo.animeId)) ?? state.themeUndo.animeId } : state?.themeUndo ?? null
        };
    }

    function describeAnimeIdentity(item) {
        return {
            localId:item?.id ?? null,
            anilistId:getAnimeAniListIdentity(item) || null,
            sourceId:item?.sourceId ?? null,
            title:item?.title || "",
            aliases:arrayOf(item?.aliases),
            year:item?.startDate?.year ?? item?.year ?? null,
            startDate:item?.startDate ?? null,
            format:item?.format || item?.mediaType || null,
            relations:arrayOf(item?.relations),
            createdAt:item?.createdAt || item?.addedAt || null,
            deletedAt:item?.deletedAt || null
        };
    }

    function auxiliaryIdentityMatches(value, anime) {
        if (!value || typeof value !== "object" || !anime) return false;
        const targetAniListId = getAnimeAniListIdentity(anime);
        const valueAniListId = getAnimeAniListIdentity(value);
        if (targetAniListId && valueAniListId) return targetAniListId === valueAniListId;
        const targetMalId = String(anime.malId ?? anime.idMal ?? anime.externalIds?.malId ?? "");
        const valueMalId = String(value.malId ?? value.idMal ?? value.externalIds?.malId ?? "");
        if (targetMalId && valueMalId) return targetMalId === valueMalId;
        return false;
    }

    function remapCollisionAuxiliaryState(state, reassignments) {
        if (!reassignments.length) return { ...(state || {}) };
        const remapContextId = (value, context) => {
            const oldId = String(value ?? "");
            if (!oldId) return value;
            const match = reassignments.find(item => item.oldId === oldId && auxiliaryIdentityMatches(context, item.record));
            return match ? match.newId : value;
        };
        const works = arrayOf(state?.works).map(work => {
            const entries = arrayOf(work?.mediaEntries).map(entry => entry?.mediaType === "anime"
                ? { ...entry, id:remapContextId(entry.id, entry) }
                : { ...entry });
            const unique = new Map();
            entries.forEach(entry => {
                const key = `${entry.mediaType || "anime"}:${String(entry.id)}`;
                const previous = unique.get(key);
                unique.set(key, previous ? { ...entry, ...previous, aliases:uniqueMergedArray([previous.aliases, entry.aliases]) } : entry);
            });
            return { ...work, mediaEntries:[...unique.values()] };
        });
        const watchHistory = arrayOf(state?.watchHistory).map(record => ({
            ...record,
            animeId:remapContextId(record?.animeId, record)
        }));
        const themeUndo = state?.themeUndo?.animeId != null
            ? { ...state.themeUndo, animeId:remapContextId(state.themeUndo.animeId, state.themeUndo) }
            : state?.themeUndo ?? null;
        return { ...(state || {}), works, watchHistory, themeUndo };
    }

    function ensureUniqueLocalAnimeIds(list, state = {}, options = {}) {
        const records = migrateList(list).map((item, index) => ({ item, index }));
        const byLocalId = new Map();
        records.forEach(record => {
            const id = String(record.item.id ?? "");
            if (id) (byLocalId.get(id) || (byLocalId.set(id, []), byLocalId.get(id))).push(record);
        });
        const usedIds = new Set(records.map(record => String(record.item.id)));
        const makeId = typeof options.idFactory === "function" ? options.idFactory : uuid;
        const reassignments = [], collisions = [];
        for (const [oldId, group] of byLocalId) {
            if (group.length < 2) continue;
            const ordered = group.slice().sort((a, b) =>
                Number(Boolean(a.item.deletedAt)) - Number(Boolean(b.item.deletedAt))
                || animeReferenceCount(state, b.item.id) - animeReferenceCount(state, a.item.id)
                || a.index - b.index
            );
            const owner = ordered[0];
            const report = { localId:oldId, owner:describeAnimeIdentity(owner.item), reassigned:[] };
            for (const record of ordered.slice(1)) {
                let newId;
                do { newId = String(makeId(record.item, record.index, oldId)); } while (!newId || usedIds.has(newId));
                usedIds.add(newId);
                const updated = {
                    ...record.item,
                    id:newId,
                    localIdReassignedFrom:oldId,
                    localIdReassignedAt:iso(options.now || new Date().toISOString())
                };
                records[record.index].item = updated;
                const reassignment = { oldId, newId, record:updated, original:record.item };
                reassignments.push(reassignment);
                report.reassigned.push({ oldId, newId, record:describeAnimeIdentity(updated) });
            }
            collisions.push(report);
        }
        const nextState = remapCollisionAuxiliaryState(state, reassignments);
        return {
            list:records.map(record => record.item),
            state:nextState,
            changed:reassignments.length > 0,
            reassignedCount:reassignments.length,
            reassignments:reassignments.map(item => ({ oldId:item.oldId, newId:item.newId, record:describeAnimeIdentity(item.record) })),
            collisions
        };
    }

    function reconcileExistingAnimeDuplicates(list, state = {}) {
        const records = migrateList(list).map((item, index) => ({ item, index }));
        const legacyBindings = [];
        for (const record of records) {
            if (getAnimeAniListIdentity(record.item)) continue;
            const matches = records.filter(known => getAnimeAniListIdentity(known.item)
                && isConservativeLegacyShadowMatch(record.item, known.item));
            const identities = [...new Set(matches.map(match => getAnimeAniListIdentity(match.item)).filter(Boolean))];
            if (identities.length !== 1) continue;
            const externalId = identities[0];
            record.item = {
                ...record.item,
                anilistId:Number.isSafeInteger(Number(externalId)) ? Number(externalId) : externalId
            };
            record.legacyIdentityBound = true;
            legacyBindings.push({
                localId:record.item.id,
                anilistId:externalId,
                matchedKnownIds:matches.map(match => match.item.id)
            });
        }
        const groups = new Map();
        records.forEach(record => {
            const externalId = getAnimeAniListIdentity(record.item);
            const key = externalId ? `anilist:${externalId}` : legacyAnimeIdentityKey(record.item);
            if (key) (groups.get(key) || (groups.set(key, []), groups.get(key))).push(record);
        });

        const duplicateGroups = [...groups.entries()].filter(([, group]) => group.length > 1);
        const removedIndexes = new Set(), replacements = new Map(), idMap = new Map(), reports = [];
        duplicateGroups.forEach(([identityKey, group]) => {
            const canonical = chooseCanonicalDuplicate(group, state);
            const merged = mergeDuplicateAnimeRecords(group, canonical);
            replacements.set(canonical.index, merged);
            group.forEach(record => {
                idMap.set(String(record.item.id), canonical.item.id);
                if (record.index !== canonical.index) removedIndexes.add(record.index);
            });
            reports.push({ identityKey, canonicalId:canonical.item.id, removedIds:group.filter(record => record.index !== canonical.index).map(record => record.item.id), records:group.map(record => describeAnimeIdentity(record.item)) });
        });
        const reconciledList = records.filter(record => !removedIndexes.has(record.index)).map(record => replacements.get(record.index) || record.item);
        const reconciledState = idMap.size ? remapAnimeAuxiliaryState(state, idMap) : { ...(state || {}) };
        const uniqueness = ensureUniqueLocalAnimeIds(reconciledList, reconciledState);
        return {
            list:uniqueness.list,
            state:uniqueness.state,
            changed:legacyBindings.length > 0 || removedIndexes.size > 0 || uniqueness.changed,
            mergedCount:removedIndexes.size,
            legacyBoundCount:legacyBindings.length,
            reassignedCount:uniqueness.reassignedCount,
            idMap:Object.fromEntries(idMap),
            groups:reports,
            collisions:uniqueness.collisions,
            reassignments:uniqueness.reassignments,
            legacyBindings
        };
    }

    function findAnimeRecordIndex(list, id, identity = null, options = {}) {
        const targetId = String(id), items = arrayOf(list);
        const identityValue = identity && typeof identity === "object" ? getAnimeAniListIdentity(identity) : String(identity ?? "");
        const records = items.map((item, index) => ({ item, index }));
        const localMatches = records.filter(record => String(record.item?.id) === targetId);
        let pool = localMatches;
        if (identityValue) {
            const exactMatches = localMatches.filter(record => getAnimeAniListIdentity(record.item) === identityValue);
            const identityMatches = records.filter(record => getAnimeAniListIdentity(record.item) === identityValue);
            pool = exactMatches.length ? exactMatches : identityMatches;
        }
        if (!pool.length) return -1;
        if (options.preferDeleted) return (pool.find(record => Boolean(record.item?.deletedAt)) || pool[0]).index;
        return (pool.find(record => !record.item?.deletedAt) || pool[0]).index;
    }

    function updateAnimeTitleById(list, id, title, now = new Date().toISOString()) {
        const targetId = String(id), nextTitle = String(title || "").trim();
        const next = arrayOf(list).slice();
        const index = findAnimeRecordIndex(next, targetId);
        if (index < 0 || !nextTitle) return { list, found:index >= 0, changed:false, anime:index >= 0 ? next[index] : null };
        const current = next[index];
        if (current.title === nextTitle && current.titleManuallyEdited === true) return { list:next, found:true, changed:false, anime:current };
        const updated = {
            ...current,
            title:nextTitle,
            displayTitle:nextTitle,
            titleSource:"manual",
            titleManuallyEdited:true,
            aliases:[...new Set([current.title, nextTitle, ...arrayOf(current.aliases)].filter(Boolean))],
            updatedAt:iso(now)
        };
        next[index] = updated;
        return { list:next, found:true, changed:true, anime:updated };
    }

    function moveAnimeCategoryById(list, id, category, now = new Date().toISOString()) {
        const targetId = String(id), nextCategory = String(category || "").trim();
        const next = arrayOf(list).slice();
        const index = findAnimeRecordIndex(next, targetId);
        if (index < 0 || !nextCategory) return { list, found:index >= 0, changed:false, anime:index >= 0 ? next[index] : null };
        const current = next[index];
        const alreadyManual = current.categorySource === "manual" && current.categoryManuallyEdited === true;
        if (current.category === nextCategory && alreadyManual) return { list:next, found:true, changed:false, anime:current };
        const updated = {
            ...current,
            category:nextCategory,
            categorySource:"manual",
            categoryManuallyEdited:true,
            updatedAt:iso(now)
        };
        if (nextCategory === "review") {
            if (current.reviewSessionActive !== true) {
                updated.reviewWatched = 0;
                updated.reviewStartedAt = iso(now);
                updated.reviewCompletedAt = null;
            }
            updated.reviewSessionActive = true;
        } else if (current.category === "review" && current.reviewSessionActive === true) {
            updated.reviewSessionActive = false;
            if (nextCategory === "completed") updated.reviewCompletedAt = iso(now);
        }
        if (nextCategory === "watching") updated.lastWatchedAt = iso(now);
        next[index] = updated;
        return { list:next, found:true, changed:true, anime:updated };
    }

    function shouldDiscoverSequelAfterCategoryMove(previousCategory, nextCategory) {
        const previous = String(previousCategory || "").trim();
        const next = String(nextCategory || "").trim();
        return next === "completed" && previous !== "completed" && previous !== "review";
    }

    function markAnimeDeletedById(list, id, now = new Date().toISOString(), identity = null) {
        const targetId = String(id), next = arrayOf(list).slice();
        const index = findAnimeRecordIndex(next, targetId, identity);
        if (index < 0) return { list, found:false, changed:false, anime:null };
        const current = next[index];
        if (current.deletedAt) return { list:next, found:true, changed:false, anime:current, recordIndex:index };
        const deletedFromCategory = current.category && current.category !== "_deleted"
            ? current.category
            : current.deletedFromCategory || "backlog";
        const updated = { ...current, deletedFromCategory, category:"_deleted", deletedAt:iso(now), updatedAt:iso(now) };
        next[index] = updated;
        return { list:next, found:true, changed:true, anime:updated, recordIndex:index };
    }

    function restoreAnimeById(list, id, snapshot, now = new Date().toISOString(), identity = null) {
        const targetId = String(id), next = arrayOf(list).slice();
        const index = findAnimeRecordIndex(next, targetId, identity, { preferDeleted:true });
        const identityValue = identity && typeof identity === "object" ? getAnimeAniListIdentity(identity) : String(identity ?? "");
        const snapshotRecords = arrayOf(snapshot);
        const snapshotMatches = snapshotRecords.filter(item => String(item?.id) === targetId);
        const original = (identityValue ? snapshotRecords.find(item => getAnimeAniListIdentity(item) === identityValue) : null)
            || snapshotMatches.find(item => !item.deletedAt)
            || snapshotMatches[0]
            || (snapshot && !Array.isArray(snapshot) && String(snapshot.id) === targetId ? snapshot : null);
        if (!original) return { list, found:false, changed:false, anime:null };
        const restored = migrateAnime({ ...original, id:original.id, deletedAt:null, category:original.category === "_deleted" ? "backlog" : original.category, updatedAt:iso(now) }, now);
        if (index >= 0) next[index] = restored;
        else next.push(restored);
        return { list:next, found:true, changed:true, anime:restored };
    }

    const ANIME_REFERENCE_FIELDS = Object.freeze([
        "includeAnimeIds", "excludeAnimeIds", "includeMediaIds", "excludeMediaIds",
        "matchedAnimeIds", "relatedAnimeIds", "animeIds"
    ]);

    function removeAnimeIdFromOverrides(overrides, animeId) {
        const targetId = String(animeId), result = {};
        Object.entries(overrides && typeof overrides === "object" ? overrides : {}).forEach(([key, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) { result[key] = value; return; }
            const cleaned = { ...value };
            ANIME_REFERENCE_FIELDS.forEach(field => {
                if (Array.isArray(cleaned[field])) cleaned[field] = cleaned[field].filter(id => String(id) !== targetId);
            });
            result[key] = cleaned;
        });
        return result;
    }

    function pruneAnimeIdOverrides(overrides, activeAnimeIds) {
        const active = new Set(arrayOf(activeAnimeIds).map(String)), result = {};
        Object.entries(overrides && typeof overrides === "object" ? overrides : {}).forEach(([key, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) { result[key] = value; return; }
            const cleaned = { ...value };
            ["includeAnimeIds", "excludeAnimeIds", "matchedAnimeIds", "relatedAnimeIds", "animeIds"].forEach(field => {
                if (Array.isArray(cleaned[field])) cleaned[field] = cleaned[field].filter(id => active.has(String(id)));
            });
            result[key] = cleaned;
        });
        return result;
    }

    function cleanupAnimeAuxiliaryState(state, animeId) {
        const targetId = String(animeId), themeCache = { ...(state?.themeCache || {}) };
        delete themeCache[`source:${targetId}`];
        return {
            ...(state || {}),
            eventOverrides:removeAnimeIdFromOverrides(state?.eventOverrides, targetId),
            eventAnimeOverrides:removeAnimeIdFromOverrides(state?.eventAnimeOverrides, targetId),
            watchHistory:arrayOf(state?.watchHistory).filter(record => String(record?.animeId) !== targetId),
            themeCache,
            themeUndo:String(state?.themeUndo?.animeId) === targetId ? null : state?.themeUndo ?? null
        };
    }

    function cloneJsonValue(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function captureOverrideReferences(overrides, animeId) {
        const targetId = String(animeId), captured = {};
        Object.entries(overrides && typeof overrides === "object" ? overrides : {}).forEach(([key, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return;
            const references = {};
            ANIME_REFERENCE_FIELDS.forEach(field => {
                const matches = arrayOf(value[field]).filter(id => String(id) === targetId);
                if (matches.length) references[field] = cloneJsonValue(matches);
            });
            if (Object.keys(references).length) captured[key] = references;
        });
        return captured;
    }

    function restoreOverrideReferences(overrides, captured) {
        const restored = { ...(overrides && typeof overrides === "object" ? overrides : {}) };
        Object.entries(captured && typeof captured === "object" ? captured : {}).forEach(([key, references]) => {
            const current = restored[key] && typeof restored[key] === "object" && !Array.isArray(restored[key])
                ? { ...restored[key] }
                : {};
            Object.entries(references || {}).forEach(([field, values]) => {
                const merged = [], seen = new Set();
                [...arrayOf(current[field]), ...arrayOf(values)].forEach(value => {
                    const keyValue = String(value);
                    if (seen.has(keyValue)) return;
                    seen.add(keyValue);
                    merged.push(value);
                });
                current[field] = merged;
            });
            restored[key] = current;
        });
        return restored;
    }

    function watchHistoryIdentity(record) {
        if (record?.id != null && String(record.id)) return `id:${record.id}`;
        return JSON.stringify([
            record?.animeId, record?.at || record?.timestamp, record?.delta,
            record?.episode ?? record?.reviewEpisode, record?.type || "watch"
        ]);
    }

    function captureAnimeAuxiliaryState(state, animeId) {
        const targetId = String(animeId), themeCache = state?.themeCache || {};
        const themeCacheKey = `source:${targetId}`;
        const matchingThemeUndo = String(state?.themeUndo?.animeId || "") === targetId;
        return {
            animeId:targetId,
            eventOverrides:captureOverrideReferences(state?.eventOverrides, targetId),
            eventAnimeOverrides:captureOverrideReferences(state?.eventAnimeOverrides, targetId),
            watchHistory:arrayOf(state?.watchHistory).map((record, index) => ({ record, index })).filter(entry => String(entry.record?.animeId) === targetId).map(cloneJsonValue),
            themeCache:{
                key:themeCacheKey,
                present:Object.prototype.hasOwnProperty.call(themeCache, themeCacheKey),
                value:Object.prototype.hasOwnProperty.call(themeCache, themeCacheKey) ? cloneJsonValue(themeCache[themeCacheKey]) : null
            },
            themeUndo:{
                touched:matchingThemeUndo,
                present:matchingThemeUndo,
                value:matchingThemeUndo ? cloneJsonValue(state.themeUndo) : null
            }
        };
    }

    function restoreAnimeAuxiliaryState(state, snapshot, animeId = snapshot?.animeId) {
        const targetId = String(animeId || ""), restored = { ...(state || {}) };
        restored.eventOverrides = restoreOverrideReferences(state?.eventOverrides, snapshot?.eventOverrides);
        restored.eventAnimeOverrides = restoreOverrideReferences(state?.eventAnimeOverrides, snapshot?.eventAnimeOverrides);
        const history = arrayOf(state?.watchHistory).slice();
        const historyKeys = new Set(history.map(watchHistoryIdentity));
        arrayOf(snapshot?.watchHistory).slice().sort((a, b) => numberOr(a?.index) - numberOr(b?.index)).forEach(entry => {
            const record = cloneJsonValue(entry?.record);
            if (!record || String(record.animeId) !== targetId) return;
            const key = watchHistoryIdentity(record);
            if (historyKeys.has(key)) return;
            history.splice(Math.min(Math.max(0, numberOr(entry.index)), history.length), 0, record);
            historyKeys.add(key);
        });
        restored.watchHistory = history;
        const themeCache = { ...(state?.themeCache || {}) };
        const cacheKey = String(snapshot?.themeCache?.key || `source:${targetId}`);
        if (snapshot?.themeCache?.present) themeCache[cacheKey] = cloneJsonValue(snapshot.themeCache.value);
        else delete themeCache[cacheKey];
        restored.themeCache = themeCache;
        if (snapshot?.themeUndo?.touched) restored.themeUndo = snapshot.themeUndo.present ? cloneJsonValue(snapshot.themeUndo.value) : null;
        return restored;
    }

    function createCompactDeleteUndo(anime, identity, state = {}, external = {}, now = new Date().toISOString()) {
        const targetIdentity = String(identity || getAnimeAniListIdentity(anime));
        return {
            schemaVersion:2,
            type:"delete-compact",
            targetId:anime?.id,
            targetIdentity,
            at:iso(now),
            record:cloneJsonValue(anime),
            auxiliary:captureAnimeAuxiliaryState(state, anime?.id),
            external:cloneJsonValue(external || {})
        };
    }

    function isStorageQuotaError(error) {
        return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
    }

    function runAnimeDeleteTransaction(options = {}) {
        const trace = step => { try { options.trace?.(step); } catch {} };
        const list = arrayOf(options.list), id = options.id, identity = options.identity;
        trace("STEP 1 findAnimeRecordIndex");
        const recordIndex = findAnimeRecordIndex(list, id, identity);
        const item = recordIndex >= 0 ? list[recordIndex] : null;
        if (!item || item.deletedAt) return { ok:false, changed:false, stage:"lookup", list, anime:item || null, error:null };
        const undo = options.undo;
        let serializedUndo = "";
        try {
            trace("STEP 4 JSON.stringify undo");
            serializedUndo = JSON.stringify(undo);
            trace("STEP 5 save UNDO_KEY");
            options.storage.setItem(options.undoKey, serializedUndo);
        } catch (error) {
            return { ok:false, changed:false, stage:"undo", list, anime:item, error, quotaExceeded:isStorageQuotaError(error), undoBytes:serializedUndo.length * 2 };
        }
        trace("STEP 6 markAnimeDeletedById");
        const marked = markAnimeDeletedById(list, id, options.now, identity);
        if (!marked.changed || !marked.anime) {
            try { options.storage.removeItem?.(options.undoKey); } catch {}
            return { ok:false, changed:false, stage:"mark", list, anime:marked.anime, error:null };
        }
        let cleanupResult = null;
        try {
            trace("STEP 7 cleanupAnimeAuxiliaryReferences");
            cleanupResult = options.cleanup?.(marked.anime, undo, marked.list) ?? null;
            trace("STEP 8 saveAndRender");
            options.persist?.(marked.list, cleanupResult);
            return {
                ok:true, changed:true, stage:"complete", list:marked.list, anime:marked.anime,
                cleanupResult, undoBytes:serializedUndo.length * 2,
                rollbackSucceeded:null, rollbackError:null, recoveryRequired:false
            };
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            let rollbackSucceeded = false, rollbackError = null;
            try {
                if (typeof options.rollback !== "function") throw new Error("Delete rollback handler is unavailable");
                options.rollback(list, undo, marked, cleanupResult, failure);
                rollbackSucceeded = true;
            } catch (caughtRollbackError) {
                rollbackError = caughtRollbackError instanceof Error
                    ? caughtRollbackError
                    : new Error(String(caughtRollbackError));
                failure.rollbackError = rollbackError;
            }
            if (rollbackSucceeded) {
                try { options.storage.removeItem?.(options.undoKey); } catch {}
            }
            return {
                ok:false, changed:false, stage:failure.deleteStage || "persist", list, anime:item,
                error:failure, quotaExceeded:isStorageQuotaError(failure) || isStorageQuotaError(rollbackError),
                undoBytes:serializedUndo.length * 2,
                rollbackSucceeded,
                rollbackError,
                recoveryRequired:!rollbackSucceeded,
                recoveryUndoPreserved:!rollbackSucceeded
            };
        }
    }

    function restoreDeleteUndoState(list, state, undo, now = new Date().toISOString()) {
        if (undo?.type === "delete-compact" && undo?.record) {
            const restored = restoreAnimeById(list, undo.targetId, undo.record, now, undo.targetIdentity);
            return {
                list:restored.list,
                state:restoreAnimeAuxiliaryState(state, undo.auxiliary, undo.targetId),
                restored:restored.changed || restored.found,
                legacy:false,
                anime:restored.anime
            };
        }
        if (Array.isArray(undo?.before)) {
            let restoredList = migrateList(undo.before);
            if (undo.type === "delete" && undo.targetId != null) restoredList = restoreAnimeById(restoredList, undo.targetId, undo.before, now, undo.targetIdentity).list;
            return { list:restoredList, state:{ ...(undo.auxiliary || state || {}) }, restored:true, legacy:true, anime:null };
        }
        return { list, state, restored:false, legacy:false, anime:null };
    }

    function createWatchRecord(anime, delta, at = new Date().toISOString()) {
        return { id: uuid(), animeId: anime.id, title: anime.title, delta: numberOr(delta), episode: numberOr(anime.currentEpisode ?? anime.watched), at: iso(at), correction: numberOr(delta) < 0 };
    }

    function createReviewWatchRecord(anime, delta, at = new Date().toISOString()) {
        return {
            id:uuid(), animeId:anime.id, title:anime.title, delta:numberOr(delta),
            episode:numberOr(anime.reviewWatched), reviewEpisode:numberOr(anime.reviewWatched),
            type:"review", review:true, at:iso(at), correction:numberOr(delta) < 0
        };
    }

    function updateAnimeProgress(list, id, delta = 1, at = new Date().toISOString()) {
        const targetId = String(id), change = Number(delta);
        const index = findAnimeRecordIndex(list, targetId);
        if (index < 0) return { list, found: false, changed: false, reason: "not-found", anime: null, historyRecord: null };
        const old = migrateAnime(list[index], at);
        const current = Math.max(0, numberOr(old.currentEpisode ?? old.watched));
        const rawTotal = old.totalEpisodes ?? old.episodes;
        const parsedTotal = Number(rawTotal);
        const total = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null;
        const requested = Math.max(0, current + (Number.isFinite(change) ? change : 0));
        const nextEpisode = total === null ? requested : Math.min(requested, total);
        if (nextEpisode === current) return { list, found: true, changed: false, reason: change > 0 && total !== null && current >= total ? "at-total" : "unchanged", anime: old, historyRecord: null };
        const updated = {
            ...old,
            watched: nextEpisode,
            currentEpisode: nextEpisode,
            updatedAt: iso(at),
            lastWatchedAt: change > 0 ? iso(at) : old.lastWatchedAt
        };
        if (total !== null && nextEpisode >= total) updated.category = "completed";
        const nextList = arrayOf(list).slice(); nextList[index] = updated;
        return { list: nextList, found: true, changed: true, reason: "updated", anime: updated, historyRecord: createWatchRecord(updated, nextEpisode - current, at), total };
    }

    function commitAnimeProgress(storage, list, history, id, delta = 1, at = new Date().toISOString()) {
        const result = updateAnimeProgress(list, id, delta, at);
        if (!result.changed) return { ...result, history: arrayOf(history) };
        const nextHistory = [...arrayOf(history), result.historyRecord];
        storage.setItem(STORAGE_KEY, JSON.stringify(result.list));
        storage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
        return { ...result, history: nextHistory };
    }

    function updateAnimeReviewProgress(list, id, delta = 1, at = new Date().toISOString()) {
        const targetId = String(id), change = Number(delta);
        const index = findAnimeRecordIndex(list, targetId);
        if (index < 0) return { list, found:false, changed:false, reason:"not-found", anime:null, historyRecord:null };
        const old = migrateAnime(list[index], at);
        const current = Math.max(0, numberOr(old.reviewWatched));
        const parsedTotal = Number(old.totalEpisodes ?? old.episodes);
        const total = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null;
        const requested = Math.max(0, current + (Number.isFinite(change) ? change : 0));
        const nextEpisode = total === null ? requested : Math.min(requested, total);
        if (nextEpisode === current) {
            return { list, found:true, changed:false, reason:change > 0 && total !== null && current >= total ? "at-total" : "unchanged", anime:old, historyRecord:null };
        }
        const updated = {
            ...old,
            reviewWatched:nextEpisode,
            reviewSessionActive:true,
            reviewStartedAt:old.reviewStartedAt || iso(at),
            updatedAt:iso(at),
            lastWatchedAt:change > 0 ? iso(at) : old.lastWatchedAt
        };
        const nextList = arrayOf(list).slice();
        nextList[index] = updated;
        return { list:nextList, found:true, changed:true, reason:"updated", anime:updated, historyRecord:createReviewWatchRecord(updated, nextEpisode - current, at), total };
    }

    function commitAnimeReviewProgress(storage, list, history, id, delta = 1, at = new Date().toISOString()) {
        const result = updateAnimeReviewProgress(list, id, delta, at);
        if (!result.changed) return { ...result, history:arrayOf(history) };
        const nextHistory = [...arrayOf(history), result.historyRecord];
        storage.setItem(STORAGE_KEY, JSON.stringify(result.list));
        storage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
        return { ...result, history:nextHistory };
    }

    function parseThemeSongText(text, type = "OP", sequence = 1) {
        const rawText = String(text || "").trim();
        const episodeMatch = rawText.match(/\((?:eps?\.?|episodes?)\s*(\d+)(?:\s*[-–—~]\s*(\d+))?\)/i);
        const episodeRange = episodeMatch ? (episodeMatch[2] ? `${episodeMatch[1]}–${episodeMatch[2]}` : episodeMatch[1]) : "";
        const withoutEpisodes = rawText.replace(/\((?:eps?\.?|episodes?)\s*\d+(?:\s*[-–—~]\s*\d+)?\)/ig, "").trim();
        const quoted = withoutEpisodes.match(/^["“「『](.*?)["”」』]\s+by\s+(.+)$/i);
        const plain = withoutEpisodes.match(/^(.+?)\s+by\s+(.+)$/i);
        const match = quoted || plain;
        const song = normalizeThemeSong({ title: match ? match[1].trim() : rawText, artist: match ? match[2].trim() : "", episodeRange, rawText, spotifyMatchStatus: "unmatched" }, type, sequence - 1);
        song.sequence = sequence;
        return song;
    }

    function extractSpotifyTrackId(value) {
        const clean = String(value || "").trim();
        const match = clean.match(/^spotify:track:([A-Za-z0-9]{22})$/) || clean.match(/^https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]{22})(?:[/?#].*)?$/i);
        return match ? match[1] : "";
    }

    function calculateSpotifyMatchScore(song, track) {
        const wantedTitle = normalizeSongTitle(song?.title), foundTitle = normalizeSongTitle(track?.name);
        const wantedArtist = normalizeArtistName(song?.artist);
        const foundArtists = arrayOf(track?.artists).map(artist => normalizeArtistName(typeof artist === "string" ? artist : artist?.name));
        let score = wantedTitle && foundTitle && wantedTitle === foundTitle ? 65 : wantedTitle && foundTitle && (wantedTitle.includes(foundTitle) || foundTitle.includes(wantedTitle)) ? 42 : 0;
        if (wantedArtist && foundArtists.some(artist => artist === wantedArtist || artist.includes(wantedArtist) || wantedArtist.includes(artist))) score += 30;
        const variantText = `${track?.name || ""} ${track?.album || ""}`;
        if (/\b(?:cover|karaoke|instrumental|remix)\b/i.test(variantText)) score -= 50;
        return Math.max(0, Math.min(100, score));
    }
    function selectSpotifyMatch(song, tracks, threshold = 75) {
        if (song?.manuallyCorrected) return { song, candidates: [], matched: false, preservedManual: true };
        const candidates = arrayOf(tracks).map(track => ({ ...track, matchScore: calculateSpotifyMatchScore(song, track) })).sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);
        const best = candidates[0];
        if (!best || best.matchScore < threshold) return { song: { ...song, spotifyMatchStatus: "candidates" }, candidates, matched: false };
        const id = extractSpotifyTrackId(best.spotifyUrl) || String(best.id || "");
        if (!/^[A-Za-z0-9]{22}$/.test(id)) return { song: { ...song, spotifyMatchStatus: "candidates" }, candidates, matched: false };
        return { song: { ...song, spotifyTrackId: id, spotifyUrl: `https://open.spotify.com/track/${id}`, spotifyEmbedUrl: `https://open.spotify.com/embed/track/${id}`, spotifyMatchStatus: "matched", spotifyMatchScore: best.matchScore, updatedAt: new Date().toISOString() }, candidates, matched: true };
    }
    function isSpecialMediaType(anime) { return /^(movie|ova|ona|special|short)$/i.test(String(anime?.mediaType || anime?.format || anime?.type || "")); }
    function mergeThemeSongs(existing, incoming) {
        const current = normalizeThemeSongs(existing), next = normalizeThemeSongs(incoming);
        const mergeGroup = (oldSongs, newSongs) => {
            const map = new Map(oldSongs.map(song => [song.id, song]));
            newSongs.forEach(song => { const old = map.get(song.id); if (!old || (!old.manuallyCorrected && Date.parse(song.updatedAt) >= Date.parse(old.updatedAt))) map.set(song.id, { ...old, ...song }); });
            return [...map.values()];
        };
        return { openings: mergeGroup(current.openings, next.openings), endings: mergeGroup(current.endings, next.endings) };
    }

    function validHttpUrl(value) {
        try { const url = new URL(String(value || "")); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; }
        catch { return ""; }
    }
    function normalizeEbookLinks(value) {
        return arrayOf(value).map(link => {
            const url = validHttpUrl(link?.url);
            if (!url) return null;
            return {
                ...link,
                platform:String(link?.platform || "其他").trim() || "其他",
                url,
                region:String(link?.region || "").trim(),
                language:String(link?.language || "").trim(),
                manuallyAdded:Boolean(link?.manuallyAdded)
            };
        }).filter(Boolean);
    }
    function nullableNumber(value) {
        return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    }
    function normalizeMediaEntry(entry, forcedType, now = new Date().toISOString()) {
        const mediaType = String(forcedType || entry?.mediaType || "anime").toLowerCase();
        const createdAt = iso(entry?.createdAt || entry?.addedAt || now);
        const manualTitle = hasManualAnimeTitle(entry);
        const commonTitle = localizedStoredTitle(entry?.title || "未命名作品", manualTitle);
        const common = {
            ...entry,
            id:entry?.id || uuid(),
            mediaType:["anime", "manga", "novel"].includes(mediaType) ? mediaType : "anime",
            title:commonTitle,
            aliases:localizedAliasList([entry?.title, commonTitle, ...arrayOf(entry?.aliases)]),
            status:String(entry?.status || "unknown").toLowerCase(),
            sourceId:String(entry?.sourceId ?? ""),
            sourceUrl:validHttpUrl(entry?.sourceUrl),
            relationType:String(entry?.relationType || "").toUpperCase(),
            createdAt,
            addedAt:iso(entry?.addedAt || createdAt),
            updatedAt:iso(entry?.updatedAt || createdAt),
            relationLocked:Boolean(entry?.relationLocked || entry?.manuallyLinked)
        };
        if (common.mediaType === "anime") return { ...migrateAnime(entry || {}, now), ...common, mediaType:"anime" };
        if (common.mediaType === "novel") return {
            ...common,
            author:String(entry?.author || ""),
            publisher:String(entry?.publisher || ""),
            totalVolumes:nullableNumber(entry?.totalVolumes ?? entry?.volumes),
            currentVolume:Math.max(0, numberOr(entry?.currentVolume)),
            rating:entry?.rating ?? null,
            notes:String(entry?.notes ?? entry?.note ?? ""),
            ebookLinks:normalizeEbookLinks(entry?.ebookLinks)
        };
        return {
            ...common,
            mediaType:"manga",
            status:["releasing", "finished", "hiatus", "cancelled", "unknown"].includes(common.status) ? common.status : "unknown",
            currentChapter:Math.max(0, numberOr(entry?.currentChapter)),
            totalChapters:nullableNumber(entry?.totalChapters ?? entry?.chapters),
            currentVolume:Math.max(0, numberOr(entry?.currentVolume)),
            totalVolumes:nullableNumber(entry?.totalVolumes ?? entry?.volumes),
            author:String(entry?.author || ""),
            publisher:String(entry?.publisher || ""),
            serialization:String(entry?.serialization || ""),
            lastChapterAt:entry?.lastChapterAt ? iso(entry.lastChapterAt) : null,
            nextChapterAt:entry?.nextChapterAt ? iso(entry.nextChapterAt) : null,
            reminderEnabled:Boolean(entry?.reminderEnabled),
            readingStatus:["planning", "reading", "completed", "paused", "dropped"].includes(String(entry?.readingStatus)) ? String(entry.readingStatus) : "planning",
            rating:entry?.rating ?? null,
            notes:String(entry?.notes ?? entry?.note ?? ""),
            lastReadAt:entry?.lastReadAt ? iso(entry.lastReadAt) : null,
            animeAdaptedToChapter:nullableNumber(entry?.animeAdaptedToChapter),
            animeAdaptedToVolume:nullableNumber(entry?.animeAdaptedToVolume),
            ebookLinks:normalizeEbookLinks(entry?.ebookLinks)
        };
    }
    function normalizeWork(work, now = new Date().toISOString()) {
        const entries = arrayOf(work?.mediaEntries).map(entry => normalizeMediaEntry(entry, entry?.mediaType, now));
        const createdAt = iso(work?.createdAt || entries[0]?.createdAt || now);
        const manualTitle = work?.titleManuallyEdited === true || work?.titleSource === "manual" || work?.manualTitle === true;
        const title = localizedStoredTitle(work?.title || entries[0]?.title || "未命名作品", manualTitle);
        return {
            ...work,
            workId:work?.workId || uuid(),
            title,
            aliases:localizedAliasList([work?.title, title, ...arrayOf(work?.aliases), ...entries.flatMap(entry => [entry.title, ...entry.aliases])]),
            mediaEntries:entries,
            createdAt,
            updatedAt:iso(work?.updatedAt || createdAt)
        };
    }
    function migrateWorks(animeList, existingWorks = [], now = new Date().toISOString()) {
        const works = arrayOf(existingWorks).map(work => normalizeWork(work, now));
        const mediaIndex = new Map();
        works.forEach(work => work.mediaEntries.forEach(entry => mediaIndex.set(`anime:${String(entry.id)}`, { work, entry })));
        arrayOf(animeList).forEach(rawAnime => {
            const anime = migrateAnime(rawAnime || {}, now);
            const externalId = anime.anilistId
                ?? anime.aniListId
                ?? (String(anime.source || "").toLowerCase() === "anilist" ? anime.sourceId : null);
            const key = `anime:${String(anime.id)}`;
            const found = mediaIndex.get(key);
            if (found) {
                const previousEntryTitle = found.entry.title;
                const refreshed = normalizeMediaEntry({
                    ...found.entry,
                    ...anime,
                    sourceId:String(externalId || found.entry.sourceId || ""),
                    createdAt:found.entry.createdAt,
                    mediaType:"anime"
                }, "anime", now);
                const index = found.work.mediaEntries.findIndex(entry => String(entry.id) === String(found.entry.id));
                found.work.mediaEntries[index] = refreshed;
                if (!found.work.title || (!found.work.titleManuallyEdited && found.work.title === previousEntryTitle)) found.work.title = anime.title;
                found.work.aliases = [...new Set([...found.work.aliases, anime.title, ...anime.aliases].filter(Boolean))];
                found.work.updatedAt = Date.parse(refreshed.updatedAt) > Date.parse(found.work.updatedAt) ? refreshed.updatedAt : found.work.updatedAt;
                return;
            }
            const entry = normalizeMediaEntry({ ...anime, mediaType:"anime", sourceId:String(externalId || anime.sourceId || anime.id) }, "anime", now);
            const work = normalizeWork({ workId:rawAnime?.workId || uuid(), title:anime.title, aliases:anime.aliases, mediaEntries:[entry], createdAt:anime.createdAt, updatedAt:anime.updatedAt }, now);
            works.push(work);
            mediaIndex.set(key, { work, entry });
        });
        return works;
    }
    function createStandaloneWork(mediaType, data = {}, now = new Date().toISOString()) {
        const entry = normalizeMediaEntry({ ...data, mediaType, id:data.id || uuid(), createdAt:data.createdAt || now, updatedAt:data.updatedAt || now }, mediaType, now);
        return normalizeWork({ workId:data.workId || uuid(), title:data.workTitle || entry.title, aliases:data.workAliases || entry.aliases, mediaEntries:[entry], createdAt:now, updatedAt:now }, now);
    }
    function addMediaEntry(works, workId, candidate, now = new Date().toISOString()) {
        const next = arrayOf(works).map(work => normalizeWork(work, now));
        const work = next.find(item => String(item.workId) === String(workId));
        if (!work) return { works, added:false, reason:"work-not-found", entry:null };
        const entry = normalizeMediaEntry({ ...candidate, id:candidate?.id || uuid(), relationLocked:Boolean(candidate?.relationLocked || candidate?.manuallyLinked), updatedAt:now }, candidate?.mediaType, now);
        const duplicate = work.mediaEntries.find(item => String(item.id) === String(entry.id) || (entry.sourceId && item.mediaType === entry.mediaType && String(item.sourceId) === String(entry.sourceId)));
        if (duplicate) return { works:next, added:false, reason:"duplicate", entry:duplicate };
        work.mediaEntries.push(entry); work.updatedAt = iso(now);
        work.aliases = [...new Set([...work.aliases, entry.title, ...entry.aliases].filter(Boolean))];
        return { works:next, added:true, reason:"added", entry };
    }
    function relationMediaNode(relation) { return relation?.node || relation?.entry || relation?.media || relation || {}; }
    function detectMangaCandidates(anime) {
        const candidates = new Map();
        arrayOf(anime?.relations).forEach(relation => {
            const node = relationMediaNode(relation);
            const relationType = String(relation?.relationType || relation?.relation_type || relation?.relation || node?.relationType || "").toUpperCase();
            const format = String(node?.format || node?.mediaType || node?.type || "").toUpperCase();
            const isManga = ["MANGA", "ONE_SHOT", "MANHWA", "MANHUA"].includes(format) || String(node?.mediaType || "").toLowerCase() === "manga";
            if (!isManga || !["ADAPTATION", "ALTERNATIVE", "SOURCE", "PARENT"].includes(relationType)) return;
            const titleObject = node?.title && typeof node.title === "object" ? node.title : {};
            const title = String(titleObject.native || titleObject.english || titleObject.romaji || node?.title || "").trim();
            if (!title) return;
            const aliases = [...new Set([titleObject.native, titleObject.english, titleObject.romaji, ...arrayOf(node?.synonyms)].filter(Boolean))];
            const staff = arrayOf(node?.staff?.edges || node?.authors || node?.staff);
            const author = staff.map(item => item?.node?.name?.full || item?.name || item?.node?.name).filter(Boolean).join("、");
            const score = relationType === "SOURCE" ? 100 : relationType === "ADAPTATION" ? 95 : relationType === "PARENT" ? 88 : 82;
            const key = String(node?.id || normalizeText(title));
            const candidate = normalizeMediaEntry({
                id:uuid(), mediaType:"manga", title, aliases, status:String(node?.status || "unknown").toLowerCase(),
                sourceId:String(node?.id || node?.mal_id || ""), sourceUrl:node?.siteUrl || node?.url || "", relationType,
                totalChapters:node?.chapters, totalVolumes:node?.volumes, author,
                publisher:node?.publisher || "", serialization:node?.serialization || "", dataSource:node?.dataSource || relation?.dataSource || "AniList relations",
                relationConfidence:score, relationLocked:true, manuallyLinked:true
            }, "manga");
            const old = candidates.get(key); if (!old || score > old.relationConfidence) candidates.set(key, candidate);
        });
        return [...candidates.values()].sort((a, b) => b.relationConfidence - a.relationConfidence || a.title.localeCompare(b.title));
    }
    function updateMangaProgress(works, mediaId, deltaChapters = 0, deltaVolumes = 0, at = new Date().toISOString()) {
        const next = arrayOf(works).map(work => normalizeWork(work, at));
        let targetWork = null, target = null;
        for (const work of next) { const entry = work.mediaEntries.find(item => item.mediaType === "manga" && String(item.id) === String(mediaId)); if (entry) { targetWork = work; target = entry; break; } }
        if (!target) return { works, found:false, changed:false, reason:"not-found", media:null, historyRecord:null };
        const oldChapter = target.currentChapter, oldVolume = target.currentVolume;
        const chapterRequested = Math.max(0, oldChapter + numberOr(deltaChapters));
        const volumeRequested = Math.max(0, oldVolume + numberOr(deltaVolumes));
        target.currentChapter = target.totalChapters === null ? chapterRequested : Math.min(chapterRequested, target.totalChapters);
        target.currentVolume = target.totalVolumes === null ? volumeRequested : Math.min(volumeRequested, target.totalVolumes);
        const actualChapters = target.currentChapter - oldChapter, actualVolumes = target.currentVolume - oldVolume;
        if (!actualChapters && !actualVolumes) return { works:next, found:true, changed:false, reason:numberOr(deltaChapters) > 0 && target.totalChapters !== null && oldChapter >= target.totalChapters ? "at-total" : "unchanged", media:target, historyRecord:null };
        target.updatedAt = iso(at); targetWork.updatedAt = iso(at);
        if (actualChapters > 0 || actualVolumes > 0) { target.lastReadAt = iso(at); if (target.readingStatus === "planning") target.readingStatus = "reading"; }
        if (target.totalChapters !== null && target.currentChapter >= target.totalChapters) target.readingStatus = "completed";
        const historyRecord = { id:uuid(), workId:targetWork.workId, mediaId:target.id, deltaChapters:actualChapters, deltaVolumes:actualVolumes, timestamp:iso(at) };
        return { works:next, found:true, changed:true, reason:"updated", work:targetWork, media:target, historyRecord };
    }
    function commitMangaProgress(storage, works, history, mediaId, deltaChapters = 0, deltaVolumes = 0, at = new Date().toISOString()) {
        const result = updateMangaProgress(works, mediaId, deltaChapters, deltaVolumes, at);
        if (!result.changed) return { ...result, history:arrayOf(history) };
        const nextHistory = [...arrayOf(history), result.historyRecord];
        storage.setItem(WORKS_KEY, JSON.stringify(result.works));
        storage.setItem(MANGA_HISTORY_KEY, JSON.stringify(nextHistory));
        return { ...result, history:nextHistory };
    }
    function mangaUpdateInfo(media, now = new Date()) {
        const manga = normalizeMediaEntry(media, "manga", now.toISOString());
        if (!manga.nextChapterAt) return { known:false, label:"更新時間未知，需人工設定", today:false, thisWeek:false, unread:false };
        const next = new Date(manga.nextChapterAt), weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
        const todayKey = date => date.toISOString().slice(0, 10);
        const released = next <= now;
        return { known:true, label:released ? "已更新但未閱讀" : todayKey(next) === todayKey(now) ? "今天更新" : next <= weekEnd ? "本週更新" : "已排定", today:todayKey(next) === todayKey(now), thisWeek:next <= weekEnd, unread:released && (!manga.lastReadAt || Date.parse(manga.lastReadAt) < next.getTime()), nextChapterAt:manga.nextChapterAt };
    }
    function adaptationProgress(media) {
        const manga = normalizeMediaEntry(media, "manga");
        if (manga.animeAdaptedToChapter === null && manga.animeAdaptedToVolume === null) return { confirmed:false, message:"改編進度尚未確認", remainingChapters:null };
        const remainingChapters = manga.animeAdaptedToChapter !== null && manga.currentChapter >= manga.animeAdaptedToChapter ? manga.currentChapter - manga.animeAdaptedToChapter : null;
        return { confirmed:true, animeAdaptedToChapter:manga.animeAdaptedToChapter, animeAdaptedToVolume:manga.animeAdaptedToVolume, mangaCurrentChapter:manga.currentChapter, remainingChapters };
    }
    function mangaStats(history, works, now = new Date()) {
        const records = arrayOf(history).filter(record => numberOr(record.deltaChapters) > 0);
        const dayKey = value => new Date(value).toISOString().slice(0, 10), today = dayKey(now), month = today.slice(0, 7);
        const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
        const sum = list => list.reduce((total, record) => total + numberOr(record.deltaChapters), 0);
        const manga = arrayOf(works).flatMap(work => arrayOf(work.mediaEntries)).filter(entry => entry.mediaType === "manga" && !entry.deletedAt).map(entry => normalizeMediaEntry(entry, "manga"));
        const platforms = manga.flatMap(entry => entry.ebookLinks.map(link => link.platform));
        const topPlatform = Object.entries(platforms.reduce((acc, platform) => (acc[platform] = (acc[platform] || 0) + 1, acc), {})).sort((a,b)=>b[1]-a[1])[0]?.[0] || "—";
        return { today:sum(records.filter(r => dayKey(r.timestamp) === today)), week:sum(records.filter(r => new Date(r.timestamp) >= weekStart)), month:sum(records.filter(r => dayKey(r.timestamp).startsWith(month))), total:sum(records), reading:manga.filter(x => x.readingStatus === "reading").length, completed:manga.filter(x => x.readingStatus === "completed").length, topPlatform };
    }
    function searchWorks(works, query = "", filters = {}) {
        const needle = normalizeText(query);
        return arrayOf(works).map(work => normalizeWork(work)).filter(work => {
            const entries = work.mediaEntries.filter(entry => !entry.deletedAt), types = new Set(entries.map(entry => entry.mediaType));
            if (!entries.length) return false;
            const searchable = normalizeText([work.title, ...work.aliases, ...entries.flatMap(entry => [entry.title, ...entry.aliases, entry.author, entry.publisher])].join(" "));
            if (needle && !searchable.includes(needle)) return false;
            if (filters.mediaType && !types.has(filters.mediaType)) return false;
            if (filters.readingStatus && !entries.some(entry => entry.mediaType === "manga" && entry.readingStatus === filters.readingStatus)) return false;
            if (filters.mangaStatus && !entries.some(entry => entry.mediaType === "manga" && entry.status === filters.mangaStatus)) return false;
            if (filters.hasAnime === true && !types.has("anime")) return false;
            if (filters.hasManga === true && !types.has("manga")) return false;
            if (filters.hasNovel === true && !types.has("novel")) return false;
            if (filters.reminder === true && !entries.some(entry => entry.mediaType === "manga" && entry.reminderEnabled)) return false;
            return true;
        });
    }

    function createBackup(data) {
        const anime = migrateList(data.animeList);
        const works = migrateWorks(anime, data.works || []);
        return {
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            [STORAGE_KEY]: anime,
            works,
            mediaEntries:works.flatMap(work => work.mediaEntries.map(entry => ({ ...entry, workId:work.workId }))),
            [MANGA_HISTORY_KEY]:arrayOf(data.mangaReadHistory),
            mangaReminders:works.flatMap(work => work.mediaEntries.filter(entry => entry.mediaType === "manga" && entry.reminderEnabled).map(entry => ({ workId:work.workId, mediaId:entry.id, nextChapterAt:entry.nextChapterAt }))),
            manualMediaRelations:works.flatMap(work => work.mediaEntries.filter(entry => entry.relationLocked).map(entry => ({ workId:work.workId, mediaId:entry.id, relationType:entry.relationType }))),
            eventOverrides: data.eventOverrides || {},
            eventAnimeOverrides:data.eventAnimeOverrides || {},
            settings: data.settings || {},
            watchHistory: arrayOf(data.watchHistory),
            reminders: data.reminders || {},
            preferences: data.preferences || {}
        };
    }

    function normalizeImportedBackup(input) {
        let value = input;
        if (typeof value === "string") {
            try { value = JSON.parse(value); }
            catch { throw new Error("備份不是有效的 JSON"); }
        }
        if (Array.isArray(value)) {
            return {
                schemaVersion: 8,
                exportedAt: null,
                [STORAGE_KEY]: value,
                works: [],
                mediaEntries: [],
                [MANGA_HISTORY_KEY]: [],
                eventOverrides: {},
                eventAnimeOverrides:{},
                settings: {},
                watchHistory: [],
                reminders: {},
                preferences: {},
                backupFormat: "舊版純陣列"
            };
        }
        if (!value || typeof value !== "object") throw new Error("備份內容必須是 JSON 物件或陣列");
        if (!Object.prototype.hasOwnProperty.call(value, STORAGE_KEY)) throw new Error(`缺少 ${STORAGE_KEY} 陣列`);
        let anime = value[STORAGE_KEY];
        if (typeof anime === "string") {
            try { anime = JSON.parse(anime); }
            catch { throw new Error(`${STORAGE_KEY} 不是合法的 JSON 陣列字串`); }
        }
        if (!Array.isArray(anime)) throw new Error(`${STORAGE_KEY} 必須是陣列或合法的陣列 JSON 字串`);
        let works = Array.isArray(value.works) ? value.works : [];
        if (!works.length && Array.isArray(value.mediaEntries)) {
            const grouped = new Map();
            value.mediaEntries.forEach(entry => {
                const workId = String(entry?.workId || ""); if (!workId) return;
                if (!grouped.has(workId)) grouped.set(workId, { workId, title:entry.title, aliases:entry.aliases, mediaEntries:[] });
                grouped.get(workId).mediaEntries.push(entry);
            });
            works = [...grouped.values()];
        }
        return {
            ...value,
            schemaVersion: value.schemaVersion ?? 8,
            exportedAt: value.exportedAt || null,
            [STORAGE_KEY]: anime,
            works,
            mediaEntries:Array.isArray(value.mediaEntries) ? value.mediaEntries : [],
            [MANGA_HISTORY_KEY]:Array.isArray(value[MANGA_HISTORY_KEY]) ? value[MANGA_HISTORY_KEY] : [],
            eventOverrides: value.eventOverrides && typeof value.eventOverrides === "object" && !Array.isArray(value.eventOverrides) ? value.eventOverrides : {},
            eventAnimeOverrides:value.eventAnimeOverrides && typeof value.eventAnimeOverrides === "object" && !Array.isArray(value.eventAnimeOverrides) ? value.eventAnimeOverrides : {},
            settings: value.settings && typeof value.settings === "object" && !Array.isArray(value.settings) ? value.settings : {},
            watchHistory: Array.isArray(value.watchHistory) ? value.watchHistory : [],
            reminders: value.reminders && typeof value.reminders === "object" ? value.reminders : {},
            preferences: value.preferences && typeof value.preferences === "object" ? value.preferences : {},
            backupFormat: "完整備份"
        };
    }

    function validateBackup(value) {
        try {
            const normalized = normalizeImportedBackup(value);
            const mediaEntries = normalized.works.flatMap(work => arrayOf(work.mediaEntries));
            return { valid: true, normalized, preview: { format: normalized.backupFormat, schemaVersion: normalized.schemaVersion, exportedAt: normalized.exportedAt, animeCount: normalized[STORAGE_KEY].length, workCount:normalized.works.length, mangaCount:mediaEntries.filter(entry => entry.mediaType === "manga").length, mangaHistoryCount:normalized[MANGA_HISTORY_KEY].length, overrideCount: Object.keys(normalized.eventOverrides).length, historyCount: normalized.watchHistory.length, requiresEmptyConfirmation: normalized[STORAGE_KEY].length === 0 && normalized.works.length === 0 } };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    function mergeById(local, incoming) {
        const map = new Map(migrateList(local).map(item => [String(item.id), item]));
        migrateList(incoming).forEach(item => {
            const old = map.get(String(item.id));
            if (!old) map.set(String(item.id), item);
            else if (Date.parse(item.updatedAt) >= Date.parse(old.updatedAt)) map.set(String(item.id), { ...old, ...item, themeSongs: mergeThemeSongs(old.themeSongs, item.themeSongs) });
            else map.set(String(item.id), { ...old, themeSongs: mergeThemeSongs(old.themeSongs, item.themeSongs) });
        });
        return [...map.values()];
    }

    function mergeWorks(local, incoming) {
        const map = new Map(arrayOf(local).map(work => { const normalized=normalizeWork(work); return [String(normalized.workId), normalized]; }));
        arrayOf(incoming).map(work => normalizeWork(work)).forEach(remote => {
            const current = map.get(String(remote.workId));
            if (!current) { map.set(String(remote.workId), remote); return; }
            const media = new Map(current.mediaEntries.map(entry => [String(entry.id), entry]));
            remote.mediaEntries.forEach(entry => {
                const old = media.get(String(entry.id)) || [...media.values()].find(item => entry.sourceId && item.mediaType === entry.mediaType && String(item.sourceId) === String(entry.sourceId));
                if (!old) { media.set(String(entry.id), entry); return; }
                if (old.relationLocked && !entry.relationLocked) return;
                if (Date.parse(entry.updatedAt) >= Date.parse(old.updatedAt)) media.set(String(old.id), { ...old, ...entry, id:old.id });
            });
            const newer = Date.parse(remote.updatedAt) >= Date.parse(current.updatedAt) ? remote : current;
            map.set(String(current.workId), normalizeWork({ ...current, ...newer, workId:current.workId, aliases:[...new Set([...current.aliases, ...remote.aliases])], mediaEntries:[...media.values()] }));
        });
        return [...map.values()];
    }

    function importBackup(current, backup, mode = "merge") {
        const normalized = normalizeImportedBackup(backup);
        const incomingRecovery = recoverLegacyAnimeIdentities(normalized[STORAGE_KEY], normalized, normalized.exportedAt || new Date().toISOString());
        const currentRecovery = recoverLegacyAnimeIdentities(current.animeList, current, new Date().toISOString());
        const incoming = migrateList(incomingRecovery.list);
        const currentAnime = migrateList(currentRecovery.list);
        const incomingWorks = migrateWorks(incoming, normalized.works);
        const result = {
            animeList: mode === "replace" ? incoming : mergeById(currentAnime, incoming),
            works:mode === "replace" ? incomingWorks : mergeWorks(migrateWorks(currentAnime, current.works || []), incomingWorks),
            mangaReadHistory:mode === "replace" ? normalized[MANGA_HISTORY_KEY] : [...arrayOf(current.mangaReadHistory), ...normalized[MANGA_HISTORY_KEY]],
            eventOverrides: mode === "replace" ? normalized.eventOverrides : { ...(current.eventOverrides || {}), ...normalized.eventOverrides },
            eventAnimeOverrides:mode === "replace" ? normalized.eventAnimeOverrides : { ...(current.eventAnimeOverrides || {}), ...normalized.eventAnimeOverrides },
            settings: mode === "replace" ? normalized.settings : { ...(current.settings || {}), ...normalized.settings },
            watchHistory: mode === "replace" ? normalized.watchHistory : [...arrayOf(current.watchHistory), ...normalized.watchHistory],
            reminders: { ...(mode === "replace" ? {} : current.reminders), ...normalized.reminders },
            preferences: { ...(mode === "replace" ? {} : current.preferences), ...normalized.preferences },
            importedAnimeCount: incoming.length,
            importedWorkCount:incomingWorks.length,
            backupFormat: normalized.backupFormat,
            legacyIdentityRecoveryCount:incomingRecovery.recoveredCount + (mode === "replace" ? 0 : currentRecovery.recoveredCount),
            legacyIdentityRecovery:{ incoming:incomingRecovery.report, current:currentRecovery.report }
        };
        const reconciled = reconcileExistingAnimeDuplicates(result.animeList, result);
        return { ...result, ...reconciled.state, animeList:reconciled.list, duplicateMergeCount:reconciled.mergedCount };
    }

    function searchFilterSort(list, query = "", filters = {}, sort = "watching-first", hasEvent = () => false) {
        const needle = normalizeText(query);
        const values = migrateList(list).filter(item => {
            const haystack = normalizeText([item.title, ...item.aliases, item.platform, ...item.tags, item.notes].join(" "));
            if (needle && !haystack.includes(needle)) return false;
            if (filters.status?.length && !filters.status.includes(item.category)) return false;
            if (filters.platform?.length && !filters.platform.some(x => normalizeText(item.platform).includes(normalizeText(x)))) return false;
            if (filters.tags?.length && !filters.tags.every(tag => item.tags.includes(tag))) return false;
            if (filters.year && String(item.year) !== String(filters.year)) return false;
            if (filters.season && item.season !== filters.season) return false;
            if (filters.hasEvents === true && !hasEvent(item)) return false;
            if (filters.hasNextSeason === true && !item.nextSeasonDate) return false;
            if (filters.unfinished === true && numberOr(item.currentEpisode) >= numberOr(item.totalEpisodes, Infinity)) return false;
            if (filters.stale === true && Date.now() - Date.parse(item.lastWatchedAt || item.createdAt) < 30 * 86400000) return false;
            if (filters.reminder === true && !item.reminderEnabled) return false;
            if (filters.rated === true && item.rating == null) return false;
            return !item.deletedAt;
        });
        const progress = item => numberOr(item.totalEpisodes) > 0 ? numberOr(item.currentEpisode) / numberOr(item.totalEpisodes) : 0;
        values.sort((a, b) => {
            if (sort === "watching-first") return Number(b.category === "watching") - Number(a.category === "watching") || Date.parse(b.lastWatchedAt || 0) - Date.parse(a.lastWatchedAt || 0);
            if (sort === "recent-watched") return Date.parse(b.lastWatchedAt || 0) - Date.parse(a.lastWatchedAt || 0);
            if (sort === "name") return a.title.localeCompare(b.title, "zh-Hant", { numeric: true });
            if (sort === "progress-desc") return progress(b) - progress(a);
            if (sort === "progress-asc") return progress(a) - progress(b);
            if (sort === "recent-added") return Date.parse(b.addedAt) - Date.parse(a.addedAt);
            return 0;
        });
        return values;
    }

    function applyBatch(list, ids, action, value, now = new Date().toISOString()) {
        const selected = new Set(arrayOf(ids).map(String));
        return migrateList(list).map(item => {
            if (!selected.has(String(item.id))) return item;
            const next = { ...item, updatedAt: iso(now) };
            if (action === "status") {
                next.category = next.status = value;
                next.categorySource = "manual";
                next.categoryManuallyEdited = true;
            }
            if (action === "platform") next.platform = next.customPlatform = value;
            if (action === "add-tag") next.tags = [...new Set([...next.tags, value].filter(Boolean))];
            if (action === "remove-tag") next.tags = next.tags.filter(tag => tag !== value);
            if (action === "reminder") next.reminderEnabled = Boolean(value);
            if (action === "complete") {
                next.category = "completed";
                next.categorySource = "manual";
                next.categoryManuallyEdited = true;
                next.currentEpisode = next.watched = numberOr(next.totalEpisodes, next.currentEpisode);
            }
            if (action === "delete") next.deletedAt = iso(now);
            return next;
        });
    }

    function watchStats(history, list, now = new Date()) {
        const records = arrayOf(history).filter(record => numberOr(record.delta) > 0);
        const dayKey = date => new Date(date).toISOString().slice(0, 10);
        const today = dayKey(now);
        const month = today.slice(0, 7);
        const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
        const sum = subset => subset.reduce((total, record) => total + numberOr(record.delta), 0);
        const activeDays = [...new Set(records.map(record => dayKey(record.at)))].sort().reverse();
        let streak = 0, cursor = new Date(now); cursor.setHours(0, 0, 0, 0);
        while (activeDays.includes(dayKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
        const trend = days => Array.from({ length: days }, (_, index) => { const date = new Date(now); date.setDate(date.getDate() - (days - 1 - index)); const key = dayKey(date); return { date: key, count: sum(records.filter(record => dayKey(record.at) === key)) }; });
        const active = migrateList(list).filter(item => !item.deletedAt);
        const ratings = active.map(item => Number(item.rating)).filter(Number.isFinite);
        const frequency = values => Object.entries(values.reduce((acc, value) => (value && (acc[value] = (acc[value] || 0) + 1), acc), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
        return { today: sum(records.filter(r => dayKey(r.at) === today)), week: sum(records.filter(r => new Date(r.at) >= weekStart)), month: sum(records.filter(r => dayKey(r.at).startsWith(month))), total: sum(records), completed: active.filter(x => x.category === "completed").length, watching: active.filter(x => x.category === "watching").length, averageRating: ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—", streak, topPlatform: frequency(active.map(x => x.platform)), topTag: frequency(active.flatMap(x => x.tags)), trend7: trend(7), trend30: trend(30) };
    }

    function resetWatchStatistics(storage, at = new Date().toISOString()) {
        let history = [];
        try { const parsed = JSON.parse(storage.getItem(HISTORY_KEY) || "[]"); history = Array.isArray(parsed) ? parsed : []; } catch { history = []; }
        const restorePoint = { createdAt: iso(at), history };
        storage.setItem(WATCH_RESET_UNDO_KEY, JSON.stringify(restorePoint));
        storage.setItem(HISTORY_KEY, "[]");
        return { reset: true, clearedCount: history.length, history: [], restorePoint };
    }

    function restoreWatchStatistics(storage) {
        let restorePoint = null;
        try { restorePoint = JSON.parse(storage.getItem(WATCH_RESET_UNDO_KEY) || "null"); } catch { restorePoint = null; }
        if (!restorePoint || !Array.isArray(restorePoint.history)) return { restored: false, history: [] };
        storage.setItem(HISTORY_KEY, JSON.stringify(restorePoint.history));
        storage.removeItem?.(WATCH_RESET_UNDO_KEY);
        return { restored: true, history: restorePoint.history, restoredCount: restorePoint.history.length };
    }

    function calendarItems(anime, events) {
        const items = [];
        migrateList(anime).forEach(item => {
            if (item.deletedAt) return;
            [[item.nextEpisodeAt, "episode", "下一集"], [item.releaseDate, "movie", "上映"], [item.nextSeasonDate, "season", "新一季"]].forEach(([date, type, label]) => { if (date) items.push({ date: iso(date).slice(0, 10), type, label, title: item.title, animeId: item.id }); });
        });
        arrayOf(events).forEach(event => {
            if (event.eventStartDate) items.push({ date: event.eventStartDate, type: "event-start", label: "活動開始", title: event.title, eventId: event.id });
            if (event.eventEndDate) items.push({ date: event.eventEndDate, type: "event-end", label: "活動結束", title: event.title, eventId: event.id });
        });
        return items.sort((a, b) => a.date.localeCompare(b.date));
    }

    function normalizeEventTitle(value) { return normalizeText(String(value || "").replace(/20\d{2}/g, "")); }
    function duplicateEventKey(event) {
        const title = normalizeEventTitle(event.title);
        const date = event.eventStartDate || "";
        const place = normalizeText(event.address || event.venue || event.venueName || "");
        const url = String(event.url || "").replace(/\?.*$/, "");
        return { title, date, place, url };
    }
    function areDuplicateEvents(a, b) {
        const A = duplicateEventKey(a), B = duplicateEventKey(b);
        const dateGap = A.date && B.date ? Math.abs(Date.parse(A.date) - Date.parse(B.date)) / 86400000 : Infinity;
        return Boolean((A.url && A.url === B.url) || (A.title && A.title === B.title && dateGap <= 3 && (!A.place || !B.place || A.place === B.place)));
    }
    function mergeDuplicateEvents(events) {
        const groups = [];
        arrayOf(events).forEach(event => {
            const group = groups.find(candidate => areDuplicateEvents(candidate.primary, event));
            if (group) group.sources.push(event); else groups.push({ primary: event, sources: [event] });
        });
        return groups.map(group => ({ ...group.primary, duplicateSources: group.sources.map(x => ({ title: x.title, url: x.url, source: x.source })).filter((x, i, all) => all.findIndex(y => y.url === x.url) === i), duplicateCount: group.sources.length }));
    }

    function eventMatchAliases(anime) {
        const aliases = [];
        const add = (value, kind) => {
            const raw = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
            const normalized = normalizeText(raw);
            if (normalized.length < 4 || aliases.some(item => item.normalized === normalized)) return;
            aliases.push({ raw, normalized, kind });
        };
        add(anime?.title, "title");
        const titleWithoutQualifier = String(anime?.title || "")
            .replace(/[（(][^）)]{1,80}[）)]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (titleWithoutQualifier !== String(anime?.title || "").trim()) add(titleWithoutQualifier, "title-base");
        arrayOf(anime?.aliases).forEach(alias => add(alias, "alias"));
        return aliases;
    }

    function isOfficialEventSourceTitle(event) {
        return event?.sourceTitleOfficial === true ||
            event?.officialSource === true ||
            event?.publisherSource === true ||
            event?.isOfficial === true ||
            /^(?:official|official-announcement|publisher|官方|官方公告|出版社)$/i.test(String(event?.sourceType || event?.sourceKind || "").trim());
    }

    function matchEventToAnime(event, anime, override = {}) {
        const eventTitle = String(event?.title || "");
        const animeTitle = String(anime?.title || "");
        const animeId = String(anime?.id ?? "");
        const workId = String(anime?.workId ?? "");
        const includeIds = new Set([...arrayOf(override?.includeAnimeIds), ...arrayOf(override?.includeMediaIds)].map(String));
        const excludeIds = new Set([...arrayOf(override?.excludeAnimeIds), ...arrayOf(override?.excludeMediaIds)].map(String));
        const includeWorkIds = new Set(arrayOf(override?.includeWorkIds).map(String));
        const excludeWorkIds = new Set(arrayOf(override?.excludeWorkIds).map(String));
        const reasons = [];
        const result = (matched, score, confidence) => ({
            eventTitle,
            animeTitle,
            mediaType:String(anime?.mediaType || "anime"),
            workId,
            matched,
            score,
            confidence,
            reasons
        });

        if (!event || !anime || !animeTitle) {
            reasons.push("missing-event-or-anime");
            return result(false, 0, "none");
        }
        if ((animeId && excludeIds.has(animeId)) || (workId && excludeWorkIds.has(workId))) {
            reasons.push("manual-exclude");
            return result(false, 0, "none");
        }
        if ((animeId && includeIds.has(animeId)) || (workId && includeWorkIds.has(workId))) {
            reasons.push("manual-include");
            return result(true, 100, "high");
        }

        const legacyIds = [event?.matchedAnimeIds, event?.relatedAnimeIds, event?.animeIds]
            .flatMap(arrayOf)
            .map(String);
        if (animeId && legacyIds.includes(animeId)) reasons.push("ignored-legacy-auto-relation");

        const aliases = eventMatchAliases(anime);
        const titleNormalized = normalizeText(eventTitle);
        const sourceTitleNormalized = normalizeText(event?.sourceTitle);
        const titleMatch = aliases.find(alias => titleNormalized.includes(alias.normalized));
        if (titleMatch) {
            reasons.push(`event-title-contains-${titleMatch.kind}`);
            return result(true, titleMatch.kind === "title" ? 100 : titleMatch.kind === "alias" ? 95 : 92, "high");
        }

        if (sourceTitleNormalized && isOfficialEventSourceTitle(event)) {
            const sourceMatch = aliases.find(alias => sourceTitleNormalized.includes(alias.normalized));
            if (sourceMatch) {
                reasons.push(`official-source-title-contains-${sourceMatch.kind}`);
                return result(true, sourceMatch.kind === "title" ? 95 : 90, "high");
            }
        } else if (sourceTitleNormalized) {
            reasons.push("ignored-non-official-source-title");
        }

        const secondaryText = normalizeText([event?.summary, event?.description, event?.snippet, event?.searchCorpus].filter(Boolean).join(" "));
        if (aliases.some(alias => secondaryText.includes(alias.normalized))) reasons.push("ignored-secondary-text-only-match");
        reasons.push("no-reliable-title-match");
        return result(false, 0, "none");
    }

    function filterEventsForAnime(events, anime, overrides = {}) {
        return arrayOf(events).filter(event => {
            const match = matchEventToAnime(event, anime, overrides?.[event?.id] || {});
            return match.matched === true && match.confidence === "high" && match.score >= 80;
        });
    }

    function mergeCloudPayload(local, cloud, choice = "merge") {
        const reconcilePayload = payload => {
            const recovery = recoverLegacyAnimeIdentities(payload?.animeList, payload || {}, new Date().toISOString());
            const recoveredPayload = { ...(payload || {}), animeList:recovery.list };
            const reconciled = reconcileExistingAnimeDuplicates(recovery.list, recoveredPayload);
            return { ...recoveredPayload, ...reconciled.state, animeList:reconciled.list, duplicateMergeCount:reconciled.mergedCount, legacyIdentityRecoveryCount:Number(payload?.legacyIdentityRecoveryCount || 0) + recovery.recoveredCount, legacyIdentityRecovery:recovery.report };
        };
        if (choice === "local") return reconcilePayload(local);
        if (choice === "cloud") return reconcilePayload(cloud);
        const recoveredLocal = recoverLegacyAnimeIdentities(local?.animeList, local || {}, new Date().toISOString());
        const recoveredCloud = recoverLegacyAnimeIdentities(cloud?.animeList, cloud || {}, new Date().toISOString());
        const localPayload = { ...(local || {}), animeList:recoveredLocal.list };
        const cloudPayload = { ...(cloud || {}), animeList:recoveredCloud.list };
        const historyMap = new Map([...arrayOf(localPayload.mangaReadHistory), ...arrayOf(cloudPayload.mangaReadHistory)].map(record => [String(record.id || `${record.workId}|${record.mediaId}|${record.timestamp}|${record.deltaChapters}|${record.deltaVolumes}`), record]));
        return reconcilePayload({ ...localPayload, ...cloudPayload, animeList: mergeById(localPayload.animeList, cloudPayload.animeList), works:mergeWorks(migrateWorks(localPayload.animeList, localPayload.works || []), migrateWorks(cloudPayload.animeList, cloudPayload.works || [])), mangaReadHistory:[...historyMap.values()], eventOverrides: { ...(localPayload.eventOverrides || {}), ...(cloudPayload.eventOverrides || {}) }, eventAnimeOverrides:{ ...(localPayload.eventAnimeOverrides || {}), ...(cloudPayload.eventAnimeOverrides || {}) }, settings: { ...(localPayload.settings || {}), ...(cloudPayload.settings || {}) }, watchHistory: [...arrayOf(localPayload.watchHistory), ...arrayOf(cloudPayload.watchHistory)], legacyIdentityRecoveryCount:recoveredLocal.recoveredCount + recoveredCloud.recoveredCount });
    }
    function pruneTombstones(list, now = Date.now()) { return migrateList(list).filter(item => !item.deletedAt || now - Date.parse(item.deletedAt) <= TOMBSTONE_DAYS * 86400000); }
    function purgeExpiredTombstones(list, state = {}, now = Date.now()) {
        const migrated = migrateList(list);
        const expired = migrated.filter(item => item.deletedAt && now - Date.parse(item.deletedAt) > TOMBSTONE_DAYS * 86400000);
        let nextState = { ...(state || {}) };
        expired.forEach(item => { nextState = cleanupAnimeAuxiliaryState(nextState, item.id); });
        return {
            list:migrated.filter(item => !expired.includes(item)),
            state:nextState,
            purgedIds:expired.map(item => item.id),
            changed:expired.length > 0
        };
    }
    function shouldCacheRequest(url) { const value = String(url || ""); return !/(supabase|auth\/v1|rest\/v1|cloudflare|workers\.dev|sync-api|api\.spotify\.com|accounts\.spotify\.com|open\.spotify\.com|jikan\.moe)/i.test(value); }

    return { SCHEMA_VERSION, STORAGE_KEY, HISTORY_KEY, WATCH_RESET_UNDO_KEY, RESTORE_KEY, SETTINGS_KEY, WORKS_KEY, MANGA_HISTORY_KEY, migrateAnime, migrateList, getAnimeTitlePresentation, getAnimeAniListIdentity, recoverLegacyAnimeIdentities, collectActiveAnimeAniListIds, legacyAnimeIdentityKey, isConservativeLegacyShadowMatch, describeAnimeIdentity, reconcileExistingAnimeDuplicates, ensureUniqueLocalAnimeIds, findAnimeRecordIndex, remapAnimeAuxiliaryState, updateAnimeTitleById, moveAnimeCategoryById, shouldDiscoverSequelAfterCategoryMove, markAnimeDeletedById, restoreAnimeById, removeAnimeIdFromOverrides, pruneAnimeIdOverrides, cleanupAnimeAuxiliaryState, captureAnimeAuxiliaryState, restoreAnimeAuxiliaryState, createCompactDeleteUndo, runAnimeDeleteTransaction, restoreDeleteUndoState, isStorageQuotaError, normalizeMediaEntry, normalizeWork, migrateWorks, createStandaloneWork, addMediaEntry, detectMangaCandidates, updateMangaProgress, commitMangaProgress, mangaUpdateInfo, adaptationProgress, mangaStats, searchWorks, normalizeEbookLinks, validHttpUrl, mergeWorks, normalizeThemeSong, normalizeThemeSongs, parseThemeSongText, normalizeSongTitle, normalizeArtistName, extractSpotifyTrackId, calculateSpotifyMatchScore, selectSpotifyMatch, isSpecialMediaType, mergeThemeSongs, createWatchRecord, createReviewWatchRecord, updateAnimeProgress, commitAnimeProgress, updateAnimeReviewProgress, commitAnimeReviewProgress, createBackup, normalizeImportedBackup, validateBackup, importBackup, mergeById, searchFilterSort, applyBatch, watchStats, resetWatchStatistics, restoreWatchStatistics, calendarItems, areDuplicateEvents, mergeDuplicateEvents, matchEventToAnime, filterEventsForAnime, mergeCloudPayload, pruneTombstones, purgeExpiredTombstones, shouldCacheRequest, normalizeText, toTraditionalChinese, hasManualAnimeTitle, isSafeAnimeSeriesRelation, buildAnimeSeriesIdentity, assignAnimeSeriesIdentity, getAnimeSeriesKey };
});
