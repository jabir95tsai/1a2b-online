# 正式部署與驗收

- 網址：[1A2B・數字之間](https://1a2b-online.jabir95tsai.workers.dev)
- 部署日期：2026-09-12（Asia/Taipei）。
- 版本：1.0.0；Cloudflare Version ID：`b45e9fbb-c276-4342-a56c-989cb013edca`。
- 平台：Workers + Workers Static Assets；SQLite DO 類別 `SoloGame`、`GameRoom` 已由 declarative exports 建立。
- 正式 AUTH_SECRET 使用 32-byte 密碼學亂數，直接透過 stdin 上傳；未存入 workspace／bundle。保留既有帳戶方案，未購買服務。
- workers.dev 已啟用，Preview URLs 關閉，進行中 `REVEAL_OPPONENT_HISTORY=false`。

## 正式瀏覽器驗證

2026-09-12 20:22 起，兩個獨立 Chrome context 操作正式網址；完整結果 [browser-production/verification.json](browser-production/verification.json)。

全部通過：A 限制猜測、B 誠實模式 8590 共 8 步、口述矛盾拒絕與修正、C-1 完整和局／後手權益／再戰交換先手、兩玩法關頁重連、後連分頁接管、長 token 邀請（含同頁 fragment 導航）、C-2 同步和局／單方命中／真實 60 秒逾時。

收到 **90 個 WebSocket 房間訊息及 39 份 HTTP 房間 View**，其中 **66 份進行中的 C-2 View** 驗證沒有答案欄位及 opponentHistory。檢查 game 欄位白名單，沒有只靠 UI 隱藏。擷取範例在 [packet-samples.json](browser-production/packet-samples.json)，已省略外層識別資訊；無 Cookie 或原始 HAR。

桌面／375px 截圖已產生並檢視；JavaScript 沒有未捕捉例外。正式 HTTP headers／資源隔離另外記錄在 [production-smoke.json](production-smoke.json)。

## 建置

最終 client JavaScript 原始約 13.77 kB、gzip 約 6.05 kB；CSS 原始約 5.66 kB、gzip 約 1.97 kB（Vite 建置輸出，十進位 kB）。Worker upload 60.94 KiB、gzip 15.72 KiB（Wrangler deploy 輸出）。這些是檔案大小，不是延遲或 CPU 保證。

`vite.config.ts` 阻止私有 core／server 模組進入 client；Static Assets 只上傳 dist/client。正式驗證 `/src/server/index.ts`、`/.dev.vars`、`/reports/solver-traces.csv` 均為 404。

## 本機與限制

本機結果：[browser-local/verification.json](browser-local/verification.json)。另外 [ui-race-regression.json](ui-race-regression.json) 記錄 HTTP 回應延遲 2 秒時，WebSocket 先抵達的新輸入鎖定回歸驗證。

78 項純模組與 23 項 workerd 測試通過；全部 5040 答案零失敗，平均 5.3537698413 步、最壞 8 步。正式 CPU 全答案測量、實際休眠比例與帳單節省尚未驗證，見 [已知限制](../docs/known-limitations.md)。
