import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA_VERSION = 3;

const RSS_URL =
    process.env.BAHAMUT_RSS_URL ||
    "https://gnn.gamer.com.tw/rss.xml";

const OUTPUT_FILE =
    process.env.OUTPUT_FILE ||
    "events.json";

const MAX_ARTICLE_FETCHES =
    Number(process.env.MAX_ARTICLE_FETCHES || 150);

const RECENT_UNDATED_DAYS =
    Number(process.env.RECENT_UNDATED_DAYS || 45);

const TAG_PAGES = [
    { tag: "快閃店", pages: 2 },
    { tag: "展覽", pages: 2 },
    { tag: "餐廳", pages: 2 },
    { tag: "主題咖啡廳", pages: 1 },
    { tag: "見面會", pages: 2 },
    { tag: "簽名會", pages: 2 },
    { tag: "漫畫博覽會", pages: 1 },
    { tag: "動漫節", pages: 1 }
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
            "期間限定咖啡", "主題 café", "主題 cafe"
        ]
    },
    {
        type: "展覽",
        keywords: [
            "特展", "動畫展", "漫畫展", "原畫展",
            "紀念展", "主題展", "互動體驗展",
            "迷宮探索展", "世界巡迴展"
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
            "國際動漫節", "動漫節", "動漫展",
            "同人展", "同人誌販售會", "動漫市集"
        ]
    }
];

const locationRules = [
    ["台北", [
        "台北", "臺北", "華山", "松菸", "三創", "信義",
        "南港", "西門", "京站", "誠品 r79", "台北地下街",
        "臺北地下街", "中山地下街", "花博爭艷館", "花博爭豔館",
        "科教館", "新光南西", "新光三越 a11", "台北世貿"
    ]],
    ["新北", [
        "新北", "板橋", "新莊", "淡水", "中和", "永和",
        "三重", "林口", "新店", "裕隆城"
    ]],
    ["桃園", ["桃園", "中壢", "華泰名品城"]],
    ["新竹", ["新竹", "竹北", "巨城"]],
    ["苗栗", ["苗栗"]],
    ["台中", [
        "台中", "臺中", "草悟道", "勤美", "中友百貨",
        "lalaport 台中", "台中漢神", "漢神洲際"
    ]],
    ["彰化", ["彰化"]],
    ["南投", ["南投"]],
    ["雲林", ["雲林"]],
    ["嘉義", ["嘉義"]],
    ["台南", ["台南", "臺南"]],
    ["高雄", [
        "高雄", "駁二", "夢時代", "高雄流行音樂中心",
        "漢神巨蛋"
    ]],
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

const recapWords = [
    "圓滿落幕", "活動落幕", "已落幕", "正式閉幕",
    "活動回顧", "會後報導", "活動紀實", "現場直擊",
    "精彩回顧", "順利落幕", "完美落幕"
];

const physicalWords = [
    "快閃店", "快閃商店", "限定店", "限定商店",
    "咖啡", "café", "cafe", "餐廳", "特展", "動畫展",
    "漫畫展", "原畫展", "紀念展", "主題展", "見面會",
    "簽名會", "演唱會", "音樂會", "舞台劇", "市集",
    "販售會", "會場", "百貨", "購物中心", "三創", "華山",
    "松菸", "駁二", "入場", "門票", "售票", "開幕", "開展"
];

const maxSingleDateDuration = {
    "快閃店": 65,
    "主題餐廳／咖啡廳": 75,
    "展覽": 125,
    "見面會": 2,
    "簽名會": 2,
    "舞台／演出": 2,
    "大型展會": 10
};

const fetchHeaders = {
    "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 Chrome/126 Safari/537.36 " +
        "TaiwanAnimeEventRadar/3.0",
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
        .replace(/&mdash;/gi, "—")
        .replace(/&ndash;/gi, "–")
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

function cleanSummary(value, title = "") {
    let text = stripHtml(value)
        .replace(/【以下內容為廠商提供資料原文】/g, "")
        .replace(/\d+\s*人推！/g, "")
        .replace(/^\s*(?:其他|動漫|PC|手機|TV)\s*/i, "")
        .trim();

    if (title && text.includes(title)) {
        text = text.slice(text.lastIndexOf(title) + title.length).trim();
    }

    if (text.includes("繼續閱讀")) {
        const parts = text
            .split("繼續閱讀")
            .map(part => part.trim())
            .filter(Boolean);

        text = parts.at(-1) || "";

        if (title && text.includes(title)) {
            text = text.slice(text.lastIndexOf(title) + title.length).trim();
        }
    }

    return text
        .replace(/^\s*[>\"'，、：:。-]+/, "")
        .replace(/\s+/g, " ")
        .trim();
}

function getTag(block, tagName) {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
        `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
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

        if (url.hostname !== "gnn.gamer.com.tw") return "";

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

function articleNumber(item) {
    const match = String(item.id || "").match(/gnn-(\d+)/);
    return match ? Number(match[1]) : 0;
}

function classifyActivity(title, summary = "") {
    const titleText = normalizeText(title);
    const summaryText = normalizeText(summary);

    for (const rule of activityRules) {
        if (
            rule.keywords.some(keyword =>
                titleText.includes(normalizeText(keyword))
            )
        ) {
            return rule.type;
        }
    }

    for (const rule of activityRules) {
        if (
            rule.keywords.some(keyword =>
                summaryText.includes(normalizeText(keyword))
            )
        ) {
            return rule.type;
        }
    }

    return "";
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

function parseJsonLd(html) {
    const blocks = [
        ...String(html).matchAll(
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
        )
    ];

    const objects = [];

    function flatten(value) {
        if (Array.isArray(value)) {
            value.forEach(flatten);
            return;
        }

        if (!value || typeof value !== "object") return;

        objects.push(value);

        if (Array.isArray(value["@graph"])) {
            value["@graph"].forEach(flatten);
        }
    }

    for (const block of blocks) {
        try {
            flatten(JSON.parse(decodeEntities(block[1]).trim()));
        } catch {}
    }

    return objects;
}

function extractPublicationDate(html, jsonObjects, fallbackDate) {
    const candidates = [
        getMeta(html, "article:published_time"),
        getMeta(html, "datePublished"),
        ...jsonObjects.map(item => item.datePublished),
        ...jsonObjects.map(item => item.dateCreated)
    ];

    for (const value of candidates) {
        const date = safeDate(value);
        if (date) return date;
    }

    const timeMatch = html.match(
        /<time[^>]+datetime=["']([^"']+)["']/i
    );
    if (timeMatch) {
        const date = safeDate(timeMatch[1]);
        if (date) return date;
    }

    const visibleMatch = stripHtml(html.slice(0, 80000)).match(
        /(?:發表|發布|刊登|更新|新聞日期|日期)[^0-9]{0,24}(20\d{2})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?/
    );

    if (visibleMatch) {
        return makeUtcDate(
            Number(visibleMatch[1]),
            Number(visibleMatch[2]),
            Number(visibleMatch[3])
        );
    }

    return safeDate(fallbackDate);
}

function extractArticle(html, fallback) {
    const jsonObjects = parseJsonLd(html);
    const articleObject = jsonObjects.find(item => {
        const type = item?.["@type"];
        const types = Array.isArray(type) ? type : [type];
        return types.some(value =>
            ["NewsArticle", "Article", "ReportageNewsArticle"].includes(value)
        );
    }) || {};

    const title = stripHtml(
        articleObject.headline ||
        getMeta(html, "og:title") ||
        getMeta(html, "twitter:title") ||
        fallback.title
    )
        .replace(/\s*[-|｜]\s*巴哈姆特.*$/i, "")
        .trim();

    const rawSummary =
        articleObject.description ||
        getMeta(html, "og:description") ||
        getMeta(html, "description") ||
        fallback.summary ||
        "";

    const articleBody = cleanSummary(
        articleObject.articleBody || "",
        title
    );

    const summary = cleanSummary(rawSummary, title);
    const publishedDate = extractPublicationDate(
        html,
        jsonObjects,
        fallback.publishedAt
    );

    return {
        ...fallback,
        title,
        summary: truncate(summary || articleBody, 420),
        articleBody: truncate(articleBody, 6000),
        publishedAt: publishedDate?.toISOString() || null,
        articleFetched: true
    };
}

function makeUtcDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
}

function dateKey(date) {
    if (!date) return null;
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-");
}

function dateFromKey(value) {
    const match = String(value || "").match(
        /^(20\d{2})-(\d{2})-(\d{2})$/
    );

    if (!match) return null;

    return makeUtcDate(
        Number(match[1]),
        Number(match[2]),
        Number(match[3])
    );
}

function addDays(date, days) {
    if (!date) return null;
    return new Date(date.getTime() + days * 86400000);
}

function dayDifference(later, earlier) {
    return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

function taiwanToday(now = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });

    const parts = Object.fromEntries(
        formatter.formatToParts(now)
            .filter(part => part.type !== "literal")
            .map(part => [part.type, part.value])
    );

    return makeUtcDate(
        Number(parts.year),
        Number(parts.month),
        Number(parts.day)
    );
}

function inferYear(month, baseDate) {
    const base = baseDate || taiwanToday();
    const baseYear = base.getUTCFullYear();
    const baseMonth = base.getUTCMonth() + 1;

    if (month < baseMonth - 6) return baseYear + 1;
    if (month > baseMonth + 6) return baseYear - 1;
    return baseYear;
}

function buildDate(
    explicitYear,
    month,
    day,
    baseDate,
    startDate = null
) {
    let year;

    if (explicitYear) {
        year = Number(explicitYear);
    } else if (startDate) {
        year = startDate.getUTCFullYear();
        if (Number(month) < startDate.getUTCMonth() + 1) {
            year += 1;
        }
    } else {
        year = inferYear(Number(month), baseDate);
    }

    return makeUtcDate(year, Number(month), Number(day));
}

function chineseNumber(value) {
    if (/^\d+$/.test(value)) return Number(value);

    const digits = {
        零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4,
        五: 5, 六: 6, 七: 7, 八: 8, 九: 9
    };

    if (value === "十") return 10;

    if (value.includes("十")) {
        const [left, right] = value.split("十");
        return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0);
    }

    return digits[value] ?? null;
}

function extractDurationDays(text) {
    const patterns = [
        /(?:限時|為期|期間限定)\s*([一二兩三四五六七八九十\d]+)\s*(?:日|天)/,
        /(?:限時|為期|期間限定)\s*([一二兩三四五六七八九十\d]+)\s*(?:週|周)/,
        /(?:限時|為期|期間限定)\s*([一二兩三四五六七八九十\d]+)\s*(?:個月|月)/
    ];

    for (let i = 0; i < patterns.length; i++) {
        const match = text.match(patterns[i]);
        if (!match) continue;

        const count = chineseNumber(match[1]);
        if (!count || count < 1) continue;

        if (i === 0) return count;
        if (i === 1) return count * 7;
        return count * 30;
    }

    return null;
}

function contextScore(text, index, length) {
    const context = text.slice(
        Math.max(0, index - 48),
        Math.min(text.length, index + length + 48)
    );

    let score = 0;

    if (/(?:快閃|展覽|特展|活動|咖啡|餐廳|見面會|簽名會|演唱會|動漫節|漫博|登場|開展|開幕|舉辦|舉行|展期|期間)/.test(context)) {
        score += 7;
    }

    if (/(?:預售|售票|開賣|啟售|報名|抽選|發售|截止|公布|新聞發布)/.test(context)) {
        score -= 9;
    }

    return score;
}

function extractEventDates(text, publishedAt, type) {
    const normalized = String(text || "")
        .replace(/[–—－]/g, "-")
        .replace(/～/g, "~")
        .replace(/\s+/g, " ");

    const publishedDate = safeDate(publishedAt) || taiwanToday();
    const candidates = [];

    function pushCandidate(startDate, endDate, score, source) {
        if (!startDate && !endDate) return;
        candidates.push({ startDate, endDate, score, source });
    }

    const chineseRange = /(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:起|開始|開展|登場|舉辦|舉行)?\s*(?:至|到|迄|~|-)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
    for (const match of normalized.matchAll(chineseRange)) {
        const start = buildDate(match[1], match[2], match[3], publishedDate);
        const end = buildDate(match[4], match[5], match[6], publishedDate, start);
        pushCandidate(
            start,
            end,
            20 + contextScore(normalized, match.index, match[0].length),
            match[0]
        );
    }

    const sameMonthRange = /(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:至|到|迄|~|-)\s*(\d{1,2})\s*日/g;
    for (const match of normalized.matchAll(sameMonthRange)) {
        const start = buildDate(match[1], match[2], match[3], publishedDate);
        const end = buildDate(match[1], match[2], match[4], publishedDate, start);
        pushCandidate(
            start,
            end,
            20 + contextScore(normalized, match.index, match[0].length),
            match[0]
        );
    }

    const slashRange = /(?:(20\d{2})[\/.])?(\d{1,2})[\/.](\d{1,2})\s*(?:起|開始)?\s*(?:至|到|迄|~|-)\s*(?:(20\d{2})[\/.])?(\d{1,2})[\/.](\d{1,2})/g;
    for (const match of normalized.matchAll(slashRange)) {
        const start = buildDate(match[1], match[2], match[3], publishedDate);
        const end = buildDate(match[4], match[5], match[6], publishedDate, start);
        pushCandidate(
            start,
            end,
            20 + contextScore(normalized, match.index, match[0].length),
            match[0]
        );
    }

    const todayToChinese = /(?:即日起|今日起|今起|自即日起)\s*(?:至|到|迄|~|-)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
    for (const match of normalized.matchAll(todayToChinese)) {
        const start = makeUtcDate(
            publishedDate.getUTCFullYear(),
            publishedDate.getUTCMonth() + 1,
            publishedDate.getUTCDate()
        );
        const end = buildDate(match[1], match[2], match[3], publishedDate, start);
        pushCandidate(start, end, 22, match[0]);
    }

    const todayToSlash = /(?:即日起|今日起|今起|自即日起)\s*(?:至|到|迄|~|-)\s*(?:(20\d{2})[\/.])?(\d{1,2})[\/.](\d{1,2})/g;
    for (const match of normalized.matchAll(todayToSlash)) {
        const start = makeUtcDate(
            publishedDate.getUTCFullYear(),
            publishedDate.getUTCMonth() + 1,
            publishedDate.getUTCDate()
        );
        const end = buildDate(match[1], match[2], match[3], publishedDate, start);
        pushCandidate(start, end, 22, match[0]);
    }

    const singleChinese = /(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
    for (const match of normalized.matchAll(singleChinese)) {
        const start = buildDate(match[1], match[2], match[3], publishedDate);
        const score = 8 + contextScore(normalized, match.index, match[0].length);
        pushCandidate(start, null, score, match[0]);
    }

    const singleSlash = /(?:(20\d{2})[\/.])?(\d{1,2})[\/.](\d{1,2})/g;
    for (const match of normalized.matchAll(singleSlash)) {
        const start = buildDate(match[1], match[2], match[3], publishedDate);
        const score = 7 + contextScore(normalized, match.index, match[0].length);
        pushCandidate(start, null, score, match[0]);
    }

    if (/明日起/.test(normalized)) {
        const start = addDays(publishedDate, 1);
        pushCandidate(start, null, 11, "明日起");
    } else if (/(?:即日起|今日起|今起)/.test(normalized)) {
        pushCandidate(publishedDate, null, 10, "即日起");
    }

    candidates.sort((a, b) => {
        const rangeBonusA = a.endDate ? 3 : 0;
        const rangeBonusB = b.endDate ? 3 : 0;
        return (b.score + rangeBonusB) - (a.score + rangeBonusA);
    });

    const best = candidates.find(candidate => candidate.score >= 5) || null;

    if (!best) {
        return {
            startDate: null,
            endDate: null,
            dateConfidence: "unknown",
            dateSource: ""
        };
    }

    let { startDate, endDate } = best;

    if (startDate && !endDate) {
        const duration = extractDurationDays(normalized);
        if (duration) {
            endDate = addDays(startDate, Math.max(0, duration - 1));
        }
    }

    return {
        startDate: dateKey(startDate),
        endDate: dateKey(endDate),
        dateConfidence: endDate ? "high" : "medium",
        dateSource: best.source
    };
}

function determineEventStatus(dateInfo, publishedAt, type, today) {
    const start = dateFromKey(dateInfo.startDate);
    const end = dateFromKey(dateInfo.endDate);
    const published = safeDate(publishedAt);

    if (end && end < today) {
        return { keep: false, status: "expired", reason: "expired" };
    }

    if (start && !end) {
        const maxDays = maxSingleDateDuration[type] || 30;
        const assumedEnd = addDays(start, maxDays);

        if (assumedEnd < today) {
            return { keep: false, status: "expired", reason: "expired" };
        }

        if (start > addDays(today, 450)) {
            return { keep: false, status: "too-far", reason: "tooFar" };
        }

        return {
            keep: true,
            status: start > today ? "upcoming" : "ongoing-unconfirmed",
            reason: ""
        };
    }

    if (start && end) {
        return {
            keep: true,
            status: start > today ? "upcoming" : "ongoing",
            reason: ""
        };
    }

    if (!published) {
        return { keep: false, status: "unknown", reason: "missingDate" };
    }

    const age = dayDifference(today, makeUtcDate(
        published.getUTCFullYear(),
        published.getUTCMonth() + 1,
        published.getUTCDate()
    ));

    if (age > RECENT_UNDATED_DAYS) {
        return { keep: false, status: "unknown", reason: "undatedOld" };
    }

    return {
        keep: true,
        status: "date-unknown",
        reason: ""
    };
}

function isExpoNoise(title, type) {
    if (type !== "大型展會") return false;

    if (!/【(?:TiCA|漫博)\d+】/i.test(title)) return false;

    return !/(?:簽名會|見面會|演出|活動資訊|開幕|登場|舉辦|展期|門票|總整理|日期|時間)/.test(title);
}

function evaluateArticle(item, today, counters) {
    const title = item.title || "";
    const summary = item.summary || "";
    const body = item.articleBody || "";
    const type = classifyActivity(title, summary);

    if (!type) {
        counters.notActivity++;
        return null;
    }

    if (isExpoNoise(title, type)) {
        counters.expoNoise++;
        return null;
    }

    const primaryText = `${title} ${summary}`;
    const fullText = `${primaryText} ${body.slice(0, 1800)}`;

    if (includesAny(primaryText, recapWords)) {
        counters.recapRemoved++;
        return null;
    }

    if (
        includesAny(primaryText, onlineOnlyWords) &&
        !includesAny(primaryText, physicalWords)
    ) {
        counters.onlineRemoved++;
        return null;
    }

    const locations = detectLocations(primaryText);
    const bodyLocations = locations.length > 0
        ? []
        : detectLocations(body.slice(0, 1800));
    const finalLocations = [...new Set([...locations, ...bodyLocations])];

    const hasTaiwan =
        includesAny(fullText, taiwanWords) ||
        finalLocations.length > 0;

    const looksForeign = includesAny(primaryText, foreignLocationWords);

    if (looksForeign && !hasTaiwan) {
        counters.foreignRemoved++;
        return null;
    }

    if (!hasTaiwan) {
        counters.noTaiwanRemoved++;
        return null;
    }

    const dateText = `${title} ${summary} ${body.slice(0, 3200)}`;
    const dateInfo = extractEventDates(
        dateText,
        item.publishedAt,
        type
    );

    const status = determineEventStatus(
        dateInfo,
        item.publishedAt,
        type,
        today
    );

    if (!status.keep) {
        counters[`${status.reason}Removed`] =
            (counters[`${status.reason}Removed`] || 0) + 1;
        return null;
    }

    return {
        id: item.id,
        title,
        summary: truncate(summary, 320),
        url: item.url,
        source: "巴哈姆特 GNN",
        discoverySource: item.discoverySource,
        sourceTag: item.sourceTag || "",
        type,
        locations: finalLocations.length > 0
            ? finalLocations
            : ["台灣"],
        confidence: finalLocations.length > 0 ? "high" : "candidate",
        publishedAt: item.publishedAt || null,
        eventStartDate: dateInfo.startDate,
        eventEndDate: dateInfo.endDate,
        eventStatus: status.status,
        dateConfidence: dateInfo.dateConfidence,
        dateSource: dateInfo.dateSource,
        verification:
            status.status === "date-unknown"
                ? "文章近期發布，但程式無法確認完整活動日期，請先查看原文。"
                : dateInfo.endDate
                    ? "已自動擷取活動期間，仍請以原文與主辦方公告為準。"
                    : "只擷取到開始日期，結束日期請查看原文確認。"
    };
}

function eventIdentity(event) {
    const workMatch = event.title.match(/《([^》]+)》/);
    const work = workMatch
        ? workMatch[1]
        : event.title
            .replace(/【[^】]+】/g, "")
            .replace(/20\d{2}\s*年/g, "")
            .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, "")
            .replace(/\d{1,2}[\/.]\d{1,2}/g, "")
            .replace(/(?:宣布|正式|今日起|即日起|登場|開展|開幕|舉辦|啟售|預售票)/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "")
            .slice(0, 26);

    return [
        event.type,
        normalizeText(work),
        [...event.locations].sort().join(",")
    ].join("|");
}

function dedupeEvents(events) {
    const map = new Map();

    for (const event of events) {
        const key = eventIdentity(event);
        const previous = map.get(key);

        if (!previous) {
            map.set(key, event);
            continue;
        }

        const previousTime =
            safeDate(previous.publishedAt)?.getTime() ||
            dateFromKey(previous.eventStartDate)?.getTime() ||
            0;

        const currentTime =
            safeDate(event.publishedAt)?.getTime() ||
            dateFromKey(event.eventStartDate)?.getTime() ||
            0;

        if (currentTime >= previousTime) {
            map.set(key, event);
        }
    }

    return [...map.values()];
}

function sortEvents(events, today) {
    const statusRank = {
        ongoing: 0,
        "ongoing-unconfirmed": 1,
        upcoming: 2,
        "date-unknown": 3
    };

    return [...events].sort((a, b) => {
        const rankA = statusRank[a.eventStatus] ?? 9;
        const rankB = statusRank[b.eventStatus] ?? 9;

        if (rankA !== rankB) return rankA - rankB;

        const dateA =
            dateFromKey(a.eventStartDate)?.getTime() ||
            safeDate(a.publishedAt)?.getTime() ||
            today.getTime();

        const dateB =
            dateFromKey(b.eventStartDate)?.getTime() ||
            safeDate(b.publishedAt)?.getTime() ||
            today.getTime();

        return rankA <= 1 ? dateB - dateA : dateA - dateB;
    });
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
                await delay(900 * attempt);
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

    return blocks.map(block => {
        const title = stripHtml(getTag(block, "title"));
        return {
            id: makeId(
                normalizeGnnUrl(
                    stripHtml(getTag(block, "link")) ||
                    stripHtml(getTag(block, "guid"))
                )
            ),
            title,
            url: normalizeGnnUrl(
                stripHtml(getTag(block, "link")) ||
                stripHtml(getTag(block, "guid"))
            ),
            summary: cleanSummary(
                getTag(block, "description") ||
                getTag(block, "content:encoded"),
                title
            ),
            publishedAt:
                safeDate(stripHtml(getTag(block, "pubDate")))
                    ?.toISOString() || null,
            discoverySource: "RSS",
            sourceTag: "",
            isRss: true,
            articleFetched: false
        };
    }).filter(item => item.url && item.title);
}

function parseTagPage(html, sourceTag) {
    const anchorPattern =
        /<a\b[^>]*href=["']([^"']*detail\.php\?[^"']*sn=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

    const byUrl = new Map();
    let match;

    while ((match = anchorPattern.exec(html)) !== null) {
        const url = normalizeGnnUrl(match[1]);
        const title = stripHtml(match[2]);

        if (!url || !title) continue;
        if (/^(?:繼續閱讀|更多|read more)$/i.test(title)) continue;

        const id = makeId(url);
        const previous = byUrl.get(id);

        if (!previous || title.length > previous.title.length) {
            byUrl.set(id, {
                id,
                title,
                url,
                summary: "",
                publishedAt: null,
                discoverySource: `標籤：${sourceTag}`,
                sourceTag,
                isRss: false,
                articleFetched: false
            });
        }
    }

    return [...byUrl.values()];
}

function mergeRawItems(items) {
    const byId = new Map();

    for (const item of items) {
        if (!item.id || !item.url) continue;

        const previous = byId.get(item.id);

        if (!previous) {
            byId.set(item.id, item);
            continue;
        }

        byId.set(item.id, {
            ...previous,
            ...item,
            title:
                item.title.length > previous.title.length
                    ? item.title
                    : previous.title,
            summary: item.summary || previous.summary,
            publishedAt: item.publishedAt || previous.publishedAt,
            isRss: item.isRss || previous.isRss,
            sourceTag: item.sourceTag || previous.sourceTag,
            discoverySource: [
                previous.discoverySource,
                item.discoverySource
            ]
                .filter(Boolean)
                .filter((value, index, array) => array.indexOf(value) === index)
                .join("、")
        });
    }

    return [...byId.values()];
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function run() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, run)
    );

    return results;
}

async function collectSources(sourceErrors) {
    const rssItems = [];
    const tagItems = [];

    try {
        const xml = await fetchTextWithRetries(RSS_URL);
        rssItems.push(...parseRss(xml));
    } catch (error) {
        sourceErrors.push({
            source: "GNN RSS",
            error: String(error.message || error)
        });
    }

    for (const config of TAG_PAGES) {
        for (let page = 1; page <= config.pages; page++) {
            const url =
                "https://gnn.gamer.com.tw/search_tag.php" +
                `?q=${encodeURIComponent(config.tag)}` +
                (page > 1 ? `&page=${page}` : "");

            try {
                const html = await fetchTextWithRetries(url, 2);
                tagItems.push(...parseTagPage(html, config.tag));
            } catch (error) {
                sourceErrors.push({
                    source: `標籤 ${config.tag} 第 ${page} 頁`,
                    error: String(error.message || error)
                });
            }

            await delay(250);
        }
    }

    return { rssItems, tagItems };
}

function selectArticleCandidates(rawItems) {
    const rss = rawItems
        .filter(item => item.isRss)
        .sort((a, b) => articleNumber(b) - articleNumber(a));

    const rssIds = new Set(rss.map(item => item.id));

    const tagOnly = rawItems
        .filter(item => !rssIds.has(item.id))
        .sort((a, b) => articleNumber(b) - articleNumber(a));

    return [
        ...rss,
        ...tagOnly
    ].slice(0, MAX_ARTICLE_FETCHES);
}

async function enrichArticles(items, sourceErrors, counters) {
    return await mapLimit(items, 4, async item => {
        try {
            const html = await fetchTextWithRetries(
                item.url,
                2,
                18000
            );

            counters.articleFetchSuccess++;
            await delay(90);
            return extractArticle(html, item);
        } catch (error) {
            counters.articleFetchFailure++;
            sourceErrors.push({
                source: `文章 ${item.id}`,
                error: String(error.message || error)
            });

            if (item.isRss && item.summary && item.publishedAt) {
                return item;
            }

            return null;
        }
    });
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

function existingEventStillValid(event, today) {
    const status = determineEventStatus(
        {
            startDate: event.eventStartDate,
            endDate: event.eventEndDate
        },
        event.publishedAt,
        event.type,
        today
    );

    return status.keep;
}

async function main() {
    const now = new Date();
    const today = taiwanToday(now);
    const existing = await readExistingData();
    const sourceErrors = [];

    const counters = {
        articleFetchSuccess: 0,
        articleFetchFailure: 0,
        notActivity: 0,
        expoNoise: 0,
        recapRemoved: 0,
        onlineRemoved: 0,
        foreignRemoved: 0,
        noTaiwanRemoved: 0,
        expiredRemoved: 0,
        undatedOldRemoved: 0,
        missingDateRemoved: 0,
        tooFarRemoved: 0
    };

    const { rssItems, tagItems } = await collectSources(sourceErrors);
    const rawItems = mergeRawItems([...rssItems, ...tagItems]);

    if (rawItems.length === 0) {
        await writeJson({
            meta: {
                ...existing.meta,
                schemaVersion: SCHEMA_VERSION,
                sourceName: "巴哈姆特 GNN RSS＋公開標籤頁",
                sourceUrl: RSS_URL,
                updatedAt: now.toISOString(),
                lastAttemptAt: now.toISOString(),
                fetchStatus: "error",
                lastError: "RSS 與標籤頁都沒有取得任何資料",
                sourceErrors,
                storedEventCount: existing.events.length,
                note: "本次讀取失敗，已保留上一次成功資料。"
            },
            events: existing.events
        });
        return;
    }

    const candidates = selectArticleCandidates(rawItems);
    const enriched = (
        await enrichArticles(candidates, sourceErrors, counters)
    ).filter(Boolean);

    const freshEvents = [];

    for (const item of enriched) {
        const event = evaluateArticle(item, today, counters);
        if (event) {
            freshEvents.push({
                ...event,
                discoveredAt: now.toISOString(),
                lastSeenAt: now.toISOString()
            });
        }
    }

    let carryEvents = [];

    if (existing.meta.schemaVersion === SCHEMA_VERSION) {
        const freshIds = new Set(freshEvents.map(event => event.id));

        carryEvents = existing.events.filter(event =>
            !freshIds.has(event.id) &&
            existingEventStillValid(event, today)
        );
    }

    const finalEvents = sortEvents(
        dedupeEvents([...freshEvents, ...carryEvents]),
        today
    );

    const fetchStatus =
        sourceErrors.length > 0 ? "partial" : "success";

    const output = {
        meta: {
            schemaVersion: SCHEMA_VERSION,
            sourceName: "巴哈姆特 GNN RSS＋公開標籤頁",
            sourceUrl: RSS_URL,
            updatedAt: now.toISOString(),
            lastSuccessfulUpdateAt: now.toISOString(),
            fetchStatus,
            fetchedRssCount: rssItems.length,
            fetchedTagItemCount: tagItems.length,
            uniqueNewsCount: rawItems.length,
            articleCandidateCount: candidates.length,
            articleFetchSuccessCount: counters.articleFetchSuccess,
            articleFetchFailureCount: counters.articleFetchFailure,
            matchedEventCount: freshEvents.length,
            storedEventCount: finalEvents.length,
            expiredRemovedCount: counters.expiredRemoved,
            recapRemovedCount: counters.recapRemoved,
            undatedOldRemovedCount: counters.undatedOldRemoved,
            missingDateRemovedCount: counters.missingDateRemoved,
            foreignRemovedCount: counters.foreignRemoved,
            nonActivityRemovedCount:
                counters.notActivity + counters.expoNoise,
            sourceErrors: sourceErrors.slice(0, 30),
            note:
                "只保留正在進行、即將開始，或近期發布但日期待確認的台灣實體動漫活動。舊活動、已落幕文章與被相鄰文章污染的摘要會被排除。"
        },
        events: finalEvents
    };

    await writeJson(output);

    console.log(
        `完成：RSS ${rssItems.length} 則，` +
        `標籤頁 ${tagItems.length} 筆，` +
        `文章成功 ${counters.articleFetchSuccess} 篇，` +
        `保留 ${finalEvents.length} 則活動，` +
        `排除過期 ${counters.expiredRemoved} 則。`
    );
}

function runSelfTests() {
    const today = makeUtcDate(2026, 7, 10);
    const tests = [
        {
            name: "已過期範圍",
            text: "自 2026 年 5 月 15 日起至 5 月 21 日在台北舉辦快閃店",
            publishedAt: "2026-05-15T00:00:00Z",
            type: "快閃店",
            keep: false
        },
        {
            name: "未來展覽",
            text: "2026 年 7 月 15 日至 8 月 30 日在台北三創舉行展覽",
            publishedAt: "2026-06-20T00:00:00Z",
            type: "展覽",
            keep: true,
            start: "2026-07-15",
            end: "2026-08-30"
        },
        {
            name: "限時五日",
            text: "快閃店 4/23 起限時五日於新店裕隆城登場",
            publishedAt: "2026-04-20T00:00:00Z",
            type: "快閃店",
            keep: false,
            start: "2026-04-23",
            end: "2026-04-27"
        },
        {
            name: "預售日期不能蓋過活動日期",
            text: "動畫展 7 月 20 日台中登場，預售票 6/24 正式啟售",
            publishedAt: "2026-06-20T00:00:00Z",
            type: "展覽",
            keep: true,
            start: "2026-07-20"
        }
    ];

    for (const test of tests) {
        const dates = extractEventDates(
            test.text,
            test.publishedAt,
            test.type
        );
        const status = determineEventStatus(
            dates,
            test.publishedAt,
            test.type,
            today
        );

        if (status.keep !== test.keep) {
            throw new Error(`${test.name} keep 判斷失敗`);
        }

        if (test.start && dates.startDate !== test.start) {
            throw new Error(
                `${test.name} start 錯誤：${dates.startDate}`
            );
        }

        if (test.end && dates.endDate !== test.end) {
            throw new Error(
                `${test.name} end 錯誤：${dates.endDate}`
            );
        }
    }

    console.log("日期與過期活動過濾測試通過。");
}

if (process.env.SELF_TEST === "1") {
    runSelfTests();
} else {
    await main();
}
