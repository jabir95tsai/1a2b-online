# 1A2B・數字之間

完整 TypeScript 遊戲，使用 Cloudflare Workers、Workers Static Assets、SQLite Durable Objects 與 WebSocket Hibernation。前端為 Vite + 原生 TypeScript / CSS，無 UI framework 或執行期第三方依賴。**不使用 Cloudflare Pages、KV 或 D1。**

正式網址與部署結果：[部署紀錄](reports/deployment.md)。

## 玩法

- **我來猜（A）**：電腦保管答案；無限猜或 N 次，預設 10 次；結束後揭曉。
- **電腦猜（B）**：誠實模式自動回饋；口述模式自行回覆 A/B。矛盾時保留原狀並指出衝突步驟；修正舊回饋會移除其後歷程、重新推理。
- **互猜答案（C-1）**：輪流猜對手答案，保留後手同回合機會，雙中和局；再戰交換先手。
- **同步競速（C-2）**：每輪各鎖定一手，兩人送出後才揭曉自己的回饋。單中勝、雙中和局；每輪 60 秒，未提交方負，雙方都未提交則取消。沒有補猜機制。
- C-2 進行中只公開對手步數，**finished 後公開雙方完整歷程**。再戰保留席位與身分；新分頁接管舊分頁。

答案／猜測均為四位不重複 ASCII 數字，允許 `0123`；空白、全形或重複字元一律拒絕且不計步。

## 本機開發：Windows 11 + PowerShell

需要 Node.js 24+、npm。相依版本由 `package-lock.json` 鎖定。

```powershell
Set-Location 'C:\Users\jabir\Hacker_J\1a2b-online'
npm ci
npm run setup:local
npm run build
npm run types
npm run dev
```

開啟 `http://127.0.0.1:8787`。`setup:local` 安全產生 `.dev.vars`，不輸出或覆寫既有密鑰。`dev` 先建置前端，再啟動本機 Wrangler；DO 資料在 `.wrangler/`。修改前端後於另一個 PowerShell 執行 `npm run build` 並重新整理，Worker 程式由 Wrangler 監看。

兩位玩家請使用兩個 browser profile、一般／無痕視窗，或 Chrome 與 Edge。**同 profile 的分頁共享匿名身分，會接管而非占兩席。**

## 測試

```powershell
npm run check
npm run solver:benchmark
npm run build:check
```

`check` 執行 TypeScript、純模組、14 項開局表即時計算比對及 workerd 測試。全部 **5040 答案零失敗，平均 5.35377 步、最壞 8 步**。第三手前最大 378 候選，之後完整 minimax，沒有抽樣或 seed。

保持 `npm run dev` 運作，另一個 PowerShell 執行：

```powershell
npm run test:http
npm run test:browser
```

瀏覽器測試需要已安裝 Google Chrome，使用 Playwright 的獨立臨時 profile，不讀取個人資料。測試涵蓋所有模式、關頁重連、接管、再戰、封包投影及真實 60 秒逾時；截圖和 JSON 在 `reports/browser-local/` 與 `reports/browser-production/`。若本機只有 Edge，可將 script 的 channel 改為 `msedge`。

重新打表：`npm run solver:table`；只比對：`npm run solver:table:check`。不要手改 generated 表。

結果：[驗證範圍](docs/verification.md)、[solver 指標](reports/solver-summary.md)、[5040 局歷程](reports/solver-traces.csv)。CSV answer 請以文字匯入，保留前導 0。

## 部署

以下會建立／更新 `wrangler.jsonc` 中的 `1a2b-online` Worker，請使用自己的 Cloudflare 帳戶。首次部署前產生正式 secret；Worker 不存在時，Wrangler 可建立 secret 所需的 Worker。**後續部署不要重跑 secret 產生步驟，以免既有匿名身分失效。**

```powershell
npx wrangler login
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put AUTH_SECRET
npm run check
npm run deploy
```

密鑰不寫入檔案或命令列引數；`.dev.vars` 只用本機，不會部署。若有多個 account，按 Wrangler 提示選擇，或在設定指定自己的 account_id。本專案不自動升級付費方案。

正式驗證，URL 換成 deploy 真正輸出的網址：

```powershell
$env:E2E_BASE_URL = 'https://你的-worker.workers.dev'
npm run test:browser
Remove-Item Env:E2E_BASE_URL
```

測試會建立少量真實遊戲，只對自己管理的部署執行。房間依期限回收。`build:check` 是 dry-run，不發布。

## 檔案結構

```text
src/core/                     純規則、630-byte bitset、minimax、矛盾診斷
  opening-table.generated.ts  第二手表；14 項含一個終止項目
src/protocol/                 公開 DTO，前端僅匯入 type
src/server/
  index.ts                    同源 API、限流、assets、upgrade
  auth.ts                     HMAC HttpOnly Cookie
  solo/                       A/B reducer、單列 SQLite、SoloGame DO
  rooms/
    GameRoom.ts               共用 DO、交易、連線、alarm、廣播
    host.ts                   生命週期、再戰、身分與期限
    strategy.ts               可替換玩法介面
    registry.ts               策略註冊
    strategies/duel.ts        C-1 與後手權益
    strategies/race.ts        C-2 與資訊可見性
src/client/                   TypeScript + CSS，無評分或 solver
public/                       favicon、Static Assets 安全 headers
scripts/                      初始化、打表、枚舉、HTTP／browser QA
tests/unit/                   純模組與策略測試
tests/runtime/                workerd／SQLite／WebSocket 測試
docs/                         架構、API、驗證、限制
reports/                      可重現的驗證證據
wrangler.jsonc                Workers、Static Assets、DO、限流
worker-configuration.d.ts      Wrangler 產生的 Env / runtime 型別
```

`vite.config.ts` 禁止 `src/core` 或 `src/server` 進入前端 bundle。秘密答案僅存 DO 私有資料；公開 View 使用白名單建立。[架構與保密資料流](docs/architecture.md)、[已知限制](docs/known-limitations.md)。


## 原始碼封裝

`artifacts/1a2b-online-source.zip` 包含原始碼、設定與驗證報告，排除密鑰、node_modules 及本機 DO 資料。重新封裝：

```powershell
.\scripts\package-source.ps1
```
