import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE } from "../config.js";
import { BackendDatabase } from "../db.js";
import { pruneDatabaseSnapshots } from "../database-snapshots.js";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(path.dirname(DB_FILE), `runtime.sqlite.before-inline-media-redaction-${stamp}.sqlite`);
const backupDb = new DatabaseSync(DB_FILE);
try {
    fs.rmSync(backupFile, { force: true });
    backupDb.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
} finally {
    backupDb.close();
}
// 同一用途只保留最新若干份，避免每次维护都堆一整份全库副本。
pruneDatabaseSnapshots(DB_FILE, "before-inline-media-redaction");

const db = new BackendDatabase(DB_FILE);
try {
    const result = db.redactLegacyInlineMedia();
    console.log(JSON.stringify({ ok: true, backupFile, ...result }));
} finally {
    db.close();
}
