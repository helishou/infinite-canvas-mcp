import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { defaultH3Model, defaultPrompt } from "./constants";
import { H3ContentExact } from "./components/H3Workbench";

export const h3NodeDefinition = {
    type: "minimax-h3:video",
    legacyTypes: ["smart-minimax", "minimax"],
    title: "MiniMax H3",
    icon: "✦",
    description: "H3 视频生成与人物替换节点",
    defaultSize: { width: 980, height: 720 },
    defaultMetadata: {
        content: "", prompt: defaultPrompt, status: "idle", duration: "8", aspectRatio: "16:9",
        videoSteps: 8, denoise: 0.65, modelName: defaultH3Model, minimaxBaseModel: defaultH3Model,
        motionContextEnabled: true, motionContextNoiseEnabled: false, smartStoryboardCount: 3, smartStoryboardMode: "ref2va", smartStoryboardSkill: "regular_storyboard",
        segments: [{ id: "segment-1", prompt: defaultPrompt, duration: 8, taskMode: "r2v", status: "idle" }],
    },
    minimapColor: "#f97316",
    Content: H3ContentExact,
    resource: (node: { metadata?: Record<string, unknown> }) => {
        const content = node.metadata?.content;
        return typeof content === "string" && content ? { kind: "video" as const, url: content } : null;
    },
    toolbar: (ctx: CanvasNodeContext) => [
        { id: "h3-clear", title: "清空 H3 输出", label: "清空", icon: "×", onClick: () => ctx.updateMetadata({ content: "", status: "idle", errorDetails: "" }) },
    ],
};
