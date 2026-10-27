import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const rootConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8")); } catch { return {}; } })();
const dataDir = process.env.INFINITE_CANVAS_DATA_DIR ? path.resolve(process.env.INFINITE_CANVAS_DATA_DIR) : rootConfig.dataDir ? path.resolve(rootConfig.dataDir) : path.join(os.homedir(), ".infinite-canvas");
const file = path.join(dataDir, "runtime.sqlite");
const db = new DatabaseSync(file, { readOnly: true });
const row = db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id = ?").get("episode-ZtSuzRl8Co3AF3YFZZ-hn-4-390xia");
const source = JSON.parse(row.draft_json).director.source;
const out = path.join(os.tmpdir(), "ep4-source.json");
fs.writeFileSync(out, JSON.stringify({ db: file, script_scenes: source.script_scenes, coverage: source.ledger.coverage }, null, 2), "utf8");
console.log(JSON.stringify({ db: file, out, scenes: source.script_scenes.length, keysFirst: Object.keys(source.script_scenes[0]) }));
db.close();
