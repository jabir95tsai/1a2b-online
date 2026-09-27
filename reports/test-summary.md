# 測試摘要

2026-09-12，Windows 11、Node 24.14.1、TypeScript 5.9.3、Vitest 4.1.11、Cloudflare Vitest plugin 1.1.8、Wrangler 4.131.1。

| 檢查 | 結果 |
|---|---|
| TypeScript server + client | 通過 |
| 純規則／solver／策略 | 6 個檔案、78 tests 通過 |
| workerd API／SQLite／WebSocket | 2 個檔案、23 tests 通過 |
| 首手回饋靜態表 vs 完整 minimax | 14 項完全一致 |
| 所有答案分別求解 | 5040／5040 成功，零無窮迴圈 |
| 平均／最壞步數 | 5.3537698413／8 |
| 第三手前候選集合上限 | 378 |
| 私有 server 模組隔離 build plugin | 通過 |
| Wrangler dry-run／正式部署 | 通過 |
| 本機與正式 UI E2E | 所有模式、邀請、重連、再戰、接管通過 |
| C-2 真實 60 秒回合 | 本機、正式均通過 |
| 延遲回應競爭回歸 | 延遲 2000ms 通過 |

有效單人動作的遊戲 UPDATE 實測 rowsWritten=1，候選 BLOB=630 bytes；不包含 alarm 等費用。runtime 強制 eviction 後由 WebSocket sync 喚醒、還原 pending 已通過。

時間分布及獨立 oracle 方法見 solver-summary.json；本機 Node 數字不能作為 Cloudflare CPU 或 300ms SLA。正式封包結果見 deployment.md。
