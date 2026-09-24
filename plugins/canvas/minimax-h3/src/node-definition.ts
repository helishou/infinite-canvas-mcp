import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { createH3NodeMetadata } from "../../../../canvas-agent/src/plugins/minimax-h3/node-factory";
import { H3ContentExact } from "./components/H3Workbench";
import { readDefaultLayout, readDefaultParams } from "./services/h3-defaults";

export const h3NodeDefinition = {
    type: "minimax-h3:video",
    legacyTypes: ["smart-minimax", "minimax", "minimax-h3"],
    title: "H3导演台",
    icon: "✦",
    description: "H3导演台 视频生成与人物替换节点",
    defaultSize: { width: 1960, height: 1080 },
    get defaultMetadata() {
        const stored = readDefaultParams();
        // 布局快照（节点宽高不影响初始参数）：各模块区域宽高写入初始 segment，
        // 工作台按 metadata 的 minimax* 键渲染，恢复与保存同一套键。
        const layout = readDefaultLayout();
        return createH3NodeMetadata(stored, {}, layout.panes || {});
    },
    get defaultLayoutSize() {
        const layout = readDefaultLayout();
        return { width: layout.width, height: layout.height };
    },
    minimapColor: "#f97316",
    hidePanel: true,
    Content: H3ContentExact,
    resource: (node: { metadata?: Record<string, unknown> }) => {
        const metadata = node.metadata || {};
        const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
        const clips = segments.flatMap((item, index) => {
            if (!item || typeof item !== "object") return [];
            const segment = item as Record<string, unknown>;
            const result = typeof segment.result === "string" && segment.result ? segment.result : Array.isArray(segment.results) ? String((segment.results[0] as Record<string, unknown> | undefined)?.url || "") : "";
            return result ? [{ kind: "video" as const, url: result, storageKey: typeof segment.resultStorageKey === "string" ? segment.resultStorageKey : undefined, text: `Clip ${index + 1}` }] : [];
        });
        if (clips.length) return clips;
        const content = metadata.content;
        return typeof content === "string" && content ? { kind: "video" as const, url: content, storageKey: typeof metadata.storageKey === "string" ? metadata.storageKey : undefined } : null;
    },
    toolbar: (ctx: CanvasNodeContext) => [
        { id: "h3-clear", title: "清空 H3 输出", label: "清空", icon: "×", onClick: () => ctx.updateMetadata({ content: "", status: "idle", errorDetails: "" }) },
    ],
};
