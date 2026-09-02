import { useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { buildRestoreParamsPatch } from "../services/h3-segment-utils";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";

type Props = { ctx: CanvasNodeContext; assets: H3Ref[]; outputs: H3Ref[]; segments: H3Segment[]; selected?: H3Segment; selectedRefs: H3Ref[]; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3MaterialLibrary({ ctx, assets, outputs, segments, selected, selectedRefs, imageRefs, videoRefs, audioRefs, patchSelected }: Props) {
    const [outputFilter, setOutputFilter] = useState<"all" | "current">("all");
    const currentUrls = new Set((selected?.results || []).map((item) => item.url).concat(selected?.result ? [String(selected.result)] : []));
    const visibleOutputs = outputFilter === "current" ? outputs.filter((item) => currentUrls.has(item.url)) : outputs;
    const clearUnused = () => {
        const used = new Set(segments.flatMap((segment) => [(typeof segment.result === "string" ? segment.result : ""), ...(segment.results || []).map((item) => item.url)]).filter(Boolean));
        const materials = Array.isArray(ctx.node.metadata?.materials) ? ctx.node.metadata.materials : [];
        ctx.updateMetadata({ materials: materials.filter((item) => { const value = item && typeof item === "object" ? item as Record<string, unknown> : {}; return used.has(String(value.url || value.content || "")); }) });
    };
    const section = (title: string, icon: "database" | "output", items: H3Ref[], output = false) => <>
        <div className={`minimax-library-head${output ? " minimax-output-head" : ""}`}><H3Icon name={icon} /> <span>{title}</span>{output ? <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}><button type="button" title="显示全部输出" onClick={() => setOutputFilter("all")} className={outputFilter === "all" ? "active" : ""}>全部</button><button type="button" title="只显示当前 Clip 输出" onClick={() => setOutputFilter("current")} className={outputFilter === "current" ? "active" : ""}>当前</button><button type="button" title="清理未用于 Clip 的输出" onClick={clearUnused}>清理</button></span> : null}</div>
        <div className={`minimax-library-list${output ? " minimax-output-list" : ""}`}>{items.map((ref) => <H3MaterialCard key={ref.url} ctx={ctx} ref={ref} compact removable={output} onRestore={() => patchSelected({ result: ref.url, resultStorageKey: ref.storageKey, results: [ref], ...buildRestoreParamsPatch(segments, ref) })} onRemove={() => output ? ctx.updateMetadata({ materials: (Array.isArray(ctx.node.metadata?.materials) ? ctx.node.metadata.materials : []).filter((item) => String((item as Record<string, unknown>)?.url || "") !== ref.url) }) : patchSelected({ refItems: selectedRefs.filter((item) => item.url !== ref.url), refs: { image: imageRefs.filter((item) => item.url !== ref.url), video: videoRefs.filter((item) => item.url !== ref.url), audio: audioRefs.filter((item) => item.url !== ref.url) } })} />)}{!items.length ? <div className="minimax-library-empty"><H3Icon name={icon} /><span>{title}</span></div> : null}</div>
    </>;
    return <aside className="minimax-library">{section("Assets", "database", assets)}{section("Output", "output", visibleOutputs, true)}</aside>;
}
