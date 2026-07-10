import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const RSS_URL =
    process.env.BAHAMUT_RSS_URL ||
    "https://gnn.gamer.com.tw/rss.xml";

const LOCAL_RSS_FILE =
    process.env.BAHAMUT_RSS_FILE || "";

const OUTPUT_FILE =
    process.env.OUTPUT_FILE || "events.json";

const KEEP_DAYS =
    Number(process.env.KEEP_DAYS || 180);

const activityRules = [
    {
        type: "快閃店",
        keywords: [
            "快閃店",
            "期間限定店",
            "期間限定商店",
            "pop up",
            "pop-up",
            "popup store"
        ]
    },
    {
        type: "主題咖啡廳",
        keywords: [
            "主題咖啡",
            "聯名咖啡",
            "合作咖啡",
            "主題餐廳",
            "聯名餐廳"
        ]
    },
    {
        type: "展覽",
        keywords: [
            "特展",
            "展覽",
            "原畫展",
            "紀念展",
            "主題展",
            "動漫展",
            "漫畫博覽會",
            "漫畫博覽",
            "漫博",
            "動漫節"
        ]
    },
    {
        type: "見面會",
        keywords: [
            "見面會",
            "聲優活動",
            "聲優來台",
            "簽名會",
            "握手會",
            "粉絲見面"
        ]
    },
    {
        type: "舞台／演出",
        keywords: [
            "演唱會",
            "音樂會",
            "舞台劇",
            "音樂劇",
            "現場演出"
        ]
    },
    {
        type: "市集／大型活動",
        keywords: [
            "同人誌販售會",
            "同人展",
            "cosplay 活動",
            "cosplay大賽",
            "動漫市集",
            "主題市集"
        ]
    }
];

const locationRules = [
    ["台北", ["台北", "臺北", "華山", "松菸", "三創", "信義", "南港", "西門"]],
    ["新北", ["新北", "板橋", "新莊", "淡水", "中和", "永和"]],
    ["桃園", ["桃園", "中壢"]],
    ["新竹", ["新竹"]],
    ["台中", ["台中", "臺中"]],
    ["彰化", ["彰化"]],
    ["嘉義", ["嘉義"]],
    ["台南", ["台南", "臺南"]],
    ["高雄", ["高雄", "駁二"]],
    ["屏東", ["屏東"]],
    ["宜蘭", ["宜蘭"]],
    ["花蓮", ["花蓮"]],
    ["台東", ["台東", "臺東"]],
    ["全台", ["全台", "全臺", "北中南"]]
];

const taiwanWords = [
    "台灣",
    "臺灣",
    "來台",
    "來臺",
    "全台",
    "全臺"
];

const onlineOrGameOnlyWords = [
    "遊戲內活動",
    "登入活動",
    "登入獎勵",
    "儲值活動",
    "轉蛋活動",
    "限時副本",
    "伺服器活動",
    "事前登錄",
    "事前預約",
    "虛寶",
    "序號",
    "卡池",
    "版本更新",
    "改版活動"
];

const strongOfflineWords = [
    "快閃店",
    "限定店",
    "咖啡",
    "餐廳",
    "特展",
    "展覽",
    "原畫展",
    "見面會",
    "簽名會",
    "演唱會",
    "音樂會",
    "舞台劇",
    "市集",
    "販售會",
    "會場",
    "百貨",
    "三創",
    "華山",
    "松菸",
    "駁二"
];

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeXml(value = "") {
    return String(value)
        .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_, n) =>
            String.fromCodePoint(Number(n))
        )
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
            String.fromCodePoint(parseInt(n, 16))
        )
        .trim();
}

function stripHtml(value = "") {
    return decodeXml(value)
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
    return match ? decodeXml(match[1]) : "";
}

function parseRss(xml) {
    const blocks =
        String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];

    return blocks.map(block => ({
        title: stripHtml(getTag(block, "title")),
        link: stripHtml(getTag(block, "link")),
        guid: stripHtml(getTag(block, "guid")),
        description: stripHtml(
            getTag(block, "description") ||
            getTag(block, "content:encoded")
        ),
        pubDate: stripHtml(getTag(block, "pubDate"))
    }));
}

function normalizeText(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function classifyActivity(text) {
    const normalized = normalizeText(text);

    for (const rule of activityRules) {
        if (
            rule.keywords.some(keyword =>
                normalized.includes(keyword.toLowerCase())
            )
        ) {
            return rule.type;
        }
    }

    return "";
}

function detectLocations(text) {
    const found = [];

    for (const [label, keywords] of locationRules) {
        if (keywords.some(keyword => text.includes(keyword))) {
            found.push(label);
        }
    }

    return [...new Set(found)];
}

function isLikelyTaiwanOfflineEvent(text) {
    const type = classifyActivity(text);

    if (!type) {
        return null;
    }

    const locations = detectLocations(text);

    const hasTaiwanWord =
        taiwanWords.some(word => text.includes(word));

    const hasPhysicalClue =
        strongOfflineWords.some(word => text.includes(word));

    const looksGameOnly =
        onlineOrGameOnlyWords.some(word => text.includes(word));

    if (looksGameOnly && !hasPhysicalClue) {
        return null;
    }

    /*
     * 高精準模式：
     * 必須同時像實體活動，且文字中有台灣／城市／場地線索。
     * 寧可少抓，也不要塞入日本或遊戲內活動。
     */
    if (
        !hasPhysicalClue ||
        (!hasTaiwanWord && locations.length === 0)
    ) {
        return null;
    }

    return {
        type,
        locations:
            locations.length > 0 ? locations : ["台灣"]
    };
}

function normalizeGnnUrl(rawUrl) {
    if (!rawUrl) {
        return "";
    }

    try {
        const url = new URL(rawUrl);

        if (url.hostname !== "gnn.gamer.com.tw") {
            return "";
        }

        url.hash = "";
        return url.toString();
    } catch {
        return "";
    }
}

function makeId(url) {
    const sn = new URL(url).searchParams.get("sn");

    if (sn) {
        return `gnn-${sn}`;
    }

    return `gnn-${crypto
        .createHash("sha256")
        .update(url)
        .digest("hex")
        .slice(0, 16)}`;
}

function safeDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}

function truncate(value, maxLength = 260) {
    const text = String(value || "").trim();

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 1)}…`;
}

async function fetchTextWithRetries(url, attempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            20000
        );

        try {
            const response = await fetch(url, {
                redirect: "follow",
                signal: controller.signal,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (X11; Linux x86_64) " +
                        "AppleWebKit/537.36 Chrome/126 Safari/537.36 " +
                        "TaiwanAnimeEventRadar/1.0",
                    "Accept":
                        "application/rss+xml, application/xml, " +
                        "text/xml;q=0.9, */*;q=0.8",
                    "Accept-Language":
                        "zh-TW,zh;q=0.9,en;q=0.5",
                    "Referer":
                        "https://gnn.gamer.com.tw/"
                }
            });

            if (!response.ok) {
                throw new Error(
                    `RSS HTTP ${response.status} ${response.statusText}`
                );
            }

            const text = await response.text();

            if (!/<rss\b|<feed\b/i.test(text)) {
                throw new Error("回傳內容不是 RSS/XML");
            }

            return text;
        } catch (error) {
            lastError = error;

            console.warn(
                `RSS 第 ${attempt}/${attempts} 次讀取失敗：`,
                error.message
            );

            if (attempt < attempts) {
                await delay(1500 * attempt);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    throw lastError || new Error("RSS 讀取失敗");
}

async function readExistingData() {
    try {
        const text = await fs.readFile(
            OUTPUT_FILE,
            "utf8"
        );

        const parsed = JSON.parse(text);

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
        return {
            meta: {},
            events: []
        };
    }
}

async function readRssText() {
    if (LOCAL_RSS_FILE) {
        return await fs.readFile(
            LOCAL_RSS_FILE,
            "utf8"
        );
    }

    return await fetchTextWithRetries(RSS_URL);
}

async function writeJson(data) {
    const directory = path.dirname(OUTPUT_FILE);

    if (directory && directory !== ".") {
        await fs.mkdir(directory, {
            recursive: true
        });
    }

    await fs.writeFile(
        OUTPUT_FILE,
        `${JSON.stringify(data, null, 2)}\n`,
        "utf8"
    );
}

async function main() {
    const now = new Date();
    const existing = await readExistingData();

    try {
        const xml = await readRssText();
        const rssItems = parseRss(xml);

        if (rssItems.length === 0) {
            throw new Error("RSS 中沒有讀到任何新聞項目");
        }

        const oldById = new Map(
            existing.events.map(event => [
                event.id,
                event
            ])
        );

        const freshEvents = [];

        for (const item of rssItems) {
            const url = normalizeGnnUrl(
                item.link || item.guid
            );

            if (!url || !item.title) {
                continue;
            }

            const combinedText =
                `${item.title} ${item.description}`;

            const match =
                isLikelyTaiwanOfflineEvent(
                    combinedText
                );

            if (!match) {
                continue;
            }

            const id = makeId(url);
            const previous = oldById.get(id);
            const publishedDate =
                safeDate(item.pubDate);

            freshEvents.push({
                id,
                title: item.title,
                summary: truncate(item.description),
                url,
                source: "巴哈姆特 GNN",
                type: match.type,
                locations: match.locations,
                publishedAt:
                    publishedDate
                        ? publishedDate.toISOString()
                        : null,
                discoveredAt:
                    previous?.discoveredAt ||
                    now.toISOString(),
                lastSeenAt: now.toISOString(),
                verification:
                    "請開啟巴哈姆特原文確認活動日期、地點與入場方式"
            });
        }

        const mergedById = new Map();

        for (const oldEvent of existing.events) {
            mergedById.set(
                oldEvent.id,
                oldEvent
            );
        }

        for (const freshEvent of freshEvents) {
            mergedById.set(
                freshEvent.id,
                {
                    ...mergedById.get(freshEvent.id),
                    ...freshEvent
                }
            );
        }

        const cutoff =
            now.getTime() -
            KEEP_DAYS * 24 * 60 * 60 * 1000;

        const mergedEvents = [
            ...mergedById.values()
        ]
            .filter(event => {
                const date =
                    safeDate(event.publishedAt) ||
                    safeDate(event.discoveredAt);

                return (
                    date &&
                    date.getTime() >= cutoff
                );
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

        const output = {
            meta: {
                sourceName: "巴哈姆特 GNN RSS",
                sourceUrl: RSS_URL,
                updatedAt: now.toISOString(),
                lastSuccessfulUpdateAt:
                    now.toISOString(),
                fetchStatus: "success",
                fetchedNewsCount:
                    rssItems.length,
                matchedEventCount:
                    freshEvents.length,
                storedEventCount:
                    mergedEvents.length,
                keepDays: KEEP_DAYS,
                note:
                    "此清單是從新聞標題與摘要自動篩選，活動日期與地點請以巴哈姆特原文及主辦方公告為準。"
            },
            events: mergedEvents
        };

        await writeJson(output);

        console.log(
            `完成：讀取 ${rssItems.length} 則新聞，` +
            `本次符合 ${freshEvents.length} 則，` +
            `目前保存 ${mergedEvents.length} 則活動消息。`
        );
    } catch (error) {
        const output = {
            meta: {
                ...existing.meta,
                sourceName:
                    existing.meta.sourceName ||
                    "巴哈姆特 GNN RSS",
                sourceUrl:
                    existing.meta.sourceUrl ||
                    RSS_URL,
                updatedAt: now.toISOString(),
                lastAttemptAt:
                    now.toISOString(),
                fetchStatus: "error",
                lastError:
                    String(
                        error?.message ||
                        error
                    ),
                storedEventCount:
                    existing.events.length,
                note:
                    "本次讀取失敗，已保留上一次成功取得的活動資料，不會清空清單。"
            },
            events: existing.events
        };

        await writeJson(output);

        console.error(
            "本次更新失敗，已保留舊資料：",
            error
        );

        /*
         * 不讓排程因單次 403 或網路波動中斷；
         * 狀態會寫入 events.json，方便網站顯示。
         */
    }
}

await main();
