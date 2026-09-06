import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";
import { resultUrl } from "../services/h3-data";
import { segmentsFor } from "../hooks/useH3Segments";

export function requestH3Run(ctx: CanvasNodeContext, all = false) {
    const node = ctx.getNode(ctx.node.id) || ctx.node;
    const metadata = node.metadata || {};
    if (["queued", "loading"].includes(String(metadata.status || ""))) return;
    const segments = segmentsFor(metadata);
    const selectedId = String(metadata.selectedSegmentId || segments[0]?.id || "");
    const selected = segments.find((segment) => segment.id === selectedId) || segments[0];
    const prompt = String(selected?.prompt || metadata.prompt || "");
    ctx.updateMetadata({
        selectedSegmentId: selectedId,
        prompt,
        segments: segments.map((segment) => all || segment.id === selectedId ? { ...segment, prompt: segment.id === selectedId ? prompt : segment.prompt, status: "queued", progress: 0, runtimeTaskId: "" } : segment),
        status: "queued",
        runRequestId: `h3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        runRequestAll: all,
        runRequestConsumedId: "",
        cancelRequested: false,
        runtimeTaskId: "",
        runProgress: 0,
    });
}

export function resetH3Run(ctx: CanvasNodeContext) {
    const node = ctx.getNode(ctx.node.id) || ctx.node;
    const segments = segmentsFor(node.metadata || {}).map((segment) => ({ ...segment, result: "", results: [], status: "idle", progress: 0, runtimeTaskId: "" }));
    ctx.updateMetadata({ content: "", mimeType: undefined, naturalWidth: undefined, naturalHeight: undefined, durationMs: undefined, materials: [], segments, status: "idle", errorDetails: "", runtimeTaskId: "", runProgress: 0, runRequestId: "", runRequestConsumedId: "", cancelRequested: false, runFinishedAt: undefined });
}

export function H3StatusBadge({ status, error, onRetry }: { status: string; error: string; onRetry: () => void }) {
    if (!status || status === "idle") return null;
    const label = status === "queued" ? "排队中…" : status === "loading" ? "生成中…" : status === "success" ? "已完成" : status === "cancelled" ? "已取消" : status === "error" ? `失败：${error || "未知错误"}` : status;
    return <div className={`minimax-status-badge ${status}`}><span>{label}</span>{status === "error" ? <button type="button" onClick={(event) => { event.stopPropagation(); onRetry(); }}>重试</button> : null}</div>;
}

// 时间轴轨道按固定 100px/秒 铺（ruler tick 用 time*50px 定位，可横向滚动），
// 指针必须用同样的像素刻度定位，按轨道总宽百分比换算会在 total<10s（timelineWidth=500 兜底）时错位。
export function H3PlayheadStyle({ playhead, total }: { playhead: number; total: number }) {
    const safe = Math.max(0, Math.min(Number(total || 0), Number(playhead || 0)));
    const position = `calc(52px + ${safe * 100}px)`;
    return <style>{`.minimax-canvas-workbench .minimax-edit-timeline::after{left:${position};background:#3b82f6}.minimax-canvas-workbench .minimax-edit-timeline::before{content:"";display:block;position:absolute;z-index:15;top:0;left:${position};width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #3b82f6;transform:translateX(-50%);pointer-events:none}`}</style>;
}

type H3PaneKey = "previewH" | "previewW" | "promptW" | "timelineH" | "refLaneH";
// 每个手柄：调哪个 metadata 键、沿哪个轴、往哪个方向拖是增大。
// 方向遵循「边缘跟随指针」：抓住某个模块的边缘往哪拖，该模块就往哪变大。
const H3_PANE_META: Record<H3PaneKey, { metadataKey: string; axis: "x" | "y"; sign: 1 | -1 }> = {
    previewH: { metadataKey: "minimaxPreviewH", axis: "y", sign: 1 },    // 预览下边缘：下拉预览增高（时间轴等量让位，Output 不变）
    previewW: { metadataKey: "minimaxPreviewW", axis: "x", sign: 1 },    // 预览右边缘：右拉预览增宽
    promptW: { metadataKey: "minimaxPromptW", axis: "x", sign: -1 },     // Setting 左边缘：左拉 Setting 增宽
    timelineH: { metadataKey: "minimaxTimelineH", axis: "y", sign: 1 },  // Output 上边缘：上拉 Output 增高（时间轴让位），预览不变
    refLaneH: { metadataKey: "minimaxRefLaneH", axis: "y", sign: -1 },   // Refs 行上边缘：上拉 Refs 增高（Video 行让位）
};
const H3_PANE_BOUNDS: Record<H3PaneKey, [number, number]> = { previewH: [130, 2000], previewW: [280, 1400], promptW: [220, 900], timelineH: [250, 2000], refLaneH: [60, 900] };
const H3_PANE_DEFAULTS: Record<H3PaneKey, number> = { previewH: 220, previewW: 960, promptW: 480, timelineH: 320, refLaneH: 150 };

// 行高布局常量（拖拽侧与读取侧共用的唯一口径，此前散在三处导致互相打架）：
// wb-body 自身 padding+gap 合计 36；Output 行保底 80；
// 时间轴面板内部固定需求 = controls 44 + 刻度尺 28 + Video 行最低 ~110 + 余量 ≈ 190 + Refs 行高。
export const H3_BODY_CHROME = 36;
export const H3_OUTPUT_MIN = 80;
export const H3_PREVIEW_MIN = 130;
export const H3_REF_MIN = 60;
export const H3_TIMELINE_CHROME = 190;
export const H3_NODE_MAX = 4000;

// 高度预算求解：节点在画布上被手动压小、行1+行2+Output 装不下时，按
// 「预览先让(到 130 下限) → 时间轴再让(到 max(250, 190+Refs) 下限)」连续收敛，Output 始终保底 80。
// 全程单调连续（脱离挤压态时恰好等于输入值），边界无跳变。拖拽侧与读取侧共用。
export function h3SolveRows(bodyH: number, p: number, t: number, r: number) {
    const avail = Math.max(0, bodyH - H3_BODY_CHROME - H3_OUTPUT_MIN);
    let ep = p;
    let et = t;
    const over = Math.max(0, ep + et - avail);
    if (over > 0) {
        const dp = Math.min(over, Math.max(0, ep - H3_PREVIEW_MIN));
        ep -= dp;
        const rest = over - dp;
        if (rest > 0) et -= Math.min(rest, Math.max(0, et - Math.max(250, H3_TIMELINE_CHROME + r)));
    }
    return { p: Math.round(ep), t: Math.round(et), r: Math.round(Math.max(H3_REF_MIN, Math.min(r, et - H3_TIMELINE_CHROME))) };
}

// 每个模块都可拖边调宽高。手柄位置不再用「工具栏高度常量 + calc 变量链」绝对定位
// （常量与实际栅格一脱节手柄就漂移），改为 ResizeObserver 实测各模块真实边界，
// offset* 是本地 CSS px，与工作台内绝对定位同坐标系、不受画布 zoom 缩放影响。
export function H3PaneHandles({ ctx }: { ctx: CanvasNodeContext }) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const solveRef = useRef<() => void>(() => { });
    const lastBodyHRef = useRef(0); // 上一次实测 wb-body 高度，用于识别「节点被画布缩放」并做等比缩放
    const [bars, setBars] = useState<Array<{ key: H3PaneKey; dir: "ns" | "ew"; x: number; y: number; w: number; h: number }>>([]);
    useEffect(() => {
        const host = hostRef.current?.parentElement;
        if (!host) return;
        // 行高归位/等比缩放（非拖动态）：
        // ①节点高度没变 → 仅挤压归位：视觉行高 ≠ metadata 时把 h3SolveRows 收敛值写回，「存的值=看到的值」。
        // ②节点高度变了（在画布上缩放 H3 节点）→ 所有模块等比缩放：预览/时间轴(含 Refs 行)/Output 按原比例
        //   一起变（各下限钳制，装不下时再收敛），而不是只有 Output 吃余量。
        // 拖动进行中只更新基线、不回写（拖动每帧都在写 metadata），松手后补一次。
        const solve = () => {
            const bodyH = host.querySelector<HTMLElement>(".minimax-wb-body")?.clientHeight || 0;
            if (!bodyH) return;
            const prev = lastBodyHRef.current;
            lastBodyHRef.current = bodyH;
            if (drag.current) return;
            const metadata = ctxRef.current.node.metadata || {};
            const r = Math.max(H3_REF_MIN, Math.min(900, Number(metadata.minimaxRefLaneH) || 150));
            const p = Math.max(H3_PREVIEW_MIN, Math.min(2000, Number(metadata.minimaxPreviewH) || 220));
            const t = Math.max(H3_TIMELINE_CHROME + r, Math.min(2000, Number(metadata.minimaxTimelineH) || 320));
            let next: { p: number; t: number; r: number };
            if (prev > 36 && bodyH > 36 && prev !== bodyH) {
                // 节点高度变化：以上一次的实际视觉行高为基准等比缩放（Output 是余量，随总空间自然同比）
                const base = h3SolveRows(prev, p, t, r);
                const k = (bodyH - H3_BODY_CHROME) / (prev - H3_BODY_CHROME);
                const np = Math.max(H3_PREVIEW_MIN, Math.round(base.p * k));
                const nt = Math.max(250, Math.round(base.t * k));
                const nr = Math.max(H3_REF_MIN, Math.min(nt - H3_TIMELINE_CHROME, Math.round(base.r * k)));
                next = h3SolveRows(bodyH, np, nt, nr);
            } else {
                next = h3SolveRows(bodyH, p, t, r);
            }
            if (next.p !== p || next.t !== t || next.r !== r) ctxRef.current.updateMetadata({ minimaxPreviewH: next.p, minimaxTimelineH: next.t, minimaxRefLaneH: next.r });
        };
        solveRef.current = solve;
        const measure = () => {
            const stage = host.querySelector<HTMLElement>(".minimax-player-stage");
            const prompt = host.querySelector<HTMLElement>(".minimax-prompt-side");
            const timeline = host.querySelector<HTMLElement>(".minimax-edit-timeline");
            const library = host.querySelector<HTMLElement>(".minimax-library");
            const tracks = host.querySelector<HTMLElement>(".minimax-tracks-scroll");
            const refRow = host.querySelector<HTMLElement>(".minimax-ref-row");
            const next: Array<{ key: H3PaneKey; dir: "ns" | "ew"; x: number; y: number; w: number; h: number }> = [];
            const colsLeft = stage ? stage.offsetLeft : 10;
            const colsRight = timeline ? timeline.offsetLeft + timeline.offsetWidth : stage ? stage.offsetLeft + stage.offsetWidth : 0;
            if (stage && stage.offsetHeight > 0 && colsRight > colsLeft) {
                // preview↔VideoRefs 分界线只跟 preview 等宽：线上方只有 preview（列1），
                // 之前取到时间轴右边缘（列1+列2），横线会穿过 preview 右侧的空区一路伸到设置面板跟前。
                next.push({ key: "previewH", dir: "ns", x: stage.offsetLeft, y: stage.offsetTop + stage.offsetHeight, w: stage.offsetWidth, h: 7 });
                next.push({ key: "previewW", dir: "ew", x: stage.offsetLeft + stage.offsetWidth, y: stage.offsetTop, w: 7, h: stage.offsetHeight });
            }
            if (prompt && prompt.offsetHeight > 0) next.push({ key: "promptW", dir: "ew", x: prompt.offsetLeft, y: prompt.offsetTop, w: 7, h: prompt.offsetHeight });
            // Output 素材库的上边缘 = 时间轴行 / Output 行分界（行1、行2 都是固定 px，行3 吃余量）
            if (library && library.offsetHeight > 0 && library.offsetWidth > 0) next.push({ key: "timelineH", dir: "ns", x: colsLeft, y: library.offsetTop, w: library.offsetWidth, h: 7 });
            if (timeline && refRow && refRow.offsetHeight > 0) {
                const scroll = tracks ? tracks.offsetTop : 0;
                next.push({ key: "refLaneH", dir: "ns", x: timeline.offsetLeft + 36, y: timeline.offsetTop + scroll + refRow.offsetTop, w: Math.max(0, timeline.offsetWidth - 36 - 54), h: 7 });
            }
            setBars((cur) => (cur.length === next.length && cur.every((bar, index) => bar.key === next[index].key && Math.abs(bar.x - next[index].x) < 1 && Math.abs(bar.y - next[index].y) < 1 && Math.abs(bar.w - next[index].w) < 1 && Math.abs(bar.h - next[index].h) < 1) ? cur : next));
        };
        measure();
        solve();
        const ro = new ResizeObserver(() => { measure(); solve(); });
        ro.observe(host);
        for (const selector of [".minimax-player-stage", ".minimax-prompt-side", ".minimax-edit-timeline", ".minimax-library", ".minimax-tracks-scroll", ".minimax-ref-row"]) {
            const el = host.querySelector(selector);
            if (el) ro.observe(el);
        }
        const onResize = () => { measure(); solve(); };
        window.addEventListener("resize", onResize);
        return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
    }, []);
    // previewH / timelineH / refLaneH 是联动手柄：拖动时需要拖起瞬间的行高/outputH/bodyH 快照做比例分配。
    const drag = useRef<{ key: H3PaneKey; x: number; y: number; value: number; previewH?: number; timelineH?: number; refLaneH?: number; outputH?: number; bodyH?: number; nodeH?: number } | null>(null);
    const scale = () => {
        const host = hostRef.current?.parentElement;
        // 画布节点带 zoom transform：屏幕指针位移 / 缩放系数 = 本地 CSS px 位移
        return host && host.offsetWidth > 0 ? host.getBoundingClientRect().width / host.offsetWidth : 1;
    };
    const onPointerDown = (key: H3PaneKey) => (event: React.PointerEvent<HTMLSpanElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const metadata = ctx.node.metadata || {};
        const value = Number(metadata[H3_PANE_META[key].metadataKey]) || H3_PANE_DEFAULTS[key];
        const factor = scale();
        const base: typeof drag.current = { key, x: event.clientX / factor, y: event.clientY / factor, value };
        if (key === "previewH" || key === "timelineH" || key === "refLaneH") {
            const host = hostRef.current?.parentElement;
            // 快照直接取 metadata 真值（钳制与 bounds 一致）。历史 bug 源：这里曾钳到 900，
            // 而行高/节点早已允许 2000，超 900 的节点一抓手就先跳回 900。
            const refLane0 = Math.max(H3_REF_MIN, Math.min(900, Number(metadata.minimaxRefLaneH) || 150));
            const p0 = Math.max(H3_PREVIEW_MIN, Math.min(2000, Number(metadata.minimaxPreviewH) || 220));
            const t0 = Math.max(H3_TIMELINE_CHROME + refLane0, Math.min(2000, Number(metadata.minimaxTimelineH) || 320));
            const bodyH = host?.querySelector<HTMLElement>(".minimax-wb-body")?.clientHeight || 0;
            const library = host?.querySelector<HTMLElement>(".minimax-library");
            const outputH = library && library.offsetHeight > 0 ? library.offsetHeight : Math.max(H3_OUTPUT_MIN, bodyH - H3_BODY_CHROME - p0 - t0);
            // 解除挤压：节点比内容需求矮（在画布上手动压小过）时，先把节点长回内容需求高度
            //（Output 恢复 80 保底），拖动从「metadata=视觉、Output=保底」的 1:1 状态开始，无死区。
            let nodeN = Number(ctx.node.height) || 0;
            if (bodyH && nodeN) {
                const minNode = nodeN - bodyH + H3_BODY_CHROME + p0 + t0 + H3_OUTPUT_MIN;
                if (minNode > nodeN) {
                    ctx.updateNode({ height: Math.round(minNode) });
                    nodeN = minNode;
                }
            }
            Object.assign(base, { previewH: p0, timelineH: t0, refLaneH: refLane0, outputH, bodyH, nodeH: nodeN });
        }
        drag.current = base;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/无指针ID 的测试事件 */ }
    };
    const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
        const state = drag.current;
        if (!state) return;
        const meta = H3_PANE_META[state.key];
        let [min, max] = H3_PANE_BOUNDS[state.key];
        // 时间轴面板内部固定需求 = controls 44 + 刻度尺 28 + Video 行最低 ~110 + Refs 行 refLaneH，
        // timelineH 低于它行与行就会互相挤压裁切；两把行高手柄互相约束下限/上限。
        const metadataNow = ctx.node.metadata || {};
        const refLaneNow = Math.max(H3_REF_MIN, Math.min(900, Number(metadataNow.minimaxRefLaneH) || 150));
        const timelineNow = Math.max(H3_TIMELINE_CHROME + refLaneNow, Math.min(2000, Number(metadataNow.minimaxTimelineH) || 320));
        if (state.key === "timelineH") min = H3_TIMELINE_CHROME + refLaneNow;
        if (state.key === "refLaneH") max = Math.min(max, timelineNow - H3_TIMELINE_CHROME);
        const factor = scale();
        const delta = (meta.axis === "y" ? event.clientY : event.clientX) / factor - (meta.axis === "y" ? state.y : state.x);
        // 规则①（Output↔VideoRefs 分界线，AGENTS.md 定案）：preview 高度不变；时间轴(VideoRefs)与 Output 此消彼长；
        // Output 压到 80 保底后继续下拉 → 节点自动长高，反向拖回时节点单调缩回。
        if (state.key === "timelineH") {
            const t0 = state.timelineH || 320;
            const minT = H3_TIMELINE_CHROME + refLaneNow;
            const capT = t0 + ((state.outputH || H3_OUTPUT_MIN) - H3_OUTPUT_MIN); // 节点不变时时间轴的物理上限
            const desiredT = t0 + meta.sign * delta;
            if (state.nodeH) ctx.updateNode({ height: Math.round(Math.min(H3_NODE_MAX, state.nodeH + Math.max(0, desiredT - capT))) });
            ctx.updateMetadata({ minimaxTimelineH: Math.round(Math.max(minT, Math.min(2000, desiredT))) });
            return;
        }
        // Refs 行上边缘：只改 Video/Refs 分割（边界跟随指针）；Refs 压到 60 下限后继续下拉 →
        // 时间轴增高（Video 行变大、Output 让位、Output 到保底后节点自动长高/缩回）。preview 不参与。
        if (state.key === "refLaneH" && state.refLaneH !== undefined && state.timelineH !== undefined) {
            const desired = state.refLaneH - delta;
            const newRef = Math.max(H3_REF_MIN, Math.min(state.timelineH - H3_TIMELINE_CHROME, desired));
            let newT = state.timelineH;
            if (desired < H3_REF_MIN) {
                const wanted = state.timelineH + (H3_REF_MIN - desired);
                const capT = state.timelineH + ((state.outputH || H3_OUTPUT_MIN) - H3_OUTPUT_MIN);
                if (state.nodeH) ctx.updateNode({ height: Math.round(Math.min(H3_NODE_MAX, state.nodeH + Math.max(0, wanted - capT))) });
                newT = Math.min(2000, wanted);
            }
            ctx.updateMetadata({ minimaxRefLaneH: Math.round(newRef), minimaxTimelineH: Math.round(newT) });
            return;
        }
        // 规则②（VideoRefs↔preview 分界线，AGENTS.md 定案）：Output 高度不变；预览与时间轴此消彼长；
        // 时间轴压到下限(190+Refs行高)后继续下拉 → 节点自动长高（预览吃增量、时间轴/Output 不变）；反向拖回节点缩回。
        if (state.key === "previewH" && state.timelineH !== undefined) {
            const t0 = state.timelineH;
            const p0 = Math.max(H3_PREVIEW_MIN, state.value);
            const minT = H3_TIMELINE_CHROME + refLaneNow;
            const maxP = p0 + (t0 - minT);                                // 节点/Output 不变时预览的物理上限
            const desiredP = p0 + delta;
            if (state.nodeH) ctx.updateNode({ height: Math.round(Math.min(H3_NODE_MAX, state.nodeH + Math.max(0, desiredP - maxP))) });
            const newP = Math.round(Math.max(H3_PREVIEW_MIN, Math.min(2000, desiredP)));
            const newT = newP > maxP ? minT : Math.round(Math.max(minT, Math.min(2000, t0 - (newP - p0))));
            ctx.updateMetadata({ minimaxPreviewH: newP, minimaxTimelineH: newT });
            return;
        }
        const next = Math.round(Math.max(min, Math.min(max, state.value + meta.sign * delta)));
        ctx.updateMetadata({ [meta.metadataKey]: next });
    };
    const release = (event: React.PointerEvent<HTMLSpanElement>) => {
        drag.current = null;
        solveRef.current(); // 松手后补一次挤压归位（拖动期间跳过的回写）
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 同上 */ }
    };
    return <div ref={hostRef} style={{ display: "contents" }}>{bars.map((bar) => <span key={bar.key} className={`minimax-pane-handle minimax-pane-handle-${bar.dir}`} style={bar.dir === "ns" ? { left: bar.x, top: bar.y - 3, width: bar.w, height: 7 } : { left: bar.x - 3, top: bar.y, width: 7, height: bar.h }} onPointerDown={onPointerDown(bar.key)} onPointerMove={onPointerMove} onPointerUp={release} onPointerCancel={release} />)}</div>;
}

export function H3RulerScrubber({ ctx, total, previewH }: { ctx: CanvasNodeContext; total: number; previewH: number }) {
    const scrubRef = useRef<HTMLDivElement | null>(null);
    const [origin, setOrigin] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
    // 轨道几何直接取 ruler 的 offset*（本地 CSS px，与绝对定位同坐标系、不受画布 zoom 缩放），
    // getBoundingClientRect 量的是屏幕 px，缩放后必须再除以 scale 才能用回本地坐标。
    useEffect(() => {
        const host = scrubRef.current?.parentElement;
        // H3Timeline 的 ruler 行 class 名是 minimax-ruler-row（不是 .minimax-ruler，
        // 后者已不存在于 DOM）。这里必须匹配实际渲染的 class，否则 origin 永远为 null
        // 退回到 fallback（top: calc(58px + previewH + 10px), height: 28），scrubber
        // 会跟 H3 节点内部 ruler 错位甚至在节点外。
        const ruler = host?.querySelector<HTMLElement>(".minimax-ruler-row");
        const timeline = host?.querySelector<HTMLElement>(".minimax-edit-timeline");
        if (!host || !ruler) return;
        const sync = () => {
            // scrubber 定位在工作台坐标系，ruler 的 offset* 是时间轴内部坐标：
            // left 要补上时间轴自身的偏移；width 必须取可见宽度（时间轴 clientWidth 减去左侧标签列 36 与右侧槽 54），
            // 不能用 ruler.offsetWidth——那是可横向滚动的轨道内容总宽（可达数千 px），
            // 之前因此整条隐形 scrubber 横穿设置面板伸出节点外，还压在面板上抢指针事件。
            const tlLeft = timeline ? timeline.offsetLeft : 0;
            const visible = timeline ? Math.max(0, timeline.clientWidth - 36 - 54) : ruler.offsetWidth;
            const next = { top: Math.round(ruler.offsetTop + ((ruler.offsetParent as HTMLElement | null)?.offsetTop ?? 0)), left: Math.round(tlLeft + ruler.offsetLeft), width: Math.round(Math.min(ruler.offsetWidth, visible)), height: Math.round(ruler.offsetHeight) };
            setOrigin((cur) => cur && Math.abs(cur.top - next.top) < 1 && Math.abs(cur.left - next.left) < 1 && Math.abs(cur.width - next.width) < 1 && Math.abs(cur.height - next.height) < 1 ? cur : next);
        };
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(ruler);
        if (timeline) ro.observe(timeline); // 拖 Settings 宽度手柄时时间轴变宽，可见宽度要跟着重算
        ro.observe(host);
        window.addEventListener("resize", sync);
        return () => { ro.disconnect(); window.removeEventListener("resize", sync); };
    }, [previewH]);
    const apply = (event: React.PointerEvent<HTMLDivElement>) => {
        const el = event.currentTarget as HTMLDivElement;
        const rect = el.getBoundingClientRect();
        // 画布节点带 zoom transform：屏幕距离 / 缩放系数 才等于本地 CSS px 距离。
        const host = scrubRef.current?.parentElement;
        const rulerInner = host?.querySelector<HTMLElement>(".minimax-ruler-row > div");
        // 指针跟随滚动：ruler 内容用 translateX(-scrollLeft) 同步轨道滚动，
        // 点击时要把这个偏移加回去，否则点击位置会偏移已滚动的距离。
        const transformMatch = rulerInner?.style.transform?.match(/translateX\(([-\d.]+)px\)/);
        const scroll = transformMatch ? Math.abs(parseFloat(transformMatch[1])) : 0;
        const scale = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
        const px = Math.max(0, (event.clientX - rect.left) / scale + scroll);
        // 拖拽/点击 seek 的同时停掉播放循环，避免视频 onTimeUpdate 用自身 currentTime 把指针拉回去
        ctx.updateMetadata({ playhead: Math.max(0, Math.min(total, px / 100)), h3PlaybackAll: false, h3Scrubbing: true });
    };
    return <div ref={scrubRef} className="minimax-ruler-scrubber" style={{ top: origin?.top ?? `calc(58px + ${previewH}px + 10px)`, left: origin?.left ?? 62, width: origin?.width ?? "calc(100% - 126px)", height: origin?.height ?? 28 }} title="点击跳转播放指针" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/无指针ID 的测试事件无活动指针，忽略 */ } apply(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) apply(event); }} onPointerUp={(event) => { try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 同上 */ } ctx.updateMetadata({ h3Scrubbing: false }); }} onPointerCancel={() => { ctx.updateMetadata({ h3Scrubbing: false }); }} />;
}

export function H3PreviewPlayer({ ctx, url, kind, storageKey, name, playhead, timelineOffset = 0, clipDuration, playRequest, nextUrl, onEnded }: { ctx: CanvasNodeContext; url: string; kind: H3Ref["type"]; storageKey?: string; name?: string; playhead: number; timelineOffset?: number; clipDuration?: number; playRequest: number; nextUrl?: string; onEnded?: () => void }) {
    const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
    const preloadRef = useRef<HTMLVideoElement | null>(null);
    const onEndedRef = useRef(onEnded);
    useEffect(() => { onEndedRef.current = onEnded; }, [onEnded]);
    // 监听 video/audio 原生 ended 事件（视频完整播完后触发，驱动 advancePlayback 换段）
    useEffect(() => {
        const media = mediaRef.current;
        if (!media) return;
        const handler = () => { onEndedRef.current?.(); };
        media.addEventListener("ended", handler);
        return () => media.removeEventListener("ended", handler);
    }, [url]);
    useEffect(() => { const media = mediaRef.current; if (!media || !playRequest) return; if (media.paused) void media.play().catch(() => undefined); else media.pause(); }, [playRequest]);
    // 拖动刻度线 seek：playhead 变化时同步更新视频当前帧（无需等 onLoadedMetadata）
    useEffect(() => {
        const media = mediaRef.current;
        if (!media || !Number.isFinite(playhead)) return;
        // 播放中不强制 seek（避免跟 onTimeUpdate 冲突），仅暂停态/未初始化时同步
        if (!media.paused && Math.abs(media.currentTime - playhead) < 0.3) return;
        if (media.readyState >= 1 && Math.abs(media.currentTime - playhead) > 0.1) {
            media.currentTime = Math.max(0, Math.min(Number(media.duration || Infinity), playhead));
        }
    }, [playhead]);
    // 点击连续播放全部 Clip：先把当前帧跳到 playhead 再播放
    useEffect(() => {
        const media = mediaRef.current;
        if (!media || !playRequest) return;
        if (media.readyState >= 1 && Math.abs(media.currentTime - playhead) > 0.05) {
            media.currentTime = Math.max(0, Math.min(Number(media.duration || Infinity), playhead));
        }
    }, [playRequest, playhead]);
    // 预加载下一个 clip 的视频（只暖缓存，不手动切 DOM；切换统一走 advancePlayback → React 更新 src）
    useEffect(() => {
        if (!nextUrl) { preloadRef.current = null; return; }
        const video = document.createElement("video");
        video.src = nextUrl;
        video.preload = "auto";
        video.muted = true;
        preloadRef.current = video;
    }, [nextUrl]);
    // 支持把输出视频/图片拖到画布变成独立节点（复用 storageKey，不重新上传）
    const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
        const payload = JSON.stringify({ url, type: kind, kind, name: name || "H3 输出", storageKey });
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-infinite-canvas-ref", payload);
        event.dataTransfer.setData("application/json", payload);
        event.dataTransfer.setData("text/plain", payload);
    };
    if (!url) return <div className="minimax-player-content"><div className="minimax-player-empty">连接视频和角色参考图</div></div>;
    if (kind === "image") return <div className="minimax-player-content minimax-player-image" draggable onDragStart={handleDragStart}><img src={url} alt="H3 reference" draggable={false} /></div>;
    if (kind === "audio") return <div className="minimax-player-content" draggable onDragStart={handleDragStart}><div className="minimax-player-empty"><audio ref={(node) => { mediaRef.current = node; }} src={url} controls preload="metadata" draggable={false} /></div></div>;
    return <div className="minimax-player-content"><video ref={(node) => { mediaRef.current = node; }} src={resultUrl(url)} controls muted playsInline draggable={false} onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, Math.min(Number(event.currentTarget.duration || Infinity), playhead)); }} onTimeUpdate={(event) => { const media = event.currentTarget; const nodeNow = (ctx.getNode ? ctx.getNode(ctx.node.id) : ctx.node) || ctx.node; if (Number(nodeNow?.metadata?.h3Scrubbing)) return; const dur = Number(media.duration || 0); const effectiveDur = Number.isFinite(Number(clipDuration)) && Number(clipDuration) > 0 ? Math.min(Number(clipDuration), dur || Number(clipDuration)) : dur; const local = Math.max(0, Math.min(Number(media.currentTime || 0), effectiveDur)); const time = timelineOffset + local; if (Math.abs(time - Number(ctx.node.metadata?.playhead || 0)) > 0.2) ctx.updateMetadata({ playhead: time }); }} /></div>;
}
