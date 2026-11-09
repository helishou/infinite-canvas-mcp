import assert from "node:assert/strict";
import test from "node:test";

import { uploadMediaRefToComfy } from "./executor.js";

const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("本地落盘命中时直接返回文件名，绝不触发 ComfyUI HTTP 上传（绕开真实视频资产注册崩溃）", async () => {
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    globalThis.fetch = (async () => { httpCalls += 1; throw new Error("不应触发 HTTP 上传"); }) as typeof fetch;
    try {
        const staged: Array<{ filename: string; bytes: number }> = [];
        const name = await uploadMediaRefToComfy(
            pngDataUrl, "视频续写上一段成片", "http://127.0.0.1:8188", AbortSignal.timeout(5000),
            (data, filename) => { staged.push({ filename, bytes: data.length }); return "workflow_staged.png"; },
        );
        assert.equal(name, "workflow_staged.png");
        assert.equal(httpCalls, 0);
        assert.equal(staged.length, 1);
        assert.ok(staged[0].bytes > 0);
        assert.match(staged[0].filename, /\.png$/);
        assert.ok(!/[^\x00-\x7F]/.test(staged[0].filename), "上传文件名应为 ASCII 安全");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("stageLocal 返回 null（远程实例/未就绪）时回退 HTTP /upload/image", async () => {
    const originalFetch = globalThis.fetch;
    let uploadUrl = "";
    globalThis.fetch = (async (url: unknown) => {
        uploadUrl = String(url);
        return new Response(JSON.stringify({ name: "uploaded.png" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const name = await uploadMediaRefToComfy(pngDataUrl, "字段", "http://127.0.0.1:8188", AbortSignal.timeout(5000), () => null);
        assert.equal(name, "uploaded.png");
        assert.match(uploadUrl, /\/upload\/image$/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("无效 dataURL 拒绝并指明媒体标签", async () => {
    await assert.rejects(
        () => uploadMediaRefToComfy("data:not-base64", "上一段成片", "http://127.0.0.1:8188", AbortSignal.timeout(5000), () => null),
        /无效的媒体 dataURL/,
    );
});