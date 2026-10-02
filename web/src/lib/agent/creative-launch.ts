import type { AgentCreativeLaunch } from "@/stores/use-agent-store";

export const CANVAS_CREATIVE_SKILL_NAME = "canvas-video-production-sop";

export function creativeLaunchPrompt(launch: Pick<AgentCreativeLaunch, "mode" | "text">) {
    const kind = launch.mode === "drama" ? "剧目创作" : "资产创作";
    return `【画布主页创意入口：${kind}】\n请按 canvas-video-production-sop 与当前用户意图开展对话。信息不足时先澄清关键创作决定；创建对象后回读实际 ID。只有用户明确要求生成图片或视频时才提交媒体生成任务。\n\n用户的创意：\n${launch.text}`;
}
