# Supabase 同步設定

1. 在 Supabase 建立新專案。
2. 開啟 SQL Editor，執行 `supabase-schema.sql`。
3. 從 Project Settings → API 取得 Project URL 與 `anon` key。不要使用 `service_role`。
4. 複製 `sync-config.example.js` 的內容到 `sync-config.js`，填入 URL 與 anon key。
5. 在 Authentication → URL Configuration，將 GitHub Pages 網址加入 Site URL 與 Redirect URLs，例如 `https://帳號.github.io/Anime/`。
6. 在 Authentication → Providers 啟用 Email；依需求選擇 Magic Link 或 Email OTP。
7. 部署後用兩個瀏覽器測試：登入、手動上傳、另一裝置下載、修改同一作品後再次合併。

同步採 local-first。未設定或服務離線時，本機動漫、活動修正、設定與觀看歷史仍正常運作。資料表啟用 RLS，使用者只能讀寫自己的 `user_id`。
