import { useEffect, useMemo, useState } from "react";
import { Empty, Input, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasNodeImage } from "@/lib/canvas/canvas-image-renderability";
import { backendMediaUrl } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasCoverCandidate = {
    nodeId: string;
    title: string;
    storageKey?: string;
    /** 直接可渲染的地址：有 storageKey 走总后台媒体，否则用节点自带 URL。 */
    url: string;
    kind: "image" | "smart" | "character" | "scene";
};

/**
 * 画布里的封面候选：图片节点与图片模式智能节点的主图、角色主图、场景图。
 * 角色节点按 characterPrimaryIndex 取图，和节点本体显示的是同一张。
 */
export function collectCanvasCoverCandidates(nodes: CanvasNodeData[]): CanvasCoverCandidate[] {
    const candidates: CanvasCoverCandidate[] = [];
    const resolve = (storageKey?: string, url?: string) => (storageKey ? backendMediaUrl(storageKey) : url || "");
    for (const node of nodes) {
        const title = node.title || node.id;
        if (node.type === CanvasNodeType.Character) {
            const images = node.metadata?.characterImages || [];
            const index = Math.min(Math.max(node.metadata?.characterPrimaryIndex || 0, 0), Math.max(images.length - 1, 0));
            const image = images[index];
            if (image && resolve(image.storageKey, image.url)) candidates.push({ nodeId: node.id, title, storageKey: image.storageKey, url: resolve(image.storageKey, image.url), kind: "character" });
            continue;
        }
        if (node.type === CanvasNodeType.Scene) {
            const image = node.metadata?.sceneImage;
            if (image && resolve(image.storageKey, image.url)) candidates.push({ nodeId: node.id, title, storageKey: image.storageKey, url: resolve(image.storageKey, image.url), kind: "scene" });
            continue;
        }
        const image = canvasNodeImage(node);
        const url = resolve(image?.storageKey, image?.content);
        if (url) candidates.push({ nodeId: node.id, title, storageKey: image?.storageKey, url, kind: node.type === CanvasNodeType.Config ? "smart" : "image" });
    }
    return candidates;
}

type Props = {
    open: boolean;
    nodes: CanvasNodeData[];
    onSelect: (candidate: CanvasCoverCandidate) => void;
    onClose: () => void;
};

export function CanvasCoverPicker({ open, nodes, onSelect, onClose }: Props) {
    const { t } = useTranslation();
    const connected = useBackendStore((state) => state.connected);
    const [keyword, setKeyword] = useState("");
    // 每次打开都从空搜索开始。
    useEffect(() => {
        if (open) setKeyword("");
    }, [open]);
    const candidates = useMemo(() => collectCanvasCoverCandidates(nodes), [nodes]);
    const filtered = useMemo(() => {
        const query = keyword.trim().toLocaleLowerCase();
        return query ? candidates.filter((candidate) => candidate.title.toLocaleLowerCase().includes(query)) : candidates;
    }, [candidates, keyword]);
    return (
        <Modal title={t("prompts.custom.form.coverFromCanvas")} open={open} onCancel={onClose} footer={null} width={720} destroyOnHidden>
            <Input size="small" allowClear placeholder={t("prompts.custom.form.coverSearchPlaceholder")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
            {filtered.length ? (
                <div className="mt-3 grid max-h-[420px] grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5">
                    {filtered.map((candidate) => (
                        <button
                            key={`${candidate.nodeId}:${candidate.storageKey || candidate.url.slice(-24)}`}
                            type="button"
                            className="group relative aspect-square overflow-hidden rounded-md border border-stone-200 bg-stone-50 text-left dark:border-stone-700 dark:bg-stone-900"
                            onClick={() => onSelect(candidate)}
                        >
                            <img src={candidate.url} alt={candidate.title} className="size-full object-cover transition duration-200 group-hover:scale-[1.04]" loading="lazy" />
                            <Tooltip title={candidate.title}>
                                <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/55 px-1 text-[9px] uppercase text-white/90">{candidate.kind}</span>
                            </Tooltip>
                            <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{candidate.title}</span>
                        </button>
                    ))}
                </div>
            ) : (
                <Empty className="mt-6" image={Empty.PRESENTED_IMAGE_SIMPLE} description={connected ? t("prompts.custom.form.coverEmpty") : t("canvas.sidePanel.mediaUnavailable")} />
            )}
        </Modal>
    );
}
