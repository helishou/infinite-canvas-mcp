#!/usr/bin/env node
/**
 * MCP 提速方案收益测量（只读）。
 *
 * 用法：
 *   node scripts/mcp-speed-metrics.mjs --since 2026-10-13 --until 2026-11-03 [--label baseline] [--out tmp/mcp-speed-baseline.json]
 *
 * 数据源：Backend runtime.sqlite 的 mcp_observability_events（MCP 工具调用遥测）与 tasks（生成任务终态）。
 * 输出方案验收的四个数 + 三个新能力专项，同一脚本改后复测即得差值。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, item, index, list) => {
  if (item.startsWith("--")) acc.push([item.slice(2), list[index + 1] && !list[index + 1].startsWith("--") ? list[index + 1] : true]);
  return acc;
}, []));
const home = os.homedir();
const dbFile = args.db || path.join(home, ".infinite-canvas", "runtime.sqlite");
// 改动上线时间：2026-11-03 17:00 (GMT+8) 之后的调用才算"改后"。
const DEFAULT_CUTOVER = "2026-11-03T09:00:00.000Z";
const since = args.since || "2026-10-13";
const until = args.until || new Date().toISOString().slice(0, 10);
const label = args.label || (args.since ? args.since : "window");
const sinceIso = `${since}T00:00:00.000Z`;
const untilIso = `${until}T24:00:00.000Z`;

const db = new DatabaseSync(dbFile, { readOnly: true });
const q = (sql, p = []) => db.prepare(sql).all(...p);
const day = (iso) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 10); // 北京时间
const j = (text) => { try { return JSON.parse(String(text || "{}")); } catch { return {}; } };
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p + 99) / 100) - 1)] ?? sorted.at(-1);
};

const rows = q(`SELECT session_id, trace_id, tool, task_id, operation_id, duration_ms, error_code, event,
    input_summary_json, output_summary_json, created_at
  FROM mcp_observability_events
  WHERE event IN ('tool.succeeded','tool.failed') AND created_at >= ? AND created_at < ?`, [sinceIso, untilIso])
  .map(row => ({ ...row, summary: j(row.output_summary_json), input: j(row.input_summary_json), day: day(row.created_at), t: Date.parse(row.created_at), ok: row.event === "tool.succeeded" }));

// ---------- 1. 规模与每日调用量 ----------
const byDay = {};
for (const row of rows) { byDay[row.day] = (byDay[row.day] || 0) + 1; }
const byTool = {};
for (const row of rows) { (byTool[row.tool] ||= { calls: 0, failed: 0, totalMs: 0 }); const item = byTool[row.tool]; item.calls++; if (!row.ok) item.failed++; item.totalMs += row.duration_ms || 0; }
const toolTable = Object.entries(byTool).map(([tool, item]) => ({ tool, calls: item.calls, failed: item.failed, failureRate: +(item.failed / item.calls).toFixed(3), avgMs: Math.round(item.totalMs / item.calls) }))
  .sort((a, b) => b.calls - a.calls);

// ---------- 2. 等待往返 ----------
// 遥测不落 wait 的 taskId 明细，只能用会话近似：一次 wait 结束后 60 秒内，
// 同一会话再次出现的等待/状态查询就是 wait→查→wait 三明治。基线与复测同口径，差值仍成立。
const QUERY_TOOLS = new Set(["canvas_wait_tasks", "canvas_task_status", "h3_get_task", "generation_get_status"]);
const bySession = new Map();
for (const row of rows) {
  if (!QUERY_TOOLS.has(row.tool)) continue;
  (bySession.get(row.session_id) || bySession.set(row.session_id, []).get(row.session_id)).push(row);
}
const extraQueriesAfterWait = [];
for (const events of bySession.values()) {
  events.sort((a, b) => a.t - b.t);
  for (let i = 0; i < events.length; i++) {
    if (events[i].tool !== "canvas_wait_tasks") continue;
    let extra = 0;
    for (let k = i + 1; k < events.length && events[k].t - events[i].t <= 60_000; k++) if (QUERY_TOOLS.has(events[k].tool)) extra++;
    extraQueriesAfterWait.push(extra);
  }
}
const waitRows = rows.filter(row => row.tool === "canvas_wait_tasks");
const activeWaits = waitRows.filter(row => (row.duration_ms || 0) >= 5_000);
const waitModes = {};
for (const row of waitRows) { const mode = String(row.summary.waitMode || "unknown"); waitModes[mode] = (waitModes[mode] || 0) + 1; }
const waitMetrics = {
  waits: waitRows.length,
  activeWaits: activeWaits.length,
  waitMode: waitModes,
  durationNear60s: waitRows.filter(row => row.duration_ms >= 59_000 && row.duration_ms <= 61_000).length,
  activeP50: percentile(activeWaits.map(row => row.duration_ms), 0.5),
  activeP95: percentile(activeWaits.map(row => row.duration_ms), 0.95),
  // 每次等待后 60 秒内同会话的追加等待/状态查询：0 是理想值
  extraQueriesAfterWait: {
    mean: +(extraQueriesAfterWait.reduce((a, b) => a + b, 0) / Math.max(1, extraQueriesAfterWait.length)).toFixed(2),
    zeroShare: +(extraQueriesAfterWait.filter(n => n === 0).length / Math.max(1, extraQueriesAfterWait.length)).toFixed(3),
    distribution: Object.fromEntries(Object.entries(extraQueriesAfterWait.reduce((acc, n) => { acc[n] = (acc[n] || 0) + 1; return acc; }, {})).sort((a, b) => a[0] - b[0]).slice(0, 8)),
  },
};

// ---------- 3. production_edit 失败与重提 ----------
const editRows = rows.filter(row => row.tool === "production_edit");
const editByOperation = new Map(); // operation_id -> [{ok, t, error_code}]
for (const row of editRows) {
  if (!row.operation_id) continue;
  (editByOperation.get(row.operation_id) || editByOperation.set(row.operation_id, []).get(row.operation_id)).push(row);
}
const retriesPerFailure = [];
let oneShotRecoveries = 0, failuresWithRetry = 0;
for (const events of editByOperation.values()) {
  events.sort((a, b) => a.t - b.t);
  for (let i = 0; i < events.length; i++) {
    if (events[i].ok) continue;
    // 失败之后 10 分钟内同 operationId 的后续提交次数 = 整批作废的重提成本
    const followUps = [];
    for (let k = i + 1; k < events.length && events[k].t - events[i].t <= 600_000; k++) followUps.push(events[k]);
    if (followUps.length) failuresWithRetry++;
    retriesPerFailure.push(followUps.length);
    if (followUps[0]?.ok) oneShotRecoveries++;
  }
}
const editMetrics = {
  edits: editRows.length,
  failed: editRows.filter(row => !row.ok).length,
  failureRate: +(editRows.filter(row => !row.ok).length / Math.max(1, editRows.length)).toFixed(3),
  errorCodes: Object.fromEntries(Object.entries(editRows.filter(row => !row.ok).reduce((acc, row) => { const code = row.error_code || "unknown"; acc[code] = (acc[code] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1])),
  failuresWithFollowUp: failuresWithRetry,
  oneShotRecoveryShare: +(oneShotRecoveries / Math.max(1, failuresWithRetry)).toFixed(3),
  followUpsPerFailure: {
    mean: +(retriesPerFailure.reduce((a, b) => a + b, 0) / Math.max(1, retriesPerFailure.length)).toFixed(2),
    distribution: Object.fromEntries(Object.entries(retriesPerFailure.reduce((acc, n) => { acc[n] = (acc[n] || 0) + 1; return acc; }, {})).sort((a, b) => a[0] - b[0])),
  },
};

// ---------- 4. 视频任务取消率（tasks 表，按创建时间归窗口） ----------
const VIDEO_KINDS = ["canvas-h3-run", "comfyui:minimax-h3"];
const videoTasks = q(`SELECT kind, status, COUNT(*) n FROM tasks WHERE kind IN (${VIDEO_KINDS.map(() => "?").join(",")}) AND created_at >= ? AND created_at < ? GROUP BY kind, status`, [...VIDEO_KINDS, sinceIso, untilIso]);
const videoTotals = { total: 0, cancelled: 0, failed: 0, succeeded: 0 };
for (const row of videoTasks) {
  videoTotals.total += row.n;
  if (row.status === "cancelled") videoTotals.cancelled += row.n;
  if (row.status === "failed") videoTotals.failed += row.n;
  if (row.status === "succeeded") videoTotals.succeeded += row.n;
}
const videoMetrics = { ...videoTotals, byKindStatus: videoTasks, cancelRate: +(videoTotals.cancelled / Math.max(1, videoTotals.total)).toFixed(3) };

// ---------- 5. 新能力专项（改后窗口才有意义） ----------
const sourceRows = rows.filter(row => row.tool === "production_get_source");
const readMetrics = {
  getSourceCalls: sourceRows.length,
  multiSectionCalls: sourceRows.filter(row => Array.isArray(row.input.parameterKeys) && row.input.parameterKeys.includes("sourceSections")).length,
  // 同 session 30 秒窗口内对同一工具的重复读（fan-out 证据，第 1/4 项消解对象）
  bursts: (() => {
    const perTool = new Map();
    for (const row of rows) { const list = perTool.get(row.tool) || perTool.set(row.tool, []).get(row.tool); list.push(row.t); }
    const result = {};
    for (const [tool, times] of perTool) {
      times.sort((a, b) => a - b);
      let bursts = 0;
      for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= 30_000) bursts++;
      if (bursts >= 5) result[tool] = bursts;
    }
    return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1]).slice(0, 10));
  })(),
  getContractCalls: rows.filter(row => row.tool === "production_get_contract").length,
};

// ---------- 6. 场次启动与失败一次纠正（全局） ----------
const sceneWork = rows.filter(row => row.tool === "production_start_scene_work");
const globalRecovery = (() => {
  const bySession = new Map();
  for (const row of rows) { const list = bySession.get(row.session_id) || bySession.set(row.session_id, []).get(row.session_id); list.push(row); }
  let failed = 0, nextSameToolOk = 0;
  for (const events of bySession.values()) {
    events.sort((a, b) => a.t - b.t);
    for (let i = 0; i < events.length; i++) {
      if (events[i].ok) continue;
      failed++;
      const next = events.slice(i + 1, i + 4).find(item => item.tool === events[i].tool);
      if (next?.ok) nextSameToolOk++;
    }
  }
  return { failed, nextSameToolOkShare: +(nextSameToolOk / Math.max(1, failed)).toFixed(3) };
})();

const report = {
  label, since, until, cutover: DEFAULT_CUTOVER, generatedAt: new Date().toISOString(),
  volume: { calls: rows.length, days: Object.keys(byDay).length, callsPerDay: +(rows.length / Math.max(1, Object.keys(byDay).length)).toFixed(1), activeSessions: new Set(rows.map(row => row.session_id)).size, byDay, topTools: toolTable.slice(0, 20) },
  wait: waitMetrics,
  edit: editMetrics,
  video: videoMetrics,
  read: readMetrics,
  sceneWork: { total: sceneWork.length, failed: sceneWork.filter(row => !row.ok).length },
  recovery: globalRecovery,
  // 换算基准（与方案一致）：单次 agent 往返固定开销 3–15s，取中值 9s
  estimateBasis: { roundTripSeconds: 9, note: "节省秒数 = 消除的调用/往返数 × 9s；只计口径一致窗口内的差值" },
};
if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
const brief = (value) => JSON.stringify(value);
console.log(`# ${label}  ${since} ~ ${until}`);
console.log("volume      :", brief({ calls: report.volume.calls, callsPerDay: report.volume.callsPerDay, sessions: report.volume.activeSessions }));
console.log("wait        :", brief({ waits: waitMetrics.waits, active: waitMetrics.activeWaits, near60s: waitMetrics.durationNear60s, activeP50: waitMetrics.activeP50, modes: waitMetrics.waitMode, extraAfterWait: waitMetrics.extraQueriesAfterWait.mean, zeroShare: waitMetrics.extraQueriesAfterWait.zeroShare }));
console.log("edit        :", brief({ edits: editMetrics.edits, failureRate: editMetrics.failureRate, codes: Object.fromEntries(Object.entries(editMetrics.errorCodes).slice(0, 4)), followUpsPerFailure: editMetrics.followUpsPerFailure.mean, oneShot: editMetrics.oneShotRecoveryShare }));
console.log("video       :", brief({ total: videoMetrics.total, cancelRate: videoMetrics.cancelRate, cancelled: videoMetrics.cancelled, failed: videoMetrics.failed }));
console.log("read        :", brief({ getSource: readMetrics.getSourceCalls, multiSection: readMetrics.multiSectionCalls, getContract: readMetrics.getContractCalls }));
console.log("sceneStart  :", brief(report.sceneWork));
console.log("recovery    :", brief(globalRecovery));
if (args.out) console.log("saved       :", path.resolve(args.out));
db.close();
