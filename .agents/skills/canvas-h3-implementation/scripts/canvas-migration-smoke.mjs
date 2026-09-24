// 迁移验证脚本：模拟「老 db 升级到当前版本」跑一遍迁移，比对迁移前后体积。
//
// 用法：
//   1. 准备一个 JSON 描述你想构造的"老"canvas_projects.data_json（可以用 exportSnapshot 拿）；
//   2. 在 SCRIPT 末尾的 testCases 里加一条；
//   3. node dist/canvas-migration-smoke.mjs
//
// 脚本输出迁移前/后体积、压缩率、以及你指定要检查的字段是否已被剥掉。
//
// 设计原则：
//   - 不依赖网络 / running backend / tsx-watch，纯本地 SQLite + BackendDatabase；
//   - 用 DatabaseSync 建 schema（模拟"db 在 v(N-1) 启动过但还没跑 vN 迁移"）；
//   - 用 INSERT schema_migrations VALUES (currentVersionBefore) 模拟老版本；
//   - 用 BackendDatabase(dbFile) 触发迁移；
//   - 读 db.db.prepare("SELECT data_json FROM canvas_projects WHERE id=?").get(...) 拿 migration 后的 data_json。

import { DatabaseSync } from "node:sqlite";
import { BackendDatabase } from "./db.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ESC = String.fromCharCode(92);
const DQ = String.fromCharCode(34);

/**
 * 在临时 db 上跑迁移并返回迁移后 data_json。
 * @param {object} args
 * @param {number} args.currentVersionBefore 模拟"老 db"的 schema_migrations 版本
 * @param {string} args.projectId 测试项目 id
 * @param {string} args.dataJson 测试项目 data_json 字符串（用 JSON.stringify 后传入）
 * @returns {{ ok: boolean, dataJson: string|null, error?: string }}
 */
export function runMigrationOnFreshDb({ currentVersionBefore, projectId, dataJson }) {
    const tmp = mkdtempSync(join(tmpdir(), "canvas-mig-"));
    const dbFile = join(tmp, "test.db");
    try {
        const rawDb = new DatabaseSync(dbFile);
        // 建最小 schema（必须先建好才能 INSERT schema_migrations）
        rawDb.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE canvas_projects (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE generation_logs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT, segment_id TEXT, status TEXT NOT NULL, platform TEXT NOT NULL, workflow TEXT, model TEXT, task_mode TEXT, prompt TEXT, references_json TEXT NOT NULL DEFAULT '[]', input_counts_json TEXT NOT NULL DEFAULT '{}', runtime_task_id TEXT, prompt_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, outputs_json TEXT NOT NULL DEFAULT '[]', error TEXT, params_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
        rawDb.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(currentVersionBefore, "2026-01-01T00:00:00Z");
        rawDb.prepare("INSERT INTO canvas_projects VALUES (?, ?, ?)").run(projectId, dataJson, "2026-01-01T00:00:00Z");
        rawDb.close();

        // 触发 BackendDatabase migrate()
        const db = new BackendDatabase(dbFile);
        const row = db.db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(projectId);
        db.close();

        return { ok: true, dataJson: row?.data_json ?? null };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * 在临时 db 上跑迁移后，断言指定字段已被剥掉。
 * @param {object} args
 * @param {number} args.currentVersionBefore
 * @param {string} args.projectId
 * @param {string} args.dataJson
 * @param {string[]} args.fieldsToStrip 期望被剥掉的字段路径（支持 "metadata.materials" 这种点路径）
 * @returns {{ ok: boolean, stripped: string[], beforeSize: number, afterSize: number, ratio: number, error?: string }}
 */
export function assertMigrationStripsFields({ currentVersionBefore, projectId, dataJson, fieldsToStrip }) {
    const beforeSize = dataJson.length;
    const result = runMigrationOnFreshDb({ currentVersionBefore, projectId, dataJson });
    if (!result.ok) return { ok: false, beforeSize, afterSize: 0, ratio: 0, stripped: [], error: result.error };
    const afterSize = result.dataJson?.length ?? 0;
    const afterParsed = result.dataJson ? JSON.parse(result.dataJson) : null;
    const stripped = [];
    for (const fieldPath of fieldsToStrip) {
        const parts = fieldPath.split(".");
        let cur = afterParsed;
        for (const part of parts) cur = cur?.[part];
        if (cur === undefined) stripped.push(fieldPath);
    }
    return {
        ok: stripped.length === fieldsToStrip.length,
        stripped,
        beforeSize,
        afterSize,
        ratio: beforeSize === 0 ? 0 : 1 - afterSize / beforeSize,
    };
}

// ── 用法示例 ──
const testCases = [
    {
        name: "v5: H3 segment.results[].params 应被剥掉",
        currentVersionBefore: 4,
        projectId: "test",
        fieldsToStrip: [
            "nodes.0.metadata.materials",
        ],
        dataJson: JSON.stringify({
            id: "test", title: "t", revision: 1,
            nodes: [{
                id: "h3-node", type: "minimax-h3:video",
                position: { x: 0, y: 0 }, width: 200, height: 200,
                metadata: {
                    materials: [{ url: "/media/old.mp4" }],
                    segments: [{
                        id: "seg_1", duration: 7,
                        results: [{ url: "/media/v.mp4", storageKey: "k1", params: { prompt: "..." }, comfy_params: { workflow: "..." } }],
                        refItems: [{ url: "/media/x.png" }],
                    }],
                },
            }],
            connections: [],
        }),
    },
];

if (import.meta.url === `file://${process.argv[1]}`) {
    console.log("=== canvas-migration-smoke ===");
    for (const tc of testCases) {
        const result = assertMigrationStripsFields({
            currentVersionBefore: tc.currentVersionBefore,
            projectId: tc.projectId,
            dataJson: tc.dataJson,
            fieldsToStrip: tc.fieldsToStrip,
        });
        console.log(`\n[${tc.name}]`);
        if (!result.ok) {
            console.log(`  ✗ failed: ${result.error}`);
            continue;
        }
        console.log(`  size: ${result.beforeSize} → ${result.afterSize} chars (${(result.ratio * 100).toFixed(1)}% smaller)`);
        console.log(`  stripped: ${result.stripped.length === tc.fieldsToStrip.length ? "✓ all" : "✗ missing " + tc.fieldsToStrip.filter((f) => !result.stripped.includes(f)).join(", ")}`);
    }
}
