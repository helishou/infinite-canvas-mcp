import type { CanvasGenerationMode } from "@basketikun/canvas-agent/generation-contract";

export type { CanvasGenerationMode } from "@basketikun/canvas-agent/generation-contract";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Loop = "loop",
    Group = "group",
    /** 角色节点：承载一个角色资产（多张参考图 + outfit），可作为下游参考节点。 */
    Character = "character",
    /** 场景节点：承载场景图、描述和可选色卡。 */
    Scene = "scene",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "queued" | "loading" | "awaiting_confirmation" | "success" | "error" | "cancelled";
export type CanvasImageGenerationType = "generation" | "edit";
export type CanvasGenerationEngine = "cloud" | "comfyui" | "video-concat" | "backend";

export type CanvasImageReferenceSnapshot = {
    id: string;
    name: string;
    type: string;
    url?: string;
    storageKey?: string;
};

export type CanvasImageGenerationSnapshot = {
    createdAt: string;
    prompt: string;
    effectivePrompt: string;
    model: string;
    size?: string;
    quality?: string;
    background?: string;
    count: number;
    params?: Record<string, unknown>;
    references: CanvasImageReferenceSnapshot[];
    maskEdit?: boolean;
};

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
    generationSnapshot?: CanvasImageGenerationSnapshot;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasNodeModeResult = {
    content?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    durationMs?: number;
};

export type CanvasNodeMetadata = {
    content?: string;
    url?: string;
    composerContent?: string;
    /** 新建的智能生成节点把提示词、参数和结果收在同一个 Config 节点里。 */
    smart?: boolean;
    prompt?: string;
    status?: CanvasNodeStatus;
    /** 后端回写的运行进度（0–1），仅生成中有效；前端只读，不得回写。 */
    runProgress?: number;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    /** 蒙版局部修改生成的智能节点：重试或再次生成时仍需启用蒙版输入分支。 */
    maskEdit?: boolean;
    /** 蒙版标注节点：局部修改时作为第 2 张参考图，Backend 据此把它排在原图之后。 */
    maskOverlay?: boolean;
    generationEngine?: CanvasGenerationEngine;
    comfyPreset?: string;
    runtimeTaskId?: string;
    generationTaskId?: string;
    generatedTextResultIds?: string[];
    primaryTextNodeId?: string;
    comfyParams?: Record<string, unknown>;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    /** 生成时参考资源的稳定输入 ID；用于从结果图反查角色节点等来源。 */
    referenceIds?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    /** 当前显示的智能图片历史版本。 */
    activeImageHistoryId?: string | null;
    /** 只有用户主动选中历史版本时，才用该版本的参考图快照覆盖实时连线。 */
    activeImageHistoryExplicit?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    /** 智能生成节点按模式暂存非当前的共享媒体字段；图片/文本结果集合仍留在各自字段。 */
    generationResultsByMode?: Partial<Record<CanvasGenerationMode, CanvasNodeModeResult>>;
    groupId?: string;
    groupLocked?: boolean;
    /** 有序组：只持久化紧凑的成员顺序；尾部空格由布局自动派生。 */
    orderedGroup?: boolean;
    groupSlots?: string[];
    orderedGroupColumns?: number;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    // 角色节点：characterAssetId 关联到资产库里的 CharacterAsset；characterImages 是节点自带的角色图谱快照（来自资产库或本地编辑）。
    characterAssetId?: string;
    characterName?: string;
    characterEnglishName?: string;
    characterDescription?: string;
    characterImages?: Array<{ url: string; storageKey?: string; name: string; outfit: string; outfitDescription: string; role?: string; width: number; height: number; bytes: number; mimeType: string }>;
    characterPrimaryIndex?: number;
    // 拖入角色节点的声线（音频）：从音频节点/音频资产/音频文件拖入后记录，存入资产库映射到 CharacterAsset.voice*。
    characterVoiceName?: string;
    characterVoiceDescription?: string;
    characterVoiceUrl?: string;
    characterVoiceStorageKey?: string;
    characterVoiceAssetId?: string;
    /** 角色节点作为某个生成节点参考输入时的选择快照；未记录时默认使用全部图片与声线。 */
    characterReferences?: Record<string, { imageKeys?: string[]; voiceEnabled?: boolean }>;
    sceneAssetId?: string;
    sceneName?: string;
    sceneDescription?: string;
    sceneImage?: { url: string; storageKey?: string; name: string; width: number; height: number; bytes: number; mimeType: string };
    sceneColorCard?: { url: string; storageKey?: string; name: string; width: number; height: number; bytes: number; mimeType: string };
    sceneColorPalette?: string[];
    sceneColorCardPrompt?: string;
    loopCount?: number;
    loopMode?: "serial" | "parallel";
    loopPromptEnabled?: boolean;
    loopImageEnabled?: boolean;
    loopVideoEnabled?: boolean;
    loopStart?: number;
    loopImageBatchSize?: number;
    loopVideoBatchSize?: number;
    loopPrompt?: string;
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
    role?: string;
    order?: number;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    startLocalX: number;
    startLocalY: number;
    currentLocalX: number;
    currentLocalY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
    excludeNodeIds?: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }

    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
