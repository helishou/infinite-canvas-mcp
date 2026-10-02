import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PreparedH3UpdateFiles } from "./prepared-h3-update-files.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(t: any) {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "h3-file-tests-"));
    const root = path.join(dir, "allowed"), archive = path.join(dir, "plans"); await mkdir(root);
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new PreparedH3UpdateFiles(root, archive);
    const file = path.join(root, "source.json"), text = JSON.stringify({ test: "😀 exact" }); await writeFile(file, text);
    return { dir, root, archive, store, file, text };
}

test("file reader enforces absolute root containment, exact digest and JSON extension", async (t) => {
    const f = await fixture(t);
    assert.deepEqual((await f.store.readSource(f.file, hash(f.text))).value, { test: "😀 exact" });
    await assert.rejects(f.store.readSource(f.file, "a".repeat(64)), /SHA|摘要/);
    await assert.rejects(f.store.readSource("source.json", hash(f.text)), /绝对/);
    const other = path.join(f.dir, "outside.json"); await writeFile(other, f.text);
    await assert.rejects(f.store.readSource(other, hash(f.text)), /目录|范围/);
    const textFile = path.join(f.root, "source.txt"); await writeFile(textFile, f.text);
    await assert.rejects(f.store.readSource(textFile, hash(f.text)), /JSON|json/);
    await assert.rejects(f.store.readSource(f.root, hash(f.text)), /JSON|json|文件/);
});

test("symlink escaping allowed root is refused", async (t) => {
    const f = await fixture(t), out = path.join(f.dir, "outside"); await mkdir(out); await writeFile(path.join(out, "secret.json"), f.text);
    const link = path.join(f.root, "link"); await symlink(out, link, "junction");
    await assert.rejects(f.store.readSource(path.join(link, "secret.json"), hash(f.text)), /目录|范围/);
});

test("frozen plans survive store recreation, source mutation and reject tampered archives", async (t) => {
    const f = await fixture(t), plan = { formatVersion: 1, operationId: "stable", revision: 8, operations: [{ safe: true }] };
    const id = await f.store.save(plan);
    await writeFile(f.file, "changed source");
    const fresh = new PreparedH3UpdateFiles(f.root, f.archive);
    assert.deepEqual(await fresh.read(id), plan);
    await assert.rejects(fresh.read("../../secret"), /preparedId/);
    const uuid = id.split(":")[1];
    await writeFile(path.join(f.archive, uuid + ".json"), JSON.stringify({ ...plan, revision: 99 }));
    await assert.rejects(fresh.read(id), /摘要|SHA/);
});

test("discard is explicit, idempotent and does not delete the source or another plan", async (t) => {
    const f = await fixture(t), a = await f.store.save({ value: "a" }), b = await f.store.save({ value: "b" });
    await f.store.discard(a); await f.store.discard(a);
    await assert.rejects(f.store.read(a));
    assert.deepEqual(await f.store.read(b), { value: "b" });
    assert.equal(await readFile(f.file, "utf8"), f.text);
});
