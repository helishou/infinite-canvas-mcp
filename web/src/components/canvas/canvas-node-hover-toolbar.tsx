import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, Dropdown, Input, Modal, Segmented, Tooltip, type MenuProps } from "antd";
import { Columns2, Download, Ellipsis, FolderPlus, Image as ImageIcon, Info, LayoutGrid, ListOrdered, LoaderCircle, Lock, MapPinned, MessageSquare, Minus, Music2, Package, Plus, RefreshCw, Scissors, Settings2, Trash2, Unlock, Upload, User, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { useCopyText } from "@/hooks/use-copy-text";
import { useThemeStore } from "@/stores/use-theme-store";
import { useImageQuickToolsStore } from "@/stores/use-image-quick-tools-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import { canvasNodePrimaryImage } from "@/lib/canvas/canvas-image-renderability";
import { propNodeAssetImage } from "@/lib/canvas/prop-node-asset";
import type { CanvasNodeToolbarItem } from "@/types/canvas-plugin";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { ImageToolSettingsModal, type ImageToolbarSettingsTool } from "./canvas-image-toolbar-settings-modal";
import { canvasNodeDropdownActions, groupCanvasNodeActions, nearbyCanvasNodeActions } from "./canvas-node-action-groups";
import { buildImageToolbarTools, type ImageQuickToolId } from "./canvas-image-toolbar-tools";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onInfo: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onToggleDialog: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    savingAsset?: boolean;
    onDiscardSharedEdits?: (node: CanvasNodeData) => void;
    onCompareVideo: (node: CanvasNodeData) => void;
    onTrimVideo: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAutoLevels: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onConvertToCharacter: (node: CanvasNodeData) => void;
    onConvertToScene: (node: CanvasNodeData) => void;
    onConvertToProp: (node: CanvasNodeData) => void;
    onSaveCharacterToAsset: (node: CanvasNodeData) => void;
    onSaveSceneToAsset: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onArrangeGroup: (node: CanvasNodeData) => void;
    onToggleOrderedGroup: (node: CanvasNodeData) => void;
    onToggleGroupLock: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
    extraTools?: CanvasNodeToolbarItem[];
    productionActions?: CanvasNodeToolbarItem[];
    productionSelected?: boolean;
    productionStatus?: string;
    canvasSize?: { width: number; height: number };
};

type ToolbarTool = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
    loading?: boolean;
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    onKeep,
    onLeave,
    onInfo,
    onDecreaseFont,
    onIncreaseFont,
    onToggleDialog,
    onGenerateImage,
    onUpload,
    onDownload,
    onSaveAsset,
    savingAsset = false,
    onDiscardSharedEdits,
    onCompareVideo,
    onTrimVideo,
    onMaskEdit,
    onCrop,
    onSplit,
    onUpscale,
    onSuperResolve,
    onAutoLevels,
    onAngle,
    onViewImage,
    onReversePrompt,
    onRetry,
    onConvertToCharacter,
    onConvertToScene,
    onConvertToProp,
    onSaveCharacterToAsset,
    onSaveSceneToAsset,
    onToggleFreeResize,
    onArrangeGroup,
    onToggleOrderedGroup,
    onToggleGroupLock,
    onDelete,
    extraTools = [],
    productionActions,
    productionSelected = false,
    productionStatus,
    canvasSize,
}: CanvasNodeHoverToolbarProps) {
    const quickImageToolIds = useImageQuickToolsStore((state) => state.ids);
    const showImageToolLabels = useImageQuickToolsStore((state) => state.showLabels);
    const [draftImageToolIds, setDraftImageToolIds] = useState<ImageQuickToolId[]>(quickImageToolIds);
    const [draftShowImageToolLabels, setDraftShowImageToolLabels] = useState(showImageToolLabels);
    const [imageToolSettingsOpen, setImageToolSettingsOpen] = useState(false);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [toolbarWidth, setToolbarWidth] = useState(0);
    const [actionsOpen, setActionsOpen] = useState(false);
    const actionsTriggerRef = useRef<HTMLButtonElement>(null);
    const productionToolbarRef = useRef<HTMLDivElement>(null);
    const [productionToolbarHeight, setProductionToolbarHeight] = useState(0);
    const hasProductionActions = Boolean(productionActions);
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];

    useEffect(() => {
        setImageToolSettingsOpen(false);
        setActionsOpen(false);
    }, [node?.id]);

    useLayoutEffect(() => {
        const element = productionToolbarRef.current;
        if (!element) return;
        const measure = () => setProductionToolbarHeight(element.getBoundingClientRect().height);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [node?.id, hasProductionActions, productionSelected]);

    useLayoutEffect(() => {
        const element = toolbarRef.current;
        if (!element) return;
        const measure = () => setToolbarWidth(element.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [node?.id, hasProductionActions]);

    if (!node || productionActions && !productionSelected) return null;

    const activeNode = node;
    const left = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const top = viewport.y + node.position.y * viewport.k - 14;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    const isSmartGenerationNode = node.type === CanvasNodeType.Config && node.metadata?.smart === true;
    const smartMode = isSmartGenerationNode ? node.metadata?.generationMode || "image" : undefined;
    const isImage = node.type === CanvasNodeType.Image || (isSmartGenerationNode && smartMode === "image");
    const isVideo = node.type === CanvasNodeType.Video || (isSmartGenerationNode && smartMode === "video");
    const isAudio = node.type === CanvasNodeType.Audio || (isSmartGenerationNode && smartMode === "audio");
    const isCharacter = node.type === CanvasNodeType.Character;
    const isScene = node.type === CanvasNodeType.Scene;
    const hasPropImage = Boolean(propNodeAssetImage(node));
    const hasImage = isImage && Boolean(canvasNodePrimaryImage(node));
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const hasAudio = isAudio && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text || (isSmartGenerationNode && smartMode === "text");
    const hasText = isText && Boolean(node.metadata?.content?.trim());
    const isConfig = node.type === CanvasNodeType.Config && !isSmartGenerationNode;
    const isGroup = node.type === CanvasNodeType.Group;
    const isSceneBoundH3 = isH3NodeType(node.type) && Boolean(String(node.metadata?.productionSceneId || "").trim());
    const canRetry = node.metadata?.status === "error";
    const quickImageToolIdSet = new Set(quickImageToolIds);
    const copyImagePrompt = (target: CanvasNodeData) => {
        const selectedImage = target.metadata?.images?.find((image) => image.id === (target.metadata?.primaryImageId || target.metadata?.images?.[0]?.id));
        const prompt = (selectedImage?.generationSnapshot?.effectivePrompt || target.metadata?.prompt)?.trim();
        if (!prompt) {
            message.warning(t("canvas.nodeToolbar.noPrompt"));
            return;
        }
        copyText(prompt, t("common.promptCopied"));
    };
    const imageTools = buildImageToolbarTools(node, { onUpload, onToggleFreeResize, onMaskEdit, onCrop, onSplit, onUpscale, onSuperResolve, onAutoLevels, onAngle, onViewImage, onCopyPrompt: copyImagePrompt, onReversePrompt });

    function openImageToolSettings() {
        onKeep(activeNode.id);
        setDraftImageToolIds(quickImageToolIds);
        setDraftShowImageToolLabels(showImageToolLabels);
        setImageToolSettingsOpen(true);
    }

    const baseToolbarTools: ToolbarTool[] = [
        { id: "info", title: t("canvas.nodeToolbar.infoTitle"), label: t("canvas.nodeToolbar.info"), icon: <Info className="size-4" />, onClick: () => onInfo(node) },
        ...(isGroup ? [{ id: "arrangeGroup", title: t("canvas.nodeToolbar.arrangeGroupTitle"), label: t("canvas.nodeToolbar.arrangeGroup"), icon: <LayoutGrid className="size-4" />, onClick: () => onArrangeGroup(node) }] : []),
        ...(isGroup ? [{ id: "toggleOrderedGroup", title: t(node.metadata?.orderedGroup ? "canvas.nodeActions.unorderedGroup" : "canvas.nodeActions.orderedGroup"), label: t(node.metadata?.orderedGroup ? "canvas.nodeActions.unorderedGroup" : "canvas.nodeActions.orderedGroup"), icon: <ListOrdered className="size-4" />, onClick: () => onToggleOrderedGroup(node), active: Boolean(node.metadata?.orderedGroup) }] : []),
        ...(!isSceneBoundH3 ? [{ id: "delete", title: t("canvas.nodeToolbar.removeTitle"), label: t("common.delete"), icon: <Trash2 className="size-4" />, onClick: () => onDelete(node), danger: true }] : []),
        ...(isGroup ? [{ id: "groupLock", title: t(node.metadata?.groupLocked ? "canvas.nodeActions.unlockGroup" : "canvas.nodeActions.lockGroup"), label: t(node.metadata?.groupLocked ? "canvas.nodeActions.unlockGroup" : "canvas.nodeActions.lockGroup"), icon: node.metadata?.groupLocked ? <Unlock className="size-4" /> : <Lock className="size-4" />, onClick: () => onToggleGroupLock(node), active: Boolean(node.metadata?.groupLocked) }] : []),
    ];
    const nodeToolbarTools: ToolbarTool[] = [
        ...(canRetry ? [{ id: "retry", title: t("canvas.nodeToolbar.retryTitle"), label: t("canvas.node.retry"), icon: <RefreshCw className="size-4" />, onClick: () => onRetry(node) }] : []),
        ...(hasImage || hasPropImage || hasVideo || isText ? [{ id: "saveAsset", disabled: savingAsset, loading: savingAsset, title: t(node.metadata?.sharedAssetReference ? "canvas.sharedLibrary.update" : "common.addToAssets"), label: t(node.metadata?.sharedAssetReference ? "canvas.sharedLibrary.update" : "canvas.nodeToolbar.saveAsset"), icon: <FolderPlus className="size-4" />, onClick: () => onSaveAsset(node) }] : []),
        ...(hasImage || hasVideo || hasAudio || hasText ? [{ id: "download", title: hasAudio ? t("canvas.nodeToolbar.downloadAudio") : hasVideo ? t("canvas.nodeToolbar.downloadVideo") : hasImage ? t("canvas.nodeToolbar.downloadImage") : t("common.download"), label: t("common.download"), icon: <Download className="size-4" />, onClick: () => onDownload(node) }] : []),
        ...(hasVideo ? [{ id: "compareVideo", title: t("canvas.videoCompare.title"), label: t("canvas.videoCompare.open"), icon: <Columns2 className="size-4" />, onClick: () => onCompareVideo(node) }] : []),
        ...(hasVideo ? [{ id: "trimVideo", title: t("canvas.videoTrim.range"), label: t("canvas.videoTrim.open"), icon: <Scissors className="size-4" />, onClick: () => onTrimVideo(node) }] : []),
        ...(isVideo && !isSmartGenerationNode ? [{ id: "edit", title: t("common.edit"), label: t("common.edit"), icon: <MessageSquare className="size-4" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isText && !isSmartGenerationNode ? [{ id: "generateImage", title: t("canvas.node.generateImage"), label: t("canvas.node.generate"), icon: <ImageIcon className="size-4" />, onClick: () => onGenerateImage(node) }] : []),
        ...(isConfig ? [{ id: "config", title: t("canvas.configNode.title"), label: t("canvas.configNode.title"), icon: <Settings2 className="size-4" />, onClick: () => onToggleDialog(node) }] : []),
        ...(isText ? [{ id: "decreaseFont", title: t("canvas.nodeToolbar.decreaseFont"), label: t("canvas.nodeToolbar.zoomOut"), icon: <Minus className="size-4" />, onClick: () => onDecreaseFont(node) }] : []),
        ...(isText ? [{ id: "increaseFont", title: t("canvas.nodeToolbar.increaseFont"), label: t("canvas.nodeToolbar.zoomIn"), icon: <Plus className="size-4" />, onClick: () => onIncreaseFont(node) }] : []),
        ...(isImage && !isSmartGenerationNode && !hasImage ? [{ id: "uploadImage", title: t("canvas.nodeToolbar.uploadImage"), label: t("canvas.nodeToolbar.uploadImage"), icon: <Upload className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isVideo && !isSmartGenerationNode ? [{ id: "uploadVideo", title: t(hasVideo ? "canvas.nodeToolbar.replaceVideo" : "canvas.nodeToolbar.uploadVideo"), label: t(hasVideo ? "canvas.nodeToolbar.replaceVideo" : "canvas.nodeToolbar.uploadVideo"), icon: <Video className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(isAudio && !isSmartGenerationNode ? [{ id: "uploadAudio", title: t(hasAudio ? "canvas.nodeToolbar.replaceAudio" : "canvas.nodeToolbar.uploadAudio"), label: t(hasAudio ? "canvas.nodeToolbar.replaceAudio" : "canvas.nodeToolbar.uploadAudio"), icon: <Music2 className="size-4" />, onClick: () => onUpload(node) }] : []),
        ...(hasImage ? [{ id: "convertToCharacter", title: t("canvas.nodeToolbar.convertToCharacter"), label: t("canvas.nodeToolbar.convertToCharacter"), icon: <User className="size-4" />, onClick: () => onConvertToCharacter(node) }] : []),
        ...(hasImage ? [{ id: "convertToScene", title: t("canvas.nodeToolbar.convertToScene"), label: t("canvas.nodeToolbar.convertToScene"), icon: <MapPinned className="size-4" />, onClick: () => onConvertToScene(node) }] : []),
        ...(hasImage ? [{ id: "convertToProp", title: t("canvas.nodeToolbar.convertToProp"), label: t("canvas.nodeToolbar.convertToProp"), icon: <Package className="size-4" />, onClick: () => onConvertToProp(node) }] : []),
        ...(isCharacter ? [{ id: "saveCharacterToAsset", disabled: savingAsset, loading: savingAsset, title: t(node.metadata?.sharedAssetReference ? "canvas.sharedLibrary.update" : "canvas.nodeToolbar.saveCharacterToAsset"), label: t(node.metadata?.sharedAssetReference ? "canvas.sharedLibrary.update" : "canvas.nodeToolbar.saveCharacterToAsset"), icon: <FolderPlus className="size-4" />, onClick: () => onSaveCharacterToAsset(node) }] : []),
        ...(isScene ? [{ id: "saveSceneToAsset", disabled: savingAsset, loading: savingAsset, title: t(node.metadata?.sharedAssetReference ? "canvas.sharedLibrary.update" : "canvas.nodeToolbar.saveSceneToAsset"), label: t(node.metadata?.sharedAssetReference ? "canvas.sharedLibrary.update" : "canvas.nodeToolbar.saveSceneToAsset"), icon: <FolderPlus className="size-4" />, onClick: () => onSaveSceneToAsset(node) }] : []),
        ...(hasImage ? imageTools.map((tool) => ({ id: tool.id, title: tool.title, label: tool.label, icon: tool.icon, active: tool.active, onClick: tool.onClick })) : []),
    ];
    const sharedTools: ToolbarTool[] = node.metadata?.sharedAssetReference && Object.keys(node.metadata.sharedAssetReference.edits || {}).length ? [
        { id: "discardShared", title: t("canvas.sharedLibrary.discard"), label: t("canvas.sharedLibrary.discard"), icon: <RefreshCw className="size-4" />, onClick: () => onDiscardSharedEdits?.(node) },
    ] : [];
    const toolbarTools = hasImage ? [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => quickImageToolIdSet.has(tool.id as ImageQuickToolId)).concat(sharedTools) : [...baseToolbarTools, ...nodeToolbarTools, ...extraTools, ...sharedTools];
    const allToolbarTools: ToolbarTool[] = [...new Map([...baseToolbarTools, ...nodeToolbarTools, ...extraTools, ...sharedTools].map((tool) => [tool.id, tool])).values()];
    const nearbyTools = nearbyCanvasNodeActions(allToolbarTools, hasImage ? quickImageToolIdSet : undefined);
    const nearbyToolIds = new Set(nearbyTools.map((tool) => tool.id));
    const moreTools = allToolbarTools.filter((tool) => !nearbyToolIds.has(tool.id));
    const dropdownTools = canvasNodeDropdownActions(allToolbarTools, moreTools, Boolean(productionActions));
    const actionMenuItems: MenuProps["items"] = groupCanvasNodeActions(dropdownTools).map((group) => ({
        type: "group",
        key: group.id,
        label: t(`canvas.nodeActions.groups.${group.id}`),
        children: group.actions.map((tool) => ({ key: tool.id, label: tool.label || tool.title, icon: tool.loading ? <LoaderCircle className="size-4 animate-spin" /> : tool.icon, danger: tool.danger || group.id === "danger", disabled: tool.disabled, onClick: tool.onClick })),
    }));
    if (hasImage) actionMenuItems.push({ type: "divider" }, { key: "customize", label: t("canvas.imageTools.customize"), icon: <Settings2 className="size-4" />, onClick: openImageToolSettings });
    const availableWidth = canvasSize?.width || window.innerWidth;
    const toolbarLeft = Math.min(Math.max(8 + toolbarWidth / 2, left), Math.max(8 + toolbarWidth / 2, availableWidth - toolbarWidth / 2 - 8));
    const selectableImageToolbarTools = [...baseToolbarTools, ...nodeToolbarTools].filter((tool) => tool.id !== "retry") as ImageToolbarSettingsTool[];

    const closeImageToolSettings = () => {
        setImageToolSettingsOpen(false);
        onLeave();
    };

    const setDraftImageToolVisible = (id: ImageQuickToolId, visible: boolean) => {
        setDraftImageToolIds((current) => {
            const selected = new Set(current);
            if (visible) selected.add(id);
            else selected.delete(id);
            return selectableImageToolbarTools.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
        });
    };

    const saveImageToolSettings = () => {
        const config = { ids: draftImageToolIds, showLabels: draftShowImageToolLabels };
        useImageQuickToolsStore.getState().setConfig(config);
        closeImageToolSettings();
    };

    if (productionActions) return <div ref={productionToolbarRef} data-production-node-actions className="absolute z-[70] flex flex-wrap items-center gap-1 rounded-lg border p-2 text-sm shadow-lg" style={{ left: Math.min(Math.max(16, left - 160), Math.max(16, (canvasSize?.width || window.innerWidth) - 336)), top: Math.min(Math.max(72, top - productionToolbarHeight - 24), Math.max(72, (canvasSize?.height || window.innerHeight) - productionToolbarHeight - 16)), width: Math.min(320, (canvasSize?.width || window.innerWidth) - 32), background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        <span className="w-full truncate px-2 text-sm font-medium" title={node.title}>{node.title || node.type}</span>
        {productionStatus && <span data-production-node-status className="w-full px-2 pb-1 text-xs" style={{ color: theme.node.muted }}>{productionStatus}</span>}
        {productionActions.map(action => <button key={action.id} type="button" disabled={action.disabled} className="rounded px-2 py-1.5 hover:bg-black/5 disabled:cursor-default disabled:opacity-40 dark:hover:bg-white/10" aria-label={action.title} onClick={action.onClick}>{action.label}</button>)}
        <Dropdown trigger={["click"]} menu={{ items: dropdownTools.map(tool => ({ key: tool.id, label: tool.label || tool.title, icon: tool.loading ? <LoaderCircle className="size-4 animate-spin" /> : tool.icon, danger: tool.danger, disabled: "disabled" in tool && tool.disabled === true, onClick: tool.onClick })) }}><button type="button" aria-label={t("productionCanvas.moreNodeActions")} className="inline-flex items-center gap-1 rounded px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/10">{t("productionCanvas.more")}<Ellipsis className="size-4" /></button></Dropdown>
    </div>;

    return (
        <>
            <div
                ref={toolbarRef}
                data-canvas-node-toolbar
                className="absolute z-[70] flex h-12 min-w-0 -translate-x-1/2 -translate-y-full items-center rounded-lg border border-border bg-popover text-[13px] text-popover-foreground shadow-sm"
                style={{ left: toolbarLeft, top: Math.max(64, top), maxWidth: Math.max(0, availableWidth - 16) }}
                onMouseEnter={() => onKeep(node.id)}
                onMouseLeave={() => {
                    if (!imageToolSettingsOpen && !actionsOpen) onLeave();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <div className="flex min-w-0 flex-1 items-center overflow-x-auto hide-scrollbar" data-canvas-no-zoom onWheel={(event) => event.stopPropagation()}>
                    {nearbyTools.map((tool) => (
                        <ToolbarAction key={tool.id} {...tool} showLabel={isImage ? showImageToolLabels : true} />
                    ))}
                </div>
                <Dropdown
                    trigger={["click"]}
                    open={actionsOpen}
                    autoFocus
                    popupRender={(menu) => <div className="canvas-blocking-overlay" data-canvas-shortcuts-ignore data-canvas-no-zoom onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Escape") { event.preventDefault(); setActionsOpen(false); actionsTriggerRef.current?.focus(); }
                        if (event.key === "Tab") setActionsOpen(false);
                    }}>{menu}</div>}
                    onOpenChange={(open) => { setActionsOpen(open); if (open) onKeep(node.id); }}
                    menu={{ items: actionMenuItems, selectable: true, selectedKeys: moreTools.filter((tool) => tool.active).map((tool) => tool.id), onClick: () => setActionsOpen(false), style: { maxHeight: "min(560px, calc(100dvh - 32px))", overflowY: "auto", maxWidth: "calc(100vw - 24px)" } }}
                >
                    <button ref={actionsTriggerRef} type="button" data-canvas-shortcuts-ignore aria-label={t("canvas.nodeActions.all")} aria-expanded={actionsOpen} className="canvas-blocking-overlay flex h-12 shrink-0 items-center gap-1 border-l border-border px-3 hover:bg-muted">
                        <Ellipsis className="size-4" /><span>{t("canvas.imageTools.more")}</span>
                    </button>
                </Dropdown>
            </div>
            {hasImage ? (
                <ImageToolSettingsModal
                    open={imageToolSettingsOpen}
                    tools={selectableImageToolbarTools}
                    selectedIds={draftImageToolIds}
                    showLabels={draftShowImageToolLabels}
                    onToggle={setDraftImageToolVisible}
                    onShowLabelsChange={setDraftShowImageToolLabels}
                    onCancel={closeImageToolSettings}
                    onSave={saveImageToolSettings}
                />
            ) : null}
        </>
    );
}

export function CanvasNodeInfoModal({ node, open, onClose, onRename }: { node: CanvasNodeData | null; open: boolean; onClose: () => void; onRename: (nodeId: string, title: string) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const [view, setView] = useState<"info" | "json">("info");
    const [titleDraft, setTitleDraft] = useState("");
    const isSmartGenerationNode = node?.type === CanvasNodeType.Config && node.metadata?.smart === true;
    const smartMode = isSmartGenerationNode ? node?.metadata?.generationMode || "image" : undefined;
    const imageBytes = (node?.type === CanvasNodeType.Image || (isSmartGenerationNode && smartMode === "image")) && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const batchCount = node?.type === CanvasNodeType.Image || (isSmartGenerationNode && smartMode === "image") ? node.metadata?.images?.length || 0 : 0;
    const json = useMemo(() => {
        if (!node) return "";
        return JSON.stringify(
            node,
            (key, value) => {
                if (key === "content" && typeof value === "string" && value.startsWith("data:image/")) {
                    return "[base64 image]";
                }
                return value;
            },
            2,
        );
    }, [node]);

    useEffect(() => {
        if (open) setView("info");
    }, [node?.id, open]);

    useEffect(() => {
        if (open && node) setTitleDraft(node.title || "");
    }, [node?.id, node?.title, open]);

    const saveTitle = () => {
        if (!node) return;
        const nextTitle = titleDraft.trim() || node.title || t("canvas.node.untitled");
        setTitleDraft(nextTitle);
        if (nextTitle !== node.title) onRename(node.id, nextTitle);
    };

    const title = (
        <div className="flex items-center justify-between gap-4 pr-12">
            <span>{t("canvas.nodeToolbar.nodeInfo")}</span>
            <Segmented
                size="small"
                value={view}
                onChange={(value) => setView(value as "info" | "json")}
                options={[
                    { label: t("canvas.nodeToolbar.info"), value: "info" },
                    { label: "JSON", value: "json" },
                ]}
            />
        </div>
    );

    return (
        <Modal className="canvas-node-info-modal" title={title} open={open && Boolean(node)} centered footer={null} onCancel={onClose}>
            {node ? (
                <div className="h-[56vh] min-h-[360px] select-text text-sm" data-canvas-shortcuts-ignore>
                    {view === "info" ? (
                        <div className="thin-scrollbar h-full space-y-3 overflow-auto pr-1">
                            <InfoRow label="ID" value={node.id} />
                            <InfoRow
                                label={t("canvas.nodeToolbar.name")}
                                value={<Input size="small" value={titleDraft} placeholder={t("canvas.node.untitled")} onChange={(event) => setTitleDraft(event.target.value)} onPressEnter={saveTitle} onBlur={saveTitle} />}
                            />
                            <InfoRow label={t("canvas.nodeToolbar.type")} value={node.type === CanvasNodeType.Group ? t("canvas.node.group") : node.type === CanvasNodeType.Config ? t("canvas.configNode.title") : [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(node.type as CanvasNodeType) ? t(`assets.kinds.${node.type}`) : getNodeDefinition(node.type)?.title || node.type} />
                            <InfoRow label={t("canvas.nodeToolbar.size")} value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                            <InfoRow label={t("canvas.nodeToolbar.position")} value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                            <InfoRow label={t("canvas.nodeToolbar.status")} value={node.metadata?.status || "idle"} />
                            {batchCount > 1 ? <InfoRow label={t("canvas.nodeToolbar.imageGroup")} value={t("canvas.configNode.images", { count: batchCount })} /> : null}
                            {node.metadata?.prompt && node.type !== "minimax-h3:video" ? <InfoRow label={t("canvas.configNode.prompt")} value={node.metadata.prompt} /> : null}
                            {imageBytes ? <InfoRow label={t("canvas.nodeToolbar.imageSize")} value={formatBytes(imageBytes)} /> : null}
                            {node.metadata?.errorDetails ? (
                                <div className="rounded-lg border p-3 text-red-400" style={{ borderColor: theme.node.stroke }}>
                                    {node.metadata.errorDetails}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <pre className="thin-scrollbar h-full overflow-auto rounded-lg border p-3 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}>
                            {json}
                        </pre>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}

function ToolbarAction({ title, label, icon, onClick, showLabel, active = false, danger = false, disabled = false, loading = false }: ToolbarTool & { showLabel: boolean }) {
    const hasText = showLabel && Boolean(label);
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className={`group relative flex h-12 shrink-0 items-center whitespace-nowrap px-1.5 ${danger ? "text-destructive" : ""}`} onClick={onClick} disabled={disabled} aria-busy={loading || undefined} aria-label={title}>
                <span className={`flex h-9 items-center ${hasText ? "gap-2 px-2.5" : "justify-center px-2"} rounded-lg transition group-hover:bg-muted ${active ? "bg-accent" : ""}`}>
                    {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
                    {hasText ? <span>{label}</span> : null}
                </span>
            </button>
        </Tooltip>
    );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </div>
    );
}
