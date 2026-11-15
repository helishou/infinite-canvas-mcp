/**
 * 「总流程」的大纲流程：六个阶段按 acheng-director 写作合同拆出来，不是自拟模板。
 *
 * 依据（.agents/skills/acheng-director）：
 * - references/10-scriptwriter-engine.md「输入合同与工作边界」：一次完整剧本交付 = 连贯梗概 + 深度小传 + 场景登记簿 + 完整分场正文，
 *   多线节拍表与弧光表是可追溯的设计附件；一次问清总时长、集数场数、题材、人物、终局约束。
 * - references/10「A/B/C 交织机制」：先写 A 的因果骨架，再让 B 使行动难以选择，最后让 C 改变已知规则。
 * - references/11-story-architecture.md「入口与产物 / 任意数量线路 / 知识与误解 / 伏笔与兑现」：
 *   先锁主题两种可辩护立场、终局必须成立的事件、主角因果权、时间与空间范围，再产出剧情线网络、伏笔/知情表和分集分场正文。
 *
 * 这里的 status 只是「这一轮写到哪一步」的展示口径，不改任何制作真值；真正的完成度仍以源稿字段为准。
 */
import { substepTone, toneStatusKey, type FlowTone } from "./agent-flow-status";
export type OutlineStage = {
    id: string;
    label: string;
    en: string;
    /** 模型在状态/工具说明里提到这些词，就算走到了这一步 */
    keywords: string[];
};

export const OUTLINE_STAGES: OutlineStage[] = [
    { id: "premise", label: "主题与前提", en: "Theme & premise", keywords: ["主题", "前提", "两种立场", "终局", "总时长", "集数", "题材", "受众"] },
    { id: "synopsis", label: "梗概与人物小传", en: "Synopsis & bios", keywords: ["梗概", "故事梗概", "小传", "人物小传", "角色小传"] },
    { id: "threads", label: "剧情线（A/B/C）", en: "Threads (A/B/C)", keywords: ["剧情线", "主线", "暗线", "支线", "A/B/C", "线网"] },
    { id: "beats", label: "节拍表", en: "Beat sheet", keywords: ["节拍", "beat", "节拍表"] },
    { id: "knowledge", label: "知情与伏笔", en: "Knowledge & setups", keywords: ["知情", "伏笔", "兑现", "误信", "知识边界"] },
    { id: "scenes", label: "场景与分场正文", en: "Scenes & script", keywords: ["场景登记", "分场", "场次", "正文", "剧本正文"] },
];

export type OutlineFlowRow = { index: number; label: string; tone: "done" | "running" | "pending"; statusKey: string };

/** 这一轮像是在写大纲/剧本吗？只认这些词，避免把出片、改提示词的对话也挂上大纲流程。 */
export function looksLikeOutlineWork(texts: readonly string[]): boolean {
    const blob = texts.join("\n");
    if (!blob.trim()) return false;
    return /大纲|梗概|小传|剧情线|节拍|伏笔|知情|分场|场次|剧本正文|场记/.test(blob);
}

/**
 * 按「这一轮写到哪一步」给六段打状态：
 * - 文案里出现该阶段关键词、且带完成词（已/完成/写完/写入/保存/生成）→ 已完成；
 * - 只出现关键词、没有完成词（例如「正在补知情与伏笔」）→ 进行中；
 * - 一句都没提到 → 未开始。
 * 不按「后面的阶段命中就当中间的也写完了」推断：那会把没写的阶段标成完成，属于伪造进度。
 * 本轮还在跑但一处进行中都没有时，把第一处未开始标成进行中，让面板有当前步可看。
 */
export function outlineFlowRows(texts: readonly string[], busy: boolean): OutlineFlowRow[] {
    const tones = OUTLINE_STAGES.map((stage) => substepTone(texts, stage.keywords));
    if (busy && !tones.includes("running")) {
        const firstOpen = tones.indexOf("pending");
        if (firstOpen >= 0) tones[firstOpen] = "running";
    }
    return OUTLINE_STAGES.map((stage, order) => ({
        index: order + 1,
        label: stage.label,
        tone: tones[order],
        statusKey: toneStatusKey(tones[order]),
    }));
}

export function outlineStageText(stage: OutlineStage, english: boolean) {
    return english ? stage.en : stage.label;
}

