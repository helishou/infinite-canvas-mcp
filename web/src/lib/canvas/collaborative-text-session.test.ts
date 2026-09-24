import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { CollaborativeTextSession, decodeTextUpdate, encodeTextUpdate, type TextDraft } from "./collaborative-text-session";

function fixture() {
    const server = new Y.Doc();
    server.getText("text").insert(0, "甲乙");
    const disk = new Map<string, TextDraft>();
    const receipts = new Map<string, string>();
    let nextId = 0;
    let offline = false;
    let loseReply = false;
    let gate: Promise<void> | undefined;
    const create = () => {
        const session = new CollaborativeTextSession({
            nextId: () => `op-${++nextId}`,
            read: async () => { if (offline) throw new Error("offline"); return { state: encodeTextUpdate(Y.encodeStateAsUpdate(server)), documentId: "doc-1" }; },
            load: async () => [...disk.values()].map((item) => ({ ...item })),
            save: async (draft) => { disk.set(draft.operationId, { ...draft }); },
            remove: async (draft) => { disk.delete(draft.operationId); },
            send: async (draft) => {
                if (gate) await gate;
                if (offline) throw new Error("offline");
                if (receipts.has(draft.operationId)) assert.equal(receipts.get(draft.operationId), draft.update);
                else {
                    receipts.set(draft.operationId, draft.update);
                    Y.applyUpdate(server, decodeTextUpdate(draft.update));
                }
                if (loseReply) { loseReply = false; throw new Error("lost receipt"); }
                session.receive({ state: encodeTextUpdate(Y.encodeStateAsUpdate(server)), documentId: "doc-1" });
            },
            isPermanentError: () => false,
        });
        return session;
    };
    return { create, disk, receipts, server, offline: (value: boolean) => { offline = value; }, loseReply: () => { loseReply = true; }, gate: (value?: Promise<void>) => { gate = value; } };
}

test("两个中文编辑增量合并，本地撤销不会撤销远端插入", async () => {
    const f = fixture();
    const a = f.create(), b = f.create();
    await Promise.all([a.initialize(), b.initialize()]);
    const origin = {};
    a.undo.addTrackedOrigin(origin);
    a.doc.transact(() => a.text.insert(1, "我的"), origin);
    b.text.insert(1, "你的");
    await Promise.all([a.flush(), b.flush()]);
    await Promise.all([a.reconnect(), b.reconnect()]);
    assert.equal(a.text.toString(), b.text.toString());
    assert.match(a.text.toString(), /我的/);
    assert.match(a.text.toString(), /你的/);
    a.undo.undo();
    await a.flush();
    await b.reconnect();
    assert.equal(a.text.toString(), "甲你的乙");
    assert.equal(b.text.toString(), a.text.toString());
});

test("丢回执后用相同 ID 和原增量重试，不能重复插入", async () => {
    const f = fixture();
    const a = f.create();
    await a.initialize();
    f.loseReply();
    a.text.insert(1, "好");
    await assert.rejects(a.flush(), /lost receipt/);
    assert.equal(f.disk.size, 1);
    const original = [...f.disk.values()][0];
    await a.flush();
    assert.equal(f.receipts.size, 1);
    assert.equal(f.receipts.get(original.operationId), original.update);
    assert.equal(f.server.getText("text").toString(), "甲好乙");
    assert.equal(f.disk.size, 0);
});

test("离线刷新恢复待确认文本，远端继续编辑后重连仍合并双方内容", async () => {
    const f = fixture();
    const a = f.create();
    await a.initialize();
    f.offline(true);
    a.text.insert(1, "离线");
    await assert.rejects(a.flush(), /offline/);
    const restored = f.create();
    await restored.initialize();
    assert.equal(restored.getSnapshot().ready, true);
    assert.equal(restored.text.toString(), "甲离线乙");
    f.server.getText("text").insert(2, "远端");
    f.offline(false);
    await restored.reconnect();
    assert.equal(restored.text.toString(), "甲离线乙远端");
    assert.equal(f.disk.size, 0);
});

test("队首网络请求等待时，新输入也立即落盘", async () => {
    const f = fixture();
    const a = f.create();
    await a.initialize();
    let release!: () => void;
    f.gate(new Promise<void>((resolve) => { release = resolve; }));
    a.text.insert(1, "一");
    const sending = a.flush();
    a.text.insert(2, "二");
    await Promise.resolve();
    assert.equal(f.disk.size, 2);
    release();
    await sending;
    assert.equal(f.server.getText("text").toString(), "甲一二乙");
});

test("确定性拒绝保留草稿并停止自动提交，显式重试前不能继续发同一请求", async () => {
    const seed = new Y.Doc();
    seed.getText("text").insert(0, "原文");
    const error = new Error("目标已删除");
    const disk = new Map<string, TextDraft>();
    let requests = 0;
    const session = new CollaborativeTextSession({
        nextId: () => "blocked-op",
        read: async () => ({ state: encodeTextUpdate(Y.encodeStateAsUpdate(seed)), documentId: "doc-1" }),
        load: async () => [],
        save: async (draft) => { disk.set(draft.operationId, draft); },
        remove: async (draft) => { disk.delete(draft.operationId); },
        send: async () => { requests++; throw error; },
        isPermanentError: (value) => value === error,
    });
    await session.initialize();
    session.text.insert(2, "修改");
    await assert.rejects(session.flush(), /目标已删除/);
    await assert.rejects(session.flush(), /目标已删除/);
    assert.equal(session.getSnapshot().blocked, true);
    assert.equal(requests, 1);
    assert.equal(disk.size, 1);
});

test("同 ID 对象重建后拒绝合并新身份，旧草稿和正文保持可恢复", async () => {
    const f = fixture();
    const session = f.create();
    await session.initialize();
    f.offline(true);
    session.text.insert(1, "待恢复");
    await assert.rejects(session.flush(), /offline/);
    const state = encodeTextUpdate(Y.encodeStateAsUpdate(f.server));
    assert.throws(() => session.receive({ state, documentId: "recreated" }), /替换/);
    assert.equal(session.text.toString(), "甲待恢复乙");
    assert.equal(session.getSnapshot().blocked, true);
    assert.equal(f.disk.size, 1);
    assert.equal([...f.disk.values()][0].documentId, "doc-1");
});
