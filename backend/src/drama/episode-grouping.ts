/**
 * 模型自动分集：结构化提示词 + 解析补齐。
 *
 * 对齐影策 backend 的 submitPlan（drama_orchestrator.go:1732）与 ParsePlan（production/parse.go:295）：
 * 模型只输出 {"episodes":[{title,chapters,synopsis,hook,cliffhanger}]}；本地解析器
 * 只收本批章序号、丢弃无章/无梗概的集、补齐模型漏掉的章，保证原文全部被覆盖。
 *
 * 与影策一致支持「一章拆多集」（同一章序号出现在多集的 chapters 里），
 * 因此解析器只在单集内去重，不做跨集去重；全覆盖按「至少一次」判定。
 * 本模块不落库、不建集；写入与建集由 drama-planning-routes 的两个接口负责。
 */

import type { ModelEpisodeGroup } from "@basketikun/canvas-agent/drama/production-contract";
import { requestOpenAiText, resolveTextProvider } from "../canvas/text-dispatcher.js";
import type { Stores } from "../stores/types.js";
import { resolveOutlineModel } from "./outline-proposal.js";

export type GroupingChapter = {
    /** 1 起算章序号，等于拆章结果的 index。 */
    index: number;
    title: string;
    /** 该章正文（用于提示词与漏章兜底梗概）。 */
    text: string;
};

/** 每章喂给模型的正文上限，与影策 PlanPrompt 的 6000 runes 一致。 */
export const GROUPING_CHAPTER_CHARS = 6000;

const SYSTEM_PROMPT = [
    "你是竖屏短剧分集编剧，把小说章节改编为节奏紧凑的分集大纲：每集开场有钩子，结尾停在悬念。",
    "只输出一个 JSON 对象：不要 Markdown 代码块、不要解释思路、不要重复题目、不要多余文字。",
    "人物、地点、事件必须来自给定章节，不得编造后续剧情；信息不足按最保守的写法留白。",
    "全部用中文。",
].join("\n");

export function truncateRunes(text: string, limit: number): string {
    const chars = Array.from(String(text || "").trim());
    return chars.length <= limit ? chars.join("") : chars.slice(0, limit).join("");
}

function chapterLine(chapter: GroupingChapter): string {
    const body = truncateRunes(chapter.text, GROUPING_CHAPTER_CHARS);
    return `[${chapter.index}] ${chapter.title || `第 ${chapter.index} 章`}\n${body}`;
}

export function buildEpisodeGroupingPrompt(input: {
    name: string;
    chapters: readonly GroupingChapter[];
    startNumber: number;
    previousCliffhanger?: string;
    instruction?: string;
}): string {
    const parts = [
        `作品：${input.name || "未命名剧目"}`,
        `下一集编号：${input.startNumber}`,
    ];
    if (input.previousCliffhanger?.trim()) parts.push(`上一集结尾悬念：${input.previousCliffhanger.trim()}`);
    parts.push(
        "请把下面的章节改编为若干集，只输出：",
        '{"episodes":[{"title":"集标题（6-12字）","chapters":[章节序号],"synopsis":"本集剧情（80-150字）","hook":"开场钩子","cliffhanger":"结尾悬念"}]}',
        "规则：信息密度高的一章可拆成两集（同一章序号分别出现在两集的 chapters 里）；过渡性章节与相邻章节合并；",
        "chapters 只能使用下方方括号里的章节序号；每一章至少被一集覆盖；synopsis 不能为空；只覆盖本批章节，不要编造后续剧情。",
        "【章节】",
        ...input.chapters.map(chapterLine),
    );
    if (input.instruction?.trim()) parts.push(`用户补充要求：${input.instruction.trim()}`);
    return parts.join("\n\n");
}

/** 从模型回复里取出第一个完整 JSON 对象；容忍 ```json 围栏与前后说明文字。 */
export function extractJsonObject(raw: string): string {
    const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = text.indexOf("{");
    if (start < 0) throw new Error("模型没有返回 JSON 对象（分集规划失败）");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    throw new Error("模型返回的 JSON 不完整（分集规划失败）");
}

type RawEpisode = {
    title?: unknown;
    chapters?: unknown;
    synopsis?: unknown;
    hook?: unknown;
    cliffhanger?: unknown;
};

function chapterNumber(value: unknown): number | null {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value.trim()) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 照影策 ParsePlan 的规则解析：只收本批章序号、单集内去重、丢弃无章/无梗概集，
 * 再按原章顺序补齐漏章；返回的分组保证每章至少被一集覆盖。
 */
export function parseEpisodeGrouping(raw: string, chapters: readonly GroupingChapter[]): ModelEpisodeGroup[] {
    let payload: { episodes?: unknown };
    try {
        payload = JSON.parse(extractJsonObject(raw)) as { episodes?: unknown };
    } catch (error) {
        throw new Error(`模型分集结果不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    const allowed = new Set(chapters.map((chapter) => chapter.index));
    const byIndex = new Map(chapters.map((chapter) => [chapter.index, chapter]));
    const covered = new Set<number>();
    const groups: ModelEpisodeGroup[] = [];
    const items = Array.isArray(payload?.episodes) ? payload.episodes as RawEpisode[] : [];
    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const synopsis = String(item.synopsis ?? "").trim();
        const picked: number[] = [];
        for (const value of Array.isArray(item.chapters) ? item.chapters : []) {
            const n = chapterNumber(value);
            if (n !== null && allowed.has(n) && !picked.includes(n)) picked.push(n);
        }
        if (!picked.length || !synopsis) continue;
        picked.forEach((n) => covered.add(n));
        groups.push({
            title: String(item.title ?? "").trim() || truncateRunes(synopsis, 10),
            chapters: picked.sort((left, right) => left - right),
            synopsis,
            hook: String(item.hook ?? "").trim(),
            cliffhanger: String(item.cliffhanger ?? "").trim(),
        });
    }
    // 模型漏章：按原章顺序补成单章集，梗概取该章原文前 120 字（影策同款兜底）。
    for (const chapter of chapters) {
        if (covered.has(chapter.index)) continue;
        groups.push({
            title: chapter.title || `第 ${chapter.index} 章`,
            chapters: [chapter.index],
            synopsis: truncateRunes(chapter.text, 120),
            hook: "",
            cliffhanger: "",
        });
        covered.add(chapter.index);
    }
    if (!groups.length) throw new Error("分集规划为空：模型没有给出任何有效分集");
    return groups;
}

/** 供 apply 校验用户确认后的分组是否仍覆盖全部选章。 */
export function missingChapters(groups: readonly { chapters: readonly number[] }[], indices: readonly number[]): number[] {
    const covered = new Set<number>();
    groups.forEach((group) => group.chapters.forEach((n) => covered.add(n)));
    return indices.filter((n) => !covered.has(n));
}

/** 模型不可用 / 未配置 / 返回空内容时抛错，绝不返回伪造分组。 */
export async function proposeEpisodeGrouping(
    stores: Pick<Stores, "settings">,
    input: {
        name: string;
        chapters: readonly GroupingChapter[];
        startNumber: number;
        previousCliffhanger?: string;
        instruction?: string;
        model?: string;
        signal?: AbortSignal;
    },
): Promise<{ groups: ModelEpisodeGroup[]; model: string }> {
    if (!input.chapters.length) throw new Error("没有可分集的章节：请先在剧目规划录入原剧本并确认选章");
    const aiConfig = stores.settings.get("ai.config");
    const model = resolveOutlineModel(aiConfig, input.model);
    if (!model) throw new Error("请先在设置里选择「文本模型」，再预览模型自动分集");
    const provider = resolveTextProvider(aiConfig, model, { systemPrompt: SYSTEM_PROMPT, reasoningEffort: "auto" });
    const raw = await requestOpenAiText(provider, buildEpisodeGroupingPrompt(input), [], input.signal);
    if (!String(raw || "").trim()) throw new Error("模型返回了空内容（分集规划失败）");
    return { groups: parseEpisodeGrouping(raw, input.chapters), model };
}
