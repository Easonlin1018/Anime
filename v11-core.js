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
        const totalRaw = item.totalEpisodes ?? item.episodes;
        const totalEpisodes = Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : totalRaw || null;
        const platform = item.platform || item.customPlatform || arrayOf(item.streamingLinks).map(link => link?.site).filter(Boolean).join("、");
        const createdAt = iso(item.createdAt || item.addedAt || now);
        return {
            ...item,
            id: item.id || uuid(),
            title: String(item.title || "未命名作品"),
            aliases: [...new Set([item.title, ...arrayOf(item.aliases)].filter(Boolean))],
            status: item.status || item.category || "backlog",
            category: item.category || item.status || "backlog",
            platform,
            customPlatform: item.customPlatform || platform || "",
            tags: arrayOf(item.tags || item.customTags),
            currentEpisode,
            watched: currentEpisode,
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
        return arrayOf(list).map(item => migrateAnime(item || {}, now));
    }

    function createWatchRecord(anime, delta, at = new Date().toISOString()) {
        return { id: uuid(), animeId: anime.id, title: anime.title, delta: numberOr(delta), episode: numberOr(anime.currentEpisode ?? anime.watched), at: iso(at), correction: numberOr(delta) < 0 };
    }

    function updateAnimeProgress(list, id, delta = 1, at = new Date().toISOString()) {
        const targetId = String(id), change = Number(delta);
        const index = arrayOf(list).findIndex(item => String(item?.id) === targetId);
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

    function createBackup(data) {
        return {
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            [STORAGE_KEY]: migrateList(data.animeList),
            eventOverrides: data.eventOverrides || {},
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
                eventOverrides: {},
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
        return {
            ...value,
            schemaVersion: value.schemaVersion ?? 8,
            exportedAt: value.exportedAt || null,
            [STORAGE_KEY]: anime,
            eventOverrides: value.eventOverrides && typeof value.eventOverrides === "object" && !Array.isArray(value.eventOverrides) ? value.eventOverrides : {},
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
            return { valid: true, normalized, preview: { format: normalized.backupFormat, schemaVersion: normalized.schemaVersion, exportedAt: normalized.exportedAt, animeCount: normalized[STORAGE_KEY].length, overrideCount: Object.keys(normalized.eventOverrides).length, historyCount: normalized.watchHistory.length, requiresEmptyConfirmation: normalized[STORAGE_KEY].length === 0 } };
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

    function importBackup(current, backup, mode = "merge") {
        const normalized = normalizeImportedBackup(backup);
        const incoming = migrateList(normalized[STORAGE_KEY]);
        return {
            animeList: mode === "replace" ? incoming : mergeById(current.animeList, incoming),
            eventOverrides: mode === "replace" ? normalized.eventOverrides : { ...(current.eventOverrides || {}), ...normalized.eventOverrides },
            settings: mode === "replace" ? normalized.settings : { ...(current.settings || {}), ...normalized.settings },
            watchHistory: mode === "replace" ? normalized.watchHistory : [...arrayOf(current.watchHistory), ...normalized.watchHistory],
            reminders: { ...(mode === "replace" ? {} : current.reminders), ...normalized.reminders },
            preferences: { ...(mode === "replace" ? {} : current.preferences), ...normalized.preferences },
            importedAnimeCount: incoming.length,
            backupFormat: normalized.backupFormat
        };
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
            if (action === "status") next.category = next.status = value;
            if (action === "platform") next.platform = next.customPlatform = value;
            if (action === "add-tag") next.tags = [...new Set([...next.tags, value].filter(Boolean))];
            if (action === "remove-tag") next.tags = next.tags.filter(tag => tag !== value);
            if (action === "reminder") next.reminderEnabled = Boolean(value);
            if (action === "complete") { next.category = "completed"; next.currentEpisode = next.watched = numberOr(next.totalEpisodes, next.currentEpisode); }
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

    function mergeCloudPayload(local, cloud, choice = "merge") {
        if (choice === "local") return local;
        if (choice === "cloud") return cloud;
        return { ...local, ...cloud, animeList: mergeById(local.animeList, cloud.animeList), eventOverrides: { ...(local.eventOverrides || {}), ...(cloud.eventOverrides || {}) }, settings: { ...(local.settings || {}), ...(cloud.settings || {}) }, watchHistory: [...arrayOf(local.watchHistory), ...arrayOf(cloud.watchHistory)] };
    }
    function pruneTombstones(list, now = Date.now()) { return migrateList(list).filter(item => !item.deletedAt || now - Date.parse(item.deletedAt) <= TOMBSTONE_DAYS * 86400000); }
    function shouldCacheRequest(url) { const value = String(url || ""); return !/(supabase|auth\/v1|rest\/v1|cloudflare|workers\.dev|sync-api|api\.spotify\.com|accounts\.spotify\.com|open\.spotify\.com|jikan\.moe)/i.test(value); }

    return { SCHEMA_VERSION, STORAGE_KEY, HISTORY_KEY, WATCH_RESET_UNDO_KEY, RESTORE_KEY, SETTINGS_KEY, migrateAnime, migrateList, normalizeThemeSong, normalizeThemeSongs, parseThemeSongText, normalizeSongTitle, normalizeArtistName, extractSpotifyTrackId, calculateSpotifyMatchScore, selectSpotifyMatch, isSpecialMediaType, mergeThemeSongs, createWatchRecord, updateAnimeProgress, commitAnimeProgress, createBackup, normalizeImportedBackup, validateBackup, importBackup, mergeById, searchFilterSort, applyBatch, watchStats, resetWatchStatistics, restoreWatchStatistics, calendarItems, areDuplicateEvents, mergeDuplicateEvents, mergeCloudPayload, pruneTombstones, shouldCacheRequest, normalizeText };
});
