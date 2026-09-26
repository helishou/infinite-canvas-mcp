import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import copyToClipboard from "copy-to-clipboard";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { defaultConfig, resolveModelChannel, resolveModelWorkflow, useConfigStore, useEffectiveConfig, VIDEO_CONCAT_MODEL } from "@/stores/use-config-store";
import { fetchWorkflowDetail, isWorkflowImageField } from "@/services/api/workflows";
import { resolveComfyImageSize } from "@/services/api/comfyui";
import { uploadImage, resolveImageUrl, type UploadedImage } from "@/services/image-storage";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { backendMediaUrl, createBackendGenerationLog, createBackendTask, fetchBackendCanvasDrama, request, syncBackendCanvasCharacterAssets, updateBackendGenerationLog, updateBackendTask, type BackendMediaResult } from "@/services/backend-api";
import { runCanvasImageTask } from "@/services/api/canvas-image";
import { runCanvasVideoTask } from "@/services/api/canvas-video";
import { runCanvasAudioTask } from "@/services/api/canvas-audio";
import { runCanvasTextTask } from "@/services/api/canvas-text-task";
import { getCanvasTextSession, replaceCanvasText } from "@/services/api/canvas-text";
import { kickCanvasBrowserTask } from "@/services/api/canvas-browser-task";
import { useBackendStore } from "@/stores/use-backend-store";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { findCharacterVoiceAsset, resolveCharacterVoiceName } from "@/lib/character-voice";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAssetStore, type AudioAsset } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { arrangeGroupMembers, computeFlowLayout } from "@/lib/canvas/canvas-agent-ops";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { retainCharacterPrimaryIndex } from "@/lib/canvas/character-primary";
import { findCanvasCompareReference } from "@/lib/canvas/image-compare-reference";
import { needsViewportCull, normalizeViewportTransform, viewportRenderPadding } from "@/lib/canvas/canvas-viewport";
import { queryCanvasSpatialIndex, type CanvasSpatialBounds } from "@/lib/canvas/canvas-spatial-index";
import { captureVideoFrame, type VideoFramePosition } from "@/lib/canvas/canvas-video-frame";
import { extractShotKeyframes } from "@/lib/canvas/video-shot-keyframes";
import { Alert, App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, clearActiveConnectionPointer, ConnectionBundleOverviewPath, ConnectionOverviewPath, ConnectionPath, writeActiveConnectionPointer } from "@/components/canvas/canvas-connections";
import { CanvasH3RefLinks } from "@/components/canvas/canvas-h3-ref-links";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildLoopSourceInputs, buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext, recordLoopGenerationOutput, splitLoopPromptItems, type CanvasLoopRuntimeContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasLoopNode } from "@/components/canvas/canvas-loop-node";
import { buildLoopGenerationStages, createLoopFallbackOutput, resolveLoopInputPlan, runLoopGenerationRounds, runLoopGenerationStages, singleLoopPanelTarget, upstreamLoopForGeneration } from "@/lib/canvas/canvas-loop-execution";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { CharacterNodeEditModal } from "@/components/canvas/character-node-edit-modal";
import { SceneNodeEditModal } from "@/components/canvas/scene-node-edit-modal";
import { MediaPreviewModal } from "@/components/canvas/media-preview-modal";
import { CanvasVideoCompareModal, type CanvasVideoComparison, type CanvasVideoCompareItem } from "@/components/canvas/canvas-video-compare-modal";
import type { CanvasMediaPreview } from "@/types/canvas-plugin";
import { InfiniteCanvas, type ViewportChangeOptions } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNodeViewportItem } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useAgentStore } from "@/stores/use-agent-store";
import { applyBackendCanvasEvent, ensureCanvasProjectLoaded, flushCanvasProjectBeforeGeneration, useCanvasStore, type CanvasCollaborator } from "@/stores/canvas/use-canvas-store";
import { getPluginNodeView } from "@/stores/canvas/plugin-node-view";
import { emitCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { setBackendCanvasPresence } from "@/stores/use-backend-store";
import { useCanvasDocument } from "@/pages/canvas/hooks/use-canvas-document";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildCanvasGraphIndex, createMentionReferenceSelector, getFixedReferenceNodes, getGroupResourceNodes, isCanvasReferenceNode, nodeResourceItems, type CanvasGraphIndex, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useCopyText } from "@/hooks/use-copy-text";
import { useExportCanvas } from "@/hooks/use-export-canvas";
import { applyNodeConfigPatch, audioMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, keepNodesInLockedGroups, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import { arrangeOrderedGroupMembers, inheritOrderedGroupOutputs, insertOrderedGroupSlot, moveOrderedGroupSlot, orderedGroupColumnCount, orderedGroupDisplaySlots, orderedGroupDraggedCenter, orderedGroupDropTarget, orderedGroupLayout, orderedGroupMemberPosition, orderedGroupMemberSize, orderedGroupResizeLayout, orderedGroupSlots, replaceOrderedGroupSlot, swapOrderedGroupSlot, transferOrderedGroupH3References } from "@/lib/canvas/ordered-group";
import { clearCanvasDragPreview, clearCanvasResizePreview, writeCanvasDragPreview, writeCanvasResizePreview, type CanvasResizePreviewBounds } from "@/lib/canvas/canvas-drag-preview";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    getGenerationCount,
    getInputSummary,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    nodeCopyableText,
    resolveImageGenerationReferences,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { CanvasGenerationLogDialog } from "@/components/canvas/canvas-generation-log-dialog";
import { CanvasRealtimePresenceLayer, useCanvasRealtimePresence, writeCanvasPresenceViewport } from "@/components/canvas/canvas-realtime-presence";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type CanvasClipboardContent = {
    kind: "image" | "video" | "audio" | "text";
    value: string;
};

const CANVAS_CLIPBOARD_FORMAT = "application/x-infinite-canvas-nodes";

function serializeCanvasClipboard(clipboard: CanvasClipboard) {
    return JSON.stringify({ format: CANVAS_CLIPBOARD_FORMAT, version: 1, ...clipboard });
}

function parseCanvasClipboard(text: string): CanvasClipboard | null {
    try {
        const value = JSON.parse(text) as { format?: unknown; version?: unknown; nodes?: unknown; connections?: unknown };
        if (value.format !== CANVAS_CLIPBOARD_FORMAT || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.connections)) return null;
        const nodes = value.nodes.filter((node): node is CanvasNodeData => {
            if (!node || typeof node !== "object") return false;
            const item = node as Partial<CanvasNodeData>;
            return typeof item.id === "string" && typeof item.type === "string" && typeof item.title === "string" && typeof item.width === "number" && typeof item.height === "number" && Boolean(item.position) && typeof item.position?.x === "number" && typeof item.position?.y === "number";
        });
        if (!nodes.length) return null;
        const nodeIds = new Set(nodes.map((node) => node.id));
        const connections = value.connections.filter((connection): connection is CanvasConnection => {
            if (!connection || typeof connection !== "object") return false;
            const item = connection as Partial<CanvasConnection>;
            return typeof item.id === "string" && typeof item.fromNodeId === "string" && typeof item.toNodeId === "string" && (nodeIds.has(item.fromNodeId) || nodeIds.has(item.toNodeId));
        });
        return { nodes, connections };
    } catch {
        return null;
    }
}

function getCanvasClipboardContent(node: CanvasNodeData): CanvasClipboardContent | null {
    const metadata = node.metadata;
    const smartMode = node.type === CanvasNodeType.Config && metadata?.smart ? metadata.generationMode || "image" : null;
    const kind = smartMode || (node.type === CanvasNodeType.Image ? "image" : node.type === CanvasNodeType.Video || node.type === "minimax-h3:video" ? "video" : node.type === CanvasNodeType.Audio ? "audio" : node.type === CanvasNodeType.Text ? "text" : null);
    if (!kind) return null;
    const value = metadata?.content?.trim();
    return value ? { kind, value } : null;
}

async function readCanvasClipboardBlob(node: CanvasNodeData) {
    const storageKey = node.metadata?.storageKey;
    if (storageKey) {
        const stored = await getMediaBlob(storageKey);
        if (stored) return stored;
    }
    const content = node.metadata?.content;
    if (!content) return null;
    const response = await fetch(content);
    return response.ok ? response.blob() : null;
}

async function writeCanvasClipboardBlob(blob: Promise<Blob | null>, kind: CanvasClipboardContent["kind"], mimeType: string | undefined, canvasClipboard: string) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    const fallbackType = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg";
    const type = mimeType && !mimeType.endsWith("/*") ? mimeType : fallbackType;
    const clipboardType = typeof ClipboardItem.supports === "function" && ClipboardItem.supports(type) ? type : `web ${type}`;
    await navigator.clipboard.write([
        new ClipboardItem({
            [clipboardType]: blob.then((value) => value || Promise.reject(new Error("clipboard content unavailable"))),
            [`web ${CANVAS_CLIPBOARD_FORMAT}`]: canvasClipboard,
        }),
    ]);
    return true;
}

function isLegacyCanvasClipboardText(text: string) {
    try {
        const value = JSON.parse(text) as { format?: unknown };
        // 兼容历史格式名与当前 CANVAS_CLIPBOARD_FORMAT（复制兜底时 JSON 会以纯文本进入系统剪贴板）
        return value.format === "infinite-canvas-nodes" || value.format === CANVAS_CLIPBOARD_FORMAT;
    } catch {
        return false;
    }
}

function findClipboardMediaType(item: ClipboardItem, kind: "image" | "video" | "audio") {
    return item.types.find((type) => type.startsWith(`${kind}/`) || type.startsWith(`web ${kind}/`));
}

async function readCanvasClipboardItem(items: ClipboardItems) {
    for (const item of items) {
        const type = item.types.find((value) => value === CANVAS_CLIPBOARD_FORMAT || value === `web ${CANVAS_CLIPBOARD_FORMAT}`);
        if (!type) continue;
        const clipboard = parseCanvasClipboard(await (await item.getType(type)).text());
        if (clipboard) return clipboard;
    }
    return null;
}

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

const EMPTY_CANVAS_COLLABORATORS: CanvasCollaborator[] = [];
const DENSE_OVERVIEW_MIN_SCALE = 0.4;
const DENSE_OVERVIEW_MIN_VISIBLE_NODES = 180;

function linkLoopAbort(signal: AbortSignal | undefined, controller: AbortController) {
    if (!signal) return () => undefined;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    return () => signal.removeEventListener("abort", abort);
}

function generationModeForLoopTarget(node: CanvasNodeData): CanvasNodeGenerationMode {
    if (node.type === CanvasNodeType.Config && node.metadata?.smart) return node.metadata.generationMode || "image";
    if (node.type === CanvasNodeType.Text) return "text";
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    return getNodeDefinition(node.type)?.useBuiltinPanel?.mode || "image";
}

function isImageConversionSource(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image || (node.type === CanvasNodeType.Config && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image");
}

function isLoopGenerationTarget(node: CanvasNodeData) {
    return (
        node.metadata?.loopOutputSlot !== true && (
            node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Config || Boolean(getNodeDefinition(node.type)?.useBuiltinPanel)
        )
    );
}

function loopImageInputCount(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], graph: CanvasGraphIndex) {
    const loop = graph.incomingByNodeId.get(nodeId)?.find((source) => source.type === CanvasNodeType.Loop);
    if (!loop) return 0;
    const inputs = buildLoopSourceInputs(loop.id, nodes, connections, graph);
    const plan = resolveLoopInputPlan(loop.metadata || {}, inputs.filter((input) => input.type === "image").length, inputs.filter((input) => input.type === "video").length);
    return plan.mediaKind === "image" ? Math.min(plan.batchSize, Math.max(0, plan.sourceCount - plan.start + 1)) : 0;
}

type ActiveGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_DRAG_PREVIEW = new Map<string, Position>();
const EMPTY_RESIZE_PREVIEW = new Map<string, CanvasResizePreviewBounds>();
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;

function sameIdSet(first: ReadonlySet<string>, second: ReadonlySet<string>) {
    if (first.size !== second.size) return false;
    for (const id of first) if (!second.has(id)) return false;
    return true;
}

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
type CanvasReferenceRole = "character_turnaround" | "storyboard" | "scene" | "motion_reference" | "audio_reference";
type CanvasReferenceDrag = { nodeId: string; url: string; type: "image"; name: string; storageKey?: string; mimeType?: string; role?: CanvasReferenceRole; subjectId?: string };
// 角色派发：H3 端按 characterGroupInput 建/复用角色组，由 group 派生 outfit image refs + voice audio ref
type CharacterReferenceDrag = {
    nodeId: string;
    type: "character";
    kind: "character";
    characterAssetId?: string;
    characterNodeId?: string;
    characterName: string;
    characterImages: Array<{ url: string; name: string; storageKey?: string; mimeType?: string }>;
    characterPrimaryIndex?: number;
    characterVoiceUrl?: string;
    characterVoiceName?: string;
    characterVoiceDescription?: string;
    characterVoiceStorageKey?: string;
    characterVoiceAssetId?: string;
    voice?: string;
    voiceName?: string;
    voiceDescription?: string;
    voiceAssetId?: string;
};
type AnyReferenceDrag = CanvasReferenceDrag | CharacterReferenceDrag;

function canvasReferenceRole(node: CanvasNodeData): CanvasReferenceRole | undefined {
    const value = `${node.type} ${node.title || ""}`.toLowerCase();
    // 角色节点是身份资产，不是四视图；拖到 ref 槽时只展开为普通 image ref。
    if (/四视图|turnaround/.test(value)) return "character_turnaround";
    if (/分镜|storyboard/.test(value)) return "storyboard";
    if (/场景|scene/.test(value)) return "scene";
    return undefined;
}

function h3DropTargetAt(clientX: number, clientY: number) {
    const directTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-canvas-ref-drop-target]");
    if (directTarget) return directTarget;
    return (
        document
            .elementsFromPoint(clientX, clientY)
            .map((element) => element.closest<HTMLElement>("[data-canvas-ref-drop-target]"))
            .find(Boolean) || null
    );
}

function dispatchCanvasReferenceDrag(
    name: "canvas-reference-drag-start" | "canvas-reference-drag-over" | "canvas-reference-drop" | "canvas-reference-drag-end",
    detail: (CanvasReferenceDrag | CharacterReferenceDrag) & { targetNodeId: string; clientX?: number; clientY?: number },
) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const { exportCanvasProjects: runCanvasExport, exporting, busy: canvasTransferBusy } = useExportCanvas();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const localAgentConnected = useAgentStore((state) => state.connected);
    const localAgentActivity = useAgentStore((state) => state.activity);
    const localAgentEnabled = useAgentStore((state) => state.enabled);
    const fragmentBootstrap = useAgentStore((state) => state.fragmentBootstrap);
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const localMultiClipboardFallbackRef = useRef(false);
    const suppressNextViewportPersistRef = useRef(false);
    const restoreGenerationRef = useRef(0);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const pendingNodeClickRef = useRef<{ nodeId: string; clientX: number; clientY: number } | null>(null);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: Map<string, Position>;
        movedIds: Set<string>;
        hasMovedGroup: boolean;
        movingNodes: CanvasNodeData[];
        groupDropCandidates: CanvasNodeData[];
        referenceDrag?: AnyReferenceDrag;
        referenceTargetNodeId?: string;
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: new Map(),
        movedIds: new Set(),
        hasMovedGroup: false,
        movingNodes: [],
        groupDropCandidates: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const getCurrentCanvasDramaId = useCallback(async () => {
        try {
            const result = await fetchBackendCanvasDrama(projectId);
            return result.episode?.dramaId || result.drama?.id || null;
        } catch {
            return null;
        }
    }, [projectId]);
    const collaborators = useCanvasStore((state) => state.collaborators[projectId] || EMPTY_CANVAS_COLLABORATORS);
    const canvasConflict = useCanvasStore((state) => state.canvasConflicts[projectId]);
    const clearCanvasConflict = useCanvasStore((state) => state.clearCanvasConflict);
    const keepPendingOpsOnCanvasConflict = useCanvasStore((state) => state.keepPendingOpsOnCanvasConflict);
    const adoptRemoteOnCanvasConflict = useCanvasStore((state) => state.adoptRemoteOnCanvasConflict);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const {
        nodes,
        setNodes,
        connections,
        setConnections,
        chatSessions,
        setChatSessions,
        activeChatId,
        setActiveChatId,
        backgroundMode,
        setBackgroundMode,
        showImageInfo,
        setShowImageInfo,
        globalPrompt,
        project: currentProject,
        historyState,
        history: historyRef,
        undo: undoDocument,
        redo: redoDocument,
    } = useCanvasDocument(projectId);
    const browserTaskIds = useMemo(() => Array.from(new Set(nodes.map((node) => String(node.metadata?.runtimeTaskId || "")).filter(Boolean))), [nodes]);
    useEffect(() => {
        browserTaskIds.forEach(kickCanvasBrowserTask);
    }, [browserTaskIds]);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const { publishCursor: publishRealtimeCursor, publishDrag: publishRealtimeDrag } = useCanvasRealtimePresence(projectId, selectedNodeIds);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    // 视频批量抽首帧：同一时间只允许一个节点在跑，避免并发解码把浏览器卡死。
    const [extractingKeyframeNodeId, setExtractingKeyframeNodeId] = useState<string | null>(null);
    const [keyframeProgress, setKeyframeProgress] = useState(0);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [runningLoopId, setRunningLoopId] = useState<string | null>(null);
    const [loopProgress, setLoopProgress] = useState<{ current: number; total: number } | undefined>();
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [assetPickerAllowedKinds, setAssetPickerAllowedKinds] = useState<string[] | undefined>();
    const assetPickerResolverRef = useRef<((image: { kind: "image"; dataUrl: string; title: string; storageKey?: string } | null) => void) | null>(null);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [projectLoadError, setProjectLoadError] = useState("");
    const [projectLoadAttempt, setProjectLoadAttempt] = useState(0);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [generationLogsOpen, setGenerationLogsOpen] = useState(false);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [videoComparison, setVideoComparison] = useState<CanvasVideoComparison | null>(null);
    const [pendingVideoComparison, setPendingVideoComparison] = useState<CanvasVideoComparison | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [expandedBatchNodeIds, setExpandedBatchNodeIds] = useState<Set<string>>(new Set());
    const [characterEditNodeId, setCharacterEditNodeId] = useState<string | null>(null);
    const [sceneEditNodeId, setSceneEditNodeId] = useState<string | null>(null);
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const [referencePickerNodeId, setReferencePickerNodeId] = useState<string | null>(null);
    // 插件节点（如 H3 导演台）点击空 ref 槽时复用同一套「从画布选节点」交互：
    // 插件发出 canvas-reference-pick-request，画布进入选择态，选中节点通过 canvas-reference-pick 回抛给插件自己写进槽位。
    const [pluginReferencePickNodeId, setPluginReferencePickNodeId] = useState<string | null>(null);
    const [characterImagePickerActive, setCharacterImagePickerActive] = useState(false);
    const [characterCanvasImagePick, setCharacterCanvasImagePick] = useState<{ id: string; image: NonNullable<CanvasNodeMetadata["characterImages"]>[number] } | null>(null);
    const [sceneImagePickerActive, setSceneImagePickerActive] = useState<"image" | "colorCard" | null>(null);
    const [sceneCanvasImagePick, setSceneCanvasImagePick] = useState<{ id: string; slot: "image" | "colorCard"; image: NonNullable<CanvasNodeMetadata["sceneImage"]> } | null>(null);

    const nodesRef = useRef(nodes);
    const previousNodeMetadataRef = useRef(new Map(nodes.map((node) => [node.id, node.metadata])));
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    // 「选节点作参考」模式的两个来源：画布内置「+」按钮（连线语义）与插件节点请求（回抛语义）。
    // 两者共用同一套节点高亮 / 提示条 / Esc 退出体验，只有选中后的落点不同。
    const refPickTargetNodeId = pluginReferencePickNodeId || referencePickerNodeId || pendingVideoComparison?.source.id;
    const refPickActive = Boolean(pluginReferencePickNodeId || referencePickerNodeId || pendingVideoComparison);
    const compareCandidateIds = useMemo(() => new Set(pendingVideoComparison?.candidates.map((item) => item.id) || []), [pendingVideoComparison]);
    // 拖动/滚轮时视口每帧都在变。走 setState 会让整棵画布树重渲染（几百个节点时直接掉到 30fps），
    // 所以高频阶段只把变换命令式写进 DOM，React state 只在拖动结束时同步一次。
    const liveViewportRef = useRef<ViewportTransform>(viewport);
    /** 已实际挂载节点的视口。请求中的裁剪不能提前写入这里，否则会把空白误判为已覆盖。 */
    const renderedViewportRef = useRef<ViewportTransform>(viewport);
    const requestedViewportRef = useRef<ViewportTransform | null>(null);
    const viewportWriterRef = useRef<((next: ViewportTransform) => void) | null>(null);
    const registerViewportWriter = useCallback((writer: ((next: ViewportTransform) => void) | null) => {
        viewportWriterRef.current = writer;
    }, []);
    /**
     * 高频视口变更：写 DOM + 更新实时 ref，不触发 React 渲染。
     * 但拖动一旦移出当前已渲染范围就会露出空白，所以按「距上次重算点的屏幕位移」补一次 state——
     * 阈值与裁剪 padding 都按屏幕像素定义（见 canvas-viewport.ts），保证补渲染总发生在空白露出来之前。
     */
    const applyViewportLive = useCallback(
        (next: ViewportTransform) => {
            next = normalizeViewportTransform(next);
            liveViewportRef.current = next;
            viewportRef.current = next;
            viewportWriterRef.current?.(next);
            writeCanvasPresenceViewport(projectId, next);
            if (!needsViewportCull(renderedViewportRef.current, next, size)) return;
            requestedViewportRef.current = next;
            // 低优先级：这次重渲染（几百个节点的裁剪重算）可以被打断，不会卡住拖动/缩放的那一帧。
            startTransition(() => setViewport(next));
        },
        [projectId, size],
    );
    /** 显式视口变更（聚焦、缩放按钮、小地图、初始化）：同步 state 并重算裁剪。 */
    const commitViewport = useCallback(
        (next: ViewportTransform) => {
            next = normalizeViewportTransform(next);
            liveViewportRef.current = next;
            viewportRef.current = next;
            requestedViewportRef.current = next;
            viewportWriterRef.current?.(next);
            writeCanvasPresenceViewport(projectId, next);
            setViewport(next);
        },
        [projectId],
    );
    // 热更时也主动修复已在内存中的旧 zoom / NaN 视口，用户无需手动清缓存。
    useEffect(() => {
        const current = liveViewportRef.current;
        const normalized = normalizeViewportTransform(current);
        if (current.x !== normalized.x || current.y !== normalized.y || current.k !== normalized.k) commitViewport(normalized);
    }, [commitViewport]);
    /** 画布容器回传的视口变更：拖动/滚轮走 live（零 React 渲染），其余走 commit。 */
    const handleViewportChange = useCallback(
        (next: ViewportTransform, options?: ViewportChangeOptions) => {
            setContextMenu(null);
            if (options?.live) applyViewportLive(next);
            else commitViewport(next);
        },
        [applyViewportLive, commitViewport],
    );
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, loopContext?: CanvasLoopRuntimeContext) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const dropTargetGroupIdRef = useRef(dropTargetGroupId);
    const selectionBoxRef = useRef(selectionBox);
    const ctrlGroupMarqueeRef = useRef<{
        nodeId: string;
        groupId: string;
        clientX: number;
        clientY: number;
        ctrlKey: boolean;
        metaKey: boolean;
        shiftKey: boolean;
        started: boolean;
    } | null>(null);
    const selectionOverlayRef = useRef<SVGSVGElement | null>(null);
    const selectionRafRef = useRef<number | null>(null);
    const selectionPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const connectionPreviewRafRef = useRef<number | null>(null);
    const connectionPreviewPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, ActiveGenerationRequest>());
    const loopAbortRef = useRef<AbortController | null>(null);
    const dragPreviewPositionsRef = useRef<Map<string, Position>>(EMPTY_DRAG_PREVIEW);
    const resizePreviewBoundsRef = useRef<Map<string, CanvasResizePreviewBounds>>(EMPTY_RESIZE_PREVIEW);
    const updateDropTargetGroupId = useCallback((next: string | null) => {
        if (dropTargetGroupIdRef.current === next) return;
        dropTargetGroupIdRef.current = next;
        setDropTargetGroupId(next);
    }, []);
    useEffect(
        () => () => {
            clearCanvasDragPreview(projectId);
            clearCanvasResizePreview(projectId);
        },
        [projectId],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const stopGenerationByRunningId = useCallback(
        (runningId: string) => {
            const affectedNodeIds = new Set<string>();
            generationRequestsRef.current.forEach((request) => {
                if (request.runningNodeId !== runningId) return;
                request.controller.abort();
                generationRequestsRef.current.delete(request.targetNodeId);
                affectedNodeIds.add(request.targetNodeId);
                affectedNodeIds.add(request.originNodeId);
            });
            setRunningNodeId((current) => (current === runningId ? null : current));
            if (!affectedNodeIds.size) return;
            setNodes((prev) =>
                prev.map((node) =>
                    affectedNodeIds.has(node.id) &&
                    node.metadata?.status === NODE_STATUS_LOADING &&
                    // Backend 绑定的任意任务都等待权威取消 delta；只清理没有任务身份的旧本地状态。
                    !node.metadata.runtimeTaskId
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: NODE_STATUS_IDLE,
                                  errorDetails: undefined,
                                  images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
                                  texts: node.metadata.texts?.map((text) => (text.status === NODE_STATUS_LOADING ? { ...text, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : text)),
                              },
                          }
                        : node,
                ),
            );
        },
        [t],
    );

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!projectId) return;
        setBackendCanvasPresence(projectId);
        return () => setBackendCanvasPresence("");
    }, [projectId]);

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        setProjectLoadError("");
        const generation = ++restoreGenerationRef.current;
        const loaded = openProject(projectId);
        const ready = loaded && !loaded.summary ? Promise.resolve(loaded) : ensureCanvasProjectLoaded(projectId);
        void ready
            .then(async (project) => {
                if (generation !== restoreGenerationRef.current) return;
                try {
                    const synced = await syncBackendCanvasCharacterAssets(projectId);
                    if (generation !== restoreGenerationRef.current) return;
                    if (synced.operations.length) applyBackendCanvasEvent({ type: "canvas.updated", entityId: projectId, revision: synced.revision, payload: { operations: synced.operations, updatedAt: synced.updatedAt } });
                } catch (error) {
                    if (generation !== restoreGenerationRef.current) return;
                    void message.warning(`角色资产同步失败：${error instanceof Error ? error.message : String(error)}`);
                }
                suppressNextViewportPersistRef.current = true;
                commitViewport(project.viewport);
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setProjectLoaded(true);
            })
            .catch((error) => {
                if (generation !== restoreGenerationRef.current) return;
                const detail = error instanceof Error ? error.message : "画布加载失败";
                setProjectLoadError(detail);
                void message.error(detail);
            });
        return () => {
            restoreGenerationRef.current += 1;
        };
    }, [hydrated, message, openProject, projectId, projectLoadAttempt, commitViewport]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (!searchParams.has("agentUrl") && !localAgentEnabled && !fragmentBootstrap) openAgentPanel();
    }, [fragmentBootstrap, localAgentEnabled, openAgentPanel, projectLoaded, searchParams]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (suppressNextViewportPersistRef.current) {
            suppressNextViewportPersistRef.current = false;
            return;
        }
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useEffect(() => {
        const previous = previousNodeMetadataRef.current;
        const changedNodeIds = nodes.filter((node) => previous.get(node.id) !== node.metadata).map((node) => node.id);
        previousNodeMetadataRef.current = new Map(nodes.map((node) => [node.id, node.metadata]));
        if (changedNodeIds.length) emitCanvasEvent("canvas:node-metadata-updated", { projectId, nodeIds: changedNodeIds });
    }, [nodes, projectId]);

    // 只有 React 实际提交了该 viewport 对应的节点树，才能把它视作可覆盖的裁剪范围。
    useLayoutEffect(() => {
        renderedViewportRef.current = viewport;
        if (requestedViewportRef.current === viewport) requestedViewportRef.current = null;
    }, [viewport]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                commitViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = canvasRectRef.current;
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = canvasRectRef.current;
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback(
        (next: ConnectionHandle | null) => {
            connectingParamsRef.current = next;
            setConnectingParams(next);
            if (!next) {
                if (connectionPreviewRafRef.current !== null) {
                    cancelAnimationFrame(connectionPreviewRafRef.current);
                    connectionPreviewRafRef.current = null;
                }
                connectionPreviewPointerRef.current = null;
                clearActiveConnectionPointer(projectId);
                connectionTargetNodeIdRef.current = null;
                setConnectionTargetNodeId(null);
            }
        },
        [projectId],
    );

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const clearActiveImageHistory = useCallback((nodeId: string) => {
        setNodes((prev) => prev.map((node) => node.id === nodeId && (node.metadata?.activeImageHistoryId || node.metadata?.activeImageHistoryExplicit)
            ? { ...node, metadata: { ...node.metadata, activeImageHistoryId: null, activeImageHistoryExplicit: false } }
            : node));
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                clearActiveImageHistory(toNodeId);
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [clearActiveImageHistory, message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Loop | CanvasNodeType.Scene, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.count || effectiveConfig.canvasImageCount) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            if (pending.connection) {
                const sourceNode = nodesRef.current.find((node) => node.id === pending.connection?.nodeId);
                if (sourceNode) {
                    newNode.width = sourceNode.width;
                    newNode.height = sourceNode.height;
                    newNode.position = {
                        x: pending.position.x - sourceNode.width / 2,
                        y: pending.position.y - sourceNode.height / 2,
                    };
                }
                const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
                if (!connection) {
                    message.warning(t("canvas.projectPage.configConnection"));
                    return;
                }
                setNodes((prev) => [...prev, newNode]);
                setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            } else {
                setNodes((prev) => [...prev, newNode]);
            }
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Loop && type !== CanvasNodeType.Scene) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const graphIndex = useMemo(() => buildCanvasGraphIndex(nodes, connections), [connections, nodes]);
    const nodeById = graphIndex.nodeById;

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            const queryPadding = Math.max(padding, handleRadius);
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            const candidates = queryCanvasSpatialIndex(graphIndex.nodeSpatialIndex, {
                left: world.x - queryPadding,
                top: world.y - queryPadding,
                right: world.x + queryPadding,
                bottom: world.y + queryPadding,
            });
            for (let index = candidates.length - 1; index >= 0; index -= 1) {
                const node = candidates[index];
                const anchor = getConnectionTargetAnchor(node, current);
                const dx = world.x - anchor.x;
                const dy = world.y - anchor.y;
                const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                if (!hitsHandle && !hitsInside && !hitsExpanded) continue;
                isNearNode = true;
                if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType, nodeById)) continue;

                const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                if (priority < bestPriority) {
                    bestNodeId = node.id;
                    bestPriority = priority;
                    if (priority === 0) break;
                }
            }

            return { nodeId: bestNodeId, isNearNode };
        },
        [graphIndex.nodeSpatialIndex, nodeById, screenToCanvas],
    );

    const updateConnectionPreview = useCallback(
        (clientX: number, clientY: number) => {
            const current = connectingParamsRef.current;
            if (!current || pendingConnectionCreateRef.current) return;
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect) canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            const dropTarget = getConnectionDropTarget(clientX, clientY, current);
            if (connectionTargetNodeIdRef.current !== dropTarget.nodeId) {
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
            }
            writeActiveConnectionPointer(projectId, screenToCanvas(clientX, clientY));
        },
        [getConnectionDropTarget, projectId, screenToCanvas],
    );

    const scheduleConnectionPreview = useCallback(
        (clientX: number, clientY: number) => {
            connectionPreviewPointerRef.current = { clientX, clientY };
            if (connectionPreviewRafRef.current !== null) return;
            connectionPreviewRafRef.current = requestAnimationFrame(() => {
                connectionPreviewRafRef.current = null;
                const pointer = connectionPreviewPointerRef.current;
                if (pointer) updateConnectionPreview(pointer.clientX, pointer.clientY);
            });
        },
        [updateConnectionPreview],
    );

    const flushConnectionPreview = useCallback(
        (clientX: number, clientY: number) => {
            if (connectionPreviewRafRef.current !== null) {
                cancelAnimationFrame(connectionPreviewRafRef.current);
                connectionPreviewRafRef.current = null;
            }
            connectionPreviewPointerRef.current = null;
            updateConnectionPreview(clientX, clientY);
        },
        [updateConnectionPreview],
    );

    const visibleWorldBounds = useMemo<CanvasSpatialBounds>(() => {
        const padding = viewportRenderPadding(viewport.k);
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        return {
            left: viewLeft,
            top: viewTop,
            right: viewLeft + size.width / viewport.k + padding * 2,
            bottom: viewTop + size.height / viewport.k + padding * 2,
        };
    }, [size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const visibleNodes = useMemo(() => queryCanvasSpatialIndex(graphIndex.nodeSpatialIndex, visibleWorldBounds), [graphIndex.nodeSpatialIndex, visibleWorldBounds]);
    // 节点过密时只降级详情控件；概览仍保留真实缩略图或信息卡，不能退化成透明空壳。
    const denseOverviewMode = visibleNodes.length >= DENSE_OVERVIEW_MIN_VISIBLE_NODES && viewport.k < DENSE_OVERVIEW_MIN_SCALE;

    const visibleConnections = useMemo(() => {
        return queryCanvasSpatialIndex(graphIndex.connectionSpatialIndex, visibleWorldBounds);
    }, [graphIndex.connectionSpatialIndex, visibleWorldBounds]);
    const groupIdByNodeId = useMemo(() => {
        const map = new Map<string, string>();
        graphIndex.groupChildrenById.forEach((children, groupId) => children.forEach((child) => map.set(child.id, groupId)));
        return map;
    }, [graphIndex.groupChildrenById]);
    const hasGroupedConnections = useMemo(
        () => connections.some((connection) => groupIdByNodeId.has(connection.fromNodeId) || groupIdByNodeId.has(connection.toNodeId)),
        [connections, groupIdByNodeId],
    );
    // 组连接在所有倍率下都汇总到组端点；平移和缩放都不会改变分组关系。
    const groupConnectionOverview = hasGroupedConnections;
    const compactConnectionOverview = denseOverviewMode && !isNodeDragging && !isNodeResizing;

    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const toolbarNodeView = getPluginNodeView(projectId, toolbarNode?.id || "__toolbar-empty__");
    const toolbarEditing = useSyncExternalStore(
        toolbarNodeView.subscribe,
        () => Boolean(toolbarNodeView.getSnapshot().editing),
        () => false,
    );
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    // 只有文本节点（文本类型 / 文本模式的智能生成节点）且正文非空时，右键菜单才提供「复制内容」。
    const contextMenuText = contextMenuNode ? nodeCopyableText(contextMenuNode) : "";
    // 右键菜单「生成组」的可用性：选中的普通节点（组不计）至少 2 个。
    const groupableSelectedCount = useMemo(
        () => nodes.reduce((count, node) => (selectedNodeIds.has(node.id) && node.type !== CanvasNodeType.Group ? count + 1 : count), 0),
        [nodes, selectedNodeIds],
    );
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewImage = previewImageId ? previewNode?.metadata?.images?.find((image) => image.id === previewImageId) : undefined;
    const previewStorageKey = previewImage?.storageKey || previewNode?.metadata?.storageKey;
    const previewRawContent = previewImage?.content || previewNode?.metadata?.content || "";
    const previewBeforeReference = useMemo(
        () => previewNode ? findCanvasCompareReference(previewNode, nodes, connections, previewImage?.generationSnapshot?.references) : null,
        [connections, nodes, previewNode, previewImage?.generationSnapshot?.references, previewRawContent],
    );
    const [previewContent, setPreviewContent] = useState("");
    const [previewBeforeContent, setPreviewBeforeContent] = useState<string | null>(null);
    // 插件经 ctx.openMediaPreview 打开的宿主预览，与节点双击预览共用同一个 MediaPreviewModal。
    const [hostMediaPreview, setHostMediaPreview] = useState<CanvasMediaPreview | null>(null);
    const mediaPreviewItem = hostMediaPreview
        || (previewContent ? { url: previewContent, beforeUrl: previewBeforeContent || undefined, name: previewNode?.title || t("assets.kinds.image"), type: "image" as const } : null);
    const closeMediaPreview = useCallback(() => {
        if (hostMediaPreview) {
            setHostMediaPreview(null);
            return;
        }
        setPreviewNodeId(null);
        setPreviewImageId(null);
    }, [hostMediaPreview]);

    useEffect(() => {
        let cancelled = false;
        if (!previewRawContent && !previewStorageKey) {
            setPreviewContent("");
            setPreviewBeforeContent(null);
            return;
        }
        const resolvePreview = (storageKey?: string, fallback = "") => resolveImageUrl(storageKey, fallback).catch(() => fallback);
        Promise.all([
            resolvePreview(previewStorageKey, previewRawContent),
            previewBeforeReference ? resolvePreview(previewBeforeReference.storageKey, previewBeforeReference.content) : Promise.resolve("") ,
        ]).then(([after, before]) => {
            if (cancelled) return;
            setPreviewContent(after);
            setPreviewBeforeContent(before || null);
        });
        return () => {
            cancelled = true;
        };
    }, [previewBeforeReference, previewRawContent, previewStorageKey]);
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const focusedConnectionIds = useMemo(() => {
        if (!groupConnectionOverview || !singleSelectedNodeId || !groupIdByNodeId.has(singleSelectedNodeId)) return new Set<string>();
        return new Set((graphIndex.connectionsByNodeId.get(singleSelectedNodeId) || []).map((connection) => connection.id));
    }, [graphIndex.connectionsByNodeId, groupConnectionOverview, groupIdByNodeId, singleSelectedNodeId]);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        graphIndex.groupChildrenById.forEach((children, groupId) => map.set(groupId, children.length));
        return map;
    }, [graphIndex.groupChildrenById]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        const addNode = (nodeId: string) => {
            nodeIds.add(nodeId);
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) graphIndex.groupChildrenById.get(nodeId)?.forEach((node) => nodeIds.add(node.id));
        };
        addNode(activeNodeId);
        graphIndex.connectionsByNodeId.get(activeNodeId)?.forEach((connection) => {
            connectionIds.add(connection.id);
            addNode(connection.fromNodeId);
            addNode(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, graphIndex, nodeById]);

    // 组相关连线始终改由组输入/输出汇总线表示；选中的单个节点恢复其真实连线。
    const renderedConnections = useMemo(() => {
        if (!groupConnectionOverview) return visibleConnections;
        return visibleConnections.filter((connection) =>
            connection.id === selectedConnectionId || focusedConnectionIds.has(connection.id) || (!groupIdByNodeId.has(connection.fromNodeId) && !groupIdByNodeId.has(connection.toNodeId)),
        );
    }, [focusedConnectionIds, groupConnectionOverview, groupIdByNodeId, selectedConnectionId, visibleConnections]);
    const connectionOverviewBundles = useMemo(() => {
        if (!groupConnectionOverview) return [];
        const bundles = new Map<string, { fromX: number; fromY: number; toX: number; toY: number; count: number }>();
        for (const connection of connections) {
            if (focusedConnectionIds.has(connection.id)) continue;
            const sourceGroupId = groupIdByNodeId.get(connection.fromNodeId);
            const targetGroupId = groupIdByNodeId.get(connection.toNodeId);
            if (!sourceGroupId && !targetGroupId) continue;
            const sourceEntityId = sourceGroupId || connection.fromNodeId;
            const targetEntityId = targetGroupId || connection.toNodeId;
            if (sourceEntityId === targetEntityId || connection.id === selectedConnectionId) continue;
            const sourceEntity = nodeById.get(sourceEntityId);
            const targetEntity = nodeById.get(targetEntityId);
            if (!sourceEntity || !targetEntity) continue;
            const start = { x: sourceEntity.position.x + sourceEntity.width, y: sourceEntity.position.y + sourceEntity.height / 2 };
            const end = { x: targetEntity.position.x, y: targetEntity.position.y + targetEntity.height / 2 };
            const key = `${sourceEntityId}>${targetEntityId}`;
            const bundle = bundles.get(key) || { fromX: 0, fromY: 0, toX: 0, toY: 0, count: 0 };
            bundle.fromX += start.x;
            bundle.fromY += start.y;
            bundle.toX += end.x;
            bundle.toY += end.y;
            bundle.count += 1;
            bundles.set(key, bundle);
        }
        return Array.from(bundles, ([id, bundle]) => ({
            id,
            from: { x: bundle.fromX / bundle.count, y: bundle.fromY / bundle.count },
            to: { x: bundle.toX / bundle.count, y: bundle.toY / bundle.count },
            count: bundle.count,
        }));
    }, [connections, focusedConnectionIds, groupConnectionOverview, groupIdByNodeId, nodeById, selectedConnectionId]);
    const visibleConnectionOverviewBundles = useMemo(
        () => connectionOverviewBundles.filter((bundle) => {
            const curvature = Math.max(Math.abs(bundle.to.x - bundle.from.x) * 0.5, 50);
            const left = Math.min(bundle.from.x, bundle.from.x + curvature, bundle.to.x - curvature, bundle.to.x);
            const right = Math.max(bundle.from.x, bundle.from.x + curvature, bundle.to.x - curvature, bundle.to.x);
            const top = Math.min(bundle.from.y, bundle.to.y);
            const bottom = Math.max(bundle.from.y, bundle.to.y);
            return right > visibleWorldBounds.left && left < visibleWorldBounds.right && bottom > visibleWorldBounds.top && top < visibleWorldBounds.bottom;
        }),
        [connectionOverviewBundles, visibleWorldBounds],
    );

    const detailVisibleNodes = useMemo(() => {
        // 轻量概览节点不会消费配置输入或 @ 参考资源；密集画布中只为即将挂载完整内容的节点计算它们。
        if (viewport.k >= 0.24 && !denseOverviewMode) return visibleNodes;
        // 拖动/缩放期间预览坐标来自瞬态订阅源，保守保留完整输入计算，避免状态切换时丢面板内容。
        if (isNodeDragging || isNodeResizing || refPickActive || characterImagePickerActive) return visibleNodes;

        const detailIds = new Set<string>();
        if (singleSelectedNodeId) detailIds.add(singleSelectedNodeId);
        if (hoveredNodeId) detailIds.add(hoveredNodeId);
        if (activeNodeId) detailIds.add(activeNodeId);
        if (connectingParams?.nodeId) detailIds.add(connectingParams.nodeId);
        if (dropTargetGroupId) detailIds.add(dropTargetGroupId);
        if (dialogNodeId) detailIds.add(dialogNodeId);
        expandedBatchNodeIds.forEach((nodeId) => detailIds.add(nodeId));
        return visibleNodes.filter((node) => detailIds.has(node.id));
    }, [
        activeNodeId,
        characterImagePickerActive,
        connectingParams?.nodeId,
        denseOverviewMode,
        dialogNodeId,
        dropTargetGroupId,
        expandedBatchNodeIds,
        hoveredNodeId,
        isNodeDragging,
        isNodeResizing,
        refPickActive,
        singleSelectedNodeId,
        viewport.k,
        visibleNodes,
    ]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        detailVisibleNodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections, graphIndex));
        });
        return map;
    }, [connections, detailVisibleNodes, graphIndex, nodes]);
    const selectMentionReferences = useMemo(() => createMentionReferenceSelector(), []);
    const mentionReferencesByNodeId = useMemo(() => selectMentionReferences(detailVisibleNodes, nodes, connections, graphIndex), [selectMentionReferences, connections, detailVisibleNodes, graphIndex, nodes]);
    // 图索引已经按目标节点维护上游节点，避免再次遍历全部连线构造同一份 Map。
    const connectedNodesByNodeId = graphIndex.incomingByNodeId;
    const referenceConnectedNodeIds = useMemo(
        () =>
            new Set(
                [
                    referencePickerNodeId,
                    ...(referencePickerNodeId
                        ? connectedNodesByNodeId.get(referencePickerNodeId)?.flatMap((node) => (node.type === CanvasNodeType.Group ? [node.id, ...getGroupResourceNodes(node.id, nodes, graphIndex).map((child) => child.id)] : [node.id])) || []
                        : []),
                ].filter((id): id is string => Boolean(id)),
            ),
        [connectedNodesByNodeId, graphIndex, nodes, referencePickerNodeId],
    );
    const { applyAgentOps } = useAgentBridge({
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
    });

    const openAssetPicker = useCallback(
        (options?: { kind?: "image" }) =>
            new Promise<{ kind: "image"; dataUrl: string; title: string; storageKey?: string } | null>((resolve) => {
                assetPickerResolverRef.current = resolve;
                setAssetPickerAllowedKinds(options?.kind ? [options.kind] : undefined);
                setAssetPickerOpen(true);
            }),
        [],
    );
    // 插件预览统一交给宿主的 MediaPreviewModal：插件不再自带灯箱，避免画布里出现多套预览弹窗。
    const openMediaPreview = useCallback((item: CanvasMediaPreview) => setHostMediaPreview(item), []);
    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        projectId,
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        openAssetPicker,
        openMediaPreview,
        applyAgentOps,
    });
    const pluginToolbarItems = useMemo(() => (toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined), [buildNodeToolbarItems, toolbarEditing, toolbarNode]);
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.count || effectiveConfig.canvasImageCount),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group && type !== CanvasNodeType.Character && type !== CanvasNodeType.Scene && type !== CanvasNodeType.Loop;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setReferencePickerNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedBatchNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    // 把选中的多个节点按连接关系做拓扑分层排布：源点（输入）在左、汇点（输出）在右，
    // 同一层纵向堆叠。MCP 批量生成常叠在同一点，一键按数据流展开。
    const arrangeSelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (selectedIds.size < 2) return;
        const selected = nodesRef.current.filter((node) => selectedIds.has(node.id));
        if (selected.length < 2) return;
        const minX = Math.min(...selected.map((node) => node.position.x));
        const minY = Math.min(...selected.map((node) => node.position.y));
        // H3 导演台节点很大，整理时排除出分层逻辑，并统一停到最右列，避免把其它节点间距撑开。
        const h3Ids = selected.filter((node) => node.type === "minimax-h3:video").map((node) => node.id);
        // 只取两端都在选择集内的边，按子图做分层（输入在左、输出在右，无连接时退回网格）。
        // normalizeSizes：把画面节点尺寸收进同一档（最大高度 ≤ 最小高度 × 2），并让输出与上游对齐同一水平线。
        const positions = computeFlowLayout({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            ids: selected.map((node) => node.id),
            scopeEdges: true,
            anchorX: minX,
            anchorY: minY,
            // 组（Group）是容器：选中组会带上它的全部成员、选中成员会带上它所属的组，整理完组框按成员包围盒重新生成。
            centerInPlace: true,
            parkAtRight: h3Ids,
            normalizeSizes: true,
        });
        const ops = [...positions.entries()].map(([id, pos]) => {
            const patch: { position: { x: number; y: number }; width?: number; height?: number } = { position: { x: pos.x, y: pos.y } };
            if (pos.width && pos.height) {
                patch.width = pos.width;
                patch.height = pos.height;
            }
            return { type: "update_node" as const, id, patch };
        });
        applyAgentOps(ops);
    }, [applyAgentOps]);

    // 右键「生成组」：把选中的多个节点装进一个新组。组不套组 —— 选中的组节点不参与，
    // 所以只有 ≥2 个普通节点被选中时菜单才显示这一项。
    const groupSelectedNodes = useCallback(() => {
        const members = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id) && node.type !== CanvasNodeType.Group);
        if (members.length < 2) return;
        applyAgentOps([{ type: "create_group", memberIds: members.map((node) => node.id) }]);
    }, [applyAgentOps]);

    // 工具栏「组」按钮：选中 ≥2 个普通节点时直接把它们装进新组（复用右键「生成组」同一套逻辑），
    // 否则维持原行为 —— 在画布中央新建一个空组。
    const addGroupNode = useCallback(() => {
        if (groupableSelectedCount >= 2) groupSelectedNodes();
        else createNode(CanvasNodeType.Group);
    }, [createNode, groupSelectedNodes, groupableSelectedCount]);

    const toggleOrderedGroup = useCallback((groupId: string) => {
        setNodes((prev) => {
            const group = prev.find((item) => item.id === groupId && item.type === CanvasNodeType.Group);
            if (!group) return prev;
            if (group.metadata?.orderedGroup) {
                return prev.map((item) => {
                    if (item.id !== groupId) return item;
                    const { orderedGroup: _orderedGroup, groupSlots: _groupSlots, orderedGroupColumns: _orderedGroupColumns, ...metadata } = item.metadata || {};
                    return { ...item, metadata };
                });
            }
            const slots = orderedGroupSlots(group, prev).filter((id): id is string => typeof id === "string");
            const orderedGroup = { ...group, metadata: { ...group.metadata, orderedGroup: true, groupSlots: slots } };
            const layout = arrangeOrderedGroupMembers(orderedGroup, prev.map((item) => item.id === groupId ? orderedGroup : item));
            return prev.map((item) => {
                if (item.id === groupId) return { ...orderedGroup, position: layout.position, width: layout.width, height: layout.height, metadata: { ...orderedGroup.metadata, orderedGroupColumns: layout.columns } };
                const position = layout.members.get(item.id);
                return position ? { ...item, position } : item;
            });
        });
    }, []);

    // 组节点工具栏「整理」：把组内成员的尺寸收成相近档位（图片/视频等比缩放，宽高比不变），
    // 按视觉顺序铺进组框范围内。组框本身不动 —— 用户要的是「排列到组的范围里」。
    const arrangeGroupNodes = useCallback((node: CanvasNodeData) => {
        const group = nodesRef.current.find((item) => item.id === node.id);
        if (!group) return;
        if (group.metadata?.orderedGroup) {
            const layout = arrangeOrderedGroupMembers(group, nodesRef.current);
            setNodes((prev) => prev.map((item) => {
                if (item.id === group.id) return { ...item, position: layout.position, width: layout.width, height: layout.height, metadata: { ...item.metadata, orderedGroupColumns: layout.columns } };
                const position = layout.members.get(item.id);
                return position ? { ...item, position } : item;
            }));
            return;
        }
        const layout = arrangeGroupMembers(group, nodesRef.current);
        if (!layout.size) return;
        setNodes((prev) =>
            prev.map((item) => {
                const next = layout.get(item.id);
                return next ? { ...item, position: { x: next.x, y: next.y }, width: next.width, height: next.height } : item;
            }),
        );
    }, []);

    const deleteConnection = useCallback((connectionId: string) => {
        const connection = connectionsRef.current.find((item) => item.id === connectionId);
        if (connection) clearActiveImageHistory(connection.toNodeId);
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, [clearActiveImageHistory]);

    const handleConnectionSelect = useCallback((connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu(null);
    }, []);
    const handleConnectionContextMenu = useCallback((event: ReactMouseEvent<SVGPathElement>, connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
    }, []);

    const disconnectNodeReference = useCallback((fromNodeId: string, toNodeId: string) => {
        clearActiveImageHistory(toNodeId);
        setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== fromNodeId || connection.toNodeId !== toNodeId));
    }, [clearActiveImageHistory]);

    const startNodeReferenceSelection = useCallback((nodeId: string) => {
        setReferencePickerNodeId(nodeId);
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const exitNodeReferenceSelection = useCallback(() => {
        if (!referencePickerNodeId) return;
        setSelectedNodeIds(new Set([referencePickerNodeId]));
        setDialogNodeId(referencePickerNodeId);
        setReferencePickerNodeId(null);
    }, [referencePickerNodeId]);

    // 退出（Esc / 点提示条）统一走这里：插件请求的选择态要把退出事件回抛给插件，让它清掉待填的槽位。
    const exitReferencePick = useCallback(() => {
        if (pendingVideoComparison) {
            setSelectedNodeIds(new Set([pendingVideoComparison.source.id]));
            setPendingVideoComparison(null);
            return;
        }
        if (pluginReferencePickNodeId) {
            window.dispatchEvent(new CustomEvent("canvas-reference-pick-end", { detail: { targetNodeId: pluginReferencePickNodeId } }));
            setSelectedNodeIds(new Set([pluginReferencePickNodeId]));
            setDialogNodeId(pluginReferencePickNodeId);
            setPluginReferencePickNodeId(null);
            return;
        }
        exitNodeReferenceSelection();
    }, [exitNodeReferenceSelection, pendingVideoComparison, pluginReferencePickNodeId]);

    // 插件节点点空 ref 槽 → 复用画布既有的「从画布选节点作参考」交互，而不是各插件自建一套选节点面板。
    useEffect(() => {
        const onRequest = (event: Event) => {
            const nodeId = String((event as CustomEvent<{ nodeId?: string }>).detail?.nodeId || "");
            if (!nodeId || !nodesRef.current.some((node) => node.id === nodeId)) return;
            setPluginReferencePickNodeId(nodeId);
            setReferencePickerNodeId(null);
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            setContextMenu(null);
        };
        window.addEventListener("canvas-reference-pick-request", onRequest);
        return () => window.removeEventListener("canvas-reference-pick-request", onRequest);
    }, []);

    const selectNodeReference = useCallback(
        (fromNodeId: string) => {
            if (!referencePickerNodeId || referenceConnectedNodeIds.has(fromNodeId)) return;
            const source = nodesRef.current.find((node) => node.id === fromNodeId);
            if (!source || !isCanvasReferenceNode(source, nodesRef.current, graphIndex)) return;
            clearActiveImageHistory(referencePickerNodeId);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId: referencePickerNodeId }]);
        },
        [clearActiveImageHistory, graphIndex, referenceConnectedNodeIds, referencePickerNodeId],
    );

    useEffect(() => {
        if (!refPickActive) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitReferencePick();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitReferencePick, refPickActive]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const currentNodes = nodesRef.current;
        const source = currentNodes.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };
        const nextConnections = connectionsRef.current.flatMap((connection) => {
            if (connection.toNodeId === nodeId) {
                const input = currentNodes.find((node) => node.id === connection.fromNodeId);
                if (input && isCanvasReferenceNode(input, currentNodes)) return [{ ...connection, id: nanoid(), toNodeId: id }];
            }
            if (connection.fromNodeId === nodeId && currentNodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config) {
                return [{ ...connection, id: nanoid(), fromNodeId: id }];
            }
            return [];
        });

        setNodes((prev) => [...prev, next]);
        if (nextConnections.length) setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(async () => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        const currentNodes = nodesRef.current;
        const clipboard = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => {
                const fromSelected = selectedIds.has(connection.fromNodeId);
                const toSelected = selectedIds.has(connection.toNodeId);
                if (fromSelected && toSelected) return true;
                if (toSelected) {
                    const input = currentNodes.find((node) => node.id === connection.fromNodeId);
                    return Boolean(input && isCanvasReferenceNode(input, currentNodes, graphIndex));
                }
                if (fromSelected) return currentNodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config;
                return false;
            }).map((connection) => ({ ...connection })),
        };
        clipboardRef.current = clipboard;
        localMultiClipboardFallbackRef.current = copiedNodes.length > 1;
        const serialized = serializeCanvasClipboard(clipboard);
        // 富格式（媒体二进制 + 画布 JSON）写入失败时的兜底：把画布 JSON 以纯文本写进系统剪贴板，
        // 粘贴端会识别该 JSON 并按节点复制还原（不会误建文字节点）。
        // 应用内剪贴板 clipboardRef 无论如何都已设置，画布内 Ctrl+V 不依赖系统剪贴板。
        const writeSystemTextFallback = async () => {
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(serialized);
                    return true;
                } catch {
                    // 降级到 execCommand 兜底
                }
            }
            return copyToClipboard(serialized);
        };
        if (copiedNodes.length > 1) {
            try {
                if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("clipboard write unsupported");
                await navigator.clipboard.write([
                    new ClipboardItem({
                        "text/plain": new Blob([copiedNodes.map((node) => node.title).join("\n")], { type: "text/plain" }),
                        [`web ${CANVAS_CLIPBOARD_FORMAT}`]: new Blob([serialized], { type: CANVAS_CLIPBOARD_FORMAT }),
                    }),
                ]);
                localMultiClipboardFallbackRef.current = false;
            } catch {
                if (!(await writeSystemTextFallback())) void message.error(t("canvas.projectPage.clipboardCopyFailed"));
            }
            return;
        }
        const content = getCanvasClipboardContent(copiedNodes[0]);
        if (!content) {
            // 未生成 / 生成失败的节点没有媒体内容可写（此前在这里静默返回，表现为 Ctrl+C 毫无反应），
            // 现在把节点结构（提示词、模型配置、连线）作为画布 JSON 复制，粘贴可原样重建。
            if (!(await writeSystemTextFallback())) void message.error(t("canvas.projectPage.clipboardCopyFailed"));
            return;
        }

        try {
            if (content.kind === "text") {
                if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
                    await navigator.clipboard.write([
                        new ClipboardItem({ "text/plain": content.value, [`web ${CANVAS_CLIPBOARD_FORMAT}`]: serialized }),
                    ]);
                    return;
                }
                if (navigator.clipboard?.writeText) {
                    try {
                        await navigator.clipboard.writeText(content.value);
                        return;
                    } catch {
                        // Fall through to the execCommand-based fallback.
                    }
                }
                if (!(await copyToClipboard(content.value))) throw new Error("clipboard write failed");
                return;
            }
            if (!(await writeCanvasClipboardBlob(readCanvasClipboardBlob(copiedNodes[0]), content.kind, copiedNodes[0].metadata?.mimeType, serialized))) throw new Error("clipboard write failed");
        } catch {
            if (await writeSystemTextFallback()) return;
            void message.error(t("canvas.projectPage.clipboardCopyFailed"));
        }
    }, [graphIndex, message, t]);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const currentNodes = nodesRef.current;
        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromIsCopied = idMap.has(connection.fromNodeId);
            const toIsCopied = idMap.has(connection.toNodeId);
            if (!fromIsCopied && !toIsCopied) return [];
            const input = fromIsCopied ? null : currentNodes.find((node) => node.id === connection.fromNodeId);
            const config = toIsCopied ? null : currentNodes.find((node) => node.id === connection.toNodeId);
            if (!fromIsCopied && (!input || !isCanvasReferenceNode(input, currentNodes))) return [];
            if (!toIsCopied && config?.type !== CanvasNodeType.Config) return [];
            const fromNodeId = idMap.get(connection.fromNodeId) || connection.fromNodeId;
            const toNodeId = idMap.get(connection.toNodeId) || connection.toNodeId;
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        commitViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [commitViewport, size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = normalizeViewportTransform(viewportRef.current);
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            // 先把 state 推到目标视口，让目标区域的节点进入渲染范围；
            // 动画过程本身只写 DOM，不再每帧重渲染整棵画布树。
            setViewport(target);
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                const next = { x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t };
                if (progress < 1) applyViewportLive(next);
                else commitViewport(next);
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [applyViewportLive, commitViewport, size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            const prev = normalizeViewportTransform(liveViewportRef.current);
            commitViewport({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            });
            setContextMenu(null);
        },
        [commitViewport, size.height, size.width],
    );

    const undoCanvas = useCallback(() => {
        const error = undoDocument();
        if (error) void message.warning(error);
    }, [undoDocument, message]);

    const redoCanvas = useCallback(() => {
        const error = redoDocument();
        if (error) void message.warning(error);
    }, [redoDocument, message]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        if (canvasTransferBusy) return;
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            if (await runCanvasExport([project], project.title || t("canvas.title"))) message.success(t("canvas.projectPage.exported"));
        } finally {
            hide();
        }
    }, [canvasTransferBusy, message, projectId, runCanvasExport, t]);

    const startSelectionBoxAt = useCallback(
        (clientX: number, clientY: number, additive: boolean, initialSelectedNodeIds: string[], excludeNodeIds?: string[]) => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return false;
            canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            const localX = clientX - rect.left;
            const localY = clientY - rect.top;
            const world = screenToCanvas(clientX, clientY);
            const nextSelectionBox: SelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                startLocalX: localX,
                startLocalY: localY,
                currentLocalX: localX,
                currentLocalY: localY,
                additive,
                initialSelectedNodeIds,
                excludeNodeIds,
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!additive) setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            return true;
        },
        [screenToCanvas],
    );

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;
            startSelectionBoxAt(event.clientX, event.clientY, event.shiftKey, event.shiftKey ? Array.from(selectedNodeIdsRef.current) : []);
        },
        [cancelPendingConnectionCreate, startSelectionBoxAt],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            const target = event.target as HTMLElement;
            if (target.closest(".cm-tooltip-autocomplete")) {
                pendingSelectionRef.current = null;
                pendingNodeClickRef.current = null;
                return;
            }
            const clickedNode = nodesRef.current.find((node) => node.id === nodeId);
            const groupId = clickedNode?.type === CanvasNodeType.Group ? clickedNode.id : clickedNode?.metadata?.groupId;
            const belongsToGroup = Boolean(groupId && nodesRef.current.some((node) => node.id === groupId && node.type === CanvasNodeType.Group));
            if ((event.ctrlKey || event.metaKey) && belongsToGroup && !target.closest("button, input, textarea, select, video, [contenteditable='true'], [data-canvas-node-panel], [data-resize-handle], [data-connection-handle]")) {
                setContextMenu(null);
                setHoveredNodeId(null);
                setSelectedConnectionId(null);
                pendingSelectionRef.current = null;
                pendingNodeClickRef.current = null;
                ctrlGroupMarqueeRef.current = {
                    nodeId,
                    groupId: groupId!,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey,
                    started: false,
                };
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
            if (event.shiftKey || event.metaKey || event.ctrlKey || target.closest("button, input, textarea, select, video, [contenteditable='true'], [data-canvas-node-panel]")) {
                pendingNodeClickRef.current = null;
            } else {
                pendingNodeClickRef.current = { nodeId, clientX: event.clientX, clientY: event.clientY };
            }
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            event.stopPropagation();
            // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
            const currentNodes = nodesRef.current;
            const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
            pendingSelectionRef.current = null;
            const dragIds = new Set(nextSelected);
            currentNodes.forEach((node) => {
                if (!nextSelected.has(node.id)) return;
                if (node.type === CanvasNodeType.Group) {
                    const childIds = node.metadata?.orderedGroup
                        ? orderedGroupSlots(node, currentNodes)
                        : currentNodes.filter((child) => child.metadata?.groupId === node.id).map((child) => child.id);
                    childIds.forEach((childId) => dragIds.add(childId));
                }
            });
            const movedNodes = currentNodes.filter((node) => dragIds.has(node.id));
            dragRef.current = {
                isDraggingNode: true,
                hasMoved: false,
                startX: event.clientX,
                startY: event.clientY,
                initialSelectedNodes: new Map(currentNodes.filter((node) => dragIds.has(node.id)).map((node) => [node.id, node.position])),
                movedIds: dragIds,
                hasMovedGroup: movedNodes.some((node) => node.type === CanvasNodeType.Group),
                movingNodes: movedNodes.filter((node) => node.type !== CanvasNodeType.Group),
                groupDropCandidates: currentNodes.filter((node) => node.type === CanvasNodeType.Group && !dragIds.has(node.id) && !node.metadata?.groupLocked),
                referenceDrag: (() => {
                    if (nextSelected.size !== 1) return undefined;
                    const node = currentNodes.find((item) => nextSelected.has(item.id));
                    if (!node) return undefined;
                    if (node.type === CanvasNodeType.Image) {
                        const url = String(node.metadata?.content || "").trim();
                        return url
                            ? {
                                  nodeId: node.id,
                                  url,
                                  type: "image" as const,
                                  name: node.title || "图片",
                                  storageKey: node.metadata?.storageKey,
                                  mimeType: node.metadata?.mimeType,
                                  role: canvasReferenceRole(node),
                                  subjectId: canvasReferenceRole(node) === "character_turnaround" ? node.id : undefined,
                              }
                            : undefined;
                    }
                    // Character 节点：作为单个 character 派发到 H3 ref 槽，由 H3 端建/复用角色组并把 outfit/voice 拆为 refs。
                    if (node.type === CanvasNodeType.Character) {
                        const images = (node.metadata?.characterImages || []).filter((image) => image.url);
                        return {
                            nodeId: node.id,
                            type: "character" as const,
                            kind: "character" as const,
                            characterNodeId: node.id,
                            characterName: node.title || "角色",
                            characterImages: images.map((image) => ({ url: image.url, name: image.outfit || image.name || "outfit", storageKey: image.storageKey, mimeType: image.mimeType })),
                            characterPrimaryIndex: node.metadata?.characterPrimaryIndex || 0,
                            characterVoiceUrl: node.metadata?.characterVoiceUrl,
                            characterVoiceName: node.metadata?.characterVoiceName,
                            characterVoiceDescription: node.metadata?.characterVoiceDescription,
                            characterVoiceStorageKey: node.metadata?.characterVoiceStorageKey,
                            characterVoiceAssetId: node.metadata?.characterVoiceAssetId,
                        };
                    }
                    if (node.type === CanvasNodeType.Scene) {
                        const image = node.metadata?.sceneImage;
                        return image?.url
                            ? { nodeId: node.id, url: image.url, type: "image" as const, name: node.title || "场景", storageKey: image.storageKey, mimeType: image.mimeType, role: "scene" as const }
                            : undefined;
                    }
                    return undefined;
                })(),
            };
            dragPreviewPositionsRef.current = EMPTY_DRAG_PREVIEW;
            writeCanvasDragPreview(projectId, EMPTY_DRAG_PREVIEW);
            nodeDraggingRef.current = true;
            setIsNodeDragging(true);
        },
        [projectId],
    );

    const applyOrderedGroupDrop = useCallback((draggedId: string, point: Position) => {
        const current = nodesRef.current;
        const dragged = current.find((item) => item.id === draggedId);
        if (!dragged || dragged.type === CanvasNodeType.Group) return false;
        const targetGroup = current.find((item) => item.type === CanvasNodeType.Group && item.metadata?.orderedGroup && point.x >= item.position.x && point.x <= item.position.x + item.width && point.y >= item.position.y && point.y <= item.position.y + item.height);
        if (!targetGroup) return false;
        const displaySlots = orderedGroupDisplaySlots(orderedGroupSlots(targetGroup, current), orderedGroupColumnCount(targetGroup));
        const slotAreas = orderedGroupLayout(targetGroup, displaySlots.length).flatMap((cell, index) => {
            const memberId = displaySlots[index];
            if (!memberId) return [{ ...cell, x: targetGroup.position.x + cell.x, y: targetGroup.position.y + cell.y }];
            const member = current.find((item) => item.id === memberId);
            return member ? [{ index, x: member.position.x, y: member.position.y, width: member.width, height: member.height }] : [];
        });
        // 图片通常从边角/标题处拖入，按图片中心而非鼠标抓取点确定槽位。
        const drop = orderedGroupDropTarget(targetGroup, displaySlots.length, point, slotAreas);
        if (!drop) return false;
        let inheritedOutputSourceId: string | undefined;
        setNodes((prev) => {
            const sourceGroup = prev.find((item) => item.type === CanvasNodeType.Group && item.metadata?.orderedGroup && orderedGroupSlots(item, prev).includes(draggedId));
            const target = prev.find((item) => item.id === targetGroup.id);
            if (!target) return prev;
            const sourceSlots = sourceGroup ? orderedGroupSlots(sourceGroup, prev) : null;
            const targetSlots = orderedGroupSlots(target, prev);
            const sourceIndex = sourceSlots?.indexOf(draggedId) ?? -1;
            const targetIndex = Math.max(0, Math.min(drop.index, targetSlots.length));
            let nextTargetSlots = [...targetSlots];
            let nextSourceSlots = sourceSlots ? [...sourceSlots] : null;
            let displacedId: string | undefined;
            if (sourceGroup?.id === target.id && sourceIndex >= 0) {
                if (drop.kind === "slot" && nextTargetSlots[targetIndex] && nextTargetSlots[targetIndex] !== draggedId) {
                    nextTargetSlots = swapOrderedGroupSlot(nextTargetSlots, sourceIndex, targetIndex);
                } else {
                    nextTargetSlots = moveOrderedGroupSlot(nextTargetSlots, sourceIndex, targetIndex);
                }
            } else {
                if (drop.kind === "slot" && targetIndex < nextTargetSlots.length) {
                    const replacement = replaceOrderedGroupSlot(nextTargetSlots, draggedId, targetIndex);
                    nextTargetSlots = replacement.slots;
                    displacedId = replacement.displacedId;
                    inheritedOutputSourceId = displacedId;
                    if (nextSourceSlots && sourceIndex >= 0 && displacedId) nextSourceSlots[sourceIndex] = displacedId;
                } else {
                    if (nextSourceSlots && sourceIndex >= 0) nextSourceSlots = nextSourceSlots.filter((id) => id !== draggedId);
                    nextTargetSlots = insertOrderedGroupSlot(nextTargetSlots, draggedId, targetIndex);
                }
            }
            const targetSlotIndex = nextTargetSlots.indexOf(draggedId);
            const sourceSlotMap = new Map((nextSourceSlots || []).map((id, index) => [id, index]));
            const targetSlotMap = new Map(nextTargetSlots.map((id, index) => [id, index]));
            const targetDisplayCount = orderedGroupDisplaySlots(nextTargetSlots, orderedGroupColumnCount(target)).length;
            const sourceDisplayCount = orderedGroupDisplaySlots(nextSourceSlots || [], sourceGroup ? orderedGroupColumnCount(sourceGroup) : 4).length;
            return prev.map((item) => {
                if (item.id === target.id) return { ...item, metadata: { ...item.metadata, orderedGroup: true, groupSlots: nextTargetSlots } };
                if (sourceGroup && item.id === sourceGroup.id && sourceGroup.id !== target.id) return { ...item, metadata: { ...item.metadata, groupSlots: nextSourceSlots || [] } };
                if (item.id === draggedId) {
                    const size = orderedGroupMemberSize(target, targetSlotIndex, item, targetDisplayCount);
                    return { ...item, metadata: { ...item.metadata, groupId: target.id }, position: orderedGroupMemberPosition(target, targetSlotIndex, item, targetDisplayCount), width: size.width, height: size.height };
                }
                if (item.id === displacedId && !sourceGroup) {
                    const { groupId: _groupId, ...metadata } = item.metadata || {};
                    return { ...item, metadata, position: dragged.position };
                }
                const targetSlot = targetSlotMap.get(item.id);
                if (targetSlot !== undefined) {
                    const size = orderedGroupMemberSize(target, targetSlot, item, targetDisplayCount);
                    return { ...item, metadata: { ...item.metadata, groupId: target.id }, position: orderedGroupMemberPosition(target, targetSlot, item, targetDisplayCount), width: size.width, height: size.height };
                }
                const sourceSlot = sourceSlotMap.get(item.id);
                if (sourceGroup && sourceGroup.id !== target.id && sourceSlot !== undefined) {
                    const size = orderedGroupMemberSize(sourceGroup, sourceSlot, item, sourceDisplayCount);
                    return { ...item, metadata: { ...item.metadata, groupId: sourceGroup.id }, position: orderedGroupMemberPosition(sourceGroup, sourceSlot, item, sourceDisplayCount), width: size.width, height: size.height };
                }
                return item;
            });
        });
        if (inheritedOutputSourceId) {
            const resources = nodeResourceItems(dragged).map((resource) => ({ ...resource, mimeType: dragged.metadata?.mimeType }));
            setNodes((prev) => prev.map((node) => transferOrderedGroupH3References(node, inheritedOutputSourceId!, dragged, resources)));
            setConnections((prev) => inheritOrderedGroupOutputs(prev, inheritedOutputSourceId!, draggedId));
        }
        return true;
    }, []);

    const finishNodeDrag = useCallback(
        (clientX?: number, clientY?: number) => {
            const pendingClick = pendingNodeClickRef.current;
            pendingNodeClickRef.current = null;
            if (pendingClick && clientX != null && clientY != null && Math.abs(clientX - pendingClick.clientX) <= 3 && Math.abs(clientY - pendingClick.clientY) <= 3) {
                const clickedNode = nodesRef.current.find((node) => node.id === pendingClick.nodeId);
                const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
                if (clickedNode && clickedNode.type !== CanvasNodeType.Group && !clickedDefinition?.hidePanel) setDialogNodeId(clickedNode.id);
            }
            publishRealtimeDrag(EMPTY_DRAG_PREVIEW);
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            if (!dragRef.current.isDraggingNode) return;

            const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.size === 1;
            const clickedNodeId = dragRef.current.initialSelectedNodes.keys().next().value as string | undefined;
            const currentViewport = viewportRef.current;
            const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
            const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
            const initialPositions = dragRef.current.initialSelectedNodes;
            const previewPositions = dragPreviewPositionsRef.current;

            nodeDraggingRef.current = false;
            setIsNodeDragging(false);
            updateDropTargetGroupId(null);
            const referenceDrag = dragRef.current.referenceDrag;
            const referenceTargetNodeId = dragRef.current.referenceTargetNodeId;
            if (referenceDrag && referenceTargetNodeId && clientX != null && clientY != null) {
                // 角色节点：以单条 character payload 派发，H3 端按 readCharacterGroupFromDrop + upsertCharacterGroup 建/复用组
                if ("characterImages" in referenceDrag) {
                    dispatchCanvasReferenceDrag("canvas-reference-drop", { ...referenceDrag, targetNodeId: referenceTargetNodeId, clientX, clientY });
                    dispatchCanvasReferenceDrag("canvas-reference-drag-end", { ...referenceDrag, targetNodeId: referenceTargetNodeId, clientX, clientY });
                } else {
                    dispatchCanvasReferenceDrag("canvas-reference-drop", { ...referenceDrag, targetNodeId: referenceTargetNodeId, clientX, clientY });
                    dispatchCanvasReferenceDrag("canvas-reference-drag-end", { ...referenceDrag, targetNodeId: referenceTargetNodeId, clientX, clientY });
                }
                dragPreviewPositionsRef.current = EMPTY_DRAG_PREVIEW;
                writeCanvasDragPreview(projectId, EMPTY_DRAG_PREVIEW);
            } else if (dragRef.current.hasMoved && clientX != null && clientY != null) {
                const movedIds = dragRef.current.movedIds;
                const draggedId = movedIds.size === 1 ? [...movedIds][0] : undefined;
                const draggedNode = draggedId ? nodesRef.current.find((node) => node.id === draggedId) : undefined;
                const draggedInitialPosition = draggedId ? initialPositions.get(draggedId) || draggedNode?.position : undefined;
                const pointerPoint = screenToCanvas(clientX, clientY);
                const orderedDropPoint = draggedNode && draggedInitialPosition ? orderedGroupDraggedCenter(draggedInitialPosition, { x: dx, y: dy }, draggedNode) : pointerPoint;
                const orderedHandled = draggedId ? applyOrderedGroupDrop(draggedId, orderedDropPoint) : false;
                if (!orderedHandled) setNodes((prev) => {
                    const moved = prev.map((node) => {
                        const initial = initialPositions.get(node.id);
                        const position = initial ? previewPositions.get(node.id) || { x: initial.x + dx, y: initial.y + dy } : null;
                        return position ? { ...node, position } : node;
                    });
                    const movingGroup = moved.some((node) => movedIds.has(node.id) && node.type === CanvasNodeType.Group);
                    const targetGroup = movingGroup ? null : findGroupDropTarget(movedIds, moved);
                    // 组拖动只移动已记录的组和成员，不重新按矩形命中关系改写成员归属；
                    // 否则有序组移动到普通组附近时，会把成员从 groupSlots 中错误移走。
                    const grouped = movingGroup
                        ? moved.map((node) => {
                              if (node.type !== CanvasNodeType.Group || !node.metadata?.orderedGroup) return node;
                              // 兼容 MCP/旧快照只写 groupId 的有序组：首次拖动时把解析出的成员固化为 slots。
                              return { ...node, metadata: { ...node.metadata, groupSlots: orderedGroupSlots(node, prev) } };
                          })
                        : targetGroup
                          ? snapNodesIntoGroup(movedIds, moved, targetGroup)
                          : moved.map((node) => {
                                if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                                const groupId = findContainingGroupId(node, moved);
                                if (node.metadata?.groupId === groupId) return node;
                                return { ...node, metadata: { ...node.metadata, groupId } };
                            });
                    const movedOutOfOrderedGroups = new Map<string, Set<string>>();
                    prev.forEach((node) => {
                        if (!movedIds.has(node.id) || !node.metadata?.groupId) return;
                        const group = prev.find((item) => item.id === node.metadata?.groupId);
                        if (group?.metadata?.orderedGroup && grouped.find((item) => item.id === node.id)?.metadata?.groupId !== group.id) {
                            const ids = movedOutOfOrderedGroups.get(group.id) || new Set<string>();
                            ids.add(node.id);
                            movedOutOfOrderedGroups.set(group.id, ids);
                        }
                    });
                    const constrained = keepNodesInLockedGroups(movedIds, prev, grouped);
                    const orderedReflows = new Map([...movedOutOfOrderedGroups].flatMap(([groupId, movedOut]) => {
                        const group = prev.find((item) => item.id === groupId);
                        if (!group) return [];
                        const slots = orderedGroupSlots(group, prev).filter((id) => typeof id === "string" && !movedOut.has(id));
                        return [[groupId, { group, slots, displayCount: orderedGroupDisplaySlots(slots, orderedGroupColumnCount(group)).length }] as const];
                    }));
                    return constrained.map((node) => {
                        const ownReflow = orderedReflows.get(node.id);
                        if (ownReflow) return { ...node, metadata: { ...node.metadata, groupSlots: ownReflow.slots } };
                        const memberReflow = node.metadata?.groupId ? orderedReflows.get(node.metadata.groupId) : undefined;
                        if (!memberReflow) return node;
                        const slotIndex = memberReflow.slots.indexOf(node.id);
                        if (slotIndex < 0) return node;
                        const size = orderedGroupMemberSize(memberReflow.group, slotIndex, node, memberReflow.displayCount);
                        return { ...node, position: orderedGroupMemberPosition(memberReflow.group, slotIndex, node, memberReflow.displayCount), width: size.width, height: size.height };
                    });
                });
                dragPreviewPositionsRef.current = EMPTY_DRAG_PREVIEW;
                writeCanvasDragPreview(projectId, EMPTY_DRAG_PREVIEW);
            } else {
                dragPreviewPositionsRef.current = EMPTY_DRAG_PREVIEW;
                writeCanvasDragPreview(projectId, EMPTY_DRAG_PREVIEW);
            }

            dragRef.current.isDraggingNode = false;
            dragRef.current.hasMoved = false;
            dragRef.current.initialSelectedNodes = new Map();
            dragRef.current.movedIds = new Set();
            dragRef.current.hasMovedGroup = false;
            dragRef.current.movingNodes = [];
            dragRef.current.groupDropCandidates = [];
            dragRef.current.referenceDrag = undefined;
            dragRef.current.referenceTargetNodeId = undefined;
            if (wasClick && clickedNodeId) {
                const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
                const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
                if (clickedDefinition?.hidePanel) {
                    // Clicking a display-only plugin node selects it without opening a lower panel.
                    setDialogNodeId((current) => (current === clickedNodeId ? current : null));
                } else if (clickedNode?.type !== CanvasNodeType.Group) {
                    setDialogNodeId(clickedNodeId);
                }
            }
        },
        [applyOrderedGroupDrop, projectId, publishRealtimeDrag, screenToCanvas, updateDropTargetGroupId],
    );

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;
            const bounds = canvasRectRef.current;
            publishRealtimeCursor(
                bounds && event.clientX >= bounds.left && event.clientX <= bounds.left + bounds.width && event.clientY >= bounds.top && event.clientY <= bounds.top + bounds.height ? screenToCanvas(event.clientX, event.clientY) : undefined,
            );

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const pendingClick = pendingNodeClickRef.current;
                if (pendingClick && (Math.abs(event.clientX - pendingClick.clientX) > 3 || Math.abs(event.clientY - pendingClick.clientY) > 3)) pendingNodeClickRef.current = null;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                const movedIds = dragRef.current.movedIds;
                const referenceDrag = dragRef.current.referenceDrag;
                const h3Target = referenceDrag ? h3DropTargetAt(event.clientX, event.clientY) : null;
                if (referenceDrag && h3Target) {
                    if (dragRef.current.referenceTargetNodeId !== h3Target.dataset.canvasRefDropTarget) {
                        if (dragRef.current.referenceTargetNodeId) dispatchCanvasReferenceDrag("canvas-reference-drag-end", { ...referenceDrag, targetNodeId: dragRef.current.referenceTargetNodeId });
                        dragRef.current.referenceTargetNodeId = h3Target.dataset.canvasRefDropTarget;
                        dispatchCanvasReferenceDrag("canvas-reference-drag-start", { ...referenceDrag, targetNodeId: h3Target.dataset.canvasRefDropTarget || "" });
                    }
                    dispatchCanvasReferenceDrag("canvas-reference-drag-over", { ...referenceDrag, targetNodeId: h3Target.dataset.canvasRefDropTarget || "", clientX: event.clientX, clientY: event.clientY });
                    if (rafRef.current) {
                        cancelAnimationFrame(rafRef.current);
                        rafRef.current = null;
                    }
                    dragPreviewPositionsRef.current = EMPTY_DRAG_PREVIEW;
                    writeCanvasDragPreview(projectId, EMPTY_DRAG_PREVIEW);
                    updateDropTargetGroupId(null);
                    return;
                }
                if (referenceDrag && dragRef.current.referenceTargetNodeId) {
                    dispatchCanvasReferenceDrag("canvas-reference-drag-end", { ...referenceDrag, targetNodeId: dragRef.current.referenceTargetNodeId, clientX: event.clientX, clientY: event.clientY });
                    dragRef.current.referenceTargetNodeId = undefined;
                }
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                const groupDropCandidates = {
                    hasMovedGroup: dragRef.current.hasMovedGroup,
                    movingNodes: dragRef.current.movingNodes,
                    groups: dragRef.current.groupDropCandidates,
                };
                rafRef.current = requestAnimationFrame(() => {
                    const previewPositions = new Map<string, Position>();
                    initialPositions.forEach((initial, nodeId) => {
                        const position = { x: initial.x + dx, y: initial.y + dy };
                        previewPositions.set(nodeId, position);
                    });
                    dragPreviewPositionsRef.current = previewPositions;
                    publishRealtimeDrag(previewPositions);
                    writeCanvasDragPreview(projectId, previewPositions);
                    updateDropTargetGroupId(findGroupDropTarget(movedIds, nodesRef.current, previewPositions, groupDropCandidates)?.id || null);
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                scheduleConnectionPreview(event.clientX, event.clientY);
            }
        },
        [finishNodeDrag, projectId, publishRealtimeCursor, publishRealtimeDrag, scheduleConnectionPreview, screenToCanvas],
    );

    const writeSelectionOverlay = useCallback((selection: SelectionBox) => {
        const overlay = selectionOverlayRef.current;
        if (!overlay) return;
        overlay.style.left = `${Math.min(selection.startLocalX, selection.currentLocalX)}px`;
        overlay.style.top = `${Math.min(selection.startLocalY, selection.currentLocalY)}px`;
        overlay.style.width = `${Math.abs(selection.currentLocalX - selection.startLocalX)}px`;
        overlay.style.height = `${Math.abs(selection.currentLocalY - selection.startLocalY)}px`;
    }, []);

    const updateSelectionPreview = useCallback(
        (clientX: number, clientY: number) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            const world = screenToCanvas(clientX, clientY);
            const rect = canvasRectRef.current;
            const localX = clientX - (rect?.left || 0);
            const localY = clientY - (rect?.top || 0);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            queryCanvasSpatialIndex(graphIndex.nodeSpatialIndex, {
                left: rectX,
                top: rectY,
                right: rectX + rectW,
                bottom: rectY + rectH,
            }).forEach((node) => {
                if (!currentSelection.excludeNodeIds?.includes(node.id)) nextSelected.add(node.id);
            });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y, currentLocalX: localX, currentLocalY: localY };
            selectionBoxRef.current = nextSelectionBox;
            // 框选框是临时的 DOM 绘制状态；每帧直接改 SVG 尺寸，避免整张画布随选框重渲染。
            writeSelectionOverlay(nextSelectionBox);
            if (!sameIdSet(selectedNodeIdsRef.current, nextSelected)) {
                selectedNodeIdsRef.current = nextSelected;
                setSelectedNodeIds(nextSelected);
            }
        },
        [graphIndex.nodeSpatialIndex, screenToCanvas, writeSelectionOverlay],
    );

    const flushSelectionFrame = useCallback(() => {
        if (selectionRafRef.current !== null) {
            cancelAnimationFrame(selectionRafRef.current);
            selectionRafRef.current = null;
        }
        const pointer = selectionPointerRef.current;
        if (pointer) updateSelectionPreview(pointer.clientX, pointer.clientY);
    }, [updateSelectionPreview]);

    const finishSelectionBox = useCallback(
        (clientX?: number, clientY?: number) => {
            if (clientX != null && clientY != null) selectionPointerRef.current = { clientX, clientY };
            flushSelectionFrame();
            selectionPointerRef.current = null;
            selectionBoxRef.current = null;
            setSelectionBox(null);
        },
        [flushSelectionFrame],
    );

    const finishCtrlGroupMarquee = useCallback((clientX?: number, clientY?: number, cancelled = false) => {
        const gesture = ctrlGroupMarqueeRef.current;
        if (!gesture) return false;
        ctrlGroupMarqueeRef.current = null;
        if (gesture.started) {
            finishSelectionBox(clientX, clientY);
        } else if (!cancelled) {
            const { soloId } = selectNodeByEvent(gesture, gesture.nodeId);
            const clickedNode = nodesRef.current.find((node) => node.id === gesture.nodeId);
            if (soloId === gesture.nodeId && clickedNode?.type !== CanvasNodeType.Group) {
                const definition = getNodeDefinition(clickedNode?.type || "");
                if (definition?.hidePanel) setDialogNodeId(null);
                else setDialogNodeId(gesture.nodeId);
            }
        }
        return true;
    }, [finishSelectionBox, selectNodeByEvent]);

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const gesture = ctrlGroupMarqueeRef.current;
            if (gesture && !gesture.started && event.buttons !== 0 && (Math.abs(event.clientX - gesture.clientX) > 3 || Math.abs(event.clientY - gesture.clientY) > 3)) {
                if (startSelectionBoxAt(gesture.clientX, gesture.clientY, true, Array.from(selectedNodeIdsRef.current), [gesture.groupId])) {
                    gesture.started = true;
                    setToolbarNodeId(null);
                    setDialogNodeId(null);
                    updateSelectionPreview(event.clientX, event.clientY);
                }
            }
            if (!selectionBoxRef.current) return;
            selectionPointerRef.current = { clientX: event.clientX, clientY: event.clientY };

            if (event.buttons === 0) {
                finishSelectionBox();
                return;
            }

            if (selectionRafRef.current !== null) return;
            selectionRafRef.current = requestAnimationFrame(() => {
                selectionRafRef.current = null;
                const pointer = selectionPointerRef.current;
                if (pointer) updateSelectionPreview(pointer.clientX, pointer.clientY);
            });
        },
        [finishSelectionBox, startSelectionBoxAt, updateSelectionPreview],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            if (!finishCtrlGroupMarquee(event.clientX, event.clientY)) finishSelectionBox(event.clientX, event.clientY);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                flushConnectionPreview(event.clientX, event.clientY);
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    writeActiveConnectionPointer(projectId, screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishCtrlGroupMarquee, finishNodeDrag, finishSelectionBox, flushConnectionPreview, getConnectionDropTarget, projectId, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            if (!finishCtrlGroupMarquee(event.clientX, event.clientY)) finishSelectionBox(event.clientX, event.clientY);
        };
        const cancelNodeDrag = () => {
            finishNodeDrag();
            if (!finishCtrlGroupMarquee(undefined, undefined, true)) finishSelectionBox();
        };
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
            if (selectionRafRef.current !== null) cancelAnimationFrame(selectionRafRef.current);
            selectionRafRef.current = null;
            if (connectionPreviewRafRef.current !== null) cancelAnimationFrame(connectionPreviewRafRef.current);
            connectionPreviewRafRef.current = null;
            connectionPreviewPointerRef.current = null;
        };
    }, [finishCtrlGroupMarquee, finishNodeDrag, finishSelectionBox, handleGlobalMouseMove, handleGlobalPointerMove, handleGlobalMouseUp]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const previewUrl = URL.createObjectURL(file);
        const initialSize = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - initialSize.width / 2, y: position.y - initialSize.height / 2 },
            width: initialSize.width,
            height: initialSize.height,
            metadata: { content: previewUrl, status: NODE_STATUS_LOADING, bytes: file.size, mimeType: file.type || "image/*" },
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
        try {
            const image = await uploadImage(file);
            const size = fitNodeSize(image.width, image.height);
            setNodes((prev) => prev.map((node) => (node.id === id ? { ...node, width: size.width, height: size.height, metadata: { ...node.metadata, ...imageMetadata(image) } } : node)));
            URL.revokeObjectURL(previewUrl);
        } catch (error) {
            const errorDetails = error instanceof Error ? error.message : "图片上传失败";
            setNodes((prev) => prev.map((node) => (node.id === id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
        }
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    // 内部引用拖拽（H3 输出视频 / 侧边栏素材）落库生成节点：复用 storageKey，不重新上传。
    const createNodeFromCanvasRef = useCallback(
        (
            ref: {
                url?: string;
                dataUrl?: string;
                storageKey?: string;
                name?: string;
                type?: string;
                kind?: string;
                width?: number;
                height?: number;
                durationMs?: number;
                bytes?: number;
                mimeType?: string;
                characterAssetId?: string;
                characterName?: string;
                characterDescription?: string;
                characterImages?: Array<{ url: string; storageKey?: string; name: string; outfit: string; outfitDescription: string; width: number; height: number; bytes: number; mimeType: string }>;
                characterPrimaryIndex?: number;
                characterVoiceUrl?: string;
                characterVoiceName?: string;
                characterVoiceDescription?: string;
                characterVoiceStorageKey?: string;
                characterVoiceAssetId?: string;
                sceneAssetId?: string;
                sceneName?: string;
                sceneDescription?: string;
                sceneImage?: { url: string; storageKey?: string; name: string; width: number; height: number; bytes: number; mimeType: string };
                sceneColorCard?: { url: string; storageKey?: string; name: string; width: number; height: number; bytes: number; mimeType: string };
                sceneColorPalette?: string[];
                sceneColorCardPrompt?: string;
                voice?: string;
                voiceName?: string;
                voiceDescription?: string;
                voiceStorageKey?: string;
                voiceAssetId?: string;
            },
            position: Position,
        ) => {
            const type = ref.type || ref.kind || "image";
            // 角色资产拖入：生成 Character 节点（不展开为多张 Image）
            if (type === "character") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Character];
                const characterImages = ref.characterImages || [];
                const title = ref.characterName || ref.name || "角色";
                const id = `character-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const voiceUrl = ref.characterVoiceUrl || ref.voice || "";
                const voiceStorageKey = ref.characterVoiceStorageKey || ref.voiceStorageKey || "";
                const voiceAssetId = ref.characterVoiceAssetId || ref.voiceAssetId || "";
                const voiceAsset = findCharacterVoiceAsset(
                    useAssetStore.getState().assets.filter((asset): asset is AudioAsset => asset.kind === "audio"),
                    { assetId: voiceAssetId, storageKey: voiceStorageKey, url: voiceUrl },
                );
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Character,
                        title,
                        position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                        width: spec.width,
                        height: spec.height,
                        metadata: {
                            status: "success",
                            characterAssetId: ref.characterAssetId,
                            characterName: ref.characterName,
                            characterDescription: ref.characterDescription,
                            characterImages,
                            characterPrimaryIndex: Math.min(Math.max(ref.characterPrimaryIndex || 0, 0), Math.max(characterImages.length - 1, 0)),
                            characterVoiceUrl: voiceUrl || voiceAsset?.data.url || undefined,
                            characterVoiceName: resolveCharacterVoiceName(ref.characterVoiceName || ref.voiceName, voiceAsset) || undefined,
                            characterVoiceDescription: ref.characterVoiceDescription || ref.voiceDescription || undefined,
                            characterVoiceStorageKey: voiceStorageKey || voiceAsset?.data.storageKey || undefined,
                            characterVoiceAssetId: voiceAssetId || voiceAsset?.id || undefined,
                        },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                return;
            }
            if (type === "scene") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Scene];
                const sceneImage = ref.sceneImage;
                if (!sceneImage?.url) return;
                const id = `scene-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                setNodes((prev) => [...prev, {
                    id,
                    type: CanvasNodeType.Scene,
                    title: ref.sceneName || ref.name || "场景",
                    position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                    width: spec.width,
                    height: spec.height,
                    metadata: { status: "success", sceneAssetId: ref.sceneAssetId, sceneName: ref.sceneName, sceneDescription: ref.sceneDescription, sceneImage, sceneColorCard: ref.sceneColorCard, sceneColorPalette: ref.sceneColorPalette, sceneColorCardPrompt: ref.sceneColorCardPrompt },
                }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                return;
            }
            const resolvedUrl = ref.storageKey ? backendMediaUrl(ref.storageKey) : ref.url || ref.dataUrl || "";
            if (!resolvedUrl) return;
            const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            if (type === "video") {
                const size = fitNodeSize(ref.width || 1280, ref.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: ref.name || "视频",
                        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                        width: size.width,
                        height: size.height,
                        metadata: { content: resolvedUrl, storageKey: ref.storageKey, status: "success", naturalWidth: ref.width, naturalHeight: ref.height, bytes: ref.bytes, mimeType: ref.mimeType || "video/mp4", durationMs: ref.durationMs },
                    },
                ]);
            } else if (type === "audio") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Audio,
                        title: ref.name || "音频",
                        position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                        width: spec.width,
                        height: spec.height,
                        metadata: { content: resolvedUrl, storageKey: ref.storageKey, status: "success", bytes: ref.bytes, mimeType: ref.mimeType || "audio/mpeg", durationMs: ref.durationMs },
                    },
                ]);
            } else {
                const size = fitNodeSize(ref.width || 512, ref.height || 512);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Image,
                        title: ref.name || "图片",
                        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                        width: size.width,
                        height: size.height,
                        metadata: { content: resolvedUrl, storageKey: ref.storageKey, status: "success", naturalWidth: ref.width, naturalHeight: ref.height, bytes: ref.bytes, mimeType: ref.mimeType || "image/png" },
                    },
                ]);
            }
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [],
    );

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return false;

        try {
            const items = await navigator.clipboard.read();
            const canvasClipboard = await readCanvasClipboardItem(items);
            if (canvasClipboard) {
                clipboardRef.current = canvasClipboard;
                pasteCopiedNodes();
                return true;
            }
            const imageItem = items.find((item) => findClipboardMediaType(item, "image"));
            if (imageItem) {
                const imageType = findClipboardMediaType(imageItem, "image");
                if (!imageType) return false;
                const blob = await imageItem.getType(imageType);
                const mimeType = imageType.replace(/^web /, "");
                const extension = mimeType.split("/")[1] || "png";
                const file = new File([blob], `clipboard-image.${extension}`, { type: mimeType });
                await createImageFileNode(file, getCanvasCenter());
                message.success(t("canvas.projectPage.clipboardImageAdded"));
                return true;
            }

            const videoItem = items.find((item) => findClipboardMediaType(item, "video"));
            if (videoItem) {
                const videoType = findClipboardMediaType(videoItem, "video");
                if (!videoType) return false;
                const blob = await videoItem.getType(videoType);
                const mimeType = videoType.replace(/^web /, "");
                try {
                    const extension = mimeType.split("/")[1] || "mp4";
                    await createVideoFileNode(new File([blob], `clipboard-video.${extension}`, { type: mimeType }), getCanvasCenter());
                    message.success(t("canvas.projectPage.clipboardVideoAdded"));
                } catch {
                    message.error(t("canvas.projectPage.clipboardPasteFailed"));
                }
                return true;
            }

            const audioItem = items.find((item) => findClipboardMediaType(item, "audio"));
            if (audioItem) {
                const audioType = findClipboardMediaType(audioItem, "audio");
                if (!audioType) return false;
                const blob = await audioItem.getType(audioType);
                const mimeType = audioType.replace(/^web /, "");
                try {
                    const extension = mimeType.split("/")[1] || "mp3";
                    await createAudioFileNode(new File([blob], `clipboard-audio.${extension}`, { type: mimeType }), getCanvasCenter());
                    message.success(t("canvas.projectPage.clipboardAudioAdded"));
                } catch {
                    message.error(t("canvas.projectPage.clipboardPasteFailed"));
                }
                return true;
            }

            const text = await navigator.clipboard.readText();
            if (isLegacyCanvasClipboardText(text)) {
                // 画布剪贴板 JSON（复制兜底时以纯文本进入系统剪贴板）：转成应用内剪贴板后
                // 交给 pasteCopiedNodes 按节点粘贴，绝不能当成普通文本创建文字节点。
                const parsed = parseCanvasClipboard(text);
                if (parsed) clipboardRef.current = parsed;
                return false;
            }
            if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
            return Boolean(text.trim());
        } catch {
            return false;
        }
    }, [createAudioFileNode, createImageFileNode, createTextNodeFromClipboard, createVideoFileNode, getCanvasCenter, message, pasteCopiedNodes, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;
            // 焦点在富文本编辑器（contenteditable / 标记 shortcuts-ignore 的容器，如 H3 主提示词）
            // 但未选中任何文本时，Ctrl/Cmd+C 放行为「复制节点」：否则点完节点（焦点落进编辑器）
            // 再按 Ctrl+C 会毫无反应。有选中文本时仍走浏览器默认复制文本；输入框内永不回落。
            const editorCopyFallback = isModifierShortcut && !event.altKey && key === "c" && !window.getSelection()?.toString() && Boolean(target?.closest("[contenteditable='true'],[data-canvas-shortcuts-ignore]"));
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]") && !editorCopyFallback))
                return;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (localMultiClipboardFallbackRef.current) {
                    pasteCopiedNodes();
                    return;
                }
                void pasteSystemClipboard().then((handled) => {
                    if (!handled) pasteCopiedNodes();
                });
                return;
            }

            // 已移除「按 Delete/Backspace 删除选中节点」的键盘快捷方式：选中节点后误按删除键会直接删掉整个节点且难以恢复（用户明确要求）。
            // 删除节点仍可通过右键菜单 / 节点悬浮工具栏 / 顶部删除按钮等有意操作完成。连线删除保留（风险低、易重连）。
            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        const handleWindowBlur = () => {
            localMultiClipboardFallbackRef.current = false;
        };
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("blur", handleWindowBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("blur", handleWindowBlur);
        };
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            const rect = containerRef.current?.getBoundingClientRect();
            if (rect) canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            writeActiveConnectionPointer(projectId, screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [projectId, screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback(
        (nodeId: string, width: number, height: number, position?: Position) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const bounds = { width, height, position: position || node.position };
            const next = new Map(resizePreviewBoundsRef.current);
            next.set(nodeId, bounds);
            if (node.type === CanvasNodeType.Group && node.metadata?.orderedGroup) {
                orderedGroupResizeLayout(node, bounds, nodesRef.current).forEach((memberBounds, memberId) => next.set(memberId, memberBounds));
            }
            resizePreviewBoundsRef.current = next;
            writeCanvasResizePreview(projectId, next);
        },
        [projectId],
    );

    const handleNodeResizeStart = useCallback(
        (nodeId: string) => {
            resizePreviewBoundsRef.current = EMPTY_RESIZE_PREVIEW;
            writeCanvasResizePreview(projectId, EMPTY_RESIZE_PREVIEW);
            setIsNodeResizing(true);
        },
        [projectId],
    );
    const handleNodeResizeEnd = useCallback(
        (nodeId: string, boundsOverride?: CanvasResizePreviewBounds) => {
            const previewBounds = boundsOverride || resizePreviewBoundsRef.current.get(nodeId);
            if (previewBounds) {
                setNodes((prev) => {
                    const resizedNode = prev.find((node) => node.id === nodeId);
                    if (!resizedNode?.metadata?.orderedGroup || resizedNode.type !== CanvasNodeType.Group) return prev.map((node) => (node.id === nodeId ? { ...node, ...previewBounds } : node));
                    const memberBounds = orderedGroupResizeLayout(resizedNode, previewBounds, prev);
                    return prev.map((node) => {
                        if (node.id === nodeId) return { ...node, ...previewBounds };
                        const bounds = memberBounds.get(node.id);
                        return bounds ? { ...node, ...bounds } : node;
                    });
                });
            }
            resizePreviewBoundsRef.current = EMPTY_RESIZE_PREVIEW;
            writeCanvasResizePreview(projectId, EMPTY_RESIZE_PREVIEW);
            setIsNodeResizing(false);
        },
        [projectId],
    );

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedBatchNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, itemId: string) => {
        const selectedNode = nodesRef.current.find((node) => node.id === nodeId);
        const selectedImage = selectedNode?.metadata?.images?.find((image) => image.id === itemId);
        const snapshot = selectedImage?.generationSnapshot;
        if (selectedNode?.type === CanvasNodeType.Config && selectedNode.metadata?.smart && snapshot) {
            const target = { nodeId, field: "composerContent" as const };
            void (async () => {
                const session = getCanvasTextSession(projectId, target);
                await session.initialize();
                const documentId = session.getDocumentId();
                if (!documentId) return;
                const replaced = await replaceCanvasText(projectId, target, documentId, session.text.toString(), snapshot.prompt);
                if (!replaced) message.warning("提示词正在被协作编辑，未覆盖当前文本");
            })().catch(() => message.error("恢复历史提示词失败"));
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                if (node.type === CanvasNodeType.Character) {
                    const images = node.metadata?.characterImages || [];
                    const nextIndex = images.findIndex((_, idx) => String(idx) === itemId);
                    if (nextIndex < 0) return node;
                    const primary = images[nextIndex];
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            characterPrimaryIndex: nextIndex,
                            content: primary?.url,
                            storageKey: primary?.storageKey,
                            naturalWidth: primary?.width,
                            naturalHeight: primary?.height,
                            bytes: primary?.bytes,
                            mimeType: primary?.mimeType,
                        },
                    };
                }
                if (node.type === CanvasNodeType.Text) {
                    const text = node.metadata?.texts?.find((item) => item.id === itemId);
                    return text?.content ? { ...node, metadata: { ...node.metadata, content: text.content, primaryTextId: text.id } } : node;
                }
                const image = node.metadata?.images?.find((item) => item.id === itemId);
                if (!image?.content) return node;
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, imageConfig.width, imageConfig.height);
                const generation = image.generationSnapshot;
                const historyReferences = generation?.references.map((reference) => reference.storageKey || reference.url || "").filter(Boolean);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                        ...(node.type === CanvasNodeType.Config && node.metadata?.smart ? {
                            activeImageHistoryId: generation ? image.id : null,
                            activeImageHistoryExplicit: Boolean(generation),
                            ...(generation ? {
                                prompt: generation.prompt,
                                model: generation.model,
                                size: generation.size,
                                quality: generation.quality,
                                background: generation.background,
                                count: generation.count,
                                comfyParams: generation.params,
                                generationType: generation.maskEdit || generation.references.length ? "edit" : "generation",
                                generationMode: "image",
                                maskEdit: generation.maskEdit,
                                references: historyReferences,
                            } : {}),
                        } : {}),
                    },
                };
            }),
        );
    }, [message, projectId]);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, imageConfig.width, imageConfig.height);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);


    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        const isSmartGenerationNode = node.type === CanvasNodeType.Config && node.metadata?.smart === true;
        if ((node.type !== CanvasNodeType.Image && !isSmartGenerationNode && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        const outputType = isSmartGenerationNode ? node.metadata?.generationMode || "image" : node.type;
        const extension = outputType === "video" ? "mp4" : outputType === "audio" ? audioExtension(node.metadata.mimeType) : outputType === "text" ? "txt" : imageExtension(node.metadata.content);
        saveAs(node.metadata.content, `canvas-${outputType}-${node.id}.${extension}`);
    }, []);

    const downloadBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        saveAs(image.content, `canvas-image-${node.id}-${image.id}.${imageExtension(image.content)}`);
    }, []);

    const captureVideoNodeFrame = useCallback(
        async (nodeId: string, position: VideoFramePosition) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const video = Array.from(containerRef.current!.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).find((item) => item.dataset.canvasVideo === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content || !video) return message.error(t("canvas.videoFrames.failed"));
            try {
                const image = await uploadImage(await captureVideoFrame(node.metadata.content, position, video.currentTime));
                const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const id = nanoid();
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - size.height / 2;
                while (nodesRef.current.some((item) => item.id !== node.id && item.position.x < x + size.width && item.position.x + item.width > x && item.position.y < y + size.height && item.position.y + item.height > y)) y += size.height + 24;
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    title: t(`canvas.videoFrames.${position}Title`, { name: node.title || t("assets.kinds.video") }),
                    position: { x, y },
                    ...size,
                    metadata: imageMetadata(image),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: id }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                message.success(t("canvas.videoFrames.captured"));
            } catch {
                message.error(t("canvas.videoFrames.failed"));
            }
        },
        [message, t],
    );

    const extractVideoNodeKeyframes = useCallback(
        async (nodeId: string) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content) return message.error(t("canvas.videoFrames.failed"));
            if (extractingKeyframeNodeId) return;
            setExtractingKeyframeNodeId(nodeId);
            // 组壳的 id 必须在 try 外声明：catch 分支要靠它把空壳清掉。
            const groupId = nanoid();
            // 抽首帧也要进生成日志和任务中心：否则用户关掉弹窗就再也看不到这次跑了多久、抽了多少。
            const logStartedAtMs = Date.now();
            let logId: string | null = null;
            // 先建一条 running 记录拿到 id，之后所有状态变化都走更新，不会刷出一串重复日志。
            void createBackendGenerationLog({
                projectId,
                platform: "canvas-video",
                status: "running",
                model: "shot-keyframe-extract",
                prompt: node.metadata.content,
                nodeId: node.id,
                taskMode: "extract-keyframes",
                references: [],
                inputCounts: { video: 1 },
                startedAt: new Date(logStartedAtMs).toISOString(),
                durationMs: 0,
                outputs: [],
                params: { sourceVideoNodeId: node.id },
            })
                .then((created) => {
                    logId = created.log?.id || null;
                })
                .catch(() => {
                    // 日志写失败不该让抽帧本身失败。
                });
            const finishLog = (patch: Record<string, unknown>) => {
                if (!logId) return;
                void updateBackendGenerationLog(logId, { ...patch, durationMs: Date.now() - logStartedAtMs }).catch(() => {});
            };
            // 任务中心读的是 tasks 表，不是日志表，所以再登记一条任务让用户能在那里看到进度。
            // kind 沿用 workbench:* 的纯前端任务形态：只做记录，实际执行在浏览器里。
            const taskId = `extract-keyframes-${nanoid()}`;
            void createBackendTask("workbench:extract-keyframes", { sourceNodeId: node.id }, { projectId, nodeId: node.id }, taskId)
                .then(() => {
                    void updateBackendTask(taskId, { status: "running", progress: 0 }).catch(() => {});
                })
                .catch(() => {});
            const finishTask = (status: "succeeded" | "failed" | "cancelled", progress: number, error?: string) => {
                void updateBackendTask(taskId, { status, progress, ...(error ? { error } : {}) }).catch(() => {});
            };
            try {
                // 先落地一个 loading 状态的组壳：切点检测 + 逐帧上传可能要几十秒，
                // 全程没有任何节点出现的话，用户只能对着画布干等。
                const baseTitle = node.title || t("assets.kinds.video");
                const shell: CanvasNodeData = {
                    id: groupId,
                    type: CanvasNodeType.Group,
                    title: baseTitle,
                    position: { x: node.position.x + node.width + 120, y: node.position.y },
                    width: 280,
                    height: 120,
                    metadata: { status: "loading", runProgress: 0, sourceVideoNodeId: node.id },
                };
                setNodes((prev) => [...prev, shell]);
                setSelectedNodeIds(new Set([groupId]));
                setSelectedConnectionId(null);
                const patchShell = (patch: Partial<CanvasNodeData["metadata"]>) =>
                    setNodes((prev) => prev.map((item) => (item.id === groupId ? { ...item, metadata: { ...item.metadata, ...patch } } : item)));

                const result = await extractShotKeyframes(node.metadata.content, {
                    onProgress: (ratio) => {
                        setKeyframeProgress(ratio);
                        // 检测阶段占前 60%，与后续抽帧上传共用同一条进度条。
                        patchShell({ runProgress: ratio * 0.6 });
                        void updateBackendTask(taskId, { progress: ratio * 0.6 }).catch(() => {});
                    },
                });
                if (!result.blobs.length) {
                    // 什么都没抽到就别留一个空壳在画布上。
                    setNodes((prev) => prev.filter((item) => item.id !== groupId));
                    finishLog({ status: "failed", error: t("canvas.videoFrames.noShots") });
                    finishTask("failed", 0, t("canvas.videoFrames.noShots"));
                    message.warning(t("canvas.videoFrames.noShots"));
                    return;
                }

                const images = await Promise.all(
                    result.blobs.map(async (blob, index) => {
                        const image = await uploadImage(blob);
                        const ratio = 0.6 + ((index + 1) / result.blobs.length) * 0.4;
                        patchShell({ runProgress: ratio });
                        void updateBackendTask(taskId, { progress: ratio }).catch(() => {});
                        return image;
                    }),
                );
                const memberIds = images.map(() => nanoid());
                const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(images.length))));
                const rows = Math.ceil(images.length / columns);
                // 用 fitNodeSize 而不是 NODE_DEFAULT_SIZE：后者是按节点类型分支的联合类型，拿不到数值。
                const cell = fitNodeSize(result.width, result.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const cellWidth = cell.width;
                const cellHeight = cell.height;
                const groupWidth = 48 + columns * cellWidth + Math.max(0, columns - 1) * 14;
                const groupHeight = 52 + rows * cellHeight + Math.max(0, rows - 1) * 14;
                const groupX = node.position.x + node.width + 120;
                const groupY = node.position.y;

                const group: CanvasNodeData = {
                    id: groupId,
                    type: CanvasNodeType.Group,
                    title: t("canvas.videoFrames.shotGroupTitle", { name: baseTitle, count: images.length }),
                    position: { x: groupX, y: groupY },
                    width: groupWidth,
                    height: groupHeight,
                    metadata: {
                        orderedGroup: true,
                        orderedGroupColumns: columns,
                        groupSlots: memberIds,
                        sourceVideoNodeId: node.id,
                        shotCount: images.length,
                    },
                };

                const members: CanvasNodeData[] = images.map((image, index) => {
                    const column = index % columns;
                    const row = Math.floor(index / columns);
                    return {
                        id: memberIds[index],
                        type: CanvasNodeType.Image,
                        title: t("canvas.videoFrames.shotTitle", { index: index + 1 }),
                        position: {
                            x: groupX + 24 + column * (cellWidth + 14),
                            y: groupY + 52 + row * (cellHeight + 14),
                        },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            docType: "shotKeyframe",
                            shotNumber: index + 1,
                            shotTime: result.cuts[index]?.time ?? 0,
                            shotScore: result.cuts[index]?.score ?? 0,
                            sourceVideoNodeId: node.id,
                        },
                    };
                });

                // 组壳已经占位，这里是替换而不是追加，否则会多出一个空壳。
                setNodes((prev) => [...prev.filter((item) => item.id !== groupId), group, ...members]);
                setConnections((prev) => [
                    ...prev.filter((connection) => connection.toNodeId !== groupId),
                    { id: nanoid(), fromNodeId: node.id, toNodeId: groupId },
                    ...memberIds.map((memberId) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: memberId })),
                ]);
                setSelectedNodeIds(new Set([groupId]));
                setSelectedConnectionId(null);
                finishLog({
                    status: "success",
                    outputs: result.cuts.map((cut, index) => ({ type: "image", shotIndex: index + 1, time: cut.time, score: cut.score, nodeId: memberIds[index] })),
                    params: { sourceVideoNodeId: node.id, shotCount: images.length, groupNodeId: groupId },
                });
                finishTask("succeeded", 1);
                message.success(t("canvas.videoFrames.extracted", { count: images.length }));
            } catch (error) {
                // 失败时清掉壳，别在画布上留一个永远转圈的组。
                setNodes((prev) => prev.filter((item) => item.id !== groupId || item.metadata?.orderedGroup));
                const reason = error instanceof Error ? error.message : String(error);
                finishLog({ status: "failed", error: reason });
                finishTask("failed", 0, reason);
                message.error(t("canvas.videoFrames.failed"));
            } finally {
                setExtractingKeyframeNodeId(null);
                setKeyframeProgress(0);
            }
        },
        [extractingKeyframeNodeId, message, projectId, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            const isSmartGenerationNode = node.type === CanvasNodeType.Config && node.metadata?.smart === true;
            const outputType = isSmartGenerationNode ? node.metadata?.generationMode || "image" : node.type;
            if (outputType === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                const dramaId = await getCurrentCanvasDramaId();
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], dramaId, source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (outputType === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                const dramaId = await getCurrentCanvasDramaId();
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    dramaId,
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (outputType === CanvasNodeType.Audio) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
                const dramaId = await getCurrentCanvasDramaId();
                addAsset({
                    kind: "audio",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布音频",
                    coverUrl: "",
                    tags: [],
                    dramaId,
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "audio/mpeg", durationMs: node.metadata.durationMs },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            const dramaId = await getCurrentCanvasDramaId();
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                dramaId,
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, getCurrentCanvasDramaId, message, t],
    );

    // 把当前画布上的图片节点就地转成角色节点：保留位置 / 大小 / 标题，把原图作为
    // character.images 的第一张 outfit（主图），原 metadata 里的 prompt 当作 description。
    const convertImageNodeToCharacter = useCallback(
        (node: CanvasNodeData) => {
            if (!isImageConversionSource(node) || !node.metadata?.content) {
                message.warning(t("canvas.character.convertNoImage"));
                return;
            }
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Character];
            setNodes((prev) =>
                prev.map((item) => {
                    if (item.id !== node.id) return item;
                    const itemMetadata = item.metadata;
                    if (!isImageConversionSource(item) || !itemMetadata?.content) return item;
                    const convertedMetadata = { ...itemMetadata };
                    delete convertedMetadata.smart;
                    delete convertedMetadata.generationMode;
                    return {
                        ...item,
                        type: CanvasNodeType.Character,
                        title: item.title || t("canvas.nodeTypes.character"),
                        width: spec.width,
                        height: spec.height,
                        metadata: {
                            ...convertedMetadata,
                            status: NODE_STATUS_SUCCESS,
                            characterAssetId: undefined,
                            characterName: item.title,
                            characterDescription: typeof item.metadata?.prompt === "string" ? item.metadata.prompt : "",
                            characterImages: [
                                {
                                    url: itemMetadata.content,
                                    storageKey: itemMetadata.storageKey,
                                    name: item.title || "image",
                                    outfit: "",
                                    outfitDescription: "",
                                    width: Number(itemMetadata.naturalWidth) || item.width,
                                    height: Number(itemMetadata.naturalHeight) || item.height,
                                    bytes: Number(itemMetadata.bytes) || 0,
                                    mimeType: itemMetadata.mimeType || "image/png",
                                },
                            ],
                            characterPrimaryIndex: 0,
                        },
                    };
                }),
            );
            message.success(t("canvas.character.converted"));
        },
        [message, t],
    );

    const convertImageNodeToScene = useCallback(
        (node: CanvasNodeData) => {
            if (!isImageConversionSource(node) || !node.metadata?.content) {
                message.warning(t("canvas.scene.convertNoImage"));
                return;
            }
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Scene];
            setNodes((prev) =>
                prev.map((item) => {
                    if (item.id !== node.id) return item;
                    const itemMetadata = item.metadata;
                    if (!isImageConversionSource(item) || !itemMetadata?.content) return item;
                    const convertedMetadata = { ...itemMetadata };
                    delete convertedMetadata.smart;
                    delete convertedMetadata.generationMode;
                    return {
                        ...item,
                        type: CanvasNodeType.Scene,
                        title: item.title || t("canvas.nodeTypes.scene"),
                        width: spec.width,
                        height: spec.height,
                        metadata: {
                            ...convertedMetadata,
                            status: NODE_STATUS_SUCCESS,
                            sceneAssetId: undefined,
                            sceneName: item.title,
                            sceneDescription: typeof item.metadata?.prompt === "string" ? item.metadata.prompt : "",
                            sceneImage: {
                                url: itemMetadata.content,
                                storageKey: itemMetadata.storageKey,
                                name: item.title || "image",
                                width: Number(itemMetadata.naturalWidth) || item.width,
                                height: Number(itemMetadata.naturalHeight) || item.height,
                                bytes: Number(itemMetadata.bytes) || 0,
                                mimeType: itemMetadata.mimeType || "image/png",
                            },
                            sceneColorCard: undefined,
                            sceneColorPalette: undefined,
                            sceneColorCardPrompt: undefined,
                        },
                    };
                }),
            );
            message.success(t("canvas.scene.converted"));
        },
        [message, t],
    );

    // 把拖入的资源（图片/音频）落到角色节点上：图片 -> outfit，音频 -> 声线。
    const dropOnCharacterNode = useCallback((node: CanvasNodeData, ref: { url: string; type: "image" | "audio"; name?: string; storageKey?: string; mimeType?: string }) => {
        if (node.type !== CanvasNodeType.Character) return;
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== node.id) return item;
                if (ref.type === "image") {
                    const images = item.metadata?.characterImages || [];
                    const nextImage: NonNullable<NonNullable<CanvasNodeData["metadata"]>["characterImages"]>[number] = {
                        url: ref.url,
                        storageKey: ref.storageKey,
                        name: ref.name || `outfit-${images.length + 1}`,
                        outfit: "",
                        outfitDescription: "",
                        width: 0,
                        height: 0,
                        bytes: 0,
                        mimeType: ref.mimeType || "image/*",
                    };
                    return {
                        ...item,
                        metadata: { ...item.metadata, characterImages: [...images, nextImage] },
                    };
                }
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        characterVoiceUrl: ref.url,
                        characterVoiceName: ref.name,
                        characterVoiceStorageKey: ref.storageKey,
                        characterVoiceAssetId: undefined,
                    },
                };
            }),
        );
    }, []);

    // 双击角色节点：记录要编辑的节点 id，触发 CharacterNodeEditModal。
    const openCharacterEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Character) return;
        setCharacterImagePickerActive(false);
        setCharacterCanvasImagePick(null);
        setCharacterEditNodeId(node.id);
    }, []);

    const closeCharacterEditor = useCallback(() => {
        setCharacterImagePickerActive(false);
        setCharacterEditNodeId(null);
    }, []);

    const startCharacterImageSelection = useCallback(() => {
        if (!characterEditNodeId) return;
        setCharacterImagePickerActive(true);
        setSelectedNodeIds(new Set([characterEditNodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, [characterEditNodeId]);

    const exitCharacterImageSelection = useCallback(() => {
        setCharacterImagePickerActive(false);
        if (characterEditNodeId) setSelectedNodeIds(new Set([characterEditNodeId]));
    }, [characterEditNodeId]);

    const selectCharacterCanvasImage = useCallback(
        (sourceNodeId: string) => {
            const source = nodesRef.current.find((node) => node.id === sourceNodeId);
            const resource = source ? nodeResourceItems(source).find((item) => item.kind === "image" && item.url) : undefined;
            if (!source || !resource?.url) return;
            setCharacterCanvasImagePick({
                id: nanoid(),
                image: {
                    url: resource.storageKey ? backendMediaUrl(resource.storageKey) : resource.url,
                    storageKey: resource.storageKey,
                    name: source.title || t("canvas.configNode.image"),
                    outfit: "",
                    outfitDescription: "",
                    width: source.metadata?.naturalWidth || source.width,
                    height: source.metadata?.naturalHeight || source.height,
                    bytes: source.metadata?.bytes || 0,
                    mimeType: source.metadata?.mimeType || "image/png",
                },
            });
            setCharacterImagePickerActive(false);
        },
        [t],
    );

    const exitSceneImageSelection = useCallback(() => {
        setSceneImagePickerActive(null);
        if (sceneEditNodeId) setSelectedNodeIds(new Set([sceneEditNodeId]));
    }, [sceneEditNodeId]);

    const selectSceneCanvasImage = useCallback((sourceNodeId: string) => {
        if (!sceneImagePickerActive) return;
        const source = nodesRef.current.find((node) => node.id === sourceNodeId);
        const resource = source ? nodeResourceItems(source).find((item) => item.kind === "image" && item.url) : undefined;
        if (!source || !resource?.url) return;
        setSceneCanvasImagePick({
            id: nanoid(),
            slot: sceneImagePickerActive,
            image: {
                url: resource.storageKey ? backendMediaUrl(resource.storageKey) : resource.url,
                storageKey: resource.storageKey,
                name: source.title || t("canvas.scene.image"),
                width: source.metadata?.naturalWidth || source.width,
                height: source.metadata?.naturalHeight || source.height,
                bytes: source.metadata?.bytes || 0,
                mimeType: source.metadata?.mimeType || "image/png",
            },
        });
        setSceneImagePickerActive(null);
    }, [sceneImagePickerActive, t]);

    const handleSelectReference = useCallback(
        (sourceNodeId: string) => {
            if (pendingVideoComparison) {
                if (!compareCandidateIds.has(sourceNodeId)) return;
                setVideoComparison({ ...pendingVideoComparison, initialSelectedIds: [sourceNodeId] });
                setSelectedNodeIds(new Set([pendingVideoComparison.source.id]));
                setPendingVideoComparison(null);
                return;
            }
            if (characterImagePickerActive) {
                selectCharacterCanvasImage(sourceNodeId);
                return;
            }
            if (sceneImagePickerActive) {
                selectSceneCanvasImage(sourceNodeId);
                return;
            }
            // 插件发起的选参考：不回写画布连线，只把选中节点回抛给插件，由插件写进被点的 ref 槽。
            if (pluginReferencePickNodeId) {
                window.dispatchEvent(new CustomEvent("canvas-reference-pick", { detail: { targetNodeId: pluginReferencePickNodeId, sourceNodeId } }));
                window.dispatchEvent(new CustomEvent("canvas-reference-pick-end", { detail: { targetNodeId: pluginReferencePickNodeId } }));
                setSelectedNodeIds(new Set([pluginReferencePickNodeId]));
                setDialogNodeId(pluginReferencePickNodeId);
                setPluginReferencePickNodeId(null);
                return;
            }
            selectNodeReference(sourceNodeId);
        },
        [characterImagePickerActive, compareCandidateIds, pendingVideoComparison, pluginReferencePickNodeId, sceneImagePickerActive, selectCharacterCanvasImage, selectNodeReference, selectSceneCanvasImage],
    );

    useEffect(() => {
        if (!characterImagePickerActive) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitCharacterImageSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [characterImagePickerActive, exitCharacterImageSelection]);

    useEffect(() => {
        if (!sceneImagePickerActive) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitSceneImageSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitSceneImageSelection, sceneImagePickerActive]);

    const saveCharacterEdit = useCallback(
        (patch: {
            title: string;
            characterName: string;
            characterDescription: string;
            characterImages: CanvasNodeMetadata["characterImages"];
            characterPrimaryIndex: number;
            characterVoiceUrl: string;
            characterVoiceName: string;
            characterVoiceDescription: string;
            characterVoiceStorageKey: string;
            characterVoiceAssetId: string;
        }) => {
            if (!characterEditNodeId) return;
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === characterEditNodeId
                        ? {
                              ...item,
                              title: patch.title,
                              metadata: {
                                  ...item.metadata,
                                  characterName: patch.characterName,
                                  characterDescription: patch.characterDescription,
                                  characterImages: patch.characterImages,
                                  characterPrimaryIndex: patch.characterPrimaryIndex,
                                  characterVoiceUrl: patch.characterVoiceUrl || undefined,
                                  characterVoiceName: patch.characterVoiceName || undefined,
                                  characterVoiceDescription: patch.characterVoiceDescription || undefined,
                                  characterVoiceStorageKey: patch.characterVoiceStorageKey || undefined,
                                  characterVoiceAssetId: patch.characterVoiceAssetId || undefined,
                              },
                          }
                        : item,
                ),
            );
        },
        [characterEditNodeId, setNodes],
    );

    // 单个角色节点保存为角色资产：按 name 去重（同名就替换，否则新建）。
    const saveCharacterNodeToAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Character) return;
            const images = node.metadata?.characterImages || [];
            const voiceUrl = node.metadata?.characterVoiceUrl || "";
            const voiceStorageKey = node.metadata?.characterVoiceStorageKey || "";
            if (!images.length && !voiceUrl && !voiceStorageKey) {
                message.warning(t("assets.characterRequireReference"));
                return;
            }
            const name = (node.title || "").trim();
            if (!name) {
                message.warning(t("canvas.character.saveNameRequired"));
                return;
            }
            const existing = useAssetStore.getState().assets.find((asset) => asset.kind === "character" && asset.id === node.metadata?.characterAssetId)
                || useAssetStore.getState().assets.find((asset) => asset.kind === "character" && (asset.data.name || asset.title) === name);
            const voiceAssetId = node.metadata?.characterVoiceAssetId || "";
            const voiceAsset = findCharacterVoiceAsset(
                useAssetStore.getState().assets.filter((asset): asset is AudioAsset => asset.kind === "audio"),
                { assetId: voiceAssetId, storageKey: voiceStorageKey, url: voiceUrl },
            );
            const assetPrimaryIndex = images.length
                ? existing?.kind === "character"
                    ? retainCharacterPrimaryIndex(existing.data.images, existing.data.primaryIndex || 0, images)
                    : Math.min(Math.max(node.metadata?.characterPrimaryIndex || 0, 0), images.length - 1)
                : 0;
            const coverUrl = images[assetPrimaryIndex]?.url || "";
            const data = {
                name,
                englishName: node.metadata?.characterEnglishName || "",
                description: node.metadata?.characterDescription || "",
                voice: voiceUrl || voiceAsset?.data.url || "",
                voiceName: resolveCharacterVoiceName(node.metadata?.characterVoiceName, voiceAsset),
                voiceDescription: node.metadata?.characterVoiceDescription || "",
                voiceStorageKey: voiceStorageKey || voiceAsset?.data.storageKey,
                voiceAssetId: voiceAssetId || voiceAsset?.id || "",
                images,
                primaryIndex: assetPrimaryIndex,
            };
            try {
                const dramaId = await getCurrentCanvasDramaId();
                let assetId = existing?.id;
                if (existing) {
                    useAssetStore.getState().updateAsset(existing.id, {
                        title: name,
                        coverUrl,
                        ...(dramaId ? { dramaId } : {}),
                        data,
                        metadata: { source: "canvas", projectId, nodeId: node.id, replaced: true },
                    });
                } else {
                    assetId = useAssetStore.getState().addAsset({
                        kind: "character",
                        title: name,
                        coverUrl,
                        tags: [],
                        dramaId,
                        source: "Canvas",
                        data,
                        metadata: { source: "canvas", projectId, nodeId: node.id },
                    });
                }
                setNodes((prev) => prev.map((item) => item.id === node.id
                    ? { ...item, metadata: { ...item.metadata, characterAssetId: assetId } }
                    : item));
                message.success(t("canvas.character.saveToAssetsSuccess"));
            } catch (error) {
                const message_ = error instanceof Error ? error.message : String(error);
                message.error(t("canvas.character.saveToAssetsFailed", { error: message_ }));
            }
        },
        [getCurrentCanvasDramaId, message, projectId, setNodes, t],
    );

    const openSceneEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Scene) return;
        setSceneImagePickerActive(null);
        setSceneCanvasImagePick(null);
        setSceneEditNodeId(node.id);
    }, []);

    const closeSceneEditor = useCallback(() => {
        setSceneImagePickerActive(null);
        setSceneCanvasImagePick(null);
        setSceneEditNodeId(null);
    }, []);

    const startSceneImageSelection = useCallback((slot: "image" | "colorCard") => {
        if (!sceneEditNodeId) return;
        setSceneImagePickerActive(slot);
        setSelectedNodeIds(new Set([sceneEditNodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, [sceneEditNodeId]);

    const saveSceneEdit = useCallback((patch: { title: string; sceneName: string; sceneDescription: string; sceneImage: NonNullable<CanvasNodeMetadata["sceneImage"]>; sceneColorCard?: NonNullable<CanvasNodeMetadata["sceneColorCard"]>; sceneColorPalette?: string[]; sceneColorCardPrompt: string }) => {
        if (!sceneEditNodeId) return;
        setNodes((prev) => prev.map((item) => item.id === sceneEditNodeId ? {
            ...item,
            title: patch.title,
            metadata: { ...item.metadata, sceneName: patch.sceneName, sceneDescription: patch.sceneDescription, sceneImage: patch.sceneImage, sceneColorCard: patch.sceneColorCard, sceneColorPalette: patch.sceneColorPalette, sceneColorCardPrompt: patch.sceneColorCardPrompt },
        } : item));
    }, [sceneEditNodeId]);

    const saveSceneNodeToAsset = useCallback(async (node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Scene) return;
        const image = node.metadata?.sceneImage;
        if (!image?.url) {
            message.warning(t("assets.sceneRequireImage"));
            return;
        }
        const name = (node.title || "").trim();
        if (!name) {
            message.warning(t("canvas.scene.saveNameRequired"));
            return;
        }
        const existing = useAssetStore.getState().assets.find((asset) => asset.kind === "scene" && (asset.data.name || asset.title) === name);
        const data = { name, description: node.metadata?.sceneDescription || "", image, colorCard: node.metadata?.sceneColorCard, colorPalette: node.metadata?.sceneColorPalette, colorCardPrompt: node.metadata?.sceneColorCardPrompt || "" };
        try {
            const dramaId = await getCurrentCanvasDramaId();
            if (existing) {
                useAssetStore.getState().updateAsset(existing.id, { title: name, coverUrl: image.url, ...(dramaId ? { dramaId } : {}), data, metadata: { source: "canvas", nodeId: node.id, replaced: true } });
            } else {
                useAssetStore.getState().addAsset({ kind: "scene", title: name, coverUrl: image.url, tags: [], dramaId, source: "Canvas", data, metadata: { source: "canvas", nodeId: node.id } });
            }
            message.success(t("canvas.scene.saveToAssetsSuccess"));
        } catch (error) {
            message.error(t("canvas.scene.saveToAssetsFailed", { error: error instanceof Error ? error.message : String(error) }));
        }
    }, [getCurrentCanvasDramaId, message, t]);

    const dropOnSceneNode = useCallback((node: CanvasNodeData, ref: { url: string; name?: string; storageKey?: string; mimeType?: string }) => {
        if (node.type !== CanvasNodeType.Scene || !ref.url) return;
        setNodes((prev) => prev.map((item) => item.id === node.id ? {
            ...item,
            metadata: { ...item.metadata, sceneImage: item.metadata?.sceneImage || { url: ref.url, storageKey: ref.storageKey, name: ref.name || "scene", width: 0, height: 0, bytes: 0, mimeType: ref.mimeType || "image/*" } },
        } : item));
    }, []);

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(
                    CanvasNodeType.Text,
                    { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY },
                    { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 },
                ),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (payload.generate && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = t("canvas.projectPage.maskPrompt", { source: imageReferenceLabel(0), mask: imageReferenceLabel(1), prompt: userPrompt });
            setMaskEditNodeId(null);
            const maskImage = await uploadImage(payload.maskDataUrl);
            const maskNodeId = nanoid();
            const childId = nanoid();
            const imageId = nanoid();
            const configNodeSize = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const maskSource = { id: maskNodeId, name: "mask.png", type: maskImage.mimeType || "image/png", dataUrl: maskImage.url, storageKey: maskImage.storageKey };
            const references = [source, maskSource];
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            const childMetadata: CanvasNodeMetadata = { smart: true, generationMode: "image", maskEdit: true, prompt, composerContent: prompt, status: NODE_STATUS_IDLE, ...(payload.generate ? { images: [{ id: imageId, status: NODE_STATUS_IDLE, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }] } : {}), ...generationMetadata };
            const nextNodes: CanvasNodeData[] = [
                ...nodesRef.current,
                {
                    id: maskNodeId,
                    type: CanvasNodeType.Image,
                    title: t("canvas.projectPage.maskNodeTitle"),
                    position: { x: node.position.x, y: node.position.y + node.height + 96 },
                    width: node.width,
                    height: node.height,
                    metadata: { ...imageMetadata(maskImage), maskOverlay: true },
                },
                {
                    id: childId,
                    type: CanvasNodeType.Config,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: configNodeSize.width,
                    height: configNodeSize.height,
                    metadata: childMetadata,
                },
            ];
            const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }, { id: nanoid(), fromNodeId: maskNodeId, toNodeId: childId }];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            if (!payload.generate) return;
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                await flushCanvasProjectBeforeGeneration(projectId);
                const size = resolveComfyImageSize(generationConfig.size);
                await runCanvasImageTask(
                    {
                        mode: "image",
                        maskEdit: true,
                        model: generationConfig.model,
                        prompt,
                        references,
                        ...size,
                        size: `${size.width}x${size.height}`,
                        quality: generationConfig.quality,
                        count: 1,
                        imageIds: [imageId],
                        params: node.metadata?.comfyParams,
                        clientTaskId: crypto.randomUUID(),
                        projectId,
                        nodeId: childId,
                        sourceNodeId: node.id,
                    },
                    controller.signal,
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, flushCanvasProjectBeforeGeneration, isAiConfigReady, message, openConfigDialog, projectId, startGenerationRequest, t, updateProject],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, []);

    const autoLevelsImageNode = useCallback(async (node: CanvasNodeData) => {
        const content = String(node.metadata?.content || "");
        const storageKey = String(node.metadata?.storageKey || "");
        if (!content && !storageKey) return;
        const activeRequest = generationRequestsRef.current.get(node.id);
        if (activeRequest && !activeRequest.controller.signal.aborted) return;
        const reference = {
            id: node.id,
            name: `${node.title || node.id}.png`,
            mimeType: node.metadata?.mimeType && !node.metadata.mimeType.endsWith("/*") ? node.metadata.mimeType : "image/png",
            ...(storageKey ? { storageKey } : {}),
            ...(content.startsWith("data:") ? { dataUrl: content } : /^(https?:\/\/|\/media\/)/.test(content) ? { url: content } : {}),
        };
        if (!storageKey && !("dataUrl" in reference) && !("url" in reference)) {
            message.error(t("canvas.projectPage.generationFailed"));
            return;
        }
        const controller = startGenerationRequest(node.id, node.id, node.id);
        setRunningNodeId(node.id);
        try {
            await flushCanvasProjectBeforeGeneration(projectId);
            await runCanvasImageTask(
                {
                    mode: "image",
                    model: "moyou-自动色阶",
                    prompt: t("canvas.imageTools.autoLevels"),
                    references: [reference],
                    count: 1,
                    clientTaskId: crypto.randomUUID(),
                    projectId,
                    nodeId: node.id,
                    sourceNodeId: node.id,
                },
                controller.signal,
            );
        } catch (error) {
            if (!isGenerationCanceled(error)) {
                message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
            }
        } finally {
            const isCurrentRequest = generationRequestsRef.current.get(node.id)?.controller === controller;
            finishGenerationRequest(node.id, controller);
            if (isCurrentRequest) setRunningNodeId(null);
        }
    }, [finishGenerationRequest, flushCanvasProjectBeforeGeneration, message, projectId, startGenerationRequest, t]);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const imageId = nanoid();
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            const nextNodes: CanvasNodeData[] = [
                ...nodesRef.current,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_IDLE, images: [{ id: imageId, status: NODE_STATUS_IDLE, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }], ...generationMetadata },
                },
            ];
            const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const references = [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }];
                await flushCanvasProjectBeforeGeneration(projectId);
                const size = resolveComfyImageSize(generationConfig.size);
                await runCanvasImageTask(
                    {
                        mode: "image",
                        model: generationConfig.model,
                        prompt,
                        references,
                        ...size,
                        size: `${size.width}x${size.height}`,
                        quality: generationConfig.quality,
                        count: 1,
                        imageIds: [imageId],
                        params: node.metadata?.comfyParams,
                        clientTaskId: crypto.randomUUID(),
                        projectId,
                        nodeId: childId,
                        sourceNodeId: node.id,
                    },
                    controller.signal,
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, flushCanvasProjectBeforeGeneration, openConfigDialog, projectId, startGenerationRequest, t, updateProject],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        // 上传入口可能从“添加参考”状态下触发；先退出参考选择，避免上传后仍被锁在选择模式。
        setReferencePickerNodeId(null);
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f));
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const previewUrl = URL.createObjectURL(first);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? { ...node, title: first.name, metadata: { ...node.metadata, content: previewUrl, storageKey: undefined, status: NODE_STATUS_LOADING, errorDetails: undefined, bytes: first.size, mimeType: first.type || "image/*" } }
                                : node,
                        ),
                    );
                    try {
                        const image = await uploadImage(first);
                        const s = fitNodeSize(image.width, image.height);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === target.nodeId
                                    ? {
                                          ...node,
                                          type: CanvasNodeType.Image,
                                          title: first.name,
                                          width: s.width,
                                          height: s.height,
                                          metadata: {
                                              ...node.metadata,
                                              ...imageMetadata(image),
                                              errorDetails: undefined,
                                              freeResize: false,
                                              images: undefined,
                                              generationType: undefined,
                                              model: undefined,
                                              size: undefined,
                                              quality: undefined,
                                              count: undefined,
                                              references: undefined,
                                              primaryImageId: undefined,
                                          },
                                      }
                                    : node,
                            ),
                        );
                        URL.revokeObjectURL(previewUrl);
                        setSelectedNodeIds(new Set([target.nodeId]));
                        setSelectedConnectionId(null);
                    } catch (error) {
                        setNodes((prev) => prev.map((node) => (node.id === target.nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: error instanceof Error ? error.message : "图片上传失败" } } : node)));
                    }
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            if (event.dataTransfer.types.includes("application/x-smart-storyboard-slot")) return;

            // 内部引用拖拽：H3 输出视频 / 侧边栏素材 → 直接落库生成节点（复用 storageKey，不重新上传）
            const refPayload = event.dataTransfer.getData("application/x-infinite-canvas-ref");
            if (refPayload) {
                try {
                    const ref = JSON.parse(refPayload) as Parameters<typeof createNodeFromCanvasRef>[0];
                    if (ref.type === "character" || ref.kind === "character" || ref.url || ref.dataUrl || ref.storageKey) {
                        createNodeFromCanvasRef(ref, screenToCanvas(event.clientX, event.clientY));
                        return;
                    }
                } catch {
                    // 解析失败则继续走外部文件逻辑
                }
            }

            const files = Array.from(event.dataTransfer.files).filter((item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item));
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, createNodeFromCanvasRef, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-node-id],[data-connection-id]")) return;
        event.preventDefault();
        setContextMenu(null);
        if (target.closest("[data-canvas-no-zoom],[data-connection-create-menu]")) return;
        if (refPickActive || characterImagePickerActive) return;
        setNodeCreatePosition(null);
        setPendingConnectionCreate({ connection: null, position: screenToCanvas(event.clientX, event.clientY) });
    }, [characterImagePickerActive, refPickActive, screenToCanvas]);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, loopContext?: CanvasLoopRuntimeContext) => {
            // 同一源节点已有生成请求时，重复点击/重复事件只复用当前请求，
            // 不再新建结果节点，也不向 Backend 再提交一次模型任务。
            const requestKey = loopContext ? `${nodeId}:loop:${loopContext.nodeId}:${loopContext.index}` : nodeId;
            const activeRequest = generationRequestsRef.current.get(requestKey)
                || (!loopContext ? [...generationRequestsRef.current.values()].find((request) => request.originNodeId === nodeId && !request.controller.signal.aborted) : undefined);
            if (activeRequest && !activeRequest.controller.signal.aborted) {
                if (loopContext) throw new Error("下游节点已有生成任务，循环无法继续");
                return;
            }
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            if (loopContext && !sourceNode) throw new Error("循环下游节点已不存在");
            const initialNode = loopContext?.initialNodes?.get(nodeId) || sourceNode;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, sourceNode, mode), ...(loopContext ? { count: "1" } : {}) };
            if (generationConfig.model !== VIDEO_CONCAT_MODEL && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                if (loopContext) throw new Error("下游节点的模型配置不可用");
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) {
                    if (loopContext) throw new Error("下游节点缺少提示词");
                    return;
                }
                if (!loopContext) setRunningNodeId(nodeId);
                const controller = startGenerationRequest(requestKey, nodeId, nodeId);
                const unlinkLoopAbort = linkLoopAbort(loopContext?.signal, controller);
                const nextNodes = nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node));
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
                updateProject(projectId, { nodes: nextNodes });
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    const context = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, fullPrompt, undefined, loopContext));
                    const refs = context.referenceImages;
                    await flushCanvasProjectBeforeGeneration(projectId);
                    const size = resolveComfyImageSize(generationConfig.size);
                    const task = await runCanvasImageTask(
                        {
                            mode: "image",
                            model: generationConfig.model,
                            prompt: context.prompt,
                            references: refs,
                            ...(context.loopInputImages.length ? { loopInputImages: context.loopInputImages } : {}),
                            ...size,
                            size: `${size.width}x${size.height}`,
                            quality: generationConfig.quality,
                            count: 1,
                            params: { ...(sourceNode.metadata?.comfyParams || {}), writeBackToTarget: true },
                            clientTaskId: crypto.randomUUID(),
                            projectId,
                            nodeId,
                            sourceNodeId: nodeId,
                        },
                        controller.signal,
                    );
                    recordLoopGenerationOutput(loopContext, sourceNode, "image", task);
                    setDialogNodeId(null);
                } catch (error) {
                    if (loopContext) throw error;
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                    }
                } finally {
                    unlinkLoopAbort();
                    finishGenerationRequest(requestKey, controller);
                }
                return;
            }

            if (!loopContext) setRunningNodeId(nodeId);
            const runController = startGenerationRequest(requestKey, nodeId, nodeId);
            const unlinkLoopAbort = linkLoopAbort(loopContext?.signal, runController);
            try {
                const sourceTextContent = initialNode?.type === CanvasNodeType.Text ? initialNode.metadata?.content?.trim() || "" : "";
                const editingTextNode = !loopContext && mode === "text" && Boolean(sourceTextContent);
                const rawGenerationContext = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt, undefined, loopContext);
                const activeImageHistory = !loopContext && mode === "image" && sourceNode?.type === CanvasNodeType.Config && sourceNode.metadata?.smart && sourceNode.metadata.activeImageHistoryExplicit === true && sourceNode.metadata.activeImageHistoryId
                    ? sourceNode.metadata.images?.find((image) => image.id === sourceNode.metadata?.activeImageHistoryId)?.generationSnapshot
                    : undefined;
                const generationContext = activeImageHistory ? rawGenerationContext : await hydrateNodeGenerationContext(rawGenerationContext);
                const effectivePrompt = (activeImageHistory && activeImageHistory.prompt.trim() === prompt.trim()
                    ? activeImageHistory.effectivePrompt
                    : generationContext.prompt).trim();
                if (runController.signal.aborted) return;
                if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                    if (loopContext) throw new Error("下游节点缺少提示词");
                    return;
                }
                if (mode === "image") {
                    if (loopContext?.loopOutput && generationContext.referenceVideos.length) throw new Error(t("canvas.loopNode.videoToImageUnsupported"));
                    const count = getGenerationCount(generationConfig.count);
                    const isImageNode = initialNode?.type === CanvasNodeType.Image;
                    const sourceReference =
                        isImageNode && !loopContext && initialNode?.metadata?.content
                            ? [{ id: initialNode.id, name: `${initialNode.title || initialNode.id}.png`, type: initialNode.metadata.mimeType || "image/png", dataUrl: initialNode.metadata.content, storageKey: initialNode.metadata.storageKey }]
                            : [];
                    const referenceImages = activeImageHistory
                        ? resolveImageGenerationReferences(activeImageHistory.references)
                        : [...new Map([...sourceReference, ...generationContext.referenceImages].map((image) => [image.id, image])).values()];
                    // 工作流路由、场景默认参数和渠道凭据由 Backend 统一解析；前端只提交节点手填参数。
                    const comfyParams = sourceNode?.metadata?.comfyParams;
                    // 稳定请求 ID 同时决定 Backend 创建的结果节点 ID；网页不再自行创建占位节点。
                    const clientTaskId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                    await flushCanvasProjectBeforeGeneration(projectId);
                    if (!loopContext) {
                        setSelectedNodeIds(new Set([nodeId]));
                        setSelectedConnectionId(null);
                        setDialogNodeId(nodeId);
                    }
                    const size = resolveComfyImageSize(generationConfig.size);
                    const task = await runCanvasImageTask(
                        {
                            mode: "image",
                            ...(sourceNode?.metadata?.maskEdit ? { maskEdit: true } : {}),
                            model: generationConfig.model,
                            prompt: effectivePrompt,
                            references: referenceImages,
                            ...(generationContext.loopInputImages.length ? { loopInputImages: generationContext.loopInputImages } : {}),
                            ...size,
                            size: `${size.width}x${size.height}`,
                            quality: generationConfig.quality,
                            count: loopContext ? 1 : count,
                            ...(loopContext?.loopOutput ? { loopOutput: loopContext.loopOutput } : {}),
                            params: comfyParams,
                            ...(sourceNode?.type === CanvasNodeType.Config && sourceNode.metadata?.smart ? {
                                historySnapshot: { prompt, size: generationConfig.size, background: generationConfig.background, maskEdit: sourceNode.metadata.maskEdit },
                            } : {}),
                            clientTaskId,
                            projectId,
                            nodeId,
                            sourceNodeId: nodeId,
                        },
                        runController.signal,
                    );
                    if (sourceNode) recordLoopGenerationOutput(loopContext, sourceNode, "image", task);
                    return;
                }

                if (mode === "video") {
                    if (generationConfig.model === VIDEO_CONCAT_MODEL && generationContext.referenceVideos.length < 2) {
                        throw new Error("视频拼接至少需要连接两个视频");
                    }
                    // 首次生成、结果节点创建与重试统一由 Backend；自定义脚本再由唯一浏览器认领执行。
                    const clientTaskId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
                    await flushCanvasProjectBeforeGeneration(projectId);
                    const task = await runCanvasVideoTask(
                        {
                            mode: "video",
                            model: generationConfig.model,
                            prompt: effectivePrompt,
                            references: generationContext.referenceImages,
                            videoReferences: generationContext.referenceVideos.map((item) => ({ id: item.id, name: item.name, url: item.url, storageKey: item.storageKey, mimeType: item.type })),
                            ...(loopContext?.loopOutput ? { loopOutput: loopContext.loopOutput } : {}),
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            resolution: generationConfig.vquality,
                            params: sourceNode?.metadata?.comfyParams,
                            clientTaskId,
                            projectId,
                            nodeId,
                            sourceNodeId: nodeId,
                        },
                        runController.signal,
                    );
                    if (sourceNode) recordLoopGenerationOutput(loopContext, sourceNode, "video", task);
                    return;
                }

                if (mode === "audio") {
                    const clientTaskId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
                    await flushCanvasProjectBeforeGeneration(projectId);
                    const task = await runCanvasAudioTask(
                        {
                            mode: "audio",
                            model: generationConfig.model,
                            prompt: effectivePrompt,
                            audioReferences: generationContext.referenceAudios.map((item) => ({ id: item.id, name: item.name, url: item.url, storageKey: item.storageKey, mimeType: item.type })),
                            params: { voice: generationConfig.audioVoice, format: generationConfig.audioFormat, speed: generationConfig.audioSpeed, instructions: generationConfig.audioInstructions },
                            clientTaskId,
                            projectId,
                            nodeId,
                            sourceNodeId: nodeId,
                        },
                        runController.signal,
                    );
                    if (sourceNode) recordLoopGenerationOutput(loopContext, sourceNode, "audio", task);
                    return;
                }

                if (mode === "text") {
                    await flushCanvasProjectBeforeGeneration(projectId);
                    const task = await runCanvasTextTask(
                        {
                            mode: "text",
                            model: generationConfig.model,
                            prompt: effectivePrompt,
                            count: loopContext ? 1 : getGenerationCount(String(sourceNode?.metadata?.textCount || 1)),
                            references: generationContext.referenceImages,
                            params: { systemPrompt: generationConfig.systemPrompt, reasoningEffort: generationConfig.reasoningEffort, ...(sourceNode?.type === CanvasNodeType.Config && sourceNode.metadata?.smart ? { targetTextNodeId: nodeId } : {}) },
                            projectId,
                            nodeId,
                            sourceNodeId: nodeId,
                            resultPolicy: "replace-active",
                            clientTaskId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined,
                        },
                        runController.signal,
                    );
                    if (sourceNode) recordLoopGenerationOutput(loopContext, sourceNode, "text", task);
                    return;
                }
            } catch (error) {
                if (loopContext) throw error;
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
            } finally {
                unlinkLoopAbort();
                finishGenerationRequest(requestKey, runController);
                if (!loopContext) setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );
    const runLoop = useCallback(
        async (loopNodeId: string) => {
            if (loopAbortRef.current) return;
            const loopNode = nodesRef.current.find((node) => node.id === loopNodeId);
            if (!loopNode || loopNode.type !== CanvasNodeType.Loop) return;
            const metadata = loopNode.metadata || {};
            let stages: CanvasNodeData[][];
            try {
                stages = buildLoopGenerationStages(loopNodeId, nodesRef.current, connectionsRef.current, isLoopGenerationTarget);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                return;
            }
            if (!stages.length) {
                // 不再强制要求先手动连下游：运行时自动补一个输出节点并连线。
                const created = createLoopFallbackOutput(loopNodeId, loopNode, (type, position) => createCanvasNode(type, position), {
                    x: Number(loopNode.position?.x || 0) + Number(loopNode.width || 340) + 120,
                    y: Number(loopNode.position?.y || 0),
                });
                setNodes((prev) => [...prev, created.node]);
                setConnections((prev) => [...prev, created.connection]);
                nodesRef.current = [...nodesRef.current, created.node];
                connectionsRef.current = [...connectionsRef.current, created.connection];
                stages = buildLoopGenerationStages(loopNodeId, nodesRef.current, connectionsRef.current, isLoopGenerationTarget);
                if (!stages.length) {
                    message.warning(t("canvas.loopNode.noInput"));
                    return;
                }
            }
            const mediaChain = stages.every((stage) => stage.every((target) => {
                const mode = generationModeForLoopTarget(target);
                return (mode === "image" && (target.type === CanvasNodeType.Image || target.type === CanvasNodeType.Config && target.metadata?.smart === true) && !target.metadata?.maskEdit)
                    || (mode === "video" && (target.type === CanvasNodeType.Video || target.type === CanvasNodeType.Config && target.metadata?.smart === true));
            }));
            if (metadata.loopMode === "parallel" && !mediaChain) {
                message.warning(t("canvas.loopNode.parallelMediaOnly"));
                return;
            }
            const inputs = buildLoopSourceInputs(loopNodeId, nodesRef.current, connectionsRef.current)
                .flatMap((input) => input.type === "group" ? input.children : [input]);
            const imageCount = inputs.filter((input) => input.type === "image").length;
            const videoCount = inputs.filter((input) => input.type === "video").length;
            const plan = resolveLoopInputPlan(metadata, imageCount, videoCount);
            const mediaKinds = new Set(inputs.filter((input) => input.type === "image" || input.type === "video").map((input) => input.type));
            if (mediaKinds.has("image") && mediaKinds.has("video")) {
                message.warning(t("canvas.loopNode.mixedMedia"));
                return;
            }
            if ((plan.mediaKind === "image" && mediaKinds.has("video")) || (plan.mediaKind === "video" && mediaKinds.has("image"))) {
                message.warning(t("canvas.loopNode.mediaMismatch"));
                return;
            }
            if (plan.mediaKind && plan.rounds === 0) {
                message.warning(t("canvas.loopNode.noMediaAtStart"));
                return;
            }
            const hasInput = Boolean(metadata.loopPromptEnabled && ((metadata.loopPrompts !== undefined ? metadata.loopPrompts.some((value) => value.trim()) : metadata.loopPrompt?.trim()) || inputs.some((input) => input.type === "text")))
                || Boolean(plan.mediaKind && plan.sourceCount)
                || stages.some((stage) => stage.some((target) => Boolean(target.metadata?.prompt?.trim() || target.metadata?.composerContent?.trim() || buildNodeGenerationInputs(target.id, nodesRef.current, connectionsRef.current).length)));
            if (!hasInput) {
                message.warning(t("canvas.loopNode.noInput"));
                return;
            }
            const total = plan.rounds;
            const start = plan.start;
            const batchSize = plan.batchSize;
            const end = start + (total - 1) * batchSize;
            const controller = new AbortController();
            const initialNodes = new Map(nodesRef.current.map((node) => [node.id, node]));
            loopAbortRef.current = controller;
            setRunningLoopId(loopNodeId);
            setLoopProgress({ current: 0, total });
            try {
                for (const target of stages[0] || []) {
                    if (generationModeForLoopTarget(target) !== "image") continue;
                    const model = buildGenerationConfig(effectiveConfig, target, "image").model;
                    if (resolveModelChannel(effectiveConfig, model).kind !== "comfyui") continue;
                    const prompt = target.metadata?.composerContent ?? target.metadata?.prompt ?? "";
                    const context = buildNodeGenerationContext(target.id, nodesRef.current, connectionsRef.current, prompt, undefined, { index: 0, total, nodeId: loopNodeId });
                    const requiredImages = context.loopInputImages.length + context.referenceImages.length;
                    const workflowName = resolveModelWorkflow(effectiveConfig, model, requiredImages);
                    if (!workflowName) continue;
                    const detail = await fetchWorkflowDetail(workflowName);
                    const availableImages = (detail.config?.fields || []).filter((field) => isWorkflowImageField(field, detail.workflow)).length;
                    if (requiredImages > availableImages) throw new Error(`工作流「${workflowName}」只有 ${availableImages} 个图片输入槽，本轮需要 ${requiredImages} 张（${context.loopInputImages.length} 张循环图 + ${context.referenceImages.length} 张固定参考图）；请配置支持三图的工作流或调整参考输入`);
                }
                await flushCanvasProjectBeforeGeneration(projectId);
                const hasComfy = mediaChain && stages.some((stage) => stage.some((target) => {
                    const model = buildGenerationConfig(effectiveConfig, target, generationModeForLoopTarget(target)).model;
                    return resolveModelChannel(effectiveConfig, model).kind === "comfyui";
                }));
                const parallelRounds = metadata.loopMode === "parallel" && total > 1;
                const configuredInstances = parallelRounds && hasComfy
                    ? await request<{ instances: string[] }>("GET", "/api/comfyui/instances", undefined, { signal: controller.signal }).then((response) => response.instances.filter((value) => value.trim()).length).catch(() => 1)
                    : 6;
                const parallelLimit = parallelRounds ? Math.min(6, Math.max(1, configuredInstances)) : 1;
                let completed = 0;
                await runLoopGenerationRounds(total, parallelLimit, controller, async (index) => {
                    controller.signal.throwIfAborted();
                    const roundIndex = start + index * batchSize;
                    const loopContext: CanvasLoopRuntimeContext = {
                        index, total: end, nodeId: loopNodeId, signal: controller.signal, roundOutputs: new Map(), initialNodes,
                        ...(mediaChain ? { loopOutput: { loopNodeId, roundIndex, slotIndex: index } } : {}),
                    };
                    const runTarget = (target: CanvasNodeData) => {
                        const prompt = target.metadata?.composerContent ?? target.metadata?.prompt ?? (target.type === CanvasNodeType.Text ? target.metadata?.content || "" : "");
                        return handleGenerateNode(target.id, generationModeForLoopTarget(target), prompt, loopContext);
                    };
                    await runLoopGenerationStages(stages, controller, runTarget);
                    completed += 1;
                    setLoopProgress({ current: completed, total });
                });
            } catch (error) {
                if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
            } finally {
                if (loopAbortRef.current === controller) loopAbortRef.current = null;
                setRunningLoopId(null);
                setLoopProgress(undefined);
            }
        },
        [effectiveConfig, handleGenerateNode, message, projectId, t],
    );

    const stopLoop = useCallback(() => {
        loopAbortRef.current?.abort();
    }, []);

    const runNodeOrLoop = useCallback(async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
        const loop = upstreamLoopForGeneration(nodeId, nodesRef.current, connectionsRef.current);
        if (loop) return runLoop(loop.id);
        return handleGenerateNode(nodeId, mode, prompt);
    }, [handleGenerateNode, runLoop]);
    useEffect(() => {
        generateNodeRef.current = runNodeOrLoop;
    }, [runNodeOrLoop]);

    const handleRetryNode = useCallback(
        async (initialNode: CanvasNodeData, imageId?: string) => {
            let node = initialNode;
            let projectFlushed = false;
            const activeRequest = generationRequestsRef.current.get(node.id);
            if (activeRequest && !activeRequest.controller.signal.aborted) return;
            if (node.metadata?.maskEdit) {
                try {
                    await flushCanvasProjectBeforeGeneration(projectId);
                    projectFlushed = true;
                    node = useCanvasStore.getState().projects.find((project) => project.id === projectId)?.nodes.find((item) => item.id === node.id) || node;
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                    return;
                }
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            // 失败结果节点的面板允许重新选择模型。重试时优先沿用结果节点当前模型，
            // 避免回溯到上游配置节点里的旧模型（例如“视频拼接”）而与面板显示不一致。
            const retryConfigSource = node.metadata?.model ? { ...sourceNode, metadata: { ...sourceNode.metadata, model: node.metadata.model } } : sourceNode;
            const smartMode = node.type === CanvasNodeType.Config && node.metadata?.smart ? node.metadata.generationMode || "image" : undefined;
            const baseSavedImageMetadata = node.type === CanvasNodeType.Image || (node.type === CanvasNodeType.Config && smartMode === "image") ? node.metadata : undefined;
            const selectedImageHistoryId = imageId || (node.type === CanvasNodeType.Config ? node.metadata?.activeImageHistoryId || node.metadata?.primaryImageId : undefined);
            const selectedImageHistory = selectedImageHistoryId ? baseSavedImageMetadata?.images?.find((image) => image.id === selectedImageHistoryId)?.generationSnapshot : undefined;
            const savedImageMetadata = selectedImageHistory && baseSavedImageMetadata ? {
                ...baseSavedImageMetadata,
                model: selectedImageHistory.model,
                quality: selectedImageHistory.quality,
                size: selectedImageHistory.size,
                background: selectedImageHistory.background,
                count: selectedImageHistory.count,
                comfyParams: selectedImageHistory.params,
                generationType: selectedImageHistory.maskEdit || selectedImageHistory.references.length ? "edit" as const : "generation" as const,
                maskEdit: selectedImageHistory.maskEdit,
            } : baseSavedImageMetadata;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : {
                          ...buildGenerationConfig(effectiveConfig, retryConfigSource, smartMode || (node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image")),
                          count: "1",
                      };
            if (generationConfig.model !== VIDEO_CONCAT_MODEL && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const retrySourcePrompt = sourceNode.metadata?.composerContent || sourceNode.metadata?.prompt || node.metadata?.prompt || "";
            const context = hasSavedImageMetadata
                ? null
                : await (async () => {
                      const sourceContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retrySourcePrompt));
                      if (sourceNode.id === node.id) return sourceContext;
                      // 结果节点面板展示的是结果节点自己的参考图。重试时不能只回溯到配置节点，
                      // 否则配置节点没有直接连图时，H3 会收到空的 references。
                      const targetContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(node.id, nodesRef.current, connectionsRef.current, retrySourcePrompt));
                      return targetContext.referenceImages.length || targetContext.referenceVideos.length || targetContext.referenceAudios.length ? targetContext : sourceContext;
                  })();
            const prompt = (selectedImageHistory?.effectivePrompt || (
                savedImageMetadata?.maskEdit && typeof savedImageMetadata.composerContent === "string"
                    ? savedImageMetadata.composerContent
                    : savedImageMetadata?.prompt || retrySourcePrompt || context?.prompt || ""
            )).trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                selectedImageHistory ? resolveImageGenerationReferences(selectedImageHistory.references)
                    : hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata)
                    : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages?.length) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"),
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)),
                                  },
                              }
                            : item,
                    ),
                );
                return;
            }
            const retryImages = retryReferenceImages || [];
            // 客户端预生成 taskId 只交给 Backend 调度任务；直连请求刷新后无法续跑。
            const retryClientTaskId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const retryUseCanvasDispatcher = node.type === CanvasNodeType.Image || (node.type === CanvasNodeType.Config && smartMode === "image");
            const retryUseVideoDispatcher = node.type === CanvasNodeType.Video || (node.type === CanvasNodeType.Config && smartMode === "video");
            const retryUseTextDispatcher = node.type === CanvasNodeType.Text || (node.type === CanvasNodeType.Config && smartMode === "text");
            const retryUseAudioDispatcher = node.type === CanvasNodeType.Audio || (node.type === CanvasNodeType.Config && smartMode === "audio");

            setRunningNodeId(node.id);
            if (retryUseCanvasDispatcher) {
                const targetImageId = imageId || node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id;
                const controller = startGenerationRequest(node.id, sourceNode.id, node.id);
                try {
                    if (!projectFlushed) await flushCanvasProjectBeforeGeneration(projectId);
                    const size = resolveComfyImageSize(generationConfig.size);
                    await runCanvasImageTask(
                        {
                            mode: "image",
                            ...(savedImageMetadata?.maskEdit ? { maskEdit: true } : {}),
                            model: generationConfig.model,
                            prompt,
                            references: retryImages,
                            ...size,
                            size: `${size.width}x${size.height}`,
                            quality: generationConfig.quality,
                            count: 1,
                            ...(targetImageId ? { imageIds: [targetImageId] } : {}),
                            params: savedImageMetadata?.comfyParams ?? sourceNode.metadata?.comfyParams,
                            clientTaskId: retryClientTaskId,
                            projectId,
                            nodeId: node.id,
                            sourceNodeId: sourceNode.id,
                        },
                        controller.signal,
                    );
                } catch (error) {
                    if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                } finally {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId(null);
                }
                return;
            }
            if (retryUseVideoDispatcher) {
                const retryVideos = context?.referenceVideos || [];
                if (generationConfig.model === VIDEO_CONCAT_MODEL && retryVideos.length < 2) {
                    message.error("视频拼接至少需要连接两个视频");
                    setRunningNodeId(null);
                    return;
                }
                const controller = startGenerationRequest(node.id, sourceNode.id, node.id);
                try {
                    await flushCanvasProjectBeforeGeneration(projectId);
                    await runCanvasVideoTask(
                        {
                            mode: "video",
                            model: generationConfig.model,
                            prompt,
                            references: retryImages,
                            videoReferences: retryVideos.map((item) => ({ id: item.id, name: item.name, url: item.url, storageKey: item.storageKey, mimeType: item.type })),
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            resolution: generationConfig.vquality,
                            params: sourceNode.metadata?.comfyParams,
                            clientTaskId: retryClientTaskId,
                            projectId,
                            nodeId: node.id,
                            sourceNodeId: sourceNode.id,
                        },
                        controller.signal,
                    );
                } catch (error) {
                    if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                } finally {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId(null);
                }
                return;
            }
            if (retryUseTextDispatcher) {
                const controller = startGenerationRequest(node.id, sourceNode.id, node.id);
                try {
                    await flushCanvasProjectBeforeGeneration(projectId);
                    await runCanvasTextTask(
                        {
                            mode: "text",
                            model: generationConfig.model,
                            prompt,
                            count: getGenerationCount(String(sourceNode.metadata?.textCount || 1)),
                            references: retryImages,
                            params: { systemPrompt: generationConfig.systemPrompt, reasoningEffort: generationConfig.reasoningEffort, targetTextNodeId: node.id },
                            clientTaskId: retryClientTaskId,
                            projectId,
                            nodeId: sourceNode.id,
                            sourceNodeId: sourceNode.id,
                            resultPolicy: "replace-active",
                        },
                        controller.signal,
                    );
                } catch (error) {
                    if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                } finally {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId(null);
                }
                return;
            }
            if (retryUseAudioDispatcher) {
                const controller = startGenerationRequest(node.id, sourceNode.id, node.id);
                try {
                    await flushCanvasProjectBeforeGeneration(projectId);
                    await runCanvasAudioTask(
                        {
                            mode: "audio",
                            model: generationConfig.model,
                            prompt,
                            audioReferences: (context?.referenceAudios || []).map((item) => ({ id: item.id, name: item.name, url: item.url, storageKey: item.storageKey, mimeType: item.type })),
                            params: { voice: generationConfig.audioVoice, format: generationConfig.audioFormat, speed: generationConfig.audioSpeed, instructions: generationConfig.audioInstructions },
                            clientTaskId: retryClientTaskId,
                            projectId,
                            nodeId: node.id,
                            sourceNodeId: sourceNode.id,
                        },
                        controller.signal,
                    );
                } catch (error) {
                    if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : t("canvas.projectPage.generationFailed"));
                } finally {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId(null);
                }
                return;
            }
            setRunningNodeId(null);
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (node?.type === CanvasNodeType.Character) {
            const images = node.metadata?.characterImages || [];
            if (images.length <= 1) return; // 至少保留 1 张 outfit
            const index = images.findIndex((_, idx) => String(idx) === imageId);
            if (index < 0) return;
            const nextImages = images.filter((_, idx) => idx !== index);
            setNodes((prev) =>
                prev.map((item) => {
                    if (item.id !== nodeId) return item;
                    const previousPrimary = item.metadata?.characterPrimaryIndex || 0;
                    const newPrimary = previousPrimary === index ? 0 : previousPrimary > index ? previousPrimary - 1 : previousPrimary;
                    const primaryImage = nextImages[newPrimary];
                    return {
                        ...item,
                        metadata: {
                            ...item.metadata,
                            characterImages: nextImages,
                            characterPrimaryIndex: newPrimary,
                            content: primaryImage?.url,
                            storageKey: primaryImage?.storageKey,
                            naturalWidth: primaryImage?.width,
                            naturalHeight: primaryImage?.height,
                            bytes: primaryImage?.bytes,
                            mimeType: primaryImage?.mimeType,
                        },
                    };
                }),
            );
            return;
        }
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                const nextPrimaryId = item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId;
                const nextHistoryId = item.metadata?.activeImageHistoryId === imageId ? null : item.metadata?.activeImageHistoryId;
                return { ...item, metadata: { ...item.metadata, images, count: item.type === CanvasNodeType.Config && item.metadata?.smart ? item.metadata.count : images.length, primaryImageId: nextPrimaryId, activeImageHistoryId: nextHistoryId, activeImageHistoryExplicit: nextHistoryId ? item.metadata?.activeImageHistoryExplicit : false } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.count || effectiveConfig.canvasImageCount),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            const resolver = assetPickerResolverRef.current;
            if (resolver) {
                assetPickerResolverRef.current = null;
                setAssetPickerOpen(false);
                setAssetPickerAllowedKinds(undefined);
                if (payload.kind === "image") resolver(payload);
                else resolver(null);
                return;
            }
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else if (payload.kind === "audio") {
                const spec = { width: 320, height: 80 };
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Audio,
                        title: payload.title,
                        position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                        width: spec.width,
                        height: spec.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, durationMs: payload.durationMs },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else if (payload.kind === "character") {
                // 角色资产：从资产库选择 / 工具栏 + 角色 / 拖入 → 统一创建 1 个 Character 节点，
                // 不再展开为 Group + N 张 Image（旧的"快速散开"路径移除）。
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Character];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `character-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const firstImage = payload.images.find((image) => image.url);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Character,
                        title: payload.title || "角色",
                        position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                        width: spec.width,
                        height: spec.height,
                        metadata: {
                            status: NODE_STATUS_SUCCESS,
                            characterName: payload.title,
                            characterAssetId: payload.assetId,
                            characterDescription: payload.description,
                            characterImages: payload.images,
                            characterPrimaryIndex: Math.min(Math.max(payload.primaryIndex, 0), Math.max(payload.images.length - 1, 0)),
                            characterVoiceUrl: payload.voice || undefined,
                            characterVoiceName: payload.voiceName || undefined,
                            characterVoiceDescription: payload.voiceDescription || undefined,
                            characterVoiceStorageKey: payload.voiceStorageKey || undefined,
                            characterVoiceAssetId: payload.voiceAssetId || undefined,
                            content: firstImage?.url,
                            storageKey: firstImage?.storageKey,
                            naturalWidth: firstImage?.width,
                            naturalHeight: firstImage?.height,
                            bytes: firstImage?.bytes,
                            mimeType: firstImage?.mimeType,
                        },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else if (payload.kind === "scene") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Scene];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `scene-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                setNodes((prev) => [...prev, {
                    id,
                    type: CanvasNodeType.Scene,
                    title: payload.title || "场景",
                    position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
                    width: spec.width,
                    height: spec.height,
                    metadata: { status: NODE_STATUS_SUCCESS, sceneAssetId: payload.assetId, sceneName: payload.title, sceneDescription: payload.description, sceneImage: payload.image, sceneColorCard: payload.colorCard, sceneColorPalette: payload.colorPalette, sceneColorCardPrompt: payload.colorCardPrompt },
                }]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    const closeAssetPicker = useCallback(() => {
        assetPickerResolverRef.current?.(null);
        assetPickerResolverRef.current = null;
        setAssetPickerAllowedKinds(undefined);
        setAssetPickerOpen(false);
    }, []);

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, []);
    const openVideoComparison = useCallback((sourceNode: CanvasNodeData) => {
        // 同屏对比弹窗会用同一份 URL 渲染一份新 <video>；打开时先暂停画布里所有视频节点，
        // 避免两边同时播放造成音轨叠加；用户关掉弹窗后画布视频保持暂停状态，需要重新点播放。
        const canvasVideos = Array.from(containerRef.current?.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]") || []);
        for (const video of canvasVideos) video.pause();
        const displayedVideos = new Map(canvasVideos.map((video) => [video.dataset.canvasVideo || "", video.currentSrc || video.src]));
        const videoItem = (node: CanvasNodeData): CanvasVideoCompareItem | null => {
            const smartVideo = node.type === CanvasNodeType.Config && node.metadata?.smart === true && node.metadata.generationMode === "video";
            if (node.type !== CanvasNodeType.Video && !smartVideo) return null;
            const latest = node.metadata?.loopOutputHistory?.at(-1);
            const storageKey = node.metadata?.storageKey || latest?.storageKey;
            const url = displayedVideos.get(node.id) || (storageKey ? backendMediaUrl(storageKey) : node.metadata?.content || node.metadata?.url || latest?.content || latest?.url || "");
            return url ? { id: node.id, title: node.title || t("assets.kinds.video"), url, durationMs: node.metadata?.durationMs || latest?.durationMs } : null;
        };
        const source = videoItem(sourceNode);
        if (!source) return;
        const candidates = nodesRef.current.filter((node) => node.id !== source.id).map(videoItem).filter((item): item is CanvasVideoCompareItem => Boolean(item));
        if (!candidates.length) { void message.warning(t("canvas.videoCompare.noCandidates")); return; }
        setPendingVideoComparison({ source, candidates });
        setSelectedNodeIds(new Set([source.id]));
        setSelectedConnectionId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setContextMenu(null);
    }, [message, t]);
    const handleNodeRetry = useCallback(
        (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text && (node.metadata?.textCount || 1) > 1) {
                void generateNodeRef.current?.(node.id, "text", node.metadata?.prompt || "");
                return;
            }
            void handleRetryNode(node);
        },
        [handleRetryNode],
    );
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) => {
            const target = panelNode.type === CanvasNodeType.Loop
                ? singleLoopPanelTarget(panelNode.id, nodes, connections, isLoopGenerationTarget)
                : panelNode;
            if (!target) return null;
            const activeLoop = upstreamLoopForGeneration(target.id, nodes, connections);
            const isRunning = runningNodeId === target.id || Boolean(activeLoop && runningLoopId === activeLoop.id);
            const stop = (nodeId: string) => activeLoop && runningLoopId === activeLoop.id ? stopLoop() : confirmStopGeneration(nodeId);
            const disconnectReference = (fromNodeId: string, toNodeId: string) => {
                const throughLoop = activeLoop && !connections.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId)
                    && connections.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === activeLoop.id);
                disconnectNodeReference(fromNodeId, throughLoop ? activeLoop!.id : toNodeId);
            };
            return getNodeDefinition(target.type)?.Panel ? (
                renderPluginPanel(target)
            ) : target.type === CanvasNodeType.Config ? (
                target.metadata?.smart ? (
                    <CanvasNodePromptPanel
                        node={target}
                        nodes={nodes}
                        isRunning={isRunning}
                        mentionReferences={mentionReferencesByNodeId.get(target.id) || EMPTY_REFERENCES}
                        connectedNodes={getFixedReferenceNodes(target.id, nodes, graphIndex)}
                        loopInputCount={loopImageInputCount(target.id, nodes, connections, graphIndex)}
                        onConfigChange={handleConfigNodeChange}
                        onGenerate={runNodeOrLoop}
                        onStop={stop}
                        onDisconnectReference={disconnectReference}
                        onStartReferenceSelection={startNodeReferenceSelection}
                        onImageSettingsOpenChange={(open) => {
                            setNodeImageSettingsOpen(open);
                            if (open) setToolbarNodeId(null);
                        }}
                    />
                ) : (
                    <CanvasConfigComposer
                        nodeId={target.id}
                        nodes={nodes}
                        value={target.metadata?.composerContent ?? target.metadata?.prompt ?? ""}
                        inputs={configInputsById.get(target.id) || []}
                        connectedNodes={getFixedReferenceNodes(target.id, nodes, graphIndex)}
                        onChange={(composerContent) => handleConfigNodeChange(target.id, { composerContent })}
                        onClose={() => setDialogNodeId(null)}
                        onDisconnectReference={disconnectReference}
                        onStartReferenceSelection={startNodeReferenceSelection}
                    />
                )
            ) : (
                <CanvasNodePromptPanel
                    node={target}
                    nodes={nodes}
                    isRunning={isRunning}
                    mentionReferences={mentionReferencesByNodeId.get(target.id) || EMPTY_REFERENCES}
                    connectedNodes={getFixedReferenceNodes(target.id, nodes, graphIndex)}
                    loopInputCount={loopImageInputCount(target.id, nodes, connections, graphIndex)}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={runNodeOrLoop}
                    onStop={stop}
                    onDisconnectReference={disconnectReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    modeOverride={getNodeDefinition(target.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            );
        },
        [
            configInputsById,
            confirmStopGeneration,
            connections,
            disconnectNodeReference,
            graphIndex,
            handleConfigNodeChange,
            runNodeOrLoop,
            mentionReferencesByNodeId,
            nodes,
            renderPluginPanel,
            runningLoopId,
            runningNodeId,
            startNodeReferenceSelection,
            stopLoop,
        ],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => {
            if (contentNode.type === CanvasNodeType.Loop) {
                const upstreamInputs = buildLoopSourceInputs(contentNode.id, nodesRef.current, connectionsRef.current)
                    .flatMap((input) => input.type === "group" ? input.children : [input]);
                const upstreamPromptItems = upstreamInputs.flatMap((input) => input.type === "text" ? splitLoopPromptItems(input.text || "") : []);
                return (
                    <CanvasLoopNode
                        node={contentNode}
                        theme={theme}
                        isRunning={runningLoopId === contentNode.id}
                        progress={runningLoopId === contentNode.id ? loopProgress : undefined}
                        upstreamPromptItems={upstreamPromptItems}
                        imageCount={upstreamInputs.filter((input) => input.type === "image").length}
                        videoCount={upstreamInputs.filter((input) => input.type === "video").length}
                        onChange={(patch) => handleConfigNodeChange(contentNode.id, patch)}
                        onRun={() => void runLoop(contentNode.id)}
                        onStop={stopLoop}
                    />
                );
            }
            if (contentNode.metadata?.smart) return null;
            return (
                <CanvasConfigNodePanel
                    node={contentNode}
                    isRunning={runningNodeId === contentNode.id}
                    inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                    onConfigChange={handleConfigNodeChange}
                    onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                    onStop={confirmStopGeneration}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void runNodeOrLoop(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    }}
                />
            );
        },
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, loopProgress, runLoop, runNodeOrLoop, runningLoopId, runningNodeId, stopLoop, theme],
    );

    if (!projectLoaded && projectLoadError)
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
                <p role="alert">{projectLoadError}</p>
                <Button type="text" onClick={() => setProjectLoadAttempt((attempt) => attempt + 1)}>
                    重新加载
                </Button>
                <Button type="text" onClick={() => navigate("/canvas")}>
                    返回画布库
                </Button>
            </div>
        );
    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel projectId={projectId} nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => navigate("/")}
                    onProjects={() => navigate("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onExportProject={exportCurrentProject}
                    exporting={exporting}
                    transferBusy={canvasTransferBusy}
                    onImportImage={() => handleUploadRequest()}
                    onOpenPlugins={() => setPluginManagerOpen(true)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    agentOpen={agentPanelOpen}
                    compactAgentStatus={{ connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity }}
                    onToggleAgent={toggleAgentPanel}
                    globalPrompt={globalPrompt}
                    projectId={projectId}
                    onOpenGenerationLogs={() => setGenerationLogsOpen(true)}
                    collaborators={collaborators}
                />
                {canvasConflict ? (
                    <div className="pointer-events-auto absolute left-1/2 top-16 z-40 w-[min(680px,calc(100%-32px))] -translate-x-1/2">
                        <Alert
                            type="warning"
                            showIcon
                            closable
                            onClose={() => clearCanvasConflict(projectId)}
                            message={canvasConflict.message}
                            description={
                                <div className="space-y-2">
                                    <div>{`后端当前版本 ${canvasConflict.revision}，本地有 ${canvasConflict.pendingOperations} 个未提交操作；其中 ${canvasConflict.conflictTargets.length} 个与远端改动直接冲突。`}</div>
                                    {canvasConflict.conflictTargets.length ? (
                                        <ul className="m-0 list-disc pl-5 text-xs opacity-80">
                                            {canvasConflict.conflictTargets.slice(0, 5).map((target) => (
                                                <li key={`${target.kind}:${target.id}`}>{target.detail}</li>
                                            ))}
                                            {canvasConflict.conflictTargets.length > 5 ? <li>{`…还有 ${canvasConflict.conflictTargets.length - 5} 个`}</li> : null}
                                        </ul>
                                    ) : null}
                                    <div className="flex gap-2 pt-1">
                                        <Button size="small" onClick={() => keepPendingOpsOnCanvasConflict(projectId)}>{`保留我的 ${canvasConflict.pendingOperations} 个操作（自动在新版本上重提）`}</Button>
                                        <Button size="small" danger onClick={() => adoptRemoteOnCanvasConflict(projectId)}>{`采用远端（丢弃我的 ${canvasConflict.pendingOperations} 个操作）`}</Button>
                                    </div>
                                </div>
                            }
                        />
                    </div>
                ) : null}

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewportRef={liveViewportRef}
                    registerViewportWriter={registerViewportWriter}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={handleViewportChange}
                    overlay={
                        selectionBox ? (
                            <svg
                                ref={selectionOverlayRef}
                                className="pointer-events-none absolute z-[100] overflow-visible"
                                style={{
                                    left: Math.min(selectionBox.startLocalX, selectionBox.currentLocalX),
                                    top: Math.min(selectionBox.startLocalY, selectionBox.currentLocalY),
                                    width: Math.abs(selectionBox.currentLocalX - selectionBox.startLocalX),
                                    height: Math.abs(selectionBox.currentLocalY - selectionBox.startLocalY),
                                }}
                            >
                                <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.95} strokeWidth="2" strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />
                            </svg>
                        ) : null
                    }
                    onCanvasMouseDown={(event) => {
                        if (!refPickActive && !characterImagePickerActive) handleCanvasMouseDown(event);
                    }}
                    onCanvasDeselect={refPickActive || characterImagePickerActive ? undefined : deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        if (refPickActive || characterImagePickerActive) return;
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {visibleConnectionOverviewBundles.map((bundle) => (
                            <ConnectionBundleOverviewPath key={bundle.id} bundle={bundle} theme={theme} />
                        ))}
                        {renderedConnections.map((connection) => {
                            const from = nodeById.get(connection.fromNodeId);
                            const to = nodeById.get(connection.toNodeId);
                            if (!from || !to) return null;

                            const touchesGroup = groupIdByNodeId.has(connection.fromNodeId) || groupIdByNodeId.has(connection.toNodeId);
                            const active = selectedConnectionId === connection.id || focusedConnectionIds.has(connection.id) || (!touchesGroup && relatedHighlight.connectionIds.has(connection.id));
                            if (compactConnectionOverview && !active) {
                                return <ConnectionOverviewPath key={connection.id} connection={connection} from={from} to={to} active={false} theme={theme} onSelect={handleConnectionSelect} onContextMenu={handleConnectionContextMenu} />;
                            }
                            return (
                                <ConnectionPath
                                    key={connection.id}
                                    projectId={projectId}
                                    connection={connection}
                                    from={from}
                                    to={to}
                                    theme={theme}
                                    active={active}
                                    onSelect={handleConnectionSelect}
                                    onContextMenu={handleConnectionContextMenu}
                                    onDelete={deleteConnection}
                                />
                            );
                        })}
                        <CanvasH3RefLinks projectId={projectId} nodes={nodes} visibleNodes={visibleNodes} selectedNodeIds={selectedNodeIds} />
                        {connectingParams ? <ActiveConnectionPath projectId={projectId} node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => {
                        const nodeDefinition = getNodeDefinition(node.type);
                        const showPanel = !isNodeResizing && dialogNodeId === node.id && !selectionBox && !nodeDefinition?.hidePanel;
                        const needsPluginHost = Boolean(nodeDefinition?.Content || nodeDefinition?.Panel || nodeDefinition?.onDoubleClick || nodeDefinition?.forceInteractive);
                        return (
                            <CanvasNodeViewportItem
                                key={node.id}
                                projectId={projectId}
                                data={node}
                                theme={theme}
                                scale={viewport.k}
                                isSelected={selectedNodeIds.has(node.id)}
                                isHovered={hoveredNodeId === node.id}
                                overviewMode={denseOverviewMode}
                                isRelated={relatedHighlight.nodeIds.has(node.id)}
                                isFocusRelated={activeNodeId === node.id}
                                isConnectionTarget={connectionTargetNodeId === node.id}
                                isConnecting={Boolean(connectingParams)}
                                isConnectionSource={connectingParams?.nodeId === node.id}
                                referenceSelectionState={
                                    pendingVideoComparison
                                        ? node.id === pendingVideoComparison.source.id
                                            ? "target"
                                            : compareCandidateIds.has(node.id) ? "available" : "disabled"
                                        : characterImagePickerActive || sceneImagePickerActive
                                        ? node.id === (characterImagePickerActive ? characterEditNodeId : sceneEditNodeId)
                                            ? "target"
                                            : nodeResourceItems(node).some((item) => item.kind === "image" && item.url)
                                              ? "available"
                                              : "disabled"
                                        : !refPickActive
                                          ? undefined
                                          : node.id === refPickTargetNodeId
                                            ? "target"
                                            : (!pluginReferencePickNodeId && referenceConnectedNodeIds.has(node.id)) || !isCanvasReferenceNode(node, nodes, graphIndex)
                                              ? "disabled"
                                              : "available"
                                }
                                selectionPurpose={pendingVideoComparison ? "video-compare" : "reference"}
                                showPanel={showPanel}
                                groupChildCount={groupChildCountById.get(node.id) || 0}
                                isGroupDropTarget={dropTargetGroupId === node.id}
                                batchExpanded={expandedBatchNodeIds.has(node.id)}
                                showImageInfo={showImageInfo}
                                mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                                pluginHost={needsPluginHost ? pluginHost : undefined}
                                registryVersion={nodeRegistryVersion}
                                // 图片/视频/音频/文本节点不会消费这些渲染器；不传无用函数，
                                // 避免生成状态或面板回调变化时让所有媒体节点失去 React.memo 命中。
                                renderPanel={showPanel ? renderNodePanel : undefined}
                                renderNodeContent={node.type === CanvasNodeType.Config || node.type === CanvasNodeType.Loop ? renderNodeContentPanel : undefined}
                                onMouseDown={handleNodeMouseDown}
                                onSelectCapture={handleNodeSelectCapture}
                                onHoverStart={handleNodeHoverStart}
                                onHoverEnd={handleNodeHoverEnd}
                                onConnectStart={handleConnectStart}
                                onResizeStart={handleNodeResizeStart}
                                onResize={handleNodeResize}
                                onResizeEnd={handleNodeResizeEnd}
                                onTitleChange={handleNodeTitleChange}
                                onToggleBatch={toggleBatchExpanded}
                                onSetBatchPrimary={setBatchPrimary}
                                onDuplicateBatchImage={duplicateBatchImage}
                                onDownloadBatchImage={downloadBatchImage}
                                onRetryBatchImage={retryBatchImage}
                                onDeleteBatchImage={deleteBatchImage}
                                onRetry={handleNodeRetry}
                                onViewImage={handleNodeViewImage}
                                onSelectReference={handleSelectReference}
                                onContextMenu={handleNodeContextMenu}
                                onEditCharacter={openCharacterEditor}
                                onCharacterDrop={dropOnCharacterNode}
                                onEditScene={openSceneEditor}
                                onSceneDrop={dropOnSceneNode}
                            />
                        );
                    })}

                    {pendingVideoComparison ? (
                        <button type="button" className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onClick={exitReferencePick}>
                            {t("canvas.videoCompare.selectingHint")}
                        </button>
                    ) : characterImagePickerActive ? (
                        <button
                            type="button"
                            className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 border px-4 py-2 text-sm font-medium backdrop-blur"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                            onClick={exitCharacterImageSelection}
                        >
                            {t("canvas.character.selectingImageHint")}
                        </button>
                    ) : sceneImagePickerActive ? (
                        <button type="button" className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 border px-4 py-2 text-sm font-medium backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} onClick={exitSceneImageSelection}>
                            {t("canvas.scene.selectingImageHint")}
                        </button>
                    ) : refPickActive ? (
                        <button
                            type="button"
                            className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                            onClick={exitReferencePick}
                        >
                            {t("canvas.references.selectingHint")}
                        </button>
                    ) : null}

                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>
                <CanvasRealtimePresenceLayer projectId={projectId} nodeById={nodeById} viewport={viewport} />

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedBatchNodeIds.has(toolbarNode?.id || "") ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={pluginToolbarItems}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onCompareVideo={openVideoComparison}
                    onConvertToCharacter={convertImageNodeToCharacter}
                    onConvertToScene={convertImageNodeToScene}
                    onSaveCharacterToAsset={(node) => void saveCharacterNodeToAsset(node)}
                    onSaveSceneToAsset={(node) => void saveSceneNodeToAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAutoLevels={(node) => void autoLevelsImageNode(node)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onArrangeGroup={arrangeGroupNodes}
                    onToggleOrderedGroup={(node) => toggleOrderedGroup(node.id)}
                    onToggleGroupLock={(node) => setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, groupLocked: !item.metadata?.groupLocked } } : item)))}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canvasTool={canvasTool}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddH3={() => createNode("minimax-h3:video")}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onAddLoop={() => createNode(CanvasNodeType.Loop)}
                    onAddCharacter={() => createNode(CanvasNodeType.Character)}
                    onAddScene={() => createNode(CanvasNodeType.Scene)}
                    onAddGroup={addGroupNode}
                    groupSelection={groupableSelectedCount >= 2}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onArrange={arrangeSelectedNodes}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={commitViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />
                <CanvasGenerationLogDialog open={generationLogsOpen} projectId={projectId} onClose={() => setGenerationLogsOpen(false)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canCaptureVideoFrame={contextMenuNode?.type === CanvasNodeType.Video && Boolean(contextMenuNode.metadata?.content)}
                        canGroup={contextMenu.type === "node" && selectedNodeIds.has(contextMenu.nodeId) && groupableSelectedCount > 1}
                        canCopyContent={Boolean(contextMenuText)}

                        onClose={() => setContextMenu(null)}
                        onCaptureVideoFrame={(position) => {
                            if (contextMenu.type !== "node") return;
                            void captureVideoNodeFrame(contextMenu.nodeId, position);
                        }}
                        isExtractingKeyframes={extractingKeyframeNodeId === contextMenuNode?.id}
                        onExtractVideoKeyframes={
                            contextMenu.type === "node" ? () => void extractVideoNodeKeyframes(contextMenu.nodeId) : undefined
                        }
                        onGroup={() => {
                            groupSelectedNodes();
                            setContextMenu(null);
                        }}

                        onCopyContent={() => {
                            if (contextMenuText) copyText(contextMenuText);
                            setContextMenu(null);
                        }}

                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} onRename={handleNodeTitleChange} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <CharacterNodeEditModal
                    open={Boolean(characterEditNodeId)}
                    selectingCanvasImage={characterImagePickerActive}
                    canvasImagePick={characterCanvasImagePick}
                    node={characterEditNodeId ? nodesRef.current.find((node) => node.id === characterEditNodeId) || null : null}
                    onClose={closeCharacterEditor}
                    onPickCanvasImage={startCharacterImageSelection}
                    onSave={saveCharacterEdit}
                />

                <SceneNodeEditModal
                    open={Boolean(sceneEditNodeId)}
                    selectingCanvasImage={Boolean(sceneImagePickerActive)}
                    canvasImagePick={sceneCanvasImagePick}
                    node={sceneEditNodeId ? nodesRef.current.find((node) => node.id === sceneEditNodeId) || null : null}
                    onClose={closeSceneEditor}
                    onPickCanvasImage={startSceneImageSelection}
                    onSave={saveSceneEdit}
                />

                <MediaPreviewModal item={mediaPreviewItem} onClose={closeMediaPreview} />
                {videoComparison ? <CanvasVideoCompareModal comparison={videoComparison} onClose={() => setVideoComparison(null)} /> : null}

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} allowedKinds={assetPickerAllowedKinds} onInsert={handleAssetInsert} onClose={closeAssetPicker} />
            </section>
        </main>
    );
}
