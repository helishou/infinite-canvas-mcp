import { z } from "zod";

import type { JsonRecord } from "../utils/value.js";
import { RULE_CATEGORIES, type RuleCandidate } from "./store.js";

/** 一轮对话里只有用户明确提出长期要求时才值得提炼；一次性改稿不进学习。 */
const revisionIntent = /以后|每次|始终|一直|永远|记住|记得|注意|不要再|别再|不要|不能|不许|必须|应该|需要|保持|改为|改成|换成|默认|所有剧|以后都|今后|今后都|保留|禁止|避免/;

const ruleItemSchema = z.object({
    title: z.string().trim().min(1).max(60),
    statement: z.string().trim().min(1).max(400),
    detail: z.string().trim().max(800).optional().default(""),
    category: z.enum(RULE_CATEGORIES),
    evidence: z.string().trim().max(400).optional().default(""),
});

export const ruleDraftSchema = z.object({
    summary: z.string().trim().max(500),
    rules: z.array(ruleItemSchema).max(12),
});

export type RuleDraft = z.infer<typeof ruleDraftSchema>;
export type RuleLearnMessage = { role: "user" | "assistant"; text: string };

export const RULE_DRAFT_OUTPUT_SCHEMA: JsonRecord = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "rules"],
    properties: {
        summary: { type: "string", maxLength: 500 },
        rules: {
            type: "array",
            maxItems: 12,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "statement", "detail", "category", "evidence"],
                properties: {
                    title: { type: "string", minLength: 1, maxLength: 60 },
                    statement: { type: "string", minLength: 1, maxLength: 400 },
                    detail: { type: "string", maxLength: 800 },
                    category: { type: "string", enum: [...RULE_CATEGORIES] },
                    evidence: { type: "string", maxLength: 400 },
                },
            },
        },
    },
};

export function shouldLearnFromMessage(text: string) {
    const value = String(text || "");
    return value.length >= 6 && value.length <= 4000 && revisionIntent.test(value);
}

export function ruleDraftPrompt(input: { messages: RuleLearnMessage[]; existingStatements: string[] }) {
    const conversation = input.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-8)
        .map((message) => `${message.role === "user" ? "用户" : "导演"}：${message.text.slice(0, 1600)}`)
        .join("\n");
    const existing = input.existingStatements.slice(0, 80).map((statement, index) => `${index + 1}. ${statement}`).join("\n");
    return [
        "你在为短剧导演 Agent 提炼长期规则。只从「用户」的修改意见里提炼，导演自己的回复不算依据。",
        "只保留用户明确要求今后一直遵守的约束；一次性改稿、具体人名/集数/镜头号/文件路径/临时产物、工具报错与调试过程都不要提炼。",
        "每条规则写成可执行的约束，用中文祈使句，不写比喻和空泛评价。没有可提炼内容时返回 rules: []。",
        "category 按规则实际作用的环节选择：general 通用全程；script 剧本与分场；storyboard 拆镜与镜头调度；prompt 视频提示词写作；asset 参考图与资产设定；continuity 跨镜连续性；video 视频生成与动效；render 剪辑合成与字幕音轨。",
        "detail 写必要的使用条件或例外，没有就留空。evidence 只摘用户原话中最短的一句，必须是原文，不得改写。",
        "已有规则（语义相同或高度相近的不要重复输出）：",
        existing || "（暂无）",
        "",
        "本轮对话：",
        conversation,
        "",
        "summary 用一句话说明本轮提炼了什么；没有可提炼内容时写「本轮没有新的长期规则」。只按 outputSchema 返回对象。",
    ].join("\n");
}

export function parseRuleDraft(raw: string): RuleDraft {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("规则提炼结果不是有效 JSON");
    }
    const parsed = ruleDraftSchema.safeParse(value);
    if (!parsed.success) throw new Error("规则提炼结果格式不正确");
    return {
        summary: parsed.data.summary,
        rules: parsed.data.rules.map((rule) => ({
            title: rule.title,
            statement: rule.statement,
            detail: rule.detail || "",
            category: rule.category,
            evidence: rule.evidence || "",
        })),
    };
}

export function ruleDraftToCandidates(draft: RuleDraft): RuleCandidate[] {
    return draft.rules.map((rule) => ({
        title: rule.title,
        statement: rule.statement,
        ...(rule.detail ? { detail: rule.detail } : {}),
        category: rule.category as RuleCandidate["category"],
        ...(rule.evidence ? { evidence: rule.evidence } : {}),
    }));
}
