import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { BackendDatabase } from "./db.js";
import { DATABASE_SCHEMA_VERSION } from "./database-upgrade.js";
import { schema52Database } from "./test-helpers/schema52-database.js";
import { storedJsonText } from "./json-storage.js";

test("format migration rolls back payloads and marker together, then retries with a verified backup", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "format-upgrade-retry-"));
    const file = path.join(directory, "runtime.sqlite");
    let migrated: BackendDatabase | undefined;
    t.after(() => { migrated?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const initial = schema52Database(file);
    const raw = '{ "n" : 1.00, "prompt" : "' + "原输入".repeat(1000) + '" }';
    const gzip = gzipSync(Buffer.from(raw));
    initial.prepare("INSERT INTO tasks(id,kind,status,input_json,params_json,created_at,updated_at) VALUES('old','canvas-image','succeeded',?,'{}','now','now')").run(gzip);
    initial.exec("CREATE TRIGGER fail_format BEFORE UPDATE OF input_json ON tasks BEGIN SELECT RAISE(ABORT,'injected upgrade failure'); END");
    initial.close();
    assert.throws(() => new BackendDatabase(file), /injected upgrade failure/);
    const unchanged = new DatabaseSync(file);
    try {
        assert.equal(unchanged.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v, 52);
        assert.deepEqual(Buffer.from(unchanged.prepare("SELECT input_json v FROM tasks").get()!.v as Uint8Array), gzip);
        unchanged.exec("DROP TRIGGER fail_format");
    } finally { unchanged.close(); }
    migrated = new BackendDatabase(file);
    assert.equal(migrated.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v, DATABASE_SCHEMA_VERSION);
    assert.equal(storedJsonText(migrated.db.prepare("SELECT input_json v FROM tasks").get()!.v), raw);
    const snapshots = fs.readdirSync(directory).filter(name => name.includes("pre-schema-v52-to-v53"));
    assert.equal(snapshots.length, 2);
    for (const name of snapshots) {
        const backup = new DatabaseSync(path.join(directory, name), { readOnly: true });
        try {
            assert.equal(backup.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
            assert.equal(backup.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v, 52);
            assert.deepEqual(Buffer.from(backup.prepare("SELECT input_json v FROM tasks").get()!.v as Uint8Array), gzip);
        } finally { backup.close(); }
    }
    migrated.close(); migrated = new BackendDatabase(file);
    assert.equal(fs.readdirSync(directory).filter(name => name.includes("pre-schema-v52-to-v53")).length, 2);
    assert.deepEqual(migrated.getTask("old")!.input, JSON.parse(raw));
});
