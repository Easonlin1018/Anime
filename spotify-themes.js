(function () {
    "use strict";
    const V = window.AnimeTrackerV11;
    if (!V) return;
    const CACHE_KEY = "anime_theme_lookup_cache_v1";
    const UNDO_KEY = "anime_theme_last_undo_v1";
    const ANIMETHEMES = "https://api.animethemes.moe";
    const APPLE_MUSIC_METADATA = "https://itunes.apple.com";
    const JIKAN = "https://api.jikan.moe/v4";
    const ANIMETHEMES_NEGATIVE_TTL = 6 * 60 * 60 * 1000;
    const NATIVE_TITLE_POSITIVE_TTL = 30 * 86400000;
    const NATIVE_TITLE_NEGATIVE_TTL = 6 * 60 * 60 * 1000;
    const JIKAN_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
    const JIKAN_RETRY_DELAYS = [800, 1600];
    const MAX_RETRY_AFTER_MS = 5000;
    let currentAnime = null, currentContainer = null, controller = null, searchTimer = null, lookupGeneration = 0;
    const candidatesBySong = new Map();
    const automaticLookupAttempts = new Set();
    const cache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {}; } catch { return {}; } })();
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
    const button = (text, action) => { const node = element("button", "", text); node.type = "button"; node.addEventListener("click", action); return node; };
    const safeUrl = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } };
    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    const ttlFor = anime => /FINISHED|completed/i.test(`${anime.status} ${anime.category}`) ? 30 * 86400000 : /NOT_YET|waiting/i.test(`${anime.status} ${anime.category}`) ? 86400000 : 3 * 86400000;
    function cachedEntry(key) {
        const item = cache[key];
        return item && Date.now() - item.queriedAt < item.ttl ? { hit:true, value:item.value } : { hit:false, value:null };
    }
    function cached(key) { const entry = cachedEntry(key); return entry.hit ? entry.value : null; }
    function putCache(key, value, ttl) { cache[key] = { value, queriedAt: Date.now(), ttl }; saveCache(); }
    function abortPending() { clearTimeout(searchTimer); controller?.abort(); controller = null; lookupGeneration++; }
    function abortError() { const error = new Error("Aborted"); error.name = "AbortError"; return error; }
    function parseRetryAfterMs(response, now = Date.now()) {
        const value = String(response?.headers?.get?.("Retry-After") || "").trim();
        if (!value) return null;
        const seconds = Number(value);
        const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Number(now);
        return Number.isFinite(milliseconds) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, milliseconds)) : null;
    }
    function waitForRetry(delay, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError());
            const timer = setTimeout(done, Math.max(0, Number(delay) || 0));
            function done() { signal?.removeEventListener?.("abort", aborted); resolve(); }
            function aborted() { clearTimeout(timer); signal?.removeEventListener?.("abort", aborted); reject(abortError()); }
            signal?.addEventListener?.("abort", aborted, { once:true });
        });
    }
    function ensureRequestCurrent(options = {}) {
        if (options.signal?.aborted || (typeof options.isCurrent === "function" && !options.isCurrent())) throw abortError();
    }
    async function requestJikanJson(url, options = {}) {
        const signal = options.signal;
        const request = options.fetchImpl || fetch;
        const delays = Array.isArray(options.delays) ? options.delays : JIKAN_RETRY_DELAYS;
        const sleep = options.sleep || waitForRetry;
        const onRetry = options.onRetry;
        const requestedRetries = Number(options.maxRetries ?? 2);
        const maxRetries = Number.isFinite(requestedRetries) ? Math.min(2, Math.max(0, Math.floor(requestedRetries))) : 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (signal?.aborted) throw abortError();
            let response;
            try {
                response = await request(url, { signal, headers:{ Accept:"application/json" } });
            } catch (error) {
                if (error?.name === "AbortError" || signal?.aborted) throw abortError();
                if (attempt >= maxRetries) throw error;
                const retry = attempt + 1, delay = Number(delays[attempt] ?? 0);
                try { onRetry?.({ retry, maxRetries, status:0, delay, error }); } catch {}
                await sleep(delay, signal);
                continue;
            }
            if (response.ok) {
                const data = await response.json();
                ensureRequestCurrent(options);
                return data;
            }
            const error = new Error(`主題曲資料來源 HTTP ${response.status}`);
            error.status = response.status;
            if (!JIKAN_RETRYABLE_STATUSES.has(Number(response.status)) || attempt >= maxRetries) throw error;
            const retry = attempt + 1;
            const retryAfter = Number(response.status) === 429 ? parseRetryAfterMs(response, options.now?.() ?? Date.now()) : null;
            const delay = retryAfter ?? Number(delays[attempt] ?? 0);
            try { onRetry?.({ retry, maxRetries, status:Number(response.status), delay, error }); } catch {}
            await sleep(delay, signal);
        }
        throw new Error("主題曲資料來源重試失敗");
    }
    async function fetchJikanJson(url, options = {}) {
        return requestJikanJson(url, {
            ...options,
            onRetry:options.onRetry || (({ retry, maxRetries }) => setStatus(`主題曲資料來源暫時無回應，正在重試（${retry}/${maxRetries}）…`))
        });
    }
    function providerError(message, details = {}) {
        const error = new Error(message);
        Object.assign(error, { provider:"AnimeThemes", ...details });
        return error;
    }
    function nativeTitleError(message, details = {}) {
        const error = new Error(message);
        Object.assign(error, { provider:"Apple Music JP", ...details });
        return error;
    }
    function hasJapaneseTitle(value) {
        return /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(value || ""));
    }
    function nativeTitleCacheKey(song) {
        return `native-title:${encodeURIComponent(V.normalizeSongTitle(song?.title))}:${encodeURIComponent(V.normalizeArtistName(song?.artist))}`;
    }
    function appleMusicSearchUrl(term, attribute = "") {
        const params = new URLSearchParams({ term:String(term || ""), country:"JP", media:"music", entity:"song", limit:"10", lang:"ja_jp" });
        if (attribute) params.set("attribute", attribute);
        return `${APPLE_MUSIC_METADATA}/search?${params}`;
    }
    function appleMusicLookupUrl(trackId) {
        const params = new URLSearchParams({ id:String(trackId), country:"JP", entity:"song", lang:"ja_jp" });
        return `${APPLE_MUSIC_METADATA}/lookup?${params}`;
    }
    async function requestNativeTitleJson(url, options = {}) {
        ensureRequestCurrent(options);
        let response;
        try {
            response = await (options.nativeTitleFetchImpl || fetch)(url, { signal:options.signal, headers:{ Accept:"application/json" } });
        } catch (error) {
            if (error?.name === "AbortError" || options.signal?.aborted) throw abortError();
            throw nativeTitleError("歌曲原名資料來源網路錯誤", { cause:error, transient:true });
        }
        if (!response.ok) throw nativeTitleError(`歌曲原名資料來源 HTTP ${response.status}`, { status:Number(response.status), transient:[429, 500, 502, 503, 504].includes(Number(response.status)) });
        let data;
        try { data = await response.json(); }
        catch (error) { throw nativeTitleError("歌曲原名資料格式錯誤", { cause:error, malformed:true }); }
        ensureRequestCurrent(options);
        if (!data || typeof data !== "object" || !Array.isArray(data.results) || !Number.isFinite(Number(data.resultCount))) {
            throw nativeTitleError("歌曲原名資料結構不符合預期", { malformed:true });
        }
        return data;
    }
    function putNativeTitleCache(key, value, ttl) {
        try { putCache(key, value, ttl); } catch {}
    }
    function topAppleTrack(payload) {
        const item = payload?.results?.[0];
        return item && String(item.trackId || "") && String(item.trackName || "").trim() ? item : null;
    }
    async function lookupNativeThemeSongTitle(song, options = {}) {
        if (!song || song.manuallyCorrected || !String(song.title || "").trim()) return { song, skipped:true };
        if (hasJapaneseTitle(song.title)) return { song:{ ...song, nativeTitle:String(song.title).trim() }, matched:true, local:true };
        if (!String(song.artist || "").trim()) return { song, skipped:true, reason:"missing-artist" };
        const key = nativeTitleCacheKey(song), old = cachedEntry(key);
        if (old.hit) {
            if (old.value?.kind !== "native-title") return { song, matched:false, cached:true, reason:old.value?.reason || "not-found" };
            return { song:{ ...song, nativeTitle:old.value.nativeTitle, nativeTitleSource:"Apple Music JP", nativeTitleTrackId:String(old.value.trackId), nativeTitleSourceUrl:safeUrl(old.value.sourceUrl) }, matched:true, cached:true };
        }
        const combined = `${song.title} ${song.artist}`.trim();
        let payloads;
        try {
            payloads = await Promise.all([
                requestNativeTitleJson(appleMusicSearchUrl(combined), options),
                requestNativeTitleJson(appleMusicSearchUrl(song.title, "songTerm"), options),
                requestNativeTitleJson(appleMusicSearchUrl(song.artist, "artistTerm"), options)
            ]);
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            options.onNativeTitleFailure?.({ song, error });
            return { song, matched:false, failure:error };
        }
        const tops = payloads.map(topAppleTrack), ids = new Set(tops.filter(Boolean).map(item => String(item.trackId)));
        if (tops.some(item => !item) || ids.size !== 1) {
            ensureRequestCurrent(options);
            putNativeTitleCache(key, { kind:"not-found", reason:"ambiguous" }, NATIVE_TITLE_NEGATIVE_TTL);
            return { song, matched:false, reason:"ambiguous" };
        }
        const candidate = tops[0], trackId = String(candidate.trackId), nativeTitle = String(candidate.trackName || "").trim();
        if (!hasJapaneseTitle(nativeTitle)) {
            ensureRequestCurrent(options);
            putNativeTitleCache(key, { kind:"not-found", reason:"official-latin", trackId }, NATIVE_TITLE_NEGATIVE_TTL);
            return { song, matched:false, reason:"official-latin", trackId };
        }
        let lookup;
        try { lookup = await requestNativeTitleJson(appleMusicLookupUrl(trackId), options); }
        catch (error) {
            if (error?.name === "AbortError") throw error;
            options.onNativeTitleFailure?.({ song, error });
            return { song, matched:false, failure:error };
        }
        const verified = lookup.results.find(item => String(item?.trackId || "") === trackId);
        if (!verified || String(verified.trackName || "").trim() !== nativeTitle) {
            ensureRequestCurrent(options);
            putNativeTitleCache(key, { kind:"not-found", reason:"lookup-mismatch" }, NATIVE_TITLE_NEGATIVE_TTL);
            return { song, matched:false, reason:"lookup-mismatch" };
        }
        const value = { kind:"native-title", nativeTitle, trackId, sourceUrl:safeUrl(verified.trackViewUrl || candidate.trackViewUrl) };
        ensureRequestCurrent(options);
        putNativeTitleCache(key, value, NATIVE_TITLE_POSITIVE_TTL);
        return { song:{ ...song, nativeTitle, nativeTitleSource:"Apple Music JP", nativeTitleTrackId:trackId, nativeTitleSourceUrl:value.sourceUrl }, matched:true, trackId };
    }
    async function enrichThemeSongsWithNativeTitles(groups, options = {}) {
        const normalized = V.normalizeThemeSongs(groups), enriched = { openings:[], endings:[] };
        for (const key of ["openings", "endings"]) {
            for (const song of normalized[key]) {
                ensureRequestCurrent(options);
                const result = await lookupNativeThemeSongTitle(song, options);
                enriched[key].push(result.song || song);
            }
        }
        return V.normalizeThemeSongs(enriched);
    }
    async function requestAnimeThemesJson(url, options = {}) {
        const signal = options.signal;
        if (signal?.aborted) throw abortError();
        let response;
        try {
            response = await (options.fetchImpl || fetch)(url, { signal, headers:{ Accept:"application/json" } });
        } catch (error) {
            if (error?.name === "AbortError" || signal?.aborted) throw abortError();
            throw providerError("AnimeThemes 網路請求失敗", { cause:error, transient:true });
        }
        if (response.status === 404) { ensureRequestCurrent(options); return { notFound:true, status:404, data:null }; }
        if (!response.ok) throw providerError(`AnimeThemes HTTP ${response.status}`, { status:Number(response.status), transient:[429, 500, 502, 503, 504].includes(Number(response.status)) });
        let data;
        try { data = await response.json(); }
        catch (error) { throw providerError("AnimeThemes 回應格式錯誤", { cause:error, malformed:true }); }
        ensureRequestCurrent(options);
        if (!data || typeof data !== "object" || !Array.isArray(data.anime)) throw providerError("AnimeThemes 回應結構不符合預期", { malformed:true });
        return { notFound:false, status:Number(response.status), data };
    }
    function animeThemesSequence(theme, fallback) {
        const native = Number(theme?.sequence);
        if (Number.isSafeInteger(native) && native > 0) return native;
        const slug = String(theme?.slug || "").match(/(?:OP|ED)\s*(\d+)/i);
        return slug ? Number(slug[1]) : fallback;
    }
    function normalizeAnimeThemesSongs(payload, at = new Date().toISOString()) {
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.anime)) throw providerError("AnimeThemes 回應結構不符合預期", { malformed:true });
        const anime = payload.anime[0] || null;
        if (!anime) return { anime:null, songs:{ openings:[], endings:[] }, themeCount:0 };
        if (!Array.isArray(anime.animethemes)) throw providerError("AnimeThemes 主題曲結構不符合預期", { malformed:true });
        const groups = { openings:[], endings:[] }, sequenceCounts = { OP:0, ED:0 };
        anime.animethemes.forEach(theme => {
            const type = String(theme?.type || "").toUpperCase();
            if (!Object.prototype.hasOwnProperty.call(sequenceCounts, type)) return;
            const song = theme?.song;
            if (!song || typeof song !== "object" || !String(song.title || "").trim()) return;
            sequenceCounts[type]++;
            const artists = Array.isArray(song.artists) ? song.artists.map(artist => String(artist?.name || "").trim()).filter(Boolean) : [];
            const normalized = V.normalizeThemeSong({
                type,
                sequence:animeThemesSequence(theme, sequenceCounts[type]),
                title:String(song.title).trim(),
                artist:artists.join("、"),
                sourceName:"AnimeThemes",
                sourceUrl:"",
                updatedAt:at
            }, type, sequenceCounts[type] - 1);
            groups[type === "OP" ? "openings" : "endings"].push(normalized);
        });
        return { anime, songs:V.normalizeThemeSongs(groups), themeCount:anime.animethemes.length };
    }
    function animeThemesUrl(anilistId) {
        const params = new URLSearchParams({
            "filter[has]":"resources",
            "filter[site]":"AniList",
            "filter[external_id]":String(anilistId),
            include:"animethemes.song.artists"
        });
        return `${ANIMETHEMES}/anime?${params}`;
    }
    async function fetchAnimeThemesThemeSongs(anime, options = {}) {
        ensureRequestCurrent(options);
        const anilistId = V.getAnimeAniListIdentity(anime);
        if (!anilistId) return { provider:"AnimeThemes", skipped:true, reason:"missing-anilist-id", selected:false, songs:null };
        const key = `animethemes:${anilistId}`, old = cachedEntry(key);
        if (old.hit) {
            if (old.value?.kind !== "songs") return { provider:"AnimeThemes", selected:false, notFound:true, cached:true, anilistId, songs:null };
            const songs = await enrichThemeSongsWithNativeTitles(old.value.songs, options);
            return { provider:"AnimeThemes", selected:true, cached:true, anilistId, ...old.value, songs };
        }
        const response = await requestAnimeThemesJson(animeThemesUrl(anilistId), options);
        if (response.notFound || !response.data.anime.length) {
            putCache(key, { kind:"not-found" }, ANIMETHEMES_NEGATIVE_TTL);
            return { provider:"AnimeThemes", selected:false, notFound:true, anilistId, songs:null };
        }
        const normalized = normalizeAnimeThemesSongs(response.data, options.now?.() || new Date().toISOString());
        ensureRequestCurrent(options);
        if (!normalized.songs.openings.length && !normalized.songs.endings.length) {
            putCache(key, { kind:"no-themes", animeTitle:normalized.anime?.name || "" }, ANIMETHEMES_NEGATIVE_TTL);
            return { provider:"AnimeThemes", selected:false, notFound:true, anilistId, animeTitle:normalized.anime?.name || "", themeCount:normalized.themeCount, songs:null };
        }
        const songs = await enrichThemeSongsWithNativeTitles(normalized.songs, options);
        const value = { kind:"songs", songs, animeTitle:normalized.anime?.name || "", themeCount:normalized.themeCount };
        putCache(key, value, ttlFor(anime));
        return { provider:"AnimeThemes", selected:true, anilistId, ...value };
    }
    function mediaType(anime) { return String(anime.mediaType || anime.format || anime.type || "TV").toUpperCase(); }
    function candidateScore(anime, candidate) {
        const wanted = [anime.title, ...(anime.aliases || [])].map(V.normalizeText).filter(Boolean);
        const titles = [candidate.title, candidate.title_english, candidate.title_japanese, ...(candidate.title_synonyms || [])].map(V.normalizeText).filter(Boolean);
        let score = wanted.some(a => titles.includes(a)) ? 65 : wanted.some(a => titles.some(b => a.includes(b) || b.includes(a))) ? 45 : 0;
        if (anime.year && candidate.year && Number(anime.year) === Number(candidate.year)) score += 15;
        if (mediaType(anime) === String(candidate.type || "").toUpperCase()) score += 15;
        if (anime.totalEpisodes && candidate.episodes && Number(anime.totalEpisodes) === Number(candidate.episodes)) score += 5;
        return score;
    }
    async function findAnimeThemeSource(anime, options = {}) {
        ensureRequestCurrent(options);
        if (anime.malId) return { selected: { mal_id: Number(anime.malId) }, candidates: [], confident: true };
        const key = `source:${anime.id}`, old = cached(key); if (old) return old;
        const queries = [...new Set([anime.title, ...(anime.aliases || []), anime.titleJapanese, anime.titleEnglish].filter(Boolean))].slice(0, 4);
        const found = new Map();
        for (const query of queries) {
            const data = await fetchJikanJson(`${JIKAN}/anime?q=${encodeURIComponent(query)}&limit=5&sfw=true`, options);
            ensureRequestCurrent(options);
            (data.data || []).forEach(item => found.set(item.mal_id, item));
            if (found.size >= 8) break;
        }
        const candidates = [...found.values()].map(item => ({ ...item, matchScore: candidateScore(anime, item) })).sort((a, b) => b.matchScore - a.matchScore);
        const confident = Boolean(candidates[0] && candidates[0].matchScore >= 70 && (!candidates[1] || candidates[0].matchScore - candidates[1].matchScore >= 10));
        const result = { selected: confident ? candidates[0] : null, candidates: candidates.slice(0, 5), confident };
        ensureRequestCurrent(options);
        putCache(key, result, ttlFor(anime)); return result;
    }
    async function fetchJikanThemeSongs(anime, chosenMalId, options = {}) {
        const source = chosenMalId ? { selected: { mal_id: Number(chosenMalId) }, confident: true, candidates: [] } : await findAnimeThemeSource(anime, options);
        if (!source.selected) return source;
        const malId = Number(source.selected.mal_id), key = `themes:${malId}`, old = cached(key);
        if (old) return { ...source, songs:await enrichThemeSongsWithNativeTitles(old, options), malId };
        const data = await fetchJikanJson(`${JIKAN}/anime/${malId}/full`, options);
        ensureRequestCurrent(options);
        const theme = data.data?.theme || {};
        const songs = {
            openings: (theme.openings || []).map((text, index) => ({ ...V.parseThemeSongText(text, "OP", index + 1), sourceName: "MyAnimeList via Jikan", sourceUrl: `https://myanimelist.net/anime/${malId}`, updatedAt: new Date().toISOString() })),
            endings: (theme.endings || []).map((text, index) => ({ ...V.parseThemeSongText(text, "ED", index + 1), sourceName: "MyAnimeList via Jikan", sourceUrl: `https://myanimelist.net/anime/${malId}`, updatedAt: new Date().toISOString() }))
        };
        ensureRequestCurrent(options);
        const enrichedSongs = await enrichThemeSongsWithNativeTitles(songs, options);
        ensureRequestCurrent(options);
        putCache(key, enrichedSongs, ttlFor(anime)); return { ...source, songs:enrichedSongs, malId };
    }
    async function fetchAnimeThemeSongs(anime, chosenMalId, options = {}) {
        let primary = null, primaryFailure = null;
        if (!chosenMalId) {
            try {
                primary = await fetchAnimeThemesThemeSongs(anime, options);
                if (primary.selected) return primary;
            } catch (error) {
                if (error?.name === "AbortError") throw error;
                primaryFailure = error;
                options.onProviderFallback?.({ provider:"AnimeThemes", error });
            }
        }
        try {
            const fallback = await fetchJikanThemeSongs(anime, chosenMalId, options);
            return { ...fallback, provider:"Jikan", primary, primaryFailure };
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            const combined = new Error("主題曲資料來源目前無法使用，請稍後再試");
            combined.providerFailures = [primaryFailure, error].filter(Boolean);
            throw combined;
        }
    }
    function rememberUndo(anime) { localStorage.setItem(UNDO_KEY, JSON.stringify({ animeId: anime.id, themeSongs: anime.themeSongs, at: new Date().toISOString() })); }
    function persist(anime) { const id=String(anime.id),container=currentContainer,expanded=Boolean(container?.querySelector("details.theme-details")?.open); anime.themeSongs = V.normalizeThemeSongs(anime.themeSongs); anime.updatedAt = new Date().toISOString(); saveAndRender(); const fresh=animeList.find(item=>String(item.id)===id)||anime; renderForAnime(fresh, container, { expanded }); }
    function restoreUndo() { try { const undo = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); if (!undo || String(undo.animeId) !== String(currentAnime.id)) return setStatus("沒有此作品可復原的主題曲修改"); currentAnime.themeSongs = undo.themeSongs; localStorage.removeItem(UNDO_KEY); persist(currentAnime); setStatus("已復原上一次主題曲修改"); } catch { setStatus("復原資料損壞"); } }
    function setStatus(message) { const box = currentContainer?.querySelector(".theme-status"); if (box) box.textContent = message; }
    function allSongs(anime) { return [...anime.themeSongs.openings, ...anime.themeSongs.endings]; }
    function songGroup(anime, type) { return type === "OP" ? anime.themeSongs.openings : anime.themeSongs.endings; }
    function findSong(id) { return allSongs(currentAnime).find(song => song.id === id); }
    function hasThemeSongData(anime) { return allSongs({ themeSongs:V.normalizeThemeSongs(anime?.themeSongs) }).length > 0; }
    function themeSongStatus(anime, online = navigator.onLine !== false) {
        const count = allSongs({ themeSongs:V.normalizeThemeSongs(anime?.themeSongs) }).length;
        if (!online) return "目前離線，顯示已儲存的主題曲資料";
        return count ? `已載入 ${count} 首主題曲` : "尚未載入主題曲資料";
    }
    function automaticLookupKey(anime) { return `local:${String(anime?.id || "unknown")}`; }
    function claimAutomaticLookup(anime, online = navigator.onLine !== false) {
        if (!online || hasThemeSongData(anime)) return false;
        const key = automaticLookupKey(anime);
        if (automaticLookupAttempts.has(key)) return false;
        automaticLookupAttempts.add(key);
        return true;
    }
    function spotifyProviderConfigured() { return Boolean(String(window.SPOTIFY_THEME_CONFIG?.workerUrl || "").trim()); }
    function beginThemeLookup(anime) {
        abortPending();
        const activeController = new AbortController();
        controller = activeController;
        const context = { controller:activeController, signal:activeController.signal, generation:++lookupGeneration, animeId:String(anime?.id || "") };
        return context;
    }
    function isThemeLookupCurrent(context, anime) {
        return Boolean(context && !context.signal.aborted && context.controller === controller && context.generation === lookupGeneration
            && context.animeId === String(anime?.id || ""));
    }
    function finishThemeLookup(context) { if (controller === context?.controller) controller = null; }
    function applyThemeLookupResult(anime, result, context) {
        if (!isThemeLookupCurrent(context, anime)) return false;
        if (result?.malId) anime.malId = result.malId;
        anime.themeSongs = V.mergeThemeSongs(anime.themeSongs, result?.songs);
        return true;
    }

    function renderForAnime(anime, container, options = {}) {
        if (!container) return;
        if (currentAnime && String(currentAnime.id) !== String(anime?.id)) abortPending();
        currentAnime = anime; currentAnime.themeSongs = V.normalizeThemeSongs(currentAnime.themeSongs); currentContainer = container;
        container.replaceChildren();
        const details = element("details", "theme-details");
        details.append(element("summary", "theme-summary", "🎵 主題曲 OP／ED"));
        const status = element("div", "event-status theme-status", themeSongStatus(currentAnime)); details.append(status);
        const actions = element("div", "v11-toolbar");
        actions.append(button("重新搜尋主題曲", () => autoFind(true)), button("人工新增", () => openEditor(null)), button("復原上一次修改", restoreUndo));
        details.append(actions);
        const content = element("div", "theme-content"); details.append(content);
        details.addEventListener("toggle", () => {
            if (!details.open) return content.replaceChildren();
            renderSongContent(content);
            void maybeAutoLoadThemeSongs();
        });
        if (options.expanded) {
            details.open = true;
            renderSongContent(content);
        }
        container.append(details);
    }
    function renderSongContent(content) {
        content.replaceChildren();
        const songs = allSongs(currentAnime);
        if (!songs.length) {
            const special = V.isSpecialMediaType(currentAnime);
            content.append(element("div", "empty", special ? "尚未找到此特別篇專屬的 OP／ED" : "尚未找到此作品的 OP／ED"));
            if (special && currentAnime.relations?.length) content.append(element("div", "tiny-note", "可查看關聯本傳的主題曲，但不會自動保存至此作品。"));
            return;
        }
        [["片頭曲 OP", currentAnime.themeSongs.openings], ["片尾曲 ED", currentAnime.themeSongs.endings]].forEach(([label, group]) => {
            const section = element("section", "theme-group"); section.append(element("h3", "", label));
            if (!group.length) section.append(element("div", "empty", "尚無資料")); else group.slice().sort((a, b) => a.sequence - b.sequence).forEach(song => section.append(renderSong(song)));
            content.append(section);
        });
    }
    function renderSong(song) {
        const card = element("article", "v11-card theme-song");
        card.dataset.songId = song.id;
        card.append(element("strong", "theme-song-label", `${song.type} ${song.sequence}`), element("div", "theme-song-title", song.nativeTitle || song.title || song.rawText || "未命名歌曲"));
        if (song.artist) card.append(element("div", "theme-song-artist", song.artist));
        if (song.episodeRange) card.append(element("div", "anime-meta", `使用集數：${song.episodeRange}`));
        if (song.manuallyCorrected) card.append(element("span", "v11-badge good", "已人工修正"));
        const sourceUrl = safeUrl(song.sourceUrl); if (song.sourceName || sourceUrl) { const row = element("div", "anime-meta", "資料來源："); if (sourceUrl) { const link = element("a", "platform-link", song.sourceName || "來源"); link.href = sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); } else row.append(document.createTextNode(song.sourceName)); card.append(row); }
        const actions = element("div", "v11-toolbar");
        actions.append(button("編輯", () => openEditor(song)), button("刪除歌曲", () => deleteSong(song)));
        card.append(actions);
        const spotify = renderSpotifyEnhancement(song); if (spotify) card.append(spotify);
        return card;
    }
    function renderSpotifyEnhancement(song) {
        const hasTrack = /^[A-Za-z0-9]{22}$/.test(String(song.spotifyTrackId || ""));
        if (!hasTrack && !spotifyProviderConfigured()) return null;
        const details = element("details", "theme-spotify-options");
        details.append(element("summary", "", hasTrack ? "Spotify 播放" : "Spotify（選用）"));
        if (hasTrack) {
            const frame = document.createElement("iframe"); frame.width = "100%"; frame.height = "152"; frame.loading = "lazy"; frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"; frame.title = `${song.title || song.type} Spotify 播放器`; frame.src = `https://open.spotify.com/embed/track/${song.spotifyTrackId}`; frame.setAttribute("allowfullscreen", ""); details.append(frame);
            const link = element("a", "event-link", "在 Spotify 開啟"); link.href = `https://open.spotify.com/track/${song.spotifyTrackId}`; link.target = "_blank"; link.rel = "noopener noreferrer"; details.append(link);
        }
        const status = element("div", "tiny-note spotify-status", song.unavailableOnSpotify ? "Spotify 尚無可用版本" : ""); details.append(status);
        const actions = element("div", "v11-toolbar");
        if (spotifyProviderConfigured()) actions.append(button("選擇 Spotify 版本", () => searchSpotify(song, true)), button("標記 Spotify 無此歌曲", () => markUnavailable(song)));
        if (hasTrack) actions.append(button("移除 Spotify 配對", () => clearMatch(song)));
        if (actions.childNodes.length) details.append(actions);
        const candidates = candidatesBySong.get(song.id); if (candidates?.length) details.append(renderCandidates(song, candidates));
        return details;
    }
    function setSpotifyStatus(song, message) {
        const box = [...(currentContainer?.querySelectorAll(".theme-song") || [])]
            .find(node => String(node.dataset.songId) === String(song?.id))?.querySelector(".spotify-status");
        if (box) box.textContent = message;
    }
    function renderCandidates(song, tracks) { const box = element("div", "theme-candidates"); box.append(element("strong", "", "Spotify 候選版本")); tracks.slice(0, 5).forEach(track => { const row = element("div", "v11-card", `${track.name} — ${(track.artists || []).join("、")}（${track.matchScore ?? V.calculateSpotifyMatchScore(song, track)} 分）`); row.append(button("選這個版本", () => chooseTrack(song, track))); box.append(row); }); return box; }

    function invalidateThemeLookupCache(anime) {
        themeCacheKeysForAnime(anime).forEach(key => delete cache[key]);
        saveCache();
    }
    async function maybeAutoLoadThemeSongs() {
        if (!currentAnime) return false;
        if (!navigator.onLine) { setStatus("目前離線，顯示已儲存的主題曲資料"); return false; }
        if (!claimAutomaticLookup(currentAnime, true)) return false;
        await autoFind(false, { automatic:true });
        return true;
    }
    async function autoFind(force, options = {}) {
        if (!navigator.onLine) return setStatus("目前離線，顯示已儲存的主題曲資料");
        const anime = currentAnime, container = currentContainer;
        if (!anime || !container) return false;
        if (force) invalidateThemeLookupCache(anime);
        const lookup = beginThemeLookup(anime);
        setStatus("正在尋找此作品的 OP／ED…");
        try {
            const result = await fetchAnimeThemeSongs(anime, null, {
                signal:lookup.signal,
                isCurrent:() => isThemeLookupCurrent(lookup, anime),
                onProviderFallback:() => { if (isThemeLookupCurrent(lookup, anime)) setStatus("主要資料來源暫時無法使用，正在嘗試備用來源…"); },
                onRetry:({ retry, maxRetries }) => { if (isThemeLookupCurrent(lookup, anime)) setStatus(`主題曲資料來源暫時無回應，正在重試（${retry}/${maxRetries}）…`); }
            });
            if (!isThemeLookupCurrent(lookup, anime)) return false;
            if (!result.selected) {
                if (result.candidates?.length) return showSourceCandidates(result.candidates, anime, container);
                renderSongContent(container.querySelector(".theme-content"));
                if (result.primaryFailure) return setStatus("主題曲資料來源目前無法使用，請稍後再試");
                return setStatus(V.isSpecialMediaType(anime) ? "尚未找到此特別篇專屬的 OP／ED" : "尚未找到此作品的 OP／ED");
            }
            if (!options.automatic || hasThemeSongData(anime)) rememberUndo(anime);
            if (!applyThemeLookupResult(anime, result, lookup)) return false;
            finishThemeLookup(lookup);
            persist(anime);
            setStatus(allSongs(anime).length ? `已載入 ${allSongs(anime).length} 首主題曲` : (V.isSpecialMediaType(anime) ? "尚未找到此特別篇專屬的 OP／ED" : "尚未找到此作品的 OP／ED"));
            return true;
        } catch (error) {
            if (error.name !== "AbortError" && isThemeLookupCurrent(lookup, anime)) setStatus(error.providerFailures ? error.message : `主題曲搜尋失敗：${error.message}`);
            return false;
        } finally { finishThemeLookup(lookup); }
    }
    function showSourceCandidates(candidates, anime = currentAnime, container = currentContainer) {
        const content = container.querySelector(".theme-content"), details = container.querySelector("details"); details.open = true; setStatus("找到多個可能作品，請選擇正確版本"); content.replaceChildren(element("div", "event-status", "請選擇正確的 MyAnimeList 作品："));
        (candidates || []).forEach(candidate => { const row = element("div", "v11-card", `${candidate.title}｜${candidate.type || "?"}｜${candidate.year || "?"}｜${candidate.episodes || "?"} 集｜${candidate.matchScore} 分`); row.append(button("選擇此作品", async () => { const lookup=beginThemeLookup(anime); try { const result = await fetchAnimeThemeSongs(anime, candidate.mal_id, { signal:lookup.signal, isCurrent:()=>isThemeLookupCurrent(lookup,anime), onRetry:({retry,maxRetries})=>{if(isThemeLookupCurrent(lookup,anime))setStatus(`主題曲資料來源暫時無回應，正在重試（${retry}/${maxRetries}）…`);} }); if(!isThemeLookupCurrent(lookup,anime))return; if (hasThemeSongData(anime)) rememberUndo(anime); if(!applyThemeLookupResult(anime,result,lookup))return; finishThemeLookup(lookup); persist(anime); setStatus(allSongs(anime).length ? `已載入 ${allSongs(anime).length} 首主題曲` : "尚未找到此作品的 OP／ED"); } catch (error) { if (error.name !== "AbortError"&&isThemeLookupCurrent(lookup,anime)) setStatus(`主題曲搜尋失敗：${error.message}`); } finally { finishThemeLookup(lookup); } })); content.append(row); });
    }
    function searchSpotify(song, showCandidates) {
        clearTimeout(searchTimer);
        return new Promise(resolve => { searchTimer = setTimeout(async () => {
            if (!navigator.onLine) { setSpotifyStatus(song, "目前離線，無法搜尋 Spotify"); return resolve(); }
            const worker = String(window.SPOTIFY_THEME_CONFIG?.workerUrl || "").replace(/\/$/, ""); if (!worker) { setSpotifyStatus(song, "尚未設定 Spotify 播放服務"); return resolve(); }
            const key = `spotify:${V.normalizeSongTitle(song.title)}:${V.normalizeArtistName(song.artist)}`, old = cached(key);
            try {
                let tracks = old; if (!tracks) { controller?.abort(); controller = new AbortController(); const response = await fetch(`${worker}/search?q=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}`, { signal: controller.signal }); const payload=await response.json().catch(()=>({})); if (!response.ok) { const details=[payload.error,payload.stage?`階段：${payload.stage}`:"",payload.spotifyStatus?`Spotify HTTP ${payload.spotifyStatus}`:"",payload.spotifyError?`錯誤：${payload.spotifyError}`:"",payload.spotifyMessage?`說明：${payload.spotifyMessage}`:""].filter(Boolean).join("｜"); throw Error(details||`Spotify Worker HTTP ${response.status}`); } tracks = payload.tracks || []; putCache(key, tracks, 3 * 86400000); }
                const result = V.selectSpotifyMatch(song, tracks); candidatesBySong.set(song.id, result.candidates);
                if (result.matched && !showCandidates) { rememberUndo(currentAnime); Object.assign(song, result.song); persist(currentAnime); } else { renderSongContent(currentContainer.querySelector(".theme-content")); setSpotifyStatus(song, result.candidates.length ? "請選擇正確的 Spotify 版本" : "Spotify 查無結果"); }
            } catch (error) { if (error.name !== "AbortError") setSpotifyStatus(song, `Spotify 搜尋失敗：${error.message}`); } finally { resolve(); }
        }, 250); });
    }
    function chooseTrack(song, track) { const id = V.extractSpotifyTrackId(track.spotifyUrl) || (/^[A-Za-z0-9]{22}$/.test(track.id || "") ? track.id : ""); if (!id) return setStatus("候選 Spotify Track ID 無效"); rememberUndo(currentAnime); Object.assign(song, { spotifyTrackId: id, spotifyUrl: `https://open.spotify.com/track/${id}`, spotifyEmbedUrl: `https://open.spotify.com/embed/track/${id}`, spotifyMatchStatus: "matched", spotifyMatchScore: V.calculateSpotifyMatchScore(song, track), manuallyCorrected: true, unavailableOnSpotify: false, updatedAt: new Date().toISOString() }); candidatesBySong.delete(song.id); persist(currentAnime); }
    function clearMatch(song) { rememberUndo(currentAnime); Object.assign(song, { spotifyTrackId: "", spotifyUrl: "", spotifyEmbedUrl: "", spotifyMatchStatus: "unmatched", spotifyMatchScore: 0, manuallyCorrected: true, updatedAt: new Date().toISOString() }); persist(currentAnime); }
    function markUnavailable(song) { rememberUndo(currentAnime); Object.assign(song, { spotifyTrackId:"", spotifyUrl:"", spotifyEmbedUrl:"", spotifyMatchStatus:"unavailable", spotifyMatchScore:0, manuallyCorrected:true, unavailableOnSpotify:true, updatedAt:new Date().toISOString() }); persist(currentAnime); }
    function deleteSong(song) { if (!confirm(`確定刪除 ${song.type} ${song.sequence}「${song.title}」？`)) return; rememberUndo(currentAnime); currentAnime.themeSongs.openings = currentAnime.themeSongs.openings.filter(item => item.id !== song.id); currentAnime.themeSongs.endings = currentAnime.themeSongs.endings.filter(item => item.id !== song.id); persist(currentAnime); }

    function snapshotAnimeCleanup(anime) {
        const animeId = String(anime?.id || ""), cacheKey = `source:${animeId}`;
        const keys = themeCacheKeysForAnime(anime);
        let themeUndo = null;
        try { themeUndo = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); } catch {}
        return {
            animeId,
            cacheKey,
            cachePresent:Object.prototype.hasOwnProperty.call(cache, cacheKey),
            cacheValue:Object.prototype.hasOwnProperty.call(cache, cacheKey) ? JSON.parse(JSON.stringify(cache[cacheKey])) : null,
            cacheEntries:keys.filter(key => Object.prototype.hasOwnProperty.call(cache, key)).map(key => [key, JSON.parse(JSON.stringify(cache[key]))]),
            themeUndoPresent:String(themeUndo?.animeId || "") === animeId,
            themeUndo:String(themeUndo?.animeId || "") === animeId ? themeUndo : null
        };
    }

    function themeCacheKeysForAnime(anime) {
        const sourceKey = `source:${String(anime?.id || "")}`, source = cache[sourceKey]?.value;
        const keys = new Set([sourceKey]);
        const anilistId = V.getAnimeAniListIdentity(anime); if (anilistId) keys.add(`animethemes:${anilistId}`);
        [anime?.malId, source?.selected?.mal_id].filter(Boolean).forEach(malId => keys.add(`themes:${Number(malId)}`));
        const songs = V.normalizeThemeSongs(anime?.themeSongs);
        [...songs.openings, ...songs.endings].forEach(song => {
            if (String(song?.title || "").trim() && String(song?.artist || "").trim()) keys.add(nativeTitleCacheKey(song));
        });
        return [...keys];
    }

    function cleanupAnime(anime) {
        const animeId = String(anime?.id || "");
        if (!animeId) return false;
        themeCacheKeysForAnime(anime).forEach(key => delete cache[key]);
        const songs = V.normalizeThemeSongs(anime?.themeSongs);
        [...songs.openings, ...songs.endings].forEach(song => candidatesBySong.delete(song.id));
        try {
            const undo = JSON.parse(localStorage.getItem(UNDO_KEY) || "null");
            if (String(undo?.animeId || "") === animeId) localStorage.removeItem(UNDO_KEY);
        } catch { localStorage.removeItem(UNDO_KEY); }
        if (String(currentAnime?.id || "") === animeId) close();
        saveCache();
        return true;
    }

    function restoreAnimeCleanupSnapshot(snapshot) {
        if (!snapshot?.animeId) return false;
        if (Array.isArray(snapshot.cacheEntries)) snapshot.cacheEntries.forEach(([key, value]) => { cache[key] = value; });
        else if (snapshot.cachePresent) cache[snapshot.cacheKey] = snapshot.cacheValue;
        else delete cache[snapshot.cacheKey];
        saveCache();
        if (snapshot.themeUndoPresent) localStorage.setItem(UNDO_KEY, JSON.stringify(snapshot.themeUndo));
        return true;
    }

    function pruneDeletedAnimeCaches() {
        if (typeof animeList === "undefined") return;
        const activeAnime = animeList.filter(anime => !anime.deletedAt), activeIds = new Set(activeAnime.map(anime => String(anime.id)));
        const activeProviderKeys = new Set();
        activeAnime.forEach(anime => themeCacheKeysForAnime(anime).forEach(key => activeProviderKeys.add(key)));
        let changed = false;
        Object.keys(cache).filter(key => /^(?:source:|animethemes:|themes:|native-title:)/.test(key)).forEach(key => {
            if (!activeProviderKeys.has(key)) { delete cache[key]; changed = true; }
        });
        if (changed) saveCache();
        try {
            const undo = JSON.parse(localStorage.getItem(UNDO_KEY) || "null");
            if (undo?.animeId != null && !activeIds.has(String(undo.animeId))) localStorage.removeItem(UNDO_KEY);
        } catch { localStorage.removeItem(UNDO_KEY); }
    }

    function openEditor(song) {
        const editing = song || V.normalizeThemeSong({ type: "OP", sequence: songGroup(currentAnime, "OP").length + 1, manuallyCorrected: true }, "OP", songGroup(currentAnime, "OP").length);
        const dialog = element("dialog", "theme-editor"); const form = element("form", "v11-modal-panel"); form.method = "dialog";
        const heading = element("h2", "", song ? "編輯主題曲" : "人工新增主題曲"); form.append(heading);
        const fields = [["type","類型 OP／ED",editing.type],["sequence","編號",editing.sequence],["title","歌曲名稱",editing.manuallyCorrected ? editing.title : (editing.nativeTitle || editing.title)],["artist","歌手",editing.artist],["episodeRange","使用集數",editing.episodeRange],["sourceName","資料來源名稱",editing.sourceName],["sourceUrl","資料來源 URL",editing.sourceUrl],["spotifyUrl","Spotify URL 或 URI（選填）",editing.spotifyUrl]];
        fields.forEach(([name,label,value]) => { const wrapper=element("label","",label); const input=element("input"); input.name=name; input.value=value||""; if(name==="sequence")input.type="number"; wrapper.append(input); form.append(wrapper); });
        const unavailable=element("label","","Spotify 無此歌曲 "); const checkbox=element("input"); checkbox.type="checkbox"; checkbox.name="unavailable"; checkbox.checked=editing.unavailableOnSpotify; unavailable.append(checkbox); form.append(unavailable);
        const actions=element("div","v11-toolbar"); actions.append(button("取消",()=>dialog.close()),button("儲存",()=>{})); actions.lastChild.type="submit"; form.append(actions); dialog.append(form); document.body.append(dialog);
        form.addEventListener("submit", event => { event.preventDefault(); const data=new FormData(form), type=String(data.get("type")||"").toUpperCase(),originalType=song?.type; if(!["OP","ED"].includes(type))return alert("類型必須是 OP 或 ED"); const spotifyValue=String(data.get("spotifyUrl")||"").trim(),trackId=spotifyValue?V.extractSpotifyTrackId(spotifyValue):""; if(spotifyValue&&!trackId)return alert("Spotify 網址或 URI 無效"); const source=safeUrl(String(data.get("sourceUrl")||"")); if(data.get("sourceUrl")&&!source)return alert("資料來源網址必須是 http／https"); const sourceName=String(data.get("sourceName")||"").trim()||(source?"人工提供":""); rememberUndo(currentAnime); if(song&&originalType!==type){currentAnime.themeSongs.openings=currentAnime.themeSongs.openings.filter(x=>x.id!==song.id);currentAnime.themeSongs.endings=currentAnime.themeSongs.endings.filter(x=>x.id!==song.id)} Object.assign(editing,{type,sequence:Math.max(1,Number(data.get("sequence"))||1),title:String(data.get("title")||"").trim(),nativeTitle:"",artist:String(data.get("artist")||"").trim(),episodeRange:String(data.get("episodeRange")||"").trim(),spotifyTrackId:trackId,spotifyUrl:trackId?`https://open.spotify.com/track/${trackId}`:"",spotifyEmbedUrl:trackId?`https://open.spotify.com/embed/track/${trackId}`:"",spotifyMatchStatus:trackId?"matched":"unmatched",sourceUrl:source,sourceName,manuallyCorrected:true,unavailableOnSpotify:checkbox.checked,updatedAt:new Date().toISOString()}); if(!song||originalType!==type)songGroup(currentAnime,type).push(editing); dialog.close();dialog.remove();persist(currentAnime); });
        dialog.addEventListener("close",()=>dialog.remove(),{once:true}); dialog.showModal();
    }
    function close() { abortPending(); currentContainer?.querySelectorAll("iframe").forEach(frame => frame.remove()); currentAnime = null; currentContainer = null; candidatesBySong.clear(); }
    function expand(container = currentContainer) { const details=container?.querySelector("details.theme-details"); if(!details)return false; details.open=true; const content=details.querySelector(".theme-content"); if(content)renderSongContent(content); void maybeAutoLoadThemeSongs(); return true; }
    function restoreCacheSnapshot(snapshot, undo) {
        Object.keys(cache).forEach(key => delete cache[key]);
        Object.assign(cache, snapshot && typeof snapshot === "object" ? snapshot : {});
        saveCache();
        if (undo) localStorage.setItem(UNDO_KEY, JSON.stringify(undo));
        else localStorage.removeItem(UNDO_KEY);
    }
    const api = { renderForAnime, expand, close, snapshotAnimeCleanup, cleanupAnime, restoreAnimeCleanupSnapshot, restoreCacheSnapshot, findAnimeThemeSource, fetchAnimeThemeSongs, fetchAnimeThemesThemeSongs, fetchJikanThemeSongs, requestAnimeThemesJson, normalizeAnimeThemesSongs, animeThemesUrl, hasThemeSongData, themeSongStatus, claimAutomaticLookup, requestJikanJson, parseRetryAfterMs, invalidateThemeLookupCache, beginThemeLookup, isThemeLookupCurrent, applyThemeLookupResult, requestNativeTitleJson, lookupNativeThemeSongTitle, enrichThemeSongsWithNativeTitles, appleMusicSearchUrl, appleMusicLookupUrl, hasJapaneseTitle, nativeTitleCacheKey };
    window.ThemeSongs = api;
    window.SpotifyThemes = api;
    pruneDeletedAnimeCaches();
})();
