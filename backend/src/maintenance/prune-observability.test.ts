import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function spawnCli(dataDir: string, ...cliArgs: string[]): Record<string, unknown> {
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/maintenance/prune-observability.ts", ...cliArgs], {
        cwd: backendRoot,
        env: { ...process.env, INFINITE_CANVAS_DATA_DIR: dataDir },
        encoding: "utf8",
    });
    return JSON.parse(out.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
}

test("v31 migration creates the created_at index and is idempotent", (t: TestContext) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-obs-"));
    const file = path.join(directory, "test.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const index = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mcp_observability_created_at'").get();
    assert.ok(index, "mcp_observability_created_at 索引未创建");
    // 重复打开不报错、不重建（在测试体内关闭，避免 after 钩子删目录时句柄未释放）。
    const again = new BackendDatabase(file);
    assert.ok(again.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mcp_observability_created_at'").get());
    again.close();
});

test("prune-observability CLI: dry-run reports, apply deletes, rejects missing db and bad args", (t: TestContext) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-obs-cli-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const old = "2020-01-01T00:00:00.000Z";
    const recent = "2030-01-01T00:00:00.000Z";
    for (const createdAt of [old, old, recent]) {
        db.createMcpObservabilityEvent({ sessionId: "s", traceId: "t", event: "tool.started", tool: "x", inputSummary: {}, outputSummary: {} });
    }
    db.db.prepare("UPDATE mcp_observability_events SET created_at = ? WHERE id IN (SELECT id FROM mcp_observability_events ORDER BY created_at LIMIT 2)").run(old);
    db.db.prepare("UPDATE mcp_observability_events SET created_at = ? WHERE id IN (SELECT id FROM mcp_observability_events ORDER BY created_at DESC LIMIT 1)").run(recent);

    const dry = spawnCli(directory, "7");
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldDelete, 2);
    assert.equal(dry.deleted, 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM mcp_observability_events").get()?.n, 3);

    const applied = spawnCli(directory, "7", "--apply");
    assert.equal(applied.dryRun, false);
    assert.equal(applied.deleted, 2);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM mcp_observability_events").get()?.n, 1);

    assert.throws(() => spawnCli(directory, "7", "--bogus"), (error: any) => /Usage/.test(String(error.message)));
    assert.throws(() => spawnCli(path.join(directory, "empty"), "7"), (error: any) => /数据库不存在/.test(String(error.message)));
    assert.equal(fs.existsSync(path.join(directory, "empty", "runtime.sqlite")), false);
});
