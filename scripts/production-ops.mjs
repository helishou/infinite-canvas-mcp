#!/usr/bin/env node
// 用法: node scripts/production-ops.mjs <episodeId|canvasId> <payload.json>
// 读取 JSON 文件（含 operationId/expectedRevision/ops），POST 到 backend /production/ops。
// 背景：MCP production_edit 的长中文 JSON 参数在传输层会偶发损坏（type 字段被吞、ops 数组重复），
// 大补丁一律走本脚本直发 backend，MCP 只用于短调用与读取。
// 示例 payload 见 tmp/clip15-check/s15cam.json。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [targetId, file] = process.argv.slice(2);
if (!targetId || !file) {
  console.error("用法: node scripts/production-ops.mjs <episodeId|canvasId> <payload.json>");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas", "backend.json"), "utf8"));
const body = fs.readFileSync(file, "utf8");
JSON.parse(body); // 发送前先本地校验 JSON 合法
const base = targetId.startsWith("episode-")
  ? `/drama/episodes/${encodeURIComponent(targetId)}`
  : `/canvas/projects/${encodeURIComponent(targetId)}`;
const res = await fetch(`${cfg.url}${base}/production/ops`, {
  method: "POST",
  headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  body,
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  const json = JSON.parse(text);
  console.log(JSON.stringify({ ok: json.ok, revision: json.production?.revision, clipRefreshes: json.clipRefreshSummary ?? json.clipRefreshes?.map((c) => ({ id: c.segmentId, status: c.status })) }, null, 2));
} catch {
  console.log(text.slice(0, 2000));
}
if (!res.ok) process.exit(2);
