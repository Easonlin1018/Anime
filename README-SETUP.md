# Anime Tracker v10.4：真正即時搜尋版

這一版不再只篩選 `events.json`。輸入任意動漫後，網站會：

1. 用 AniList／Wikipedia 取得中文、日文、英文、羅馬字和同義名稱。
2. 透過 Cloudflare Worker 安全啟動 GitHub Actions。
3. GitHub Actions 即時搜尋 Google News、Bing News 的台灣活動資料。
4. 讀取候選文章內容，確認文章確實提到該作品與實體活動。
5. 結果自動回到網站，並加入 `events.json` 快取。

> GitHub Pages 是純靜態網站，不能把 GitHub Token 寫進 `index.html`。因此需要一個 Cloudflare Worker 代替網頁安全地啟動 GitHub Actions。

## 一、上傳到 GitHub

將壓縮包中的檔案依照原本路徑覆蓋或新增：

- `index.html`
- `scripts/update-events.mjs`
- `scripts/search-anime-events.mjs`
- `.github/workflows/update-events.yml`
- `.github/workflows/search-anime-events.yml`
- `search-results/.gitkeep`

不要覆蓋原本的 `events.json`。

## 二、建立 GitHub Fine-grained Token

1. GitHub 右上角頭像 → Settings。
2. Developer settings → Personal access tokens → Fine-grained tokens。
3. 建立新 Token。
4. Repository access 選 **Only select repositories**，只選 `Anime`。
5. Repository permissions 將 **Contents** 設為 **Read and write**。
6. 建立後先複製 Token。

不要把 Token 貼到 ChatGPT、`index.html`、公開 GitHub 檔案或截圖中。

## 三、建立 Cloudflare Worker

1. 登入 Cloudflare。
2. Workers & Pages → Create → Worker。
3. 建立後進入編輯器，把 `cloudflare-worker.js` 的完整內容貼上並部署。
4. Worker → Settings → Variables and Secrets，新增：

| 名稱 | 類型 | 值 |
|---|---|---|
| `GITHUB_TOKEN` | Secret | 剛才建立的 GitHub Token |
| `REPO_OWNER` | Text | `Easonlin1018` |
| `REPO_NAME` | Text | `Anime` |
| `REPO_BRANCH` | Text | `main` |
| `ALLOWED_ORIGIN` | Text | `https://easonlin1018.github.io` |

5. 部署後複製 Worker 網址，例如：

```text
https://anime-event-live-search.你的帳號.workers.dev
```

使用 Wrangler 部署時，也可以使用壓縮包裡的 `wrangler.toml.example`，並執行：

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

## 四、在網站啟用

1. 開啟 Anime Tracker。
2. 到「台灣動漫活動雷達」。
3. 按「⚙️ 搜尋設定」。
4. 貼上 Worker 網址。
5. 顯示「即時搜尋後端連線成功」後即可使用。

## 五、搜尋流程

輸入作品並按「⚡ 即時搜尋作品活動」後：

- 網站先整理作品別名。
- Worker 啟動 GitHub Actions。
- 網站每 3.5 秒自動檢查一次結果。
- 通常約 1～5 分鐘完成。
- 關閉或重新整理頁面後，網站仍可恢復尚未完成的搜尋。

搜尋引擎尚未收錄、文章擋機器人讀取，或官方只在圖片內公布名單時，仍可能找不到；網站會顯示實際檢查的別名數、來源數和候選文章數，不再只顯示模糊的本機比對訊息。
