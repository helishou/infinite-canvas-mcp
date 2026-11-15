import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 大纲引导的纯逻辑：顺序、完成判定、候选文本解析。
 * 与界面分开，方便直接跑 node:test；不引入 React / antd / i18n。
 */
export const OUTLINE_WIZARD_STEPS = ["episodes", "characters", "worldContext", "storyline", "threeActs", "ending"] as const;
export type OutlineWizardStep = (typeof OUTLINE_WIZARD_STEPS)[number];

export type OutlineStepState = { key: OutlineWizardStep; labelKey: string; done: boolean };

/** 六步的完成状态全部由已存字段推导，不另存进度。 */
export function outlineStepStates(input: { plan: Partial<DramaProductionPlan>; outline: string; episodeCount: number; registryCharacters: number }): OutlineStepState[] {
    const detail = input.plan.outlineDetail;
    const done: Record<OutlineWizardStep, boolean> = {
        episodes: input.episodeCount > 0,
        characters: (detail?.characters?.length || 0) > 0 || input.registryCharacters > 0,
        worldContext: Boolean(String(detail?.worldContext || "").trim()),
        storyline: Boolean(String(input.outline || "").trim()),
        threeActs: (detail?.threeActs || []).filter((act) => String(act || "").trim()).length >= 3,
        ending: Boolean(String(detail?.ending || "").trim()),
    };
    return OUTLINE_WIZARD_STEPS.map((key) => ({ key, labelKey: `outlineWizard.step.${key}`, done: done[key] }));
}

/** 当前该做的那一步：第一个没完成的；全做完返回 null。 */
export function firstPendingStep(states: OutlineStepState[]): OutlineWizardStep | null {
    return states.find((state) => !state.done)?.key ?? null;
}

/** 后面的步骤是否锁住：按顺序引导，前一步没写入就不让往下走。 */
export function stepLocked(states: OutlineStepState[], step: OutlineWizardStep): boolean {
    const current = firstPendingStep(states);
    if (!current) return false;
    return OUTLINE_WIZARD_STEPS.indexOf(step) > OUTLINE_WIZARD_STEPS.indexOf(current);
}

/** 把一步的返回文本拆成条目：分集与角色按行拆，其余整段用。 */
export function proposalLines(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*·]\s*/, ""))
        .filter(Boolean);
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「第3集」「第三集」「第十二集」都认；认不出就按行号兜底。 */
export function parseChineseNumber(value: string): number {
    const text = String(value || "").trim().replace(/两/g, "二");
    if (/^\d+$/.test(text)) return Number(text);
    const tenIndex = text.indexOf("十");
    if (tenIndex < 0) return CN_DIGITS[text] ?? Number.NaN;
    const tens = tenIndex === 0 ? 1 : CN_DIGITS[text.slice(0, tenIndex)] ?? Number.NaN;
    const onesText = text.slice(tenIndex + 1);
    const ones = onesText ? CN_DIGITS[onesText] ?? Number.NaN : 0;
    return tens * 10 + ones;
}

/** 「第3集｜雪夜客栈｜沈云入府」→ 结构化；解析不出来的行保留原文当简介。 */
export function parseEpisodeLines(text: string) {
    return proposalLines(text).map((line, index) => {
        const parts = line.split(/[｜|]/).map((part) => part.trim()).filter(Boolean);
        const numberMatch = /第\s*([0-9]+|[零一二三四五六七八九十两]+)\s*[集话]/.exec(parts[0] || "");
        const parsed = numberMatch ? parseChineseNumber(numberMatch[1]) : Number.NaN;
        const number = Number.isFinite(parsed) ? parsed : index + 1;
        const rest = numberMatch ? parts.slice(1) : parts;
        return { episodeNumber: number, title: String(rest[0] || "").replace(/^[「『"]|[」』"]$/g, ""), synopsis: rest.slice(1).join("｜") };
    });
}

/** 三幕：行首「第一幕｜」这类前缀去掉，只留正文。 */
export function parseActLines(text: string) {
    return proposalLines(text).slice(0, 3).map((line) => line.split(/[｜|]/).slice(1).join("｜").trim() || line);
}

export function buildStepInstruction(mode: "rewrite" | "fill", depth: "brief" | "standard" | "detailed", extra: string) {
    const modeText = mode === "rewrite" ? "按原剧本重写这一步，可以覆盖现有内容" : "只在现有内容上补全缺失部分，保留已有的事实与措辞";
    const depthText = depth === "brief" ? "偏精简，宁可短也不凑字" : depth === "detailed" ? "写详细一些，把因果、动机和空间交代清楚" : "按标准详略写";
    return [modeText, depthText, extra.trim()].filter(Boolean).join("；");
}
