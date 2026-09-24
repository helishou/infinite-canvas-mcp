import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { CanvasTextPresence, encodeCanvasTextSelection, resolveCanvasTextSelection } from "./canvas-text-presence";

const target = { nodeId: "h3", segmentId: "S03", field: "prompt" as const };
test("远端插入后相对光标/选区跟随原文字，不停留在旧索引", () => {
    const first = new Y.Doc(), second = new Y.Doc();
    const text = first.getText("text"); text.insert(0, "甲乙丙丁");
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    const selection = encodeCanvasTextSelection(text, target, "document", 1, 3);
    second.getText("text").insert(0, "远端");
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    assert.deepEqual(resolveCanvasTextSelection(text, target, "document", selection), { anchor: 3, head: 5 });
    assert.deepEqual(resolveCanvasTextSelection(second.getText("text"), target, "document", selection), { anchor: 3, head: 5 });
    first.destroy(); second.destroy();
});
test("不同 Clip、重建文档和损坏位置不显示旧光标", () => {
    const doc = new Y.Doc(), text = doc.getText("text"); text.insert(0, "正文");
    const selection = encodeCanvasTextSelection(text, target, "old-document", 1, 1);
    assert.equal(resolveCanvasTextSelection(text, { ...target, segmentId: "S04" }, "old-document", selection), null);
    assert.equal(resolveCanvasTextSelection(text, target, "new-document", selection), null);
    assert.equal(resolveCanvasTextSelection(text, target, "old-document", { ...selection, anchor: "broken" }), null);
    doc.destroy();
});
test("新编辑器接管后旧 blur 不清空位置；断线清除远端；画布鼠标变化不通知文本", () => {
    const presence = new CanvasTextPresence(), oldEditor = {}, newEditor = {};
    const selection = { target, documentId: "doc", anchor: "a", head: "b" };
    let localCalls = 0, remoteCalls = 0;
    presence.onLocal(() => { localCalls++; }); presence.onRemote(() => { remoteCalls++; });
    presence.publish(oldEditor, selection);
    presence.publish(newEditor, selection);
    presence.publish(oldEditor, null);
    assert.deepEqual(presence.getLocal(), selection);
    assert.equal(localCalls, 1);
    presence.publish(newEditor, null);
    assert.equal(localCalls, 2);
    const peer = { connectionId: "peer", label: "协作者", color: "#0f766e", textSelection: selection };
    presence.receive([peer]); presence.receive([{ ...peer }]);
    assert.equal(remoteCalls, 1);
    presence.receive([]);
    assert.deepEqual(presence.getPeers(), []);
    assert.equal(remoteCalls, 2);
});
