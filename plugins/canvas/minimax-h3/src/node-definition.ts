import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { defaultH3Model, defaultPrompt } from "./constants";
import { H3ContentExact } from "./components/H3Workbench";

export const h3NodeDefinition = {
    type: "minimax-h3:video",
    legacyTypes: ["smart-minimax", "minimax"],
    title: "南风 H3 V10",
    icon: "✦",
    description: "南风 H3 V10 视频生成与人物替换节点",
    defaultSize: { width: 980, height: 720 },
    defaultMetadata: {
        content: "", prompt: defaultPrompt, status: "idle" as const, duration: "8", aspectRatio: "16:9",
        videoSteps: 8, denoise: 0.65, modelName: defaultH3Model, minimaxBaseModel: defaultH3Model,
        motionContextEnabled: true, motionContextNoiseEnabled: false, smartStoryboardCount: 3, smartStoryboardMode: "ref2va", smartStoryboardSkill: "regular_storyboard",
        segments: [{ id: "segment-1", prompt: defaultPrompt, duration: 8, taskMode: "ref2va", status: "idle" }],
    },
    minimapColor: "#f97316",
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
