import localforage from "localforage";
import * as Y from "yjs";

// Isolated fixture transport: no request from this page reaches the production Backend.
const projectId = "test-orphan-text-drafts";
const orphanNodeId = "deleted-config";
const project = { id: projectId, nodes: [{ id: "active-config", metadata: {} }] };
const reads: string[] = [];
const sends: string[] = [];
const documents = new Map<string, Y.Doc>();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const lines: string[] = [];
const report = (line: string) => { lines.push(line); document.querySelector("#results")!.textContent = lines.join("\n"); };
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); report("PASS: " + label); };
sessionStorage.setItem("backend-connection", JSON.stringify({ url: location.origin, token: "fixture-only" }));
window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.pathname.startsWith("/canvas/draft-sessions/")) return Response.json({ ok: true, lease: { active: true, owned: true, expiresAt: Date.now() + 60_000 } });
    if (!url.pathname.startsWith(`/canvas/projects/${projectId}/`)) throw new Error("Unexpected fixture request: " + url.pathname);
    if (url.pathname.endsWith("/text")) {
        const nodeId = url.searchParams.get("nodeId")!;
        reads.push(nodeId);
        if (!project.nodes.some(node => node.id === nodeId)) return Response.json({ ok: false, error: `找不到节点：${nodeId}` }, { status: 400 });
        return Response.json({ ok: true, documentId: `document:${nodeId}`, state: encode(Y.encodeStateAsUpdate(documents.get(nodeId)!)) });
    }
    if (url.pathname.endsWith("/ops")) {
        const command = JSON.parse(String(init?.body));
        const operation = command.operations[0];
        sends.push(operation.target.nodeId);
        if (operation.target.nodeId === "rejected-config") return Response.json({ ok: false, error: "当前提示词未同步" }, { status: 400 });
        Y.applyUpdate(documents.get(operation.target.nodeId)!, Uint8Array.from(atob(operation.update), ch => ch.charCodeAt(0)));
        return Response.json({ ok: true, revision: 2, project });
    }
    throw new Error("Unexpected fixture route: " + url.pathname);
};

try {
    const { initializeCanvasDraftSession } = await import("../src/lib/canvas/canvas-draft-session");
    await initializeCanvasDraftSession();
    const { getCanvasDraftSessionId, getCanvasCollaborationClient } = await import("../src/services/backend-api");
    const { flushCanvasTexts, prepareCanvasTextWith, getCanvasTextSession, reconnectCanvasTexts } = await import("../src/services/api/canvas-text");
    const ownerId = getCanvasDraftSessionId();
    const outbox = localforage.createInstance({ name: "infinite-canvas-text-outbox" });
    const seed = async (nodeId: string) => {
        const doc = new Y.Doc();
        doc.getText("text").insert(0, `${nodeId}未确认草稿`);
        documents.set(nodeId, doc);
        const state = encode(Y.encodeStateAsUpdate(doc));
        const operationId = `${projectId}:${ownerId}:${nodeId}`;
        await outbox.setItem(operationId, { ownerId, backend: location.origin, projectId, target: { nodeId, field: "composerContent" }, source: getCanvasCollaborationClient(), documentId: `document:${nodeId}`, operationId, update: state, state, order: Date.now() });
        return operationId;
    };
    const orphanId = `${projectId}:${ownerId}:${orphanNodeId}`;
    const restored = Boolean(await outbox.getItem(orphanId));
    if (!restored) await seed(orphanNodeId);
    const activeId = await seed("active-config");
    prepareCanvasTextWith(async () => {}, () => project);
    report(restored ? "刷新恢复：复用 IndexedDB 中保留的旧节点草稿" : "首次运行：写入已删除节点和当前节点的未确认草稿");
    await flushCanvasTexts(projectId);
    check(!reads.includes(orphanNodeId), "不向已删除节点发送 GET /text");
    check(sends.includes("active-config"), "当前节点的文本仍正常提交");
    check(Boolean(await outbox.getItem(orphanId)), "已删除节点的原草稿保留在 IndexedDB");
    check(!await outbox.getItem(activeId), "当前节点成功后清理其已确认草稿");

    project.nodes.push({ id: "removed-while-open", metadata: {} });
    documents.set("removed-while-open", new Y.Doc());
    await getCanvasTextSession(projectId, { nodeId: "removed-while-open", field: "composerContent" }).initialize();
    project.nodes = project.nodes.filter(node => node.id !== "removed-while-open");
    const readsBeforeReconnect = reads.filter(id => id === "removed-while-open").length;
    await reconnectCanvasTexts(projectId);
    check(reads.filter(id => id === "removed-while-open").length === readsBeforeReconnect, "节点删除后重连不再读取已失效会话");

    project.nodes.push({ id: "rejected-config", metadata: {} });
    const rejectedId = await seed("rejected-config");
    let rejection = "";
    try { await flushCanvasTexts(projectId); } catch (error) { rejection = String(error); }
    check(rejection.includes("当前提示词未同步"), "当前节点的真实保存失败仍阻止继续");
    check(Boolean(await outbox.getItem(rejectedId)), "当前节点保存失败仍保留草稿");
    await outbox.removeItem(rejectedId);
    report("全部通过；点击刷新按钮验证持久草稿恢复。");
    document.body.dataset.result = "passed";
} catch (error) {
    report("FAIL: " + String(error));
    document.body.dataset.result = "failed";
}
