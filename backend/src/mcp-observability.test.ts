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
