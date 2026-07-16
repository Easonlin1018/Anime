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
        const common = {
            ...entry,
            id:entry?.id || uuid(),
            mediaType:["anime", "manga", "novel"].includes(mediaType) ? mediaType : "anime",
            title:String(entry?.title || "未命名作品"),
            aliases:[...new Set([entry?.title, ...arrayOf(entry?.aliases)].filter(Boolean))],
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
        return {
            ...work,
            workId:work?.workId || uuid(),
            title:String(work?.title || entries[0]?.title || "未命名作品"),
            aliases:[...new Set([work?.title, ...arrayOf(work?.aliases), ...entries.flatMap(entry => [entry.title, ...entry.aliases])].filter(Boolean))],
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
            const key = `anime:${String(anime.id)}`;
            const found = mediaIndex.get(key);
            if (found) {
                const refreshed = normalizeMediaEntry({ ...found.entry, ...anime, createdAt:found.entry.createdAt, mediaType:"anime" }, "anime", now);
                const index = found.work.mediaEntries.findIndex(entry => String(entry.id) === String(found.entry.id));
                found.work.mediaEntries[index] = refreshed;
                found.work.title ||= anime.title;
                found.work.aliases = [...new Set([...found.work.aliases, anime.title, ...anime.aliases].filter(Boolean))];
                found.work.updatedAt = Date.parse(refreshed.updatedAt) > Date.parse(found.work.updatedAt) ? refreshed.updatedAt : found.work.updatedAt;
                return;
            }
            const entry = normalizeMediaEntry({ ...anime, mediaType:"anime", sourceId:String(anime.sourceId || anime.id) }, "anime", now);
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
        const manga = arrayOf(works).flatMap(work => arrayOf(work.mediaEntries)).filter(entry => entry.mediaType === "manga").map(entry => normalizeMediaEntry(entry, "manga"));
        const platforms = manga.flatMap(entry => entry.ebookLinks.map(link => link.platform));
        const topPlatform = Object.entries(platforms.reduce((acc, platform) => (acc[platform] = (acc[platform] || 0) + 1, acc), {})).sort((a,b)=>b[1]-a[1])[0]?.[0] || "—";
        return { today:sum(records.filter(r => dayKey(r.timestamp) === today)), week:sum(records.filter(r => new Date(r.timestamp) >= weekStart)), month:sum(records.filter(r => dayKey(r.timestamp).startsWith(month))), total:sum(records), reading:manga.filter(x => x.readingStatus === "reading").length, completed:manga.filter(x => x.readingStatus === "completed").length, topPlatform };
    }
    function searchWorks(works, query = "", filters = {}) {
        const needle = normalizeText(query);
        return arrayOf(works).map(work => normalizeWork(work)).filter(work => {
            const entries = work.mediaEntries, types = new Set(entries.map(entry => entry.mediaType));
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
        const incoming = migrateList(normalized[STORAGE_KEY]);
        const incomingWorks = migrateWorks(incoming, normalized.works);
        return {
            animeList: mode === "replace" ? incoming : mergeById(current.animeList, incoming),
            works:mode === "replace" ? incomingWorks : mergeWorks(migrateWorks(current.animeList, current.works || []), incomingWorks),
            mangaReadHistory:mode === "replace" ? normalized[MANGA_HISTORY_KEY] : [...arrayOf(current.mangaReadHistory), ...normalized[MANGA_HISTORY_KEY]],
            eventOverrides: mode === "replace" ? normalized.eventOverrides : { ...(current.eventOverrides || {}), ...normalized.eventOverrides },
            eventAnimeOverrides:mode === "replace" ? normalized.eventAnimeOverrides : { ...(current.eventAnimeOverrides || {}), ...normalized.eventAnimeOverrides },
            settings: mode === "replace" ? normalized.settings : { ...(current.settings || {}), ...normalized.settings },
            watchHistory: mode === "replace" ? normalized.watchHistory : [...arrayOf(current.watchHistory), ...normalized.watchHistory],
            reminders: { ...(mode === "replace" ? {} : current.reminders), ...normalized.reminders },
            preferences: { ...(mode === "replace" ? {} : current.preferences), ...normalized.preferences },
            importedAnimeCount: incoming.length,
            importedWorkCount:incomingWorks.length,
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
        if (choice === "local") return local;
        if (choice === "cloud") return cloud;
        const historyMap = new Map([...arrayOf(local.mangaReadHistory), ...arrayOf(cloud.mangaReadHistory)].map(record => [String(record.id || `${record.workId}|${record.mediaId}|${record.timestamp}|${record.deltaChapters}|${record.deltaVolumes}`), record]));
        return { ...local, ...cloud, animeList: mergeById(local.animeList, cloud.animeList), works:mergeWorks(migrateWorks(local.animeList, local.works || []), migrateWorks(cloud.animeList, cloud.works || [])), mangaReadHistory:[...historyMap.values()], eventOverrides: { ...(local.eventOverrides || {}), ...(cloud.eventOverrides || {}) }, eventAnimeOverrides:{ ...(local.eventAnimeOverrides || {}), ...(cloud.eventAnimeOverrides || {}) }, settings: { ...(local.settings || {}), ...(cloud.settings || {}) }, watchHistory: [...arrayOf(local.watchHistory), ...arrayOf(cloud.watchHistory)] };
    }
    function pruneTombstones(list, now = Date.now()) { return migrateList(list).filter(item => !item.deletedAt || now - Date.parse(item.deletedAt) <= TOMBSTONE_DAYS * 86400000); }
    function shouldCacheRequest(url) { const value = String(url || ""); return !/(supabase|auth\/v1|rest\/v1|cloudflare|workers\.dev|sync-api|api\.spotify\.com|accounts\.spotify\.com|open\.spotify\.com|jikan\.moe)/i.test(value); }

    return { SCHEMA_VERSION, STORAGE_KEY, HISTORY_KEY, WATCH_RESET_UNDO_KEY, RESTORE_KEY, SETTINGS_KEY, WORKS_KEY, MANGA_HISTORY_KEY, migrateAnime, migrateList, normalizeMediaEntry, normalizeWork, migrateWorks, createStandaloneWork, addMediaEntry, detectMangaCandidates, updateMangaProgress, commitMangaProgress, mangaUpdateInfo, adaptationProgress, mangaStats, searchWorks, normalizeEbookLinks, validHttpUrl, mergeWorks, normalizeThemeSong, normalizeThemeSongs, parseThemeSongText, normalizeSongTitle, normalizeArtistName, extractSpotifyTrackId, calculateSpotifyMatchScore, selectSpotifyMatch, isSpecialMediaType, mergeThemeSongs, createWatchRecord, updateAnimeProgress, commitAnimeProgress, createBackup, normalizeImportedBackup, validateBackup, importBackup, mergeById, searchFilterSort, applyBatch, watchStats, resetWatchStatistics, restoreWatchStatistics, calendarItems, areDuplicateEvents, mergeDuplicateEvents, matchEventToAnime, filterEventsForAnime, mergeCloudPayload, pruneTombstones, shouldCacheRequest, normalizeText };
});
