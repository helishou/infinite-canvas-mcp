import { useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { buildRestoreParamsPatch } from "../services/h3-segment-utils";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";

type Props = { ctx: CanvasNodeContext; assets: H3Ref[]; outputs: H3Ref[]; segments: H3Segment[]; selected?: H3Segment; selectedRefs: H3Ref[]; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3MaterialLibrary({ ctx, assets, outputs, segments, selected, selectedRefs, imageRefs, videoRefs, audioRefs, patchSelected }: Props) {
    const [outputFilter, setOutputFilter] = useState<"all" | "current">(String(ctx.node.metadata?.minimaxOutputFilter || "") === "current" ? "current" : "all");
    const changeOutputFilter = (next: "all" | "current") => {
        setOutputFilter(next);
        ctx.updateMetadata({ minimaxOutputFilter: next });
    };
    const currentUrls = new Set((selected?.results || []).map((item) => item.url).concat(selected?.result ? [String(selected.result)] : []));
    const currentName = `Clip ${Math.max(0, segments.findIndex((item) => item.id === selected?.id)) + 1}`;
    // materials 保存的是节点级历史输出；当前筛选应显示当前 Clip 的全部历史结果，
    // 而不是只匹配当前 segment.results 中最后一次结果。
    const visibleOutputs = outputFilter === "current" ? outputs.filter((item) => currentUrls.has(item.url) || item.segmentId === selected?.id || item.name === currentName) : outputs;
    const clearUnused = () => {
        const used = new Set(segments.flatMap((segment) => [(typeof segment.result === "string" ? segment.result : ""), ...(segment.results || []).map((item) => item.url)]).filter(Boolean));
        const materials = Array.isArray(ctx.node.metadata?.materials) ? ctx.node.metadata.materials : [];
        ctx.updateMetadata({ materials: materials.filter((item) => { const value = item && typeof item === "object" ? item as Record<string, unknown> : {}; return used.has(String(value.url || value.content || "")); }) });
    };
    const section = (title: string, icon: "database" | "output", items: H3Ref[], output = false) => [
        <div key={`${title}-head`} className={`minimax-library-head${output ? " minimax-output-head" : ""}`}><H3Icon name={icon} /> <span>{title}</span>{output ? <span className="minimax-output-actions"><button type="button" aria-label={outputFilter === "all" ? "切换为只显示当前 Clip 输出" : "切换为显示全部输出"} aria-pressed={outputFilter === "current"} title={outputFilter === "all" ? "当前显示全部输出，点击只显示当前 Clip" : "当前只显示当前 Clip，点击显示全部输出"} onClick={() => changeOutputFilter(outputFilter === "all" ? "current" : "all")} className={`minimax-output-filter${outputFilter === "current" ? " active" : ""}`}><H3Icon name={outputFilter === "all" ? "filter-all" : "filter-current"} /></button><button type="button" aria-label="清理未用于 Clip 的输出" title="清理未用于 Clip 的输出" onClick={clearUnused} className="minimax-output-clear"><H3Icon name="trash" /></button></span> : null}</div>,
        <div key={`${title}-list`} className={`minimax-library-list${output ? " minimax-output-list" : ""}`}>{items.map((ref, index) => <H3MaterialCard key={`${ref.type}-${ref.url}-${index}`} ctx={ctx} ref={ref} compact removable={output} onRestore={() => patchSelected({ result: ref.url, resultStorageKey: ref.storageKey, results: [ref], ...buildRestoreParamsPatch(segments, ref) })} onRemove={() => output ? ctx.updateMetadata({ materials: (Array.isArray(ctx.node.metadata?.materials) ? ctx.node.metadata.materials : []).filter((item) => String((item as Record<string, unknown>)?.url || "") !== ref.url) }) : patchSelected({ refItems: selectedRefs.filter((item) => item.url !== ref.url), refs: { image: imageRefs.filter((item) => item.url !== ref.url), video: videoRefs.filter((item) => item.url !== ref.url), audio: audioRefs.filter((item) => item.url !== ref.url) } })} />)}{!items.length ? <div className="minimax-library-empty"><H3Icon name={icon} /><span>{title}</span></div> : null}</div>,
    ];
    return <aside className="minimax-library">{[section("Assets", "database", assets), section("Output", "output", visibleOutputs, true)]}</aside>;
}
