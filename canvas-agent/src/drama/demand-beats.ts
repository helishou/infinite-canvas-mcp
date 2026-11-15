/**
 * 需求正文 → 镜头节拍（纯函数，不调模型、不写库）。
 *
 * 这是方案 A 里唯一「反向」的一跳：`chapter-demand` 让模型产出带
 * `【场景：】/【时间：】/【镜头 N】` 标记的需求正文，这里再把这串给人看的正文
 * 解析回结构化节拍，供 `planChapterStoryboard` 排 Shot / Clip。
 *
 * 之所以不直接把模型的 JSON 留到最后用：需求正文是要落进分集 synopsis 的正式源稿，
 * 用户在草案面板里改的、后端 `importDemandScriptBlocks` 切的，都是这一份文本。
 * 所以真相以文本为准，结构只是它的投影 —— 否则文本和结构迟早对不上。
 *
 * 不猜剧情：没有台词标记就不造台词；说话人认不出来就把台词并回画面描述并给诊断，
 * 不编造人物。
 */

import type { ChapterBeat } from "./chapter-storyboard.js";

export type ParsedDemand = {
    /** 【场景：X】里的 X；缺失时为空串。 */
    sceneName: string;
    /** 【时间：Y】里的 Y；缺失时为空串。 */
    timeOfDay: string;
    beats: ChapterBeat[];
    /** 非致命提示：说话人识别不出、镜头过长被压、正文为空等。 */
    diagnostics: string[];
};

export type ParseDemandOptions = {
    /** 单镜时长上限（秒），超过的镜头会被压到该值并给诊断。默认 6。 */
    maxShotSeconds?: number;
    /** 单镜时长下限（秒），默认 1。 */
    minShotSeconds?: number;
    /** 动作描述的中文阅读速度（字/秒），默认 8。 */
    actionCharsPerSecond?: number;
    /** 台词的中文语速（字/秒），默认 4.5。 */
    dialogueCharsPerSecond?: number;
};

const DEFAULT_MAX_SHOT_SECONDS = 6;
const DEFAULT_MIN_SHOT_SECONDS = 1;
const DEFAULT_ACTION_CPS = 8;
const DEFAULT_DIALOGUE_CPS = 4.5;

/** 镜头标记：`【镜头 1】` / `【镜头一】` / `[镜头 2]`。 */
const SHOT_MARKER = /[【\[]\s*镜头\s*([^】\]]+?)\s*[】\]]/g;
const SCENE_MARKER = /[【\[]\s*场景\s*[：:]\s*([^】\]]+?)\s*[】\]]/;
const TIME_MARKER = /[【\[]\s*时间\s*[：:]\s*([^】\]]+?)\s*[】\]]/;

/** `张三：「台词」` / `张三：台词` —— 冒号前是短称呼且不含标点。 */
const NAMED_LINE = /^([^\s：:，。！？、；「」“”"']{1,8})\s*[：:]\s*([\s\S]+)$/;
const QUOTED = /[「“"]([^」”"]{2,80})[」”"]/;

function asText(value: string | undefined) {
    return String(value ?? "").replace(/\r/g, "").trim();
}

/** 去掉镜头 / 场景 / 时间标记本身，只留正文。 */
function stripMarker(text: string) {
    return text
        .replace(SHOT_MARKER, "")
        .replace(/[【\[]\s*(?:场景|时间)\s*[：:][^】\]]*[】\]]/g, "")
        .trim();
}

/**
 * 把一段镜头正文拆成「画面 / 台词 / 说话人」。
 *
 * 台词绝不能留在画面描述里：H3 编译会把 Shot.visual 全文塞进提示词，正文里复述台词
 * 会触发「台词重复」拦截。所以认不出说话人的台词一律丢弃并进诊断（带上原文让用户补），
 * 而不是塞回 visual。
 */
function splitBeat(body: string, index: number, diagnostics: string[]) {
    const lines = body.split("\n").map(line => line.trim()).filter(Boolean);
    const visualLines: string[] = [];
    const dialogues: Array<{ speaker: string; text: string }> = [];
    const orphans: string[] = [];

    for (const line of lines) {
        const named = line.match(NAMED_LINE);
        if (named) {
            const speaker = named[1].trim();
            const said = named[2].trim();
            const quoted = said.match(QUOTED);
            const text = (quoted ? quoted[1] : said).trim();
            if (text) {
                dialogues.push({ speaker, text });
                continue;
            }
        }
        const quoted = line.match(QUOTED);
        if (quoted && line.replace(QUOTED, "").trim().length <= 2) {
            orphans.push(quoted[1]);
            continue;
        }
        visualLines.push(line);
    }

    if (orphans.length) {
        diagnostics.push(`第 ${index + 1} 镜有 ${orphans.length} 句没写说话人的台词，已丢弃（原文：${orphans[0].slice(0, 20)}），补成「说话人：台词」格式即可保留`);
    }

    const visual = visualLines.join("\n").trim();
    const first = dialogues[0];
    return {
        visual,
        dialogue: first?.text,
        speaker: first?.speaker,
        extraDialogue: Math.max(0, dialogues.length - 1),
    };
}

/** 时长估算：动作按 8 字/秒，台词按 4.5 字/秒，量化到 0.5 秒并夹在上下限内。 */
function estimateSeconds(visual: string, dialogue: string | undefined, options: Required<ParseDemandOptions>) {
    const actionChars = visual.replace(/\s/g, "").length;
    const dialogueChars = (dialogue || "").replace(/\s/g, "").length;
    // 每镜至少有 0.6 秒的起幅，避免纯短句被压成 1 秒的机械节奏。
    const unclamped = 0.6 + actionChars / options.actionCharsPerSecond + dialogueChars / options.dialogueCharsPerSecond;
    const rounded = Math.round(unclamped * 2) / 2;
    return { unclamped: rounded, seconds: Math.min(options.maxShotSeconds, Math.max(options.minShotSeconds, rounded)) };
}

/** 无镜头标记时的兜底分镜：空行分段 → 段内按行分 → 过短的行并入上一镜 → 超长行按句切开。 */
function splitByParagraphs(text: string) {
    const blocks = text.split(/\n{2,}/).map(item => stripMarker(item)).filter(Boolean);
    const shots: string[] = [];
    for (const block of blocks) {
        let buffer = "";
        const flush = () => {
            if (!buffer) return;
            if (shots.length) shots[shots.length - 1] += `\n${buffer}`;
            else shots.push(buffer);
            buffer = "";
        };
        for (const raw of block.split(/\n+/)) {
            const line = raw.trim();
            if (!line) continue;
            // 太短的行（章节号、残句、标记残留）当成上一镜的延续。
            if (line.length < 6) { buffer = buffer ? `${buffer}\n${line}` : line; continue; }
            flush();
            if (line.length <= 160) { shots.push(line); continue; }
            // 一行写了好几件事：按中文句末标点切开，避免整段被压成一个超长镜头。
            const sentences = line.split(/(?<=[。！？!?])/).map(item => item.trim()).filter(Boolean);
            let chunk = "";
            for (const sentence of sentences) {
                if (chunk && chunk.length + sentence.length > 120) { shots.push(chunk); chunk = ""; }
                chunk += sentence;
            }
            if (chunk) shots.push(chunk);
        }
        flush();
    }
    return shots;
}

/**
 * 解析需求正文。没有【镜头 N】标记时按段落/行兜底分镜，保证「一段也能出片」。
 * 空正文抛 `DEMAND_BEATS_EMPTY`；其余问题只进 diagnostics，不阻断。
 */
export function parseDemandText(demand: string, options: ParseDemandOptions = {}): ParsedDemand {
    const resolved: Required<ParseDemandOptions> = {
        maxShotSeconds: Math.max(1, Number(options.maxShotSeconds) || DEFAULT_MAX_SHOT_SECONDS),
        minShotSeconds: Math.max(0.5, Number(options.minShotSeconds) || DEFAULT_MIN_SHOT_SECONDS),
        actionCharsPerSecond: Math.max(1, Number(options.actionCharsPerSecond) || DEFAULT_ACTION_CPS),
        dialogueCharsPerSecond: Math.max(1, Number(options.dialogueCharsPerSecond) || DEFAULT_DIALOGUE_CPS),
    };
    const text = asText(demand);
    if (!text) throw new Error("DEMAND_BEATS_EMPTY: 需求正文为空");

    const sceneName = asText(text.match(SCENE_MARKER)?.[1]);
    const timeOfDay = asText(text.match(TIME_MARKER)?.[1]);
    const diagnostics: string[] = [];

    const matches = [...text.matchAll(SHOT_MARKER)];
    const blocks: string[] = [];
    if (matches.length) {
        for (let index = 0; index < matches.length; index += 1) {
            const start = (matches[index].index ?? 0) + matches[index][0].length;
            const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
            blocks.push(text.slice(start, end));
        }
    } else {
        const paragraphs = splitByParagraphs(text);
        if (paragraphs.length) blocks.push(...paragraphs);
        if (paragraphs.length) diagnostics.push("需求正文没有【镜头 N】标记，已按段落自动分镜");
    }

    const beats: ChapterBeat[] = [];
    blocks.forEach(block => {
        const body = stripMarker(block);
        if (!body) return;
        const index = beats.length;
        const split = splitBeat(body, index, diagnostics);
        if (!split.visual) {
            // 整镜只有台词：用中性的镜头语言补位，不把台词写回画面描述（会触发重复拦截）。
            if (!split.dialogue) return;
            diagnostics.push(`第 ${index + 1} 镜只有台词没有画面描述，已补成「人物近景开口」`);
        }
        if (split.extraDialogue > 0) diagnostics.push(`第 ${index + 1} 镜有 ${split.extraDialogue + 1} 句台词，只保留第一句，其余已丢弃`);
        const visual = split.visual || "人物近景，开口说话。";
        const estimate = estimateSeconds(visual, split.dialogue, resolved);
        if (estimate.unclamped > resolved.maxShotSeconds) {
            diagnostics.push(`第 ${index + 1} 镜原估 ${estimate.unclamped} 秒，超过单镜上限 ${resolved.maxShotSeconds} 秒，已压到上限；建议在草案里拆成两镜`);
        }
        beats.push({
            title: `镜头 ${beats.length + 1}`,
            visual,
            seconds: estimate.seconds,
            ...(split.dialogue && split.speaker ? { dialogue: split.dialogue, speaker: split.speaker } : {}),
        });
    });

    if (!beats.length) throw new Error("DEMAND_BEATS_EMPTY: 需求正文里没有可用镜头");
    return { sceneName, timeOfDay, beats, diagnostics };
}

/**
 * 把解析结果拼回需求正文 —— 用户在草案里改了镜头之后，synopsis 要跟着变，
 * 否则后端 `importDemandScriptBlocks` 切出来的还是旧文本。
 *
 * 场景与时间必须**各占一行**：后端取场景名的正则是 `场景[：:]\s*([^\r\n]+)`，
 * 两个标记挤在一行时会连【时间：】一起吞掉，场次环境 ID 就变成「破庙】【时间：夜】」。
 */
export function composeDemandText(input: {
    sceneName?: string;
    timeOfDay?: string;
    beats: readonly Pick<ChapterBeat, "visual" | "dialogue" | "speaker">[];
}) {
    const head = [`【场景：${input.sceneName?.trim() || "未指定场景"}】`, `【时间：${input.timeOfDay?.trim() || "未指定"}】`];
    const body = input.beats.map((beat, index) => {
        const lines = [`【镜头 ${index + 1}】`, beat.visual.trim()];
        if (beat.dialogue && beat.speaker) lines.push(`${beat.speaker}：「${beat.dialogue}」`);
        return lines.join("\n");
    });
    return [...head, ...body].join("\n");
}
