import type { DramaTopic } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 选题卡与步骤条的纯逻辑：选项表、多选规则、完成判定。
 * 不含 React，方便直接跑 node:test。
 */

export const TOPIC_OPTIONS = {
    themes: ["霸道总裁", "甜宠", "复仇", "穿越", "重生", "悬疑", "宫斗", "都市", "玄幻", "末日", "校园", "职场", "古装言情"],
    gender: ["不限", "女性", "男性"],
    age: ["全龄", "幼儿", "儿童", "少年", "青年", "中年", "老年"],
    tones: ["甜", "虐", "甜虐", "爽", "燃", "搞笑", "暗黑", "温情"],
    ending: ["HE 好结局", "BE 坏结局", "OE 开放结局"],
    language: ["中文", "English"],
    artStyle: ["日系赛璐璐", "日系半厚涂", "新海诚", "吉卜力", "韩漫", "韩系唯美", "国风水墨", "新国风", "古风工笔", "国潮", "3D国漫", "半写实厚涂"],
    episodePresets: [1, 10, 30, 60, 80, 100],
    minutePresets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
} as const;

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
    episodesWithSynopsis: number;
    episodesWithScript: number;
    assetCount: number;
    episodeCanvasCount: number;
}): PlanningStepState[] {
    const done: Record<PlanningStepKey, boolean> = {
        topic: (input.topic.themes?.length || 0) > 0 || Boolean(String(input.topic.theme || "").trim()),
        outline: Boolean(String(input.outline || "").trim()) && Boolean(String(input.worldContext || "").trim()),
        script: input.episodeCount > 0 && input.episodesWithScript >= input.episodeCount,
        assets: input.assetCount > 0,
        shots: input.episodeCanvasCount > 0,
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
