# 🎁 iOS IAP Freebie Tracker (iOS 內購限免追蹤器)

[![iOS IAP Freebie Crawler](https://github.com/Dr-XYZ/ios-iap-freebie-tracker/actions/workflows/crawler.yml/badge.svg)](https://github.com/Dr-XYZ/ios-iap-freebie-tracker/actions/workflows/crawler.yml)
[![Pages Deployment](https://github.com/Dr-XYZ/ios-iap-freebie-tracker/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/Dr-XYZ/ios-iap-freebie-tracker/actions/workflows/pages/pages-build-deployment)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一個全自動運作的 **iOS App 內購限免（In-App Purchase Freebies）追蹤系統**。透過 GitHub Actions 每 5 分鐘自動排程運作，自動爬取台灣 App Store 排行榜與自訂追蹤清單，並透過精美的 Glassmorphic（毛玻璃風）網頁展示當前所有有效的內購限免項目！

👉 **[點此查看 Live 限免網頁](https://Dr-XYZ.github.io/ios-iap-freebie-tracker/)**

---

## ✨ 核心特色

### 1. 🧠 動態權重分數排程演算法 (Dynamic Priority Score)
為解決 Apple CDN 頻繁阻擋高頻爬蟲的限制，系統不採用盲目爬取，而是為每款 App 計算動態優先級：
- **自訂追蹤（Watchlist）**：最高優先級，每輪必爬。
- **排行榜熱門（Top 5 Charts）**：極高優先級，快速反應排行變動。
- **在線限免中（Active Freebies）**：每 10-15 分鐘覆檢一次，確保過期降價第一時間被下架。
- **無內購軟體（No IAP Placeholders）**：極低優先級，每 3 天僅複檢一次，節省 75% 的無效請求。
- **無效連結（Failed 404）**：降低至每月複檢一次，避免無效流量。

### 2. 🛡️ 擬人化反偵測爬取 (Stealth Scraper)
內建完善的伺服器防封鎖機制，保障高頻（每 5 分鐘一次）運作下的穩定度：
- **User-Agent 輪替**：隨機使用 Chrome、Safari (Mac/iOS)、Firefox 等多種標頭，偽裝成多元設備的正常瀏覽。
- **隨機抖動延遲（Jitter Delay）**：每次請求加入 1.0 ~ 2.5 秒的隨機延遲，打亂固定請求節奏。
- **動態 IP 輪轉**：充分利用 GitHub Actions 每次分配不同 Azure 虛擬機 IP 的特性，從物理層面免除 IP 封鎖。

### 3. 📱 軟體群組化精美介面 (Grouped UI)
- 將同一個 App 下的多個限免內購項目（如不同的高級訂閱、解鎖包）自動整合成單一卡片，拒絕版面凌亂。
- 全網頁採用現代 Glassmorphic 暗色系毛玻璃設計，具備流暢的微動畫與自適應手機排版。
- 具備即時搜尋過濾、分類切換（應用/遊戲），以及針對失效圖示的防破圖 Placeholder。

---

## 🛠️ 如何運作

```mermaid
graph TD
    A[GitHub Actions 5分鐘排程] --> B[動態排行榜與自訂清單探索]
    B --> C[計算 Priority Score 挑選前 250 款]
    C --> D[並行擬人化爬取 App Store 網頁]
    D --> E[動態更新 database.json 歷史紀錄]
    E --> F[產出當前有效 freebies.json]
    F --> G[自動推送到 GitHub Pages]
    G --> H[前端 Glass-UI 即時渲染]
```

---

## ⚙️ 快速上手與部署

如果您想要部署一套屬於您自己的 iOS 限免追蹤系統，只需簡單幾步：

### 1. 複製儲存庫 (Fork)
點擊本專案右上角的 **Fork** 鍵，將專案複製到您自己的 GitHub 帳戶下。

### 2. 設定自訂追蹤清單 (Watchlist)
編輯儲存庫根目錄下的 `watchlist.json`，在陣列中加入您特別想即時盯梢的 App ID（例如：Canva 的 ID 為 `897446215`）：
```json
[
  "897446215",
  "1091189122"
]
```

### 3. 啟用 GitHub Actions 與 GitHub Pages
1. 前往您 Fork 的 Repository 的 **Settings > Actions > General**，確認 "Workflow permissions" 設為 **"Read and write permissions"**（爬蟲需要寫入更新回 JSON 檔案）。
2. 前往 **Settings > Pages**：
   - "Build and deployment" 的 Source 選擇 **"GitHub Actions"**。
3. 前往 **Actions** 頁面，手動啟用並觸發 **"iOS IAP Freebie Crawler"** 工作流。

部署完成後，您就可以在 `https://<您的 GitHub 帳號>.github.io/ios-iap-freebie-tracker/` 瀏覽您專屬的追蹤網頁！

---

## 📄 開源授權

本專案採用 **[MIT License](LICENSE)** 授權。
