import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const EVENTS_FILE = path.join(ROOT, "events.json");
const RESULTS_DIR = path.join(ROOT, "search-results");
const QUERY = String(process.env.QUERY || "").trim().slice(0, 160);
const REQUEST_ID = String(process.env.REQUEST_ID || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
const MAX_RSS_QUERIES = Number(process.env.MAX_RSS_QUERIES || 18);
const MAX_ARTICLE_FETCHES = Number(process.env.MAX_ARTICLE_FETCHES || 28);
const ARTICLE_DELAY_MS = Number(process.env.ARTICLE_DELAY_MS || 650);

if (!QUERY) throw new Error("缺少 QUERY");
if (!REQUEST_ID) throw new Error("缺少 REQUEST_ID");

const EVENT_TERMS = [
    "漫畫博覽會", "漫博", "動漫節", "動畫節", "快閃店", "快閃", "展覽",
    "特展", "原畫展", "簽名會", "見面會", "舞台活動", "攤位", "主題店",
    "期間限定店", "聯名活動", "合作活動", "主題咖啡", "咖啡廳", "應援活動",
    "pop-up", "popup", "exhibition", "festival", "event"
];

const TAIWAN_TERMS = [
    "台灣", "臺灣", "台北", "臺北", "新北", "桃園", "新竹", "台中", "臺中",
    "彰化", "嘉義", "台南", "臺南", "高雄", "花蓮", "世貿", "華山", "松菸",
    "三創", "南港", "臺中國際展覽館", "台中國際展覽館"
];

const CITY_ALIASES = [
    ["台北", ["台北", "臺北"]], ["新北", ["新北"]], ["桃園", ["桃園"]],
    ["新竹", ["新竹"]], ["台中", ["台中", "臺中"]], ["彰化", ["彰化"]],
    ["嘉義", ["嘉義"]], ["台南", ["台南", "臺南"]], ["高雄", ["高雄"]],
    ["花蓮", ["花蓮"]]
];

const VENUES = [
    "台北世貿一館", "臺北世貿一館", "台北世貿", "臺北世貿", "南港展覽館",
    "臺中國際展覽館", "台中國際展覽館", "華山1914文化創意產業園區", "華山1914",
    "松山文創園區", "松菸", "三創生活園區", "三創", "新光三越", "夢時代",
    "統一時代百貨", "誠品生活", "台北地下街", "臺北地下街"
];

const USER_AGENT = "AnimeEventRadar/10.4 (+https://github.com/Easonlin1018/Anime)";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalize(value) {
    return String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\((?:動畫|anime|tv)\)|（(?:動畫|anime|tv)）/gi, " ")
        .replace(/(?:電視動畫|動畫版|劇場版|電影版|第\s*\d+\s*[季期])/gi, " ")
        .replace(/[\s\u3000・·!！?？:：,，.。\-–—_~～()（）\[\]【】《》「」『』\/\\]/g, "");
}

function decodeEntities(value) {
    return String(value || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(value) {
    return decodeEntities(String(value || ""))
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getTag(block, tag) {
    const match = String(block).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match?.[1] || "";
}

function truncate(value, max = 500) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function hash(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 18);
}

function safeDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

async function fetchText(url, { attempts = 3, timeout = 22000 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, {
                redirect: "follow",
                signal: controller.signal,
                headers: {
                    "user-agent": USER_AGENT,
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "accept-language": "zh-TW,zh;q=0.9,en;q=0.6,ja;q=0.5"
                }
            });
            if (response.status === 429) {
                const wait = Math.max(Number(response.headers.get("retry-after") || 0) * 1000, 3000 * attempt);
                if (attempt < attempts) {
                    await delay(wait + Math.floor(Math.random() * 500));
                    continue;
                }
            }
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            return {
                text: await response.text(),
                finalUrl: response.url,
                contentType: response.headers.get("content-type") || ""
            };
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await delay(800 * attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError || new Error("讀取失敗");
}

async function searchWikipediaAliases(query) {
    const cleaned = String(query || "")
        .replace(/\((?:動畫|anime|tv)\)|（(?:動畫|anime|tv)）/gi, " ")
        .replace(/(?:電視動畫|動畫版)/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return [];

    const searchUrl = new URL("https://zh.wikipedia.org/w/api.php");
    searchUrl.search = new URLSearchParams({
        action:"query", list:"search", srsearch:cleaned, srlimit:"5",
        srnamespace:"0", format:"json", origin:"*"
    }).toString();
    const searchResponse = await fetch(searchUrl, { headers:{ "user-agent":USER_AGENT } });
    if (!searchResponse.ok) throw new Error(`Wikipedia search HTTP ${searchResponse.status}`);
    const searchJson = await searchResponse.json();
    const results = searchJson?.query?.search || [];
    const best = results.find(item => /動畫|輕小說|漫畫|電視/.test(stripHtml(item.snippet || ""))) || results[0];
    if (!best?.title) return [];

    const pageUrl = new URL("https://zh.wikipedia.org/w/api.php");
    pageUrl.search = new URLSearchParams({
        action:"query", prop:"langlinks|redirects", titles:best.title,
        lllimit:"max", redirects:"1", format:"json", origin:"*"
    }).toString();
    const pageResponse = await fetch(pageUrl, { headers:{ "user-agent":USER_AGENT } });
    if (!pageResponse.ok) return [best.title];
    const pageJson = await pageResponse.json();
    const page = Object.values(pageJson?.query?.pages || {})[0] || {};
    const langlinks = Array.isArray(page.langlinks) ? page.langlinks : [];
    const preferred = langlinks
        .filter(link => ["ja", "en", "zh-yue", "zh-min-nan"].includes(link.lang))
        .map(link => link["*"])
        .filter(Boolean);
    return [page.title || best.title, ...preferred];
}

async function queryAniList(search) {
    const graphql = `
        query ($search: String) {
            Media(search: $search, type: ANIME) {
                id
                title { romaji english native userPreferred }
                synonyms
                format
                seasonYear
            }
        }
    `;
    const response = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ query: graphql, variables: { search } })
    });
    if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
    const json = await response.json();
    return json?.data?.Media || null;
}

async function resolveAniListAliases(query) {
    const cleaned = String(query || "")
        .replace(/\((?:動畫|anime|tv)\)|（(?:動畫|anime|tv)）/gi, " ")
        .replace(/(?:電視動畫|動畫版)/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    const wikiAliases = await searchWikipediaAliases(cleaned).catch(() => []);
    const candidates = [cleaned, ...wikiAliases].filter(Boolean);
    let media = null;
    for (const candidate of candidates.slice(0, 6)) {
        try {
            media = await queryAniList(candidate);
            if (media) break;
        } catch {}
    }

    const values = [
        query,
        cleaned,
        ...wikiAliases,
        media?.title?.userPreferred,
        media?.title?.romaji,
        media?.title?.english,
        media?.title?.native,
        ...(Array.isArray(media?.synonyms) ? media.synonyms : [])
    ].filter(Boolean);

    const seen = new Set();
    const aliases = [];
    for (const value of values) {
        const clean = String(value).trim();
        const key = normalize(clean);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        aliases.push(clean);
    }
    return { media, aliases: aliases.slice(0, 40) };
}

function usableAlias(alias) {
    const compact = normalize(alias);
    if (compact.length >= 4) return true;
    return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(alias) && compact.length >= 2;
}

function buildSearchQueries(aliases) {
    const useful = aliases.filter(usableAlias).slice(0, 9);
    const queries = [];
    const add = (engine, label, query, url) => queries.push({ engine, label, query, url });

    for (const alias of useful) {
        const quoted = `"${alias.replace(/"/g, "")}"`;
        const q1 = `${quoted} 台灣 (漫博 OR 動漫節 OR 快閃店 OR 展覽 OR 簽名會 OR 主題店)`;
        const q2 = `${quoted} (漫畫博覽會 OR 台北國際動漫節 OR 台中國際動漫節 OR 攤位 OR 舞台活動)`;
        add("Google News", alias, q1, `https://news.google.com/rss/search?q=${encodeURIComponent(q1)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`);
        add("Bing News", alias, q2, `https://www.bing.com/news/search?q=${encodeURIComponent(q2)}&format=rss&setlang=zh-hant&cc=tw`);
        if (queries.length >= MAX_RSS_QUERIES) break;
    }
    return queries.slice(0, MAX_RSS_QUERIES);
}

function parseRss(xml, source, searchAlias) {
    const blocks = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];
    return blocks.map(block => {
        const title = stripHtml(getTag(block, "title")).replace(/\s+-\s+[^-]+$/, "").trim();
        const url = stripHtml(getTag(block, "link")) || stripHtml(getTag(block, "guid"));
        const description = stripHtml(getTag(block, "description"));
        const publishedRaw = stripHtml(getTag(block, "pubDate"));
        return {
            id: `live-${hash(`${url}|${title}`)}`,
            title,
            url,
            description,
            publishedAt: safeDate(publishedRaw)?.toISOString() || null,
            discoverySource: source,
            searchAlias
        };
    }).filter(item => item.title && item.url);
}

function articleTextFromHtml(html) {
    const meta = [...String(html).matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["']/gi)]
        .map(match => decodeEntities(match[1]));
    const body = stripHtml(String(html)
        .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
        .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
        .replace(/<footer\b[\s\S]*?<\/footer>/gi, " "));
    return truncate([...meta, body].filter(Boolean).join(" "), 18000);
}

function matchedAliases(corpus, aliases) {
    const raw = String(corpus || "").normalize("NFKC").toLowerCase();
    const compact = normalize(raw);
    return aliases.filter(alias => {
        const clean = String(alias).normalize("NFKC").toLowerCase().trim();
        const normalized = normalize(alias);
        if (!usableAlias(alias)) return false;
        if (clean.length >= 3 && raw.includes(clean)) return true;
        return normalized.length >= 3 && compact.includes(normalized);
    });
}

function containsAny(text, terms) {
    const lower = String(text || "").toLowerCase();
    return terms.some(term => lower.includes(String(term).toLowerCase()));
}

function formatDateKey(year, month, day) {
    const y = Number(year), m = Number(month), d = Number(day);
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function inferYear(month, day, publishedAt) {
    const published = safeDate(publishedAt) || new Date();
    let year = published.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
    if (candidate.getTime() < published.getTime() - 150 * 86400000) year += 1;
    return year;
}

function extractDates(text, publishedAt) {
    const source = String(text || "").replace(/[～〜]/g, "~");
    let match;

    match = source.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:至|到|~|－|-)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (match) return {
        start: formatDateKey(match[1], match[2], match[3]),
        end: formatDateKey(match[4] || match[1], match[5], match[6]),
        source: match[0]
    };

    match = source.match(/(\d{1,2})\s*[\/.]\s*(\d{1,2})\s*(?:至|到|~|－|-)\s*(\d{1,2})\s*[\/.]\s*(\d{1,2})/);
    if (match) {
        const y1 = inferYear(match[1], match[2], publishedAt);
        let y2 = y1;
        if (Number(match[3]) < Number(match[1])) y2 += 1;
        return { start: formatDateKey(y1, match[1], match[2]), end: formatDateKey(y2, match[3], match[4]), source: match[0] };
    }

    match = source.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:至|到|~|－|-)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/);
    if (match) {
        const endMonth = match[3] || match[1];
        const y1 = inferYear(match[1], match[2], publishedAt);
        let y2 = y1;
        if (Number(endMonth) < Number(match[1])) y2 += 1;
        return { start: formatDateKey(y1, match[1], match[2]), end: formatDateKey(y2, endMonth, match[4]), source: match[0] };
    }

    match = source.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (match) return { start: formatDateKey(match[1], match[2], match[3]), end: null, source: match[0] };

    match = source.match(/(?:^|\D)(\d{1,2})\s*[\/.]\s*(\d{1,2})(?:\D|$)/);
    if (match) {
        const year = inferYear(match[1], match[2], publishedAt);
        return { start: formatDateKey(year, match[1], match[2]), end: null, source: match[0].trim() };
    }

    return { start: null, end: null, source: "" };
}

function extractLocations(text) {
    const result = [];
    for (const [canonical, aliases] of CITY_ALIASES) {
        if (aliases.some(alias => String(text).includes(alias))) result.push(canonical);
    }
    return [...new Set(result)];
}

function extractVenue(text) {
    const found = VENUES.find(venue => String(text).includes(venue));
    if (found) return found.replace(/^臺/, "台");
    const match = String(text).match(/(?:於|在|地點[:：]?|會場[:：]?)\s*([^，。；;\n]{3,35}(?:館|園區|中心|百貨|廣場|展場|會館|空間|店))/);
    return truncate(match?.[1] || "", 60);
}

function detectType(text) {
    const source = String(text);
    if (/漫畫博覽會|漫博|動漫節|動畫節/.test(source)) return "大型展會";
    if (/快閃|期間限定店|主題店|pop-?up/i.test(source)) return "快閃店";
    if (/簽名會|見面會/.test(source)) return "簽名會／見面會";
    if (/原畫展|特展|展覽|exhibition/i.test(source)) return "展覽";
    if (/主題咖啡|咖啡廳/.test(source)) return "主題餐飲";
    return "動漫活動";
}

function detectAdmission(text) {
    const source = String(text);
    if (/免費入場|免費參觀|免門票|自由入場/.test(source)) return "免費入場";
    if (/預約|事前登記/.test(source)) return "需預約";
    if (/抽選|抽籤/.test(source)) return "抽選制";
    if (/整理券/.test(source)) return "整理券";
    if (/購票|售票|票價|門票/.test(source)) return "購票入場";
    if (/低消|消費滿|消費即可/.test(source)) return "消費入場";
    return "待確認";
}

function eventStatus(start, end) {
    const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    if (end && end < today) return "expired";
    if (start && start > today) return "upcoming";
    if (start || end) return "ongoing";
    return "date-unknown";
}

function sourceNameFromTitle(title, fallback) {
    const match = String(title).match(/\s+-\s+([^-]{2,50})$/);
    return match?.[1]?.trim() || fallback;
}

function evaluateCandidate(item, aliases, article) {
    const corpus = [item.title, item.description, article?.text].filter(Boolean).join(" ");
    const matches = matchedAliases(corpus, aliases);
    if (!matches.length) return null;
    if (!containsAny(corpus, EVENT_TERMS)) return null;

    const hasTaiwan = containsAny(corpus, TAIWAN_TERMS);
    if (!hasTaiwan) return null;

    const dates = extractDates(corpus, item.publishedAt);
    const locations = extractLocations(corpus);
    const venue = extractVenue(corpus);
    const fullArticle = Boolean(article?.text && article.text.length > 500);
    let score = 45;
    score += Math.min(matches.length * 6, 24);
    if (fullArticle) score += 10;
    if (dates.start || dates.end) score += 10;
    if (locations.length || venue) score += 8;
    if (matches.some(alias => normalize(item.title).includes(normalize(alias)))) score += 8;
    score = Math.min(score, 99);

    const finalUrl = article?.finalUrl && !article.finalUrl.includes("news.google.com")
        ? article.finalUrl
        : item.url;

    return {
        id: `live-${hash(finalUrl || item.url)}`,
        title: item.title.replace(/\s+-\s+[^-]+$/, "").trim(),
        summary: truncate(item.description || article?.text || "", 520),
        url: finalUrl,
        source: sourceNameFromTitle(item.title, item.discoverySource),
        discoverySource: `即時搜尋：${item.discoverySource}`,
        sourceTag: "即時搜尋",
        type: detectType(corpus),
        locations,
        venue,
        admissionType: detectAdmission(corpus),
        confidence: score >= 82 ? "high" : score >= 65 ? "medium" : "low",
        confidenceScore: score,
        matchedAliases: [...new Set(matches)].slice(0, 20),
        workTitles: [...new Set(matches)].slice(0, 20),
        publishedAt: item.publishedAt,
        eventStartDate: dates.start,
        eventEndDate: dates.end,
        eventStatus: eventStatus(dates.start, dates.end),
        dateConfidence: dates.start || dates.end ? "medium" : "unknown",
        dateSource: dates.source,
        verification: fullArticle
            ? "即時搜尋已讀取文章內容並確認作品名稱；日期與地點仍請以主辦方公告為準。"
            : "即時搜尋在新聞標題或摘要找到作品名稱；請開啟原文確認完整資訊。",
        searchCorpus: truncate(corpus, 12000),
        liveSearchQuery: QUERY,
        liveSearchRequestId: REQUEST_ID,
        discoveredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
    };
}

function mergeEvents(existing, found) {
    const byKey = new Map();
    const keyFor = event => event.url || `${normalize(event.title)}|${event.eventStartDate || ""}`;
    for (const event of existing) byKey.set(keyFor(event), event);
    let added = 0;
    for (const event of found) {
        const key = keyFor(event);
        const previous = byKey.get(key);
        if (previous) {
            byKey.set(key, {
                ...previous,
                ...event,
                id: previous.id || event.id,
                discoveredAt: previous.discoveredAt || event.discoveredAt,
                workTitles: [...new Set([...(previous.workTitles || []), ...(event.workTitles || [])])],
                matchedAliases: [...new Set([...(previous.matchedAliases || []), ...(event.matchedAliases || [])])]
            });
        } else {
            byKey.set(key, event);
            added++;
        }
    }
    return { events: [...byKey.values()], added };
}

async function readEvents() {
    try {
        const raw = JSON.parse(await fs.readFile(EVENTS_FILE, "utf8"));
        return {
            meta: raw?.meta || {},
            events: Array.isArray(raw?.events) ? raw.events : [],
            archive: Array.isArray(raw?.archive) ? raw.archive : []
        };
    } catch {
        return { meta: {}, events: [], archive: [] };
    }
}

async function writeJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main() {
    const startedAt = new Date().toISOString();
    const errors = [];
    const { media, aliases } = await resolveAniListAliases(QUERY).catch(error => {
        errors.push(`AniList：${error.message}`);
        return { media: null, aliases: [QUERY] };
    });

    const searchQueries = buildSearchQueries(aliases);
    const items = [];
    for (const search of searchQueries) {
        try {
            const response = await fetchText(search.url, { attempts: 2, timeout: 18000 });
            items.push(...parseRss(response.text, search.engine, search.label));
        } catch (error) {
            errors.push(`${search.engine} ${search.label}：${error.message}`);
        }
        await delay(220);
    }

    const deduped = [...new Map(items.map(item => [item.url || `${item.title}|${item.publishedAt}`, item])).values()]
        .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));

    const prelim = deduped.filter(item => {
        const corpus = `${item.title} ${item.description}`;
        return matchedAliases(corpus, aliases).length > 0 && containsAny(corpus, EVENT_TERMS);
    });

    const found = [];
    for (const item of prelim.slice(0, MAX_ARTICLE_FETCHES)) {
        let article = null;
        try {
            const response = await fetchText(item.url, { attempts: 2, timeout: 18000 });
            article = { text: articleTextFromHtml(response.text), finalUrl: response.finalUrl };
        } catch (error) {
            errors.push(`文章 ${item.title.slice(0, 40)}：${error.message}`);
        }
        const event = evaluateCandidate(item, aliases, article);
        if (event && event.eventStatus !== "expired") found.push(event);
        await delay(ARTICLE_DELAY_MS + Math.floor(Math.random() * 220));
    }

    const uniqueFound = [...new Map(found.map(event => [event.url || `${normalize(event.title)}|${event.eventStartDate || ""}`, event])).values()]
        .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    const existing = await readEvents();
    const merged = mergeEvents(existing.events, uniqueFound);
    const completedAt = new Date().toISOString();

    await writeJson(EVENTS_FILE, {
        meta: {
            ...existing.meta,
            liveSearchUpdatedAt: completedAt,
            liveSearchQuery: QUERY,
            liveSearchResultCount: uniqueFound.length,
            liveSearchAddedCount: merged.added
        },
        events: merged.events,
        archive: existing.archive
    });

    await writeJson(path.join(RESULTS_DIR, `${REQUEST_ID}.json`), {
        schemaVersion: 1,
        status: "complete",
        requestId: REQUEST_ID,
        query: QUERY,
        media: media ? {
            id: media.id,
            title: media.title,
            synonyms: media.synonyms || []
        } : null,
        aliases,
        sourcesChecked: searchQueries.length,
        rssItemsFound: deduped.length,
        candidateArticles: prelim.length,
        articleFetchesAttempted: Math.min(prelim.length, MAX_ARTICLE_FETCHES),
        events: uniqueFound,
        addedToEventsJson: merged.added,
        errors: errors.slice(0, 20),
        startedAt,
        completedAt,
        message: uniqueFound.length
            ? `已即時找到 ${uniqueFound.length} 個明確提及作品的活動。`
            : `已即時搜尋 ${aliases.length} 個作品名稱與 ${searchQueries.length} 個活動來源，但沒有找到明確提及作品的活動。`
    });

    console.log(JSON.stringify({ query: QUERY, aliases: aliases.length, sources: searchQueries.length, events: uniqueFound.length, added: merged.added }, null, 2));
}

main().catch(async error => {
    const resultFile = path.join(RESULTS_DIR, `${REQUEST_ID}.json`);
    await writeJson(resultFile, {
        schemaVersion: 1,
        status: "error",
        requestId: REQUEST_ID,
        query: QUERY,
        events: [],
        message: `即時搜尋失敗：${error.message}`,
        completedAt: new Date().toISOString()
    });
    console.error(error);
});
