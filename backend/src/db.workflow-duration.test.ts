import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackendDatabase } from "./db.js";

/** 升级前的工作流配置表：没有 duration_target_json 列。 */
const LEGACY_SCHEMA = `
    CREATE TABLE workflow_configs (
        name TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        backend TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL DEFAULT '',
        fields_json TEXT NOT NULL DEFAULT '[]',
        media_inputs_json TEXT NOT NULL DEFAULT '{}',
        mini_cards_json TEXT NOT NULL DEFAULT '{}',
        runninghub_profile_id TEXT NOT NULL DEFAULT '',
        run_target TEXT NOT NULL DEFAULT 'local',
        output_nodes_json TEXT NOT NULL DEFAULT '',
        preview_node_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );
`;

function tempDatabase(context: { after: (fn: () => void) => void }) {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-duration-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, "runtime.sqlite");
}

test("老库自动补 duration_target_json 列，旧配置保持未配置状态", (context) => {
    const file = tempDatabase(context);
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_SCHEMA);
    legacy.exec(`INSERT INTO workflow_configs (name, title, fields_json, updated_at) VALUES ('custom/legacy.json', '旧流', '[{"id":"duration","node":"132","input":"value"}]', '2026-01-01T00:00:00Z')`);
    legacy.close();

    const db = new BackendDatabase(file);
    try {
        const columns = (db.db.prepare("PRAGMA table_info(workflow_configs)").all() as Array<{ name: string }>).map((item) => item.name);
        assert.ok(columns.includes("duration_target_json"));
        const row = db.getWorkflowConfig("custom/legacy.json");
        assert.equal(row?.durationTargetJson, "");
        assert.equal(row?.title, "旧流");
        assert.equal(JSON.parse(row?.fieldsJson || "[]")[0].node, "132");
    } finally { db.db.close(); }
});

test("新库写入 / 读回 / 显式清空 / 不带字段沿用旧值", (context) => {
    const db = new BackendDatabase(tempDatabase(context));
    const name = "custom/duration.json";
    const target = JSON.stringify({ nodeId: "136", input: "length", unit: "frames" });
    try {
        db.upsertWorkflowConfig(name, { title: "时长流", durationTargetJson: target });
        assert.equal(db.getWorkflowConfig(name)?.durationTargetJson, target);

        // 一次普通保存没带该字段，不能把已配置的目标抹掉。
        db.upsertWorkflowConfig(name, { title: "改名" });
        assert.equal(db.getWorkflowConfig(name)?.durationTargetJson, target);
        assert.equal(db.getWorkflowConfig(name)?.title, "改名");

        // 显式清空存空串，与「从未配置」一致地表示不注入。
        db.upsertWorkflowConfig(name, { durationTargetJson: "" });
        assert.equal(db.getWorkflowConfig(name)?.durationTargetJson, "");
        assert.equal(db.getWorkflowConfig(name)?.title, "改名");
    } finally { db.db.close(); }
});
