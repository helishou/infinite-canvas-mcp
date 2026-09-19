import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Copy, Download, FileText, Image as ImageIcon, ListRestart, MapPinned, Music2, Puzzle, RefreshCw, Settings2, Star, Trash2, User, Video } from "lucide-react";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { pickImageSource } from "@/lib/image-thumbnail";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { isImageGenerationNode } from "@/lib/canvas/canvas-resource-references";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useBackendStore } from "@/stores/use-backend-store";
import { CanvasCollaborativeText } from "./canvas-collaborative-text";
import { useParams } from "react-router-dom";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeImage, type CanvasNodeText, type Position } from "@/types/canvas";
import type { CanvasNodeContext, CanvasPluginHost } from "@/types/canvas-plugin";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { characterReferenceKey } from "@/lib/canvas/canvas-resource-references";
import { ensureImagePreview, getImagePreviewRevisionFor, previewUrlFor, resolveImageUrl, subscribeImagePreview } from "@/services/image-storage";
import { useTranslation } from "react-i18next";
import { useCanvasNodePreview } from "@/lib/canvas/canvas-drag-preview";
import { ensureVideoPreview, getVideoPreviewRevision, subscribeVideoPreview, videoPreviewUrlFor } from "@/lib/canvas/canvas-video-frame";
import { getPluginNodeView } from "@/stores/canvas/plugin-node-view";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";
// 只有节点确实缩到难以承载编辑内容时才切换概览，避免常用缩放区间过早换壳。
const NODE_DETAIL_MODE_ENTER_SCREEN_SIZE = 180;
const NODE_OVERVIEW_MODE_ENTER_SCREEN_SIZE = 100;
const emptyPluginView: Record<string, unknown> = {};
const subscribeNoPluginView = () => () => undefined;
const EMPTY_NODES: CanvasNodeData[] = [];
const EMPTY_CONNECTIONS: CanvasConnection[] = [];

export type CanvasNodeProps = {
    projectId: string;
    data: CanvasNodeData;
    // 由画布统一传入，供远处概览壳复用，避免每个概览节点单独订阅主题状态。
    theme: CanvasTheme;
    previewPosition?: Position;
    previewBounds?: { width: number; height: number; position: Position };
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    isConnectionSource?: boolean;
    referenceSelectionState?: "target" | "disabled" | "available";
    showPanel: boolean;
    showImageInfo: boolean;
    mentionReferences?: CanvasResourceReference[];
    pluginHost?: CanvasPluginHost;
    registryVersion?: number;
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    groupChildCount?: number;
    isGroupDropTarget?: boolean;
    batchExpanded?: boolean;
    isHovered?: boolean;
    overviewMode?: boolean;
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    // 角色节点双击标题：打开完整编辑面板（名字/描述/参考图/声线）
    onEditCharacter?: (node: CanvasNodeData) => void;
    // 拖入图片/音频到角色节点
    onCharacterDrop?: (node: CanvasNodeData, ref: { url: string; type: "image" | "audio"; name?: string; storageKey?: string; mimeType?: string }) => void;
    onEditScene?: (node: CanvasNodeData) => void;
    onSceneDrop?: (node: CanvasNodeData, ref: { url: string; name?: string; storageKey?: string; mimeType?: string }) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (nodeId: string, itemId: string) => void;
    onDuplicateBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDownloadBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onRetryBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDeleteBatchImage?: (nodeId: string, imageId: string) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData, imageId?: string) => void;
    onSelectReference?: (nodeId: string) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

function nodeTypeIcon(node: CanvasNodeData) {
    if (node.type.includes("minimax-h3") || node.type === CanvasNodeType.Video) return Video;
    if (node.type === CanvasNodeType.Image) return ImageIcon;
    if (node.type === CanvasNodeType.Audio) return Music2;
    if (node.type === CanvasNodeType.Text) return FileText;
    if (node.type === CanvasNodeType.Character) return User;
    if (node.type === CanvasNodeType.Scene) return MapPinned;
    if (node.type === CanvasNodeType.Loop) return ListRestart;
    if (node.type === CanvasNodeType.Config) {
        const mode = node.metadata?.generationMode || (node.metadata?.smart ? "image" : undefined);
        if (mode === "video") return Video;
        if (mode === "audio") return Music2;
        if (mode === "text") return FileText;
        if (mode === "image") return ImageIcon;
    }
    return Settings2;
}

function nodeAccentColor(node: CanvasNodeData, theme: CanvasTheme) {
    if (node.type === CanvasNodeType.Character) return theme.node.typeStroke.character;
    if (node.type === CanvasNodeType.Scene) return theme.node.typeStroke.scene;
    if (node.type === CanvasNodeType.Group) return theme.node.typeStroke.group;
    if (node.type.includes("minimax-h3")) return theme.node.linkActive;
    return theme.node.muted;
}

type OverviewImage = Pick<CanvasNodeImage, "content" | "storageKey" | "naturalWidth" | "naturalHeight">;

function overviewImageForNode(node: CanvasNodeData): OverviewImage | undefined {
    if (node.type === CanvasNodeType.Character) {
        const images = node.metadata?.characterImages || [];
        const image = images[Math.min(Math.max(node.metadata?.characterPrimaryIndex || 0, 0), Math.max(images.length - 1, 0))];
        return image ? { content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height } : undefined;
    }
    if (node.type === CanvasNodeType.Scene) {
        const image = node.metadata?.sceneImage;
        return image ? { content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height } : undefined;
    }
    const images = node.metadata?.images || [];
    const primary = images.find((image) => image.id === node.metadata?.primaryImageId) || images[0];
    if (primary) return primary;
    if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) {
        return { content: node.metadata?.content || "", storageKey: node.metadata?.storageKey, naturalWidth: node.metadata?.naturalWidth || 0, naturalHeight: node.metadata?.naturalHeight || 0 };
    }
    return undefined;
}

function overviewSummary(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (node.type === CanvasNodeType.Character) return `${metadata?.characterName || node.title || "角色"} · ${metadata?.characterImages?.length || 0} 张参考图`;
    if (node.type === CanvasNodeType.Scene) return `${metadata?.sceneName || node.title || "场景"}${metadata?.sceneDescription ? ` · ${metadata.sceneDescription}` : ""}`;
    if (node.type === CanvasNodeType.Text || metadata?.generationMode === "text") return metadata?.content || metadata?.prompt || metadata?.texts?.[0]?.content || node.title || "文本";
    if (node.type === CanvasNodeType.Audio || metadata?.generationMode === "audio") return `${node.title || "音频"}${metadata?.durationMs ? ` · ${Math.round(metadata.durationMs / 1000)} 秒` : ""}`;
    if (node.type === CanvasNodeType.Video || metadata?.generationMode === "video") return `${node.title || "视频"}${metadata?.status ? ` · ${metadata.status}` : ""}`;
    if (node.type === CanvasNodeType.Group) return `${node.title || "分组"} · ${metadata?.groupLocked ? "已锁定" : "分组"}`;
    if (node.type === CanvasNodeType.Loop) return `${node.title || "循环"} · ${metadata?.loopCount || 1} 次`;
    return metadata?.prompt || metadata?.content || node.title || node.type;
}

function videoSourceFromSegment(segment: Record<string, unknown> | undefined) {
    const result = segment?.result;
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
        const value = result as Record<string, unknown>;
        return typeof value.url === "string" ? value.url : typeof value.video_url === "string" ? value.video_url : undefined;
    }
    const first = Array.isArray(segment?.results) ? segment.results[0] : undefined;
    if (first && typeof first === "object") {
        const value = first as Record<string, unknown>;
        return typeof value.url === "string" ? value.url : typeof value.video_url === "string" ? value.video_url : undefined;
    }
    return undefined;
}

function overviewVideoSource(node: CanvasNodeData, selectedSegmentId?: string) {
    if (node.type === CanvasNodeType.Video || node.metadata?.generationMode === "video") return node.metadata?.content;
    if (!node.type.includes("minimax-h3")) return undefined;
    const segments = Array.isArray((node.metadata as Record<string, unknown> | undefined)?.segments) ? ((node.metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>) : [];
    // selectedSegmentId 由插件窗口私有 view 提供；metadata 仅兼容没有打开过插件的旧节点。
    const selectedId = selectedSegmentId || String((node.metadata as Record<string, unknown> | undefined)?.selectedSegmentId || "");
    const segment = segments.find((item) => String(item.id || "") === selectedId) || segments[0];
    return videoSourceFromSegment(segment);
}

function OverviewImagePreview({ image, label, theme }: { image: OverviewImage; label: string; theme: CanvasTheme }) {
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    const subscribe = useCallback((listener: () => void) => subscribeImagePreview(image.storageKey, listener), [image.storageKey]);
    const getRevision = useCallback(() => getImagePreviewRevisionFor(image.storageKey), [image.storageKey]);
    useSyncExternalStore(subscribe, getRevision, () => 0);
    const [source, setSource] = useState(image.content || "");

    useEffect(() => {
        let cancelled = false;
        void ensureImagePreview(image.storageKey);
        void resolveImageUrl(image.storageKey, image.content)
            .then((url) => {
                if (!cancelled) setSource(url || image.content || "");
            })
            .catch(() => {
                if (!cancelled) setSource(image.content || "");
            });
        return () => {
            cancelled = true;
        };
    }, [backendConnected, backendToken, image.content, image.storageKey]);

    // 优先使用本地 WebP；缓存尚未生成或读取失败时回退到节点已有图片源，避免缩小后只剩占位图。
    const src = previewUrlFor(image.storageKey) || source;
    return src ? (
        <img src={src} alt={label} draggable={false} className="pointer-events-none h-full w-full select-none object-cover" />
    ) : (
        <div className="flex h-full w-full items-center justify-center" style={{ background: theme.toolbar.activeBg }}>
            <ImageIcon className="size-5 opacity-35" />
        </div>
    );
}

function OverviewVideoPreview({ source, label, theme, iconSize = 20 }: { source: string; label: string; theme: CanvasTheme; iconSize?: number }) {
    const subscribe = useCallback((listener: () => void) => subscribeVideoPreview(source, listener), [source]);
    const getRevision = useCallback(() => getVideoPreviewRevision(source), [source]);
    useSyncExternalStore(subscribe, getRevision, () => 0);
    useEffect(() => {
        ensureVideoPreview(source);
    }, [source]);
    const src = videoPreviewUrlFor(source);
    return src ? (
        <img src={src} alt={label} draggable={false} className="pointer-events-none h-full w-full select-none object-cover" />
    ) : (
        <div className="flex h-full w-full items-center justify-center">
            <Video style={{ width: iconSize, height: iconSize, color: theme.node.linkActive, opacity: 0.78 }} />
        </div>
    );
}

function OverviewH3Preview({ data, projectId, label, theme, iconSize }: { data: CanvasNodeData; projectId: string; label: string; theme: CanvasTheme; iconSize: number }) {
    const view = useMemo(() => getPluginNodeView(projectId, data.id), [data.id, projectId]);
    const viewState = useSyncExternalStore(view.subscribe, view.getSnapshot, () => emptyPluginView);
    const selectedSegmentId = typeof viewState.selectedSegmentId === "string" ? viewState.selectedSegmentId : undefined;
    const source = overviewVideoSource(data, selectedSegmentId);
    return source ? (
        <OverviewVideoPreview source={source} label={label} theme={theme} iconSize={iconSize} />
    ) : (
        <div className="flex h-full w-full items-center justify-center">
            <Video style={{ width: iconSize, height: iconSize, color: theme.node.linkActive, opacity: 0.78 }} />
        </div>
    );
}

function useImagePreviewRevision(storageKey?: string) {
    const subscribe = useCallback((listener: () => void) => subscribeImagePreview(storageKey, listener), [storageKey]);
    const getRevision = useCallback(() => getImagePreviewRevisionFor(storageKey), [storageKey]);
    useSyncExternalStore(subscribe, getRevision, () => 0);
}

/** 缩小时保留真实媒体缩略图或信息卡，只卸载编辑器、播放器和插件详情。 */
export const CanvasNodeOverview = React.memo(function CanvasNodeOverview({
    data,
    projectId,
    theme,
    previewPosition,
    previewBounds,
    scale,
    isSelected,
    isConnectionTarget,
    isRelated,
    isFocusRelated,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onContextMenu,
}: CanvasNodeProps) {
    const Icon = nodeTypeIcon(data);
    const position = previewBounds?.position || previewPosition || data.position;
    const width = previewBounds?.width || data.width;
    const height = previewBounds?.height || data.height;
    const active = isSelected || isConnectionTarget || isFocusRelated;
    const image = overviewImageForNode(data);
    const isH3 = !image && data.type.includes("minimax-h3");
    const videoSource = !image && !isH3 ? overviewVideoSource(data) : undefined;
    const isGroup = data.type === CanvasNodeType.Group;
    const isCharacter = data.type === CanvasNodeType.Character;
    const isScene = data.type === CanvasNodeType.Scene;
    const isSmartGenerationNode = data.type === CanvasNodeType.Config && data.metadata?.smart === true;
    const isTextOverview = data.type === CanvasNodeType.Text || (isSmartGenerationNode && data.metadata?.generationMode === "text");
    const textOverviewTitle = data.title || "文本";
    // 字号在低倍率时维持约 14px 屏幕高度，但必须同时受节点宽高和两行标题容量约束，不能用 transform 放大后溢出。
    const textOverviewFontSize = Math.max(12, Math.min(14 / Math.max(scale, 0.01), (width * 0.8) / Math.max(1, Math.ceil(Array.from(textOverviewTitle).length / 2)), height * 0.28));
    const overviewIconSize = Math.min(44 / Math.max(scale, 0.01), Math.min(width, height) * 0.42);
    const hasMediaPreview = Boolean(image || videoSource || isH3);
    const borderColor = active ? selectionBlue : isRelated ? theme.node.muted : nodeAccentColor(data, theme);
    const summary = overviewSummary(data);

    return (
        <div
            data-node-id={data.id}
            className={`node-element group/node absolute flex select-none overflow-hidden ${isH3 ? "rounded-lg border" : "rounded-3xl border-2"} ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${position.x}px, ${position.y}px)`,
                width,
                height,
                color: theme.node.text,
                background: isGroup || isH3 || hasMediaPreview ? "transparent" : theme.node.fill,
                borderColor,
                borderWidth: isGroup ? 3 : undefined,
                borderStyle: isGroup ? "dashed" : "solid",
                boxShadow: active ? `0 0 0 1px ${selectionBlue}55` : isRelated ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                // 画布节点处于父级 scale 变换层内；content-visibility:auto 在缩放到 24% 以下时
                // 会被部分浏览器误判为视口外，从而把概览节点整块跳过绘制。轻量壳本身已足够省开销，
                // 这里不再启用会影响可见性的浏览器跳过绘制。
                contain: "layout style",
            }}
            onMouseEnter={() => onHoverStart(data.id)}
            onMouseLeave={() => onHoverEnd(data.id)}
            onMouseDownCapture={(event) => {
                if (event.button === 0) onSelectCapture?.(event, data.id);
            }}
            onMouseDown={(event) => {
                event.stopPropagation();
                onMouseDown(event, data.id);
            }}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            {image ? (
                <OverviewImagePreview image={image} label={data.title || data.type} theme={theme} />
            ) : isH3 ? (
                <OverviewH3Preview data={data} projectId={projectId} label={data.title || data.type} theme={theme} iconSize={overviewIconSize} />
            ) : videoSource ? (
                <OverviewVideoPreview source={videoSource} label={data.title || data.type} theme={theme} iconSize={overviewIconSize} />
            ) : isTextOverview ? (
                <div className="flex h-full w-full items-center justify-center px-6 text-center" style={{ background: theme.node.fill }}>
                    <span className="line-clamp-2 font-semibold leading-snug opacity-85" style={{ fontSize: textOverviewFontSize }}>
                        {textOverviewTitle}
                    </span>
                </div>
            ) : (
                <div className="relative flex h-full w-full min-w-0 flex-col justify-between overflow-hidden p-3" style={{ background: theme.node.fill }}>
                    {!isGroup ? (
                        <Icon
                            aria-hidden="true"
                            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                            style={{ width: overviewIconSize, height: overviewIconSize, color: nodeAccentColor(data, theme), opacity: 0.22 }}
                        />
                    ) : null}
                    <div className="relative flex min-w-0 items-center gap-2">
                        {!isGroup ? <Icon className="size-4 shrink-0 opacity-80" style={{ color: nodeAccentColor(data, theme) }} /> : null}
                        <span className="truncate text-[11px] font-medium opacity-90">{data.title || data.type}</span>
                    </div>
                    <span className="relative line-clamp-2 text-[10px] leading-4 opacity-75">{summary}</span>
                </div>
            )}
            {image || videoSource || isH3 ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1 bg-black/45 px-2 py-1 text-[10px] text-white">
                    <Icon className="size-3 shrink-0" />
                    <span className="truncate">{data.title || summary}</span>
                </div>
            ) : null}
        </div>
    );
});

export const CanvasNodeViewportItem = React.memo(function CanvasNodeViewportItem(props: CanvasNodeProps) {
    const { dragPreviewPosition, resizePreviewBounds } = useCanvasNodePreview(props.projectId, props.data.id);
    let resolvedProps = props;
    if (dragPreviewPosition && props.previewPosition !== dragPreviewPosition) resolvedProps = { ...resolvedProps, previewPosition: dragPreviewPosition };
    if (resizePreviewBounds && resolvedProps.previewBounds !== resizePreviewBounds) resolvedProps = { ...resolvedProps, previewBounds: resizePreviewBounds };
    const screenShortSide = Math.min(resolvedProps.data.width, resolvedProps.data.height) * resolvedProps.scale;
    const detailModeRef = useRef(screenShortSide > NODE_OVERVIEW_MODE_ENTER_SCREEN_SIZE);
    if (screenShortSide >= NODE_DETAIL_MODE_ENTER_SCREEN_SIZE) detailModeRef.current = true;
    else if (screenShortSide <= NODE_OVERVIEW_MODE_ENTER_SCREEN_SIZE) detailModeRef.current = false;
    const overview =
        (resolvedProps.overviewMode || !detailModeRef.current) &&
        !resolvedProps.isSelected &&
        !resolvedProps.isConnectionSource &&
        !resolvedProps.isGroupDropTarget &&
        !resolvedProps.showPanel &&
        !resolvedProps.referenceSelectionState &&
        !resolvedProps.batchExpanded &&
        !resolvedProps.previewPosition &&
        !resolvedProps.previewBounds;
    if (overview) return <CanvasNodeOverview {...resolvedProps} />;
    // overviewMode 只决定是否切换到概览壳。远处节点悬停时仍保持缩略预览，
    // 只有明确选中/编辑才切回完整内容；避免低倍率下闪回一堆难读的小字。
    // 完整节点内部使用自己的 hover 状态，不要把父层每次 hover 变化继续传给图片、视频或插件内容。
    return <CanvasNode {...resolvedProps} isHovered={undefined} overviewMode={undefined} />;
});

type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    scale: number;
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLDivElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    pluginContext?: CanvasNodeContext | null;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (itemId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
    groupChildCount: number;
    compact: boolean;
};

function imageNaturalSize(node: CanvasNodeData) {
    const images = node.metadata?.images || [];
    const image = images.find((item) => item.id === node.metadata?.primaryImageId) || images[0];
    const width = image?.naturalWidth || node.metadata?.naturalWidth || 0;
    const height = image?.naturalHeight || node.metadata?.naturalHeight || 0;
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

function imageAspectRatio(node: CanvasNodeData) {
    const size = imageNaturalSize(node);
    return size ? size.width / size.height : node.width / Math.max(1, node.height);
}

export const CanvasNode = React.memo(function CanvasNode({
    data,
    theme,
    previewPosition,
    previewBounds,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    referenceSelectionState,
    showPanel,
    showImageInfo,
    mentionReferences = [],
    pluginHost,
    renderPanel,
    renderNodeContent,
    groupChildCount = 0,
    isGroupDropTarget = false,
    batchExpanded = false,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResizeStart,
    onResize,
    onResizeEnd,
    onTitleChange,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onRetry,
    onViewImage,
    onSelectReference,
    onContextMenu,
    onEditCharacter,
    onCharacterDrop,
    onEditScene,
    onSceneDrop,
}: CanvasNodeProps) {
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const definition = getNodeDefinition(data.type);
    const pluginContext = useMemo<CanvasNodeContext | null>(() => (pluginHost ? buildNodeContext(pluginHost, data, theme, scale, isSelected) : null), [pluginHost, data, theme, scale, isSelected]);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title || "");
    const isSmartGenerationNode = data.type === CanvasNodeType.Config && data.metadata?.smart === true;
    const smartMode = isSmartGenerationNode ? data.metadata?.generationMode || "image" : undefined;
    const isSmartImageNode = isSmartGenerationNode && smartMode === "image";
    const isAspectLockedImage = isSmartImageNode || (data.type === CanvasNodeType.Image && !data.metadata?.freeResize);
    const hasTextContent = (data.type === CanvasNodeType.Text || (isSmartGenerationNode && smartMode === "text")) && Boolean(data.metadata?.content?.trim());
    const hasImageContent = (data.type === CanvasNodeType.Image || (isSmartGenerationNode && smartMode === "image")) && Boolean(data.metadata?.content || data.metadata?.images?.length);
    const hasVideoContent = (data.type === CanvasNodeType.Video || (isSmartGenerationNode && smartMode === "video")) && Boolean(data.metadata?.content);
    const hasAudioContent = (data.type === CanvasNodeType.Audio || (isSmartGenerationNode && smartMode === "audio")) && Boolean(data.metadata?.content);
    const isCharacter = data.type === CanvasNodeType.Character;
    const hasCharacterContent = isCharacter && (data.metadata?.characterImages?.length || 0) > 0;
    const isScene = data.type === CanvasNodeType.Scene;
    const hasSceneContent = isScene && Boolean(data.metadata?.sceneImage?.url);
    const isGroup = data.type === CanvasNodeType.Group;
    const batchCount =
        data.type === CanvasNodeType.Image || (isSmartGenerationNode && smartMode === "image")
            ? data.metadata?.images?.length || 0
            : data.type === CanvasNodeType.Text || (isSmartGenerationNode && smartMode === "text")
              ? data.metadata?.texts?.length || 0
              : 0;
    const isBatchRoot = batchCount > 1;
    // Nodes with the interaction/move toggle ignore content pointer events in move mode and allow interaction in interactive mode.
    // forceInteractive states such as editing stay interactive, as do empty nodes so their upload and generation actions remain usable.
    const supportsInteractionToggle = Boolean(definition?.interactionToggle);
    const forceInteractive = useSyncExternalStore(
        pluginContext?.view.subscribe || subscribeNoPluginView,
        () => (supportsInteractionToggle ? Boolean(definition?.forceInteractive?.(data, pluginContext?.view.getSnapshot() || emptyPluginView)) : false),
        () => false,
    );
    const contentInteractive = !supportsInteractionToggle || forceInteractive || !data.metadata?.content ? true : Boolean(data.metadata?.interactive);
    // Transparent nodes such as SVGs blend into the canvas while retaining outlines for selected or related states.
    const transparentBg = Boolean(definition?.transparentBackground);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    // 概览和完整媒体节点共用同一条默认边框，缩放跨过详情阈值时不再像换了一套卡片皮肤。
    const imageBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.stroke;
    const smartBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.stroke;
    const characterBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.typeStroke.character;
    const sceneBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.typeStroke.scene;
    const groupBorderColor = isGroupDropTarget || isActive ? selectionBlue : theme.node.typeStroke.group;
    const nodeBorderColor = isGroup
        ? groupBorderColor
        : isCharacter
          ? characterBorderColor
          : isScene
            ? sceneBorderColor
            : isSmartGenerationNode
              ? smartBorderColor
              : hasImageContent || hasCharacterContent || hasSceneContent
                ? imageBorderColor
                : isActive
                  ? selectionBlue
                  : isRelated
                    ? theme.node.muted
                    : transparentBg
                      ? "transparent"
                      : theme.node.stroke;
    const textareaRef = useRef<HTMLDivElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });
    const autoFitImageRef = useRef("");

    useEffect(() => {
        setTitleDraft(data.title || "");
    }, [data.title]);

    useEffect(() => {
        if (!isEditingTitle) return;
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
    }, [isEditingTitle]);

    const finishTitleEditing = useCallback(() => {
        const title = titleDraft.trim() || data.title || t("canvas.node.untitled");
        setTitleDraft(title);
        setIsEditingTitle(false);
        if (title !== data.title) onTitleChange(data.id, title);
    }, [data.id, data.title, onTitleChange, t, titleDraft]);

    useEffect(() => {
        if (!isEditingTitle) return;
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && titleInputRef.current?.contains(target)) return;
            finishTitleEditing();
        };
        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [finishTitleEditing, isEditingTitle]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            // 竖向裁剪图经常在生成时就接近原来的 220px 最小宽度，
            // 图片节点需要允许继续缩小；其他节点保留原有可读性下限。
            const minWidth = data.type === CanvasNodeType.Image ? 120 : 220;
            const minHeight = data.type === CanvasNodeType.Image ? 120 : 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd(data.id);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        onResizeStart(data.id);
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: isAspectLockedImage || data.type === CanvasNodeType.Video || Boolean(definition?.keepAspectRatio?.(data)),
            ratio: imageAspectRatio(data),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    const adaptiveImageSize = isAspectLockedImage ? imageNaturalSize(data) : null;
    const adaptiveImageWidth = adaptiveImageSize?.width;
    const adaptiveImageHeight = adaptiveImageSize?.height;
    useEffect(() => {
        if (!isAspectLockedImage || !adaptiveImageWidth || !adaptiveImageHeight) {
            autoFitImageRef.current = "";
            return;
        }
        const key = `${data.id}:${adaptiveImageWidth}:${adaptiveImageHeight}`;
        if (autoFitImageRef.current === key) return;
        autoFitImageRef.current = key;

        const scale = Math.min(data.width / adaptiveImageWidth, data.height / adaptiveImageHeight);
        const width = adaptiveImageWidth * scale;
        const height = adaptiveImageHeight * scale;
        if (Math.abs(width - data.width) < 0.5 && Math.abs(height - data.height) < 0.5) return;
        onResizeStart(data.id);
        onResize(data.id, width, height, {
            x: data.position.x + (data.width - width) / 2,
            y: data.position.y + (data.height - height) / 2,
        });
        onResizeEnd(data.id);
    }, [data.height, data.id, data.position.x, data.position.y, data.width, isAspectLockedImage, onResize, onResizeEnd, onResizeStart, adaptiveImageHeight, adaptiveImageWidth]);

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    const panelContent = showPanel && !isGroup && renderPanel ? renderPanel(data) : null;
    const compact = scale < 0.24 && !isSelected && !hovered && !showPanel && !referenceSelectionState;

    return (
        <div
            data-node-id={data.id}
            className={`node-element group/node absolute flex select-none flex-col transition-shadow duration-200 ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"} ${referenceSelectionState === "available" ? "cursor-pointer" : referenceSelectionState ? "cursor-not-allowed" : ""}`}
            style={{
                transform: `translate(${(previewBounds?.position || previewPosition || data.position).x}px, ${(previewBounds?.position || previewPosition || data.position).y}px)`,
                width: previewBounds?.width || data.width,
                height: previewBounds?.height || data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onMouseDownCapture={(event) => {
                if (!referenceSelectionState) onSelectCapture?.(event, data.id);
                if (!referenceSelectionState) {
                    // H3 节点内容几乎全是交互控件，且其根 div 在冒泡阶段 stopPropagation 挡掉了普通的
                    // body 拖拽路径，只能走这里。若沿用全量黑名单（button/input/textarea/select/video），
                    // 节点上几乎任何可见区域都命中被排除，导致“拖不动”。故对 H3 仅屏蔽纯文本编辑控件，
                    // H3 只允许从自己的标题栏拖动，其他区域全部保留给控件和内容交互。
                    const target = event.target as HTMLElement;
                    const isH3 = data.type === "minimax-h3:video";
                    const interactive = isH3 ? target.closest("button, input, textarea, select, video") : target.closest("button, input, textarea, select, video");
                    const isH3DragHandle = target.closest("[data-canvas-node-drag-handle]");
                    // 四角缩放手柄是纯 div，会命中上面的拖拽分支；但若在此处触发拖拽，
                    // handleNodeMouseDown 的 event.stopPropagation() 会掐断事件，使 ResizeHandle 自己的
                    // onMouseDown（冒泡阶段）无法执行，缩放被拖拽彻底劫持。故需显式排除缩放手柄。
                    const onResizeHandle = target.closest("[data-resize-handle]");
                    // 连线手柄（ConnectionHandleDot）与缩放手柄同理：纯 div 会命中拖拽分支，
                    // capture 阶段触发 handleNodeMouseDown 的 stopPropagation 会掐断其自身
                    // onMouseDown（onConnectStart，冒泡阶段），导致无法连线、反而变成拖拽。需显式排除。
                    const onConnectionHandle = target.closest("[data-connection-handle]");
                    // 节点下方的面板（提示词/参考内容等）是纯交互区：面板已在冒泡阶段 stopPropagation，
                    // 但 capture 先于冒泡执行，会先在这里触发拖拽。命中面板时跳过拖拽，把交互留给面板自身。
                    const onNodePanel = target.closest("[data-canvas-node-panel]");
                    if (!interactive && !onResizeHandle && !onConnectionHandle && !onNodePanel && (!isH3 || isH3DragHandle)) onMouseDown(event, data.id);
                }
            }}
            onContextMenu={(event) => {
                if (referenceSelectionState) event.preventDefault();
                else onContextMenu(event, data.id);
            }}
        >
            {!referenceSelectionState && (isSelected || hovered || isEditingTitle) && (
                <div className="absolute left-3 top-[-28px] z-[65] max-w-[calc(100%-24px)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {isEditingTitle ? (
                        <input
                            ref={titleInputRef}
                            value={titleDraft}
                            maxLength={64}
                            className="h-6 max-w-full border-0 border-b border-dashed bg-transparent px-0 text-left text-xs font-medium outline-none"
                            style={{ borderColor: theme.node.muted, color: theme.node.text }}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onBlur={finishTitleEditing}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") finishTitleEditing();
                                if (event.key === "Escape") {
                                    setTitleDraft(data.title || "");
                                    setIsEditingTitle(false);
                                }
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="block max-w-full truncate border-b border-dashed border-transparent px-0 py-0.5 text-left text-xs font-medium opacity-75 transition hover:border-current hover:opacity-100"
                            style={{ color: theme.node.text }}
                            title={t("canvas.node.renameHint")}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                if (data.type === CanvasNodeType.Character && onEditCharacter) {
                                    onEditCharacter(data);
                                } else if (data.type === CanvasNodeType.Scene && onEditScene) {
                                    onEditScene(data);
                                } else {
                                    setIsEditingTitle(true);
                                }
                            }}
                        >
                            {data.title || t("canvas.node.untitled")}
                        </button>
                    )}
                </div>
            )}

            <div
                data-character-drop={data.type === CanvasNodeType.Character ? "true" : undefined}
                className={`relative h-full w-full overflow-visible ${data.type === "minimax-h3:video" ? "rounded-lg border" : "rounded-3xl border-2"}`}
                style={{
                    background: isGroup || data.type === "minimax-h3:video" ? "transparent" : hasImageContent || hasVideoContent || hasCharacterContent || hasSceneContent || transparentBg ? "transparent" : theme.node.fill,
                    borderRadius: data.type === "minimax-h3:video" ? 8 : undefined,
                    borderColor: nodeBorderColor,
                    borderStyle: isGroup ? "dashed" : "solid",
                    borderWidth: isGroup ? 3 : undefined,
                    boxShadow: isGroupDropTarget ? `0 0 0 2px ${selectionBlue}66, inset 0 0 0 999px ${selectionBlue}10` : isActive ? `0 0 0 1px ${selectionBlue}55` : isRelated ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => {
                    const target = event.target as HTMLElement;
                    const isH3 = data.type === "minimax-h3:video";
                    if (!referenceSelectionState && (!isH3 || target.closest("[data-canvas-node-drag-handle]"))) onMouseDown(event, data.id);
                    else if (event.button === 0 && referenceSelectionState === "available") {
                        event.stopPropagation();
                        onSelectReference?.(data.id);
                    }
                }}
                onDoubleClick={(event) => {
                    if (referenceSelectionState) {
                        event.stopPropagation();
                        return;
                    }
                    if (definition?.onDoubleClick && pluginContext) {
                        if (definition.onDoubleClick(pluginContext)) event.stopPropagation();
                        return;
                    }
                    if ((data.type === CanvasNodeType.Image || isSmartGenerationNode) && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type === CanvasNodeType.Character) {
                        event.stopPropagation();
                        onEditCharacter?.(data);
                        return;
                    }
                    if (data.type === CanvasNodeType.Scene) {
                        event.stopPropagation();
                        onEditScene?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    setIsEditingContent(true);
                }}
                onDragOver={(event) => {
                    if (data.type !== CanvasNodeType.Character && data.type !== CanvasNodeType.Scene) return;
                    const types = Array.from(event.dataTransfer?.types || []);
                    if (types.includes("application/x-infinite-canvas-ref")) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                    }
                }}
                onDrop={(event) => {
                    if (data.type !== CanvasNodeType.Character && data.type !== CanvasNodeType.Scene) return;
                    const raw = event.dataTransfer.getData("application/x-infinite-canvas-ref") || event.dataTransfer.getData("application/json") || event.dataTransfer.getData("text/plain");
                    if (!raw) return;
                    try {
                        const ref = JSON.parse(raw) as { url?: string; type?: string; kind?: string; storageKey?: string; name?: string; mimeType?: string };
                        const kind = ref.kind || ref.type;
                        if (kind === "image" && ref.url) {
                            event.preventDefault();
                            event.stopPropagation();
                            if (data.type === CanvasNodeType.Character) onCharacterDrop?.(data, { url: ref.url, type: "image", name: ref.name, storageKey: ref.storageKey, mimeType: ref.mimeType });
                            else onSceneDrop?.(data, { url: ref.url, name: ref.name, storageKey: ref.storageKey, mimeType: ref.mimeType });
                        } else if (kind === "audio" && ref.url && data.type === CanvasNodeType.Character) {
                            event.preventDefault();
                            event.stopPropagation();
                            onCharacterDrop?.(data, { url: ref.url, type: "audio", name: ref.name, storageKey: ref.storageKey, mimeType: ref.mimeType });
                        }
                    } catch {
                        // ignore
                    }
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center ${data.type === "minimax-h3:video" ? "rounded-lg" : "rounded-[inherit]"} ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: isGroup ? "transparent" : hasImageContent || hasVideoContent || hasCharacterContent || hasSceneContent || transparentBg ? "transparent" : theme.node.fill,
                            pointerEvents: contentInteractive ? undefined : "none",
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        scale={scale}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        renderNodeContent={renderNodeContent}
                        pluginContext={pluginContext}
                        mentionReferences={mentionReferences}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={(itemId) => onSetBatchPrimary?.(data.id, itemId)}
                        onDuplicateBatchImage={(imageId) => onDuplicateBatchImage?.(data, imageId)}
                        onDownloadBatchImage={(imageId) => onDownloadBatchImage?.(data, imageId)}
                        onRetryBatchImage={(imageId) => onRetryBatchImage?.(data, imageId)}
                        onDeleteBatchImage={(imageId) => onDeleteBatchImage?.(data.id, imageId)}
                        onViewBatchImage={(imageId) => onViewImage?.(data, imageId)}
                        groupChildCount={groupChildCount}
                        compact={compact}
                    />
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {!isGroup && data.type !== "minimax-h3:video" && !hasImageContent && !hasVideoContent && !hasAudioContent ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} />
                ) : null}

                {referenceSelectionState && (referenceSelectionState !== "available" || hovered) ? (
                    <div
                        className="pointer-events-none absolute inset-0 z-[60] grid place-items-center rounded-[inherit]"
                        style={{
                            background: `color-mix(in srgb, ${theme.canvas.background} ${referenceSelectionState === "target" ? 78 : referenceSelectionState === "disabled" ? 60 : 34}%, transparent)`,
                            boxShadow: referenceSelectionState === "available" ? `inset 0 0 0 2px ${selectionBlue}` : undefined,
                        }}
                    >
                        {referenceSelectionState !== "disabled" ? (
                            <span className="rounded-lg px-3 py-2 text-sm font-medium shadow-sm" style={{ background: theme.toolbar.panel, color: theme.node.text }}>
                                {t(referenceSelectionState === "target" ? "canvas.references.selecting" : "canvas.references.choose")}
                            </span>
                        ) : null}
                    </div>
                ) : null}

                {!referenceSelectionState ? <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} /> : null}
                {!referenceSelectionState ? <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} /> : null}
            </div>

            {!referenceSelectionState && !isGroup ? <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "target")} /> : null}
            {!referenceSelectionState && (definition?.hasSourceHandle ?? true) && (data.type !== CanvasNodeType.Config || isSmartGenerationNode) ? (
                <ConnectionHandleDot side="right" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "source")} />
            ) : null}

            {panelContent ? (
                <div data-canvas-node-panel className="absolute left-1/2 top-full z-[70] w-[600px] -translate-x-1/2 pt-4">
                    {panelContent}
                </div>
            ) : null}
        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    if (props.compact) return <CompactNodeContent node={props.node} theme={props.theme} scale={props.scale} />;
    if (props.node.type === CanvasNodeType.Config && props.node.metadata?.smart && props.renderNodeContent) {
        const mode = props.node.metadata.generationMode || "image";
        const result =
            props.node.metadata.status === "loading" ? (
                <LoadingContent theme={props.theme} />
            ) : props.node.metadata.status === "error" && !props.node.metadata.content ? (
                <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />
            ) : mode === "video" ? (
                <VideoNodeContent {...props} />
            ) : mode === "audio" ? (
                <AudioNodeContent {...props} />
            ) : mode === "text" ? (
                <TextContent {...props} />
            ) : (
                <ImageNodeContent {...props} />
            );
        return (
            <div className="flex h-full w-full flex-col overflow-visible rounded-[inherit]">
                <div className="min-h-0 flex-1 overflow-visible">{result}</div>
            </div>
        );
    }
    if ((props.node.type === CanvasNodeType.Config || props.node.type === CanvasNodeType.Loop) && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.isBatchRoot && props.node.type === CanvasNodeType.Image) return <ImageNodeContent {...props} />;
    if (props.node.type === CanvasNodeType.Text && props.node.metadata?.texts?.length && (props.node.metadata.status !== "error" || props.node.metadata.texts.some((text) => text.content))) return <TextContent {...props} />;
    // The H3 workbench owns its loading/error presentation. Keep the complete
    // editor visible so a failed generation does not replace it with the
    // generic canvas error card (the legacy node behaved this way).
    if (props.node.type === "minimax-h3:video") {
        const h3Definition = getNodeDefinition(props.node.type);
        if (h3Definition?.Content && props.pluginContext) {
            const H3Content = h3Definition.Content;
            return <H3Content ctx={props.pluginContext} />;
        }
    }
    if (props.node.metadata?.status === "loading") return <LoadingContent theme={props.theme} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;

    const Renderer = nodeContentRenderers[props.node.type as CanvasNodeType];
    if (Renderer) return <Renderer {...props} />;

    // Render plugin nodes with their registered renderer, or show the missing-plugin placeholder.
    const definition = getNodeDefinition(props.node.type);
    if (definition?.Content && props.pluginContext) {
        const PluginContent = definition.Content;
        return <PluginContent ctx={props.pluginContext} />;
    }
    return <MissingPluginContent theme={props.theme} type={props.node.type} />;
}

function CompactNodeContent({ node, theme, scale }: Pick<NodeContentRendererProps, "node" | "theme" | "scale">) {
    const Icon = nodeTypeIcon(node);
    const isGroup = node.type === CanvasNodeType.Group;
    const iconSize = Math.min(44 / Math.max(scale, 0.01), Math.min(node.width, node.height) * 0.42);
    return (
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden" style={{ color: theme.node.text }} aria-label={node.title || node.type}>
            {!isGroup ? <Icon aria-hidden="true" style={{ width: iconSize, height: iconSize, color: nodeAccentColor(node, theme) }} /> : null}
            <span
                className={`absolute inset-x-1 truncate text-center opacity-75 ${isGroup ? "inset-y-0 flex items-center justify-center" : "bottom-1"}`}
                style={isGroup ? { fontSize: Math.min(12 / Math.max(scale, 0.01), Math.min(node.width, node.height) * 0.35) } : undefined}
            >
                {node.title || node.type}
            </span>
        </div>
    );
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Loop]: EmptyLoopContent,
    [CanvasNodeType.Group]: GroupNodeContent,
    [CanvasNodeType.Character]: CharacterNodeContent,
    [CanvasNodeType.Scene]: SceneNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function EmptyLoopContent({ node, theme }: NodeContentRendererProps) {
    return (
        <div className="flex h-full w-full items-center gap-3 px-4" style={{ color: theme.node.text }}>
            <ListRestart className="size-5 shrink-0 opacity-70" />
            <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{node.title}</div>
                <div className="mt-1 text-xs opacity-60">{node.metadata?.loopCount || 1} ×</div>
            </div>
        </div>
    );
}

function GroupNodeContent({ node, theme, groupChildCount }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none flex h-full w-full p-3">
            <div className="flex h-7 max-w-full items-center gap-2 px-1 text-xs font-medium" style={{ color: theme.node.text }}>
                <span className="truncate">{node.title || t("canvas.node.group")}</span>
                <span className="shrink-0 text-[11px] font-normal" style={{ color: theme.node.muted }}>
                    {t("canvas.node.nodeCount", { count: groupChildCount })}
                </span>
            </div>
        </div>
    );
}

function LoadingContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span>
        </div>
    );
}

function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    const { t } = useTranslation();
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="text-xs leading-5 text-red-300">{node.metadata?.errorDetails || t("canvas.node.failed")}</div>
            <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
        </div>
    );
}

function MissingPluginContent({ theme, type }: Pick<NodeContentRendererProps, "theme"> & { type: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Puzzle className="size-7 opacity-40" />
            <span className="text-sm">{t("canvas.node.missingPlugin")}</span>
            <span className="text-[11px] opacity-70">{t("canvas.node.missingPluginDescription", { type })}</span>
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, batchExpanded, onStopEditing, onToggleBatch, onSetBatchPrimary }: NodeContentRendererProps) {
    const { id: projectId = "" } = useParams();
    const { t } = useTranslation();
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;
    const texts = node.metadata?.texts || [];
    const batchCount = texts.length;
    const isBatchRoot = batchCount > 1;
    const primaryTextId = node.metadata?.primaryTextId || texts[0]?.id;
    const primaryText = texts.find((text) => text.id === primaryTextId);
    const content = primaryText?.content || node.metadata?.content || "";
    const paddingClass = isBatchRoot ? "px-4 pb-4 pt-14" : "p-4";

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded ? texts.filter((text) => text.id !== primaryTextId).map((text, index) => <ExpandedTextCard key={text.id} node={node} text={text} index={index} onSetPrimary={() => onSetBatchPrimary?.(text.id)} />) : null}
            <div className="flex h-full w-full flex-col overflow-hidden rounded-3xl">
                {isEditingContent ? (
                    <div ref={textareaRef} className="h-full w-full">
                        <CanvasCollaborativeText
                            projectId={projectId}
                            target={{ nodeId: node.id, field: "content", ...(primaryText ? { textItemId: primaryText.id } : {}) }}
                            className={`thin-scrollbar h-full w-full overflow-y-auto font-mono select-text ${paddingClass}`}
                            style={textStyle}
                            references={mentionReferences}
                            autoFocus
                            onBlur={onStopEditing}
                            onEscape={onStopEditing}
                        />
                    </div>
                ) : content ? (
                    <div className={`thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono ${paddingClass}`} style={textStyle} onWheel={(event) => event.stopPropagation()}>
                        {content}
                    </div>
                ) : primaryText ? (
                    <TextSlotStatus text={primaryText} />
                ) : (
                    <div className="p-4 font-mono" style={{ color: theme.node.placeholder }}>
                        {t("canvas.node.editText")}
                    </div>
                )}
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.12)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.textBatchExpanded") : t("canvas.node.textBatchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.texts", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedTextCard({ node, text, index, onSetPrimary }: { node: CanvasNodeData; text: CanvasNodeText; index: number; onSetPrimary: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const count = node.metadata?.texts?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const x = (slot % columns) * (node.width + 18);
    const y = (Math.floor(slot / columns) - rows + 1) * (node.height + 18);

    return (
        <div
            className="absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.14)]"
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: theme.node.panel,
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {text.content ? (
                <>
                    <div className="thin-scrollbar h-full overflow-y-auto whitespace-pre-wrap break-words px-4 pb-4 pt-14 font-mono text-sm leading-6" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
                        {text.content}
                    </div>
                    <button
                        type="button"
                        className="pointer-events-none absolute right-2.5 top-2.5 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium opacity-0 transition duration-150 hover:bg-black/5 group-hover/node:pointer-events-auto group-hover/node:opacity-100 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                        onClick={(event) => (event.stopPropagation(), onSetPrimary())}
                    >
                        <Star className="size-3.5" style={{ color: selectionBlue }} />
                        {t("canvas.node.setPrimaryText")}
                    </button>
                </>
            ) : (
                <TextSlotStatus text={text} />
            )}
        </div>
    );
}

function TextSlotStatus({ text }: { text: CanvasNodeText }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const failed = text.status === "error";
    const loading = text.status === "loading";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? (
                <span className="text-xs leading-5">{text.errorDetails || t("canvas.node.failed")}</span>
            ) : loading ? (
                <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            ) : (
                <span className="text-xs">{t("apiErrors.noContent")}</span>
            )}
            {loading ? <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span> : null}
        </div>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && !props.isBatchRoot) {
        if (props.node.metadata?.status === "loading" || props.node.metadata?.images?.[0]?.status === "loading") return <LoadingContent theme={props.theme} />;
        if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;
        return <EmptyImageContent {...props} />;
    }

    return (
        <ImageContent
            node={props.node}
            scale={props.scale}
            batchExpanded={props.batchExpanded}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onDuplicateBatchImage={props.onDuplicateBatchImage}
            onDownloadBatchImage={props.onDownloadBatchImage}
            onRetryBatchImage={props.onRetryBatchImage}
            onDeleteBatchImage={props.onDeleteBatchImage}
            onViewBatchImage={props.onViewBatchImage}
        />
    );
}

function EmptyImageContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
        </div>
    );
}

function SceneNodeContent({ node, theme, scale }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const image = node.metadata?.sceneImage;
    const colorCard = node.metadata?.sceneColorCard;
    const [imageUrl, setImageUrl] = useState("");
    const [colorCardUrl, setColorCardUrl] = useState("");
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    useImagePreviewRevision(image?.storageKey);
    useImagePreviewRevision(colorCard?.storageKey);

    useEffect(() => {
        let cancelled = false;
        if (!image?.url && !image?.storageKey) {
            setImageUrl("");
            return;
        }
        void ensureImagePreview(image.storageKey);
        resolveImageUrl(image.storageKey, image.url).then((url) => { if (!cancelled) setImageUrl(url); }).catch(() => { if (!cancelled) setImageUrl(""); });
        return () => { cancelled = true; };
    }, [backendConnected, backendToken, image?.storageKey, image?.url]);

    useEffect(() => {
        let cancelled = false;
        if (!colorCard?.url && !colorCard?.storageKey) {
            setColorCardUrl("");
            return;
        }
        void ensureImagePreview(colorCard.storageKey);
        resolveImageUrl(colorCard.storageKey, colorCard.url).then((url) => { if (!cancelled) setColorCardUrl(url); }).catch(() => { if (!cancelled) setColorCardUrl(""); });
        return () => { cancelled = true; };
    }, [backendConnected, backendToken, colorCard?.storageKey, colorCard?.url]);

    if (!image) return <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}><MapPinned className="size-9 opacity-30" /><span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.scene.empty")}</span></div>;
    const source = imageUrl ? pickImageSource({ previewUrl: previewUrlFor(image.storageKey), originalUrl: imageUrl, naturalWidth: image.width, naturalHeight: image.height, renderedWidth: node.width, renderedHeight: node.height, scale }) : "";
    return (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-[inherit]">
            <div className="relative min-h-0 flex-1 overflow-hidden" style={{ background: theme.node.panel }}>
                {source ? <img src={source} alt={node.title} className="size-full object-cover" draggable={false} /> : <div className="flex size-full items-center justify-center"><MapPinned className="size-9 opacity-30" /></div>}
                {node.metadata?.sceneDescription ? <div className="absolute inset-x-2 bottom-2 line-clamp-2 rounded-md bg-black/55 px-2 py-1 text-[10px] leading-4 text-white">{node.metadata.sceneDescription}</div> : null}
            </div>
            {(colorCardUrl || node.metadata?.sceneColorCardPrompt) ? (
                <div className="flex shrink-0 items-center gap-2 border-t px-2 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    {colorCardUrl ? <img src={previewUrlFor(colorCard?.storageKey) || colorCardUrl} alt={t("canvas.scene.colorCard")} className="size-8 shrink-0 rounded object-cover" draggable={false} /> : null}
                    <span className="min-w-0 truncate text-[10px]" style={{ color: theme.node.muted }} title={node.metadata?.sceneColorCardPrompt}>{node.metadata?.sceneColorCardPrompt || t("canvas.scene.colorCard")}</span>
                </div>
            ) : null}
        </div>
    );
}

/** 角色节点被图像类生成节点引用时，用选中的参考图作为节点背景的栅格展示：
 *  1 张图 → 栅格 1 列（占 1 格方形，铺满节点）；2 张图 → 栅格 2 列（横向并排占 2 格的矩形）；不显示声线。 */
type CharacterImage = NonNullable<NonNullable<CanvasNodeData["metadata"]>["characterImages"]>[number];
type CharacterReferenceCell = { image: CharacterImage; index: number };

function CharacterReferenceCellView({ node, theme, refs, thumbUrls }: { node: CanvasNodeData; theme: CanvasTheme; refs: CharacterReferenceCell[]; thumbUrls: Record<number, string> }) {
    const { t } = useTranslation();
    const urlFor = (image: CharacterImage, index: number) => previewUrlFor(image.storageKey) || thumbUrls[index] || image.url || "";
    const cols = refs.length === 1 ? 1 : 2;
    return (
        <div className="relative h-full w-full overflow-hidden" style={{ background: theme.node.panel }}>
            {/* 背景栅格：1 列 / 2 列，每格用所选图铺满 */}
            <div className="absolute inset-0 grid gap-0.5 p-0.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {refs.map(({ image, index }) => {
                    const url = urlFor(image, index);
                    return (
                        <div key={index} className="relative min-h-0 min-w-0 overflow-hidden rounded-md">
                            {url ? (
                                <img src={url} alt={image.outfit || image.name || ""} className="size-full object-cover" draggable={false} />
                            ) : (
                                <div className="flex size-full items-center justify-center" style={{ background: theme.node.fill }}>
                                    <User className="size-6 opacity-30" />
                                </div>
                            )}
                            {image.outfit ? (
                                <div className="absolute bottom-1 left-1 max-w-[calc(100%-8px)] truncate rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">{image.outfit}</div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
            {/* 顶部信息条：浮动叠加在背景图上，半透明压暗保证可读 */}
            <div className="absolute inset-x-0 top-0 flex shrink-0 items-center gap-1.5 border-b border-white/15 bg-black/35 px-2 py-1.5 text-[10px] backdrop-blur-[1px]">
                <User className="size-3 shrink-0 text-white/90" />
                <span className="min-w-0 truncate font-medium text-white">{node.metadata?.characterName || node.title || "角色"}</span>
                <span className="ml-auto shrink-0 rounded bg-white/25 px-1 py-0.5 text-white">{t("canvas.character.imageReference")}</span>
            </div>
        </div>
    );
}

/** 角色节点：主图（大）+ 底部 outfit 缩略图条；多图时像多图片输出节点一样可横向展开，点缩略图或“设为主图”切换主图。 */
function CharacterNodeContent(props: NodeContentRendererProps) {
    const { node, theme, scale, batchExpanded, onToggleBatch, onSetBatchPrimary, onDeleteBatchImage, onViewBatchImage } = props;
    const { t } = useTranslation();
    const images = node.metadata?.characterImages || [];
    const primaryIndex = Math.min(Math.max(node.metadata?.characterPrimaryIndex || 0, 0), Math.max(images.length - 1, 0));
    const primary = images[primaryIndex];
    const voiceUrl = node.metadata?.characterVoiceUrl || "";
    const voiceName = node.metadata?.characterVoiceName || "";
    const voiceDescription = node.metadata?.characterVoiceDescription || "";
    // 角色节点被「图像类生成节点」（生图 / 智能选生图）引用时，用选中的参考图作为背景栅格展示：
    // 1 张占 1 格（方形），2 张并排成横向矩形占 2 格；该模式下不显示声线。
    // 注意：所选参考图保存在「引用本角色的生成节点」上：genNode.metadata.characterReferences[characterNodeId] = { imageKeys, voiceEnabled }。
    const { id: projectId = "" } = useParams();
    const upstreamNodes = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.nodes || EMPTY_NODES);
    const upstreamConnections = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.connections || EMPTY_CONNECTIONS);
    const imageGenReference = useMemo<{ image: CharacterImage; index: number }[] | null>(() => {
        const genNode =
            upstreamNodes.find((n) => isImageGenerationNode(n) && Boolean(n.metadata?.characterReferences?.[node.id])) ||
            (() => {
                for (const conn of upstreamConnections) {
                    if (conn.fromNodeId !== node.id) continue;
                    const n = upstreamNodes.find((m) => m.id === conn.toNodeId);
                    if (isImageGenerationNode(n) && n?.metadata?.characterReferences?.[node.id]) return n;
                }
                return undefined;
            })();
        if (!genNode) return null;
        const selection = genNode.metadata?.characterReferences?.[node.id];
        const keys = selection?.imageKeys ? new Set(selection.imageKeys) : null;
        const selected = keys
            ? images.map((image, index) => ({ image, index })).filter(({ image, index }) => keys.has(characterReferenceKey(image, index)))
            : images.map((image, index) => ({ image, index }));
        return selected.length ? selected : null;
    }, [node.id, images, upstreamNodes, upstreamConnections]);
    const [primaryUrl, setPrimaryUrl] = useState<string | null>(null);
    const [thumbUrls, setThumbUrls] = useState<Record<number, string>>({});
    const urlCache = useRef<Record<string, string>>({});
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    useImagePreviewRevision(primary?.storageKey);

    // 解析主图 URL（storageKey → blob URL / dataUrl）
    useEffect(() => {
        let cancelled = false;
        if (!primary) {
            setPrimaryUrl(null);
            return;
        }
        void ensureImagePreview(primary.storageKey);
        const key = primary.storageKey || primary.url;
        if (!key) {
            setPrimaryUrl(null);
            return;
        }
        if (urlCache.current[key]) {
            setPrimaryUrl(urlCache.current[key]);
            return;
        }
        resolveImageUrl(key, primary.url)
            .then((url) => {
                if (cancelled) return;
                if (url) urlCache.current[key] = url;
                setPrimaryUrl(url);
            })
            .catch(() => {
                if (!cancelled) setPrimaryUrl(null);
            });
        return () => {
            cancelled = true;
        };
    }, [backendConnected, backendToken, primary?.url, primary?.storageKey]);

    // 解析所有缩略图 URL
    useEffect(() => {
        let cancelled = false;
        const next: Record<number, string> = {};
        Promise.all(
            images.map(async (image, idx) => {
                void ensureImagePreview(image.storageKey);
                const key = image.storageKey || image.url;
                if (!key) return null;
                if (urlCache.current[key]) {
                    next[idx] = urlCache.current[key];
                    return;
                }
                const url = await resolveImageUrl(key, image.url).catch(() => null);
                if (url) {
                    urlCache.current[key] = url;
                    next[idx] = url;
                }
                return null;
            }),
        ).then(() => {
            if (!cancelled) setThumbUrls(next);
        });
        return () => {
            cancelled = true;
        };
    }, [backendConnected, backendToken, images]);

    useEffect(
        () => () => {
            Object.values(urlCache.current).forEach((url) => URL.revokeObjectURL(url));
        },
        [],
    );

    if (!images.length) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4" style={{ color: theme.node.placeholder }}>
                <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                    <User className="size-6 opacity-30" />
                </div>
                <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.character.empty")}</span>
            </div>
        );
    }

    if (imageGenReference) {
        return <CharacterReferenceCellView node={node} theme={theme} refs={imageGenReference} thumbUrls={thumbUrls} />;
    }

    const visibleThumbs = images.slice(0, 5);
    const overflow = images.length - visibleThumbs.length;
    const isBatchRoot = images.length > 1;

    return (
        <BatchFrame batchCount={images.length} batchExpanded={batchExpanded}>
            {batchExpanded
                ? images.map((image, index) => (
                      <ExpandedCharacterImageCard
                          key={index}
                          node={node}
                          image={image}
                          index={index}
                          scale={scale}
                          primary={index === primaryIndex}
                          onSetPrimary={() => onSetBatchPrimary?.(String(index))}
                          onDelete={() => onDeleteBatchImage?.(String(index))}
                          onView={() => onViewBatchImage?.(String(index))}
                      />
                  ))
                : null}
            <div className="flex h-full w-full flex-col">
                <div className="relative flex-1 min-h-0 overflow-hidden bg-stone-100 dark:bg-stone-900" data-canvas-no-zoom>
                    {primaryUrl ? (
                        <img
                            src={pickImageSource({ previewUrl: previewUrlFor(primary.storageKey), originalUrl: primaryUrl, naturalWidth: primary.width, naturalHeight: primary.height, renderedWidth: node.width, renderedHeight: node.height, scale })}
                            alt={primary.outfit || primary.name || node.title}
                            className="size-full object-cover"
                            draggable={false}
                        />
                    ) : (
                        <div className="flex size-full items-center justify-center" style={{ color: theme.node.placeholder }}>
                            <User className="size-10 opacity-30" />
                        </div>
                    )}
                    {primary?.outfit ? <div className="absolute left-2 top-2 max-w-[calc(100%-16px)] truncate rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">{primary.outfit}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 border-t px-2 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    {visibleThumbs.map((image, idx) => {
                        const url = previewUrlFor(image.storageKey) || thumbUrls[idx];
                        const active = idx === primaryIndex;
                        return (
                            <button
                                key={idx}
                                type="button"
                                className="size-7 shrink-0 overflow-hidden rounded-md border p-0 transition hover:opacity-100"
                                style={{ borderColor: active ? selectionBlue : theme.node.stroke, opacity: active ? 1 : 0.7 }}
                                title={image.outfit || image.name}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onSetBatchPrimary?.(String(idx));
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                                {url ? <img src={url} alt="" className="size-full object-cover" draggable={false} /> : null}
                            </button>
                        );
                    })}
                    {overflow > 0 ? (
                        <div className="grid size-7 shrink-0 place-items-center rounded-md border text-[10px] font-semibold" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            +{overflow}
                        </div>
                    ) : null}
                    {voiceUrl ? (
                        <span className="flex items-center gap-1 text-[10px] tabular-nums" style={{ color: theme.node.muted }} title={[voiceName || t("canvas.character.voice"), voiceDescription].filter(Boolean).join("\n")}>
                            <Music2 className="size-3" />
                            <span className="max-w-[60px] truncate">{voiceName || t("canvas.character.voice")}</span>
                        </span>
                    ) : null}
                    <span className="ml-auto text-[10px] tabular-nums" style={{ color: theme.node.muted }}>
                        {t("canvas.character.imageCount", { count: images.length })}
                    </span>
                </div>
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.character.collapsed") : t("canvas.character.expanded")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.character.imageCount", { count: images.length })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

/** 角色节点横向展开时的单张参考图卡片（排在节点右侧）。点“设为主图”切换主图，可删除。 */
function ExpandedCharacterImageCard({
    node,
    image,
    index,
    scale,
    primary,
    onSetPrimary,
    onDelete,
    onView,
}: {
    node: CanvasNodeData;
    image: NonNullable<NonNullable<CanvasNodeData["metadata"]>["characterImages"]>[number];
    index: number;
    scale: number;
    primary: boolean;
    onSetPrimary: () => void;
    onDelete: () => void;
    onView: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const [imageUrl, setImageUrl] = useState("");
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    useImagePreviewRevision(image.storageKey);
    const x = (index + 1) * (node.width + 18);
    const y = 0;

    useEffect(() => {
        let cancelled = false;
        if (!image.url && !image.storageKey) {
            setImageUrl("");
            return;
        }
        void ensureImagePreview(image.storageKey);
        resolveImageUrl(image.storageKey, image.url).then((url) => {
            if (!cancelled) setImageUrl(url);
        });
        return () => {
            cancelled = true;
        };
    }, [backendConnected, backendToken, image.url, image.storageKey]);

    return (
        <div
            className="absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.14)]"
            style={{ left: x, top: y, width: node.width, height: node.height, background: "transparent", borderColor: primary ? selectionBlue : theme.node.stroke, animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both` }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                if (!image.url || (event.target instanceof Element && event.target.closest("button"))) return;
                event.stopPropagation();
                onView();
            }}
        >
            {imageUrl ? (
                <img
                    src={pickImageSource({ previewUrl: previewUrlFor(image.storageKey), originalUrl: imageUrl, naturalWidth: image.width, naturalHeight: image.height, renderedWidth: node.width, renderedHeight: node.height, scale })}
                    alt={image.outfit || image.name}
                    draggable={false}
                    className="pointer-events-none h-full w-full select-none object-cover"
                />
            ) : (
                <ImageSlotStatus />
            )}
            {image.url ? (
                <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/node:pointer-events-auto group-hover/node:opacity-100">
                    <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("canvas.character.setMain")}
                        onClick={(event) => (event.stopPropagation(), onSetPrimary())}
                    >
                        <Star className="size-3 shrink-0" style={{ color: primary ? selectionBlue : theme.node.muted }} />
                        <span className="truncate">{t("canvas.character.setMain")}</span>
                    </button>
                    <button
                        type="button"
                        className="grid size-8 shrink-0 place-items-center rounded-lg border shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                        onClick={(event) => (event.stopPropagation(), onDelete())}
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function VideoNodeContent({ node, theme, scale }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyVideo")}</span>
            </div>
        );
    if (scale < 0.2) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[18px] bg-black/10" style={{ color: theme.node.muted }}>
                <Video className="size-7 opacity-60" />
                <span className="max-w-[80%] truncate text-[10px]">{node.title || t("canvas.nodeTypes.video")}</span>
            </div>
        );
    }
    return <video src={node.metadata.content} controls className="h-full w-full rounded-[18px] bg-black object-contain" data-canvas-video={node.id} data-canvas-no-zoom />;
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyAudio")}</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{t("canvas.node.audio")}</span>
            </div>
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({
    node,
    scale,
    batchExpanded,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onViewBatchImage,
}: {
    node: CanvasNodeData;
    scale: number;
    batchExpanded: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const images = node.metadata?.images || [];
    const batchCount = images.length;
    const isBatchRoot = batchCount > 1;
    const primaryImageId = node.metadata?.primaryImageId || images[0]?.id;
    const primaryImage = images.find((image) => image.id === primaryImageId);
    useImagePreviewRevision(primaryImage?.storageKey || node.metadata?.storageKey);
    const primaryContent = primaryImage?.content || node.metadata?.content;
    const [primaryUrl, setPrimaryUrl] = useState("");
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);

    useEffect(() => {
        let cancelled = false;
        if (!primaryContent) {
            setPrimaryUrl("");
            return;
        }
        void ensureImagePreview(primaryImage?.storageKey || node.metadata?.storageKey);
        resolveImageUrl(primaryImage?.storageKey || node.metadata?.storageKey, primaryContent).then((url) => {
            if (!cancelled) setPrimaryUrl(url);
        });
        return () => {
            cancelled = true;
        };
    }, [backendConnected, backendToken, node.metadata?.storageKey, primaryContent, primaryImage?.storageKey]);
    const primarySource = primaryUrl
        ? pickImageSource({
              previewUrl: previewUrlFor(primaryImage?.storageKey || node.metadata?.storageKey),
              originalUrl: primaryUrl,
              naturalWidth: primaryImage?.naturalWidth || node.metadata?.naturalWidth,
              naturalHeight: primaryImage?.naturalHeight || node.metadata?.naturalHeight,
              renderedWidth: node.width,
              renderedHeight: node.height,
              scale,
          })
        : "";

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded}>
            {batchExpanded
                ? images
                      .filter((image) => image.id !== primaryImageId)
                      .map((image, index) => (
                          <ExpandedImageCard
                              key={image.id}
                              node={node}
                              image={image}
                              index={index}
                              scale={scale}
                              onView={() => onViewBatchImage?.(image.id)}
                              onSetPrimary={() => onSetBatchPrimary?.(image.id)}
                              onDuplicate={() => onDuplicateBatchImage?.(image.id)}
                              onDownload={() => onDownloadBatchImage?.(image.id)}
                              onRetry={() => onRetryBatchImage?.(image.id)}
                              onDelete={() => onDeleteBatchImage?.(image.id)}
                          />
                      ))
                : null}
            <div className="h-full w-full overflow-hidden rounded-3xl">
                {primarySource ? (
                    <img
                        src={primarySource}
                        alt={node.title}
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                    />
                ) : (
                    <ImageSlotStatus image={primaryImage} />
                )}
            </div>
            {primaryImage?.status === "error" ? <BatchImageFailureActions placement="left" onRetry={() => onRetryBatchImage?.(primaryImage.id)} onDelete={() => onDeleteBatchImage?.(primaryImage.id)} /> : null}
            {primaryImage?.content ? (
                <div className="pointer-events-none absolute left-2.5 top-2.5 z-30 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/node:pointer-events-auto group-hover/node:opacity-100">
                    <button
                        type="button"
                        className="flex h-8 min-w-0 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("common.download")}
                        onClick={(event) => (event.stopPropagation(), onDownloadBatchImage?.(primaryImage.id))}
                    >
                        <Download className="size-3 shrink-0" />
                        <span className="truncate">{t("common.download")}</span>
                    </button>
                    <button
                        type="button"
                        className="flex h-8 min-w-0 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("canvas.node.createCopy")}
                        onClick={(event) => (event.stopPropagation(), onDuplicateBatchImage?.(primaryImage.id))}
                    >
                        <Copy className="size-3 shrink-0" />
                        <span className="truncate">{t("canvas.node.createCopy")}</span>
                    </button>
                </div>
            ) : null}
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.batchExpanded") : t("canvas.node.batchCollapsed")}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.images", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedImageCard({
    node,
    image,
    index,
    scale,
    onView,
    onSetPrimary,
    onDuplicate,
    onDownload,
    onRetry,
    onDelete,
}: {
    node: CanvasNodeData;
    image: CanvasNodeImage;
    index: number;
    scale: number;
    onView: () => void;
    onSetPrimary: () => void;
    onDuplicate: () => void;
    onDownload: () => void;
    onRetry: () => void;
    onDelete: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    useImagePreviewRevision(image.storageKey);
    const [imageUrl, setImageUrl] = useState("");
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    const count = node.metadata?.images?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = column * (node.width + 18);
    const y = (row - rows + 1) * (node.height + 18);

    useEffect(() => {
        let cancelled = false;
        if (!image.content) {
            setImageUrl("");
            return;
        }
        void ensureImagePreview(image.storageKey);
        resolveImageUrl(image.storageKey, image.content).then((url) => {
            if (!cancelled) setImageUrl(url);
        });
        return () => {
            cancelled = true;
        };
    }, [backendConnected, backendToken, image.content, image.storageKey]);
    const source = imageUrl
        ? pickImageSource({ previewUrl: previewUrlFor(image.storageKey), originalUrl: imageUrl, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, renderedWidth: node.width, renderedHeight: node.height, scale })
        : "";

    return (
        <div
            className={`absolute z-20 overflow-hidden rounded-3xl ${image.content ? "" : "border shadow-[0_18px_50px_rgba(28,25,23,.18)]"}`}
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: "transparent",
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                if (!image.content || (event.target instanceof Element && event.target.closest("button"))) return;
                event.stopPropagation();
                onView();
            }}
        >
            {source ? <img src={source} alt={node.title} draggable={false} className="pointer-events-none h-full w-full select-none object-contain" /> : <ImageSlotStatus image={image} />}
            {image.content ? (
                <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/node:pointer-events-auto group-hover/node:opacity-100">
                    <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("common.download")}
                        onClick={(event) => (event.stopPropagation(), onDownload())}
                    >
                        <Download className="size-3 shrink-0" />
                        <span className="truncate">{t("common.download")}</span>
                    </button>
                    <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("canvas.node.createCopy")}
                        onClick={(event) => (event.stopPropagation(), onDuplicate())}
                    >
                        <Copy className="size-3 shrink-0" />
                        <span className="truncate">{t("canvas.node.createCopy")}</span>
                    </button>
                    <button
                        type="button"
                        className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                        title={t("canvas.node.setPrimary")}
                        onClick={(event) => (event.stopPropagation(), onSetPrimary())}
                    >
                        <Star className="size-3 shrink-0" style={{ color: selectionBlue }} />
                        <span className="truncate">{t("canvas.node.setPrimary")}</span>
                    </button>
                </div>
            ) : null}
            {image.status === "error" ? <BatchImageFailureActions placement="right" onRetry={onRetry} onDelete={onDelete} /> : null}
        </div>
    );
}

function BatchImageFailureActions({ placement, onRetry, onDelete }: { placement: "left" | "right"; onRetry: () => void; onDelete: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    return (
        <div className={`absolute top-3 z-30 flex items-center gap-1.5 ${placement === "left" ? "left-3" : "right-3"}`}>
            <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => (event.stopPropagation(), onRetry())}
            >
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
            <button
                type="button"
                className="grid size-8 place-items-center rounded-lg border shadow-sm transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => (event.stopPropagation(), onDelete())}
                aria-label={t("common.delete")}
                title={t("common.delete")}
            >
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}

function ImageSlotStatus({ image }: { image?: CanvasNodeImage }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const failed = image?.status === "error";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? (
                <span className="text-xs leading-5">{image.errorDetails || t("canvas.node.failed")}</span>
            ) : (
                <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            )}
            {!failed ? <span className="text-[10px] tracking-[0.2em]">{t("canvas.node.generating")}</span> : null}
        </div>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

function BatchFrame({ batchCount, batchExpanded, children }: { batchCount: number; batchExpanded: boolean; children: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div className="group/batch relative h-full w-full overflow-visible">
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 3) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_10px_24px_rgba(68,64,60,.12)] transition-all duration-300 group-hover/batch:translate-x-1"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded ? 0 : 1,
                                transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div data-resize-handle className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            data-connection-handle
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}
