import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { createStores } from "./stores/index.js";

test("MCP 脱敏事件按 trace 保存并生成累计诊断报告", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-mcp-observability-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    const task = stores.tasks.create("task-observed", "canvas-image", { projectId: "canvas-1", nodeId: "node-1" }, { model: "test::image" });
    stores.tasks.update(task.id, { status: "succeeded", progress: 1 });
    const { app } = startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] }, { stores });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (pathname: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${pathname}`, {
        ...init,
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", ...init?.headers },
    });
    const record = (body: Record<string, unknown>) => request("/mcp/observability/events", { method: "POST", body: JSON.stringify(body) });

    try {
        await record({ sessionId: "session-1", traceId: "trace-failed", event: "tool.started", tool: "canvas_get_state", inputSummary: { hasProjectId: false, textLength: 0 } });
        await record({ sessionId: "session-1", traceId: "trace-failed", event: "tool.failed", tool: "canvas_get_state", durationMs: 12, errorCode: "PROJECT_SELECTION_REQUIRED", recoverable: true, suggestedTool: "canvas_inspect" });
        await record({ sessionId: "session-1", traceId: "trace-recovery", event: "tool.started", tool: "canvas_inspect" });
        await record({ sessionId: "session-1", traceId: "trace-recovery", event: "tool.succeeded", tool: "canvas_inspect", durationMs: 7 });
        await record({ sessionId: "session-1", traceId: "trace-generate", event: "tool.started", tool: "canvas_generate_image" });
        await record({ sessionId: "session-1", traceId: "trace-generate", event: "tool.succeeded", tool: "canvas_generate_image", durationMs: 30, taskId: task.id, operationId: "operation-1" });

        const traceResponse = await request("/mcp/observability/traces/trace-failed");
        assert.equal(traceResponse.status, 200);
        const trace = await traceResponse.json() as { events: Array<Record<string, unknown>> };
        assert.deepEqual(trace.events.map((event) => event.event), ["tool.started", "tool.failed"]);
        assert.deepEqual(trace.events[0].inputSummary, { hasProjectId: false, textLength: 0 });

        const reportResponse = await request("/mcp/observability/report");
        assert.equal(reportResponse.status, 200);
        const report = (await reportResponse.json() as { report: Record<string, any> }).report;
        assert.equal(report.calls.completed, 3);
        assert.equal(report.calls.succeeded, 2);
        assert.equal(report.calls.failed, 1);
        assert.equal(report.calls.p95DurationMs, 30);
        assert.deepEqual(report.sessions, { total: 1, averageCalls: 3, maxCalls: 3 });
        assert.equal(report.recovery.suggested, 1);
        assert.equal(report.recovery.followed, 1);
        assert.equal(report.recovery.succeeded, 1);
        assert.equal(report.recovery.followedSuccessRate, 1);
        assert.equal(report.recovery.observation, "same_session_adjacent_terminal_call");
        assert.deepEqual(report.errors, [{ code: "PROJECT_SELECTION_REQUIRED", count: 1 }]);
        assert.deepEqual(report.failuresByTool, [{ tool: "canvas_get_state", code: "PROJECT_SELECTION_REQUIRED", count: 1, latestTraceId: "trace-failed" }]);
        assert.deepEqual(report.taskStatuses, [{ status: "succeeded", count: 1 }]);
        assert.deepEqual(report.taskOutcomesByTool, [{ tool: "canvas_generate_image", status: "succeeded", count: 1 }]);
        assert.deepEqual(report.taskAssociation, { incomplete: false, note: "当前任务统计按创建工具和去重后的 taskId 计算。" });
        assert.deepEqual(report.latency.ordinary, { calls: 3, averageDurationMs: 16, maxDurationMs: 30, p95DurationMs: 30 });
        assert.deepEqual(report.latency.waiting, { calls: 0, averageDurationMs: null, maxDurationMs: null, p95DurationMs: null });
        assert.deepEqual(report.transitions, [
            { fromTool: "canvas_get_state", toTool: "canvas_inspect", count: 1 },
            { fromTool: "canvas_inspect", toTool: "canvas_generate_image", count: 1 },
        ]);
        assert.equal(report.daily.length, 1);
        assert.equal(report.daily[0].calls, 3);
        assert.equal(report.byTool.find((item: { tool: string }) => item.tool === "canvas_generate_image").p95DurationMs, 30);
        assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "LOW_SUCCESS_RATE"));
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("MCP 诊断支持本地日期范围并隔离恢复与调用路径边界", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-mcp-observability-range-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    const setCreatedAt = (id: string, createdAt: string) => database.db.prepare("UPDATE mcp_observability_events SET created_at = ? WHERE id = ?").run(createdAt, id);
    const record = (traceId: string, event: "tool.succeeded" | "tool.failed", tool: string, createdAt: string, extra: Record<string, unknown> = {}) => {
        const saved = database.createMcpObservabilityEvent({ sessionId: "range-session", traceId, event, tool, ...extra });
        setCreatedAt(saved.id, createdAt);
        return saved;
    };
    try {
        record("day1-failed", "tool.failed", "canvas_a", "2026-01-01T10:00:00.000Z", { errorCode: "RANGE_FAIL", recoverable: true, suggestedTool: "canvas_b", outputSummary: { outputChars: 1000 } });
        record("day1-success", "tool.succeeded", "canvas_a", "2026-01-01T10:01:00.000Z", { outputSummary: { outputChars: 2000 } });
        record("day2-recovery", "tool.succeeded", "canvas_b", "2026-01-02T10:00:00.000Z", { outputSummary: { outputChars: 3000 } });
        record("day2-failed", "tool.failed", "canvas_c", "2026-01-02T10:01:00.000Z", { errorCode: "RANGE_FAIL_2", outputSummary: { outputChars: 4000 } });

        const report = database.getMcpObservabilityReport({ from: "2026-01-02", to: "2026-01-02" });
        assert.equal(report.calls.completed, 2);
        assert.equal(report.calls.succeeded, 1);
        assert.equal(report.calls.failed, 1);
        assert.equal(report.daily.length, 1);
        assert.equal(report.daily[0].calls, 2);
        assert.equal(report.daily[0].averageOutputChars, 3500);
        assert.deepEqual(report.dailyByTool.map((item) => item.tool), ["canvas_b", "canvas_c"]);
        assert.deepEqual(report.errors, [{ code: "RANGE_FAIL_2", count: 1 }]);
        assert.equal(report.payload.averageOutputChars, 3500);
        assert.equal(report.recovery.suggested, 0);
        assert.deepEqual(report.transitions, [{ fromTool: "canvas_b", toTool: "canvas_c", count: 1 }]);
        assert.deepEqual(report.filters, { from: "2026-01-02", to: "2026-01-02" });

        const invalid = await startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] }, { stores });
        const server = invalid.app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const port = (server.address() as AddressInfo).port;
        const request = (pathname: string) => fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { Authorization: "Bearer test-token" } });
        const badDate = await request("/mcp/observability/report?from=2026-99-99");
        const reverseRange = await request("/mcp/observability/report?from=2026-01-03&to=2026-01-02");
        assert.equal(badDate.status, 400);
        assert.equal(reverseRange.status, 400);
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("MCP 任务统计按 taskId 去重并保留批量与等待口径", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-mcp-observability-batch-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    const succeededTask = stores.tasks.create("task-succeeded", "canvas-image", { projectId: "canvas-1" }, {});
    const failedTask = stores.tasks.create("task-failed", "canvas-image", { projectId: "canvas-1" }, {});
    const partialBatchTask = stores.tasks.create("task-partial", "canvas-image", { projectId: "canvas-1" }, {});
    stores.tasks.update(succeededTask.id, { status: "succeeded", progress: 1 });
    stores.tasks.update(failedTask.id, { status: "succeeded", progress: 1 });
    stores.tasks.update(partialBatchTask.id, { status: "failed", progress: 1, error: "provider failed" });
    const { app } = startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] }, { stores });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (pathname: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${pathname}`, {
        ...init,
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", ...init?.headers },
    });
    const record = (body: Record<string, unknown>) => request("/mcp/observability/events", { method: "POST", body: JSON.stringify(body) });

    try {
        await record({ sessionId: "session-batch", traceId: "trace-generation", event: "tool.succeeded", tool: "canvas_generate_image", durationMs: 20, taskId: succeededTask.id, outputSummary: { taskCount: 2, createdTaskIds: [succeededTask.id, failedTask.id] } });
        await record({ sessionId: "session-batch", traceId: "trace-status", event: "tool.succeeded", tool: "canvas_task_status", durationMs: 10, outputSummary: { taskCount: 2 } });
        await record({ sessionId: "session-batch", traceId: "trace-wait", event: "tool.succeeded", tool: "canvas_wait_tasks", durationMs: 9000, outputSummary: { waitsForTasks: true } });
        await record({ sessionId: "session-batch", traceId: "trace-partial", event: "tool.failed", tool: "canvas_generate_image_batch", durationMs: 30, taskId: partialBatchTask.id, outputSummary: { taskCount: 1, createdTaskIds: [partialBatchTask.id], errorCode: "BACKEND_HTTP_500" } });

        const reportResponse = await request("/mcp/observability/report");
        const report = (await reportResponse.json() as { report: Record<string, any> }).report;
        assert.deepEqual(report.taskStatuses, [
            { status: "succeeded", count: 2 },
            { status: "failed", count: 1 },
        ]);
        assert.deepEqual(report.taskOutcomesByTool, [
            { tool: "canvas_generate_image", status: "succeeded", count: 2 },
            { tool: "canvas_generate_image_batch", status: "failed", count: 1 },
        ]);
        assert.equal(report.taskAssociation.incomplete, true);
        assert.equal(report.latency.waiting.calls, 1);
        assert.equal(report.latency.waiting.p95DurationMs, 9000);
        assert.equal(report.failuresByTool[0].latestTraceId, "trace-partial");
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("MCP 诊断统计每个工具的输入输出大小并标记超大返回体", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-mcp-observability-payload-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    const { app } = startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] }, { stores });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (pathname: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${pathname}`, {
        ...init,
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", ...init?.headers },
    });
    const record = (body: Record<string, unknown>) => request("/mcp/observability/events", { method: "POST", body: JSON.stringify(body) });

    try {
        // 两次大返回体调用（超过阈值）+ 一次小返回体 + 一次未记录尺寸的旧事件
        await record({ sessionId: "session-payload", traceId: "trace-big-1", event: "tool.succeeded", tool: "canvas_get_state", durationMs: 40, inputSummary: { inputChars: 76 }, outputSummary: { ok: true, outputChars: 2200000 } });
        await record({ sessionId: "session-payload", traceId: "trace-big-2", event: "tool.succeeded", tool: "canvas_get_state", durationMs: 60, inputSummary: { inputChars: 80 }, outputSummary: { ok: true, outputChars: 1800000 } });
        await record({ sessionId: "session-payload", traceId: "trace-small", event: "tool.succeeded", tool: "canvas_inspect", durationMs: 10, inputSummary: { inputChars: 50 }, outputSummary: { ok: true, outputChars: 1000 } });
        await record({ sessionId: "session-payload", traceId: "trace-legacy", event: "tool.succeeded", tool: "canvas_inspect", durationMs: 12, outputSummary: {} });

        const response = await request("/mcp/observability/report");
        const report = (await response.json() as { report: Record<string, any> }).report;

        // 汇总口径
        assert.equal(report.payload.totalOutputChars, 4001000);
        assert.equal(report.payload.maxOutputChars, 2200000);
        assert.equal(report.payload.maxOutputTokens, 550000);
        assert.equal(report.payload.oversizedCalls, 2);
        assert.equal(report.payload.warnThresholdChars, 100000);
        assert.equal(report.payload.outputSizedCalls, 3, "4 次终态调用中 3 次记录了 outputChars");
        assert.equal(report.payload.inputSizedCalls, 3, "3 次记录了 inputChars（legacy 事件两者都缺）");
        assert.equal(report.payload.averageOutputChars, Math.round(4001000 / 3));

        // 分工具口径：均值只对已记录尺寸的调用求平均，不能把缺尺寸的调用算进分母
        const stateMetric = report.byTool.find((item: { tool: string }) => item.tool === "canvas_get_state");
        assert.equal(stateMetric.maxOutputChars, 2200000);
        assert.equal(stateMetric.averageOutputChars, 2000000);
        assert.equal(stateMetric.estimatedOutputTokens, 550000);
        assert.equal(stateMetric.maxInputChars, 80);
        assert.equal(stateMetric.averageInputChars, 78);

        const inspectMetric = report.byTool.find((item: { tool: string }) => item.tool === "canvas_inspect");
        assert.equal(inspectMetric.maxOutputChars, 1000);
        assert.equal(inspectMetric.averageOutputChars, 1000, "2 次调用里只有 1 次带 outputChars，均值应为 1000 而不是 500");
        assert.equal(inspectMetric.sizedCalls, 1, "只有 1 次记录了尺寸");

        // 诊断必须点名超大返回体
        assert.ok(report.diagnostics.some((item: { code: string; tool?: string }) => item.code === "TOOL_PAYLOAD_HOTSPOT" && item.tool === "canvas_get_state"));
        assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "OVERSIZED_PAYLOAD_CALLS"));
        assert.ok(!report.diagnostics.some((item: { code: string; tool?: string }) => item.code === "TOOL_PAYLOAD_HOTSPOT" && item.tool === "canvas_inspect"));
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("MCP 超大返回体阈值包含恰好 100000 字符", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-mcp-observability-threshold-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    try {
        database.createMcpObservabilityEvent({
            sessionId: "session-threshold",
            traceId: "trace-threshold",
            event: "tool.succeeded",
            tool: "canvas_get_state",
            durationMs: 1,
            inputSummary: { inputChars: 10 },
            outputSummary: { outputChars: 100000 },
        });
        const report = database.getMcpObservabilityReport();
        assert.equal(report.payload.oversizedCalls, 1);
        assert.equal(report.payload.outputSizedCalls, 1);
        assert.equal(report.payload.averageOutputChars, 100000);
    } finally {
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("canvas_wait_tasks 的历史事件即使缺少等待标记也不污染普通延迟", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-mcp-observability-wait-legacy-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    const { app } = startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] }, { stores });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (pathname: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${pathname}`, {
        ...init,
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", ...init?.headers },
    });
    const record = (body: Record<string, unknown>) => request("/mcp/observability/events", { method: "POST", body: JSON.stringify(body) });

    try {
        await record({ sessionId: "session-wait-legacy", traceId: "trace-wait-legacy", event: "tool.succeeded", tool: "canvas_wait_tasks", durationMs: 196244, outputSummary: {} });
        for (let index = 0; index < 5; index += 1) {
            await record({ sessionId: "session-wait-legacy", traceId: `trace-normal-${index}`, event: "tool.succeeded", tool: "canvas_inspect", durationMs: 6001, outputSummary: {} });
        }

        const response = await request("/mcp/observability/report");
        const report = (await response.json() as { report: Record<string, any> }).report;
        assert.deepEqual(report.latency.waiting, { calls: 1, averageDurationMs: 196244, maxDurationMs: 196244, p95DurationMs: 196244 });
        assert.deepEqual(report.latency.ordinary, { calls: 5, averageDurationMs: 6001, maxDurationMs: 6001, p95DurationMs: 6001 });
        const waitMetric = report.byTool.find((item: { tool: string }) => item.tool === "canvas_wait_tasks");
        assert.equal(waitMetric.ordinaryP95DurationMs, null);
        assert.ok(!report.diagnostics.some((item: { code: string; tool?: string }) => item.code === "TOOL_LATENCY_HOTSPOT" && item.tool === "canvas_wait_tasks"));
        assert.ok(report.diagnostics.some((item: { code: string; tool?: string }) => item.code === "TOOL_LATENCY_HOTSPOT" && item.tool === "canvas_inspect"));
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
