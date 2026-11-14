"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const appSourcePath = require("./release-path.cjs");
const V = require(appSourcePath("v11-core.js"));

const html = fs.readFileSync(appSourcePath("index.html"), "utf8");
const sourceOf = (start, end) => {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return html.slice(from, to);
};
const listRenderer = sourceOf("function renderList(", "function exportData()")
    + sourceOf("function normalizeAnimeSearchText", "function animeProgress");

const related = (relationType, id) => ({ relationType, node:{ id, type:"ANIME", format:"MOVIE" } });
const record = (id, mediaId, title, category, startDate, fields = {}) => ({
    id, anilistId:mediaId, sourceId:String(mediaId), source:"anilist", title, category,
    groupTitle:"青春豬頭少年", startDate, episodes:12, watched:0, favorite:true, notes:"synthetic",
    ...fields
});
const fixture = () => V.assignAnimeSeriesIdentity([
    record("december-film",161474,"青春豬頭少年不會夢到紅書包女孩","review",{ year:2023,month:12,day:1 }, {
        relations:[related("PREQUEL",154967)]
    }),
    record("first-tv",101291,"青春豬頭少年不會夢見兔女郎學姊","completed",{ year:2018,month:10,day:4 }, {
        relations:[related("SEQUEL",104157)], watched:12
    }),
    record("june-film",154967,"青春豬頭少年不會夢到嬌憐外出妹","backlog",{ year:2023,month:6,day:23 }, {
        relations:[related("PREQUEL",104157)], aliases:["嬌憐外出妹"]
    }),
    record("first-film",104157,"青春豬頭少年不會夢到懷夢美少女","backlog",{ year:2019,month:6,day:15 }),
    record("in-progress",171046,"青春豬頭少年不會夢到聖誕服女郎","watching",{ year:2025,month:7,day:5 }, {
        relations:[related("PREQUEL",161474)], watched:3, currentEpisode:3
    }),
    record("deleted",199340,"青春豬頭少年不會夢到親愛好朋友","_deleted",{ year:2026,month:10,day:16 }, {
        relations:[related("PREQUEL",171046)]
    })
]).list;

function render(list, { query = "", expanded = [] } = {}) {
    const nodes = Object.fromEntries([
        "list-watching", "list-backlog", "list-review", "list-waiting", "list-completed",
        "anime-list-summary", "anime-list-no-results", "anime-title-options"
    ].map(id => [id, { innerHTML:"", textContent:"", style:{} }]));
    const context = {
        AnimeTrackerV11:V,
        animeList:list,
        animeListQuery:query,
        document:{
            querySelectorAll:() => expanded.map(groupkey => ({ dataset:{ groupkey } })),
            getElementById:id => nodes[id]
        },
        getSeriesGroupTitle:item => item.groupTitle,
        toTraditionalAnimeTitle:V.toTraditionalChinese,
        escapeHtml:value => String(value).replace(/[&<>"']/g, char => ({
            "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
        })[char]),
        compareAnime:(a,b) => a.title.localeCompare(b.title, "zh-Hant"),
        buildAnimeItem:anime => `<article data-test-id="${anime.id}"><div class="anime-meta">${anime.title}</div></article>`,
        renderAiringCalendar() {}
    };
    vm.runInNewContext(listRenderer + "\nrenderList();", context);
    return nodes;
}

const cardIds = element => [...element.innerHTML.matchAll(/data-test-id="([^"]+)"/g)].map(match => match[1]);

test("a mixed-category series has one chronological group and leaves each source record intact", () => {
    const rows = fixture();
    const original = structuredClone(rows);
    const seriesKey = V.getAnimeSeriesKey(rows.find(row => row.id === "first-tv"));
    const nodes = render(rows, { expanded:[seriesKey] });
    assert.deepEqual(cardIds(nodes["list-completed"]), ["first-tv","first-film","june-film","december-film"]);
    assert.match(nodes["list-completed"].innerHTML, /data-groupkey="[^"]+" open/u);
    assert.match(nodes["list-completed"].innerHTML, /📦 青春豬頭少年\s/u);
    assert.match(nodes["list-completed"].innerHTML, /class="v11-badge">已追完/u);
    assert.match(nodes["list-completed"].innerHTML, /class="v11-badge">補番中/u);
    assert.match(nodes["list-completed"].innerHTML, /class="v11-badge">複習中/u);
    assert.deepEqual(cardIds(nodes["list-backlog"]), []);
    assert.deepEqual(cardIds(nodes["list-review"]), []);
    assert.match(nodes["list-backlog"].innerHTML, /在「青春豬頭少年」系列查看 2 部/u);
    assert.match(nodes["list-review"].innerHTML, /在「青春豬頭少年」系列查看 1 部/u);
    assert.deepEqual(cardIds(nodes["list-watching"]), []);
    assert.equal(nodes["anime-list-summary"].textContent,"顯示 4／5 部");
    assert.deepEqual(rows, original);
});

test("an alias or category filter leaves hidden series members outside the cards and count", () => {
    const rows = fixture();
    const nodes = render(rows, { query:"嬌憐外出妹" });
    assert.deepEqual(cardIds(nodes["list-backlog"]), ["june-film"]);
    assert.deepEqual(cardIds(nodes["list-completed"]), []);
    assert.doesNotMatch(nodes["list-backlog"].innerHTML, /series-group/u);
    assert.equal(nodes["anime-list-summary"].textContent,"顯示 1／5 部");

    const filtered = rows.map(row => row.category === "completed" ? { ...row, category:"_v11_filtered" } : row);
    const moved = render(filtered, { expanded:[V.getAnimeSeriesKey(rows[0])] });
    assert.deepEqual(cardIds(moved["list-backlog"]), ["first-film","june-film","december-film"]);
    assert.match(moved["list-backlog"].innerHTML, /data-groupkey="[^"]+" open/u);
    assert.deepEqual(cardIds(moved["list-completed"]), []);
    assert.equal(moved["anime-list-summary"].textContent,"顯示 3／5 部");
});

test("the main renderer finds both seasons through a verified search alias", () => {
    const first = record("dress-up-first",132405,"戀上換裝娃娃","completed",{ year:2022,month:1,day:9 }, {
        groupTitle:"戀上換裝娃娃", watched:12
    });
    const second = record("dress-up-second",154768,"戀上換裝娃娃 第二季","backlog",{ year:2025,month:7,day:6 }, {
        groupTitle:"戀上換裝娃娃"
    });
    const addVerifiedMetadata = (row, relationType, relatedId) => ({
        ...row,
        seriesMetadata:V.buildVerifiedAnimeSeriesMetadata({
            id:row.anilistId, type:"ANIME", format:"TV",
            title:{ native:row.title }, startDate:row.startDate,
            relations:[{ relationType, node:{ id:relatedId, type:"ANIME", format:"TV" } }]
        }, row.anilistId)
    });
    const rows = [
        addVerifiedMetadata(second,"PREQUEL",132405),
        addVerifiedMetadata(first,"SEQUEL",154768)
    ];
    const nodes = render(rows, { query:"更衣人偶墜入愛河" });
    assert.deepEqual(cardIds(nodes["list-completed"]), ["dress-up-first","dress-up-second"]);
    assert.match(nodes["list-completed"].innerHTML, /📦 戀上換裝娃娃\s/u);
    assert.match(nodes["list-backlog"].innerHTML, /在「戀上換裝娃娃」系列查看 1 部/u);
    assert.equal(nodes["anime-list-summary"].textContent,"顯示 2／2 部");
    assert.ok(rows.every(row => !Object.hasOwn(row,"seriesKey")));
});

test("hidden active relations can connect visible cards while deleted-only bridges cannot", () => {
    const first = record("first",9001,"第一部","completed",{ year:2020 }, {
        relations:[related("SEQUEL",9002)], watched:12
    });
    const bridge = record("bridge",9002,"第二部","_v11_filtered",{ year:2021 }, {
        relations:[related("SEQUEL",9003)]
    });
    const third = record("third",9003,"第三部","backlog",{ year:2022 });
    const fromHidden = render([first,bridge,third]);
    assert.deepEqual(cardIds(fromHidden["list-completed"]), ["first","third"]);
    assert.deepEqual(cardIds(fromHidden["list-backlog"]), []);

    const fromDeleted = render([first,{ ...bridge, category:"_deleted" },third]);
    assert.deepEqual(cardIds(fromDeleted["list-completed"]), ["first"]);
    assert.deepEqual(cardIds(fromDeleted["list-backlog"]), ["third"]);
    assert.doesNotMatch(fromDeleted["list-completed"].innerHTML,/series-group/u);
});
