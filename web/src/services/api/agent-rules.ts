import { fetchAgentJson } from "./canvas-agent";

export const RULE_CATEGORIES = ["general", "script", "storyboard", "prompt", "asset", "continuity", "video", "render"] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULE_CATEGORY_LABELS: Record<RuleCategory, string> = {
    general: "通用",
    script: "剧本",
    storyboard: "分镜",
    prompt: "提示词",
    asset: "资产与参考图",
    continuity: "连续性",
    video: "视频生成",
    render: "剪辑与合成",
};

/** 每类规则落到哪个制作环节，页面按这张表说明生效范围，不另写一套文案。 */
export const RULE_CATEGORY_TARGETS: Record<RuleCategory, string> = {
    general: "所有文本生成环节",
    script: "剧本与分场规划",
    storyboard: "拆镜与镜头设计",
    prompt: "视频提示词撰写",
    asset: "资产提取与参考图生成",
    continuity: "拆镜与提示词中的跨镜承接",
    video: "视频提示词中的生成约束",
    render: "剪辑合成环节（记为约束，不自动改参数）",
};

export type LearnedRule = {
    id: string;
    title: string;
    statement: string;
    detail?: string;
    category: RuleCategory;
    evidence?: string;
    enabled: boolean;
    reviewed: boolean;
    createdAt: string;
    updatedAt: string;
    sourceThreadId?: string;
};

export type LearnedRulesState = {
    version: number;
    autoLearn: boolean;
    rules: LearnedRule[];
};

export type LearnedRulePatch = {
    title?: string;
    statement?: string;
    detail?: string;
    category?: RuleCategory;
    evidence?: string;
};

function jsonPost(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function fetchLearnedRules(endpoint: string, token: string) {
    return fetchAgentJson<{ ok?: boolean; data?: LearnedRulesState }>(endpoint, token, "/rules");
}

export function setRulesAutoLearn(endpoint: string, token: string, autoLearn: boolean) {
    return fetchAgentJson<{ ok?: boolean; data?: { autoLearn: boolean } }>(endpoint, token, "/rules/settings", jsonPost({ autoLearn }));
}

export function reviewLearnedRule(endpoint: string, token: string, id: string, action: "accept" | "ignore") {
    return fetchAgentJson<{ ok?: boolean; data?: LearnedRule }>(endpoint, token, `/rules/${encodeURIComponent(id)}/review`, jsonPost({ action }));
}

export function setLearnedRuleEnabled(endpoint: string, token: string, id: string, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean; data?: LearnedRule }>(endpoint, token, `/rules/${encodeURIComponent(id)}/enabled`, jsonPost({ enabled }));
}

export function updateLearnedRule(endpoint: string, token: string, id: string, patch: LearnedRulePatch) {
    return fetchAgentJson<{ ok?: boolean; data?: LearnedRule }>(endpoint, token, `/rules/${encodeURIComponent(id)}`, jsonPost(patch));
}

export function deleteLearnedRule(endpoint: string, token: string, id: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
}
