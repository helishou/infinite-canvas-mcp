import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { ComfyUiBackend, type ComfyUiDeps } from "./bridge.js";

test("LoRA catalog discovers nested local files while ComfyUI is offline and rescans changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-catalog-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ComfyUI offline"); };
    try {
        await mkdir(path.join(root, "input"));
        await writeFile(path.join(root, "main.py"), "");
        await mkdir(path.join(root, "models", "loras", "H3"), { recursive: true });
        const name = "MiniMax-H3-FL2VA-Acc-8Step.safetensors";
        const relative = path.join("H3", name);
        const file = path.join(root, "models", "loras", relative);
        await writeFile(file, "fixture");
        await writeFile(path.join(root, "models", "loras", "preview.png"), "not a model");
        await writeFile(path.join(root, "models", "loras", "unfinished.safetensors.part"), "partial");
        const bridge = new ComfyUiBackend({ settings: { get: (key: string) => key === "comfyui.localRootDir" ? root : "" } } as unknown as ComfyUiDeps, "http://comfy.test");
        assert.deepEqual((await bridge.models()).loras, [relative]);
        await writeFile(path.join(root, "models", "loras", "new.pt"), "fixture");
        assert.deepEqual((await bridge.models()).loras.sort(), [relative, "new.pt"].sort());
        await rm(file);
        assert.deepEqual((await bridge.models()).loras, ["new.pt"]);
    } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
    }
});

test("LoRA catalog merges local files with live external paths without duplicates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-lora-catalog-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const node = String(input).split("/").at(-1)!;
        const required = node === "LoraLoader" ? { lora_name: [["same.safetensors", "external/style.safetensors"]] } : {};
        return new Response(JSON.stringify({ [node]: { input: { required } } }));
    };
    try {
        await mkdir(path.join(root, "input"));
        await writeFile(path.join(root, "main.py"), "");
        await mkdir(path.join(root, "models", "loras"), { recursive: true });
        await writeFile(path.join(root, "models", "loras", "same.safetensors"), "fixture");
        await writeFile(path.join(root, "models", "loras", "local.safetensors"), "fixture");
        const bridge = new ComfyUiBackend({ settings: { get: (key: string) => key === "comfyui.localRootDir" ? root : "" } } as unknown as ComfyUiDeps, "http://comfy.test");
        assert.deepEqual((await bridge.models()).loras, ["external/style.safetensors", "local.safetensors", "same.safetensors"]);
    } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
    }
});
