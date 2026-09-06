import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { defaultH3Model, defaultPrompt } from "./constants";
import { H3ContentExact } from "./components/H3Workbench";
import { readDefaultParams } from "./services/h3-defaults";

// 「设为默认参数」可持久化的节点级参数键：这些键同时存在于节点根与初始 segment，
// 故既合并进根也合并进初始 segment，保证新建节点根/段一致。duration/status 等
// 易产生 string/number 类型歧义或属于运行态的键不在此列，仅由初始 segment 继承。
const NODE_LEVEL_PARAM_KEYS = [
    "aspectRatio", "videoSteps", "denoise", "modelName", "minimaxBaseModel",
    "motionContextEnabled", "motionContextNoiseEnabled",
    "smartStoryboardCount", "smartStoryboardMode", "smartStoryboardSkill",
];

// 内置基础默认（无持久化默认时的回退）。defaultMetadata 用 getter 在每次新建节点时读取
// localStorage 中的「永久默认参数」，与基础默认合并，使新建 H3 节点自动携带用户设定。
const BASE_DEFAULT_METADATA = {
    content: "", prompt: defaultPrompt, status: "idle" as const, duration: "8", aspectRatio: "16:9",
    videoSteps: 8, denoise: 1, modelName: defaultH3Model, minimaxBaseModel: defaultH3Model,
    motionContextEnabled: true, motionContextNoiseEnabled: false, smartStoryboardCount: 3, smartStoryboardMode: "ref2va", smartStoryboardSkill: "regular_storyboard",
    textEncoder: "qwen3vl_32b_minimax_h3_fp8.safetensors",
    videoVae: "minimax_h3_video_vae_fp16.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
    sageAttention: "H3专用Sage加速",
    segments: [{ id: "segment-1", prompt: defaultPrompt, duration: 8, taskMode: "ref2va", status: "idle",
        textEncoder: "qwen3vl_32b_minimax_h3_fp8.safetensors",
        videoVae: "minimax_h3_video_vae_fp16.safetensors",
        audioVae: "minimax_h3_audio_vae_fp32.safetensors",
        sageAttention: "H3专用Sage加速",
    }],
};

export const h3NodeDefinition = {
    type: "minimax-h3:video",
    legacyTypes: ["smart-minimax", "minimax"],
    title: "H3导演台",
    icon: "✦",
    description: "H3导演台 视频生成与人物替换节点",
    defaultSize: { width: 1960, height: 1080 },
    get defaultMetadata() {
        const stored = readDefaultParams();
        const nodeLevel = Object.fromEntries(NODE_LEVEL_PARAM_KEYS.filter((key) => key in stored).map((key) => [key, stored[key]]));
        const initialSegment = { ...BASE_DEFAULT_METADATA.segments[0], ...stored };
        return { ...BASE_DEFAULT_METADATA, ...nodeLevel, segments: [initialSegment] };
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
