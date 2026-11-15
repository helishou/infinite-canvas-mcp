import type { Readable } from "node:stream";
import type { WorkflowDurationTarget } from "./workflows/duration.js";

// ── 任务契约 ──────────────────────────────────────────────────────────────────

export type RuntimeTaskStatus = "queued" | "running" | "awaiting_confirmation" | "succeeded" | "failed" | "cancelled";

export type RuntimeTask = {
    id: string; kind: string; status: RuntimeTaskStatus; progress: number;
    input: Record<string, unknown>; params: Record<string, unknown>;
    result: Record<string, unknown> | null; error: string | null;
    createdAt: string; updatedAt: string;
    parentTaskId?: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    executor?: string;
    model?: string;
    outputs: Array<Record<string, unknown>>;
};

export type RuntimeTaskEvent = {
    id: number; taskId: string; type: string;
    payload: Record<string, unknown>; createdAt: string;
};

export type TaskPatch = { status?: RuntimeTaskStatus; progress?: number; result?: Record<string, unknown> | null; error?: string | null; executor?: string };

/** 任务 store：tasks + task_events。引擎只依赖该接口，权威实现由宿主注入。 */
export type TaskStore = {
    /**
     * 创建任务。两种重载：
     *   create(kind, input, params) — 由后端生成 UUID
     *   create(id, kind, input, params) — 客户端预生成 taskId（用于「前端能跨刷新找回任务」）
     */
    create(kindOrId: string, inputOrKind: string | Record<string, unknown>, paramsOrInput: Record<string, unknown>, maybeParams?: Record<string, unknown>): RuntimeTask;
    get(id: string): RuntimeTask | null;
    /** 查询已清理任务 ID 的凭据；不存在返回 null。入口在副作用前调用。 */
    getTombstone(id: string): { taskId: string; terminalStatus: string; prunedAt: string } | null;
    list(filter?: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; parentThreadId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number }): RuntimeTask[];
    modelUsage(): Array<{ model: string; channelId: string; count: number }>;
    /** 摘要列表：同一过滤条件，但只回传卡片渲染所需的标量 + 输出媒体引用（裁掉多 MB 提示词大列）。返回结构与 RuntimeTask 兼容。 */
    listSummaries(filter?: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; parentThreadId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number }): RuntimeTask[];
    update(id: string, patch: TaskPatch): RuntimeTask;
    transitionH3(id: string, expectedStatus: RuntimeTaskStatus, expectedRevision: number, patch: TaskPatch & { status: RuntimeTaskStatus; result: Record<string, unknown> }, event: { type: string; payload: Record<string, unknown> }): RuntimeTask | null;
    cancel(id: string): RuntimeTask;
    events(id: string, after?: number): RuntimeTaskEvent[];
    /** 追加一条任务事件（bridge 执行过程上报用）。 */
    addEvent(id: string, type: string, payload: Record<string, unknown>): RuntimeTaskEvent;
};

// ── 媒体契约 ──────────────────────────────────────────────────────────────────

export type MediaFile = {
    storageKey: string; filePath: string; mimeType: string;
    bytes: number; width: number | null; height: number | null; durationMs: number | null;
    createdAt: string; sha256?: string | null;
};

export type MediaStats = { width?: number | null; height?: number | null; durationMs?: number | null };
export type MediaCategory = "input" | "output" | "library";

/** runtime 媒体（H3 ref 落地等）：按 name 幂等读写。 */
export type RuntimeMedia = {
    name: string;
    path: string;
    size: number;
    bytes?: number;
};

export type NamedMedia = RuntimeMedia & { id: string; mimeType: string; url: string };

/** 画布/引擎共用的媒体引用契约（原 canvas/image-dispatcher 定义，权威归引擎）。 */
export type CanvasImageReference = {
    id?: string;
    name?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    sha256?: string;
};

/** 媒体 store：media_files 表 + runtime-media/ 文件系统统一入口。 */
export type MediaStore = {
    /** 入库媒体（web 双写 / 生成结果落地），storageKey 由后台生成。 */
    store(data: Buffer, options: { name?: string; mimeType?: string; storageKey?: string; category?: MediaCategory } & MediaStats): MediaFile;
    /** 流式归档媒体，避免视频下载与落盘期间同时保留整文件 Buffer。 */
    storeStream(source: Readable, options: { name?: string; mimeType?: string; storageKey?: string; category?: MediaCategory; resolveMimeType?: (prefix: Buffer, bytes: number) => string } & MediaStats): Promise<MediaFile & { sha256: string; prefix: Buffer }>;
    /** 按 base64 dataUrl 落地（兼容旧 Agent /runtime/media 与 H3 ref），返回带本地路径的完整记录。 */
    storeDataUrl(dataUrl: string, name: string, extra?: MediaStats & { storageKey?: string; category?: MediaCategory }): MediaFile & { path: string; url: string };
    /** 按 name 幂等读写 runtime 媒体（H3 ref 落地），对应旧 Agent 的 storeRuntimeMedia。 */
    storeNamed(name: string, data: Buffer, mimeType?: string): NamedMedia;
    meta(storageKey: string): MediaFile | null;
    list(): MediaFile[];
    read(storageKey: string): Promise<Buffer>;
    /** runtime 媒体按文件名读（对应旧 Agent /runtime/media-file）。 */
    readNamed(name: string): Buffer;
    /** 代理 URL（相对宿主服务根路径）。 */
    url(m: MediaFile): string;
    delete(storageKey: string): number;
};

// ── 生成日志契约 ──────────────────────────────────────────────────────────────

export type GenerationLogStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type GenerationLog = {
    id: string; projectId: string; nodeId?: string; segmentId?: string;
    status: GenerationLogStatus; platform: string;
    workflow?: string; model?: string; taskMode?: string; prompt?: string;
    references: Array<Record<string, unknown>>; inputCounts: Record<string, number>;
    runtimeTaskId?: string; promptId?: string;
    startedAt: string; finishedAt?: string; durationMs: number;
    outputs: Array<Record<string, unknown>>; error?: string;
    params: Record<string, unknown>; createdAt: string; updatedAt: string;
};

export type GenerationLogInput = Omit<GenerationLog, "id" | "createdAt" | "updatedAt">;
export type GenerationLogFilter = { projectId?: string; nodeId?: string; segmentId?: string; runtimeTaskId?: string; platform?: string; model?: string; status?: GenerationLogStatus; from?: string; to?: string; limit?: number; offset?: number };

// ── 工作流契约 ────────────────────────────────────────────────────────────────

export type WorkflowFieldType = 'text' | 'number' | 'slider' | 'boolean' | 'dropdown' | 'image' | 'audio' | 'video';

export type WorkflowField = {
    id: string;
    node: string;
    input: string;
    name: string;
    type: WorkflowFieldType;
    required?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    randomEnabled?: boolean;
    isPrompt?: boolean;
    /**
     * 可选媒体字段：值为空时直接把加载器节点从提交图里剪掉（连同悬空连线），
     * 让下游的“可选输入”分支退回原始行为。用于视频续写这类“有就用、没有就当首段”的加载器。
     */
    optionalWhenEmpty?: boolean;
};

export type WorkflowRunTarget = "local" | "cloud" | "hybrid";

export type WorkflowConfig = {
    title: string;
    backend: string;
    operation: string;
    description: string;
    fields: WorkflowField[];
    /** 指定输出节点：只保留这些节点的产物；留空表示不过滤。 */
    outputNodes?: string[];
    /**
     * 预览桥节点（单值）：该节点发出的预览帧会推送到画布节点的生成态画面。
     * 只影响展示，不参与产物筛选、归档与生成日志。留空表示不采集预览。
     */
    previewNodeId?: string;
    /**
     * 时长输入节点（单值）：画布视频生成时，把制作台的秒数换算后写入这个节点输入。
     * 与提示词 isPrompt 的自动注入同构，不要求该输入同时是一个可填字段。
     * 未配置 / null 表示不注入，旧工作流行为不变。仅本地 ComfyUI 链生效。
     */
    durationTarget?: WorkflowDurationTarget | null;
    mediaInputs?: Record<string, unknown>;
    miniCards?: Record<string, unknown>;
    /** 绑定的 RunningHub 云端档案 id（本地工作流 ↔ 云端工作流）。留空表示没绑定。 */
    runningHubProfileId?: string;
    /** 运行位置：本地 ComfyUI / 云端 RunningHub / 两者自动（本地并发占满时上云）。 */
    runTarget?: WorkflowRunTarget;
};

export type WorkflowConfigRow = {
    name: string; title: string; backend: string; description: string; operation: string;
    fieldsJson: string; mediaInputsJson: string; miniCardsJson: string; updatedAt: string;
    runningHubProfileId: string; runTarget: string;
    /** 输出节点选择的原始 JSON；空串表示从未配置过（此时前端会默认勾选链路末端的输出节点）。 */
    outputNodesJson: string;
    /** 预览桥节点 id；空串表示未选择。 */
    previewNodeId: string;
    /** 时长输入目标的原始 JSON；空串表示未配置（含显式清空）。 */
    durationTargetJson: string;
};

export type WorkflowConfigPatch = {
    title?: string; backend?: string; description?: string; operation?: string;
    fieldsJson?: string; mediaInputsJson?: string; miniCardsJson?: string;
    runningHubProfileId?: string; runTarget?: string; outputNodesJson?: string; previewNodeId?: string;
    durationTargetJson?: string;
};

/**
 * 引擎需要的最小持久化接口：工作流配置 + 生成日志。
 * 画布宿主由 BackendDatabase 结构化满足；独立服务用自己的 SQLite 实现。
 */
export type EnginePersistence = {
    getWorkflowConfig(name: string): WorkflowConfigRow | null;
    upsertWorkflowConfig(name: string, config: WorkflowConfigPatch): void;
    deleteWorkflowConfig(name: string): number;
    listWorkflowNamesByRunningHubProfile(profileId: string): string[];
    getWorkflowFieldDefinitionsByIds(ids: string[]): Array<{ workflowName: string; field: WorkflowField }>;
    createGenerationLog(input: GenerationLogInput): GenerationLog;
    updateGenerationLog(id: string, patch: Partial<Omit<GenerationLog, "id" | "projectId" | "createdAt">>): GenerationLog;
    listGenerationLogs(options?: GenerationLogFilter): GenerationLog[];
};

// ── 设置契约 ──────────────────────────────────────────────────────────────────

/** 运行时设置 store（runtime_settings 表）。 */
export type SettingStore = {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
};