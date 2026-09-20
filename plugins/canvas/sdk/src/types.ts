// Infinite Canvas 插件公共契约类型。
//
// 这是插件作者面向的「公开接口」子集,不依赖宿主 `@/` 内部模块,
// 因此可以被独立构建的插件包直接 import,获得完整的 TS 提示。
//
// 生成协议直接复用 canvas-agent 的跨进程契约，其余 UI 类型仍与宿主保持一致。

import type { ComponentType, ReactNode } from "react";
import type { CanvasGenerationCommand, CanvasGenerationMode, CanvasGenerationTask } from "@basketikun/canvas-agent/generation-contract";

export type { CanvasGenerationCommand, CanvasGenerationMode, CanvasGenerationTask } from "@basketikun/canvas-agent/generation-contract";

// ---------------------------------------------------------------------------
// 画布基础几何与节点数据
// ---------------------------------------------------------------------------

export type Position = { x: number; y: number };

// 内置节点类型;插件节点建议用 "<pluginId>:<name>"。放开为字符串以便扩展。
export type CanvasBuiltinNodeType = "image" | "text" | "config" | "video" | "audio" | "group";
export type CanvasNodeTypeId = CanvasBuiltinNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "queued" | "success" | "loading" | "error" | "cancelled";
export type CanvasImageGenerationType = "generation" | "edit";

// 节点 metadata 是扁平可选字段袋;插件自定义字段可直接写入(内容惯例放 content)。
export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    quality?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    // 插件可写入任意自定义字段
    [key: string]: unknown;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

// ---------------------------------------------------------------------------
// 主题 token(用来让插件 UI 跟随画布明暗主题)
// ---------------------------------------------------------------------------

export type CanvasTheme = {
    canvas: {
        background: string;
        dot: string;
        line: string;
        selectionStroke: string;
        selectionFill: string;
    };
    node: {
        label: string;
        fill: string;
        panel: string;
        stroke: string;
        activeStroke: string;
        placeholder: string;
        text: string;
        muted: string;
        faint: string;
    };
    toolbar: {
        panel: string;
        border: string;
        item: string;
        itemHover: string;
        activeBg: string;
        activeText: string;
    };
};

// ---------------------------------------------------------------------------
// 画布指令集(ctx.applyOps):与 AI Agent 同级的画布操作能力
// ---------------------------------------------------------------------------

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeTypeId; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string }
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: CanvasGenerationMode; prompt?: string };

// ---------------------------------------------------------------------------
// 资源:插件节点作为上游输入被消费时输出什么(接入生成/引用体系)
// ---------------------------------------------------------------------------

export type CanvasResourceKind = "image" | "video" | "audio" | "text";
export type CanvasNodeResource = { kind: CanvasResourceKind; text?: string; url?: string; storageKey?: string };

// ---------------------------------------------------------------------------
// AI 生成:插件直接复用宿主的模型/密钥配置发起生成(生图/生视频/生文本/生音频)
//
// 插件本身拿不到 API Key 与模型配置,这些能力由宿主注入。前置/系统提示词由
// 插件自行拼进 prompt(宿主不感知),因此不同插件可各自定制自己的提示词策略。
// 若宿主 AI 配置未就绪,会抛错(并由宿主提示用户去配置),插件用 try/catch 处理即可。
// ---------------------------------------------------------------------------

// 生成公共可选项;references 为图生图/图生视频的参考图(dataURL 或可访问 URL)
export type GenerateOptions = {
    signal?: AbortSignal;
    references?: string[];
    model?: string; // 指定模型(取自 ai.listModels 的 value);缺省用宿主当前配置
};

export type GenerateImageOptions = GenerateOptions & {
    count?: number; // 期望生成张数(宿主会按模型上限裁剪)
    size?: string; // 形如 "1024x1024" / "auto";缺省用宿主当前配置
};

export type GenerateImageResult = {
    // 生成图的 dataURL(已可直接作为 <img src> 或 three 纹理使用)
    images: string[];
};

export type GenerateVideoOptions = GenerateOptions & {
    size?: string;
    seconds?: string;
};

export type GenerateVideoResult = {
    url: string; // 视频可访问 URL
    mimeType: string;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type GenerateTextOptions = {
    signal?: AbortSignal;
    model?: string;
    system?: string; // 附加系统提示词(拼在宿主系统提示之后)
    references?: Array<{ url: string; name?: string }>;
    onDelta?: (text: string) => void; // 流式增量回调
};

export type GenerateTextResult = {
    text: string;
};
export type LocalH3ActualSubmission = { promptId: string; seed?: number; frames?: number; width?: number; height?: number; loras?: Array<{ name: string; strength: number }>; attention?: string; sigma?: string; mediaInputs?: { images: string[]; videos: string[]; audios: string[] } };
export type LocalH3Result = { url: string; storageKey?: string; mimeType: string; taskId?: string; width?: number; height?: number; durationMs?: number; actualSubmission?: LocalH3ActualSubmission; segments?: Array<{ media?: Array<{ url: string; storageKey?: string; mimeType: string }> }> };
export type LocalH3Options = { signal?: AbortSignal; onTaskId?: (taskId: string) => void };
export type LocalH3Preview = { promptId: string; dataUrl: string; step?: number; total?: number; mime?: string };
export type LocalH3Task = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress: number; preview?: LocalH3Preview | null; result?: LocalH3Result | null; error?: string | null };
export type LocalVideoConcatResult = { url: string; storageKey?: string; mimeType: string; taskId?: string };

// 一个可选模型:value 传回给 generateXxx({ model }),label 用于展示
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ModelOption = { value: string; label: string };

// 宿主注入的 AI 生成能力,挂在 ctx.ai 下。任何插件均可调用。
export type CanvasPluginAi = {
    generateImage: (prompt: string, options?: GenerateImageOptions) => Promise<GenerateImageResult>;
    generateVideo: (prompt: string, options?: GenerateVideoOptions) => Promise<GenerateVideoResult>;
    generateText: (prompt: string, options?: GenerateTextOptions) => Promise<GenerateTextResult>;
    runCanvasGeneration: (command: CanvasGenerationCommand) => Promise<CanvasGenerationTask>;
    getLocalH3Task: (taskId: string) => Promise<LocalH3Task>;
    getCanvasH3Task: (taskId: string) => Promise<LocalH3Task>;
    cancelCanvasH3Task: (taskId: string) => Promise<LocalH3Task>;
    runVideoConcat: (videos: Array<{ name: string; url?: string; storageKey?: string }>, options?: LocalH3Options) => Promise<LocalVideoConcatResult>;
    listLocalH3Models: () => Promise<{
        models: string[];
        loras: string[];
        textEncoders?: string[];
        videoVaes?: string[];
        audioVaes?: string[];
        latentUpscaleModels?: string[];
        nanfeng?: Record<string, unknown[]>;
    }>;
    getRunningHubH3Task: (taskId: string) => Promise<LocalH3Task>;
    // 列出某能力下用户已配置的可选模型;不传能力则返回全部
    listModels: (capability?: ModelCapability) => ModelOption[];
    // 该能力当前默认选中的模型 value(可作为下拉框初始值)
    defaultModel: (capability: ModelCapability) => string;
};
export type CanvasH3Defaults = {
    get: () => Promise<Record<string, unknown>>;
    set: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
    reset: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// 节点上下文:每个节点渲染时注入,是插件与画布交互的核心接口
// ---------------------------------------------------------------------------

export type PluginStorage = {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

export type CanvasAssetPickerImage = { kind: "image"; dataUrl: string; title: string; storageKey?: string };
export type CanvasReferenceAsset = { id: string; label: string; mediaType: "image" | "video" | "audio"; role: string; tags: string[]; url?: string; storageKey?: string; mimeType?: string; sourceNodeId?: string; subjectId?: string; analysis?: Record<string, unknown> };
export type CanvasReferenceValidation = { semanticPrompt: string; compiledPrompt: string; bindings: Array<Record<string, unknown>>; references: Array<Record<string, unknown>>; issues: Array<{ severity: "error" | "warning"; code: string; message: string; bindingId?: string }>; migratedLegacyRefs: boolean };
export type CanvasReferenceService = {
    list: () => Promise<CanvasReferenceAsset[]>;
    upsert: (asset: Partial<CanvasReferenceAsset> & { label: string }) => Promise<CanvasReferenceAsset>;
    remove: (assetId: string) => Promise<void>;
    validate: (nodeId: string, segmentId: string) => Promise<CanvasReferenceValidation>;
};

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
    /** 为每个非空实际换行添加主题着色与可点击滚动刻度。 */
    lineMap?: boolean;
    /** 仅为匹配这些完整行文本的行显示跳转刻度；省略时显示所有非空行。 */
    lineMapTargets?: string[];
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
    // 自身数据
    node: CanvasNodeData;
    theme: CanvasTheme;
    scale: number;
    isSelected: boolean; // 该节点当前是否被选中(用于按需启用 iframe 交互等)
    updateMetadata: (patch: CanvasNodeMetadata) => void;
    updateNode: (patch: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>) => void;
    // 图访问
    getNode: (id: string) => CanvasNodeData | null;
    getNodes: () => CanvasNodeData[];
    getConnections: () => CanvasConnection[];
    getUpstream: () => CanvasNodeData[];
    getDownstream: () => CanvasNodeData[];
    // 画布操作(复用 Agent 指令集)
    applyOps: (ops: CanvasAgentOp[]) => void;
    flush: () => Promise<void>;
    // 节点间/插件间通信
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    // AI 生成能力(生图/生视频/生文本),复用宿主模型配置
    ai: CanvasPluginAi;
    h3Defaults: CanvasH3Defaults;
    references: CanvasReferenceService;
    // 打开/关闭本节点下方的自定义 Panel(需在节点定义里提供 Panel)
    openPanel: () => void;
    closePanel: () => void;
    openAssetPicker: (options?: { kind?: "image" }) => Promise<CanvasAssetPickerImage | null>;
    // 插件私有持久化,按插件 id 命名空间隔离
    storage: PluginStorage;
    generationLogs: CanvasGenerationLogs;
};

// ---------------------------------------------------------------------------
// 节点定义:内置节点与插件节点统一走这套结构
// ---------------------------------------------------------------------------

export type CanvasNodeToolbarItem = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

export type CanvasNodeContentProps = { ctx: CanvasNodeContext };
export type CanvasNodePanelProps = { ctx: CanvasNodeContext; onClose: () => void };

// 复用宿主内置生成面板(与图片/视频/文本节点同一个组件:模型选择、参数设置、
// 提示词库、运行/停止状态全部一致)。声明它即可获得完整生成体验,无需自写面板。
export type CanvasBuiltinPanelConfig = {
    mode: "image" | "video" | "text" | "audio"; // 生成类型,决定面板里的模型/设置项
    // 提交给模型前自动拼在用户提示词前面的固定前缀(如全景图的 equirectangular 约束)
    promptPrefix?: string;
    // true(默认)时生成结果写回本节点自身 metadata.content;false 则按内置逻辑生成到下游新节点
    writeBackToSelf?: boolean;
};

export type CanvasNodeDefinition = {
    type: string; // 建议 "<pluginId>:<name>",全局唯一
    legacyTypes?: string[]; // 旧画布类型别名,用于导入时兼容
    title: string;
    icon: ReactNode; // emoji 字符串或任意 ReactNode
    description?: string;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    showInCreateMenu?: boolean; // 默认 true
    hasSourceHandle?: boolean; // 右侧输出连接点,默认 true
    hidePanel?: boolean; // 为 true 时:点击/新建不弹出下方面板(含内置生图面板),纯展示型节点用
    // 为 true 时:节点卡片背景与边框透明,内容直接融入画布(如 SVG/矢量图);选中时仍显示选中描边
    transparentBackground?: boolean;
    autoOpenPanel?: boolean; // 为 true 时:单击节点自动打开自定义 Panel(默认仅内置节点单击自动打开)
    // 复用宿主内置生成面板;与自定义 Panel 二选一(同时提供时优先 Panel)
    useBuiltinPanel?: CanvasBuiltinPanelConfig;
    // 为 true 时:宿主自动在工具条加「交互 ⇄ 移动」开关,并按 metadata.interactive 控制内容层指针事件。
    // 默认(interactive 未设/为 false)为「移动」态:内容不吃指针,拖动整块移动节点;
    // 切到「交互」态后内容可点击/拖拽(如全景转视角、iframe 操作)。适合内部有交互的展示型节点。
    interactionToggle?: boolean;
    // 配合 interactionToggle:返回 true 表示当前节点内容「强制可交互」(如编辑态),
    // 此时忽略 interactive 标志、始终允许操作,并隐藏移动/交互开关。缺省视为 false。
    forceInteractive?: (node: CanvasNodeData, view: Record<string, unknown>) => boolean;
    keepAspectRatio?: (node: CanvasNodeData) => boolean;
    resource?: (node: CanvasNodeData) => CanvasNodeResource | CanvasNodeResource[] | null;
    // 渲染
    Content?: ComponentType<CanvasNodeContentProps>;
    Panel?: ComponentType<CanvasNodePanelProps>; // 节点下方面板(自定义)
    toolbar?: (ctx: CanvasNodeContext) => CanvasNodeToolbarItem[];
    onDoubleClick?: (ctx: CanvasNodeContext) => boolean; // 返回 true 表示已处理
};

// ---------------------------------------------------------------------------
// 插件运行时与插件包
// ---------------------------------------------------------------------------

// 插件启动时(setup)可访问的应用能力
export type CanvasPluginApp = {
    version: string;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: (payload: unknown) => void) => () => void;
    // 注入插件样式,返回移除函数;传 key 时同 key 覆盖旧样式
    injectCSS: (css: string, key?: string) => () => void;
};

// 宿主注入的运行时(工厂形式插件的入参),内含宿主 React 实例避免双 React
export type PluginRuntime = CanvasPluginApp & {
    React: typeof import("react");
    jsx: typeof import("react").createElement;
    Fragment: typeof import("react").Fragment;
};

// 插件包(默认导出对象,或返回它的工厂函数)
export type CanvasPlugin = {
    id: string; // 唯一,kebab-case
    name: string;
    version: string;
    description?: string;
    minAppVersion?: string;
    css?: string; // 插件样式,启用时自动注入、卸载/禁用时自动清理
    nodes: CanvasNodeDefinition[];
    setup?: (app: CanvasPluginApp) => void | (() => void);
    // 可选声明的 MCP 模块:让插件在 Agent(canvas-agent)侧动态暴露 MCP 工具。
    // 浏览器插件包只声明 tools 元信息;真正的执行逻辑由 Agent 侧 MCP 模块提供。
    mcp?: CanvasPluginMcp;
};

export type CanvasPluginFactory = (runtime: PluginRuntime) => CanvasPlugin;

// ---------------------------------------------------------------------------
// 插件 MCP 能力:让插件在 Agent(canvas-agent)侧动态暴露 MCP 工具
//
// 安全边界:MCP 不能运行在浏览器插件代码里,它由 Node.js stdio 服务(Agent)执行。
// 第三方远程插件的 MCP 执行需经用户显式安装 + Agent 授权;官方/本地插件自动加载。
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
    endpoint: string;
    token: string;
    // 读取/更新画布节点(数据来自 Agent 持久化的 SQLite)
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
