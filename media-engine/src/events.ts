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