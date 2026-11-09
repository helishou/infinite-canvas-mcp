import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ComfyUiBackend } from "./bridge.js";

function makeBridge(rootDir: string) {
    const store = new Map<string, string>([["comfyui.localRootDir", rootDir]]);
    const settings = { get: (key: string) => store.get(key) ?? "", set: (key: string, value: string) => { store.set(key, value); } };
    return new ComfyUiBackend({ settings } as never, "http://127.0.0.1:8188");
}

function tempComfyRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-local-input-"));
    fs.writeFileSync(path.join(root, "main.py"), "");
    fs.mkdirSync(path.join(root, "input"));
    return root;
}

test("本地实例：字节平铺落盘 input/，返回 ASCII 安全文件名，内容一致，不打 HTTP", () => {
    const root = tempComfyRoot();
    try {
        const bridge = makeBridge(root);
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        const name = bridge.stageLocalInput(bytes, "workflow_视频续写上一段成片_123.mp4", "http://127.0.0.1:8188");
        assert.ok(name, "本地就绪应返回文件名");
        assert.ok(!/[^\x00-\x7F]/.test(name!), "文件名应 ASCII 安全");
        assert.match(name!, /\.mp4$/);
        const written = fs.readFileSync(path.join(root, "input", name!));
        assert.deepEqual([...written], [1, 2, 3, 4, 5]);
        assert.equal(path.dirname(path.join(root, "input", name!)), path.join(root, "input"), "必须平铺在 input 根目录");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("远程实例（URL 不匹配）返回 null，交由调用方回退 HTTP", () => {
    const root = tempComfyRoot();
    try {
        const bridge = makeBridge(root);
        assert.equal(bridge.stageLocalInput(new Uint8Array([1]), "a.mp4", "http://remote.example:8188"), null);
        assert.equal(fs.readdirSync(path.join(root, "input")).length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("未配置本地根目录（未就绪）返回 null", () => {
    const bridge = makeBridge("");
    assert.equal(bridge.stageLocalInput(new Uint8Array([1]), "a.mp4", "http://127.0.0.1:8188"), null);
});

test("文件名含路径分量时只取 basename，绝不写出 input 目录", () => {
    const root = tempComfyRoot();
    try {
        const bridge = makeBridge(root);
        const name = bridge.stageLocalInput(new Uint8Array([9]), "../../evil.mp4", "http://127.0.0.1:8188");
        assert.ok(name);
        assert.ok(!name!.includes("/") && !name!.includes("\\") && !name!.includes(".."));
        assert.ok(fs.existsSync(path.join(root, "input", name!)));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});