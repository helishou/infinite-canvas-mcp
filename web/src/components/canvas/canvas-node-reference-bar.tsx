import { useEffect, useState, useSyncExternalStore } from "react";
import { FileText, Image as ImageIcon, Music2, Plus, Puzzle, Video, X } from "lucide-react";
import { Popover } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { characterReferenceKey, getGroupResourceNodes, isAudioGenerationNode, isImageGenerationNode, isTextGenerationNode, nodeResourceItems, type CanvasCharacterReferenceSelection } from "@/lib/canvas/canvas-resource-references";

import type { CanvasNodeResource } from "@/types/canvas-plugin";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasImageReferenceSnapshot, type CanvasNodeData } from "@/types/canvas";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useBackendStore } from "@/stores/use-backend-store";

type ReferenceEntry = { node: CanvasNodeData; sourceNodeId: string; resource?: CanvasNodeResource; index: number; character?: boolean };

export function CanvasNodeReferenceBar({ nodeId, nodes, connectedNodes, historyReferences, onClearHistoryReferences, onDisconnect, onStartSelection }: { nodeId: string; nodes: CanvasNodeData[]; connectedNodes: CanvasNodeData[]; historyReferences?: CanvasImageReferenceSnapshot[]; onClearHistoryReferences?: () => void; onDisconnect?: (fromNodeId: string, toNodeId: string) => void; onStartSelection?: (nodeId: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const targetNode = nodes.find((node) => node.id === nodeId);
    const characterSelections = targetNode?.metadata?.characterReferences || {};
    const references: ReferenceEntry[] = connectedNodes.flatMap((sourceNode) => (sourceNode.type === CanvasNodeType.Group ? getGroupResourceNodes(sourceNode.id, nodes) : [sourceNode]).flatMap((node): ReferenceEntry[] => {
        if (node.type === CanvasNodeType.Character) return [{ node, sourceNodeId: sourceNode.id, index: 0, character: true }];
        return nodeResourceItems(node).map((resource, index) => ({ node, resource, index, sourceNodeId: sourceNode.id }));
    }));

    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>{t("canvas.references.title")}</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {historyReferences !== undefined ? historyReferences.map((reference, index) => (
                    <HistoryImageReference key={`${reference.id}:${index}`} reference={reference} onClear={onClearHistoryReferences} />
                )) : references.map((reference) => reference.character ? (
                    <CharacterReferenceItem
                        key={`${reference.sourceNodeId}:${reference.node.id}:character`}
                        node={reference.node}
                        selection={characterSelections[reference.node.id]}
                        sourceIsImageGeneration={isImageGenerationNode(targetNode)}
                        sourceIsAudioGeneration={isAudioGenerationNode(targetNode)}
                        sourceIsTextGeneration={isTextGenerationNode(targetNode)}
                        onRemove={() => onDisconnect?.(reference.sourceNodeId, nodeId)}
                    />
                ) : (
                    <ReferenceItem key={`${reference.sourceNodeId}:${reference.node.id}:${reference.index}`} node={reference.node} resource={reference.resource!} onRemove={() => onDisconnect?.(reference.sourceNodeId, nodeId)} />
                ))}
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title={t("canvas.references.select")} onClick={() => { if (historyReferences !== undefined) onClearHistoryReferences?.(); onStartSelection?.(nodeId); }}>
                    <Plus className="size-4" />
                </button>
            </div>

        </div>
    );
}

function HistoryImageReference({ reference, onClear }: { reference: CanvasImageReferenceSnapshot; onClear?: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    const [url, setUrl] = useState("");
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    useEffect(() => {
        let cancelled = false;
        if (!reference.storageKey && !reference.url) { setUrl(""); return; }
        void ensureImagePreview(reference.storageKey);
        void resolveImageUrl(reference.storageKey, reference.url || "").then((resolved) => { if (!cancelled) setUrl(resolved || reference.url || ""); }).catch(() => { if (!cancelled) setUrl(reference.url || ""); });
        return () => { cancelled = true; };
    }, [backendConnected, backendToken, reference.storageKey, reference.url]);
    const imageUrl = previewUrlFor(reference.storageKey) || url;
    return (
        <div className="group relative size-12 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.toolbar.border, background: theme.node.panel }} title={reference.name}>
            {imageUrl ? <img src={imageUrl} alt={reference.name} className="size-full object-cover" draggable={false} /> : <div className="grid size-full place-items-center"><ImageIcon className="size-5 opacity-35" /></div>}
            {onClear ? <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-bl-md opacity-0 transition-opacity group-hover:opacity-100" style={{ background: theme.toolbar.panel, color: theme.node.text }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onClick={(event) => { event.stopPropagation(); onClear(); }}><X className="size-3" /></button> : null}
        </div>
    );
}

function CharacterReferenceItem({ node, selection, sourceIsImageGeneration, sourceIsAudioGeneration, sourceIsTextGeneration, onRemove }: { node: CanvasNodeData; selection?: CanvasCharacterReferenceSelection; sourceIsImageGeneration?: boolean; sourceIsAudioGeneration?: boolean; sourceIsTextGeneration?: boolean; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    const images = node.metadata?.characterImages || [];
    const primaryIndex = Math.min(Math.max(node.metadata?.characterPrimaryIndex || 0, 0), Math.max(images.length - 1, 0));
    const primaryImage = images[primaryIndex];
    const keys = selection?.imageKeys
        ? new Set(selection.imageKeys)
        : new Set(primaryImage ? [characterReferenceKey(primaryImage, primaryIndex)] : []);
    const selectedImages = images.filter((image, index) => keys.has(characterReferenceKey(image, index))).slice(0, 2);
    const selectedImageCount = selection?.imageKeys ? selection.imageKeys.length : selectedImages.length;
    const voiceIncluded = !sourceIsImageGeneration && !sourceIsAudioGeneration && !sourceIsTextGeneration && selection?.voiceEnabled !== false && Boolean(node.metadata?.characterVoiceUrl || node.metadata?.characterVoiceStorageKey);
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [urls, setUrls] = useState<string[]>([]);
    useEffect(() => {
        let cancelled = false;
        void Promise.all(selectedImages.map((image) => {
            void ensureImagePreview(image.storageKey);
            return resolveImageUrl(image.storageKey, image.url || "").catch(() => image.url || "");
        })).then((resolved) => { if (!cancelled) setUrls(resolved); });
        return () => { cancelled = true; };
    }, [backendConnected, backendToken, node.id, selection?.imageKeys?.join(","), images.length]);
    // 音频生成节点：角色引用以「声线音频」作为输入，渲染音频格。
    // 文本生成节点：角色引用以「角色文本设定」作为输入，渲染文本格。
    // 两个早返回都放在 hooks 之后，避免切换生成模式时 hook 数量变化导致 React 报错。
    if (sourceIsAudioGeneration) return <CharacterAudioReferenceItem node={node} onRemove={onRemove} />;
    if (sourceIsTextGeneration) return <CharacterTextReferenceItem node={node} onRemove={onRemove} />;
    // 选 1 张图 → 占 1 格方形；选 2 张图 → 横向矩形占 2 格；多张时角标显示总数。
    const wide = selectedImages.length > 1;
    const name = node.metadata?.characterName || node.title || "角色";
    const hoverPreview = selectedImages.length ? (
        <span className="flex gap-2">
            {selectedImages.map((image, index) => {
                const url = urls[index] || previewUrlFor(image.storageKey);
                return url ? <img key={index} src={url} alt={image.outfit || image.name || ""} className="max-h-52 w-36 rounded-lg object-cover" draggable={false} /> : null;
            })}
        </span>
    ) : (
        <span className="block max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{name}</span>
    );
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={hoverPreview}>
            <div
                className={`group relative ${wide ? "h-12 w-[104px]" : "size-12"} shrink-0 overflow-hidden rounded-xl border transition hover:opacity-85`}
                style={{ borderColor: theme.node.activeStroke || theme.toolbar.border, background: theme.toolbar.activeBg }}
            >
                <span className="flex size-full">
                    {selectedImages.map((image, index) => {
                        const url = urls[index] || previewUrlFor(image.storageKey);
                        return (
                            <span key={index} className="relative min-w-0 flex-1 overflow-hidden" style={{ background: theme.node.panel }}>
                                {url ? <img src={url} alt={image.outfit || image.name || ""} className="absolute inset-0 size-full object-cover" draggable={false} /> : <span className="grid size-full place-items-center text-[10px]" style={{ color: theme.node.muted }}>{selectedImageCount} 图</span>}
                            </span>
                        );
                    })}
                    {!selectedImages.length ? <span className="grid size-full place-items-center px-1 text-center leading-tight"><span className="min-w-0 truncate text-[10px] font-medium">{name}</span></span> : null}
                </span>
                <span className="pointer-events-none absolute bottom-0 left-0 max-w-full truncate rounded-tr-md bg-black/55 px-1 py-px text-[9px] font-medium text-white">{name}{voiceIncluded ? " · 声线" : ""}</span>
                <span className="pointer-events-none absolute right-0 top-0 rounded-bl-md bg-black/55 px-1 py-px text-[9px] font-medium text-white">{selectedImageCount}图</span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

/** 角色节点被「音频类生成节点」引用时，角色引用以声线音频作为输入：方形音频格 + 角色名 + 试听。 */
function CharacterAudioReferenceItem({ node, onRemove }: { node: CanvasNodeData; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    const voiceUrl = node.metadata?.characterVoiceUrl || "";
    const voiceKey = node.metadata?.characterVoiceStorageKey;
    const hasVoice = Boolean(voiceUrl || voiceKey);
    const [url, setUrl] = useState("");
    const [playing, setPlaying] = useState(false);
    useEffect(() => {
        let cancelled = false;
        if (!voiceKey && !voiceUrl) { setUrl(""); return; }
        void resolveImageUrl(voiceKey, voiceUrl).then((resolved) => { if (!cancelled) setUrl(resolved || voiceUrl); }).catch(() => { if (!cancelled) setUrl(voiceUrl); });
        return () => { cancelled = true; };
    }, [backendConnected, backendToken, voiceKey, voiceUrl]);
    return (
        <div
            className="group relative grid size-12 shrink-0 place-items-center rounded-xl border transition hover:opacity-85"
            style={{ borderColor: theme.node.activeStroke || theme.toolbar.border, background: theme.toolbar.activeBg }}
            title={t("canvas.references.empty")}
        >
            <Music2 className="size-5" style={{ color: theme.node.muted }} />
            <span className="pointer-events-none absolute bottom-0 left-0 max-w-full truncate rounded-tr-md bg-black/55 px-1 py-px text-[9px] font-medium text-white">{node.metadata?.characterName || node.title || "角色"}</span>
            {hasVoice ? (
                <button type="button" className="absolute left-0 top-0 grid size-5 place-items-center rounded-full border shadow-sm" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setPlaying((value) => !value); }}>
                    {playing ? <span className="block size-2 rounded-[1px] bg-current" /> : <span className="ml-0.5 block size-0 border-y-[4px] border-l-[6px] border-y-transparent" style={{ borderLeftColor: theme.node.text }} />}
                </button>
            ) : null}
            {hasVoice && url ? <audio className={`pointer-events-auto absolute inset-x-0 bottom-0 z-10 h-5 w-full ${playing ? "" : "hidden"}`} src={url} controls autoPlay={playing} ref={(element) => { if (element) { if (playing) void element.play().catch(() => {}) ; else element.pause(); } }} /> : null}
            <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
        </div>
    );
}

/** 角色节点被「文本类生成节点」引用时，角色引用以角色的文本设定作为输入：方形文本格 + 角色名。 */
function CharacterTextReferenceItem({ node, onRemove }: { node: CanvasNodeData; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const name = node.metadata?.characterName || node.title || "角色";
    const description = node.metadata?.characterDescription || node.metadata?.characterEnglishName || "";
    return (
        <div
            className="group relative grid size-12 shrink-0 place-items-center rounded-xl border transition hover:opacity-85"
            style={{ borderColor: theme.node.activeStroke || theme.toolbar.border, background: theme.toolbar.activeBg }}
            title={description ? `${name} · ${description}` : name}
        >
            <FileText className="size-5" style={{ color: theme.node.muted }} />
            <span className="pointer-events-none absolute bottom-0 left-0 max-w-full truncate rounded-tr-md bg-black/55 px-1 py-px text-[9px] font-medium text-white">{name}</span>
            <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
        </div>
    );
}

function ReferenceItem({ node, resource, onRemove }: { node: CanvasNodeData; resource: CanvasNodeResource; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const rawContent = resource.url || node.metadata?.content;
    const storageKey = resource.storageKey || node.metadata?.storageKey;
    const backendConnected = useBackendStore((state) => state.connected);
    const backendToken = useBackendStore((state) => state.token);
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [content, setContent] = useState(rawContent);
    useEffect(() => {
        let cancelled = false;
        if (!rawContent && !storageKey) {
            setContent("");
            return;
        }
        if (resource.kind === "image") void ensureImagePreview(storageKey);
        resolveImageUrl(storageKey, rawContent || "").then((resolved) => {
            if (!cancelled) setContent(resolved);
        }).catch(() => {
            if (!cancelled) setContent(rawContent || "");
        });
        return () => { cancelled = true; };
    }, [backendConnected, backendToken, rawContent, storageKey]);
    const thumbnail = resource.kind === "image" ? previewUrlFor(storageKey) || content : content;
    const Icon = resource.kind === "image" ? ImageIcon : resource.kind === "video" ? Video : resource.kind === "audio" ? Music2 : resource.kind === "text" ? FileText : Puzzle;
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={<ReferencePreview node={node} resource={resource} content={content} />}>
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {(resource?.kind === "image" || node.type === CanvasNodeType.Image) && thumbnail ? <img src={thumbnail} alt="" className="size-full object-cover" /> : (resource?.kind === "video" || node.type === CanvasNodeType.Video) && content ? <video src={content} className="size-full object-cover" muted /> : <Icon className="size-4 opacity-65" />}
                </span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

function ReferencePreview({ node, resource, content }: { node: CanvasNodeData; resource: CanvasNodeResource; content?: string }) {
    const { t } = useTranslation();
    if (resource.kind === "image" && content) return <img src={content} alt={node.title} className="max-h-52 w-72 rounded-lg object-contain" />;
    if (resource.kind === "video" && content) return <video src={content} className="max-h-52 w-72 rounded-lg" muted controls />;
    if (resource.kind === "audio" && content) return <audio src={content} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{resource.text || node.metadata?.content || node.metadata?.prompt || node.title || t("canvas.references.empty")}</div>;
}
