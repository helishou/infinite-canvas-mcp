import { useEffect, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { buildRestoreParamsPatch } from "../services/h3-segment-utils";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";

type Props = { ctx: CanvasNodeContext; outputs: H3Ref[]; segments: H3Segment[]; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3MaterialLibrary({ ctx, outputs, segments, selected, patchSelected }: Props) {
    const [outputFilter, setOutputFilter] = useState<"all" | "current">(String(ctx.node.metadata?.minimaxOutputFilter || "") === "current" ? "current" : "all");
    const [previewRef, setPreviewRef] = useState<H3Ref | null>(null);
    const changeOutputFilter = (next: "all" | "current") => { setOutputFilter(next); ctx.updateMetadata({ minimaxOutputFilter: next }); };
    const currentUrls = new Set((selected?.results || []).map((item) => item.url).concat(selected?.result ? [String(selected.result)] : []));
    const visibleOutputs = outputFilter === "current" ? outputs.filter((item) => currentUrls.has(item.url) || item.segmentId === selected?.id) : outputs;
    const clearUnused = () => {
        const used = new Set(segments.flatMap((segment) => [(typeof segment.result === "string" ? segment.result : ""), ...(segment.results || []).map((item) => item.url)]).filter(Boolean));
        const materials = Array.isArray(ctx.node.metadata?.materials) ? ctx.node.metadata.materials : [];
        ctx.updateMetadata({ materials: materials.filter((item) => used.has(String((item as Record<string, unknown>)?.url || (item as Record<string, unknown>)?.content || ""))) });
    };
    const removeOutput = (ref: H3Ref) => ctx.updateMetadata({ materials: (Array.isArray(ctx.node.metadata?.materials) ? ctx.node.metadata.materials : []).filter((item) => String((item as Record<string, unknown>)?.url || "") !== ref.url) });
    useEffect(() => {
        if (!previewRef) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPreviewRef(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [previewRef]);
    return <aside className="minimax-library">
        <div key="library-head" className="minimax-library-head"><H3Icon name="output" /> <span>Output</span><span className="minimax-output-actions"><button type="button" aria-label="切换输出筛选" aria-pressed={outputFilter === "current"} title={outputFilter === "all" ? "当前显示全部输出，点击只显示当前 Clip" : "当前只显示当前 Clip，点击显示全部输出"} onClick={() => changeOutputFilter(outputFilter === "all" ? "current" : "all")} className={`minimax-output-filter${outputFilter === "current" ? " active" : ""}`}><H3Icon name={outputFilter === "all" ? "filter-all" : "filter-current"} /></button><button type="button" aria-label="清理未用于 Clip 的输出" title="清理未用于 Clip 的输出" onClick={clearUnused} className="minimax-output-clear"><H3Icon name="trash" /></button></span></div>
        <div key="library-list" className="minimax-library-list minimax-output-list">{visibleOutputs.map((ref, index) => <H3MaterialCard key={`${ref.type}-${ref.url}-${index}`} ctx={ctx} ref={ref} compact removable onRestore={() => patchSelected({ result: ref.url, resultStorageKey: ref.storageKey, results: [ref], ...buildRestoreParamsPatch(segments, ref) })} onRemove={() => removeOutput(ref)} onOpenPreview={() => setPreviewRef(ref)} />)}{!visibleOutputs.length ? <div key="empty-output" className="minimax-library-empty"><H3Icon name="output" /><span>Output</span></div> : null}</div>
        {previewRef ? <div key="lightbox" className="minimax-lightbox" onClick={() => setPreviewRef(null)}>
            <button type="button" className="minimax-lightbox-close" aria-label="关闭预览" onClick={(event) => { event.stopPropagation(); setPreviewRef(null); }}><H3Icon name="close" /></button>
            <div className="minimax-lightbox-body" onClick={(event) => event.stopPropagation()}>
                {previewRef.type === "video" ? <video src={previewRef.url} controls autoPlay playsInline style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8, background: "#000" }} /> : previewRef.type === "image" ? <img src={previewRef.url} alt={previewRef.name} style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8 }} /> : <audio src={previewRef.url} controls autoPlay style={{ width: "min(640px, 92vw)" }} />}
                <div className="minimax-lightbox-name">{previewRef.name || (previewRef.type === "video" ? "视频" : previewRef.type === "image" ? "图片" : "音频")}</div>
            </div>
        </div> : null}
    </aside>;
}
