/**
 * 从执行引擎 `comfyui2api/src/events.ts` 落地到画布的类型/纯函数副本。
 * 目的：画布不再 import 引擎 npm 包，双方只通过 HTTP 通信。
 * 同步方式：引擎侧该文件改动时，这里需要手工同步（内容已冻结，不含 I/O）。
 */
/** 引擎事件契约：与宿主 BackendEventBus 结构化兼容，引擎不依赖画布事件实现。 */
export type EngineEventSource = {
    clientId: string;
    kind: "browser" | "mcp" | "agent" | "task" | "system";
    label?: string;
};

export type EngineEvent = {
    id: string;
    type: string;
    entityId?: string;
    revision?: number;
    createdAt: string;
    payload: unknown;
    source?: EngineEventSource;
    operationId?: string;
};

export type EngineEventBus = {
    publish(input: Omit<EngineEvent, "id" | "createdAt">): EngineEvent;
    subscribe(listener: (event: EngineEvent) => void): () => void;
};