import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureSiteWorkspace, loadConfig } from "../config.js";

/** 规则类别决定它落到哪条链路；general 全程携带，其余只进同名环节。 */
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
    version: 1;
    autoLearn: boolean;
    rules: LearnedRule[];
};

export type RuleCandidate = {
    title: string;
    statement: string;
    detail?: string;
    category: RuleCategory;
    evidence?: string;
};

const MAX_RULES = 200;
const MAX_CONTEXT_CHARS = 6000;
const MAX_CONTEXT_RULES = 30;
const MAX_TITLE_CHARS = 60;
const MAX_STATEMENT_CHARS = 400;
const MAX_DETAIL_CHARS = 800;

const sensitivePattern = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})|\b(?:api[_ -]?key|token|secret|password|authorization|credential)\s*[:=：]\s*\S{8,}|[A-Za-z]:\\[^\s]+|\bhttps?:\/\/[^\s]+/i;

let writeQueue: Promise<unknown> = Promise.resolve();

export function learnedRulesPath() {
    const workspace = ensureSiteWorkspace(loadConfig());
    return path.join(workspace.workspacePath, ".canvas-agent", "learned-rules.json");
}

function emptyState(): LearnedRulesState {
    return { version: 1, autoLearn: true, rules: [] };
}

export async function readLearnedRules(): Promise<LearnedRulesState> {
    await writeQueue.catch(() => undefined);
    let raw: string;
    try {
        raw = await fs.promises.readFile(learnedRulesPath(), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw error;
    }
    try {
        const value = JSON.parse(raw) as Partial<LearnedRulesState>;
        if (!value || value.version !== 1 || !Array.isArray(value.rules)) return emptyState();
        return {
            version: 1,
            autoLearn: value.autoLearn !== false,
            rules: value.rules.filter(isLearnedRule),
        };
    } catch {
        return emptyState();
    }
}

function isLearnedRule(value: unknown): value is LearnedRule {
    if (!value || typeof value !== "object") return false;
    const rule = value as Partial<LearnedRule>;
    return typeof rule.id === "string" && typeof rule.title === "string" && typeof rule.statement === "string"
        && typeof rule.category === "string" && RULE_CATEGORIES.includes(rule.category as RuleCategory)
        && typeof rule.enabled === "boolean" && typeof rule.reviewed === "boolean";
}

async function writeState(state: LearnedRulesState) {
    const file = learnedRulesPath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporary, file);
}

/** 所有写操作走同一队列，避免自动提取与规则页开关互相覆盖。 */
function mutate<T>(operation: (state: LearnedRulesState) => Promise<T> | T): Promise<T> {
    const result = writeQueue.catch(() => undefined).then(async () => {
        const state = await readLearnedRulesUnlocked();
        const outcome = await operation(state);
        await writeState(state);
        return outcome;
    });
    writeQueue = result.catch(() => undefined);
    return result;
}

async function readLearnedRulesUnlocked(): Promise<LearnedRulesState> {
    try {
        const raw = await fs.promises.readFile(learnedRulesPath(), "utf8");
        const value = JSON.parse(raw) as Partial<LearnedRulesState>;
        if (value && value.version === 1 && Array.isArray(value.rules)) {
            return { version: 1, autoLearn: value.autoLearn !== false, rules: value.rules.filter(isLearnedRule) };
        }
    } catch { /* 不存在或损坏都从空状态重建 */ }
    return emptyState();
}

export function normalizeRuleText(value: string) {
    return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").trim();
}

function cleanTextField(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function validateCategory(value: unknown): RuleCategory {
    return typeof value === "string" && RULE_CATEGORIES.includes(value as RuleCategory) ? value as RuleCategory : "general";
}

/** 写入自动提取的候选。候选默认停用且未复核，必须由用户在规则页采纳后才生效。 */
export function addRuleCandidates(candidates: RuleCandidate[], sourceThreadId = ""): Promise<LearnedRule[]> {
    return mutate((state) => {
        const existing = new Set(state.rules.map((rule) => normalizeRuleText(rule.statement)));
        const added: LearnedRule[] = [];
        const now = new Date().toISOString();
        for (const candidate of candidates) {
            const statement = cleanTextField(candidate?.statement, MAX_STATEMENT_CHARS);
            const title = cleanTextField(candidate?.title, MAX_TITLE_CHARS);
            if (!statement || !title || sensitivePattern.test(statement) || sensitivePattern.test(title)) continue;
            const key = normalizeRuleText(statement);
            if (!key || existing.has(key)) continue;
            existing.add(key);
            const detail = cleanTextField(candidate?.detail, MAX_DETAIL_CHARS);
            const evidence = cleanTextField(candidate?.evidence, MAX_STATEMENT_CHARS);
            if (sensitivePattern.test(detail) || sensitivePattern.test(evidence)) continue;
            const rule: LearnedRule = {
                id: crypto.randomUUID(),
                title,
                statement,
                category: validateCategory(candidate?.category),
                enabled: false,
                reviewed: false,
                createdAt: now,
                updatedAt: now,
                ...(detail ? { detail } : {}),
                ...(evidence && !sensitivePattern.test(evidence) ? { evidence } : {}),
                ...(sourceThreadId ? { sourceThreadId } : {}),
            };
            state.rules.push(rule);
            added.push(rule);
        }
        if (state.rules.length > MAX_RULES) state.rules.splice(0, state.rules.length - MAX_RULES);
        return added;
    });
}

export function setAutoLearn(enabled: boolean) {
    return mutate((state) => {
        state.autoLearn = Boolean(enabled);
        return state.autoLearn;
    });
}

export function setRuleEnabled(id: string, enabled: boolean): Promise<LearnedRule | null> {
    return mutate((state) => {
        const rule = state.rules.find((item) => item.id === id);
        if (!rule) return null;
        rule.enabled = Boolean(enabled);
        if (rule.enabled) rule.reviewed = true;
        rule.updatedAt = new Date().toISOString();
        return rule;
    });
}

export function reviewRule(id: string, action: "accept" | "ignore"): Promise<LearnedRule | null> {
    return mutate((state) => {
        const index = state.rules.findIndex((item) => item.id === id);
        if (index < 0) return null;
        if (action === "ignore") {
            const [removed] = state.rules.splice(index, 1);
            return removed;
        }
        const rule = state.rules[index];
        rule.reviewed = true;
        rule.enabled = true;
        rule.updatedAt = new Date().toISOString();
        return rule;
    });
}

export function updateRule(id: string, patch: Partial<RuleCandidate>): Promise<LearnedRule | null> {
    return mutate((state) => {
        const rule = state.rules.find((item) => item.id === id);
        if (!rule) return null;
        const statement = patch.statement === undefined ? rule.statement : cleanTextField(patch.statement, MAX_STATEMENT_CHARS);
        const title = patch.title === undefined ? rule.title : cleanTextField(patch.title, MAX_TITLE_CHARS);
        if (!statement || !title || sensitivePattern.test(statement) || sensitivePattern.test(title)) throw new Error("规则内容无效或含有敏感信息");
        rule.statement = statement;
        rule.title = title;
        if (patch.category !== undefined) rule.category = validateCategory(patch.category);
        if (patch.detail !== undefined) rule.detail = cleanTextField(patch.detail, MAX_DETAIL_CHARS);
        if (patch.evidence !== undefined) rule.evidence = cleanTextField(patch.evidence, MAX_STATEMENT_CHARS);
        rule.updatedAt = new Date().toISOString();
        return rule;
    });
}

export function deleteRule(id: string): Promise<boolean> {
    return mutate((state) => {
        const index = state.rules.findIndex((item) => item.id === id);
        if (index < 0) return false;
        state.rules.splice(index, 1);
        return true;
    });
}

/** 按类别取启用规则；general 永远包含，未启用的规则一律不进链路。 */
export function enabledRulesFor(categories: Iterable<RuleCategory>, rules?: LearnedRule[]): LearnedRule[] {
    const wanted = new Set<RuleCategory>(["general", ...categories]);
    const source = rules;
    return (source || []).filter((rule) => rule.enabled && wanted.has(rule.category));
}

export async function enabledRulesForCategories(categories: Iterable<RuleCategory>): Promise<LearnedRule[]> {
    const state = await readLearnedRules();
    return enabledRulesFor(categories, state.rules);
}

/** 供 Agent 每轮读取的已启用规则块；没有规则时返回空串，不给提示词添噪声。 */
export function formatRulesContext(rules: LearnedRule[]): string {
    const selected = rules.filter((rule) => rule.enabled).slice(0, MAX_CONTEXT_RULES);
    if (!selected.length) return "";
    const lines: string[] = [];
    let used = 0;
    for (const rule of selected) {
        const line = `- [${RULE_CATEGORY_LABELS[rule.category]}] ${rule.title}：${rule.statement}${rule.detail ? ` ${rule.detail}` : ""}`;
        if (used + line.length > MAX_CONTEXT_CHARS) break;
        lines.push(line);
        used += line.length;
    }
    if (!lines.length) return "";
    return [
        "## 已启用的长期规则（全局；只在对应环节适用，与本轮任务无关的不执行）",
        ...lines,
        "规则与本轮任务冲突时，以用户本轮明确要求为准；不要复述规则，直接按规则做事。",
    ].join("\n");
}

const CATEGORY_KEYWORDS: Array<[RuleCategory, RegExp]> = [
    ["script", /剧本|分场|大纲|剧情|台词|钩子|悬念|改编|对白/],
    ["storyboard", /分镜|拆镜|镜头|景别|机位|运镜|构图|切点|节奏|时长|段数/],
    ["prompt", /提示词|prompt|h3|英文提示|关键词|描述词|加权/iu],
    ["asset", /参考图|资产|角色图|场景图|道具|三视图|设定图|画风|生图/],
    ["continuity", /连续性|接镜|朝向|反打|越轴|动线|视线|尾帧|首帧|站位/],
    ["video", /视频|片段|动效|特效|动作|打斗|生成结果|成片/],
    ["render", /剪辑|转场|字幕|音轨|合成|导出|拼接|配音/],
];

const STAGE_CATEGORIES: Record<string, RuleCategory[]> = {
    script: ["script"],
    assets: ["asset"],
    spatial: ["continuity"],
    shots: ["storyboard", "continuity"],
    keyframes: ["asset", "prompt"],
    clips: ["video", "render"],
};

/** 根据用户输入和当前阶段推断本轮涉及的规则类别；推断不出时只带通用规则。 */
export function selectRuleCategories(text: string, stage = ""): RuleCategory[] {
    const categories = new Set<RuleCategory>();
    const content = `${text}\n${stage}`;
    for (const [category, pattern] of CATEGORY_KEYWORDS) {
        if (pattern.test(content)) categories.add(category);
    }
    for (const [key, values] of Object.entries(STAGE_CATEGORIES)) {
        if (stage && (stage === key || stage.includes(key))) values.forEach((value) => categories.add(value));
    }
    return [...categories];
}
