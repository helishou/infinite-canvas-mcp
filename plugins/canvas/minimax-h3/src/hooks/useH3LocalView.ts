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
    const metadata = (shared: Record<string, unknown>, state: Record<string, unknown>) => ({
        ...shared, ...H3_LOCAL_VIEW_DEFAULTS, ...Object.fromEntries(Object.keys(H3_LOCAL_VIEW_DEFAULTS).map((key) => [key, state[key] ?? H3_LOCAL_VIEW_DEFAULTS[key as keyof typeof H3_LOCAL_VIEW_DEFAULTS]])),
    });
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
