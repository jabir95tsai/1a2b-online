# 驗證紀錄

## 可重現測試

- `npm run check`：78 項純模組、23 項 workerd runtime 測試，外加 TypeScript 與 14 項開局表比對。
- `npm run solver:benchmark`：全部 5040 合法答案分別求解，獨立評分 oracle 核對每一手，無 decision cache。零失敗、26983 總猜測、平均 5.3537698413 步、最壞 8 步。完整歷程與環境／時間在 reports。
- `npm run build:check`：前端 build（禁止匯入私有 core／server）及 Wrangler dry-run；不等於正式部署。
- `npm run test:http`：真實 loopback A、B 誠實、B 口述 HTTP 流程。
- `npm run test:browser`：Google Chrome 兩個獨立 context，使用實際 UI，不讀私有答案。根據可見回饋在 Node 測試程序推理 C-2；solver 不會注入瀏覽器 bundle。
- `node scripts/ui-race-regression.mjs`：將出題 HTTP 回應刻意延遲 2 秒，確認 WebSocket 先到時新回合輸入保持鎖定，後續猜測不會被前一請求的收尾清掉。

## 純模組／runtime 覆蓋

ASCII／前導 0／重複與非法輸入、14 回饋、候選 bitset、全部答案、所有可達 solver 分支、矛盾／舊回饋修正；Solo 所有權／Origin、並行、重送、版本拒絕、SQLite BLOB 630 bytes／有效動作 rowsWritten=1、alarm／eviction。

多人涵蓋 C-1 後手和局與先手交換、C-2 pending 私密與同步公開、單中／雙中／單方逾時／雙方取消；房滿／碰撞／邀請權限、epoch 接管、舊局拒絕、再戰、同時送出／去重、alarm 清理、強制 eviction 後 WebSocket 喚醒。

## Browser 與封包

`reports/browser-production/verification.json` 記錄最後一次測試目標、時間、檢查結果、收到的 WebSocket 和 HTTP 公開 View 數量。所有 active View 檢查答案欄位不存在；所有 C-2 active View 不含 opponentHistory，game 所有欄位須符合白名單，不能用額外欄位夾帶私有 state。包含 HTTP 回應及 WebSocket frames，而非只檢查 UI。

`packet-samples.json` 為實際擷取的 pending 自己／對手及 finished game 欄位，省略外層房碼、局 ID。未保存 Cookie、secret、原始 HAR 或包含認證的 trace。

UI E2E 已測：A 次數上限、B 誠實 8590 的 8 步、口述矛盾拒絕與修正、C-1／C-2 完整局及關頁重連、接管、再戰、C-2 單方勝／和局／真實 60 秒逾時。桌面及 375px 截圖已產生並檢視；行動寬度無水平溢出。

正式測試與本機結果分開保存，部署及線上測試完成狀態以 `reports/deployment.md` 為準。未量測項目另見 known-limitations。

