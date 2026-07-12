let tokenCache = { value: "", expiresAt: 0 };
const queryCache = new Map();
const rateBuckets = new Map();
const SPOTIFY_SEARCH_LIMIT = 5;

function corsHeaders(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = new Set([env.ALLOWED_ORIGIN || "https://easonlin1018.github.io", "http://localhost:8080"]);
    return { "Access-Control-Allow-Origin": allowed.has(origin) ? origin : env.ALLOWED_ORIGIN || "https://easonlin1018.github.io", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin", "Content-Type": "application/json; charset=utf-8" };
}
function response(request, env, body, status = 200) { return new Response(JSON.stringify(body), { status, headers: corsHeaders(request, env) }); }
function validText(value, max) { const clean = String(value || "").trim(); return clean.length >= 1 && clean.length <= max ? clean : ""; }
function safeSpotifyValue(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") return value.slice(0, 300);
    return value && typeof value === "object" ? safeSpotifyValue(value.message || value.status || value.error) : "Unknown Spotify error";
}
async function parseSpotifyResponse(upstreamResponse) {
    const spotifyText = await upstreamResponse.text();
    let spotifyBody = {};
    try { spotifyBody = spotifyText ? JSON.parse(spotifyText) : {}; }
    catch { spotifyBody = { message: spotifyText.slice(0, 300) }; }
    return spotifyBody;
}
class SpotifyUpstreamError extends Error {
    constructor(stage, status, body, publicMessage) {
        super(publicMessage);
        this.name = "SpotifyUpstreamError";
        this.stage = stage;
        this.spotifyStatus = Number(status || 0);
        this.spotifyError = safeSpotifyValue(body?.error?.status ?? body?.error ?? body?.error_description ?? "Unknown Spotify error");
        this.spotifyMessage = safeSpotifyValue(body?.error?.message ?? body?.error_description ?? body?.message ?? "Unknown Spotify error");
    }
}
function rateAllowed(request) {
    const key = request.headers.get("CF-Connecting-IP") || "local";
    const now = Date.now(), bucket = rateBuckets.get(key) || [];
    const recent = bucket.filter(time => now - time < 60000);
    if (recent.length >= 30) return false;
    recent.push(now); rateBuckets.set(key, recent); return true;
}
async function spotifyToken(env) {
    if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) throw new Error("Spotify Worker 尚未設定");
    const credentials = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    const data = await parseSpotifyResponse(tokenResponse);
    if (!tokenResponse.ok) throw new SpotifyUpstreamError("token", tokenResponse.status, data, "Spotify token 請求失敗");
    if (!data.access_token) throw new SpotifyUpstreamError("token", tokenResponse.status, { message: "Spotify token 回應缺少 access_token" }, "Spotify token 請求失敗");
    tokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
    return tokenCache.value;
}
async function searchTracks(q, artist, env) {
    const key = `${q.toLowerCase()}|${artist.toLowerCase()}`, cached = queryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.tracks;
    const token = await spotifyToken(env);
    const query = artist ? `track:${q} artist:${artist}` : `track:${q}`;
    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("type", "track");
    searchUrl.searchParams.set("limit", String(Math.min(SPOTIFY_SEARCH_LIMIT, 10)));
    const searchResponse = await fetch(searchUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = await parseSpotifyResponse(searchResponse);
    if (!searchResponse.ok) throw new SpotifyUpstreamError("search", searchResponse.status, data, "Spotify 搜尋失敗");
    const tracks = (data.tracks?.items || []).slice(0, SPOTIFY_SEARCH_LIMIT).map(track => ({ id: track.id, name: track.name, artists: (track.artists || []).map(item => item.name), album: track.album?.name || "", image: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || "", spotifyUrl: track.external_urls?.spotify || "", durationMs: Number(track.duration_ms || 0), explicit: Boolean(track.explicit) }));
    queryCache.set(key, { tracks, expiresAt: Date.now() + 5 * 60 * 1000 });
    return tracks;
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
        if (request.method !== "GET") return response(request, env, { error: "Method not allowed" }, 405);
        const url = new URL(request.url);
        if (url.pathname === "/health") return response(request, env, { ok: true });
        if (url.pathname !== "/search") return response(request, env, { error: "Not found" }, 404);
        if (!rateAllowed(request)) return response(request, env, { error: "Too many requests" }, 429);
        const q = validText(url.searchParams.get("q"), 120), artist = validText(url.searchParams.get("artist"), 120);
        if (!q) return response(request, env, { error: "q 長度必須為 1–120 字元" }, 400);
        try { return response(request, env, { tracks: await searchTracks(q, artist, env) }); }
        catch (error) {
            if (error instanceof SpotifyUpstreamError) {
                return response(request, env, { error: error.message, stage: error.stage, spotifyStatus: error.spotifyStatus, spotifyError: error.spotifyError, spotifyMessage: error.spotifyMessage }, 502);
            }
            return response(request, env, { error: error.message || "搜尋失敗" }, 502);
        }
    }
};
