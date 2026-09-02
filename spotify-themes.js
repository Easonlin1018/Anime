(function () {
    "use strict";
    const V = window.AnimeTrackerV11;
    if (!V) return;
    const CACHE_KEY = "anime_theme_lookup_cache_v1";
    const UNDO_KEY = "anime_theme_last_undo_v1";
    const JIKAN = "https://api.jikan.moe/v4";
    const JIKAN_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
    const JIKAN_RETRY_DELAYS = [800, 1600];
    const MAX_RETRY_AFTER_MS = 5000;
    let currentAnime = null, currentContainer = null, controller = null, searchTimer = null;
    const candidatesBySong = new Map();
    const automaticLookupAttempts = new Set();
    const cache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {}; } catch { return {}; } })();
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
    const button = (text, action) => { const node = element("button", "", text); node.type = "button"; node.addEventListener("click", action); return node; };
    const safeUrl = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } };
    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    const ttlFor = anime => /FINISHED|completed/i.test(`${anime.status} ${anime.category}`) ? 30 * 86400000 : /NOT_YET|waiting/i.test(`${anime.status} ${anime.category}`) ? 86400000 : 3 * 86400000;
    function cached(key) { const item = cache[key]; return item && Date.now() - item.queriedAt < item.ttl ? item.value : null; }
    function putCache(key, value, ttl) { cache[key] = { value, queriedAt: Date.now(), ttl }; saveCache(); }
    function abortPending() { clearTimeout(searchTimer); controller?.abort(); controller = null; }
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
            if (response.ok) return response.json();
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
    async function fetchJikanJson(url) {
        controller?.abort();
        const activeController = new AbortController();
        controller = activeController;
        try {
            return await requestJikanJson(url, {
                signal:activeController.signal,
                onRetry:({ retry, maxRetries }) => setStatus(`主題曲資料來源暫時無回應，正在重試（${retry}/${maxRetries}）…`)
            });
        } finally {
            if (controller === activeController) controller = null;
        }
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
    async function findAnimeThemeSource(anime) {
        if (anime.malId) return { selected: { mal_id: Number(anime.malId) }, candidates: [], confident: true };
        const key = `source:${anime.id}`, old = cached(key); if (old) return old;
        const queries = [...new Set([anime.title, ...(anime.aliases || []), anime.titleJapanese, anime.titleEnglish].filter(Boolean))].slice(0, 4);
        const found = new Map();
        for (const query of queries) {
            const data = await fetchJikanJson(`${JIKAN}/anime?q=${encodeURIComponent(query)}&limit=5&sfw=true`);
            (data.data || []).forEach(item => found.set(item.mal_id, item));
            if (found.size >= 8) break;
        }
        const candidates = [...found.values()].map(item => ({ ...item, matchScore: candidateScore(anime, item) })).sort((a, b) => b.matchScore - a.matchScore);
        const confident = Boolean(candidates[0] && candidates[0].matchScore >= 70 && (!candidates[1] || candidates[0].matchScore - candidates[1].matchScore >= 10));
        const result = { selected: confident ? candidates[0] : null, candidates: candidates.slice(0, 5), confident };
        putCache(key, result, ttlFor(anime)); return result;
    }
    async function fetchAnimeThemeSongs(anime, chosenMalId) {
        const source = chosenMalId ? { selected: { mal_id: Number(chosenMalId) }, confident: true, candidates: [] } : await findAnimeThemeSource(anime);
        if (!source.selected) return source;
        const malId = Number(source.selected.mal_id), key = `themes:${malId}`, old = cached(key);
        if (old) return { ...source, songs: old, malId };
        const data = await fetchJikanJson(`${JIKAN}/anime/${malId}/full`);
        const theme = data.data?.theme || {};
        const songs = {
            openings: (theme.openings || []).map((text, index) => ({ ...V.parseThemeSongText(text, "OP", index + 1), sourceName: "MyAnimeList via Jikan", sourceUrl: `https://myanimelist.net/anime/${malId}`, updatedAt: new Date().toISOString() })),
            endings: (theme.endings || []).map((text, index) => ({ ...V.parseThemeSongText(text, "ED", index + 1), sourceName: "MyAnimeList via Jikan", sourceUrl: `https://myanimelist.net/anime/${malId}`, updatedAt: new Date().toISOString() }))
        };
        putCache(key, songs, ttlFor(anime)); return { ...source, songs, malId };
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

    function renderForAnime(anime, container, options = {}) {
        if (!container) return;
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
        card.append(element("strong", "theme-song-label", `${song.type} ${song.sequence}`), element("div", "theme-song-title", song.title || song.rawText || "未命名歌曲"));
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
        const sourceKey = `source:${anime.id}`, source = cache[sourceKey]?.value;
        const malIds = new Set([anime.malId, source?.selected?.mal_id].filter(Boolean).map(Number));
        delete cache[sourceKey];
        malIds.forEach(malId => delete cache[`themes:${malId}`]);
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
        if (force) invalidateThemeLookupCache(currentAnime);
        setStatus("正在尋找此作品的 OP／ED…");
        try {
            const result = await fetchAnimeThemeSongs(currentAnime);
            if (!result.selected) {
                if (result.candidates?.length) return showSourceCandidates(result.candidates);
                renderSongContent(currentContainer.querySelector(".theme-content"));
                return setStatus(V.isSpecialMediaType(currentAnime) ? "尚未找到此特別篇專屬的 OP／ED" : "尚未找到此作品的 OP／ED");
            }
            if (!options.automatic || hasThemeSongData(currentAnime)) rememberUndo(currentAnime);
            currentAnime.malId = result.malId;
            currentAnime.themeSongs = V.mergeThemeSongs(currentAnime.themeSongs, result.songs);
            persist(currentAnime);
            setStatus(allSongs(currentAnime).length ? `已載入 ${allSongs(currentAnime).length} 首主題曲` : (V.isSpecialMediaType(currentAnime) ? "尚未找到此特別篇專屬的 OP／ED" : "尚未找到此作品的 OP／ED"));
        } catch (error) { if (error.name !== "AbortError") setStatus(`主題曲搜尋失敗：${error.message}`); }
    }
    function showSourceCandidates(candidates) {
        const content = currentContainer.querySelector(".theme-content"); const details = currentContainer.querySelector("details"); details.open = true; setStatus("找到多個可能作品，請選擇正確版本"); content.replaceChildren(element("div", "event-status", "請選擇正確的 MyAnimeList 作品："));
        (candidates || []).forEach(candidate => { const row = element("div", "v11-card", `${candidate.title}｜${candidate.type || "?"}｜${candidate.year || "?"}｜${candidate.episodes || "?"} 集｜${candidate.matchScore} 分`); row.append(button("選擇此作品", async () => { try { const result = await fetchAnimeThemeSongs(currentAnime, candidate.mal_id); if (hasThemeSongData(currentAnime)) rememberUndo(currentAnime); currentAnime.malId = candidate.mal_id; currentAnime.themeSongs = V.mergeThemeSongs(currentAnime.themeSongs, result.songs); persist(currentAnime); setStatus(allSongs(currentAnime).length ? `已載入 ${allSongs(currentAnime).length} 首主題曲` : "尚未找到此作品的 OP／ED"); } catch (error) { if (error.name !== "AbortError") setStatus(`主題曲搜尋失敗：${error.message}`); } })); content.append(row); });
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
        let themeUndo = null;
        try { themeUndo = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); } catch {}
        return {
            animeId,
            cacheKey,
            cachePresent:Object.prototype.hasOwnProperty.call(cache, cacheKey),
            cacheValue:Object.prototype.hasOwnProperty.call(cache, cacheKey) ? JSON.parse(JSON.stringify(cache[cacheKey])) : null,
            themeUndoPresent:String(themeUndo?.animeId || "") === animeId,
            themeUndo:String(themeUndo?.animeId || "") === animeId ? themeUndo : null
        };
    }

    function cleanupAnime(anime) {
        const animeId = String(anime?.id || "");
        if (!animeId) return false;
        delete cache[`source:${animeId}`];
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
        if (snapshot.cachePresent) cache[snapshot.cacheKey] = snapshot.cacheValue;
        else delete cache[snapshot.cacheKey];
        saveCache();
        if (snapshot.themeUndoPresent) localStorage.setItem(UNDO_KEY, JSON.stringify(snapshot.themeUndo));
        return true;
    }

    function pruneDeletedAnimeCaches() {
        if (typeof animeList === "undefined") return;
        const activeIds = new Set(animeList.filter(anime => !anime.deletedAt).map(anime => String(anime.id)));
        let changed = false;
        Object.keys(cache).filter(key => key.startsWith("source:")).forEach(key => {
            if (!activeIds.has(key.slice(7))) { delete cache[key]; changed = true; }
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
        const fields = [["type","類型 OP／ED",editing.type],["sequence","編號",editing.sequence],["title","歌曲名稱",editing.title],["artist","歌手",editing.artist],["episodeRange","使用集數",editing.episodeRange],["sourceName","資料來源名稱",editing.sourceName],["sourceUrl","資料來源 URL",editing.sourceUrl],["spotifyUrl","Spotify URL 或 URI（選填）",editing.spotifyUrl]];
        fields.forEach(([name,label,value]) => { const wrapper=element("label","",label); const input=element("input"); input.name=name; input.value=value||""; if(name==="sequence")input.type="number"; wrapper.append(input); form.append(wrapper); });
        const unavailable=element("label","","Spotify 無此歌曲 "); const checkbox=element("input"); checkbox.type="checkbox"; checkbox.name="unavailable"; checkbox.checked=editing.unavailableOnSpotify; unavailable.append(checkbox); form.append(unavailable);
        const actions=element("div","v11-toolbar"); actions.append(button("取消",()=>dialog.close()),button("儲存",()=>{})); actions.lastChild.type="submit"; form.append(actions); dialog.append(form); document.body.append(dialog);
        form.addEventListener("submit", event => { event.preventDefault(); const data=new FormData(form), type=String(data.get("type")||"").toUpperCase(),originalType=song?.type; if(!["OP","ED"].includes(type))return alert("類型必須是 OP 或 ED"); const spotifyValue=String(data.get("spotifyUrl")||"").trim(),trackId=spotifyValue?V.extractSpotifyTrackId(spotifyValue):""; if(spotifyValue&&!trackId)return alert("Spotify 網址或 URI 無效"); const source=safeUrl(String(data.get("sourceUrl")||"")); if(data.get("sourceUrl")&&!source)return alert("資料來源網址必須是 http／https"); const sourceName=String(data.get("sourceName")||"").trim()||(source?"人工提供":""); rememberUndo(currentAnime); if(song&&originalType!==type){currentAnime.themeSongs.openings=currentAnime.themeSongs.openings.filter(x=>x.id!==song.id);currentAnime.themeSongs.endings=currentAnime.themeSongs.endings.filter(x=>x.id!==song.id)} Object.assign(editing,{type,sequence:Math.max(1,Number(data.get("sequence"))||1),title:String(data.get("title")||"").trim(),artist:String(data.get("artist")||"").trim(),episodeRange:String(data.get("episodeRange")||"").trim(),spotifyTrackId:trackId,spotifyUrl:trackId?`https://open.spotify.com/track/${trackId}`:"",spotifyEmbedUrl:trackId?`https://open.spotify.com/embed/track/${trackId}`:"",spotifyMatchStatus:trackId?"matched":"unmatched",sourceUrl:source,sourceName,manuallyCorrected:true,unavailableOnSpotify:checkbox.checked,updatedAt:new Date().toISOString()}); if(!song||originalType!==type)songGroup(currentAnime,type).push(editing); dialog.close();dialog.remove();persist(currentAnime); });
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
    const api = { renderForAnime, expand, close, snapshotAnimeCleanup, cleanupAnime, restoreAnimeCleanupSnapshot, restoreCacheSnapshot, findAnimeThemeSource, fetchAnimeThemeSongs, hasThemeSongData, themeSongStatus, claimAutomaticLookup, requestJikanJson, parseRetryAfterMs, invalidateThemeLookupCache };
    window.ThemeSongs = api;
    window.SpotifyThemes = api;
    pruneDeletedAnimeCaches();
})();
