import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { auditAllAnswers } from '../tests/helpers/exhaustive.ts';

const { traces, ...metrics } = auditAllAnswers();
const report = {
  generatedAt: new Date().toISOString(),
  environment: { runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
  method: 'All 5040 secrets separately; no decision cache. Independent scoring oracle and full history checks. Local Node wall-clock timings, not Cloudflare CPU or network latency.',
  openingTableSha256: createHash('sha256').update(readFileSync(new URL('../src/core/opening-table.generated.ts', import.meta.url))).digest('hex'),
  ...metrics,
};
const directory = new URL('../reports/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('solver-summary.json', directory), JSON.stringify(report, null, 2) + '\n');
writeFileSync(new URL('solver-traces.csv', directory), 'answer,steps,guesses,candidate_counts\n'
  + traces.map(trace => `${trace.answer},${trace.steps},${trace.guesses.join(' ')},${trace.candidateCounts.join(' ')}`).join('\n') + '\n');
const ms = (value: number) => value.toFixed(3);
const markdown = `# 第 2 階段 solver 實測\n\n產生時間：${report.generatedAt}\n\n`
  + `- 環境：${report.environment.runtime} / ${report.environment.platform} / ${report.environment.arch} / ${report.environment.cpu}\n`
  + `- 完整枚舉：${metrics.answers} 組；失敗 ${metrics.failures}；平均 ${metrics.averageSteps.toFixed(6)} 步；最壞 ${metrics.worstSteps} 步。\n`
  + `- 首手後最多 ${metrics.maxCandidatesAfterFirst} 個候選；第二手後最多 ${metrics.maxCandidatesAfterSecond} 個候選。\n`
  + `- 第三手起完整 minimax：${metrics.exactMinimaxThirdOnwardMs.calls} 次，p50 ${ms(metrics.exactMinimaxThirdOnwardMs.p50)} ms，p95 ${ms(metrics.exactMinimaxThirdOnwardMs.p95)} ms，p99 ${ms(metrics.exactMinimaxThirdOnwardMs.p99)} ms，最大 ${ms(metrics.exactMinimaxThirdOnwardMs.max)} ms。\n`
  + `- 完整回饋轉移（含過濾、歷史配置與選下一手）：最大 ${ms(metrics.feedbackTransitionMs.max)} ms。\n`
  + `- 全部檢核執行時間 ${ms(metrics.fullRunMs)} ms，包含獨立評分、歷史重算及額外 selector 量測，不是正式服務處理時間。\n\n`
  + `| 步數 | 答案數 |\n|---|---:|\n${Object.entries(metrics.stepDistribution).map(([steps, count]) => `| ${steps} | ${count} |`).join('\n')}\n\n`
  + `每局獨立執行，不跨局 memoize solver 決策。評分使用測試專用獨立 oracle。每步驗證真實答案仍在候選、bitset 等於全部歷史交集、非命中候選數嚴格下降、無重複猜測。\n\n`
  + `這些是本機 Node wall-clock 量測，不能證明 Cloudflare CPU、冷啟動或 HTTP 延遲符合 300ms。尚未實作誠實模式 API / UI E2E。\n\n`
  + `逐答案歷程位於 [solver-traces.csv](./solver-traces.csv)，請將 answer 欄以文字匯入以保留前導 0。機器可讀結果位於 [solver-summary.json](./solver-summary.json)。\n`;
writeFileSync(new URL('solver-summary.md', directory), markdown);
console.log(JSON.stringify(report, null, 2));
