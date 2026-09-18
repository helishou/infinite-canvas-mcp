import path from "node:path";
import type {
    Asset, AssetFolder, CanvasFolder, CanvasProject,
    GenerationLog, GenerationLogStatus, MediaFile,
    McpObservabilityEvent, McpObservabilityEventInput,
    RuntimeTask, RuntimeTaskEvent, RuntimeTaskStatus,
} from "../db.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { CanvasCommandContext } from "../canvas/collaboration.js";

/** 各 store 的筛选条件。 */
export type AssetFilter = { kind?: string; folderId?: string; dramaId?: string };
export type LogFilter = { projectId?: string; nodeId?: string; segmentId?: string; runtimeTaskId?: string; platform?: string; model?: string; status?: GenerationLogStatus; from?: string; to?: string; limit?: number; offset?: number };
export type LogDeleteScope = { id?: string; projectId?: string; nodeId?: string };
export type TaskPatch = { status?: RuntimeTaskStatus; progress?: number; result?: Record<string, unknown> | null; error?: string | null };
export type GenerationLogInput = Omit<GenerationLog, "id" | "createdAt" | "updatedAt">;
export type MediaStats = { width?: number | null; height?: number | null; durationMs?: number | null };
export type MediaCategory = "input" | "output" | "library";

/** runtime 媒体（H3 ref 落地等）：按 name 幂等读写。 */
export type RuntimeMedia = {
    name: string;
    path: string;
    size: number;
    bytes?: number;
};

/** 画布项目 store：权威来源为总后台 SQLite。 */
export type H3NodeMaterial = {
    url: string;
    storageKey?: string;
    mimeType?: string;
    width?: number | null;
    height?: number | null;
    name?: string;
    segmentId?: string;
    createdAt: string;
};
export type CanvasProjectFilter = { episodeId?: string; id?: string };
export type CanvasProjectStore = {
    list(): CanvasProject[];
    listSummaries(filter?: CanvasProjectFilter): CanvasProject[];
    get(id: string): CanvasProject | null;
    create(project: CanvasProject): { project: CanvasProject; created: boolean };
    delete(id: string): number;
    applyOperations(id: string, expectedRevision: number | undefined, operations: CanvasOperation[], context?: CanvasCommandContext): { project: CanvasProject; revision: number; operationResults: unknown[]; operations: CanvasOperation[]; duplicated?: boolean };
    /** H3 任务终态与 Clip、生成日志在同一数据库事务中回写。 */
    writeBackH3Task(
        task: RuntimeTask,
        binding: { projectId: string; nodeId: string; segmentId: string; generationLogId?: string },
        output: Record<string, unknown> | null,
    ): { project: CanvasProject; log: GenerationLog | null; operations: CanvasOperation[] } | null;
    writeBackCanvasImageTask(
        task: RuntimeTask,
        input: { projectId: string; nodeId: string; prompt: string; model: string; references?: Array<Record<string, unknown>>; resultPolicy?: "replace-active" | "append"; imageIds?: string[] },
        media: Array<Record<string, unknown>>,
    ): { project: CanvasProject; operations: CanvasOperation[] } | null;
    markCanvasImageTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null;
    writeBackCanvasVideoTask(task: RuntimeTask, input: { projectId: string; nodeId: string; prompt: string; model: string }, media: Record<string, unknown>): { project: CanvasProject; operations: CanvasOperation[] } | null;
    markCanvasVideoTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null;
    writeBackCanvasAudioTask(task: RuntimeTask, input: { projectId: string; nodeId: string; prompt: string; model: string }, media: Record<string, unknown>): { project: CanvasProject; operations: CanvasOperation[] } | null;
    markCanvasAudioTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null;
    /** H3 节点历史运行产物（替代老的 metadata.materials 与 segments[i].results[].params 字段）。 */
    getH3NodeMaterials(projectId: string, nodeId: string, limit?: number, segmentId?: string): H3NodeMaterial[];
};

/** 画布库文件夹 store。 */
export type CanvasFolderStore = {
    list(): CanvasFolder[];
    upsert(folder: CanvasFolder): CanvasFolder;
    delete(id: string): number;
    deleteDrama(id: string): number;
};

/** 资产 store：assets + asset_folders 统一入口。 */
export type AssetStore = {
    list(filter?: AssetFilter): Asset[];
    get(id: string): Asset | null;
    upsert(asset: Asset): Asset;
    replaceAll(assets: Asset[], folders: AssetFolder[]): void;
    delete(id: string): number;
    folders(): AssetFolder[];
    upsertFolder(folder: AssetFolder): AssetFolder;
    deleteFolder(id: string): number;
};

export type NamedMedia = RuntimeMedia & { id: string; mimeType: string; url: string };

/** 媒体 store：media_files 表 + runtime-media/ 文件系统统一入口。 */
export type MediaStore = {
    /** 入库媒体（web 双写 / 生成结果落地），storageKey 由后台生成。 */
    store(data: Buffer, options: { name?: string; mimeType?: string; storageKey?: string; category?: MediaCategory } & MediaStats): MediaFile;
    /** 按 base64 dataUrl 落地（兼容旧 Agent /runtime/media 与 H3 ref），返回带本地路径的完整记录。 */
    storeDataUrl(dataUrl: string, name: string, extra?: MediaStats & { storageKey?: string; category?: MediaCategory }): MediaFile & { path: string; url: string };
    /** 按 name 幂等读写 runtime 媒体（H3 ref 落地），对应旧 Agent 的 storeRuntimeMedia。 */
    storeNamed(name: string, data: Buffer, mimeType?: string): NamedMedia;
    meta(storageKey: string): MediaFile | null;
    list(): MediaFile[];
    read(storageKey: string): Promise<Buffer>;
    /** runtime 媒体按文件名读（对应旧 Agent /runtime/media-file）。 */
    readNamed(name: string): Buffer;
    /** 代理 URL（相对总后台根路径）。 */
    url(m: MediaFile): string;
    delete(storageKey: string): number;
};

/** 任务 store：tasks + task_events。 */
export type TaskStore = {
    /**
     * 创建任务。两种重载：
     *   create(kind, input, params) — 由后端生成 UUID
     *   create(id, kind, input, params) — 客户端预生成 taskId（用于「前端能跨刷新找回任务」）
     */
    create(kindOrId: string, inputOrKind: string | Record<string, unknown>, paramsOrInput: Record<string, unknown>, maybeParams?: Record<string, unknown>): RuntimeTask;
    get(id: string): RuntimeTask | null;
    list(filter?: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number }): RuntimeTask[];
    update(id: string, patch: TaskPatch): RuntimeTask;
    cancel(id: string): RuntimeTask;
    events(id: string, after?: number): RuntimeTaskEvent[];
    /** 追加一条任务事件（bridge 执行过程上报用）。 */
    addEvent(id: string, type: string, payload: Record<string, unknown>): RuntimeTaskEvent;
};

/** 生成日志 store。 */
export type GenerationLogStore = {
    create(input: GenerationLogInput): GenerationLog;
    get(id: string): GenerationLog | null;
    update(id: string, patch: Partial<GenerationLogInput>): GenerationLog;
    list(filter?: LogFilter): GenerationLog[];
    delete(scope: LogDeleteScope): number;
};

/** MCP 调用只保存脱敏摘要，用 traceId 串联工具、画布事务和任务。 */
export type McpObservabilityStore = {
    record(input: McpObservabilityEventInput): McpObservabilityEvent;
    trace(traceId: string): McpObservabilityEvent[];
    report(): Record<string, unknown>;
};

/** 运行时设置 store（runtime_settings 表）。 */
export type SettingStore = {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
};

/** 总后台 store 集合：server 路由和业务模块的统一依赖。 */
export type Stores = {
    projects: CanvasProjectStore;
    canvasFolders: CanvasFolderStore;
    assets: AssetStore;
    media: MediaStore;
    tasks: TaskStore;
    logs: GenerationLogStore;
    mcpObservability: McpObservabilityStore;
    settings: SettingStore;
};

/** 媒体存储 key 前缀推导（image/video/audio/file:uuid）。 */
export function mediaKindForMime(mime: string, fileName = ""): "image" | "video" | "audio" | "file" {
    const name = fileName.toLowerCase();
    if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/.test(name)) return "image";
    if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv)$/.test(name)) return "video";
    if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|opus|flac|aac|m4a)$/.test(name)) return "audio";
    return "file";
}

export function extensionForMime(mime: string, fileName = ""): string {
    const fromName = path.extname(path.basename(fileName)).replace(/[^a-z0-9.]/gi, "").slice(0, 12);
    if (fromName.startsWith(".")) return fromName;
    const table: Array<[RegExp, string]> = [
        [/png/i, ".png"], [/jpe?g/i, ".jpg"], [/webp/i, ".webp"], [/gif/i, ".gif"], [/avif/i, ".avif"],
        [/mp4/i, ".mp4"], [/(webm|mov|m4v|mkv)/i, ".mp4"], [/pdf/i, ".pdf"],
        [/mp3/i, ".mp3"], [/(wav|ogg|opus|flac|aac|m4a)/i, ".mp3"],
    ];
    for (const [pat, ext] of table) if (pat.test(mime)) return ext;
    return ".bin";
}
