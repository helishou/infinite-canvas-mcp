import { useEffect, useState, useSyncExternalStore } from "react";
import { FileText, Image as ImageIcon, Music2, Plus, Puzzle, User, Video, X } from "lucide-react";
import { Popover } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getGroupResourceNodes, nodeResourceItems, type CanvasCharacterReferenceSelection } from "@/lib/canvas/canvas-resource-references";
import { CanvasCharacterReferenceModal } from "./canvas-character-reference-modal";
import type { CanvasNodeResource } from "@/types/canvas-plugin";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useBackendStore } from "@/stores/use-backend-store";

type ReferenceEntry = { node: CanvasNodeData; sourceNodeId: string; resource?: CanvasNodeResource; index: number; character?: boolean };

export function CanvasNodeReferenceBar({ nodeId, nodes, connectedNodes, onDisconnect, onStartSelection, onCharacterSelectionChange }: { nodeId: string; nodes: CanvasNodeData[]; connectedNodes: CanvasNodeData[]; onDisconnect?: (fromNodeId: string, toNodeId: string) => void; onStartSelection?: (nodeId: string) => void; onCharacterSelectionChange?: (sourceNodeId: string, selection: CanvasCharacterReferenceSelection) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [editingCharacterNodeId, setEditingCharacterNodeId] = useState<string | null>(null);
    const targetNode = nodes.find((node) => node.id === nodeId);
    const characterSelections = targetNode?.metadata?.characterReferences || {};
    const references: ReferenceEntry[] = connectedNodes.flatMap((sourceNode) => (sourceNode.type === CanvasNodeType.Group ? getGroupResourceNodes(sourceNode.id, nodes) : [sourceNode]).flatMap((node): ReferenceEntry[] => {
        if (node.type === CanvasNodeType.Character) return [{ node, sourceNodeId: sourceNode.id, index: 0, character: true }];
        return nodeResourceItems(node).map((resource, index) => ({ node, resource, index, sourceNodeId: sourceNode.id }));
    }));
    const editingCharacterNode = editingCharacterNodeId ? nodes.find((node) => node.id === editingCharacterNodeId) : undefined;
    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>{t("canvas.references.title")}</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map((reference) => reference.character ? (
                    <CharacterReferenceItem
                        key={`${reference.sourceNodeId}:${reference.node.id}:character`}
                        node={reference.node}
                        selection={characterSelections[reference.node.id]}
                        onOpen={onCharacterSelectionChange ? () => setEditingCharacterNodeId(reference.node.id) : undefined}
                        onRemove={() => onDisconnect?.(reference.sourceNodeId, nodeId)}
                    />
                ) : (
                    <ReferenceItem key={`${reference.sourceNodeId}:${reference.node.id}:${reference.index}`} node={reference.node} resource={reference.resource!} onRemove={() => onDisconnect?.(reference.sourceNodeId, nodeId)} />
                ))}
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title={t("canvas.references.select")} onClick={() => onStartSelection?.(nodeId)}>
                    <Plus className="size-4" />
                </button>
            </div>
            {editingCharacterNode && onCharacterSelectionChange ? <CanvasCharacterReferenceModal node={editingCharacterNode} selection={characterSelections[editingCharacterNode.id]} onApply={(selection) => onCharacterSelectionChange(editingCharacterNode.id, selection)} onClose={() => setEditingCharacterNodeId(null)} /> : null}
        </div>
    );
}

function CharacterReferenceItem({ node, selection, onOpen, onRemove }: { node: CanvasNodeData; selection?: CanvasCharacterReferenceSelection; onOpen?: () => void; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const images = node.metadata?.characterImages || [];
    const primary = images[Math.min(node.metadata?.characterPrimaryIndex || 0, Math.max(images.length - 1, 0))] || images[0];
    const selectedImageCount = selection?.imageKeys ? selection.imageKeys.length : images.length;
    const voiceIncluded = selection?.voiceEnabled !== false && Boolean(node.metadata?.characterVoiceUrl || node.metadata?.characterVoiceStorageKey);
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={primary?.url ? <div className="w-52"><img src={primary.url} alt={node.metadata?.characterName || node.title} className="max-h-56 w-full rounded-lg object-contain" /><div className="mt-1 text-sm">{node.metadata?.characterName || node.title || "角色"}</div></div> : null}>
            <div
                className="group relative flex h-14 w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-1.5 transition hover:opacity-85"
                style={{ background: theme.toolbar.activeBg, borderColor: theme.node.activeStroke || theme.toolbar.border }}
                title={onOpen ? "双击选择角色参考输入" : t("canvas.references.empty")}
                onDoubleClick={(event) => { event.stopPropagation(); onOpen?.(); }}
            >
                <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg" style={{ background: theme.toolbar.panel }}>
                    {primary?.url ? <img src={primary.url} alt="" className="size-full object-cover" draggable={false} /> : <User className="size-4 opacity-65" />}
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[11px] font-medium">{node.metadata?.characterName || node.title || "角色"}</span>
                    <span className="mt-0.5 block truncate text-[10px]" style={{ color: theme.node.muted }}>{selectedImageCount} 图{voiceIncluded ? " · 声线" : ""}</span>
                </span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
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
