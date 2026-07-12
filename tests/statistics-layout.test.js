"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const css=fs.readFileSync(path.resolve(__dirname,"..","v11-styles.css"),"utf8");
const ui=fs.readFileSync(path.resolve(__dirname,"..","v11-ui.js"),"utf8");
let passed=0;
function test(name,fn){try{fn();passed++;console.log(`✓ ${name}`)}catch(error){console.error(`✗ ${name}\n  ${error.stack}`);process.exitCode=1}}

test("1. 統計頁不使用 width 100vw",()=>assert.doesNotMatch(css,/width\s*:\s*100vw/i));
test("2. 統計主容器限制為父容器寬度",()=>{assert.match(css,/\.v11-stats-page,#v11-stats\s*\{[^}]*width:100%[^}]*max-width:100%[^}]*overflow-x:hidden/s);assert.match(css,/box-sizing:border-box/)});
test("3. Grid／Flex 子項允許縮小",()=>assert.match(css,/\.v11-stats-page \*,#v11-stats \*\s*\{[^}]*min-width:0/s));
test("4. 桌面 grid 使用 auto-fit 160px",()=>assert.match(css,/\.v11-stats-grid\s*\{[^}]*repeat\(auto-fit,minmax\(160px,1fr\)\)/s));
test("5. 圖表寬度不超過父容器",()=>{assert.match(css,/\.v11-chart-wrap\s*\{[^}]*width:100%[^}]*max-width:100%/s);assert.match(css,/\.v11-trend\s*\{[^}]*width:100%[^}]*max-width:100%/s);assert.doesNotMatch(css,/800px/)});
test("6. 圖表 bar 可收縮",()=>assert.match(css,/\.v11-bar\s*\{[^}]*min-width:0[^}]*max-width:100%/s));
test("7. 常用平台長文字可任意換行",()=>assert.match(css,/\.v11-stat-value\s*\{[^}]*overflow-wrap:anywhere[^}]*word-break:break-word/s));
test("8. 375px 使用單欄且無水平溢出",()=>{assert.match(css,/@media\(max-width:480px\)\{\.v11-stats-grid\{grid-template-columns:1fr\}\}/);assert.match(css,/overflow-x:hidden/)});
test("9. 768px 使用兩欄 minmax 0",()=>assert.match(css,/@media\(max-width:768px\)\{\.v11-stats-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/));
test("10. 統計 UI 使用專用 grid 與圖表外層",()=>{assert.match(ui,/v11-grid v11-stats-grid/);assert.match(ui,/v11-chart-wrap/);assert.match(ui,/v11-stat-value/)});
test("11. 重設按鈕及確認訊息存在",()=>{assert.match(ui,/重設觀看統計/);assert.match(ui,/只會清除觀看歷史與統計，不會修改動漫進度，確定繼續嗎？/);assert.match(ui,/復原上一次統計重設/)});

if(!process.exitCode)console.log(`\nStatistics layout tests passed: ${passed}/11`);
