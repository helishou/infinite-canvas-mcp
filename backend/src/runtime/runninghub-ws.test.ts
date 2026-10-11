import assert from "node:assert/strict";
import test from "node:test";

import { buildWsFileUrls, parseWsExecuted, WS_MIN_FILE_BYTES } from "./runninghub.js";

// netWssUrl 是平台下发的带凭据地址；这里用假值，不含任何真实 userId 或 key。
const AUTH = Buffer.from(JSON.stringify({ userId: "u-123" })).toString("base64");
const NET_WSS = `wss://example.runninghub.ai/ws?clientId=c1&Rh-Comfy-Auth=${encodeURIComponent(AUTH)}`;

test("executed 消息里提取 images/gifs/videos/3d/audio 全部产物字段", () => {
    const { nodeId, files } = parseWsExecuted({
        type: "executed",
        data: {
            node: "42",
            output: {
                images: [{ filename: "a.png", subfolder: "", type: "output" }],
                gifs: [{ filename: "b.gif", subfolder: "", type: "output" }],
                videos: [{ filename: "c.mp4", subfolder: "vid", type: "output" }],
                "3d": [{ filename: "d.glb", subfolder: "", type: "output" }],
            },
        },
    });
    assert.equal(nodeId, "42");
    // 四个字段都要被认出，且保留 subfolder 供拼下载地址用。
    assert.deepEqual(files.map((f) => f.filename).sort(), ["a.png", "b.gif", "c.mp4", "d.glb"]);
    assert.equal(files.find((f) => f.filename === "c.mp4")?.subfolder, "vid");
});

test("内部中间件（音频中转/temp）不作为产物返回", () => {
    const { files } = parseWsExecuted({
        type: "executed",
        data: { node: "9", output: { images: [{ filename: "ComfyUI_0001_.png" }, { filename: "temp_002.wav" }], audio: [{ filename: "preview.m4a" }] } },
    });
    assert.deepEqual(files.map((f) => f.filename), ["ComfyUI_0001_.png"]);
});

test("没有 filename 的条目被忽略，不会造出空产物", () => {
    const { files } = parseWsExecuted({ type: "executed", data: { node: "1", output: { images: [{ subfolder: "", type: "output" }, { filename: "" }] } } });
    assert.equal(files.length, 0);
});

test("拼下载地址：主通道带 Rh-Comfy-Auth，CDN 兜底带 userId", () => {
    const urls = buildWsFileUrls("https://www.runninghub.ai", NET_WSS, { filename: "ComfyUI_1_.png", subfolder: "", type: "output" });
    assert.equal(urls.length, 2);
    assert.ok(urls[0].startsWith("https://www.runninghub.ai/view?"));
    assert.ok(urls[0].includes("Rh-Comfy-Auth="));
    assert.ok(urls[0].includes("filename=ComfyUI_1_.png"));
    assert.equal(urls[1], "https://rh-images.xiaoyaoyou.com/u-123/output/ComfyUI_1_.png");
});

test("有 subfolder 时 CDN 路径带上子目录", () => {
    const urls = buildWsFileUrls("https://www.runninghub.ai", NET_WSS, { filename: "c.mp4", subfolder: "vid", type: "output" });
    assert.equal(urls[1], "https://rh-images.xiaoyaoyou.com/u-123/output/vid/c.mp4");
});

test("netWssUrl 没有凭据时不给下载地址，而不是给出必然 401 的链接", () => {
    assert.deepEqual(buildWsFileUrls("https://www.runninghub.ai", "wss://example/ws?clientId=c1", { filename: "a.png", subfolder: "", type: "output" }), []);
});

test("鉴权错误页的体积下限存在，避免把 HTML 存成图片", () => {
    assert.ok(WS_MIN_FILE_BYTES >= 200);
});