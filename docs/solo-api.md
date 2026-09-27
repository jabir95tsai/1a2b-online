# 單人 API 與 SoloGame

Worker → SQLite Durable Object 的 Mode A、B-honest、B-oral HTTP 介面。前端已整合；正式驗證另見部署紀錄。

## 本機執行

Windows 11 + PowerShell、Node 24+：

```powershell
npm ci
npm run setup:local
npm run types
npm run dev
```

另開 PowerShell：

```powershell
Set-Location 'C:\Users\jabir\Hacker_J\1a2b-online'
npm run test:http
```

`setup:local` 僅在不存在時產生 `.dev.vars`，不顯示或覆寫密鑰。Cookie 使用 HttpOnly、Secure、SameSite=Strict、__Host- prefix。loopback smoke 由 Node 手動保留 Cookie，瀏覽器 Cookie 行為另由 Playwright E2E 驗證。

## 通訊規則

所有寫入使用 JSON、同源 Origin；body 上限 8 KiB。GET 也拒絕跨站 Origin / Fetch Metadata。API 不接受 query，答案、狀態與身分憑證不放 URL。不設定跨域 CORS，回應 no-store，不將 payload、答案或例外 stack 寫入 log。`AUTH_SECRET` 缺少或不符 64 位 hex 時 fail closed。

匿名身分由 HMAC-SHA256 簽章 Cookie 保存，Cookie 不含答案。擁有者必須與 DO 記錄相符；他人局號即使已知，仍回 404。Cookie 簽章用 Web Crypto verify 檢查。建立成功後前端只需保存不具獨立操作權的 id；刷新使用 Cookie + id 重新讀取。

| 方法／路徑 | 用途與 body |
|---|---|
| GET `/api/health` | 存活資訊，不代表所有平台功能可用 |
| POST `/api/session` | `{}`，建立或延長原匿名身分；不接受指定 owner |
| POST `/api/solo` | 共用 requestId（UUID v4）；kind 及設定見下方 |
| GET `/api/solo/{id}` | 讀取目前公開 View，不更新閒置期限 |
| POST `/api/solo/{id}/actions` | generation、expectedRevision、requestId 及動作 |

建立 body：

```json
{ "requestId": "<新的 UUID v4>", "kind": "A", "maxGuesses": 10 }
```

- A：maxGuesses 省略為 10、null 為無回合次數上限，正整數為指定限制。答案以密碼學亂數及 rejection sampling 公平抽取 5040 組之一。
- B-honest：`kind: "B-honest"`、`answer: "0123"`。答案僅進入私有狀態。
- B-oral：`kind: "B-oral"`，不接受 answer。

建立局號由 HMAC(owner + requestId) 派生；重送相同設定回傳目前 View（200、replayed=true），不重生答案；同一 requestId 換設定回 409。新建回 201。

動作 body 共用欄位：

```json
{
  "requestId": "<新的 UUID v4>",
  "generation": "<建立回應中的 generation>",
  "expectedRevision": 0,
  "type": "guess",
  "guess": "0123"
}
```

| 模式 | type | 額外欄位 |
|---|---|---|
| A | guess | guess |
| B-honest | next | 無；伺服端評分目前 pendingGuess，決定下一手 |
| B-oral | feedback | feedback: { a, b } |
| B-oral | correct | turn（1-based）、feedback；重算該輪並移除後續歷史 |
| 所有進行中的局 | abandon | 無；永久結束本局後才揭曉已有答案 |

finished 不可再提交、更正或重開；重新玩建立新的局。口述模式只有玩家宣告 4A0B 時才能提供推定答案；放棄時沒有已知答案則不捏造答案。

## 回應與資訊界線

成功：`{ game: SoloView, replayed: boolean }`。

SoloView 欄位：id、generation、revision、kind、status、outcome、expiresAt、steps、history、maxGuesses、pendingGuess、candidateCount；只有 finished 才可能加入 answer。history 僅包含 guess、feedback，B 另有 candidatesBefore / candidatesAfter。

不回傳 owner、creation、receipts、solver 私有物件或 candidate bitset。B 的 pendingGuess 是電腦本來就要提出的猜測，可能碰巧等於答案，屬使用者已同意的必要資訊例外。誠實模式的實際答案只有 finished 的揭曉欄位才可回傳。

錯誤：`{ error: { code, message, turns?, irreducible? } }`。矛盾回 422 與衝突回合；非法格式 400，非 JSON 415，過大 413，身分 401，跨站 403，找不到／不是擁有者 404，舊版本／重複 requestId 換內容／模式不符／局已結束 409，過期 410，限流 429，未知內部錯誤 503。錯誤不含原始輸入、SQL 或 stack。

## 原子狀態與重播

每動作重新由 DB 讀取，不依賴 instance 記憶體。檢查 owner → expiry → generation → 去重 receipt → expectedRevision，再同步 transition + SQLite UPDATE，使用 transactionSync 封住整個檢查／寫入範圍。

- 同 revision 的不同並行動作最多接受一個，另一個回 409。
- 保存最近 64 個成功動作 receipt；原封重送回目前 View、不再次計次或寫入。舊 receipt 已淘汰時，原動作的舊 revision 仍會被拒絕。不要改 requestId／revision 來重試未知結果，先讀取目前 View。
- 非法及矛盾動作不寫入、也不遞增 revision。
- generation 隨新局初始化變更。到期資料清除後，即使重送舊建立 requestId 再建同 id，新 generation 仍會拒絕舊局動作。
- 已結束後不允許 rollback，更正口述回饋也只限 active。

## 寫入、到期與容量

單一 `solo_game` row 保存私有 JSON snapshot 與 630-byte candidates BLOB（A 為空 bitset）。沒有 mutable secondary index、候選逐列或逐手 event INSERT。每個有效動作一次 UPDATE；在真實 workerd 測得 cursor.rowsWritten=1。無效動作與成功重送皆不更新該 row。

建立時的 INSERT 與首次 setAlarm 使用同一 storage transaction。active 動作只延長 snapshot.expiresAt，不逐手 setAlarm。結束改為保留 30 分鐘，需視情況另寫 alarm；重送終局動作會修復中途失敗的 alarm 排程。active 閒置 24 小時到期，GET／重送不延長期限。

alarm 先核對最新 expiry；尚未到期則重排，已到期則 deleteAll 回收 SQLite。實測 deleteAll 不能在 storage transaction 內，故清理生命週期用 blockConcurrencyWhile 保護檢查與刪除，沒有外部網路 I/O。DO 被 eviction 後從同一 row 還原。

snapshot 工程上限 1,000,000 bytes，避免單列無限膨脹；達上限回 GAME_STORAGE_FULL，不計入該動作。無限猜意指沒有遊戲回合上限，仍受平台／容量限制。abandon 清掉歷史 receipt 騰出結束所需空間，保留全部猜測歷程。

「一次遊戲列寫入」不代表總計費只有一 row：alarm、清理、限流及平台請求另計。不得以本機 rowsWritten 宣稱已核對帳戶帳單。

## 限流

使用 Cloudflare Rate Limiting binding：session 20 次／60 秒（來源 IP 的 HMAC），create 10 次／60 秒（身分及來源分開限制），讀取／動作 120 次／60 秒（身分）。不記錄原始 IP。

此 binding 依 Cloudflare location 的計數實作，不能當作全域強一致配額或付費上限。多人 join 另有身分 5 次／分鐘、IP 20 次／分鐘限制。測試使用合成 edge IP 識別；正式環境需依 Cloudflare 注入的 CF-Connecting-IP，不能從一般使用者提供的身分 header 取得 owner。

## 官方查證與工具版本

2026-09-12 查閱：[SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[DO testing](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)、[Wrangler schema](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

鎖定 Wrangler 4.131.1、@cloudflare/vitest-plugin 1.1.8、Vitest 4.1.11。官方 plugin 的 peer dependency 為 Vitest ^4.1.0，故將先前 Vitest 5 調整至相容版本，沒有 --force 或跳過 peer 檢查。plugin 間接依賴的 Miniflare 帶 alpha 版本標記，仍需正式平台驗收。

wrangler.jsonc 採已經 installed schema／dry-run 驗證的 declarative exports + SQLite；不混用 migrations。Env 與 runtime 型別由 wrangler types 產生。同一設定亦包含 GameRoom 與 Workers Static Assets；部署結果另見 reports/deployment.md。

