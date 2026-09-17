import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";
import * as Y from "yjs";

const buckets = new Map<string, Map<string, unknown>>();
let failStore = "";
let failImportRead = false;
localforage.createInstance = ((options: { name: string }) => {
    const bucket = buckets.get(options.name) || new Map<string, unknown>(); buckets.set(options.name, bucket);
    return {
        getItem: async (key: string) => bucket.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { if (options.name === failStore) throw new Error("磁盘满"); bucket.set(key, structuredClone(value)); return value; },
        removeItem: async (key: string) => { bucket.delete(key); },
        iterate: async (visit: (value: unknown, key: string) => void) => { if (failImportRead && options.name === "infinite-canvas-draft-imports") throw new Error("无法读取导入档案"); bucket.forEach(visit); },
    };
}) as unknown as typeof localforage.createInstance;
const held = new Set<string>();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (name: string, _: unknown, action: (lock: unknown) => unknown) => {
        if (held.has(name)) return action(null);
        held.add(name); try { return await action({ name }); } finally { held.delete(name); }
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
} } });
const { parseCanvasDraftImport, importCanvasDraftBackup } = await import("./canvas-draft-import");
const { hasPendingDraftImport } = await import("../../lib/canvas/canvas-draft-import-state");
const { listCanvasDrafts } = await import("./canvas-drafts");
const { reopenCanvasDraftSession } = await import("../../lib/canvas/canvas-draft-session");
const backend = "http://127.0.0.1:17370", ownerId = "closed-owner";
const commandStore = "infinite-canvas-command-outbox", textStore = "infinite-canvas-text-outbox";
const base = { id: "p", title: "画布", nodes: [], connections: [] };
const source = { clientId: "original-client", kind: "browser", label: "浏览器" };
const command = { operationId: "original-op", projectId: "p", ownerId, backend, base, baseRevision: 7, source, order: 1, operations: [{ type: "update_project", patch: { title: "恢复标题" } }] };
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const doc = new Y.Doc(); doc.getText("text").insert(0, "未提交正文");
const textDraft = { operationId: "text-op", projectId: "p", ownerId, backend, source, order: 2, documentId: "doc-id", target: { field: "globalPrompt" }, state: encode(Y.encodeStateAsUpdate(doc)), update: encode(Y.encodeStateAsUpdate(doc)) };
const file = () => ({ format: "canvas-draft-backup", version: 1, records: [{ store: commandStore, key: command.operationId, value: command }, { store: textStore, key: textDraft.operationId, value: textDraft }] });

test("备份全量校验，拒绝跨后台、混合归属、重复项和损坏增量，未写入草稿", async () => {
    assert.throws(() => parseCanvasDraftImport(JSON.stringify({ ...file(), version: 99 })), /版本/);
    assert.throws(() => parseCanvasDraftImport(JSON.stringify({ ...file(), records: [file().records[0], file().records[0]] })), /重复/);
    assert.throws(() => parseCanvasDraftImport(JSON.stringify({ ...file(), records: [file().records[0], { ...file().records[1], value: { ...textDraft, ownerId: "other" } }] })), /同一/);
    assert.throws(() => parseCanvasDraftImport(JSON.stringify({ ...file(), records: [{ ...file().records[1], value: { ...textDraft, update: "broken" } }] })), /增量损坏/);
    const foreign = parseCanvasDraftImport(JSON.stringify({ ...file(), records: [{ ...file().records[0], value: { ...command, backend: "http://elsewhere" } }] }));
    await assert.rejects(importCanvasDraftBackup(foreign), /其他后台/);
    assert.equal(buckets.get(commandStore)?.size || 0, 0);
});

test("内存备份保留请求原文，清理记录不转换为删除操作", () => {
    const parsed = parseCanvasDraftImport(JSON.stringify({ format: "canvas-unsaved-memory", version: 1, records: [{ key: "command:original-op", record: command }, { key: "text:old-op", record: null }] }));
    assert.deepEqual(parsed.records[0].value, command);
    assert.equal(parsed.skipped, 1);
    assert.equal(parsed.records.length, 1);
});

test("活跃窗口不可导入；同 ID 不同内容拒绝覆盖且不落半份新记录", async () => {
    const archive = parseCanvasDraftImport(JSON.stringify(file()));
    held.add("canvas-draft-owner:" + ownerId);
    await assert.rejects(importCanvasDraftBackup(archive), /另一窗口/);
    held.clear();
    buckets.set(commandStore, new Map([[command.operationId, { ...command, order: 99 }]]));
    await assert.rejects(importCanvasDraftBackup(archive), /不同内容/);
    assert.equal(buckets.get(textStore)?.size || 0, 0);
    assert.equal(await hasPendingDraftImport(ownerId), false);
    buckets.get(commandStore)!.clear();
});

test("中途存储失败保留完整档案并关闭恢复入口；原样重试完成后可恢复", async () => {
    const archive = parseCanvasDraftImport(JSON.stringify(file()));
    failStore = textStore;
    await assert.rejects(importCanvasDraftBackup(archive), /磁盘满/);
    assert.equal(await hasPendingDraftImport(ownerId), true);
    await assert.rejects(reopenCanvasDraftSession(ownerId), /尚未完整导入/);
    const bundle = (await listCanvasDrafts()).find((item) => item.ownerId === ownerId)!;
    assert.equal(bundle.importPending, true);
    assert.equal(bundle.records.length, 2);
    failStore = "";
    await importCanvasDraftBackup(archive);
    assert.equal(await hasPendingDraftImport(ownerId), false);
    assert.deepEqual(buckets.get(commandStore)?.get(command.operationId), command);
    assert.deepEqual(buckets.get(textStore)?.get(textDraft.operationId), textDraft);
    await importCanvasDraftBackup(archive);
    assert.equal(buckets.get(commandStore)?.size, 1);
    assert.equal(buckets.get(textStore)?.size, 1);
});

test("导入状态不可读时不认领旧 owner，也不阻止新窗口在线打开", async () => {
    const saved = new Map([["canvas-draft-session", ownerId]]);
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) } });
    const { initializeCanvasDraftSession, getCanvasDraftSessionId } = await import("../../lib/canvas/canvas-draft-session");
    failImportRead = true;
    try {
        await initializeCanvasDraftSession();
        assert.notEqual(getCanvasDraftSessionId(), ownerId);
        assert.equal(saved.get("canvas-draft-session"), getCanvasDraftSessionId());
        assert.deepEqual(buckets.get(commandStore)?.get(command.operationId), command);
    } finally { failImportRead = false; }
});
