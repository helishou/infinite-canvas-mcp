import type { BackendDatabase } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { Stores } from "../stores/types.js";
import { BackendEventBus } from "../events.js";
import type { AgentRuntime } from "@basketikun/canvas-agent/runtime/agent-runtime";

/** Backend 统一运行时依赖；Agent 嵌入层只能消费这些实例，不得自行创建业务存储。 */
export type BackendRuntimeContext = {
    db: BackendDatabase;
    stores: Stores;
    comfy: ComfyUiBackend;
    tasks: Stores["tasks"];
    media: Stores["media"];
    logs: Stores["logs"];
    events: BackendEventBus;
    agent?: AgentRuntime;
};

export function createBackendRuntimeContext(input: Omit<BackendRuntimeContext, "tasks" | "media" | "logs" | "events"> & { events?: BackendEventBus }): BackendRuntimeContext {
    return {
        ...input,
        tasks: input.stores.tasks,
        media: input.stores.media,
        logs: input.stores.logs,
        events: input.events ?? new BackendEventBus(),
    };
}
