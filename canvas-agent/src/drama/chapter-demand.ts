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
import { ShotTarget, LineTarget, PacingRelaxed, DialogueStandard } from "./pacing.js";

export type ChapterDemandDraft = {
    /** 写进分集 synopsis 的需求正文；必须含【场景：】【时间：】【镜头 N】标记。 */
    demand: string;
    scenes: ChapterScenePlan[];
};

export type ChapterDemandEnvironment = { id: string; name: string };
/** 结构化引用清单项（角色/道具/场景）；id 是注册表/资产卡的稳定 ID，name 仅给模型看。 */
export type ChapterDemandRef = { id: string; name: string };

export type ChapterDemandPromptInput = {
    chapterTitle: string;
    chapterBody: string;
    /** 本集已登记的场景环境；模型只能从这里挑 environmentId。 */
    environments: ChapterDemandEnvironment[];
    /** 本集已登记角色（character_registry）；模型的 beat.character_ids 只能逐字复制这里的 id。 */
    characterRefs?: ChapterDemandRef[];
    /** 本集已登记道具（asset_cards 中 kind=prop）；模型的 beat.prop_ids 只能逐字复制这里的 id。 */
    propRefs?: ChapterDemandRef[];
    /** 场景引用清单；不传时场景段用 environments。 */
    sceneRefs?: ChapterDemandRef[];
    /** 单镜时长上限，用于提示模型别给过长镜头。 */
    maxShotSeconds?: number;
    /** 目标单集秒数；给出时用影策 ShotTarget/LineTarget 作为软参考写进提示词，不强制模型照搬。 */
    episodeSeconds?: number;
    /**
     * 视觉风格（影策 StylePrompt，如「写实电影感」）。注入提示词后，
     * 模型的构图与光线描述会朝这个方向收敛，不再各镜各写一套调性。
     */
    stylePrompt?: string;
    /**
     * 全剧统一的画面规则（影策 VisualRules）：色彩、光线、镜头语言、禁忌等。
     * 影策把它和风格一起注入拆分镜头 prompt，是跨集一致性的来源。
     */
    visualRules?: string;
    /** 本集开场钩子（影策 hook）：第一个镜头就要建立它。 */
    hook?: string;
    /** 本集结尾悬念（影策 cliffhanger）：最后一个镜头停在它上面。 */
    cliffhanger?: string;
    /** 本集场次与时间信息（影策 time/setting 提示），帮助模型分场。 */
    sceneHints?: string;
};

const DEFAULT_MAX_SHOT_SECONDS = 8; // 影策 relaxed 舒缓档上限，情绪戏可给到8秒
/** 兜底切节拍时每段的字数，约等于一个镜头能承载的信息量。 */
const FALLBACK_BEAT_CHARS = 120;

export function buildChapterDemandPrompt(input: ChapterDemandPromptInput) {
    const maxShotSeconds = Math.max(1, Math.floor(input.maxShotSeconds ?? DEFAULT_MAX_SHOT_SECONDS));
    const environments = input.environments.length
        ? input.environments.map(item => `- environmentId: "${item.id}"（场景名：${item.name}）`).join("\n")
        : "（本集还没有登记场景环境，请把 environmentId 留空并在 sceneName 里写场景名）";
    const refList = (refs: ChapterDemandRef[] | undefined, empty: string) => refs?.length
        ? refs.map(item => `- ${item.id}｜${item.name}`).join("\n")
        : empty;
    const characters = refList(input.characterRefs, "（本集还没有登记角色，所有 beat 的 character_ids 给空数组）");
    const props = refList(input.propRefs, "（本集还没有登记道具，所有 beat 的 prop_ids 给空数组）");
    const scenes = input.sceneRefs?.length
        ? input.sceneRefs.map(item => `- scene_id: "${item.id}"（场景名：${item.name}）`).join("\n")
        : environments;
    const systemLines = [
        "你是短剧分镜编剧。把给定章节改写成可拍摄的分镜草案，只输出一个 JSON 对象，不要解释、不要 Markdown 围栏。",
        "JSON 结构：",
        '{"demand":"字符串","scenes":[{"sceneKey":"英文短键","sceneName":"场景名","environmentId":"已登记环境 ID","beats":[{"title":"镜头小标题","visual":"画面描述","action":"画面里发生的具体动作","shotSize":"特写/近景/中景/全景/远景","camera":"运镜（固定/推/拉/摇/跟/环绕，可空）","imagePrompt":"本镜起幅画面","videoPrompt":"本镜镜内动作与运镜的时序","seconds":数字,"dialogue":"台词（可空）","speaker":"说话人（有台词时必填）","sourceQuote":"对应的原文小句","character_ids":["角色ID数组"],"prop_ids":["道具ID数组"],"scene_id":"场景ID或空串"}]}]}',
        "硬性要求：",
        `1. 每个 beat 的 seconds 是时长提示（3–${maxShotSeconds} 秒，整数或 .5）：动作/冲突镜给 3–4 秒短镜，情绪戏/对话/关键场面给 6–${maxShotSeconds} 秒长镜，普通叙事给 4–5 秒。按剧情需要分配，不要所有镜头都用同一个秒数。`,
        "2. environmentId 只能填下面场景清单里 environmentId: 后面引号中的 ID 原值（只填 ID，不要带引号、场景名或「｜」）；清单为空时才允许留空串。",
        "3. 原文里每段引号内的对白都必须逐字提取到某个 beat 的 dialogue，并同时给出 speaker；这是硬要求，不是可选项。宁可把带对白的段落拆成独立镜头，也不要把台词省略或只写进 visual 叙述。",
        "4. demand 是给人看的需求正文：【场景：X】与【时间：Y】各占一行（不要写在同一行），每个镜头用【镜头 N】单独起行，镜头正文原样叙述，不要写 JSON。",
        "5. 不要新增原文没有的人物关系；不要写音乐、字幕、转场特效。",
        "6. 每个 beat 的 character_ids / prop_ids / scene_id 用于自动绑定参考图：id 只能从下方对应清单里逐字复制，不得新编、不得改写、不得用名称代替 id；清单里没有就 character_ids/prop_ids 给空数组、scene_id 给空串；同一镜内按出场顺序去重，同一个 id 只写一次。",
        // 下面三条是分镜可拍性的硬要求：缺了它们，镜头只会剩一句结果陈述。
        "7. visual 写「这一镜看得见什么」，不是剧情概括。要能直接指导拍摄：谁站在哪、朝哪个方向、正在做什么动作、脸上是什么表情、画面前景中景背景各有什么。至少 60 字。禁止写「神情坚定」「气氛紧张」这类不可拍的判断，改写能看见的具体表现（手指收紧、喉结动了一下、视线避开）。",
        "8. imagePrompt 与 videoPrompt 必须分开写，不能复制 visual。imagePrompt 是本镜第一帧的静止构图（人物站位与朝向、动作起始姿态、表情、构图、光线方向、环境陈设），40 字以上；videoPrompt 是本镜时长内按时间顺序发生的动作与镜头运动，写清起止（如「0-2 秒……，2-5 秒……」），40 字以上。",
        "9. shotSize 必须按叙事需要明确给出特写/近景/中景/全景/远景之一，不得整集都用一个。交代空间用全景/远景，对话与情绪用近景/特写，动作交代用中景。sourceQuote 填本镜对应的原文一小句（逐字摘录，没有原文依据就留空）。",
    ];
    if (Number.isFinite(input.episodeSeconds) && (input.episodeSeconds ?? 0) > 0) {
        const targetSeconds = Number(input.episodeSeconds);
        systemLines.push(
            `7. 目标单集约 ${targetSeconds} 秒：影策估算约 ${ShotTarget(targetSeconds, PacingRelaxed)} 镜、${LineTarget(targetSeconds, DialogueStandard)} 条台词/旁白。这是软参考，按剧情实际需要取舍。`,
        );
    }
    systemLines.push("角色清单：", characters);
    systemLines.push("道具清单：", props);
    systemLines.push("场景清单：", scenes);
    // 影策拆分镜头 prompt 的票面信息：风格与画面规则决定整集调性，钩子与悬念决定首尾镜头。
    const style = String(input.stylePrompt || "").trim();
    const visualRules = String(input.visualRules || "").trim();
    const hook = String(input.hook || "").trim();
    const cliffhanger = String(input.cliffhanger || "").trim();
    const sceneHints = String(input.sceneHints || "").trim();
    if (style || visualRules) {
        systemLines.push("视觉风格与画面规则（每一镜的构图、光线、色彩都要照此执行，不得各镜各写一套）：");
        if (style) systemLines.push(`- 视觉风格：${style}`);
        if (visualRules) systemLines.push(`- 画面规则：${visualRules}`);
    }
    if (hook) systemLines.push(`开场钩子（第一个镜头就要把它建立起来）：${hook}`);
    if (cliffhanger) systemLines.push(`结尾悬念（最后一个镜头停在它上面，不要提前解决）：${cliffhanger}`);
    if (sceneHints) systemLines.push(`场次与时间提示：${sceneHints}`);
    const system = systemLines.join("\n");
    const user = [
        `章节标题：${input.chapterTitle}`,
        "章节正文：",
        input.chapterBody,
    ].join("\n");
    return { system, user };
}

/** 从模型回包里取出 JSON：容忍 ```json 围栏与前后闲聊。 */
/** 收集文本中所有「可能是一个完整 JSON 对象」的候选片段（围栏块 / 裸 {…} / 平衡括号扫描）。 */
function extractJsonCandidates(text: string): string[] {
    const out: string[] = [];
    const push = (value: string) => { const v = value.trim(); if (v.startsWith("{") && v.endsWith("}") && !out.includes(v)) out.push(v); };
    // 1) 所有 Markdown 围栏块
    const re = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push(m[1]);
    // 2) 首个 { 到末尾 }（常见整段就是一个对象）
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start >= 0 && end > start) push(text.slice(start, end + 1));
    // 3) 对每个 "{" 起点单独做平衡扫描，收集所有可能的 {…} 对象。
    // 只扫顶层会被前置的坏 "{" 吞掉后面的好对象；逐起点扫描能覆盖好对象自己的 "{"。
    for (let start = 0; start < text.length; start++) {
        if (text[start] !== "{") continue;
        let depth = 0, inStr = false, esc = false, closed = -1;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
            if (ch === '"') { inStr = true; continue; }
            if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { closed = i; break; } }
        }
        if (closed > start) push(text.slice(start, closed + 1));
    }
    return out;
}

/** 逐个候选 JSON.parse，返回第一个「对象且含 scenes 数组」的结果；都没有返回 null。 */
function parseDemandRecord(text: string): Record<string, unknown> | null {
    for (const candidate of extractJsonCandidates(text)) {
        try {
            const value = JSON.parse(candidate);
            if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).scenes)) {
                return value as Record<string, unknown>;
            }
        } catch { /* 候选不是合法 JSON，试下一个 */ }
    }
    return null;
}

function asText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export type ChapterDemandParseOptions = {
    environments?: ChapterDemandEnvironment[];
    /** 合法角色 ID 全集（character_registry.id）；给定时 beat.character_ids 仅保留命中项。 */
    allowedCharacterIds?: Set<string>;
    /** 合法道具资产 ID 全集（asset_cards.id, kind=prop）；给定时 beat.prop_ids 仅保留命中项。 */
    allowedPropIds?: Set<string>;
    /** 合法场景 ID 全集（environmentId）；给定时 beat.scene_id 非法则清空。 */
    allowedSceneIds?: Set<string>;
};

/**
 * 白名单过滤 + 保序去重：非法 id 丢弃，合法项按模型给出的顺序保留，重复项只留第一次。
 * allowed 未给定时不过滤（向后兼容老调用方）。
 */
function filterRefIds(value: unknown, allowed?: Set<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(value) ? value : []) {
        const id = asText(raw);
        if (!id || seen.has(id) || (allowed && !allowed.has(id))) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * 解析模型回包。结构性错误抛 `CHAPTER_DEMAND_*`，与制作台的报错风格一致。
 * `environments` 给定时会校验 environmentId 是否在清单内（模型最容易在这里瞎编）。
 * 结构化引用 id 同样走白名单：编造的 character_ids / prop_ids / scene_id 一律丢弃。
 */
export function parseChapterDemand(text: string, options: ChapterDemandParseOptions = {}): ChapterDemandDraft {
    const record = parseDemandRecord(String(text ?? ""));
    if (!record) throw new Error("CHAPTER_DEMAND_JSON: 回包里没有可解析的 scenes JSON 对象");
    const demand = asText(record.demand);
    if (!demand) throw new Error("CHAPTER_DEMAND_EMPTY: 缺少 demand 正文");
    const rawScenes = Array.isArray(record.scenes) ? record.scenes : [];
    if (!rawScenes.length) throw new Error("CHAPTER_DEMAND_SCENES: 没有场次");
    const allowed = new Set((options.environments || []).map(item => item.id));
    const scenes: ChapterScenePlan[] = rawScenes.map((item, index) => {
        const scene = item && typeof item === "object" ? item as Record<string, unknown> : {};
        let environmentId = asText(scene.environmentId);
        // 容错：模型可能把清单整行 "ID｜场景名" 照抄到 environmentId；取「｜」前的 ID 段。
        if (environmentId.includes("｜") && !allowed.has(environmentId)) environmentId = environmentId.split("｜")[0].trim();
        if (allowed.size && !allowed.has(environmentId)) throw new Error(`CHAPTER_DEMAND_ENVIRONMENT: 第 ${index + 1} 个场次的 environmentId 不在已登记清单内：${environmentId || "(空)"}`);
        const beats = (Array.isArray(scene.beats) ? scene.beats : []).map((beat, beatIndex) => {
            const row = beat && typeof beat === "object" ? beat as Record<string, unknown> : {};
            const seconds = Number(row.seconds);
            let rawSceneId = asText(row.scene_id);
            if (rawSceneId.includes("｜") && options.allowedSceneIds && !options.allowedSceneIds.has(rawSceneId)) rawSceneId = rawSceneId.split("｜")[0].trim();
            const sceneId = options.allowedSceneIds && rawSceneId && !options.allowedSceneIds.has(rawSceneId) ? "" : rawSceneId;
            return {
                title: asText(row.title) || `镜头 ${beatIndex + 1}`,
                visual: asText(row.visual),
                camera: asText(row.camera),
                seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 2,
                dialogue: asText(row.dialogue) || undefined,
                speaker: asText(row.speaker) || undefined,
                characterIds: filterRefIds(row.character_ids, options.allowedCharacterIds),
                propIds: filterRefIds(row.prop_ids, options.allowedPropIds),
                sceneId,
                // 分镜可拍性字段：模型给了就透传，缺了由 chapter-storyboard 按旧逻辑兜底。
                shotSize: asText(row.shotSize) || undefined,
                action: asText(row.action) || undefined,
                imagePrompt: asText(row.imagePrompt) || undefined,
                videoPrompt: asText(row.videoPrompt) || undefined,
                sourceQuote: asText(row.sourceQuote) || undefined,
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
    const secondsPerBeat = Math.max(1, Number(input.secondsPerBeat) || 4);
    const beatChars = Math.max(40, Math.floor(input.beatChars ?? FALLBACK_BEAT_CHARS));
    const paragraphs = String(input.chapterBody || "").split(/\n{2,}|\n/).map(line => line.trim()).filter(Boolean);
    const beats: ChapterBeat[] = [];
    // 影策节奏：兜底也按剧情内容给时长 hint，不再一律 3 秒。含情绪/关键动作词的镜头给 6-7 秒长镜，其余 4 秒。
    const emotionalRe = /笑|泪|哭|望|回身|回首|坐|跪|睡|沉默|痴|惊|喜|怒|哀|惧|愣|怔|叹|犹豫|对视|抱|握|留|信|酒|哭诉|求/;
    const actionRe = /奔|冲|追|打|斗|战|刺|斩|逃|飞|跃|跌|倒|吞|袭|赶|挥|拔|射/;
    for (const paragraph of paragraphs) {
        for (let offset = 0; offset < paragraph.length; offset += beatChars) {
            const slice = paragraph.slice(offset, offset + beatChars).trim();
            if (!slice) continue;
            const hint = emotionalRe.test(slice) ? 7 : actionRe.test(slice) ? 4 : secondsPerBeat;
            // 兜底不猜引用：角色/道具留空，场景引用就是本场次环境 ID（不做 scene_registry.id 臆造）。
            beats.push({ title: `节拍 ${beats.length + 1}`, visual: slice, seconds: hint, characterIds: [], propIds: [], sceneId: environmentId });
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
