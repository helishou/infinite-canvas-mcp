import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = process.env.CANVAS_PLAYWRIGHT_DIR
    ? createRequire(path.join(process.env.CANVAS_PLAYWRIGHT_DIR, "package.json"))("playwright")
    : require("playwright");
const rootConfig = path.join(os.homedir(), ".infinite-canvas-root.json");
const root = fs.existsSync(rootConfig) ? JSON.parse(fs.readFileSync(rootConfig, "utf8")) : {};
const config = JSON.parse(fs.readFileSync(path.join(process.env.INFINITE_CANVAS_DATA_DIR || root.dataDir || path.join(os.homedir(), ".infinite-canvas"), "backend.json"), "utf8"));
const backend = process.env.CANVAS_TEST_BACKEND || "http://127.0.0.1:17370";
const web = process.env.CANVAS_TEST_WEB || "http://localhost:3001";
const projectId = "collaboration-test-" + randomUUID();
const api = async (method, route, body) => {
    const response = await fetch(backend + route, { method, headers: { authorization: "Bearer " + config.token, "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify({ status: response.status, error: result.error }));
    return result;
};
let browser;
let mcp;
let mcpTransport;
let created = false;
const extraProjectIds = [];
let releaseCommandResponse;
const errors = [];
try {
    await api("POST", "/canvas/projects", { id: projectId, title: "自动验收临时画布", revision: 0, nodes: [], connections: [], globalPrompt: "甲乙", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    created = true;
    console.log("Temporary fixture:", projectId);
    browser = await chromium.launch({
        channel: process.env.CANVAS_BROWSER_CHANNEL || "chrome",
        headless: true,
        // 新版 Chromium 即使已 grant local-network-access，自动化上下文仍可能在导航前拦截 loopback。
        // 仅测试进程关闭该检查；生产页面的连接与 CORS 校验不受影响。
        args: ["--disable-features=LocalNetworkAccessChecks"],
    });
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map(async (context) => {
        await context.grantPermissions(["local-network-access"], { origin: web });
        await context.addInitScript(({ token, backend }) => { if (!localStorage.getItem("backend-url")) { localStorage.setItem("backend-token", token); localStorage.setItem("backend-url", backend); } }, { token: config.token, backend });
        await context.route("**/__canvas_text_test__?*", (route) => route.fulfill({ contentType: "text/html", body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await (await import("/src/lib/canvas/canvas-draft-session.ts")).initializeCanvasDraftSession(); await import("/tests/canvas-text-harness.tsx");</script></body></html>' }));
        const page = await context.newPage();
        page.on("pageerror", (error) => { errors.push(error.message); console.error("PAGE ERROR:", error.message); });
        page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER:", message.text().replaceAll(config.token, "[redacted]")); });
        await page.goto(web + "/__canvas_text_test__?projectId=" + projectId);
        await page.locator(".cm-content[contenteditable=true]").waitFor();
        return page;
    }));
    const [a, b] = pages;
    const text = (page) => page.evaluate(() => window.canvasTextTest.session().text.toString());
    const flush = (page) => page.evaluate(() => window.canvasTextTest.session().flush());
    await Promise.all(pages.map((page) => page.locator(".cm-content").press("End")));
    await Promise.all([a.keyboard.insertText("我的"), b.keyboard.insertText("你的")]);
    await Promise.all(pages.map(flush));
    await a.waitForFunction(() => /我的/.test(window.canvasTextTest.session().text.toString()) && /你的/.test(window.canvasTextTest.session().text.toString()));
    await b.waitForFunction(() => /我的/.test(window.canvasTextTest.session().text.toString()) && /你的/.test(window.canvasTextTest.session().text.toString()));
    assert.equal(await text(a), await text(b));
    await a.locator(".cm-content").press("Control+z");
    await flush(a);
    await b.waitForFunction(() => !window.canvasTextTest.session().text.toString().includes("我的"));
    assert.match(await text(b), /你的/);
    console.log("PASS: 两独立窗口中文输入实时合并；本地撤销不撤销远端文字");
    const beforePresenceRevision = (await api("GET", "/canvas/projects/" + projectId)).project.revision;
    await a.locator(".cm-content").press("Home");
    await a.locator(".cm-content").press("Shift+ArrowRight");
    await b.locator(".cm-canvas-peer-caret").waitFor();
    await b.locator(".cm-canvas-peer-selection").waitFor();
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.revision, beforePresenceRevision);
    if (process.env.CANVAS_TEXT_PRESENCE_SCREENSHOT) await b.screenshot({ path: process.env.CANVAS_TEXT_PRESENCE_SCREENSHOT, animations: "disabled" });
    await a.locator(".cm-content").evaluate((element) => element.blur());
    await b.locator(".cm-canvas-peer-caret").waitFor({ state: "detached" });
    console.log("PASS: 真实 WS 显示远端文本光标/选区，失焦后清除，纯光标移动不增加 revision");
    await a.locator(".cm-content").press("End");
    await a.keyboard.insertText("@图片");
    await a.locator(".cm-tooltip-autocomplete li").first().click();
    await flush(a);
    assert.match(await text(a), /图片1/);
    assert.ok(!((await text(a)).includes("@图片")));
    await a.locator(".cm-canvas-reference").waitFor();
    console.log("PASS: @ 引用插入与 chip 显示，序列化保留标签");
    const candidateId = randomUUID();
    const baseText = await text(a);
    const originalDocumentId = await a.evaluate(() => window.canvasTextTest.session().getDocumentId());
    await a.evaluate(async ({ id, documentId, base }) => {
        await window.canvasTextTest.suggestions().save({ id, documentId, base, text: "可恢复的强化结果" });
    }, { id: candidateId, documentId: originalDocumentId, base: baseText });
    await b.evaluate(() => window.canvasTextTest.suggestions());
    await b.waitForFunction((id) => window.canvasTextTest.suggestions().getSnapshot().items.some((item) => item.id === id), candidateId);
    await b.locator(".cm-content").press("End");
    await b.keyboard.insertText("协作者新增");
    await flush(b);
    await assert.rejects(a.evaluate(({ id, documentId, base }) => window.canvasTextTest.suggestions().apply(id, documentId, base), { id: candidateId, documentId: originalDocumentId, base: baseText }), /原文/);
    assert.match(await text(b), /协作者新增/);
    await a.reload();
    await a.locator(".cm-content[contenteditable=true]").waitFor();
    await a.evaluate(() => window.canvasTextTest.suggestions());
    await a.waitForFunction((id) => window.canvasTextTest.suggestions().getSnapshot().items.some((item) => item.id === id && item.status === "pending"), candidateId);
    await a.evaluate((id) => window.canvasTextTest.suggestions().apply(id, window.canvasTextTest.session().getDocumentId(), window.canvasTextTest.session().text.toString()), candidateId);
    await b.waitForFunction(() => window.canvasTextTest.session().text.toString() === "可恢复的强化结果");
    await b.waitForFunction((id) => window.canvasTextTest.suggestions().getSnapshot().items.find((item) => item.id === id)?.status === "applied", candidateId);
    console.log("PASS: 候选跨窗口实时可见、刷新恢复；并发原文变化不覆盖，显式采用同步更新正文与状态");
    const lostReceiptId = randomUUID();
    const opsRoute = "**/canvas/projects/" + projectId + "/ops*";
    await a.route(opsRoute, async (route) => {
        // 后台已提交但浏览器没有收到响应：只阻断测试页，不影响用户页面。
        await route.fetch();
        await route.abort("connectionfailed");
    });
    await assert.rejects(a.evaluate(async (id) => {
        await window.canvasTextTest.suggestions().save({ id, documentId: window.canvasTextTest.session().getDocumentId(), base: window.canvasTextTest.session().text.toString(), text: "丢回执也保留" });
    }, lostReceiptId));
    assert.equal(await a.evaluate(() => window.canvasTextTest.suggestions().getSnapshot().pending), 1);
    await a.unroute(opsRoute);
    await a.reload();
    await a.locator(".cm-content[contenteditable=true]").waitFor();
    await a.evaluate(() => window.canvasTextTest.suggestions().refresh());
    await a.waitForFunction((id) => window.canvasTextTest.suggestions().getSnapshot().pending === 0 && window.canvasTextTest.suggestions().getSnapshot().items.some((item) => item.id === id), lostReceiptId);
    const savedCandidates = await api("GET", "/canvas/projects/" + projectId + "/text-suggestions");
    assert.equal(savedCandidates.suggestions.filter((item) => item.id === lostReceiptId).length, 1);
    await a.evaluate((id) => window.canvasTextTest.suggestions().dismiss(id), lostReceiptId);
    assert.equal(await text(a), "可恢复的强化结果");
    console.log("PASS: 候选保存丢回执后刷新恢复，稳定 ID 去重；忽略候选不改正文");
    const offlineId = randomUUID();
    await a.route(opsRoute, (route) => route.abort("internetdisconnected"));
    await assert.rejects(a.evaluate((id) => window.canvasTextTest.suggestions().save({
        id, documentId: window.canvasTextTest.session().getDocumentId(), base: window.canvasTextTest.session().text.toString(), text: "离线返回结果",
    }), offlineId));
    await a.reload();
    await a.locator(".cm-content[contenteditable=true]").waitFor();
    await a.evaluate(() => window.canvasTextTest.suggestions());
    await a.waitForFunction((id) => window.canvasTextTest.suggestions().getSnapshot().items.some((item) => item.id === id && item.text === "离线返回结果") && Boolean(window.canvasTextTest.suggestions().getSnapshot().error), offlineId);
    assert.equal((await api("GET", "/canvas/projects/" + projectId + "/text-suggestions")).suggestions.some((item) => item.id === offlineId), false);
    await a.unroute(opsRoute);
    await a.evaluate(() => window.canvasTextTest.suggestions().refresh());
    assert.equal((await api("GET", "/canvas/projects/" + projectId + "/text-suggestions")).suggestions.some((item) => item.id === offlineId), true);
    await a.evaluate((id) => window.canvasTextTest.suggestions().dismiss(id), offlineId);
    console.log("PASS: 未到达后台的候选结果在刷新后保留，联网重交原请求恢复到 Backend");
    await api("POST", "/canvas/projects/" + projectId + "/ops", { operationId: randomUUID(), operations: [{ type: "add_node", id: "h3", nodeType: "minimax-h3:video", metadata: { segments: [{ id: "S03", prompt: "三" }, { id: "S04", prompt: "四" }] } }] });
    await a.evaluate(() => window.canvasTextTest.mount({ nodeId: "h3", segmentId: "S03", field: "prompt" }));
    await a.waitForFunction(() => window.canvasTextTest.session().getSnapshot().ready && window.canvasTextTest.session().text.toString() === "三");
    await b.evaluate(() => window.canvasTextTest.mount({ nodeId: "h3", segmentId: "S03", field: "prompt" }));
    await b.waitForFunction(() => window.canvasTextTest.session().getSnapshot().ready && window.canvasTextTest.session().text.toString() === "三");
    await a.locator(".cm-content").press("End");
    await b.locator(".cm-canvas-peer-caret").waitFor();
    await a.keyboard.insertText("改");
    await flush(a);
    await a.evaluate(() => window.canvasTextTest.mount({ nodeId: "h3", segmentId: "S04", field: "prompt" }));
    await a.waitForFunction(() => window.canvasTextTest.session().getSnapshot().ready && window.canvasTextTest.session().text.toString() === "四");
    await b.locator(".cm-canvas-peer-caret").waitFor({ state: "detached" });
    await a.locator(".cm-content").press("Control+z");
    assert.equal(await text(a), "四");
    console.log("PASS: 切 Clip 的文档和撤销栈隔离");
    const beforeLocalViewRevision = (await api("GET", "/canvas/projects/" + projectId)).project.revision;
    await a.evaluate(async ({ projectId }) => {
        const { getPluginNodeView } = await import("/src/stores/canvas/plugin-node-view.ts");
        getPluginNodeView(projectId, "h3").update({ selectedSegmentId: "S03", minimaxTimelineH: 210, playhead: 3 });
    }, { projectId });
    assert.equal(await b.evaluate(async ({ projectId }) => {
        const { getPluginNodeView } = await import("/src/stores/canvas/plugin-node-view.ts");
        return getPluginNodeView(projectId, "h3").getSnapshot().selectedSegmentId;
    }, { projectId }), undefined);
    await b.evaluate(async ({ projectId }) => {
        const { getPluginNodeView } = await import("/src/stores/canvas/plugin-node-view.ts");
        getPluginNodeView(projectId, "h3").update({ selectedSegmentId: "S04", minimaxTimelineH: 330, playhead: 7 });
    }, { projectId });
    const [localViewA, localViewB] = await Promise.all(pages.map((page) => page.evaluate(async ({ projectId }) => {
        const { getPluginNodeView } = await import("/src/stores/canvas/plugin-node-view.ts");
        return getPluginNodeView(projectId, "h3").getSnapshot();
    }, { projectId })));
    assert.deepEqual({ selectedSegmentId: localViewA.selectedSegmentId, minimaxTimelineH: localViewA.minimaxTimelineH, playhead: localViewA.playhead }, { selectedSegmentId: "S03", minimaxTimelineH: 210, playhead: 3 });
    assert.deepEqual({ selectedSegmentId: localViewB.selectedSegmentId, minimaxTimelineH: localViewB.minimaxTimelineH, playhead: localViewB.playhead }, { selectedSegmentId: "S04", minimaxTimelineH: 330, playhead: 7 });
    const afterLocalViewProject = (await api("GET", "/canvas/projects/" + projectId)).project;
    assert.equal(afterLocalViewProject.revision, beforeLocalViewRevision);
    const h3Metadata = afterLocalViewProject.nodes.find((node) => node.id === "h3").metadata;
    for (const key of ["selectedSegmentId", "minimaxTimelineH", "playhead"]) assert.equal(Object.hasOwn(h3Metadata, key), false);
    console.log("PASS: H3 两窗口可独立选择 Clip、时间点和内部布局，本地视图不增加 revision 或写入共享节点");
    await a.goto(web + "/canvas/" + projectId);
    await api("POST", "/canvas/projects/" + projectId + "/ops", { operationId: randomUUID(), operations: [{ type: "add_node", id: "live-text", nodeType: "text", title: "实时验收节点", position: { x: 100, y: 100 }, width: 300, height: 200, metadata: { content: "实时写入验收正文" } }] });
    await a.getByText("实时写入验收正文", { exact: true }).first().waitFor();
    console.log("PASS: 真实画布接收后台新增节点，无需刷新");
    const agentRead = await api("POST", "/agent/api/tools", { name: "canvas_read_text", input: { projectId, target: { nodeId: "live-text", field: "content" } } });
    assert.equal(agentRead.result.text, "实时写入验收正文");
    await api("POST", "/agent/api/tools", { name: "canvas_replace_text", input: { projectId, operationId: randomUUID(), target: { nodeId: "live-text", field: "content" }, documentId: agentRead.result.documentId, expectedText: agentRead.result.text, text: "Agent统一协议回写" } });
    await a.getByText("Agent统一协议回写", { exact: true }).first().waitFor();
    console.log("PASS: Agent 无面板连接也可读取和条件替换，画布实时显示");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
    mcp = new Client({ name: "canvas-collaboration-test", version: "1.0.0" });
    mcpTransport = new StreamableHTTPClientTransport(new URL(backend + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + config.token } } });
    await mcp.connect(mcpTransport);
    const inventory = await mcp.listTools();
    assert.ok(inventory.tools.some((tool) => tool.name === "canvas_replace_text"));
    const readReply = await mcp.callTool({ name: "canvas_read_text", arguments: { projectId, target: { nodeId: "live-text", field: "content" } } });
    assert.equal(readReply.isError, undefined);
    const mcpText = JSON.parse(readReply.content.find((item) => item.type === "text").text);
    const edited = await mcp.callTool({ name: "canvas_edit_text", arguments: { projectId, operationId: randomUUID(), documentId: mcpText.documentId, target: { nodeId: "live-text", field: "content" }, baseState: mcpText.state, edits: [{ index: 0, deleteCount: 0, insert: "MCP增量：" }] } });
    assert.equal(edited.isError, undefined);
    await a.getByText("MCP增量：Agent统一协议回写", { exact: true }).first().waitFor();
    console.log("PASS: 常驻 MCP HTTP 工具清单与增量编辑，画布实时显示");
    for (const name of ["canvas_save_text_suggestion", "canvas_list_text_suggestions", "canvas_resolve_text_suggestion"]) assert.ok(inventory.tools.some((tool) => tool.name === name));
    const candidateTarget = { nodeId: "h3", segmentId: "S03", field: "prompt" };
    const candidateDoc = await api("GET", "/canvas/projects/" + projectId + "/text?" + new URLSearchParams(candidateTarget));
    const h3CandidateId = randomUUID();
    const saved = await mcp.callTool({ name: "canvas_save_text_suggestion", arguments: { projectId, operationId: randomUUID(), suggestion: { id: h3CandidateId, target: candidateTarget, documentId: candidateDoc.documentId, base: candidateDoc.text, text: "MCP提供的持久强化候选" } } });
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    await a.getByText("待确认的强化候选（仅对应此 Clip）", { exact: true }).first().waitFor({ state: "attached" });
    const agentCandidates = await api("POST", "/agent/api/tools", { name: "canvas_list_text_suggestions", input: { projectId, target: candidateTarget } });
    assert.ok(agentCandidates.result.suggestions.some((item) => item.id === h3CandidateId));
    console.log("PASS: MCP 候选实时显示到真实 H3 面板，Agent 可读取同一份持久候选");
    await api("POST", "/canvas/projects/" + projectId + "/ops", { operationId: randomUUID(), operations: [{ type: "add_node", id: "deleted-candidate-target", nodeType: "text", title: "稍后删除的目标", position: { x: 460, y: 100 }, width: 280, height: 160, metadata: { content: "删除前原文" } }] });
    const deletedTarget = { nodeId: "deleted-candidate-target", field: "content" };
    const deletedTargetDoc = await api("GET", "/canvas/projects/" + projectId + "/text?" + new URLSearchParams(deletedTarget));
    const deletedTargetCandidateId = randomUUID();
    const deletedCandidate = await mcp.callTool({ name: "canvas_save_text_suggestion", arguments: { projectId, operationId: randomUUID(), suggestion: { id: deletedTargetCandidateId, target: deletedTarget, documentId: deletedTargetDoc.documentId, base: deletedTargetDoc.text, text: "删后保留的候选" } } });
    assert.equal(deletedCandidate.isError, undefined, JSON.stringify(deletedCandidate));
    await api("POST", "/canvas/projects/" + projectId + "/ops", { operationId: randomUUID(), operations: [{ type: "delete_node", id: "deleted-candidate-target" }] });
    await a.getByRole("button", { name: /改写候选/ }).click();
    const candidateDialog = a.getByRole("dialog").filter({ hasText: "改写候选" });
    const deletedCandidateRow = candidateDialog.locator("section").filter({ hasText: "删后保留的候选" });
    await deletedCandidateRow.getByText("目标已删除 · 待确认", { exact: true }).waitFor();
    assert.equal(await deletedCandidateRow.getByRole("button", { name: "采用", exact: true }).isDisabled(), true);
    await deletedCandidateRow.getByRole("button", { name: "忽略", exact: true }).click();
    await deletedCandidateRow.getByText("目标已删除 · 已忽略", { exact: true }).waitFor();
    await a.keyboard.press("Escape");
    await candidateDialog.waitFor({ state: "hidden" });
    console.log("PASS: 项目级候选管理可查看已删除目标、禁止误采用并显式忽略，不丢失候选记录");
    // 真实画布编辑入口的动作队列，不通过后台直接写代替用户编辑。
    await b.goto(web + "/canvas/" + projectId);
    const editCanvas = async (page, action) => {
        // 应用必须先完成 owner 认领与正常入口加载，不能由测试抢先导入 Store。
        if (action.kind === "init") await page.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
        return page.evaluate(async ({ projectId, action }) => {
        const { useCanvasStore, ensureCanvasProjectLoaded, hydrateCanvasProjects, flushCanvasSyncNow } = await import("/tests/canvas-command-harness.ts");
        if (action.kind === "init") { await hydrateCanvasProjects(); await ensureCanvasProjectLoaded(projectId); return; }
        if (action.kind === "flush") return flushCanvasSyncNow();
        const state = useCanvasStore.getState();
        if (action.kind === "title") state.renameProject(projectId, action.value);
        else {
            const current = state.projects.find((item) => item.id === projectId);
            state.updateProject(projectId, { nodes: current.nodes.map((node) => node.id === "live-text" ? { ...node, ...(action.kind === "node-title" ? { title: action.value } : { metadata: { ...node.metadata, content: action.value } }) } : node) });
        }
        }, { projectId, action });
    };
    await Promise.all(pages.map((page) => editCanvas(page, { kind: "init" })));
    const actionRequests = [];
    let receivedFirst;
    const firstArrived = new Promise((resolve) => { receivedFirst = resolve; });
    const releaseResponse = new Promise((resolve) => { releaseCommandResponse = resolve; });
    await a.route(opsRoute, async (route) => {
        actionRequests.push(route.request().postDataJSON());
        const response = await route.fetch();
        if (actionRequests.length === 1) { receivedFirst(); await releaseResponse; }
        await route.fulfill({ response });
    });
    await editCanvas(a, { kind: "title", value: "动作队列标题" });
    const firstFlush = editCanvas(a, { kind: "flush" });
    let receiptWaitTimer;
    try {
        await Promise.race([firstArrived, new Promise((_, reject) => {
            receiptWaitTimer = setTimeout(() => reject(new Error("动作队列测试未收到首个 ops 请求")), 10_000);
        })]);
    } finally { clearTimeout(receiptWaitTimer); }
    await editCanvas(a, { kind: "node-title", value: "等待回执时新增的动作" });
    await editCanvas(b, { kind: "content", value: "另一窗口的正文" });
    await editCanvas(b, { kind: "flush" });
    releaseCommandResponse();
    await firstFlush;
    await editCanvas(a, { kind: "flush" });
    const actionProject = (await api("GET", "/canvas/projects/" + projectId)).project;
    assert.equal(actionProject.title, "动作队列标题");
    assert.equal(actionProject.nodes.find((node) => node.id === "live-text").title, "等待回执时新增的动作");
    assert.equal(actionProject.nodes.find((node) => node.id === "live-text").metadata.content, "另一窗口的正文");
    assert.equal(actionRequests.length, 2);
    assert.notEqual(actionRequests[0].operationId, actionRequests[1].operationId);
    assert.deepEqual(actionRequests[0].operations, [{ type: "update_project", patch: { title: "动作队列标题" } }]);
    await a.unroute(opsRoute);
    console.log("PASS: 前一动作等待回执时后续动作独立入队，另一窗口编辑的字段不会被旧快照覆盖");
    const retryBodies = [];
    await a.route(opsRoute, async (route) => {
        const request = route.request();
        retryBodies.push(request.postDataJSON());
        const response = await fetch(request.url(), {
            method: request.method(),
            headers: request.headers(),
            body: request.postData() || undefined,
        });
        assert.ok(response.ok, `动作队列丢回执测试的直达请求失败：${response.status}`);
        await route.abort("connectionfailed");
    });
    await editCanvas(a, { kind: "title", value: "丢回执的整图动作" });
    await editCanvas(a, { kind: "flush" });
    await editCanvas(a, { kind: "node-title", value: "刷新后仍保留的后续动作" });
    await editCanvas(a, { kind: "flush" });
    // 先撤销故障注入再刷新，避免旧页面导航取消仍在处理的 route 后，handler 又调用 abort。
    await a.unroute(opsRoute);
    await a.reload();
    await editCanvas(a, { kind: "init" });
    await editCanvas(a, { kind: "flush" });
    const recoveredProject = (await api("GET", "/canvas/projects/" + projectId)).project;
    assert.equal(recoveredProject.title, "丢回执的整图动作");
    assert.equal(recoveredProject.nodes.find((node) => node.id === "live-text").title, "刷新后仍保留的后续动作");
    assert.ok(retryBodies.length >= 2);
    for (const body of retryBodies) assert.deepEqual(body, retryBodies[0]);
    console.log("PASS: 动作队列丢回执后刷新重放原请求，后续动作仍按顺序提交");
    for (const decision of ["keep", "remote"]) {
        const remoteRequests = [];
        await b.route(opsRoute, async (route) => {
            const input = route.request().postDataJSON();
            const response = await route.fetch();
            const output = await response.json();
            remoteRequests.push({ operationId: input.operationId, baseRevision: input.baseRevision, operations: input.operations, status: response.status(), code: output.code, conflictTargets: output.conflictTargets, revision: output.revision });
            await route.fulfill({ response });
        });
        const baselineTitle = (await api("GET", "/canvas/projects/" + projectId)).project.title;
        await Promise.all(pages.map((page) => page.waitForFunction(async ({ id, title }) => {
            const { useCanvasStore } = await import("/tests/canvas-command-harness.ts");
            const state = useCanvasStore.getState();
            return state.projects.find((item) => item.id === id)?.title === title && !state.canvasConflicts[id];
        }, { id: projectId, title: baselineTitle })));
        const requests = [];
        let arrived;
        const ready = new Promise((resolve) => { arrived = resolve; });
        const gate = new Promise((resolve) => { releaseCommandResponse = resolve; });
        await a.route(opsRoute, async (route) => {
            requests.push(route.request().postDataJSON());
            if (requests.length === 1) { arrived(); await gate; }
            await route.fulfill({ response: await route.fetch() });
        });
        await editCanvas(a, { kind: "title", value: decision + "：我的标题" });
        const conflictFlush = editCanvas(a, { kind: "flush" });
        void conflictFlush.catch(() => {});
        await ready;
        const remoteState = await b.evaluate(async (id) => {
            const { useCanvasStore, getCanvasAcknowledgedRevision } = await import("/tests/canvas-command-harness.ts");
            const project = useCanvasStore.getState().projects.find((item) => item.id === id);
            return { title: project?.title, revision: project?.revision, acknowledged: getCanvasAcknowledgedRevision(id), conflicts: useCanvasStore.getState().canvasConflicts[id] };
        }, projectId);
        await editCanvas(b, { kind: "title", value: decision + "：远端标题" });
        await editCanvas(b, { kind: "flush" });
        assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, decision + "：远端标题", JSON.stringify({ remoteRequests, remoteState }));
        releaseCommandResponse();
        await conflictFlush;
        await a.waitForFunction(async (id) => {
            const { useCanvasStore } = await import("/tests/canvas-command-harness.ts");
            return Boolean(useCanvasStore.getState().canvasConflicts[id]);
        }, projectId);
        await a.evaluate(async ({ id, decision }) => {
            const { useCanvasStore } = await import("/tests/canvas-command-harness.ts");
            const state = useCanvasStore.getState();
            if (decision === "keep") await state.keepPendingOpsOnCanvasConflict(id);
            else await state.adoptRemoteOnCanvasConflict(id);
        }, { id: projectId, decision });
        await editCanvas(a, { kind: "flush" });
        const settled = (await api("GET", "/canvas/projects/" + projectId)).project;
        assert.equal(settled.title, decision === "keep" ? "keep：我的标题" : "remote：远端标题");
        if (decision === "keep") {
            assert.equal(requests.length, 2, JSON.stringify(requests.map(({ operationId, operations, baseRevision }) => ({ operationId, operations, baseRevision }))));
            assert.notEqual(requests[0].operationId, requests[1].operationId);
        } else assert.equal(requests.length, 1);
        await a.unroute(opsRoute);
        await b.unroute(opsRoute);
    }
    console.log("PASS: 同字段冲突不覆盖；保留我的生成新命令，采用远端丢弃旧意图而非自动重试");
    const createdProjectId = await a.evaluate(async () => {
        const { useCanvasStore } = await import("/tests/canvas-command-harness.ts");
        return useCanvasStore.getState().createProject("动作队列创建验收");
    });
    extraProjectIds.push(createdProjectId);
    await a.evaluate(async (id) => {
        const { useCanvasStore, flushCanvasSyncNow } = await import("/tests/canvas-command-harness.ts");
        const state = useCanvasStore.getState();
        state.updateProject(id, { nodes: [{ id: "created-once", type: "text", title: "新节点", position: { x: 0, y: 0 }, width: 200, height: 160, metadata: { content: "创建后的动作" } }] });
        state.renameProject(id, "新建与后续动作分别提交");
        await flushCanvasSyncNow();
    }, createdProjectId);
    const newlyCreated = (await api("GET", "/canvas/projects/" + createdProjectId)).project;
    assert.equal(newlyCreated.nodes.length, 1);
    assert.equal(newlyCreated.title, "新建与后续动作分别提交");
    assert.equal(newlyCreated.revision, 2);
    console.log("PASS: 新项目只提交初始种子，紧随其后的新增节点和改名各执行一次");
    // 相同浏览器上下文（共用 IndexedDB），不能让另一窗口抢交未确认文字/候选。
    const c = await contexts[0].newPage();
    await c.goto(web + "/__canvas_text_test__?projectId=" + projectId);
    await c.locator(".cm-content[contenteditable=true]").waitFor();
    const sharedBase = await text(c);
    await c.route(opsRoute, (route) => route.abort("connectionfailed"));
    await c.evaluate(() => window.canvasTextTest.session().text.insert(0, "窗口私有未提交文字"));
    await assert.rejects(flush(c));
    const privateCandidateId = randomUUID();
    await assert.rejects(c.evaluate((id) => window.canvasTextTest.suggestions().save({ id,
        documentId: window.canvasTextTest.session().getDocumentId(), base: window.canvasTextTest.session().text.toString(), text: "本窗口未确认候选",
    }), privateCandidateId));
    const d = await contexts[0].newPage();
    await d.goto(web + "/__canvas_text_test__?projectId=" + projectId);
    await d.locator(".cm-content[contenteditable=true]").waitFor();
    await d.evaluate(() => window.canvasTextTest.suggestions().refresh());
    assert.equal(await text(d), sharedBase);
    assert.equal(await d.evaluate(() => window.canvasTextTest.session().getSnapshot().pending), 0);
    assert.equal(await d.evaluate((id) => window.canvasTextTest.suggestions().getSnapshot().items.some((item) => item.id === id), privateCandidateId), false);
    await c.reload();
    await c.locator(".cm-content[contenteditable=true]").waitFor();
    assert.equal(await text(c), "窗口私有未提交文字" + sharedBase);
    await c.evaluate(() => window.canvasTextTest.suggestions().refresh().catch(() => {}));
    assert.equal(await c.evaluate(() => window.canvasTextTest.suggestions().getSnapshot().pending), 1);
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.globalPrompt, sharedBase);
    await c.unroute(opsRoute);
    await flush(c);
    await c.evaluate(() => window.canvasTextTest.suggestions().refresh());
    await d.waitForFunction(() => window.canvasTextTest.session().text.toString().startsWith("窗口私有未提交文字"));
    console.log("PASS: 同浏览器窗口不抢发别人的文本/候选草稿，原窗口刷新恢复后可正常同步");
    const beforePrivateTitle = (await api("GET", "/canvas/projects/" + projectId)).project.title;
    await a.route(opsRoute, (route) => route.abort("connectionfailed"));
    await editCanvas(a, { kind: "title", value: "只在 A 窗口待提交的标题" });
    await editCanvas(a, { kind: "flush" });
    await d.goto(web + "/canvas/" + projectId);
    await editCanvas(d, { kind: "init" });
    await editCanvas(d, { kind: "flush" });
    const readTitle = (page) => page.evaluate(async (id) => {
        const { useCanvasStore } = await import("/tests/canvas-command-harness.ts");
        return useCanvasStore.getState().projects.find((item) => item.id === id)?.title;
    }, projectId);
    assert.equal(await readTitle(d), beforePrivateTitle);
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, beforePrivateTitle);
    await a.reload();
    await editCanvas(a, { kind: "init" });
    assert.equal(await readTitle(a), "只在 A 窗口待提交的标题");
    await a.unroute(opsRoute);
    await editCanvas(a, { kind: "flush" });
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, "只在 A 窗口待提交的标题");
    await Promise.all([c.close(), d.close()]);
    console.log("PASS: 同浏览器项目缓存与命令归属隔离，另一窗口刷新不导入或覆盖本窗口草稿");
    const recoveryRequests = [];
    await a.route(opsRoute, (route) => { recoveryRequests.push(route.request().postDataJSON()); return route.abort("connectionfailed"); });
    await editCanvas(a, { kind: "title", value: "关闭原窗口后恢复的草稿" });
    await editCanvas(a, { kind: "flush" });
    const originalOwner = await a.evaluate(() => sessionStorage.getItem("canvas-draft-session"));
    const popupReady = a.waitForEvent("popup");
    await a.evaluate((url) => { window.open(url, "_blank"); }, web + "/canvas/" + projectId);
    const copied = await popupReady;
    const recoveredRequests = [];
    copied.on("request", (request) => { if (request.url().includes("/canvas/projects/" + projectId + "/ops") && request.method() === "POST") recoveredRequests.push(request.postDataJSON()); });
    await copied.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
    const copiedOwner = await copied.evaluate(() => sessionStorage.getItem("canvas-draft-session"));
    assert.notEqual(copiedOwner, originalOwner);
    await copied.reload();
    await copied.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
    assert.equal(await copied.evaluate(() => sessionStorage.getItem("canvas-draft-session")), copiedOwner);
    await copied.getByRole("button", { name: "本机草稿", exact: true }).click();
    const oldSessionRow = copied.locator("section").filter({ hasText: "窗口 " + originalOwner.slice(-8) });
    await oldSessionRow.getByText("另一窗口仍在使用，不能抢占。", { exact: true }).waitFor();
    assert.equal(await oldSessionRow.getByRole("button", { name: "恢复会话", exact: true }).isDisabled(), true);
    if (process.env.CANVAS_DRAFT_SCREENSHOT) await copied.screenshot({ path: process.env.CANVAS_DRAFT_SCREENSHOT, animations: "disabled" });
    await assert.rejects(copied.evaluate(async (owner) => {
        const { reopenCanvasDraftSession } = await import("/src/lib/canvas/canvas-draft-session.ts");
        await reopenCanvasDraftSession(owner);
    }, originalOwner), /另一窗口使用/);
    await a.close();
    await copied.getByRole("button", { name: "刷新列表", exact: true }).click();
    await oldSessionRow.getByText("原窗口已关闭，可以恢复整个会话（包括其中的删除意图）。", { exact: true }).waitFor();
    await oldSessionRow.getByRole("button", { name: "恢复会话", exact: true }).click();
    await copied.getByRole("dialog").filter({ hasText: "恢复这份会话草稿？" }).getByRole("button", { name: "恢复会话", exact: true }).click();
    await copied.waitForFunction((owner) => sessionStorage.getItem("canvas-draft-session") === owner, originalOwner);
    await copied.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
    await editCanvas(copied, { kind: "init" });
    await editCanvas(copied, { kind: "flush" });
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, "关闭原窗口后恢复的草稿");
    assert.ok(recoveredRequests.length > 0);
    assert.deepEqual(recoveredRequests[0], recoveryRequests[0]);
    console.log("PASS: 继承 sessionStorage 的窗口分配独立 owner；刷新保持身份；原窗口关闭后通过草稿面板恢复并提交原操作");
    const httpContext = await browser.newContext();
    await httpContext.grantPermissions(["local-network-access"], { origin: web });
    await httpContext.addInitScript(({ token, backend }) => {
        localStorage.setItem("backend-token", token);
        localStorage.setItem("backend-url", backend);
        Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    }, { token: config.token, backend });
    await httpContext.route("**/__canvas_text_test__?*", (route) => route.fulfill({ contentType: "text/html", body: '<html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await (await import("/src/lib/canvas/canvas-draft-session.ts")).initializeCanvasDraftSession(); await import("/tests/canvas-text-harness.tsx");</script></body></html>' }));
    const httpOwnerPage = await httpContext.newPage();
    await httpOwnerPage.goto(web + "/__canvas_text_test__?projectId=" + projectId);
    await httpOwnerPage.locator(".cm-content[contenteditable=true]").waitFor();
    const httpOwner = await httpOwnerPage.evaluate(() => sessionStorage.getItem("canvas-draft-session"));
    const httpPopupReady = httpOwnerPage.waitForEvent("popup");
    await httpOwnerPage.evaluate((url) => window.open(url, "_blank"), web + "/__canvas_text_test__?projectId=" + projectId);
    const httpCopy = await httpPopupReady;
    await httpCopy.locator(".cm-content[contenteditable=true]").waitFor();
    const httpCopyOwner = await httpCopy.evaluate(() => sessionStorage.getItem("canvas-draft-session"));
    assert.notEqual(httpCopyOwner, httpOwner);
    assert.equal((await api("GET", `/canvas/draft-sessions/${encodeURIComponent(httpOwner)}/lease`)).lease.active, true);
    await httpOwnerPage.close();
    await httpCopy.waitForFunction(async ({ backend, token, owner }) => {
        const response = await fetch(`${backend}/canvas/draft-sessions/${encodeURIComponent(owner)}/lease`, { headers: { Authorization: `Bearer ${token}` } });
        return response.ok && !(await response.json()).lease.active;
    }, { backend, token: config.token, owner: httpOwner });
    await httpContext.close();
    console.log("PASS: 普通 HTTP 无 Web Locks 时由 Backend 租约阻止复制窗口抢占，正常关闭立即释放");
    // 仅在独立测试页注入 IndexedDB 写失败；验证真实编辑、文字与候选的共同恢复入口。
    await copied.evaluate(async (projectId) => {
        const harness = await import("/tests/canvas-command-harness.ts");
        const session = harness.getCanvasTextSession(projectId, { field: "globalPrompt" });
        await session.initialize();
        await harness.getCanvasTextSuggestions(projectId, { field: "globalPrompt" }).refresh();
    }, projectId);
    const titleBeforeStorageFailure = (await api("GET", "/canvas/projects/" + projectId)).project.title;
    const storageCandidateId = randomUUID();
    await copied.evaluate(() => {
        window.originalTestPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException("测试：存储空间不足", "QuotaExceededError"); };
    });
    await editCanvas(copied, { kind: "title", value: "存储恢复后才提交的标题" });
    await editCanvas(copied, { kind: "flush" }).catch(() => {});
    await copied.evaluate(async ({ projectId, id }) => {
        const { getCanvasTextSession, getCanvasTextSuggestions } = await import("/tests/canvas-command-harness.ts");
        const session = getCanvasTextSession(projectId, { field: "globalPrompt" });
        session.text.insert(session.text.length, "存储失败期间输入");
        await session.flush().catch(() => {});
        await getCanvasTextSuggestions(projectId, { field: "globalPrompt" }).save({ id, documentId: session.getDocumentId(), base: session.text.toString(), text: "存储失败期间返回的强化结果" }).catch(() => {});
    }, { projectId, id: storageCandidateId });
    const storageAlert = copied.getByRole("alert", { name: "本机草稿保存失败", exact: true });
    await storageAlert.waitFor();
    if (process.env.CANVAS_STORAGE_SCREENSHOT) await copied.screenshot({ path: process.env.CANVAS_STORAGE_SCREENSHOT, animations: "disabled" });
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, titleBeforeStorageFailure);
    const backupDownload = copied.waitForEvent("download");
    await storageAlert.getByRole("button", { name: "导出内存备份", exact: true }).click();
    const backup = JSON.parse(fs.readFileSync(await (await backupDownload).path(), "utf8"));
    assert.equal(backup.format, "canvas-unsaved-memory");
    const unsavedCommand = backup.records.find((item) => item.key.startsWith("command:") && item.record.operations.some((operation) => operation.patch?.title === "存储恢复后才提交的标题"));
    assert.ok(unsavedCommand);
    assert.ok(backup.records.some((item) => item.key.startsWith("text:") && item.record.update));
    assert.ok(backup.records.some((item) => item.record?.suggestion?.id === storageCandidateId && item.record.suggestion.text === "存储失败期间返回的强化结果"));
    await copied.evaluate(() => {
        IDBObjectStore.prototype.put = window.originalTestPut;
        delete window.originalTestPut;
    });
    await storageAlert.getByRole("button", { name: "重试保存", exact: true }).click();
    await storageAlert.waitFor({ state: "hidden" });
    await copied.waitForFunction(async ({ projectId, id }) => {
        const harness = await import("/tests/canvas-command-harness.ts");
        const session = harness.getCanvasTextSession(projectId, { field: "globalPrompt" });
        const suggestions = harness.getCanvasTextSuggestions(projectId, { field: "globalPrompt" }).getSnapshot();
        return session.getSnapshot().pending === 0 && suggestions.pending === 0 && suggestions.items.some((item) => item.id === id && item.revision > 0);
    }, { projectId, id: storageCandidateId });
    await editCanvas(copied, { kind: "flush" });
    const storageRecovered = (await api("GET", "/canvas/projects/" + projectId)).project;
    assert.equal(storageRecovered.title, "存储恢复后才提交的标题");
    assert.equal(storageRecovered.globalPrompt.split("存储失败期间输入").length, 2);
    assert.ok(recoveredRequests.some((request) => request.operationId === unsavedCommand.record.operationId));
    console.log("PASS: IndexedDB 写失败时命令/文本/强化结果可导出，持续提示不伪装成功；解除故障后统一重试，原操作 ID 提交且文本不重复");
    const importedOwner = "browser:import-" + randomUUID();
    const importedOperation = randomUUID();
    const importedCacheKey = JSON.stringify([backend, importedOwner, projectId]);
    const importedCommand = { operationId: importedOperation, projectId, ownerId: importedOwner, backend, order: 1, base: storageRecovered, baseRevision: storageRecovered.revision,
        source: { clientId: importedOwner, kind: "browser", label: "导入测试" }, operations: [{ type: "update_project", patch: { title: "文件导入后显式恢复的标题" } }] };
    const importFile = { format: "canvas-unsaved-memory", version: 1, records: [
        { key: "command:" + importedOperation, record: importedCommand },
        { key: importedCacheKey, record: { backend, ownerId: importedOwner, project: storageRecovered, base: storageRecovered, queueVersion: 2 } },
        { key: "command:acknowledged-cleanup", record: null },
    ] };
    await copied.getByRole("button", { name: "本机草稿", exact: true }).click();
    await copied.getByLabel("选择草稿备份", { exact: true }).setInputFiles({ name: "canvas-memory-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(importFile)) });
    const preview = copied.getByRole("region", { name: "备份导入预览" });
    await preview.getByText("已跳过 1 条清理记录，不会删除本机已有数据。", { exact: true }).waitFor();
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, storageRecovered.title);
    await copied.evaluate((key) => {
        window.originalImportPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.transaction.db.name === "infinite-canvas-project-cache" && args[1] === key) throw new DOMException("测试：导入中断", "QuotaExceededError");
            return window.originalImportPut.apply(this, args);
        };
    }, importedCacheKey);
    await preview.getByRole("button", { name: "确认导入到本机", exact: true }).click();
    const importedRow = copied.locator("section").filter({ hasText: "窗口 " + importedOwner.slice(-8) }).filter({ hasText: "备份尚未完整导入" });
    await importedRow.waitFor();
    assert.equal(await importedRow.getByRole("button", { name: "恢复会话", exact: true }).isDisabled(), true);
    await copied.reload();
    await copied.getByRole("button", { name: "本机草稿", exact: true }).click();
    await importedRow.waitFor();
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, storageRecovered.title);
    await importedRow.getByRole("button", { name: "继续导入", exact: true }).click();
    const completedImportRow = copied.locator("section").filter({ hasText: "窗口 " + importedOwner.slice(-8) });
    await completedImportRow.getByText("原窗口已关闭，可以恢复整个会话（包括其中的删除意图）。", { exact: true }).waitFor();
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, storageRecovered.title);
    if (process.env.CANVAS_IMPORT_SCREENSHOT) await copied.screenshot({ path: process.env.CANVAS_IMPORT_SCREENSHOT, animations: "disabled" });
    await completedImportRow.getByRole("button", { name: "恢复会话", exact: true }).click();
    await copied.getByRole("dialog").filter({ hasText: "恢复这份会话草稿？" }).getByRole("button", { name: "恢复会话", exact: true }).click();
    await copied.waitForFunction((owner) => sessionStorage.getItem("canvas-draft-session") === owner, importedOwner);
    await editCanvas(copied, { kind: "init" });
    await editCanvas(copied, { kind: "flush" });
    assert.equal((await api("GET", "/canvas/projects/" + projectId)).project.title, "文件导入后显式恢复的标题");
    const importedRequest = recoveredRequests.find((request) => request.operationId === importedOperation);
    assert.ok(importedRequest);
    assert.deepEqual(importedRequest.operations, importedCommand.operations);
    assert.equal(importedRequest.baseRevision, importedCommand.baseRevision);
    assert.deepEqual(importedRequest.source, importedCommand.source);
    console.log("PASS: 内存备份文件预览后显式导入；中断刷新保留完整档案且不重放半份，继续导入后恢复原 ID/基线/来源");
    // 连接界面验证只读测试、确认取消、切换窗口隔离；绝不保存真实主机开放设置。
    const networkBefore = await api("GET", "/connection");
    await copied.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).useConfigStore.getState().openConfigDialog(false, "connection"));
    await copied.getByRole("tab", { name: "连接与协作", exact: true }).click();
    const connectionDialog = copied.getByRole("dialog").filter({ has: copied.getByLabel("后台地址", { exact: true }) });
    await connectionDialog.getByLabel("允许局域网连接", { exact: true }).waitFor();
    await connectionDialog.getByLabel("连接密钥", { exact: true }).fill("intentionally-wrong");
    await connectionDialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await connectionDialog.getByRole("alert").filter({ hasText: "连接密钥不正确" }).waitFor();
    await connectionDialog.getByLabel("连接密钥", { exact: true }).fill(config.token);
    await connectionDialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await connectionDialog.getByRole("status").filter({ hasText: "验证通过" }).waitFor();
    if (process.env.CANVAS_CONNECTION_SCREENSHOT) await copied.screenshot({ path: process.env.CANVAS_CONNECTION_SCREENSHOT, animations: "disabled" });
    await connectionDialog.getByRole("button", { name: "保存主机设置", exact: true }).click();
    await copied.getByRole("dialog").filter({ hasText: /保存.*设置？/ }).getByRole("button", { name: /^取\s*消$/ }).click();
    assert.deepEqual(await api("GET", "/connection"), networkBefore);
    const connectionPeer = await copied.context().newPage();
    await connectionPeer.goto(web + "/canvas");
    await connectionPeer.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
    const otherConnectionBefore = await connectionPeer.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).getBackendUrl());
    const alias = new URL(backend); alias.hostname = alias.hostname === "localhost" ? "127.0.0.1" : "localhost";
    await connectionDialog.getByLabel("后台地址", { exact: true }).fill(alias.origin);
    await connectionDialog.getByRole("button", { name: "连接并重新加载", exact: true }).click();
    await copied.getByRole("dialog").filter({ hasText: "切换此窗口的后台？" }).getByRole("button", { name: "验证并连接", exact: true }).click();
    await copied.waitForURL(web + "/canvas");
    await copied.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
    assert.equal(await copied.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).getBackendUrl()), alias.origin);
    assert.equal(await connectionPeer.evaluate(() => localStorage.getItem("backend-url")), alias.origin);
    assert.equal(await connectionPeer.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).getBackendUrl()), otherConnectionBefore);
    await connectionPeer.reload();
    await connectionPeer.getByRole("button", { name: "本机草稿", exact: true }).waitFor();
    assert.equal(await connectionPeer.evaluate(async () => (await import("/tests/canvas-command-harness.ts")).getBackendUrl()), otherConnectionBefore);
    await connectionPeer.close();
    console.log("PASS: 连接设置验证密钥、取消不改监听配置；切换只影响本窗口，另一窗口刷新仍保留原后台");

    const disconnected = await browser.newPage();
    await disconnected.route("**/127.0.0.1:17370/**", (route) => route.abort("connectionfailed"));
    await disconnected.goto(web + "/canvas");
    await disconnected.getByRole("button", { name: "连接设置", exact: true }).click();
    await disconnected.getByLabel("后台地址", { exact: true }).waitFor();
    await disconnected.getByLabel("连接密钥", { exact: true }).waitFor();
    await disconnected.close();
    console.log("PASS: 后台离线、配置尚未加载时仍可进入连接设置，不被加载状态挡住");
    assert.deepEqual(errors, []);
} finally {
    releaseCommandResponse?.();
    await Promise.allSettled([mcpTransport?.terminateSession(), mcp?.close(), browser?.close()]);
    for (const id of extraProjectIds) await api("DELETE", "/canvas/projects/" + id);
    if (created) {
        try { await api("DELETE", "/canvas/projects/" + projectId); }
        catch (error) { console.error("临时画布清理待恢复 Backend 后重试：", projectId); throw error; }
    }
}
