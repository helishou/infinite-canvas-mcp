import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { listDatabaseSnapshots, pruneDatabaseSnapshots, snapshotRetention } from "./database-snapshots.js";

function scratch(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-snapshots-"));
    t.after(() => {
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid test cleanup directory");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { directory, file: path.join(directory, "runtime.sqlite") };
}

/** 写入一份带显式 mtime 的假快照；mtime 是保留策略唯一的排序依据。 */
function fakeSnapshot(file: string, family: string, name: string, mtimeMs: number) {
    const target = `${file}.${family}-${name}.sqlite`;
    fs.writeFileSync(target, "snapshot");
    fs.utimesSync(target, new Date(mtimeMs), new Date(mtimeMs));
    return target;
}

test("retention deletes the oldest snapshots of one family and keeps the newest", (t) => {
    const { file } = scratch(t);
    const oldest = fakeSnapshot(file, "demo", "a", 1_000_000);
    const middle = fakeSnapshot(file, "demo", "b", 2_000_000);
    const newest = fakeSnapshot(file, "demo", "c", 3_000_000);

    const result = pruneDatabaseSnapshots(file, "demo", 2);

    assert.deepEqual(result.kept, [newest, middle]);
    assert.deepEqual(result.removed, [oldest]);
    assert.equal(fs.existsSync(oldest), false);
    assert.equal(fs.existsSync(newest), true);
});

test("retention never touches other families, the live database, or its sidecars", (t) => {
    const { directory, file } = scratch(t);
    fs.writeFileSync(file, "live database");
    fs.writeFileSync(`${file}-wal`, "wal");
    fs.writeFileSync(`${file}-shm`, "shm");
    const other = fakeSnapshot(file, "other-family", "a", 1_000_000);
    const owned = fakeSnapshot(file, "demo", "a", 1_000_000);

    pruneDatabaseSnapshots(file, "demo", 0);

    assert.equal(fs.existsSync(owned), false);
    assert.equal(fs.existsSync(other), true);
    assert.deepEqual(
        fs.readdirSync(directory).sort(),
        [path.basename(file), `${path.basename(file)}-shm`, `${path.basename(file)}-wal`, path.basename(other)].sort(),
    );
});

test("listing is newest first and ignores unrelated names", (t) => {
    const { file } = scratch(t);
    fs.writeFileSync(`${file}.demo-not-a-snapshot.txt`, "ignored");
    const older = fakeSnapshot(file, "demo", "a", 1_000_000);
    const newer = fakeSnapshot(file, "demo", "b", 2_000_000);

    assert.deepEqual(listDatabaseSnapshots(file, "demo"), [newer, older]);
});

test("retention default is a bounded positive number and env can tighten it", (t) => {
    const previous = process.env.INFINITE_CANVAS_SNAPSHOT_KEEP;
    t.after(() => { if (previous === undefined) delete process.env.INFINITE_CANVAS_SNAPSHOT_KEEP; else process.env.INFINITE_CANVAS_SNAPSHOT_KEEP = previous; });

    delete process.env.INFINITE_CANVAS_SNAPSHOT_KEEP;
    assert.equal(snapshotRetention(), 2);
    process.env.INFINITE_CANVAS_SNAPSHOT_KEEP = "0";
    assert.equal(snapshotRetention(), 0);
    process.env.INFINITE_CANVAS_SNAPSHOT_KEEP = "not-a-number";
    assert.equal(snapshotRetention(), 2);
});
