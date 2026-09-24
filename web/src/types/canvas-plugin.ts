import type { ComponentType, ReactNode } from "react";

import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasResourceKind } from "@/lib/canvas/canvas-resource-references";
import type { CanvasGenerationCommand, CanvasGenerationTask } from "@basketikun/canvas-agent/generation-contract";

export type { CanvasGenerationCommand, CanvasGenerationTask } from "@basketikun/canvas-agent/generation-contract";

// Resource emitted when a plugin node is consumed as an upstream input.
export type CanvasNodeResource = { kind: CanvasResourceKind; text?: string; url?: string; storageKey?: string };

// AI generation capabilities injected by the host, reusing its model and credential configuration.
export type GenerateOptions = { signal?: AbortSignal; references?: string[]; model?: string };
export type GenerateImageOptions = GenerateOptions & { count?: number; size?: string };
export type GenerateImageResult = { images: string[] };
export type GenerateVideoOptions = GenerateOptions & { size?: string; seconds?: string };
export type GenerateVideoResult = { url: string; mimeType: string; width?: number; height?: number; durationMs?: number };
// 插件文本调用的日志归属元数据：传入后宿主把本次调用登记进生成日志，并把节点/Clip 写进运行任务。
export type GenerateTextLogMeta = { taskMode: string; prompt?: string; nodeId?: string; segmentId?: string; references?: Array<Record<string, unknown>> };
export type GenerateTextOptions = { signal?: AbortSignal; model?: string; system?: string; references?: Array<{ url: string; name?: string }>; onDelta?: (text: string) => void; log?: GenerateTextLogMeta };
export type GenerateTextResult = { text: string; taskId?: string };
export type LocalH3ActualSubmission = { promptId: string; seed?: number; seedMode?: "random" | "fixed"; frames?: number; width?: number; height?: number; steps?: number; sampler?: string; scheduler?: string; teAccel?: boolean; loras?: Array<{ name: string; strength: number }>; attention?: string; sigma?: string; mediaInputs?: { images: string[]; videos: string[]; audios: string[] } };
export type LocalH3Result = { url: string; mimeType: string; taskId?: string; width?: number; height?: number; durationMs?: number; actualSubmission?: LocalH3ActualSubmission; segments?: Array<{ media?: Array<{ url: string; mimeType: string }> }> };
export type LocalH3Options = { signal?: AbortSignal; onTaskId?: (taskId: string) => void };
export type LocalH3Preview = { dataUrl: string; mime?: string; promptId?: string; step?: number; total?: number };
export type LocalH3Task = { id: string; status: "queued" | "running" | "awaiting_confirmation" | "succeeded" | "failed" | "cancelled"; progress: number; result?: (LocalH3Result & { currentChildTaskId?: string; currentChildKind?: string; confirmation?: { pending: Array<{ nodeId: string; segmentId: string; firstPassFingerprint: string; firstPassResult: string }> } }) | null; preview?: LocalH3Preview | null; error?: string | null };
export type LocalVideoConcatResult = { url: string; storageKey?: string; mimeType: string; taskId?: string };
export type PluginModelCapability = "image" | "video" | "text" | "audio";
export type ModelOption = { value: string; label: string };
export type CanvasGenerationLogStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type CanvasGenerationLog = {
    id: string; projectId: string; nodeId?: string; segmentId?: string; status: CanvasGenerationLogStatus;
    platform: string; workflow?: string; model?: string; taskMode?: string; prompt?: string;
    references: Array<Record<string, unknown>>; inputCounts: Record<string, number>; runtimeTaskId?: string; promptId?: string;
    startedAt: string; finishedAt?: string; durationMs: number; outputs: Array<Record<string, unknown>>;
    error?: string; params: Record<string, unknown>; createdAt: string; updatedAt: string;
};
export type CanvasGenerationLogInput = Omit<CanvasGenerationLog, "id" | "createdAt" | "updatedAt">;
export type CanvasGenerationLogs = {
    list: (options?: { projectId?: string; nodeId?: string; status?: CanvasGenerationLogStatus; limit?: number }) => Promise<CanvasGenerationLog[]>;
    create: (input: CanvasGenerationLogInput) => Promise<CanvasGenerationLog>;
    update: (id: string, patch: Partial<CanvasGenerationLogInput>) => Promise<CanvasGenerationLog>;
    remove: (options: { id?: string; projectId?: string; nodeId?: string }) => Promise<number>;
};

export type CanvasPluginAi = {
    generateImage: (prompt: string, options?: GenerateImageOptions) => Promise<GenerateImageResult>;
    generateVideo: (prompt: string, options?: GenerateVideoOptions) => Promise<GenerateVideoResult>;
    generateText: (prompt: string, options?: GenerateTextOptions) => Promise<GenerateTextResult>;
    runCanvasGeneration: (command: CanvasGenerationCommand) => Promise<CanvasGenerationTask>;
    resolveH3Confirmation: (input: { taskId: string; action: "confirm" | "keep_first_pass" | "discard"; segmentIds: string[]; firstPassFingerprint: string; retry?: boolean }) => Promise<LocalH3Task>;
    getLocalH3Task: (taskId: string) => Promise<LocalH3Task>;
    getCanvasH3Task: (taskId: string) => Promise<LocalH3Task>;
    cancelCanvasH3Task: (taskId: string) => Promise<LocalH3Task>;
    runVideoConcat: (videos: Array<{ name: string; url?: string; storageKey?: string }>, options?: LocalH3Options) => Promise<LocalVideoConcatResult>;
    listLocalH3Models: () => Promise<{ models: string[]; loras: string[]; textEncoders?: string[]; videoVaes?: string[]; audioVaes?: string[]; latentUpscaleModels?: string[] }>;
    getRunningHubH3Task: (taskId: string) => Promise<LocalH3Task>;
    listModels: (capability?: PluginModelCapability) => ModelOption[];
    defaultModel: (capability: PluginModelCapability) => string;
};
export type CanvasH3Defaults = {
    get: () => Promise<Record<string, unknown>>;
    set: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
    reset: () => Promise<void>;
};

// Node-specific buttons appended to the hover toolbar.
export type CanvasNodeToolbarItem = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

export type CanvasAssetPickerImage = { kind: "image"; dataUrl: string; title: string; storageKey?: string };
export type CanvasReferenceAsset = { id: string; label: string; mediaType: "image" | "video" | "audio"; role: string; tags: string[]; url?: string; storageKey?: string; mimeType?: string; sourceNodeId?: string; subjectId?: string; analysis?: Record<string, unknown> };
export type CanvasReferenceValidation = { semanticPrompt: string; compiledPrompt: string; bindings: Array<Record<string, unknown>>; references: Array<Record<string, unknown>>; issues: Array<{ severity: "error" | "warning"; code: string; message: string; bindingId?: string }>; migratedLegacyRefs: boolean };
export type CanvasReferenceService = {
    list: () => Promise<CanvasReferenceAsset[]>;
    upsert: (asset: Partial<CanvasReferenceAsset> & { label: string }) => Promise<CanvasReferenceAsset>;
    upsertMany: (assets: Array<Partial<CanvasReferenceAsset> & { label: string }>) => Promise<CanvasReferenceAsset[]>;
    remove: (assetId: string) => Promise<void>;
    validate: (nodeId: string, segmentId: string) => Promise<CanvasReferenceValidation>;
};

// Context injected while rendering each node; the primary interface between plugins and the canvas.
export type CanvasTextTarget = { nodeId?: string; segmentId?: string; textItemId?: string; field: "prompt" | "content" | "composerContent" | "globalPrompt" };
export type CanvasTextSnapshot = { ready: boolean; pending: number; blocked: boolean; error: string; text: string };
export type CanvasTextSuggestionInput = { id: string; target: CanvasTextTarget; documentId: string; base: string; text: string };
export type CanvasTextSuggestion = CanvasTextSuggestionInput & { status: "pending" | "applied" | "dismissed"; revision: number };
export type CanvasTextSuggestions = {
    getSnapshot: () => { items: CanvasTextSuggestion[]; pending: number; error: string };
    subscribe: (listener: () => void) => () => void;
    refresh: (retryRejected?: boolean) => Promise<void>;
    save: (input: Omit<CanvasTextSuggestionInput, "target">) => Promise<void>;
    apply: (id: string, documentId: string, expectedText: string) => Promise<void>;
    dismiss: (id: string) => Promise<void>;
};
export type CanvasTextDocument = {
    getSnapshot: () => CanvasTextSnapshot;
    subscribe: (listener: () => void) => () => void;
    getDocumentId: () => string;
    flush: () => Promise<void>;
};
export type CanvasTextEditorHandle = {
    insert: (text: string, options?: { prefixNewline?: boolean; select?: boolean }) => void;
    replace: (text: string) => void;
    focus: () => void;
};
export type CanvasTextReference = { label: string; displayLabel?: string; title?: string; insert?: string; tokens?: string[]; previewUrl?: string; active?: boolean; suggestible?: boolean; kind?: string };
export type CanvasSpeakerOption = { id: string; name?: string; previewUrl?: string };
export type CanvasTextEditorProps = {
    projectId: string; target: CanvasTextTarget; placeholder?: string;
    references?: CanvasTextReference[]; chips?: boolean;
    /** 台词说话人名册：菜单/徽标按此显示角色名与头像；省略时回退 S1–S6。 */
    speakers?: CanvasSpeakerOption[];
    /** Local rich text editor for transient fields that are persisted through their owning document. */
    standalone?: boolean; value?: string; onChange?: (text: string) => void;
    /** Standalone editor grows with its content instead of owning an internal scroll area. */
    autoHeight?: boolean;
    className?: string; style?: import("react").CSSProperties;
    editorRef?: import("react").Ref<CanvasTextEditorHandle>;
    onSubmit?: () => void; onBlur?: () => void; onEscape?: () => void;
    autoFocus?: boolean;
    /** 启用台词（<d>…</d>）内联高亮与右键「转为台词/取消台词」。 */
    dialogue?: boolean;
    /** 为每个非空实际换行添加主题着色，并为编辑器提供可拖拽的细滚动条。 */
    lineMap?: boolean;
};

export type CanvasNodeContext = {
    TextEditor: ComponentType<CanvasTextEditorProps>;
    textDocument: (target: CanvasTextTarget) => CanvasTextDocument;
    textSuggestions: (target: CanvasTextTarget) => CanvasTextSuggestions;
    replaceText: (target: CanvasTextTarget, documentId: string, expectedText: string, text: string) => Promise<boolean>;
    /** 当前窗口的节点视图状态，不同步给其他协作者。 */
    view: {
        getSnapshot: () => Record<string, unknown>;
        subscribe: (listener: () => void) => () => void;
        update: (patch: Record<string, unknown>) => void;
    };
    projectId: string;
    node: CanvasNodeData;
    theme: CanvasTheme;
    scale: number;
    isSelected: boolean; // Whether this node is selected, used to enable iframe interaction on demand.
    // Node data.
    updateMetadata: (patch: CanvasNodeMetadata) => void;
    updateNode: (patch: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>) => void;
    // Graph access.
    getNode: (id: string) => CanvasNodeData | null;
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getUpstream: () => CanvasNodeData[];
    getDownstream: () => CanvasNodeData[];
    // Canvas operations using the Agent instruction set for nodes, connections, selection, viewport, and generation.
    applyOps: (ops: CanvasAgentOp[]) => void;
    flush: () => Promise<void>;
    // Inter-node and inter-plugin communication.
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    // AI image, video, and text generation using the host model configuration.
    ai: CanvasPluginAi;
    h3Defaults: CanvasH3Defaults;
    references: CanvasReferenceService;
    // Opens or closes the custom panel below this node; the definition must provide a Panel.
    openPanel: () => void;
    closePanel: () => void;
    openAssetPicker: (options?: { kind?: "image" }) => Promise<CanvasAssetPickerImage | null>;
    // Plugin-private persistence isolated by namespace.
    storage: PluginStorage;
    generationLogs: CanvasGenerationLogs;
};

export type PluginStorage = {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

// Node-independent host capabilities constructed by the canvas page and injected into the render chain.
export type CanvasPluginHost = {
    projectId: string;
    getNode: (id: string) => CanvasNodeData | null;
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getUpstream: (nodeId: string) => CanvasNodeData[];
    getDownstream: (nodeId: string) => CanvasNodeData[];
    updateNode: (nodeId: string, patch: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>) => void;
    updateMetadata: (nodeId: string, patch: CanvasNodeMetadata) => void;
    applyOps: (ops: CanvasAgentOp[]) => void;
    flush: () => Promise<void>;
    // AI generation using the current canvas model and credential configuration.
    ai: CanvasPluginAi;
    h3Defaults: CanvasH3Defaults;
    references: CanvasReferenceService;
    // Opens or closes the custom panel below a specified node.
    openPanel: (nodeId: string) => void;
    closePanel: () => void;
    openAssetPicker: (options?: { kind?: "image" }) => Promise<CanvasAssetPickerImage | null>;
    generationLogs: CanvasGenerationLogs;
};

// Configuration for reusing the host's built-in generation panel; see SDK CanvasBuiltinPanelConfig.
export type CanvasBuiltinPanelConfig = {
    mode: "image" | "video" | "text" | "audio";
    promptPrefix?: string;
    writeBackToSelf?: boolean;
};

// Shared node definition used by both built-in and plugin nodes.
export type CanvasNodeDefinition = {
    type: string; // Built-ins use values such as "image"; plugins should use "<pluginId>:<name>".
    legacyTypes?: string[]; // Older canvas node types migrated by this plugin, e.g. smart-minimax.
    title: string;
    icon: ReactNode;
    description?: string;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    showInCreateMenu?: boolean; // Defaults to true.
    hasSourceHandle?: boolean; // Right-side output handle; defaults to true.
    hidePanel?: boolean; // Prevents click/create from opening a lower panel; intended for display-only nodes.
    transparentBackground?: boolean; // Makes the node card transparent so SVG or vector content blends into the canvas.
    autoOpenPanel?: boolean; // Opens a custom Panel on click; automatic opening otherwise applies only to built-ins.
    useBuiltinPanel?: CanvasBuiltinPanelConfig; // Reuses the built-in generation panel instead of a custom Panel.
    // Lets the host provide an Interaction/Move toolbar toggle and control pointer events through metadata.interactive.
    interactionToggle?: boolean;
    // With interactionToggle, true forces interactive content, ignores metadata.interactive, and hides the toggle.
    forceInteractive?: (node: CanvasNodeData, view: Record<string, unknown>) => boolean;
    keepAspectRatio?: (node: CanvasNodeData) => boolean;
    resource?: (node: CanvasNodeData) => CanvasNodeResource | CanvasNodeResource[] | null;
    // Built-ins use canvas-node's internal renderer and may omit Content.
    Content?: ComponentType<{ ctx: CanvasNodeContext }>;
    Panel?: ComponentType<{ ctx: CanvasNodeContext; onClose: () => void }>;
    toolbar?: (ctx: CanvasNodeContext) => CanvasNodeToolbarItem[];
    onDoubleClick?: (ctx: CanvasNodeContext) => boolean; // Return true when handled.
};

// Application capabilities available while a plugin starts.
export type CanvasPluginApp = {
    version: string;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    // Injects plugin styles and returns a cleanup function; the same key replaces previous styles.
    injectCSS: (css: string, key?: string) => () => void;
};

// Default plugin package export.
export type CanvasPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    minAppVersion?: string;
    css?: string; // Injected when enabled and removed when uninstalled or disabled.
    nodes: CanvasNodeDefinition[];
    setup?: (app: CanvasPluginApp) => void | (() => void);
    // 可选声明的 MCP 模块:让插件在 Agent(canvas-agent)侧动态暴露 MCP 工具。
    // 浏览器插件包只声明 tools 元信息(供启用时同步给 Agent);真正的执行逻辑
    // 由 Agent 侧的 MCP 模块提供(createHandler 由 Agent 打包,浏览器可省略)。
    mcp?: CanvasPluginMcp;
};

// ---------------------------------------------------------------------------
// 插件 MCP 能力:让插件在 Agent(canvas-agent)侧动态暴露 MCP 工具
//
// 安全边界:MCP 不能运行在浏览器插件代码里,它由 Node.js stdio 服务(Agent)执行。
// 第三方远程插件的 MCP 执行需经用户显式安装 + Agent 授权;官方/本地插件自动加载。
// Agent 侧从本地已安装包或受信插件目录加载 MCP 模块,绝不执行任意网页脚本。
// ---------------------------------------------------------------------------

// 单个 MCP 工具的声明(纯描述,供 Agent 校验与动态注册)
export type McpToolDefinition = {
    id: string; // 工具名(全局唯一,建议 "<pluginId>:<tool>")
    version: string; // 同插件 version,用于兼容校验
    name: string; // 展示名
    description: string;
    inputJsonSchema: Record<string, unknown>; // JSON Schema,Agent 端转换为 zod
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
};

// 插件 MCP handler 运行上下文(Agent 注入)
export type PluginMcpContext = {
    // Agent 端点与令牌(用于回调 canvas-agent 自身接口)
    endpoint: string;
    token: string;
    // 读取/更新画布节点(数据来自 Agent 持久化的 SQLite,页面态未同步时回退)
    getCanvasNodes: () => Promise<CanvasNodeData[]>;
    getCanvasNode: (id: string) => Promise<CanvasNodeData | null>;
    updateCanvasNode: (id: string, patch: Partial<CanvasNodeData>, metadataPatch?: Record<string, unknown>) => Promise<void>;
    // 宿主运行时(具体类型由 Agent 提供,此处仅作契约占位)
    runtimeDb: unknown;
    comfyUi: unknown;
};

// 单个工具的处理函数
export type McpToolHandler = (input: Record<string, unknown>, context: PluginMcpContext) => Promise<unknown>;

// 插件可选声明的 MCP 模块
export type CanvasPluginMcp = {
    id: string; // 应等于插件 id
    version: string;
    tools: readonly McpToolDefinition[];
    // 返回「工具 id -> 处理函数」映射,Agent 据此为每个工具调用 registerTool。
    // 官方/本地插件由 Agent 侧打包的 MCP 模块提供,浏览器声明可省略。
    createHandler?: (context: PluginMcpContext) => Record<string, McpToolHandler>;
};
