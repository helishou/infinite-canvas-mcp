import type { Stores } from "../stores/types.js";
import { requestOpenAiText, resolveTextProvider } from "../canvas/text-dispatcher.js";
import {
    TOPIC_OPTIONS,
    normalizeEpisodeMinutes,
    normalizeEpsiodeCount,
    normalizeThemeList,
    normalizeTopicOption,
} from "@basketikun/canvas-agent/drama/topic-options";

/**
 * 「粘贴剧本 → 自动填好选题」：一次模型调用，把原文归纳成选题卡的那几项。
 *
 * 只产出候选值，不写库（创建前剧目还不存在）；前端点「应用」才落进 productionPlan。
 * 取值一律经 topic-options 归一化：模型给的近义词能落到选项表就落，落不到就保持空/自定义，
 * 不让它往 schema 里塞编出来的枚举。
 */

const SOURCE_LIMIT = 16000;

export function trimTopicSource(source: string, limit = SOURCE_LIMIT): string {
    const text = String(source || "").trim();
    if (text.length <= limit) return text;
    const head = text.slice(0, Math.floor(limit * 0.8));
    const tail = text.slice(-Math.floor(limit * 0.15));
    return `${head}\n\n……（中间省略 ${text.length - head.length - tail.length} 字）……\n\n${tail}`;
}

export const TOPIC_EXTRACT_SYSTEM_PROMPT = [
    "你是短剧策划，只做一件事：读用户给的剧本/小说/故事梗概，归纳出这部短剧的选题卡。",
    "严格输出一个 JSON 对象，不要 markdown 代码块，不要解释。字段：",
    `themes: 数组，最多 2 个，只能从这些里选：${TOPIC_OPTIONS.themes.join("、")}`,
    `tones: 数组，1~3 个，只能从这些里选：${TOPIC_OPTIONS.tones.join("、")}`,
    `gender: 只能选 ${TOPIC_OPTIONS.gender.join(" / ")}`,
    `age: 只能选 ${TOPIC_OPTIONS.age.join(" / ")}`,
    `ending: 只能选 ${TOPIC_OPTIONS.ending.join(" / ")}`,
    `language: ${TOPIC_OPTIONS.language.join(" / ")}`,
    `artStyle: 只能从这些里选：${TOPIC_OPTIONS.artStyle.join("、")}`,
    "episodes: 整数，按原文体量给出合理集数（20~100 之间，短篇取小值）",
    "episodeMinutes: 整数分钟；判断不出就给 0（0 表示交给模型按剧情定）",
    "title: 剧名，8~14 字，能看出题材与钩子，不要带书名号",
    "logline: 一句话故事，30 字以内，写清谁、遇到什么、要什么",
    "依据：题材/调性/受众看原文的类型与情绪，画风看原文的时代与画面感，集数看原文的篇幅与场景数量。原文没写的字段给空字符串或空数组，不要编。",
].join("\n");

export function buildTopicExtractPrompt(source: string): string {
    return `下面是原剧本 / 小说原文，请归纳选题卡：\n\n${trimTopicSource(source)}`;
}

/** 从模型回包里抠 JSON（容忍代码块、前后废话）。 */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
    const raw = String(text || "").trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : raw).trim();
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export type TopicProposal = {
    title: string;
    themes: string[];
    tones: string[];
    gender: string;
    age: string;
    ending: string;
    language: string;
    artStyle: string;
    episodes: number;
    episodeMinutes: number;
    logline: string;
};

export function normalizeTopicProposal(input: Record<string, unknown> | null): TopicProposal {
    const value = input || {};
    const tones: string[] = [];
    for (const item of Array.isArray(value.tones) ? value.tones : []) {
        const tone = normalizeTopicOption(item, TOPIC_OPTIONS.tones);
        if (tone && !tones.includes(tone)) tones.push(tone);
        if (tones.length >= 3) break;
    }
    return {
        title: String(value.title || "").trim().slice(0, 24),
        themes: normalizeThemeList(value.themes),
        tones,
        gender: normalizeTopicOption(value.gender, TOPIC_OPTIONS.gender, "", "gender"),
        age: normalizeTopicOption(value.age, TOPIC_OPTIONS.age, "", "age"),
        ending: normalizeTopicOption(value.ending, TOPIC_OPTIONS.ending, "", "ending"),
        language: normalizeTopicOption(value.language, TOPIC_OPTIONS.language, "", "language"),
        artStyle: normalizeTopicOption(value.artStyle, TOPIC_OPTIONS.artStyle),
        episodes: normalizeEpsiodeCount(value.episodes),
        episodeMinutes: normalizeEpisodeMinutes(value.episodeMinutes),
        logline: String(value.logline || "").trim().slice(0, 80),
    };
}

/** 没指定模型时挑第一个登记为文本能力的模型：直接传空串会落到 channels[0]，那是音频/图片渠道就 405。 */
export function pickDefaultTextModel(aiConfig: unknown): string {
    const config = (aiConfig && typeof aiConfig === "object" ? aiConfig : {}) as Record<string, unknown>;
    const channels = Array.isArray(config.channels) ? config.channels as Array<Record<string, unknown>> : [];
    for (const channel of channels) {
        const models = Array.isArray(channel.models) ? channel.models as Array<Record<string, unknown>> : [];
        const hit = models.find((entry) => String(entry.capability || "") === "text" && String(entry.name || "").trim());
        if (hit) return `${String(channel.id || "")}::${String(hit.name)}`;
    }
    return "";
}

/** 一次调用拿到选题候选；失败抛错（前端提示可手工填）。 */
export async function proposeTopicFromSource(stores: Pick<Stores, "settings">, input: { source: string; model?: string; instruction?: string }) {
    const source = String(input.source || "").trim();
    const aiConfig = stores.settings.get("ai.config");
    const model = String(input.model || "").trim() || pickDefaultTextModel(aiConfig);
    if (!model) throw new Error("没有可用的文本模型，请先在「设置 → 渠道」里配一个文本模型");
    const provider = resolveTextProvider(aiConfig, model, { systemPrompt: TOPIC_EXTRACT_SYSTEM_PROMPT, reasoningEffort: "auto" });
    const prompt = [buildTopicExtractPrompt(source), input.instruction ? `补充要求：${input.instruction}` : ""].filter(Boolean).join("\n\n");
    const raw = await requestOpenAiText(provider, prompt, []);
    const text = String(raw || "").replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
    if (!text) throw new Error("模型返回了空内容");
    const parsed = extractJsonBlock(text);
    return { topic: normalizeTopicProposal(parsed), raw: parsed ? undefined : text.slice(0, 600), model };
}
