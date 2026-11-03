#!/usr/bin/env node
/**
 * Agent 卡在哪？——运行中/刚结束的回合诊断（只读）。
 *
 * 用法：
 *   node scripts/mcp-where-stuck.mjs                 # 看最近 30 分钟
 *   node scripts/mcp-where-stuck.mjs --minutes 120   # 看最近 2 小时
 *   node scripts/mcp-where-stuck.mjs --session mcp:xxxx   # 只看某个会话
 *
 * 三种"卡"分开判：
 *   1. 工具在跑（started 无终态 = in-flight，已耗时直接可读）
 *   2. 工具很慢（终态了但 duration 大）
 *   3. 两次调用之间的空隙（agent 在推理/等模型，或人工间隔——不是 Backend 慢）
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const minutes = Number(get("minutes", 30));
const sessionFilter = get("session", null);
const dbFile = path.join(os.homedir(), ".infinite-canvas", "runtime.sqlite");
const db = new DatabaseSync(dbFile, { readOnly: true });
const j = (t) => { try { return JSON.parse(String(t || "{}")); } catch { return {}; } };
const fmt = (iso) => new Date(new Date(iso).getTime() + 8 * 3600_000).toTimeString().slice(0, 8);
const dur = (ms) => ms >= 90_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;

const since = new Date(Date.now() - minutes * 60_000).toISOString();
const events = db.prepare(`SELECT trace_id, session_id, tool, event, duration_ms, error_code,
    input_summary_json, output_summary_json, created_at
  FROM mcp_observability_events WHERE created_at >= ? ORDER BY created_at, id`).all(since);

// 按 trace 配对：started 无终态 = in-flight
const byTrace = new Map();
for (const e of events) { const list = byTrace.get(e.trace_id) || byTrace.set(e.trace_id, []).get(e.trace_id); list.push(e); }
const now = Date.now();
const inflight = [];
const calls = []; // {session, tool, t0, t1, ok, errorCode, wait, bytes}
for (const list of byTrace.values()) {
  const started = list.find(e => e.event === "tool.started");
  const terminal = list.find(e => e.event === "tool.succeeded" || e.event === "tool.failed");
  if (!started) continue;
  if (!terminal) {
    inflight.push({ ...started, runningMs: now - Date.parse(started.created_at) });
    continue;
  }
  calls.push({ session: started.session_id, tool: started.tool, t0: Date.parse(started.created_at), t1: Date.parse(terminal.created_at),
    ok: terminal.event === "tool.succeeded", errorCode: terminal.error_code, durationMs: terminal.duration_ms || 0,
    wait: started.tool === "canvas_wait_tasks", bytes: j(terminal.output_summary_json).outputChars || 0 });
}

// 会话分组 + 空隙
const sessions = new Map();
for (const c of calls) { (sessions.get(c.session) || sessions.set(c.session, []).get(c.session)).push(c); }
const gapTotals = [];
const sessionLines = [];
for (const [session, list] of [...sessions.entries()].sort((a, b) => b.at(-1).t1 - a.at(-1).t1)) {
  if (sessionFilter && !session.includes(sessionFilter)) continue;
  list.sort((a, b) => a.t0 - b.t0);
  const lines = [];
  let prevEnd = null;
  for (const c of list) {
    if (prevEnd) {
      const gap = c.t0 - prevEnd;
      if (gap > 60_000) { lines.push(`  ${fmt(new Date(prevEnd + 8 * 3600_000).toISOString())}  ⏸  空隙 ${(gap / 60_000).toFixed(1)}m（agent 推理/等模型/人工间隔）`); gapTotals.push(gap); }
    }
    const mark = c.wait ? "WAIT" : c.durationMs > 15_000 ? "SLOW" : c.ok ? "    " : "FAIL";
    const err = c.ok ? "" : ` ← ${c.errorCode || "error"}`;
    lines.push(`  ${fmt(new Date(c.t0 + 8 * 3600_000).toISOString())}  ${mark}  ${c.tool.padEnd(34)} ${dur(c.durationMs).padStart(6)}${err}`);
    prevEnd = Math.max(prevEnd ?? 0, c.t1);
  }
  sessionLines.push({ session, lastActive: list.at(-1).t1, lines });
}

console.log(`# 卡点诊断  窗口=最近 ${minutes} 分钟  生成于 ${fmt(new Date(now + 8 * 3600_000).toISOString())}\n`);

console.log(`## ① 正在执行的调用（started 无终态）`);
if (!inflight.length) console.log("  无。当前没有工具在跑——agent 若在动，是在推理或等待你的输入。");
for (const c of inflight.sort((a, b) => b.runningMs - a.runningMs).slice(0, 10)) {
  const flag = c.runningMs > 60_000 ? "⚠ 超过 1 分钟" : "";
  const input = j(c.input_summary_json);
  console.log(`  ${fmt(c.created_at)} 起  ${c.tool}  已跑 ${dur(c.runningMs)}  session=${c.session_id.slice(0, 24)}… ${flag}${input.operationCount ? `  ops=${input.operationCount}` : ""}`);
}

for (const { session, lastActive, lines } of sessionLines.slice(0, 4)) {
  const idleMin = ((now - lastActive) / 60_000).toFixed(1);
  console.log(`\n## ② 会话时间线  ${session.slice(0, 32)}…  （最后活动 ${idleMin} 分钟前，显示最近 ${Math.min(40, lines.length)} 条）`);
  for (const line of lines.slice(-40)) console.log(line);
}

const totalToolMs = calls.reduce((a, c) => a + c.durationMs, 0);
const waitMs = calls.filter(c => c.wait).reduce((a, c) => a + c.durationMs, 0);
const slowMs = calls.filter(c => !c.wait && c.durationMs > 15_000).reduce((a, c) => a + c.durationMs, 0);
const slowList = calls.filter(c => c.durationMs > 15_000).sort((a, b) => b.durationMs - a.durationMs).slice(0, 8);
console.log(`\n## ③ 窗口耗时构成`);
console.log(`  工具执行合计 ${(totalToolMs / 60_000).toFixed(1)}m｜其中等待任务 ${(waitMs / 60_000).toFixed(1)}m｜非等待慢调用(>15s) ${(slowMs / 60_000).toFixed(1)}m｜长空隙合计 ${(gapTotals.reduce((a, b) => a + b, 0) / 60_000).toFixed(1)}m`);
if (slowList.length) {
  console.log(`\n## ④ 最慢的调用（>15s，非等待）`);
  for (const c of slowList) console.log(`  ${dur(c.durationMs).padStart(6)}  ${c.tool.padEnd(34)} ${c.ok ? "" : `← ${c.errorCode || "error"}`}`);
}
console.log(`\n判读：WAIT=等生成任务（设计内，看回执 pendingTaskIds）；SLOW=工具本身慢（找 Backend）；⏸=agent 在推理或人在看（不是 Backend 慢）；FAIL 行是下一个要看的东西。`);
db.close();
