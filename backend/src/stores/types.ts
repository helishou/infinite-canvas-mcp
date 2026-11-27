import path from "node:path";
import type {
    Asset, AssetFolder, CanvasFolder, CanvasProject,
    GenerationLog,
    McpObservabilityEvent, McpObservabilityEventInput,
    RuntimeTask,
} from "../db.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { CanvasCommandContext } from "../canvas/collaboration.js";
import type { TaskStore, MediaStore, SettingStore, TaskPatch, MediaStats, MediaCategory, RuntimeMedia, NamedMedia, GenerationLogInput, GenerationLogFilter } from "../engine-contract/contracts.js";

// 任务 / 媒体 / 设置 store 契约由画布自带类型定义；此处 re-export 保持既有入口。
export type { TaskStore, MediaStore, SettingStore, TaskPatch, MediaStats, MediaCategory, RuntimeMedia, NamedMedia, GenerationLogInput };
export type LogFilter = GenerationLogFilter;

/** 各 store 的筛选条件。 */
export type AssetFilter = { kind?: string; folderId?: string; dramaId?: string };
export type LogDeleteScope = { id?: string; projectId?: string; nodeId?: string };

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
export type H3ProductionRequirements = { ownerId: string; revision: number; version: number; videoAspectRatio?: string; clips: Array<{ nodeId: string; segmentId: string; targetId?: string; numbering?: import("@basketikun/canvas-agent/drama/production-contract").ProductionNumbering["clips"][number]; storyboardRequired: boolean; promptContentHash?: string; sourceHash?: string; literalDialogues?: Array<{ blockId: string; speaker: string; text: string }>; shots: Array<{ id: string; duration: number }> }> };
export type CanvasProjectStore = {
    getH3ProductionRequirements?(projectId: string): H3ProductionRequirements | null;
    /** Current draft requirements; used as the diagnosis baseline before a version is published. */
    getH3DraftRequirements?(projectId: string): H3ProductionRequirements | null;
    /**
     * 制作稿 `shot.keyframes` → 画布分镜格的派生轨（segmentId → track）。
     * 读取时现算，画布上存的那份不作为权威。
     */
    getStoryboardTracks?(projectId: string): Record<string, import("../drama/storyboard-track.js").StoryboardTrack> | undefined;
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
        completion?: { cacheFingerprint?: string; firstPassReady?: boolean },
    ): { project: CanvasProject; log: GenerationLog | null; operations: CanvasOperation[] } | null;
    writeBackCanvasImageTask(
        task: RuntimeTask,
        input: { projectId: string; nodeId: string; prompt: string; model: string; references?: Array<Record<string, unknown>>; resultPolicy?: "replace-active" | "append"; imageIds?: string[] },
        media: Array<Record<string, unknown>>,
    ): { project: CanvasProject; operations: CanvasOperation[] } | null;
    /** 生成结果落到正式制作实体节点后，把媒体写回制作台资产卡与实体节点权威图。 */
    syncProductionAssetImageWriteBack(
        input: { projectId: string; nodeId: string; storageKey: string; taskId?: string },
    ): { ok: true; scope: "episode" | "shared"; assetId: string; storageKey: string } | { ok: false; reason: string };
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

/** 生成日志 store。 */
export type GenerationLogStore = {
    create(input: GenerationLogInput): GenerationLog;
    get(id: string): GenerationLog | null;
    update(id: string, patch: Partial<GenerationLogInput>): GenerationLog;
    list(filter?: LogFilter): GenerationLog[];
    delete(scope: LogDeleteScope): number;
};

/** MCP 调用只保存脱敏摘要，用 traceId 串联工具、画布事务和任务。 */
export type McpObservabilityReportOptions = {
    /** `from`/`to` 是本地日历日（YYYY-MM-DD），包含边界当天。 */
    from?: string;
    to?: string;
    tool?: string;
    view?: "summary" | "full";
};

export type McpObservabilityStore = {
    record(input: McpObservabilityEventInput): McpObservabilityEvent;
    trace(traceId: string): McpObservabilityEvent[];
    report(options?: McpObservabilityReportOptions): Record<string, unknown>;
    optimizationMarkers(): unknown[];
    saveOptimizationMarker(input: unknown): unknown;
    deleteOptimizationMarker(id: string): boolean;
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