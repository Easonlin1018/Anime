const recentRequests = new Map();

function corsHeaders(origin, allowedOrigin) {
    const allowed = allowedOrigin || "*";
    const actual = allowed === "*" || origin === allowed ? origin || "*" : allowed;
    return {
        "access-control-allow-origin": actual,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin"
    };
}

function json(data, status, origin, allowedOrigin) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            ...corsHeaders(origin, allowedOrigin)
        }
    });
}

function cleanQuery(value) {
    return String(value || "")
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

function cleanEnv(value, fallback = "") {
    return String(value || fallback).trim();
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get("origin") || "";
        const allowedOrigin = cleanEnv(env.ALLOWED_ORIGIN, "*");

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigin) });
        }

        if (allowedOrigin !== "*" && origin && origin !== allowedOrigin) {
            return json({ ok: false, error: "Origin not allowed" }, 403, origin, allowedOrigin);
        }

        if (request.method === "GET" && url.pathname === "/health") {
            return json({ ok: true, service: "anime-event-live-search", version: "10.4" }, 200, origin, allowedOrigin);
        }

        if (request.method !== "POST" || url.pathname !== "/search") {
            return json({ ok: false, error: "Not found" }, 404, origin, allowedOrigin);
        }

        if (!env.GITHUB_TOKEN) {
            return json({ ok: false, error: "Worker 尚未設定 GITHUB_TOKEN" }, 500, origin, allowedOrigin);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return json({ ok: false, error: "請傳送 JSON" }, 400, origin, allowedOrigin);
        }

        const query = cleanQuery(body?.query);
        if (query.length < 2) {
            return json({ ok: false, error: "作品名稱至少需要 2 個字" }, 400, origin, allowedOrigin);
        }

        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const now = Date.now();
        const previous = recentRequests.get(ip) || 0;
        if (now - previous < 12000) {
            return json({ ok: false, error: "搜尋太頻繁，請 12 秒後再試" }, 429, origin, allowedOrigin);
        }
        recentRequests.set(ip, now);
        for (const [key, value] of recentRequests) {
            if (now - value > 10 * 60 * 1000) recentRequests.delete(key);
        }

        const owner = cleanEnv(env.REPO_OWNER, "Easonlin1018");
        const repo = cleanEnv(env.REPO_NAME, "Anime");
        const branch = cleanEnv(env.REPO_BRANCH, "main");
        const requestId = crypto.randomUUID().replace(/-/g, "");

        const dispatch = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`, {
            method: "POST",
            headers: {
                "accept": "application/vnd.github+json",
                "authorization": `Bearer ${env.GITHUB_TOKEN}`,
                "content-type": "application/json",
                "user-agent": "anime-event-live-search-worker/10.4",
                "x-github-api-version": "2026-03-10"
            },
            body: JSON.stringify({
                event_type: "anime-event-search",
                client_payload: { query, requestId }
            })
        });

        if (!dispatch.ok) {
            const detail = await dispatch.text();
            return json({
                ok: false,
                error: `GitHub 啟動搜尋失敗：HTTP ${dispatch.status}`,
                detail: detail.slice(0, 500)
            }, 502, origin, allowedOrigin);
        }

        const resultUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/search-results/${requestId}.json`;
        return json({
            ok: true,
            requestId,
            query,
            resultUrl,
            pollAfterMs: 3500,
            message: "搜尋工作已啟動"
        }, 202, origin, allowedOrigin);
    }
};
