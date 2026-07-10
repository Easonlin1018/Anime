import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const RSS_URL =
    process.env.BAHAMUT_RSS_URL ||
    "https://gnn.gamer.com.tw/rss.xml";

const OUTPUT_FILE =
    process.env.OUTPUT_FILE ||
    "events.json";

const KEEP_DAYS =
    Number(process.env.KEEP_DAYS || 180);

const MAX_ARTICLE_FETCHES =
    Number(process.env.MAX_ARTICLE_FETCHES || 55);

const TAG_PAGES = [
    { tag: "快閃店", type: "快閃店", pages: 2 },
    { tag: "展覽", type: "展覽", pages: 2 },
    { tag: "餐廳", type: "主題餐廳／咖啡廳", pages: 2 },
    { tag: "主題咖啡廳", type: "主題餐廳／咖啡廳", pages: 1 },
    { tag: "見面會", type: "見面會", pages: 2 },
    { tag: "簽名會", type: "簽名會", pages: 1 },
    { tag: "漫畫博覽會", type: "大型展會", pages: 2 },
    { tag: "動漫節", type: "大型展會", pages: 2 }
];

const activityRules = [
    {
        type: "快閃店",
        keywords: [
            "快閃店", "快閃商店", "期間限定店",
            "期間限定商店", "限定商店",
            "pop up", "pop-up", "popup store"
        ]
    },
    {
        type: "主題餐廳／咖啡廳",
        keywords: [
            "主題咖啡", "聯名咖啡", "合作咖啡",
            "主題餐廳", "聯名餐廳", "合作餐廳",
            "期間限定咖啡"
        ]
    },
    {
        type: "展覽",
        keywords: [
            "特展", "展覽", "原畫展", "紀念展",
            "主題展", "動畫展", "漫畫展", "互動展"
        ]
    },
    {
        type: "見面會",
        keywords: [
            "見面會", "粉絲見面", "聲優活動",
            "聲優來台", "聲優來臺", "握手會"
        ]
    },
    {
        type: "簽名會",
        keywords: ["簽名會", "簽書會"]
    },
    {
        type: "舞台／演出",
        keywords: [
            "演唱會", "音樂會", "舞台劇",
            "音樂劇", "現場演出", "live 活動"
        ]
    },
    {
        type: "大型展會",
        keywords: [
            "漫畫博覽會", "漫畫博覽", "漫博",
            "動漫節", "動漫展", "同人展",
            "同人誌販售會", "動漫市集"
        ]
    }
];

const locationRules = [
    ["台北", ["台北", "臺北", "華山", "松菸", "三創", "信義", "南港", "西門", "京站", "中山地下街", "台北地下街", "花博爭艷館", "花博爭豔館"]],
    ["新北", ["新北", "板橋", "新莊", "淡水", "中和", "永和", "三重", "林口"]],
    ["桃園", ["桃園", "中壢", "華泰名品城"]],
    ["新竹", ["新竹", "竹北"]],
    ["苗栗", ["苗栗"]],
    ["台中", ["台中", "臺中", "草悟道", "勤美", "中友百貨", "LaLaport 台中", "lalaport 台中"]],
    ["彰化", ["彰化"]],
    ["南投", ["南投"]],
    ["雲林", ["雲林"]],
    ["嘉義", ["嘉義"]],
    ["台南", ["台南", "臺南"]],
    ["高雄", ["高雄", "駁二", "夢時代", "高雄流行音樂中心"]],
    ["屏東", ["屏東"]],
    ["宜蘭", ["宜蘭"]],
    ["花蓮", ["花蓮"]],
    ["台東", ["台東", "臺東"]],
    ["全台", ["全台", "全臺", "北中南"]]
];

const taiwanWords = [
    "台灣", "臺灣", "來台", "來臺",
    "全台", "全臺", "台灣限定", "臺灣限定"
];

const foreignLocationWords = [
    "日本", "東京", "大阪", "京都", "名古屋", "橫濱",
    "神戶", "福岡", "北海道", "沖繩", "池袋", "澀谷",
    "韓國", "首爾", "釜山", "香港", "澳門",
    "中國大陸", "上海", "北京", "廣州", "深圳",
    "新加坡", "馬來西亞", "泰國", "曼谷",
    "japan", "tokyo", "osaka", "kyoto",
    "seoul", "hong kong", "singapore"
];

const onlineOnlyWords = [
    "線上活動", "遊戲內活動", "登入活動", "登入獎勵",
    "儲值活動", "轉蛋活動", "限時副本", "伺服器活動",
    "事前登錄", "事前預約", "虛寶", "序號", "卡池",
    "版本更新", "改版活動", "限定召喚", "活動關卡",
    "活動副本", "活動任務"
];

const physicalWords = [
    "快閃店", "快閃商店", "限定店", "限定商店",
    "咖啡", "餐廳", "特展", "展覽", "原畫展",
    "紀念展", "主題展", "見面會", "簽名會",
    "演唱會", "音樂會", "舞台劇", "市集", "販售會",
    "會場", "百貨", "購物中心", "三創", "華山",
    "松菸", "駁二", "入場", "門票", "售票", "開幕"
];

const fetchHeaders = {
    "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 Chrome/126 Safari/537.36 " +
        "TaiwanAnimeEventRadar/2.0",
    "Accept":
        "text/html,application/xhtml+xml,application/rss+xml," +
        "application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5",
    "Referer": "https://gnn.gamer.com.tw/"
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function includesAny(text, words) {
    const normalized = normalizeText(text);
    return words.some(word =>
        normalized.includes(normalizeText(word))
    );
}

function decodeEntities(value = "") {
    return String(value)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&#(\d+);/g, (_, n) =>
            String.fromCodePoint(Number(n))
        )
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
            String.fromCodePoint(parseInt(n, 16))
        );
}

function stripHtml(value = "") {
    return decodeEntities(value)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getTag(block, tagName) {
    const pattern = new RegExp(
        `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
        "i"
    );
    const match = block.match(pattern);
    return match ? decodeEntities(match[1]).trim() : "";
}

function getMeta(html, property) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
        new RegExp(
            `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
            "i"
        ),
        new RegExp(
            `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
            "i"
        )
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return decodeEntities(match[1]).trim();
    }

    return "";
}

function safeDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function truncate(value, maxLength = 280) {
    const text = String(value || "").trim();
    return text.length <= maxLength
        ? text
        : `${text.slice(0, maxLength - 1)}…`;
}

function normalizeGnnUrl(rawUrl) {
    if (!rawUrl) return "";

    try {
        const url = new URL(
            decodeEntities(rawUrl),
            "https://gnn.gamer.com.tw/"
        );

        if (url.hostname !== "gnn.gamer.com.tw") {
            return "";
        }

        if (
            !url.pathname.includes("detail.php") ||
            !url.searchParams.get("sn")
        ) {
            return "";
        }

        url.hash = "";
        return url.toString();
    } catch {
        return "";
    }
}

function makeId(url) {
    try {
        const sn = new URL(url).searchParams.get("sn");
        if (sn) return `gnn-${sn}`;
    } catch {}

    return `gnn-${crypto
        .createHash("sha256")
        .update(url)
        .digest("hex")
        .slice(0, 16)}`;
}

function classifyActivity(text, fallbackType = "") {
    const normalized = normalizeText(text);

    for (const rule of activityRules) {
        if (
            rule.keywords.some(keyword =>
                normalized.includes(normalizeText(keyword))
            )
        ) {
            return rule.type;
        }
    }

    return fallbackType;
}

function detectLocations(text) {
    const normalized = normalizeText(text);
    const locations = [];

    for (const [label, keywords] of locationRules) {
        if (
            keywords.some(keyword =>
                normalized.includes(normalizeText(keyword))
            )
        ) {
            locations.push(label);
        }
    }

    return [...new Set(locations)];
}

function evaluateCandidate(text, fallbackType = "") {
    const type = classifyActivity(text, fallbackType);
    if (!type) return null;

    const locations = detectLocations(text);
    const hasTaiwan =
        includesAny(text, taiwanWords) ||
        locations.length > 0;

    const looksForeign =
        includesAny(text, foreignLocationWords);

    const looksOnline =
        includesAny(text, onlineOnlyWords);

    const looksPhysical =
        includesAny(text, physicalWords) ||
        Boolean(fallbackType);

    if (!looksPhysical) return null;

    if (looksOnline && !hasTaiwan && !includesAny(text, physicalWords)) {
        return null;
    }

    if (looksForeign && !hasTaiwan) {
        return null;
    }

    return {
        type,
        locations:
            locations.length > 0
                ? locations
                : hasTaiwan
                    ? ["台灣"]
                    : ["地點待確認"],
        confidence: hasTaiwan ? "high" : "candidate"
    };
}

async function fetchTextWithRetries(
    url,
    attempts = 3,
    timeout = 22000
) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            timeout
        );

        try {
            const response = await fetch(url, {
                redirect: "follow",
                signal: controller.signal,
                headers: fetchHeaders
            });

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status} ${response.statusText}`
                );
            }

            return await response.text();
        } catch (error) {
            lastError = error;

            if (attempt < attempts) {
                await delay(1200 * attempt);
            }
        } finally {
            clearTimeout(timer);
        }
    }

    throw lastError || new Error("讀取失敗");
}

function parseRss(xml) {
    const blocks =
        String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];

    return blocks.map(block => ({
        title: stripHtml(getTag(block, "title")),
        url: normalizeGnnUrl(
            stripHtml(getTag(block, "link")) ||
            stripHtml(getTag(block, "guid"))
        ),
        summary: stripHtml(
            getTag(block, "description") ||
            getTag(block, "content:encoded")
        ),
        publishedAt:
            safeDate(stripHtml(getTag(block, "pubDate")))
                ?.toISOString() || null,
        discoverySource: "RSS",
        sourceTag: ""
    }));
}

function parseTagPage(html, sourceTag, fallbackType) {
    const anchorPattern =
        /<a\b[^>]*href=["']([^"']*detail\.php\?[^"']*sn=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

    const byUrl = new Map();
    let match;

    while ((match = anchorPattern.exec(html)) !== null) {
        const url = normalizeGnnUrl(match[1]);
        const anchorText = stripHtml(match[2]);

        if (!url) continue;
        if (!anchorText || /^(繼續閱讀|更多|read more)$/i.test(anchorText)) {
            continue;
        }

        const before = Math.max(0, match.index - 1300);
        const after = Math.min(
            html.length,
            match.index + match[0].length + 1800
        );
        const context = stripHtml(html.slice(before, after));

        const previous = byUrl.get(url);
        const candidate = {
            title: anchorText,
            url,
            summary: truncate(context, 600),
            publishedAt: null,
            discoverySource: `標籤：${sourceTag}`,
            sourceTag,
            fallbackType
        };

        if (
            !previous ||
            candidate.title.length > previous.title.length
        ) {
            byUrl.set(url, candidate);
        }
    }

    return [...byUrl.values()];
}

function parseArticlePage(html, fallback) {
    const title =
        stripHtml(getMeta(html, "og:title")) ||
        stripHtml(
            (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
        ) ||
        fallback.title;

    const summary =
        stripHtml(getMeta(html, "og:description")) ||
        stripHtml(getMeta(html, "description")) ||
        fallback.summary;

    let publishedAt =
        safeDate(getMeta(html, "article:published_time")) ||
        safeDate(getMeta(html, "datePublished"));

    if (!publishedAt) {
        const jsonDate = html.match(
            /["']datePublished["']\s*:\s*["']([^"']+)["']/i
        );
        publishedAt = safeDate(jsonDate?.[1]);
    }

    if (!publishedAt) {
        const timeDate = html.match(
            /<time[^>]+datetime=["']([^"']+)["']/i
        );
        publishedAt = safeDate(timeDate?.[1]);
    }

    const articleText = truncate(stripHtml(html), 6000);

    return {
        ...fallback,
        title,
        summary: truncate(summary, 360),
        publishedAt:
            publishedAt?.toISOString() ||
            fallback.publishedAt ||
            null,
        articleText
    };
}

async function readExistingData() {
    try {
        const parsed = JSON.parse(
            await fs.readFile(OUTPUT_FILE, "utf8")
        );

        return {
            meta:
                parsed && typeof parsed.meta === "object"
                    ? parsed.meta
                    : {},
            events:
                Array.isArray(parsed?.events)
                    ? parsed.events
                    : []
        };
    } catch {
        return { meta: {}, events: [] };
    }
}

async function writeJson(data) {
    const directory = path.dirname(OUTPUT_FILE);

    if (directory && directory !== ".") {
        await fs.mkdir(directory, { recursive: true });
    }

    await fs.writeFile(
        OUTPUT_FILE,
        `${JSON.stringify(data, null, 2)}\n`,
        "utf8"
    );
}

async function collectRss(sourceErrors) {
    try {
        const xml = await fetchTextWithRetries(RSS_URL);
        return parseRss(xml);
    } catch (error) {
        sourceErrors.push({
            source: "GNN RSS",
            error: String(error.message || error)
        });
        return [];
    }
}

async function collectTagPages(sourceErrors) {
    const all = [];

    for (const config of TAG_PAGES) {
        for (let page = 1; page <= config.pages; page++) {
            const url =
                "https://gnn.gamer.com.tw/search_tag.php" +
                `?q=${encodeURIComponent(config.tag)}` +
                (page > 1 ? `&page=${page}` : "");

            try {
                const html = await fetchTextWithRetries(url, 2);
                const items = parseTagPage(
                    html,
                    config.tag,
                    config.type
                );

                all.push(...items);
            } catch (error) {
                sourceErrors.push({
                    source: `標籤 ${config.tag} 第 ${page} 頁`,
                    error: String(error.message || error)
                });
            }

            await delay(350);
        }
    }

    return all;
}

function mergeRawItems(items) {
    const byId = new Map();

    for (const item of items) {
        if (!item.url) continue;

        const id = makeId(item.url);
        const previous = byId.get(id);

        if (!previous) {
            byId.set(id, { ...item, id });
            continue;
        }

        const sourceList = [
            previous.discoverySource,
            item.discoverySource
        ]
            .filter(Boolean)
            .join("、");

        byId.set(id, {
            ...previous,
            ...item,
            id,
            title:
                item.title.length > previous.title.length
                    ? item.title
                    : previous.title,
            summary:
                item.summary.length > previous.summary.length
                    ? item.summary
                    : previous.summary,
            publishedAt:
                item.publishedAt || previous.publishedAt,
            fallbackType:
                item.fallbackType || previous.fallbackType,
            sourceTag:
                item.sourceTag || previous.sourceTag,
            discoverySource: sourceList
        });
    }

    return [...byId.values()];
}

async function enrichArticles(rawItems, sourceErrors) {
    const enriched = [];
    let fetched = 0;

    for (const item of rawItems) {
        if (fetched >= MAX_ARTICLE_FETCHES) {
            enriched.push(item);
            continue;
        }

        try {
            const html = await fetchTextWithRetries(
                item.url,
                2,
                18000
            );

            enriched.push(
                parseArticlePage(html, item)
            );
            fetched++;
        } catch (error) {
            enriched.push(item);

            sourceErrors.push({
                source: `文章 ${item.id}`,
                error: String(error.message || error)
            });
        }

        await delay(280);
    }

    return enriched;
}

async function main() {
    const now = new Date();
    const existing = await readExistingData();
    const sourceErrors = [];

    const rssItems = await collectRss(sourceErrors);
    const tagItems = await collectTagPages(sourceErrors);
    const rawItems = mergeRawItems([
        ...rssItems,
        ...tagItems
    ]);

    if (rawItems.length === 0) {
        const output = {
            meta: {
                ...existing.meta,
                sourceName:
                    "巴哈姆特 GNN RSS＋公開標籤頁",
                sourceUrl: RSS_URL,
                updatedAt: now.toISOString(),
                lastAttemptAt: now.toISOString(),
                fetchStatus: "error",
                lastError:
                    "RSS 與標籤頁都沒有取得任何資料",
                sourceErrors,
                storedEventCount: existing.events.length,
                note:
                    "本次讀取失敗，已保留上一次成功資料。"
            },
            events: existing.events
        };

        await writeJson(output);
        console.error(output.meta.lastError);
        return;
    }

    const enrichedItems = await enrichArticles(
        rawItems,
        sourceErrors
    );

    const oldById = new Map(
        existing.events.map(event => [
            event.id,
            event
        ])
    );

    const freshEvents = [];

    for (const item of enrichedItems) {
        const combinedText = [
            item.title,
            item.summary,
            item.articleText || ""
        ].join(" ");

        const match = evaluateCandidate(
            combinedText,
            item.fallbackType || ""
        );

        if (!match) continue;

        const previous = oldById.get(item.id);

        freshEvents.push({
            id: item.id,
            title: item.title,
            summary: truncate(item.summary, 300),
            url: item.url,
            source: "巴哈姆特 GNN",
            discoverySource: item.discoverySource,
            sourceTag: item.sourceTag || "",
            type: match.type,
            locations: match.locations,
            confidence: match.confidence,
            publishedAt: item.publishedAt || null,
            discoveredAt:
                previous?.discoveredAt ||
                now.toISOString(),
            lastSeenAt: now.toISOString(),
            verification:
                match.confidence === "high"
                    ? "請開啟巴哈姆特原文確認活動日期、地點與入場方式。"
                    : "疑似實體活動，但地點或日期不完整，請先查看原文確認。"
        });
    }

    const mergedById = new Map();

    for (const oldEvent of existing.events) {
        mergedById.set(oldEvent.id, oldEvent);
    }

    for (const freshEvent of freshEvents) {
        mergedById.set(freshEvent.id, {
            ...mergedById.get(freshEvent.id),
            ...freshEvent
        });
    }

    const cutoff =
        now.getTime() -
        KEEP_DAYS * 24 * 60 * 60 * 1000;

    const mergedEvents = [...mergedById.values()]
        .filter(event => {
            const date =
                safeDate(event.publishedAt) ||
                safeDate(event.discoveredAt);

            return date && date.getTime() >= cutoff;
        })
        .sort((a, b) => {
            const aTime =
                safeDate(a.publishedAt)?.getTime() ||
                safeDate(a.discoveredAt)?.getTime() ||
                0;

            const bTime =
                safeDate(b.publishedAt)?.getTime() ||
                safeDate(b.discoveredAt)?.getTime() ||
                0;

            return bTime - aTime;
        });

    const highConfidenceCount =
        freshEvents.filter(
            event => event.confidence === "high"
        ).length;

    const candidateCount =
        freshEvents.filter(
            event => event.confidence === "candidate"
        ).length;

    const successfulCoreSources =
        Number(rssItems.length > 0) +
        Number(tagItems.length > 0);

    const fetchStatus =
        successfulCoreSources === 2
            ? sourceErrors.length > 0
                ? "partial"
                : "success"
            : "partial";

    const output = {
        meta: {
            sourceName:
                "巴哈姆特 GNN RSS＋公開標籤頁",
            sourceUrl: RSS_URL,
            updatedAt: now.toISOString(),
            lastSuccessfulUpdateAt:
                now.toISOString(),
            fetchStatus,
            fetchedRssCount: rssItems.length,
            fetchedTagItemCount: tagItems.length,
            uniqueNewsCount: rawItems.length,
            matchedEventCount: freshEvents.length,
            highConfidenceCount,
            candidateCount,
            storedEventCount: mergedEvents.length,
            keepDays: KEEP_DAYS,
            sourceErrors: sourceErrors.slice(0, 30),
            note:
                "資料來自巴哈姆特 GNN RSS 與公開標籤頁；活動日期、地點與入場方式仍請以原文及主辦方公告為準。"
        },
        events: mergedEvents
    };

    await writeJson(output);

    console.log(
        `完成：RSS ${rssItems.length} 則，` +
        `標籤頁 ${tagItems.length} 筆，` +
        `去重後 ${rawItems.length} 筆，` +
        `符合活動 ${freshEvents.length} 筆，` +
        `目前保存 ${mergedEvents.length} 筆。`
    );
}

await main();
