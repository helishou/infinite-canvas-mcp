import type { DramaTopic } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 选题卡与步骤条的纯逻辑：选项表、多选规则、完成判定。
 * 不含 React，方便直接跑 node:test。
 */

/** 选项表与默认值的唯一真值在 canvas-agent（后端自动填写也读它）；这里只做转出。 */
import { TOPIC_OPTIONS } from "@basketikun/canvas-agent/drama/topic-options";

export { TOPIC_OPTIONS };
export { TOPIC_DEFAULTS } from "@basketikun/canvas-agent/drama/topic-options";

/** 「模型决定」不是空字符串的语义占位：时长 0 = 由模型按原文剧情决定（导演大师也是这么存）。 */
export function episodeDurationLabel(minutes: number): string {
    return minutes > 0 ? `${minutes} 分钟` : "模型决定";
}

/** 题材最多两个；再点已选中的取消。 */
export function toggleThemes(current: readonly string[], value: string): string[] {
    if (current.includes(value)) return current.filter((item) => item !== value);
    if (current.length >= 2) return [...current.slice(1), value];
    return [...current, value];
}

export function toggleValue(current: readonly string[], value: string): string[] {
    return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

/** 旧版把题材/受众存成一段文字；读的时候把它当第一个选项，避免老数据看不见。 */
export function topicFromLegacy(topic: DramaTopic): DramaTopic {
    const themes = topic.themes?.length ? topic.themes : (topic.theme ? [topic.theme] : []);
    const gender = topic.gender || (topic.audience ? topic.audience : "");
    return { ...topic, themes, gender };
}

export type PlanningStepKey = "topic" | "outline" | "script" | "assets" | "shots" | "package";
export const PLANNING_STEPS: PlanningStepKey[] = ["topic", "outline", "script", "assets", "shots", "package"];

export type PlanningStepState = { key: PlanningStepKey; labelKey: string; done: boolean; target: "tab" | "episode" };

/**
 * 步骤条只报能派生的完成度：
 * 选题/大纲/剧本/资产 都从剧目级字段算；分镜与导演包在分集制作里，只做入口不猜状态。
 */
export function planningStepStates(input: {
    topic: DramaTopic;
    outline: string;
    worldContext: string;
    episodeCount: number;
    episodesWithScript: number;
    assetCount: number;
}): PlanningStepState[] {
    const done: Record<PlanningStepKey, boolean> = {
        topic: (input.topic.themes?.length || 0) > 0 || Boolean(String(input.topic.theme || "").trim()),
        outline: Boolean(String(input.outline || "").trim()) && Boolean(String(input.worldContext || "").trim()),
        script: input.episodeCount > 0 && input.episodesWithScript >= input.episodeCount,
        assets: input.assetCount > 0,
        // 分镜与导演包在分集制作里，剧目级拿不到真实镜头数；
        // 这里只当入口，不能拿「有分集画布」冒充分镜已完成（建集就带画布，会永远假绿）。
        shots: false,
        package: false,
    };
    return PLANNING_STEPS.map((key) => ({
        key,
        labelKey: `planningSteps.${key}`,
        done: done[key],
        target: key === "shots" || key === "package" ? "episode" : "tab",
    }));
}

/** 下一步：第一个没完成的步骤；全完成返回 null。 */
export function nextPlanningStep(states: readonly PlanningStepState[]) {
    return states.find((state) => !state.done)?.key ?? null;
}

/** 画风没选时，用它把已存在的老值补进选项，避免选中态丢失。 */
export function artStyleOptions(current: string) {
    const options: string[] = [...TOPIC_OPTIONS.artStyle];
    return current && !options.includes(current) ? [...options, current] : options;
}
