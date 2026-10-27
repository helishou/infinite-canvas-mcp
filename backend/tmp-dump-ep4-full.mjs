import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const rootConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8")); } catch { return {}; } })();
const dataDir = process.env.INFINITE_CANVAS_DATA_DIR ? path.resolve(process.env.INFINITE_CANVAS_DATA_DIR) : rootConfig.dataDir ? path.resolve(rootConfig.dataDir) : path.join(os.homedir(), ".infinite-canvas");
const file = path.join(dataDir, "runtime.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
const row = db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id = ?").get("episode-ZtSuzRl8Co3AF3YFZZ-hn-4-390xia");
const draft = JSON.parse(row.draft_json);
const source = draft.director.source;
const out = path.join(os.tmpdir(), "ep4-full-source.json");
fs.writeFileSync(out, JSON.stringify(source, null, 2), "utf8");
const summary = {
  out,
  keys: Object.keys(source),
  sceneKeys: source.script_scenes.map((s) => ({ id: s.id, scene_id: s.scene_id, blocks: Array.isArray(s.blocks) ? s.blocks.length : typeof s.blocks, hasText: typeof s.text })),
  coverage: source.ledger.coverage.length,
  digests: source.ledger.coverage.map((c) => [c.source_anchor.block_id, c.source_digest.slice(0, 16)]),
};
console.log(JSON.stringify(summary, null, 2));
db.close();
