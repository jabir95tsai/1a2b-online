# 已知限制與未驗證項目

更新：2026-09-12。

- 本機 Node 時間見 `reports/solver-summary.json`；不是 Cloudflare 每次呼叫 CPU、全球延遲或 300ms SLA。未逐一量測正式平台全部答案的 CPU。第三手起最多 378 候選，沒有抽樣 fallback。
- workerd 已驗證強制 eviction 後以 WebSocket 喚醒、恢復待決猜測。正式平台何時真正休眠、休眠比例及節省費用尚未量測。
- Rate Limiting binding 非全域強一致配額，不能作為帳單硬上限。未做分散來源大量負載測試，未新增付費 WAF 或 CAPTCHA。
- 8 碼空間為 `31^8`，約 39.63 bits（數學計算）。短碼可獨立加入，長 token 不增加短碼熵。房滿、身分和 IP 限流降低風險，不能宣稱無法猜中房碼。
- 無跨裝置帳號復原；清除 Cookie、過期或輪替 AUTH_SECRET 後，既有席位無法取回。同人使用另一瀏覽器身分不能被可靠辨識。
- C-2 同步指同一權威交易後發送兩份 View，不能保證裝置在相同毫秒收到。斷線不延長回合；雙方都未提交則取消無勝者。
- 逾時未完整回合的已提交手會在最終歷程標示 `incomplete: true`，不假裝雙方實際提交數相等。
- 矛盾診斷盡可能縮為 irreducible subset，不保證全域最少回饋數。前後一致的謊報無法與心中答案區分。
- 每局／房間 snapshot 有 1,000,000 bytes 工程上限；無限猜不另設回合數上限，但仍受儲存與平台配額限制。alarm、刪除等另可能計費，單列 UPDATE 不代表動作總計費只有一 row。
- Windows Chrome 完成桌面及 375px 行動寬度檢查；未在實體 iPhone、Android 或所有 Safari／Firefox 版本驗收。
- 相依版本已鎖定；Cloudflare plugin 間接使用帶 alpha 標記的 Miniflare。升級時須重跑 runtime 與 browser 測試。
- 無自訂網域、帳號系統、聊天、排行榜；部署結果見 `reports/deployment.md`。未初始化 Git、未推送 remote，原始碼以 workspace 交付。

