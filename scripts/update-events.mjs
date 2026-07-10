import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/*
 * ==========================================
 * 基本設定
 * ==========================================
 */

const RSS_URL =
    process.env.BAHAMUT_RSS_URL ||
    "https://gnn.gamer.com.tw/rss.xml";

const LOCAL_RSS_FILE =
    process.env.BAHAMUT_RSS_FILE || "";

const OUTPUT_FILE =
    process.env.OUTPUT_FILE || "events.json";

const KEEP_DAYS =
    Number(process.env.KEEP_DAYS || 180);


/*
 * ==========================================
 * 活動類型關鍵字
 * ==========================================
 */

const activityRules = [
    {
        type: "快閃店",
        keywords: [
            "快閃店",
            "快閃商店",
            "期間限定店",
            "期間限定商店",
            "限定商店",
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
            "期間限定咖啡",
            "主題餐廳",
            "聯名餐廳",
            "合作餐廳"
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
            "動漫節",
            "漫博"
        ]
    },
    {
        type: "見面會",
        keywords: [
            "見面會",
            "聲優活動",
            "聲優來台",
            "聲優來臺",
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
            "現場演出",
            "live 活動",
            "live演出"
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
            "主題市集",
            "動漫祭"
        ]
    }
];


/*
 * ==========================================
 * 台灣地區與場地
 * ==========================================
 */

const locationRules = [
    [
        "台北",
        [
            "台北",
            "臺北",
            "華山",
            "松菸",
            "三創",
            "信義",
            "南港",
            "西門",
            "京站",
            "台北地下街",
            "臺北地下街"
        ]
    ],
    [
        "新北",
        [
            "新北",
            "板橋",
            "新莊",
            "淡水",
            "中和",
            "永和",
            "三重"
        ]
    ],
    [
        "桃園",
        [
            "桃園",
            "中壢",
            "華泰名品城"
        ]
    ],
    [
        "新竹",
        [
            "新竹",
            "竹北"
        ]
    ],
    [
        "台中",
        [
            "台中",
            "臺中",
            "草悟道",
            "勤美"
        ]
    ],
    [
        "彰化",
        [
            "彰化"
        ]
    ],
    [
        "嘉義",
        [
            "嘉義"
        ]
    ],
    [
        "台南",
        [
            "台南",
            "臺南"
        ]
    ],
    [
        "高雄",
        [
            "高雄",
            "駁二",
            "夢時代"
        ]
    ],
    [
        "屏東",
        [
            "屏東"
        ]
    ],
    [
        "宜蘭",
        [
            "宜蘭"
        ]
    ],
    [
        "花蓮",
        [
            "花蓮"
        ]
    ],
    [
        "台東",
        [
            "台東",
            "臺東"
        ]
    ],
    [
        "全台",
        [
            "全台",
            "全臺",
            "北中南"
        ]
    ]
];

const taiwanWords = [
    "台灣",
    "臺灣",
    "來台",
    "來臺",
    "全台",
    "全臺",
    "台灣限定",
    "臺灣限定"
];


/*
 * ==========================================
 * 明確國外地點
 * ==========================================
 */

const foreignLocationWords = [
    "日本",
    "東京",
    "大阪",
    "京都",
    "名古屋",
    "橫濱",
    "神戶",
    "福岡",
    "北海道",
    "沖繩",

    "韓國",
    "首爾",
    "釜山",

    "香港",
    "澳門",

    "中國大陸",
    "上海",
    "北京",
    "廣州",
    "深圳",

    "新加坡",
    "馬來西亞",
    "泰國",
    "曼谷",

    "japan",
    "tokyo",
    "osaka",
    "kyoto",
    "seoul",
    "hong kong",
    "singapore"
];


/*
 * ==========================================
 * 遊戲內活動排除詞
 * ==========================================
 */

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
    "改版活動",
    "限定角色",
    "限定召喚",
    "限時召喚",
    "活動關卡",
    "活動副本",
    "活動任務"
];


/*
 * ==========================================
 * 實體活動判斷詞
 * ==========================================
 */

const strongOfflineWords = [
    "快閃店",
    "快閃商店",
    "限定店",
    "限定商店",
    "期間限定店",

    "咖啡",
    "餐廳",

    "特展",
    "展覽",
    "原畫展",
    "紀念展",
    "主題展",

    "見面會",
    "簽名會",
    "握手會",

    "演唱會",
    "音樂會",
    "舞台劇",
    "音樂劇",

    "市集",
    "販售會",
    "會場",

    "百貨",
    "購物中心",

    "三創",
    "華山",
    "松菸",
    "駁二",

    "入場",
    "門票",
    "售票"
];


/*
 * ==========================================
 * 通用工具
 * ==========================================
 */

function delay(milliseconds) {
    return new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

function normalizeText(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function includesAny(text, words) {
    const normalizedText = normalizeText(text);

    return words.some(word => {
        return normalizedText.includes(
            normalizeText(word)
        );
    });
}

function decodeXml(value = "") {
    return String(value)
        .replace(
            /^<!\[CDATA\[([\s\S]*?)\]\]>$/i,
            "$1"
        )
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(
            /&#(\d+);/g,
            (_, number) =>
                String.fromCodePoint(
                    Number(number)
                )
        )
        .replace(
            /&#x([0-9a-f]+);/gi,
            (_, number) =>
                String.fromCodePoint(
                    parseInt(number, 16)
                )
        )
        .trim();
}

function stripHtml(value = "") {
    return decodeXml(value)
        .replace(
            /<script\b[^>]*>[\s\S]*?<\/script>/gi,
            " "
        )
        .replace(
            /<style\b[^>]*>[\s\S]*?<\/style>/gi,
            " "
        )
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getTag(block, tagName) {
    const pattern = new RegExp(
        `<${tagName}(?:\\s[^>]*)?>` +
        `([\\s\\S]*?)` +
        `<\\/${tagName}>`,
        "i"
    );

    const match = block.match(pattern);

    return match
        ? decodeXml(match[1])
        : "";
}

function safeDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}

function truncate(value, maxLength = 260) {
    const text =
        String(value || "").trim();

    if (text.length <= maxLength) {
        return text;
    }

    return (
        text.slice(0, maxLength - 1) +
        "…"
    );
}


/*
 * ==========================================
 * RSS 解析
 * ==========================================
 */

function parseRss(xml) {
    const itemBlocks =
        String(xml).match(
            /<item\b[\s\S]*?<\/item>/gi
        ) || [];

    return itemBlocks.map(block => {
        return {
            title:
                stripHtml(
                    getTag(block, "title")
                ),

            link:
                stripHtml(
                    getTag(block, "link")
                ),

            guid:
                stripHtml(
                    getTag(block, "guid")
                ),

            description:
                stripHtml(
                    getTag(block, "description") ||
                    getTag(block, "content:encoded")
                ),

            pubDate:
                stripHtml(
                    getTag(block, "pubDate")
                )
        };
    });
}


/*
 * ==========================================
 * 活動分類
 * ==========================================
 */

function classifyActivity(text) {
    const normalizedText =
        normalizeText(text);

    for (const rule of activityRules) {
        const matched =
            rule.keywords.some(keyword => {
                return normalizedText.includes(
                    normalizeText(keyword)
                );
            });

        if (matched) {
            return rule.type;
        }
    }

    return "";
}


/*
 * ==========================================
 * 地點偵測
 * ==========================================
 */

function detectLocations(text) {
    const foundLocations = [];

    for (
        const [label, keywords]
        of locationRules
    ) {
        const matched =
            keywords.some(keyword => {
                return text.includes(keyword);
            });

        if (matched) {
            foundLocations.push(label);
        }
    }

    return [
        ...new Set(foundLocations)
    ];
}


/*
 * ==========================================
 * 台灣實體活動判斷
 * ==========================================
 */

function isLikelyTaiwanOfflineEvent(text) {
    const type =
        classifyActivity(text);

    if (!type) {
        return null;
    }

    const locations =
        detectLocations(text);

    const hasTaiwanWord =
        includesAny(
            text,
            taiwanWords
        );

    const hasPhysicalClue =
        includesAny(
            text,
            strongOfflineWords
        );

    const looksGameOnly =
        includesAny(
            text,
            onlineOrGameOnlyWords
        );

    const looksForeign =
        includesAny(
            text,
            foreignLocationWords
        );

    /*
     * 沒有實體活動相關詞就排除。
     */
    if (!hasPhysicalClue) {
        return null;
    }

    /*
     * 有遊戲內活動詞，而且沒有地點或台灣線索，
     * 通常只是遊戲內活動。
     */
    if (
        looksGameOnly &&
        !hasTaiwanWord &&
        locations.length === 0
    ) {
        return null;
    }

    /*
     * 有台灣或台灣城市線索：
     * 直接判定為高可信度。
     */
    if (
        hasTaiwanWord ||
        locations.length > 0
    ) {
        return {
            type,

            locations:
                locations.length > 0
                    ? locations
                    : ["台灣"],

            confidence: "high"
        };
    }

    /*
     * 明確寫在國外舉辦：
     * 排除。
     */
    if (looksForeign) {
        return null;
    }

    /*
     * 看起來是實體活動，
     * 但 RSS 摘要沒有寫地點。
     * 先列入待確認區。
     */
    return {
        type,
        locations: ["地點待確認"],
        confidence: "candidate"
    };
}


/*
 * ==========================================
 * 巴哈姆特網址處理
 * ==========================================
 */

function normalizeGnnUrl(rawUrl) {
    if (!rawUrl) {
        return "";
    }

    try {
        const url =
            new URL(rawUrl);

        if (
            url.hostname !==
            "gnn.gamer.com.tw"
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
    const parsedUrl =
        new URL(url);

    const articleNumber =
        parsedUrl.searchParams.get("sn");

    if (articleNumber) {
        return `gnn-${articleNumber}`;
    }

    const hash =
        crypto
            .createHash("sha256")
            .update(url)
            .digest("hex")
            .slice(0, 16);

    return `gnn-${hash}`;
}


/*
 * ==========================================
 * 網路請求
 * ==========================================
 */

async function fetchTextWithRetries(
    url,
    attempts = 3
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= attempts;
        attempt++
    ) {
        const controller =
            new AbortController();

        const timeoutId =
            setTimeout(() => {
                controller.abort();
            }, 20000);

        try {
            const response =
                await fetch(url, {
                    redirect: "follow",

                    signal:
                        controller.signal,

                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 " +
                            "(X11; Linux x86_64) " +
                            "AppleWebKit/537.36 " +
                            "Chrome/126 Safari/537.36 " +
                            "TaiwanAnimeEventRadar/1.1",

                        "Accept":
                            "application/rss+xml, " +
                            "application/xml, " +
                            "text/xml;q=0.9, " +
                            "*/*;q=0.8",

                        "Accept-Language":
                            "zh-TW,zh;q=0.9,en;q=0.5",

                        "Referer":
                            "https://gnn.gamer.com.tw/"
                    }
                });

            if (!response.ok) {
                throw new Error(
                    `RSS HTTP ` +
                    `${response.status} ` +
                    `${response.statusText}`
                );
            }

            const text =
                await response.text();

            if (
                !/<rss\b|<feed\b/i.test(text)
            ) {
                throw new Error(
                    "回傳內容不是 RSS/XML"
                );
            }

            return text;
        } catch (error) {
            lastError = error;

            console.warn(
                `RSS 第 ${attempt}/${attempts} ` +
                `次讀取失敗：`,
                error.message
            );

            if (attempt < attempts) {
                await delay(
                    1500 * attempt
                );
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    throw (
        lastError ||
        new Error("RSS 讀取失敗")
    );
}


/*
 * ==========================================
 * 舊資料讀取
 * ==========================================
 */

async function readExistingData() {
    try {
        const text =
            await fs.readFile(
                OUTPUT_FILE,
                "utf8"
            );

        const parsed =
            JSON.parse(text);

        return {
            meta:
                parsed &&
                typeof parsed.meta === "object"
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


/*
 * ==========================================
 * RSS 資料讀取
 * ==========================================
 */

async function readRssText() {
    if (LOCAL_RSS_FILE) {
        return await fs.readFile(
            LOCAL_RSS_FILE,
            "utf8"
        );
    }

    return await fetchTextWithRetries(
        RSS_URL
    );
}


/*
 * ==========================================
 * JSON 寫入
 * ==========================================
 */

async function writeJson(data) {
    const directory =
        path.dirname(OUTPUT_FILE);

    if (
        directory &&
        directory !== "."
    ) {
        await fs.mkdir(
            directory,
            {
                recursive: true
            }
        );
    }

    await fs.writeFile(
        OUTPUT_FILE,
        JSON.stringify(
            data,
            null,
            2
        ) + "\n",
        "utf8"
    );
}


/*
 * ==========================================
 * 主程式
 * ==========================================
 */

async function main() {
    const now =
        new Date();

    const existing =
        await readExistingData();

    try {
        const xml =
            await readRssText();

        const rssItems =
            parseRss(xml);

        if (rssItems.length === 0) {
            throw new Error(
                "RSS 中沒有讀到任何新聞項目"
            );
        }

        const oldById =
            new Map(
                existing.events.map(event => {
                    return [
                        event.id,
                        event
                    ];
                })
            );

        const freshEvents = [];

        for (const item of rssItems) {
            const url =
                normalizeGnnUrl(
                    item.link ||
                    item.guid
                );

            if (
                !url ||
                !item.title
            ) {
                continue;
            }

            const combinedText =
                `${item.title} ` +
                `${item.description}`;

            const match =
                isLikelyTaiwanOfflineEvent(
                    combinedText
                );

            if (!match) {
                continue;
            }

            const id =
                makeId(url);

            const previous =
                oldById.get(id);

            const publishedDate =
                safeDate(
                    item.pubDate
                );

            const isCandidate =
                match.confidence ===
                "candidate";

            freshEvents.push({
                id,

                title:
                    item.title,

                summary:
                    truncate(
                        item.description
                    ),

                url,

                source:
                    "巴哈姆特 GNN",

                type:
                    match.type,

                locations:
                    match.locations,

                confidence:
                    match.confidence,

                publishedAt:
                    publishedDate
                        ? publishedDate.toISOString()
                        : null,

                discoveredAt:
                    previous?.discoveredAt ||
                    now.toISOString(),

                lastSeenAt:
                    now.toISOString(),

                verification:
                    isCandidate
                        ? "此消息疑似為實體活動，但 RSS 摘要沒有明確台灣地點，請開啟原文確認。"
                        : "請開啟巴哈姆特原文確認活動日期、地點與入場方式。"
            });
        }

        /*
         * 合併舊資料與本次資料。
         */
        const mergedById =
            new Map();

        for (
            const oldEvent
            of existing.events
        ) {
            mergedById.set(
                oldEvent.id,
                oldEvent
            );
        }

        for (
            const freshEvent
            of freshEvents
        ) {
            mergedById.set(
                freshEvent.id,
                {
                    ...mergedById.get(
                        freshEvent.id
                    ),

                    ...freshEvent
                }
            );
        }

        /*
         * 刪除保存期限之外的舊消息。
         */
        const cutoff =
            now.getTime() -
            KEEP_DAYS *
            24 *
            60 *
            60 *
            1000;

        const mergedEvents = [
            ...mergedById.values()
        ]
            .filter(event => {
                const date =
                    safeDate(
                        event.publishedAt
                    ) ||
                    safeDate(
                        event.discoveredAt
                    );

                return (
                    date &&
                    date.getTime() >= cutoff
                );
            })
            .sort((eventA, eventB) => {
                const timeA =
                    safeDate(
                        eventA.publishedAt
                    )?.getTime() ||
                    safeDate(
                        eventA.discoveredAt
                    )?.getTime() ||
                    0;

                const timeB =
                    safeDate(
                        eventB.publishedAt
                    )?.getTime() ||
                    safeDate(
                        eventB.discoveredAt
                    )?.getTime() ||
                    0;

                return timeB - timeA;
            });

        const highConfidenceCount =
            freshEvents.filter(event => {
                return (
                    event.confidence ===
                    "high"
                );
            }).length;

        const candidateCount =
            freshEvents.filter(event => {
                return (
                    event.confidence ===
                    "candidate"
                );
            }).length;

        const output = {
            meta: {
                sourceName:
                    "巴哈姆特 GNN RSS",

                sourceUrl:
                    RSS_URL,

                updatedAt:
                    now.toISOString(),

                lastSuccessfulUpdateAt:
                    now.toISOString(),

                fetchStatus:
                    "success",

                fetchedNewsCount:
                    rssItems.length,

                matchedEventCount:
                    freshEvents.length,

                highConfidenceCount,

                candidateCount,

                storedEventCount:
                    mergedEvents.length,

                keepDays:
                    KEEP_DAYS,

                note:
                    "此清單是從新聞標題與摘要自動篩選；活動日期、地點及入場方式請以巴哈姆特原文與主辦方公告為準。"
            },

            events:
                mergedEvents
        };

        await writeJson(output);

        console.log(
            `完成：讀取 ${rssItems.length} 則新聞，` +
            `本次符合 ${freshEvents.length} 則，` +
            `高可信度 ${highConfidenceCount} 則，` +
            `待確認 ${candidateCount} 則，` +
            `目前保存 ${mergedEvents.length} 則。`
        );
    } catch (error) {
        /*
         * 抓取失敗時保留舊資料，
         * 不會將 events.json 清空。
         */
        const output = {
            meta: {
                ...existing.meta,

                sourceName:
                    existing.meta.sourceName ||
                    "巴哈姆特 GNN RSS",

                sourceUrl:
                    existing.meta.sourceUrl ||
                    RSS_URL,

                updatedAt:
                    now.toISOString(),

                lastAttemptAt:
                    now.toISOString(),

                fetchStatus:
                    "error",

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

            events:
                existing.events
        };

        await writeJson(output);

        console.error(
            "本次更新失敗，已保留舊資料：",
            error
        );
    }
}

await main();
