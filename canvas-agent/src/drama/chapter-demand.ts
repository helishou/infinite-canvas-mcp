/**
 * 章节 → 单次提示词 → 结构化草案（纯函数，不发起模型调用）。
 *
 * 方案 A 的第二跳前半段：把一章正文包成一次调用能吃的 prompt，再把模型回包解析成
 * `planChapterStoryboard` 的入参。三件事都在这里做，且都可单测：
 * - `buildChapterDemandPrompt`：约束模型必须回一个 JSON，且 demand 里带
 *   `【场景：】/【时间：】/【镜头 N】` —— 因为后端 `importDemandScriptBlocks` 只认这几种标记切块；
 * - `parseChapterDemand`：容忍 ```json 围栏、前后闲聊、字段缺失，但拒绝「没有场次」这种空壳；
 * - `fallbackChapterDemand`：模型不可用或回包不可解析时的规则兜底，先让场次与镜头结构立起来。
 *
 * 这里不猜剧情：兜底只是把原文按段落搬进「镜头」占位，画面留给人工/下一轮补。
 */

import type { ChapterBeat, ChapterScenePlan } from "./chapter-storyboard.js";

export type ChapterDemandDraft = {
    /** 写进分集 synopsis 的需求正文；必须含【场景：】【时间：】【镜头 N】标记。 */
    demand: string;
    scenes: ChapterScenePlan[];
};

export type ChapterDemandEnvironment = { id: string; name: string };

export type ChapterDemandPromptInput = {
    chapterTitle: string;
    chapterBody: string;
    /** 本集已登记的场景环境；模型只能从这里挑 environmentId。 */
    environments: ChapterDemandEnvironment[];
    /** 单镜时长上限，用于提示模型别给过长镜头。 */
    maxShotSeconds?: number;
};

const DEFAULT_MAX_SHOT_SECONDS = 5;
/** 兜底切节拍时每段的字数，约等于一个镜头能承载的信息量。 */
const FALLBACK_BEAT_CHARS = 120;

export function buildChapterDemandPrompt(input: ChapterDemandPromptInput) {
    const maxShotSeconds = Math.max(1, Math.floor(input.maxShotSeconds ?? DEFAULT_MAX_SHOT_SECONDS));
    const environments = input.environments.length
        ? input.environments.map(item => `- ${item.id}｜${item.name}`).join("\n")
        : "（本集还没有登记场景环境，请把 environmentId 留空并在 sceneName 里写场景名）";
    const system = [
        "你是短剧分镜编剧。把给定章节改写成可拍摄的分镜草案，只输出一个 JSON 对象，不要解释、不要 Markdown 围栏。",
        "JSON 结构：",
        '{"demand":"字符串","scenes":[{"sceneKey":"英文短键","sceneName":"场景名","environmentId":"已登记环境 ID","beats":[{"title":"镜头小标题","visual":"画面描述","camera":"运镜（可空）","seconds":数字,"dialogue":"台词（可空）","speaker":"说话人（有台词时必填）"}]}]}',
        "硬性要求：",
        `1. 每个 beat 的 seconds 在 1–${maxShotSeconds} 之间，整数或 .5；不要写超长镜头。`,
        "2. environmentId 只能从下面清单里选；清单为空时才允许留空串。",
        "3. 有 dialogue 必须同时给 speaker，否则这条台词会被丢弃。",
        "4. demand 是给人看的需求正文：【场景：X】与【时间：Y】各占一行（不要写在同一行），每个镜头用【镜头 N】单独起行，镜头正文原样叙述，不要写 JSON。",
        "5. 不要新增原文没有的人物关系；不要写音乐、字幕、转场特效。",
        "场景环境清单：",
        environments,
    ].join("\n");
    const user = [
        `章节标题：${input.chapterTitle}`,
        "章节正文：",
        input.chapterBody,
    ].join("\n");
    return { system, user };
}

/** 从模型回包里取出 JSON：容忍 ```json 围栏与前后闲聊。 */
function extractJson(text: string) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = (fenced ? fenced[1] : text).trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return "";
    return raw.slice(start, end + 1);
}

function asText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析模型回包。结构性错误抛 `CHAPTER_DEMAND_*`，与制作台的报错风格一致。
 * `environments` 给定时会校验 environmentId 是否在清单内（模型最容易在这里瞎编）。
 */
export function parseChapterDemand(text: string, options: { environments?: ChapterDemandEnvironment[] } = {}): ChapterDemandDraft {
    const json = extractJson(String(text ?? ""));
    if (!json) throw new Error("CHAPTER_DEMAND_JSON: 回包里没有 JSON 对象");
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("CHAPTER_DEMAND_JSON: 回包 JSON 无法解析");
    }
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const demand = asText(record.demand);
    if (!demand) throw new Error("CHAPTER_DEMAND_EMPTY: 缺少 demand 正文");
    const rawScenes = Array.isArray(record.scenes) ? record.scenes : [];
    if (!rawScenes.length) throw new Error("CHAPTER_DEMAND_SCENES: 没有场次");
    const allowed = new Set((options.environments || []).map(item => item.id));
    const scenes: ChapterScenePlan[] = rawScenes.map((item, index) => {
        const scene = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const environmentId = asText(scene.environmentId);
        if (allowed.size && !allowed.has(environmentId)) throw new Error(`CHAPTER_DEMAND_ENVIRONMENT: 第 ${index + 1} 个场次的 environmentId 不在已登记清单内：${environmentId || "(空)"}`);
        const beats = (Array.isArray(scene.beats) ? scene.beats : []).map((beat, beatIndex) => {
            const row = beat && typeof beat === "object" ? beat as Record<string, unknown> : {};
            const seconds = Number(row.seconds);
            return {
                title: asText(row.title) || `镜头 ${beatIndex + 1}`,
                visual: asText(row.visual),
                camera: asText(row.camera),
                seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 2,
                dialogue: asText(row.dialogue) || undefined,
                speaker: asText(row.speaker) || undefined,
            } satisfies ChapterBeat;
        }).filter(beat => beat.visual);
        if (!beats.length) throw new Error(`CHAPTER_DEMAND_BEATS: 第 ${index + 1} 个场次没有画面描述`);
        return {
            sceneKey: asText(scene.sceneKey) || `scene-${index + 1}`,
            sceneName: asText(scene.sceneName) || undefined,
            environmentId,
            beats,
        };
    });
    return { demand, scenes };
}

/**
 * 规则兜底：模型不可用 / 回包不可解析时，把章节按段落搬成镜头占位。
 * 只保证结构合法（有场次、有镜头、有 demand 标记），画面描述直接取原文，不加工。
 */
export function fallbackChapterDemand(input: {
    chapterTitle: string;
    chapterBody: string;
    environmentId: string;
    sceneName?: string;
    secondsPerBeat?: number;
    beatChars?: number;
}): ChapterDemandDraft {
    const environmentId = String(input.environmentId || "").trim();
    if (!environmentId) throw new Error("CHAPTER_DEMAND_ENVIRONMENT: 兜底需要场次环境 ID");
    const secondsPerBeat = Math.max(1, Number(input.secondsPerBeat) || 3);
    const beatChars = Math.max(40, Math.floor(input.beatChars ?? FALLBACK_BEAT_CHARS));
    const paragraphs = String(input.chapterBody || "").split(/\n{2,}|\n/).map(line => line.trim()).filter(Boolean);
    const beats: ChapterBeat[] = [];
    for (const paragraph of paragraphs) {
        for (let offset = 0; offset < paragraph.length; offset += beatChars) {
            const slice = paragraph.slice(offset, offset + beatChars).trim();
            if (!slice) continue;
            beats.push({ title: `节拍 ${beats.length + 1}`, visual: slice, seconds: secondsPerBeat });
        }
    }
    if (!beats.length) throw new Error("CHAPTER_DEMAND_BEATS: 章节正文为空，无法兜底");
    const sceneName = String(input.sceneName || "").trim() || "未指定场景";
    // 场景与时间各占一行：后端取场景名的正则是「场景[：:]\s*([^\r\n]+)」，
    // 挤在一行会把【时间：】一起吞进场次环境 ID。
    const demand = [
        `【场景：${sceneName}】`,
        "【时间：未指定】",
        ...beats.map((beat, index) => `【镜头 ${index + 1}】\n${beat.visual}`),
    ].join("\n");
    return {
        demand,
        scenes: [{ sceneKey: "fallback", sceneName, environmentId, beats }],
    };
}
