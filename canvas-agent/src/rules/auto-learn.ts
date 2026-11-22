import { addRuleCandidates, readLearnedRules, type RuleCategory } from "./store.js";
import { parseRuleDraft, ruleDraftPrompt, shouldLearnFromMessage, type RuleDraft, type RuleLearnMessage } from "./learn.js";

export type LearnTurnInput = {
    messages: RuleLearnMessage[];
    threadId: string;
    structured: (prompt: string) => Promise<unknown>;
};

export type LearnTurnResult = {
    summary: string;
    added: number;
    candidates: Array<{ id: string; title: string; category: RuleCategory }>;
};

/** 规则块放在阶段块之后、用户请求之前；没有启用规则就不动原文。 */
export function withLearnedRulesContext(prompt: string, block: string) {
    const value = String(block || "").trim();
    if (!value) return prompt;
    return `${value}\n\n---\n用户请求：${prompt}`;
}

/**
 * 一轮结束后自动提炼：先做意图筛选，再交给结构化模型，最后只写待复核候选。
 * 提炼失败不影响生产 turn，调用方负责吞掉异常并记录日志。
 */
export async function learnFromTurn(input: LearnTurnInput): Promise<LearnTurnResult> {
    const userMessages = input.messages.filter((message) => message.role === "user" && shouldLearnFromMessage(message.text));
    if (!userMessages.length) return { summary: "本轮没有新的长期规则", added: 0, candidates: [] };
    const state = await readLearnedRules();
    if (!state.autoLearn) return { summary: "自动提炼已关闭", added: 0, candidates: [] };
    const prompt = ruleDraftPrompt({
        messages: input.messages,
        existingStatements: state.rules.map((rule) => rule.statement),
    });
    const raw = await input.structured(prompt);
    const draft: RuleDraft = typeof raw === "string" ? parseRuleDraft(raw) : parseRuleDraft(JSON.stringify(raw));
    if (!draft.rules.length) return { summary: draft.summary || "本轮没有新的长期规则", added: 0, candidates: [] };
    const added = await addRuleCandidates(draft.rules, input.threadId);
    return {
        summary: draft.summary,
        added: added.length,
        candidates: added.map((rule) => ({ id: rule.id, title: rule.title, category: rule.category })),
    };
}
