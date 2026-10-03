import { useMemo, useRef, useState } from "react";
import { Input, InputNumber, Modal } from "antd";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { canvasRenamePreview } from "@/lib/canvas/canvas-navigation";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasBatchRename({ nodes, onClose, onApply }: { nodes: CanvasNodeData[]; onClose: () => void; onApply: (renames: Array<{ id: string; title: string }>) => void }) {
    const { t } = useTranslation();
    const [prefix, setPrefix] = useState(t("canvas.navigation.defaultPrefix"));
    const [start, setStart] = useState<number | null>(1);
    const list = useRef<HTMLDivElement>(null);
    const preview = useMemo(() => canvasRenamePreview(nodes, prefix, start), [nodes, prefix, start]);
    const virtualizer = useVirtualizer({ count: preview.length, getScrollElement: () => list.current, estimateSize: () => 36, overscan: 8 });
    return <Modal open title={t("canvas.navigation.rename")} onCancel={onClose} modalRender={(content) => <div data-canvas-shortcuts-ignore>{content}</div>} okText={t("canvas.navigation.applyRename", { count: preview.length })} okButtonProps={{ disabled: !preview.length }} onOk={() => { onApply(preview); onClose(); }} afterOpenChange={() => virtualizer.measure()}>
        <div data-canvas-shortcuts-ignore>
            <div className="flex gap-3">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">{t("canvas.navigation.prefix")}<Input autoFocus aria-label={t("canvas.navigation.prefix")} value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label>
                <label className="flex flex-col gap-1 text-sm">{t("canvas.navigation.startNumber")}<InputNumber aria-label={t("canvas.navigation.startNumber")} min={1} precision={0} value={start} onChange={setStart} /></label>
            </div>
            <p className="mt-3 text-xs opacity-60">{t("canvas.navigation.renameHint")}</p>
            <div ref={list} className="overflow-y-auto" style={{ height: Math.min(216, Math.max(72, preview.length * 36)) }}>
                <div className="relative" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((row) => {
                    const item = preview[row.index];
                    return <div key={item.id} className="absolute left-0 top-0 flex w-full items-center gap-2 text-sm" style={{ height: row.size, transform: `translateY(${row.start}px)` }}><span className="min-w-0 flex-1 truncate opacity-60">{item.before || t("canvas.node.untitled")}</span><span aria-hidden>→</span><span className="min-w-0 flex-1 truncate">{item.title}</span></div>;
                })}</div>
                {!preview.length && <p role="status" className="text-sm opacity-60">{t("canvas.navigation.invalidNumber")}</p>}
            </div>
        </div>
    </Modal>;
}
