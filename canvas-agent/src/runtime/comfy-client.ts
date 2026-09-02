import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BackendClient } from "./backend-client.js";
import type { ComfyModelCatalog, ComfyPreset } from "./comfyui-types.js";
import type { RuntimeTask, RuntimeTaskEvent } from "./types.js";

/** 构造 BackendClient（读 backend.json 或环境变量）。 */
export function createBackendClient(backendUrl: string, env: Record<string, string | undefined> = process.env): BackendClient {
    const token = env.INFINITE_CANVAS_BACKEND_TOKEN
        || (() => {
            try {
                const file = path.join(os.homedir(), ".infinite-canvas", "backend.json");
                return String(JSON.parse(fs.readFileSync(file, "utf8")).token || "");
            } catch { return ""; }
        })();
    return new BackendClient(backendUrl, token);
}

/** ComfyUI 能力客户端：Backend 是唯一实现。 */
export type ComfyUiClient = {
    status(): Promise<Record<string, unknown>>;
    models(signal?: AbortSignal): Promise<ComfyModelCatalog>;
    presets(): ComfyPreset[];
    run(preset: string, input: Record<string, unknown>, params: Record<string, unknown>, baseUrl?: string): Promise<RuntimeTask>;
    cancel(id: string): Promise<RuntimeTask>;
    getUrl(): Promise<string>;
    setUrl(url: string): Promise<string>;
};

/** backend 侧 ComfyUI 客户端（HTTP 到总后台 /comfy/*）。 */
export function backendComfyUi(client: BackendClient, presets: () => ComfyPreset[]): ComfyUiClient {
    return {
        status: () => client.comfyStatus(),
        models: (signal) => client.comfyModels(signal),
        presets,
        run: (preset, input, params, baseUrl) => client.comfyRun(preset, input, params, baseUrl),
        cancel: (id) => client.comfyCancel(id),
        getUrl: async () => (await client.comfyConfig()).url,
        setUrl: async (url) => (await client.comfySetConfig(url)).url,
    };
}

/** 查 ComfyUI 任务：Backend 是唯一权威，不回退到 Agent 本地数据库。 */
export async function resolveComfyTask(backend: BackendClient, id: string, after = 0): Promise<{ task: RuntimeTask; events: RuntimeTaskEvent[] }> {
    const { task, events } = await backend.comfyGetTask(id, after);
    if (!task || !task.kind.startsWith("comfyui:")) throw new Error(`task not found: ${id}`);
    return { task, events };
}
