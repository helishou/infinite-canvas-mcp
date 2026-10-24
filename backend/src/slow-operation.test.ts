import assert from "node:assert/strict";
import test from "node:test";

// 模块在导入时读取阈值，先设短阈值再动态导入，避免测试真等 1 秒。
process.env.INFINITE_CANVAS_SLOW_OPERATION_MS = "120";
const { safeOperationPath, watchHttpOperation } = await import("./slow-operation.js");

type Warning = { message: string; details: Record<string, unknown> };

function recorder() {
    const warnings: Warning[] = [];
    return {
        warnings,
        logger: {
            warn: (message: string, details: Record<string, unknown> = {}) => {
                warnings.push({ message, details });
            },
        },
    };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("SSE 长连接按连接存活时间结束时不报慢请求", async () => {
    const { warnings, logger } = recorder();
    const watch = watchHttpOperation(logger, "GET /events");
    watch.markFirstByte("text/event-stream; charset=utf-8");
    await sleep(260);
    watch.finish("connection-closed", "text/event-stream; charset=utf-8");
    assert.deepEqual(warnings, []);
});

test("流式响应仍记录过慢的首字节", async () => {
    const { warnings, logger } = recorder();
    const watch = watchHttpOperation(logger, "GET /mcp");
    await sleep(160);
    watch.markFirstByte("text/event-stream");
    watch.finish("connection-closed", "text/event-stream");
    const firstByte = warnings.at(-1);
    assert.equal(firstByte?.message, "slow-operation-first-byte");
    assert.ok(Number(firstByte?.details.firstByteMs) >= 120);
    assert.equal(warnings.filter((item) => item.message === "slow-operation-finished").length, 0);
});

test("普通 JSON 请求按总耗时记录，短请求不记录", async () => {
    const slow = recorder();
    const watch = watchHttpOperation(slow.logger, "GET /tasks");
    await sleep(160);
    watch.markFirstByte("application/json; charset=utf-8");
    watch.finish("http-200", "application/json; charset=utf-8");
    assert.equal(slow.warnings.at(-1)?.message, "slow-operation-finished");

    const fast = recorder();
    const quick = watchHttpOperation(fast.logger, "GET /health");
    quick.markFirstByte("application/json");
    quick.finish("http-200", "application/json");
    assert.deepEqual(fast.warnings, []);
});

test("媒体路径归一化到 storageKey，不再按每个媒体文件分桶", () => {
    assert.equal(safeOperationPath("/media/video%3A0eeca708-60b9-4930-9507-2cfb0ce2959d"), "/media/:storageKey");
    assert.equal(safeOperationPath("/runtime/media-file/audio%3Aabc"), "/runtime/media-file/:storageKey");
    assert.equal(safeOperationPath("/drama/episodes/ep1/production/readiness?token=x"), "/drama/episodes/:id/production/readiness");
    assert.equal(safeOperationPath("/mcp"), "/mcp");
});
