# 拾藏 Stash

> 貼上連結（IG / TikTok / Threads / Google Maps / 任何網頁），AI 自動整理成**中文＋泰文**收藏卡片，地點直接顯示在地圖上，還可以分享給朋友。
> 類似 Albo 的個人收藏 App，全部用免費服務搭建。

🔗 App：https://chaiowei.github.io/stash/

---

## 功能

| 功能 | 說明 |
|---|---|
| 🔗 貼連結自動整理 | AI 判斷類型（地點、食譜、電影、影集、書、商品、文章、影片、音樂、活動、軟體、運動），整理成卡片 |
| 📱 社群平台 | TikTok（影片＋圖文貼文）、Instagram（貼文 / Reels）、Threads、Facebook、Google Maps 分享連結；短網址自動展開 |
| 🖼️ 看圖理解 | 封面圖會一起交給 AI，圖裡的店名、菜單、價格、景點都能辨識 |
| 🗺️ 地圖 | 單一地點：卡片內嵌 Google 地圖＋導航；多景點（例如「4 天 3 夜」行程）：編號標記地圖＋景點清單，每點可導航 |
| 🌏 中文 / ไทย | 介面一鍵切換；每張卡片同時產生中文和泰文內容 |
| 📤 分享給朋友 | 單張卡片或整份清單，LINE / WhatsApp / Facebook / 複製連結；朋友免登入、看不到私人筆記；可隨時停止分享 |
| 📚 清單 | 自訂清單（例如「清邁旅行」），想做 / 完成、釘選、1–5 星、筆記、標籤搜尋 |
| ✨ 問 AI | 根據你的收藏回答問題（例如「週末想去哪？」） |
| 🔄 重新分析 | 舊卡片整理不好時一鍵重跑，保留星等、筆記、清單 |
| 📲 PWA | 可加到主畫面；Android 會出現在系統分享選單 |
| 🔁 多裝置同步 | 資料存在雲端試算表，手機、電腦看到同一份 |

## 架構

```
手機 / 電腦（GitHub Pages：index.html）
        │  fetch POST（JSON，text/plain 避免 CORS 預檢）
        ▼
Google Apps Script 網頁應用程式（Code.gs：doPost API）
   ├─ UrlFetchApp：抓網頁 / TikTok oEmbed / Meta 免 token oEmbed / IG 嵌入頁
   ├─ Gemini API：抽取內容（一次輸出 zh + th）、看封面圖、URL Context 備援
   ├─ Maps.newGeocoder()：景點轉座標（免 API Key）
   └─ Google Sheets：Items / Collections / Shares 三張工作表
```

- 前端地圖：單點用 Google Maps 嵌入；多點用 [Leaflet](https://leafletjs.com/) + OpenStreetMap
- 權限：擁有者用密鑰（存在裝置 localStorage）；朋友用分享 token，只能讀
- AI 模型：`gemini-flash-latest`（可在 `Code.gs` 的 `CONFIG.MODEL` 修改）

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 整個 App 畫面（單檔，含 CSS / JS / 中泰文字典） |
| `config.js` | `API_URL`：Apps Script 部署網址（結尾 `/exec`） |
| `manifest.json` / `sw.js` | PWA 設定、Android 分享選單 |
| `icon-192.png` / `icon-512.png` | App 圖示 |
| `Code.gs` | 後端程式（貼到 Apps Script 專案，不是給 GitHub Pages 用的） |

## 安裝 / 重建步驟

1. **Gemini API Key**：https://aistudio.google.com/apikey
2. **Apps Script**：新專案 → 貼上 `Code.gs` → 專案設定 → 指令碼屬性加 `GEMINI_API_KEY` → 執行 `testSetup` 並授權
3. **部署**：網頁應用程式，執行身分「我」、存取權「所有人」→ 執行 `showMyLinks` 取得 API 網址和密鑰
4. **前端**：`config.js` 填入 API 網址 → push 到這個 repo → Settings → Pages → `main` / root
5. **手機**：開 `https://chaiowei.github.io/stash/#k=你的密鑰` → 加到主畫面

> ⚠️ 密鑰不要寫進 repo。外流時在 Apps Script 執行 `resetOwnerKey` 換新（朋友的分享連結不受影響）。

### 更新流程
- 改前端：修改 `index.html` → commit → push（1–2 分鐘後生效，手機重新整理即可）
- 改後端：修改 `Code.gs` → 貼到 Apps Script 存檔 → 部署 → 管理部署作業 → 編輯 → **新版本**（網址不變）

### 除錯用函式（Apps Script 編輯器執行）
| 函式 | 用途 |
|---|---|
| `testSetup` | 建立資料庫並測試一筆 |
| `testAI` | 單獨測 Gemini 回應 |
| `testLink` | 測某個社群連結抓到什麼（改函式內網址） |
| `showMyLinks` | 顯示 API 網址與密鑰 |
| `resetOwnerKey` | 換一組新密鑰 |

## 已知限制
- 抓不到：私人帳號、IG 限時動態、TikTok 影片裡口說的內容（只讀說明文字＋封面）
- 平台改版時可能暫時抓不到內容 → 把說明文字貼到「補充說明」，或之後按「重新分析」
- LINE 連結預覽只顯示 App 名稱與圖示
- 每次整理約 10–20 秒（抓網頁＋AI＋定位）

## 更新紀錄

| 日期 | 版本 | 內容 |
|---|---|---|
| 2026-09-18 | v1 | Apps Script 網頁版：貼連結 → AI 整理、清單、想做/完成、星等、問 AI |
| 2026-09-18 | v2 | 中文 / 泰文雙語；分享單張卡片與清單給朋友；密鑰權限 |
| 2026-09-21 | v2.1 | AI 回應容錯解析與自動重試，修正輸出重複跑到字數上限 |
| 2026-09-21 | v3 | 前端搬到 GitHub Pages（去掉 Google 橫幅）、PWA、Android 分享選單；IG / TikTok / Threads / Facebook / Google Maps 解析；封面圖給 AI 看 |
| 2026-09-21 | v3.1 | 地點卡片內嵌 Google 地圖＋導航按鈕 |
| 2026-09-21 | v3.2 | 多景點行程：全部景點抽取＋自動定位＋編號地圖與清單；支援 TikTok 圖文貼文；「重新分析」按鈕 |
