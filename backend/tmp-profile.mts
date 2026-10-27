import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const source = "C:/Users/wxy/.infinite-canvas/runtime.sqlite";
const dir = mkdtempSync(join(tmpdir(), "ic-profile-"));
const copy = join(dir, "copy.sqlite");
const reader = new DatabaseSync(source, { readOnly: true });
reader.exec(`VACUUM INTO '${copy.replaceAll("\\", "/")}'`);
reader.close();

const { BackendDatabase } = await import("./src/db.ts");
const { EpisodeProductionService } = await import("./src/drama/production.ts");

const db = new BackendDatabase(copy);
const service: any = new EpisodeProductionService(db, undefined, dir);
const episodeId = process.argv[2] || "episode-ZtSuzRl8Co3AF3YFZZ-hn-2-fee4k2";

for (let i = 0; i < 3; i += 1) service.workflowReadiness(episodeId, "draft");
const started = performance.now();
for (let i = 0; i < 15; i += 1) service.workflowReadiness(episodeId, "draft");
console.log(`avg=${((performance.now() - started) / 15).toFixed(1)}ms`);
db.close();
