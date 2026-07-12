(function () {
    "use strict";
    const V = window.AnimeTrackerV11;
    if (!V) return;
    const CACHE_KEY = "anime_theme_lookup_cache_v1";
    const UNDO_KEY = "anime_theme_last_undo_v1";
    const JIKAN = "https://api.jikan.moe/v4";
    let currentAnime = null, currentContainer = null, controller = null, searchTimer = null;
    const candidatesBySong = new Map();
    const cache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {}; } catch { return {}; } })();
    const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
    const button = (text, action) => { const node = element("button", "", text); node.type = "button"; node.addEventListener("click", action); return node; };
    const safeUrl = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } };
    const saveCache = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    const ttlFor = anime => /FINISHED|completed/i.test(`${anime.status} ${anime.category}`) ? 30 * 86400000 : /NOT_YET|waiting/i.test(`${anime.status} ${anime.category}`) ? 86400000 : 3 * 86400000;
    function cached(key) { const item = cache[key]; return item && Date.now() - item.queriedAt < item.ttl ? item.value : null; }
    function putCache(key, value, ttl) { cache[key] = { value, queriedAt: Date.now(), ttl }; saveCache(); }
    function abortPending() { clearTimeout(searchTimer); controller?.abort(); controller = null; }
    async function fetchJson(url) { controller?.abort(); controller = new AbortController(); const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } }); if (!response.ok) throw new Error(`主題曲資料來源 HTTP ${response.status}`); return response.json(); }
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
            const data = await fetchJson(`${JIKAN}/anime?q=${encodeURIComponent(query)}&limit=5&sfw=true`);
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
        const data = await fetchJson(`${JIKAN}/anime/${malId}/full`);
        const theme = data.data?.theme || {};
        const songs = {
            openings: (theme.openings || []).map((text, index) => ({ ...V.parseThemeSongText(text, "OP", index + 1), sourceName: "MyAnimeList via Jikan", sourceUrl: `https://myanimelist.net/anime/${malId}`, updatedAt: new Date().toISOString() })),
            endings: (theme.endings || []).map((text, index) => ({ ...V.parseThemeSongText(text, "ED", index + 1), sourceName: "MyAnimeList via Jikan", sourceUrl: `https://myanimelist.net/anime/${malId}`, updatedAt: new Date().toISOString() }))
        };
        putCache(key, songs, ttlFor(anime)); return { ...source, songs, malId };
    }
    function rememberUndo(anime) { localStorage.setItem(UNDO_KEY, JSON.stringify({ animeId: anime.id, themeSongs: anime.themeSongs, at: new Date().toISOString() })); }
    function persist(anime) { const id=String(anime.id),container=currentContainer; anime.themeSongs = V.normalizeThemeSongs(anime.themeSongs); anime.updatedAt = new Date().toISOString(); saveAndRender(); const fresh=animeList.find(item=>String(item.id)===id)||anime; renderForAnime(fresh, container); }
    function restoreUndo() { try { const undo = JSON.parse(localStorage.getItem(UNDO_KEY) || "null"); if (!undo || String(undo.animeId) !== String(currentAnime.id)) return setStatus("沒有此作品可復原的主題曲修改"); currentAnime.themeSongs = undo.themeSongs; localStorage.removeItem(UNDO_KEY); persist(currentAnime); setStatus("已復原上一次主題曲修改"); } catch { setStatus("復原資料損壞"); } }
    function setStatus(message) { const box = currentContainer?.querySelector(".theme-status"); if (box) box.textContent = message; }
    function allSongs(anime) { return [...anime.themeSongs.openings, ...anime.themeSongs.endings]; }
    function songGroup(anime, type) { return type === "OP" ? anime.themeSongs.openings : anime.themeSongs.endings; }
    function findSong(id) { return allSongs(currentAnime).find(song => song.id === id); }

    function renderForAnime(anime, container) {
        if (!container) return;
        currentAnime = anime; currentAnime.themeSongs = V.normalizeThemeSongs(currentAnime.themeSongs); currentContainer = container;
        container.replaceChildren();
        const details = element("details", "theme-details");
        details.append(element("summary", "theme-summary", "🎵 主題曲 OP／ED"));
        const status = element("div", "event-status theme-status", navigator.onLine ? (window.SPOTIFY_THEME_CONFIG?.workerUrl ? "展開後才載入 Spotify 播放器" : "Spotify 搜尋尚未設定；仍可人工貼入歌曲網址") : "目前離線，無法重新搜尋"); details.append(status);
        const actions = element("div", "v11-toolbar");
        actions.append(button("自動尋找 OP／ED", () => autoFind(false)), button("重新搜尋", () => autoFind(true)), button("人工新增", () => openEditor(null)), button("復原上一次修改", restoreUndo));
        details.append(actions);
        const content = element("div", "theme-content"); details.append(content);
        details.addEventListener("toggle", () => { if (details.open) renderSongContent(content); else content.replaceChildren(); });
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
            if (!group.length) section.append(element("div", "empty", "尚無資料")); else group.sort((a, b) => a.sequence - b.sequence).forEach(song => section.append(renderSong(song)));
            content.append(section);
        });
    }
    function renderSong(song) {
        const card = element("article", "v11-card theme-song");
        card.append(element("strong", "theme-song-label", `${song.type} ${song.sequence}`), element("div", "theme-song-title", song.title || song.rawText || "未命名歌曲"));
        if (song.artist) card.append(element("div", "theme-song-artist", song.artist));
        if (song.episodeRange) card.append(element("div", "anime-meta", `使用集數：${song.episodeRange}`));
        if (song.manuallyCorrected) card.append(element("span", "v11-badge good", "已人工修正"));
        if (song.unavailableOnSpotify) card.append(element("span", "v11-badge warn", "Spotify 無此歌曲"));
        const sourceUrl = safeUrl(song.sourceUrl); if (song.sourceName || sourceUrl) { const row = element("div", "anime-meta", "資料來源："); if (sourceUrl) { const link = element("a", "platform-link", song.sourceName || "來源"); link.href = sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); } else row.append(document.createTextNode(song.sourceName)); card.append(row); }
        if (song.spotifyTrackId && /^[A-Za-z0-9]{22}$/.test(song.spotifyTrackId)) {
            const frame = document.createElement("iframe"); frame.width = "100%"; frame.height = "152"; frame.loading = "lazy"; frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"; frame.title = `${song.title || song.type} Spotify 播放器`; frame.src = `https://open.spotify.com/embed/track/${song.spotifyTrackId}`; frame.setAttribute("allowfullscreen", ""); card.append(frame);
            const link = element("a", "event-link", "在 Spotify 開啟"); link.href = `https://open.spotify.com/track/${song.spotifyTrackId}`; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link);
        }
        const actions = element("div", "v11-toolbar");
        actions.append(button("選擇 Spotify 版本", () => searchSpotify(song, true)), button("編輯", () => openEditor(song)), button("移除 Spotify 配對", () => clearMatch(song)), button("標記 Spotify 無此歌曲", () => markUnavailable(song)), button("刪除歌曲", () => deleteSong(song)));
        card.append(actions);
        const candidates = candidatesBySong.get(song.id); if (candidates?.length) card.append(renderCandidates(song, candidates));
        return card;
    }
    function renderCandidates(song, tracks) { const box = element("div", "theme-candidates"); box.append(element("strong", "", "Spotify 候選版本")); tracks.slice(0, 5).forEach(track => { const row = element("div", "v11-card", `${track.name} — ${(track.artists || []).join("、")}（${track.matchScore ?? V.calculateSpotifyMatchScore(song, track)} 分）`); row.append(button("選這個版本", () => chooseTrack(song, track))); box.append(row); }); return box; }

    async function autoFind(force) {
        if (!navigator.onLine) return setStatus("目前離線，無法重新搜尋");
        if (force) Object.keys(cache).filter(key => key.includes(String(currentAnime.id)) || key.startsWith(`themes:${currentAnime.malId}`)).forEach(key => delete cache[key]), saveCache();
        setStatus("正在尋找此作品專屬的 OP／ED…");
        try {
            const result = await fetchAnimeThemeSongs(currentAnime);
            if (!result.selected) return showSourceCandidates(result.candidates);
            rememberUndo(currentAnime); currentAnime.malId = result.malId;
            currentAnime.themeSongs = V.mergeThemeSongs(currentAnime.themeSongs, result.songs);
            persist(currentAnime); setStatus(allSongs(currentAnime).length ? `已找到 ${allSongs(currentAnime).length} 首主題曲` : (V.isSpecialMediaType(currentAnime) ? "尚未找到此特別篇專屬的 OP／ED" : "尚未找到此作品的 OP／ED"));
            if (window.SPOTIFY_THEME_CONFIG?.workerUrl) for (const song of allSongs(currentAnime).filter(item => !item.manuallyCorrected && !item.spotifyTrackId && !item.unavailableOnSpotify)) await searchSpotify(song, false);
        } catch (error) { if (error.name !== "AbortError") setStatus(`主題曲搜尋失敗：${error.message}`); }
    }
    function showSourceCandidates(candidates) {
        const content = currentContainer.querySelector(".theme-content"); const details = currentContainer.querySelector("details"); details.open = true; content.replaceChildren(element("div", "event-status", "找到多個可能作品，請選擇正確版本："));
        (candidates || []).forEach(candidate => { const row = element("div", "v11-card", `${candidate.title}｜${candidate.type || "?"}｜${candidate.year || "?"}｜${candidate.episodes || "?"} 集｜${candidate.matchScore} 分`); row.append(button("選擇此作品", async () => { const result = await fetchAnimeThemeSongs(currentAnime, candidate.mal_id); rememberUndo(currentAnime); currentAnime.malId = candidate.mal_id; currentAnime.themeSongs = V.mergeThemeSongs(currentAnime.themeSongs, result.songs); persist(currentAnime); })); content.append(row); });
    }
    function searchSpotify(song, showCandidates) {
        clearTimeout(searchTimer);
        return new Promise(resolve => { searchTimer = setTimeout(async () => {
            if (!navigator.onLine) { setStatus("目前離線，無法重新搜尋"); return resolve(); }
            const worker = String(window.SPOTIFY_THEME_CONFIG?.workerUrl || "").replace(/\/$/, ""); if (!worker) { setStatus("Spotify 搜尋尚未設定；可使用編輯功能貼入 Spotify 網址"); return resolve(); }
            const key = `spotify:${V.normalizeSongTitle(song.title)}:${V.normalizeArtistName(song.artist)}`, old = cached(key);
            try {
                let tracks = old; if (!tracks) { controller?.abort(); controller = new AbortController(); const response = await fetch(`${worker}/search?q=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}`, { signal: controller.signal }); const payload=await response.json().catch(()=>({})); if (!response.ok) { const details=[payload.error,payload.stage?`階段：${payload.stage}`:"",payload.spotifyStatus?`Spotify HTTP ${payload.spotifyStatus}`:"",payload.spotifyError?`錯誤：${payload.spotifyError}`:"",payload.spotifyMessage?`說明：${payload.spotifyMessage}`:""].filter(Boolean).join("｜"); throw Error(details||`Spotify Worker HTTP ${response.status}`); } tracks = payload.tracks || []; putCache(key, tracks, 3 * 86400000); }
                const result = V.selectSpotifyMatch(song, tracks); candidatesBySong.set(song.id, result.candidates);
                if (result.matched && !showCandidates) { rememberUndo(currentAnime); Object.assign(song, result.song); persist(currentAnime); } else { setStatus(result.candidates.length ? "請選擇正確的 Spotify 版本" : "Spotify 查無結果"); renderSongContent(currentContainer.querySelector(".theme-content")); }
            } catch (error) { if (error.name !== "AbortError") setStatus(`Spotify 搜尋失敗：${error.message}`); } finally { resolve(); }
        }, 250); });
    }
    function chooseTrack(song, track) { const id = V.extractSpotifyTrackId(track.spotifyUrl) || (/^[A-Za-z0-9]{22}$/.test(track.id || "") ? track.id : ""); if (!id) return setStatus("候選 Spotify Track ID 無效"); rememberUndo(currentAnime); Object.assign(song, { spotifyTrackId: id, spotifyUrl: `https://open.spotify.com/track/${id}`, spotifyEmbedUrl: `https://open.spotify.com/embed/track/${id}`, spotifyMatchStatus: "matched", spotifyMatchScore: V.calculateSpotifyMatchScore(song, track), manuallyCorrected: true, unavailableOnSpotify: false, updatedAt: new Date().toISOString() }); candidatesBySong.delete(song.id); persist(currentAnime); }
    function clearMatch(song) { rememberUndo(currentAnime); Object.assign(song, { spotifyTrackId: "", spotifyUrl: "", spotifyEmbedUrl: "", spotifyMatchStatus: "unmatched", spotifyMatchScore: 0, manuallyCorrected: true, updatedAt: new Date().toISOString() }); persist(currentAnime); }
    function markUnavailable(song) { rememberUndo(currentAnime); Object.assign(song, { spotifyTrackId:"", spotifyUrl:"", spotifyEmbedUrl:"", spotifyMatchStatus:"unavailable", spotifyMatchScore:0, manuallyCorrected:true, unavailableOnSpotify:true, updatedAt:new Date().toISOString() }); persist(currentAnime); }
    function deleteSong(song) { if (!confirm(`確定刪除 ${song.type} ${song.sequence}「${song.title}」？`)) return; rememberUndo(currentAnime); currentAnime.themeSongs.openings = currentAnime.themeSongs.openings.filter(item => item.id !== song.id); currentAnime.themeSongs.endings = currentAnime.themeSongs.endings.filter(item => item.id !== song.id); persist(currentAnime); }

    function openEditor(song) {
        const editing = song || V.normalizeThemeSong({ type: "OP", sequence: songGroup(currentAnime, "OP").length + 1, manuallyCorrected: true }, "OP", songGroup(currentAnime, "OP").length);
        const dialog = element("dialog", "theme-editor"); const form = element("form", "v11-modal-panel"); form.method = "dialog";
        const heading = element("h2", "", song ? "編輯主題曲" : "人工新增主題曲"); form.append(heading);
        const fields = [["type","類型 OP／ED",editing.type],["sequence","編號",editing.sequence],["title","歌曲名稱",editing.title],["artist","歌手",editing.artist],["episodeRange","使用集數",editing.episodeRange],["spotifyUrl","Spotify URL 或 URI",editing.spotifyUrl],["sourceUrl","資料來源 URL",editing.sourceUrl]];
        fields.forEach(([name,label,value]) => { const wrapper=element("label","",label); const input=element("input"); input.name=name; input.value=value||""; if(name==="sequence")input.type="number"; wrapper.append(input); form.append(wrapper); });
        const unavailable=element("label","","Spotify 無此歌曲 "); const checkbox=element("input"); checkbox.type="checkbox"; checkbox.name="unavailable"; checkbox.checked=editing.unavailableOnSpotify; unavailable.append(checkbox); form.append(unavailable);
        const actions=element("div","v11-toolbar"); actions.append(button("取消",()=>dialog.close()),button("儲存",()=>{})); actions.lastChild.type="submit"; form.append(actions); dialog.append(form); document.body.append(dialog);
        form.addEventListener("submit", event => { event.preventDefault(); const data=new FormData(form), type=String(data.get("type")||"").toUpperCase(),originalType=song?.type; if(!["OP","ED"].includes(type))return alert("類型必須是 OP 或 ED"); const spotifyValue=String(data.get("spotifyUrl")||"").trim(),trackId=spotifyValue?V.extractSpotifyTrackId(spotifyValue):""; if(spotifyValue&&!trackId)return alert("Spotify 網址或 URI 無效"); const source=safeUrl(String(data.get("sourceUrl")||"")); if(data.get("sourceUrl")&&!source)return alert("資料來源網址必須是 http／https"); rememberUndo(currentAnime); if(song&&originalType!==type){currentAnime.themeSongs.openings=currentAnime.themeSongs.openings.filter(x=>x.id!==song.id);currentAnime.themeSongs.endings=currentAnime.themeSongs.endings.filter(x=>x.id!==song.id)} Object.assign(editing,{type,sequence:Math.max(1,Number(data.get("sequence"))||1),title:String(data.get("title")||"").trim(),artist:String(data.get("artist")||"").trim(),episodeRange:String(data.get("episodeRange")||"").trim(),spotifyTrackId:trackId,spotifyUrl:trackId?`https://open.spotify.com/track/${trackId}`:"",spotifyEmbedUrl:trackId?`https://open.spotify.com/embed/track/${trackId}`:"",spotifyMatchStatus:trackId?"matched":"unmatched",sourceUrl:source,sourceName:source?"人工提供":"",manuallyCorrected:true,unavailableOnSpotify:checkbox.checked,updatedAt:new Date().toISOString()}); if(!song||originalType!==type)songGroup(currentAnime,type).push(editing); dialog.close();dialog.remove();persist(currentAnime); });
        dialog.addEventListener("close",()=>dialog.remove(),{once:true}); dialog.showModal();
    }
    function close() { abortPending(); currentContainer?.querySelectorAll("iframe").forEach(frame => frame.remove()); currentAnime = null; currentContainer = null; candidatesBySong.clear(); }
    function expand(container = currentContainer) { const details=container?.querySelector("details.theme-details"); if(!details)return false; details.open=true; return true; }
    window.SpotifyThemes = { renderForAnime, expand, close, findAnimeThemeSource, fetchAnimeThemeSongs };
})();
