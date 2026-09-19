import { getReact } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

export const H3_LOCAL_VIEW_DEFAULTS = {
    selectedSegmentId: "",
    playhead: 0,
    h3PlaybackAll: false,
    h3PlayRequest: 0,
    h3Scrubbing: false,
    timelineScrollLeft: 0,
    minimaxOutputFilter: "all",
    minimaxPreviewH: 220,
    minimaxPreviewW: 960,
    minimaxPromptW: 480,
    minimaxTimelineH: 320,
    minimaxRefLaneH: 150,
    nanFengExpandedSections: {},
    h3SigmaPresetName: "",
};

const localKeys = new Set(Object.keys(H3_LOCAL_VIEW_DEFAULTS));

export function splitH3MetadataPatch(patch: Record<string, unknown>) {
    const personal: Record<string, unknown> = {};
    const shared: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) (localKeys.has(key) ? personal : shared)[key] = value;
    return { personal, shared };
}

// 保持现有子组件接口，但明确将视图字段从共享文档中剥离。
export function useH3LocalView(ctx: CanvasNodeContext): CanvasNodeContext {
    const view = ctx.view;
    const local = getReact().useSyncExternalStore(view.subscribe, view.getSnapshot);
    // 取值优先级：本窗口视图状态 > 节点共享 metadata > 新建节点写入首个 segment 的布局快照 > 内置默认值。
    // 中间两层不能省：
    // ① 节点 metadata：新建 H3 节点会把「设为默认参数」保存的布局快照抄进节点；
    // ② segment 快照：布局键属于 H3_LOCAL_VIEW_FIELDS，节点顶层的那份不参与后端同步，
    //    一次往返就被权威数据抹掉（实测），而创建时写进 segment 的同名字段会留下来。
    // 少任一层，默认布局一渲染就被硬编码的 220/960/480/320/150 顶掉，表现成「布局没保存成功」。
    const metadata = (shared: Record<string, unknown>, state: Record<string, unknown>) => {
        const segment = Array.isArray(shared.segments) ? shared.segments[0] as Record<string, unknown> | undefined : undefined;
        return {
            ...shared, ...Object.fromEntries(Object.keys(H3_LOCAL_VIEW_DEFAULTS).map((key) => [key, state[key] ?? shared[key] ?? segment?.[key] ?? H3_LOCAL_VIEW_DEFAULTS[key as keyof typeof H3_LOCAL_VIEW_DEFAULTS]])),
        };
    };
    return {
        ...ctx,
        node: { ...ctx.node, metadata: metadata(ctx.node.metadata || {}, local) },
        getNode: (id) => {
            const node = ctx.getNode(id);
            return node && id === ctx.node.id ? { ...node, metadata: metadata(node.metadata || {}, view.getSnapshot()) } : node;
        },
        updateMetadata: (patch) => {
            const { personal, shared } = splitH3MetadataPatch(patch);
            if (Object.keys(personal).length) view.update(personal);
            if (Object.keys(shared).length) ctx.updateMetadata(shared);
        },
    };
}
