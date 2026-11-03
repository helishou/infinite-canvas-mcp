#!/usr/bin/env node
/**
 * 内部制作代理（codex 线程）此刻在想什么——只读 ~/.codex/sessions 的 rollout 流。
 *
 * 用法：
 *   node scripts/mcp-agent-thoughts.mjs                    # 最近 30 分钟活跃的线程
 *   node scripts/mcp-agent-thoughts.mjs --minutes 120      # 扩大窗口
 *   node scripts/mcp-agent-thoughts.mjs --thread 01a17b3e  # 指定线程前缀
 *   node scripts/mcp-agent-thoughts.mjs --tail 40          # 每线程显示条数
 *
 * 说明：这只覆盖 Backend 内部代理（场次制作/审核/director-subagent，走 codex 线程）。
 * 聊天窗里的外部 agent 的推理只在它自己的客户端里，Backend 遥测看不见。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const minutes = Number(get("minutes", 30));
const threadPrefix = get("thread", null);
const tail = Number(get("tail", 12));
const root = path.join(os.homedir(), ".codex", "sessions");

const walk = (dir, depth = 0) => {
  if (depth > 3) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, depth + 1) : e.name.endsWith(".jsonl") ? [full] : [];
  });
};
const cutoff = Date.now() - minutes * 60_000;
const files = walk(root)
  .map(f => ({ f, m: fs.statSync(f).mtimeMs }))
  .filter(item => item.m >= cutoff)
  .sort((a, b) => b.m - a.m)
  .slice(0, 5);

if (!files.length) { console.log(`最近 ${minutes} 分钟没有活跃的 codex 线程。`); process.exit(0); }

const readTail = (file, bytes = 4 * 1024 * 1024) => {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  return buffer.toString("utf8").split("\n").filter(Boolean);
};

const fmt = (iso) => new Date(new Date(iso).getTime() + 8 * 3600_000).toTimeString().slice(0, 8);
const clip = (text, n = 220) => String(text || "").replace(/\s+/g, " ").slice(0, n);

for (const { f, m } of files) {
  const lines = readTail(f);
  const items = [];
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || {};
    if (p.type === "reasoning" && Array.isArray(p.summary)) {
      for (const s of p.summary) if (s.text) items.push({ t: row.timestamp, kind: "想", text: s.text });
    } else if (p.type === "agent_message") {
      items.push({ t: row.timestamp, kind: "说", text: p.message });
    } else if (p.type === "message" && p.role === "assistant") {
      const text = (p.content || []).map(c => c.text).join(" ");
      if (text) items.push({ t: row.timestamp, kind: "说", text });
    } else if (p.type === "function_call" || p.type === "local_shell_call") {
      const action = p.name ? `${p.name}: ${clip(p.arguments, 120)}` : clip(JSON.stringify(p.action), 120);
      items.push({ t: row.timestamp, kind: "调", text: action });
    }
  }
  const idleSec = Math.round((Date.now() - m) / 1000);
  const threadId = path.basename(f).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl/)?.[1] || "";
  if (threadPrefix && !threadId.startsWith(threadPrefix)) continue;
  // 尾部 5 分钟的事件类型：判断线程是「在推进」还是「活着但空转」（如等待授权/心跳）
  const recentTypes = {};
  for (const line of lines.slice(-400)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (Date.parse(row.timestamp) < Date.now() - 5 * 60_000) continue;
    const type = String(row.payload?.type || row.type || "unknown");
    recentTypes[type] = (recentTypes[type] || 0) + 1;
  }
  console.log(`\n## 线程 ${threadId.slice(0, 8)}…  最后写入 ${idleSec < 90 ? `${idleSec}s 前` : `${Math.round(idleSec / 60)}m 前`}  ${path.basename(f)}`);
  for (const item of items.slice(-tail)) console.log(`  ${fmt(item.t)}  ${item.kind}  ${clip(item.text)}`);
  if (!items.length) {
    const top = Object.entries(recentTypes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([type, n]) => `${type}×${n}`).join("、");
    console.log(`  （尾部 4MB 没有推理/消息事件。最近 5 分钟事件：${top || "无"}——只有心跳/设置类事件说明线程活着但没在实际推进。）`);
  }
}
console.log(`\n判读：想=reasoning 摘要（模型当前步的意图）；说=给用户的中间结论；调=正在执行的动作。空隙很久没有新行 = 该线程回合已结束或卡在等待。`);
