import type { Stores } from "../stores/types.js";
import { requestOpenAiText, resolveTextProvider } from "../canvas/text-dispatcher.js";
import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 剧目大纲的六步生成：一步一次调用，产出可直接落进 productionPlan 的纯文本。
 *
 * 步骤顺序与画布「大纲」分区的六段一致，也与 canvas-video-production-sop 的
 * references/production-stage-order.md 里 ①剧情设计 的判据对齐：
 * 分集目录 → 角色 → 时空背景 → 故事线 → 三幕和节奏 → 结局与卡点。
 *
 * 这里只产出文本；写入哪一段、要不要覆盖，由前端确认框决定，后端不改任何真值。
 */
export const dramaOutlineSteps = ["episodes", "characters", "worldContext", "storyline", "threeActs", "ending"] as const;
export type DramaOutlineStep = (typeof dramaOutlineSteps)[number];

type StepSpec = { title: string; goal: string; shape: string; context: (plan: Partial<DramaProductionPlan>, outline: string) => string };

const SOURCE_LIMIT = 12000;

/** 原剧本过长时保留头尾：开头给设定，结尾给终局，避免把上下文挤爆。 */
export function trimSource(source: string, limit = SOURCE_LIMIT) {
    const text = String(source || "").trim();
    if (text.length <= limit) return text;
    const head = text.slice(0, Math.floor(limit * 0.7));
    const tail = text.slice(-Math.floor(limit * 0.25));
    return `${head}\n\n……（中间省略 ${text.length - head.length - tail.length} 字）……\n\n${tail}`;
}

const STEP_SPECS: Record<DramaOutlineStep, StepSpec> = {
    episodes: {
        title: "分集目录",
        goal: "把原剧本按短剧节奏拆成整集：每集有独立钩子、结尾留卡点，集与集之间因果相扣，不把一场戏劈成两集。",
        shape: "每行一集，格式：第N集｜标题（不超过 12 字）｜一句话简介（不超过 40 字，写清本集谁做了什么、卡在哪）",
        context: () => "",
    },
    characters: {
        title: "角色",
        goal: "只列原剧本里真正推动剧情的角色；每个角色写出他在故事里的功能与内在矛盾，不写外貌。",
        shape: "每行一个角色，格式：姓名｜定位（主角/对手/帮手…）｜欲望（他要什么）｜需要（他其实缺什么）｜误信（他错在哪）｜最后代价",
        context: () => "",
    },
    worldContext: {
        title: "时空背景",
        goal: "定下时代、地域、主要空间与这个世界独有的规则或限制；只写会影响画面和行动的事实。",
        shape: "纯文本，两到四句话：时代 / 地域 / 主要空间 / 规则限制",
        context: (plan) => plan.topic?.theme ? `已定选题：${plan.topic.theme}` : "",
    },
    storyline: {
        title: "故事线",
        goal: "写全剧故事线：A 主线给出因果骨架，B 关系线让主角的选择变难，C 世界暗线改变已知规则；三线在关键节点交汇。",
        shape: "纯文本，一段到底也可以，但必须能看出 A/B/C 三条线各自推进与交汇点",
        context: (plan, outline) => outline ? `当前已有故事线（可在其基础上改写）：\n${outline}` : "",
    },
    threeActs: {
        title: "三幕和节奏",
        goal: "把全剧分成三幕并标出节奏：第一幕建置与失控，第二幕对抗与代价升级，第三幕决断与终局。",
        shape: "恰好三行，每行格式：第一幕｜…… 第二幕｜…… 第三幕｜……（每行不超过 120 字）",
        context: (plan, outline) => outline ? `故事线：\n${outline}` : "",
    },
    ending: {
        title: "结局与卡点",
        goal: "写终局必须发生的那件事，以及每集卡点停在哪里；结局要兑现前面的伏笔，不靠旁白解释。",
        shape: "纯文本：“终局：……”一句，“卡点规则：……”一到两句",
        context: (plan, outline) => [
            outline ? `故事线：\n${outline}` : "",
            plan.outlineDetail?.threeActs?.length ? `三幕：${plan.outlineDetail.threeActs.filter(Boolean).join(" / ")}` : "",
        ].filter(Boolean).join("\n\n"),
    },
};

export function dramaOutlineStepSpec(step: DramaOutlineStep) {
    return STEP_SPECS[step];
}

const SYSTEM_PROMPT = [
    "你是短剧编剧，负责把原剧本提炼成可执行的大纲。",
    "只输出要求的内容本身：不要客套话、不要解释你的思路、不要 Markdown 标题、不要重复题目。",
    "人物、地点、事件必须来自原剧本或已定选题，不得新增原作没有的设定；信息不足时按最保守的写法留白，不要编造。",
    "全部用中文。",
].join("\n");

export function buildOutlinePrompt(input: { step: DramaOutlineStep; source: string; plan: Partial<DramaProductionPlan>; outline: string; name?: string; instruction?: string }) {
    const spec = STEP_SPECS[input.step];
    const parts = [
        `本步任务：${spec.title}`,
        `目标：${spec.goal}`,
        `输出格式：${spec.shape}`,
    ];
    // 每一步都带上剧名、已有大纲和已定选段：老剧目常常没有原剧本，只能靠这些事实。
    const common = [
        input.name ? `剧目：${input.name}` : "",
        input.outline ? `现有大纲/故事线：\n${input.outline}` : "",
        input.plan.topic?.theme ? `选题：${input.plan.topic.theme}${input.plan.topic.logline ? `｜${input.plan.topic.logline}` : ""}` : "",
        input.plan.outlineDetail?.worldContext ? `已写时空背景：${input.plan.outlineDetail.worldContext}` : "",
        input.plan.outlineDetail?.threeActs?.filter(Boolean).length ? `已写三幕：${input.plan.outlineDetail.threeActs.filter(Boolean).join(" / ")}` : "",
        input.plan.outlineDetail?.ending ? `已写结局与卡点：${input.plan.outlineDetail.ending}` : "",
    ].filter(Boolean).join("\n");
    if (common) parts.push(`已知信息：\n${common}`);
    const context = spec.context(input.plan, input.outline);
    if (context) parts.push(`本步补充：\n${context}`);
    if (input.instruction?.trim()) parts.push(`用户补充要求：${input.instruction.trim()}`);
    const source = trimSource(input.source);
    parts.push(source ? `原剧本：\n${source}` : "原剧本：尚未提供（按已知信息尽力完成，缺的留给用户补）");
    return parts.join("\n\n");
}

export function resolveOutlineModel(aiConfig: unknown, override?: string) {
    const config = aiConfig && typeof aiConfig === "object" && !Array.isArray(aiConfig) ? aiConfig as Record<string, unknown> : {};
    return String(override || config.textModel || config.model || "").trim();
}

export async function proposeDramaOutlineStep(
    stores: Pick<Stores, "settings">,
    input: { step: DramaOutlineStep; source: string; plan: Partial<DramaProductionPlan>; outline: string; name?: string; model?: string; instruction?: string; signal?: AbortSignal },
) {
    const aiConfig = stores.settings.get("ai.config");
    const model = resolveOutlineModel(aiConfig, input.model);
    if (!model) throw new Error("请先在设置里为「文本模型」选择一个模型，或在剧目录制里指定大纲模型");
    // 没有原剧本也没有大纲时，模型只能编出「待补」；与其产出废稿，不如先让人把输入补上。
    if (!trimSource(input.source) && !String(input.outline || "").trim()) throw new Error("先把「原剧本」或「故事大纲」填上，再来生成这一步");
    const provider = resolveTextProvider(aiConfig, model, { systemPrompt: SYSTEM_PROMPT, reasoningEffort: "auto" });
    const raw = await requestOpenAiText(provider, buildOutlinePrompt(input), [], input.signal);
    const text = String(raw || "").replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
    if (!text) throw new Error("模型返回了空内容");
    return { text, model };
}

const EPISODE_SYSTEM_PROMPT = [
    "你是短剧编剧，负责把全剧大纲落成单集的剧本大纲（分场）。",
    "只输出场次行本身：不要客套话、不要解释思路、不要 Markdown 标题、不要写对白和镜头。",
    "人物、地点、事件必须来自已定的全剧大纲、原剧本或本集简介，不得新增设定；信息不足就少写几场，不要编。",
    "全部用中文。",
].join("\n");

/**
 * 单集剧本大纲：一场一行，格式与制作稿的场次口径一致（场次｜内外·地点｜日/夜｜人物｜事件）。
 * previousTail 传上一集的最后一场，保证集间承接不跳。
 */
export function buildEpisodeScriptPrompt(input: {
    episodeNumber: number;
    title: string;
    synopsis: string;
    outline: string;
    worldContext?: string;
    threeActs?: readonly string[];
    ending?: string;
    source: string;
    previousTail?: string;
    instruction?: string;
}) {
    const parts = [
        `本集任务：第 ${input.episodeNumber} 集${input.title ? `《${input.title}》` : ""}的剧本大纲（分场）`,
        "输出格式：每行一场 —— 场N｜内景/外景·地点｜日/夜｜出场人物｜这一场发生什么（一句因果，写清本场钩子）",
    ];
    if (input.synopsis.trim()) parts.push(`本集简介：${input.synopsis.trim()}`);
    if (input.outline.trim()) parts.push(`全剧故事线：\n${input.outline.trim()}`);
    if (input.worldContext?.trim()) parts.push(`时空背景：${input.worldContext.trim()}`);
    if (input.threeActs?.filter(Boolean).length) parts.push(`三幕：${input.threeActs.filter(Boolean).join(" / ")}`);
    if (input.ending?.trim()) parts.push(`结局与卡点：${input.ending.trim()}`);
    if (input.previousTail?.trim()) parts.push(`上一集最后一场（用于承接）：\n${input.previousTail.trim()}`);
    if (input.instruction?.trim()) parts.push(`用户补充要求：${input.instruction.trim()}`);
    const source = trimSource(input.source);
    parts.push(source ? `原剧本：\n${source}` : "原剧本：尚未提供（按上面的已知信息完成）");
    return parts.join("\n\n");
}

export async function proposeEpisodeScript(
    stores: Pick<Stores, "settings">,
    input: { episodeNumber: number; title: string; synopsis: string; outline: string; worldContext?: string; threeActs?: readonly string[]; ending?: string; source: string; previousTail?: string; model?: string; instruction?: string; signal?: AbortSignal },
) {
    const aiConfig = stores.settings.get("ai.config");
    const model = resolveOutlineModel(aiConfig, input.model);
    if (!model) throw new Error("请先在设置里为「文本模型」选择一个模型，或在剧目规划里指定大纲模型");
    if (!input.synopsis.trim() && !input.outline.trim() && !trimSource(input.source)) throw new Error("先写好本集简介或全剧大纲，再来生成分场");
    const provider = resolveTextProvider(aiConfig, model, { systemPrompt: EPISODE_SYSTEM_PROMPT, reasoningEffort: "auto" });
    const raw = await requestOpenAiText(provider, buildEpisodeScriptPrompt(input), [], input.signal);
    const text = String(raw || "").replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
    if (!text) throw new Error("模型返回了空内容");
    return { text, model };
}
