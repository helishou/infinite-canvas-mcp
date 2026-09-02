import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { buildRestoreParamsPatch } from "../services/h3-segment-utils";
import { H3Icon } from "./H3Icon";
import { H3MaterialCard } from "./H3MaterialCard";

type Props = { ctx: CanvasNodeContext; assets: H3Ref[]; outputs: H3Ref[]; segments: H3Segment[]; selectedRefs: H3Ref[]; imageRefs: H3Ref[]; videoRefs: H3Ref[]; audioRefs: H3Ref[]; patchSelected: (patch: Partial<H3Segment>) => void };

export function H3MaterialLibrary({ ctx, assets, outputs, segments, selectedRefs, imageRefs, videoRefs, audioRefs, patchSelected }: Props) {
    const section = (title: string, icon: "database" | "output", items: H3Ref[], output = false) => <>
        <div className={`minimax-library-head${output ? " minimax-output-head" : ""}`}><H3Icon name={icon} /> <span>{title}</span></div>
        <div className={`minimax-library-list${output ? " minimax-output-list" : ""}`}>{items.map((ref) => <H3MaterialCard key={ref.url} ctx={ctx} ref={ref} compact removable onRestore={() => patchSelected({ result: ref.url, resultStorageKey: ref.storageKey, results: [ref], ...buildRestoreParamsPatch(segments, ref) })} onRemove={() => patchSelected({ refItems: selectedRefs.filter((item) => item.url !== ref.url), refs: { image: imageRefs.filter((item) => item.url !== ref.url), video: videoRefs.filter((item) => item.url !== ref.url), audio: audioRefs.filter((item) => item.url !== ref.url) } })} />)}{!items.length ? <div className="minimax-library-empty"><H3Icon name={icon} /><span>{title}</span></div> : null}</div>
    </>;
    return <aside className="minimax-library">{section("Assets", "database", assets)}{section("Output", "output", outputs, true)}</aside>;
}
