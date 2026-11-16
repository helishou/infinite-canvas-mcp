export type PlanningLaunchScope = "source" | "topic" | "outline" | "script";

const SCOPE_TASK: Record<PlanningLaunchScope, string> = {
    source: "把「原剧本」这一步做完：读现存内容，缺正文就先问我要原文，别自己编；有正文就核对接下来的选题和大纲是否跟它对得上。",
    topic: "把「选题」这一步做完：题材、受众、调性、集数、每集时长、画风、结局、语言都按原剧本填成可直接确认的卡，缺依据的先说明推断来源。",
    outline: "把「大纲」这一步做完：先写全剧故事线，再补时空背景、角色名单、三幕与节奏、结局和卡点；只依据原剧本和已有选题，不新造设定。",
    script: "把「剧本」这一步做完：按集号顺序，一集一场一行写出分场纪要，上一集收尾接下一集开场；只写还没写的集。",
};

/**
 * 「交给导演」的提示词：只给目标和边界，具体怎么读怎么写由 agent 依据
 * instructions/drama-planning.md 的合同决定，网页这边不预设步骤细节。
 */
export function planningPrompt(scope: PlanningLaunchScope, input: { dramaId: string; name: string; pendingEpisodes?: number[] }) {
    const head = `【剧目策划】剧目「${input.name}」（dramaId=${input.dramaId}）`;
    const pending = input.pendingEpisodes?.length ? `；还没写剧本的集号：${input.pendingEpisodes.join("、")}` : "";
    return `${head}${pending}。${SCOPE_TASK[scope]}先调用 drama_set_active_project（dramaId=${input.dramaId}）把当前剧目钉住，或每次调用 drama_* 工具都显式传 dramaId；不传会报 PROJECT_SELECTION_REQUIRED（那不是断线）。之后读 drama_get_planning 拿真值和完成度，写的时候用 drama_update_planning（剧本用 drama_update_episode 写 fullPlot），不要只把内容留在对话里，也不要写占位稿。完成后一句话回执：改了哪一步、写进哪个字段、还剩什么。`;
}
