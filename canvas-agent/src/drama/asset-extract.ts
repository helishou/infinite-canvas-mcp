/**
 * 剧本 → 设定提取（纯函数，不发起模型调用）。
 *
 * 对齐影策 script 阶段 `cast[]` 产物（production/prompts.go:311-315）：
 * 影策在一次剧本 LLM 调用里同时产出镜头表 + 新设定 cast（角色/道具/场景/造型的
 * appearance/voice），由 applyScriptShots 即时建档。本地改编只出分场文本、拆镜草案
 * 只有 speaker/scene，没有结构化外貌，所以资产库空、视频无参考图。
 *
 * 本模块的职责：把「分场文本 / 拆镜草案」包成一次文本调用能吃的 prompt，让模型回
 * {characters,props,scenes}（每个带可直接生图的外貌描述），再把回包容错解析成可建档的
 * 设定列表。调用方拿到结果后用 createManualDirectorAsset 写 create_manual_director_asset op。
 */
import type { AssetKind } from "./asset-kind.js";

export type ExtractedAsset = {
    kind: AssetKind;
    name: string;
    /** 可直接用于生图的外貌/外观描述。 */
    appearance: string;
    /** 角色声线（可选）。 */
    voice?: string;
};

export type AssetExtractPromptInput = {
    chapterTitle: string;
    /** 分场文本（episode.synopsis，形如「场N｜内景·地点｜日夜｜人物｜事件」）。 */
    synopsis: string;
    /** 拆镜草案里出现的说话人（兜底线索）。 */
    speakers?: string[];
    /** 拆镜草案里出现的场景名（兜底线索）。 */
    scenes?: string[];
    /** 已建档的设定名，要求模型不要重复产出。 */
    existingNames?: string[];
};

export function buildAssetExtractPrompt(input: AssetExtractPromptInput) {
    const existing = (input.existingNames || []).filter(Boolean);
    const speakerHint = (input.speakers || []).filter(Boolean);
    const sceneHint = (input.scenes || []).filter(Boolean);
    const system = [
        "你是短剧美术设定提取师。从给定分场剧本里提取需要制作参考图的角色、道具、场景。",
        "只输出一个 JSON 对象，不要解释、不要 Markdown 围栏。",
        "JSON 结构：",
        '{"characters":[{"name":"角色名","appearance":"可直接用于生图的外貌描述：年龄、体态、五官、发型、服装、标志物","voice":"声线描述（可空）"}],"props":[{"name":"道具名","appearance":"可直接用于生图的外观描述"}],"scenes":[{"name":"场景名","appearance":"可直接用于生图的环境描述：地点、建筑、陈设、光线"}]}',
        "硬性要求：",
        "1. 只提取剧本里实际出现、且需要稳定视觉形象的实体；旁白、纯概念不提取。",
        "2. appearance 必须具体可视（可据此生图），不要写「见原文」「同上」「略」。",
        "3. 每个实体只出现一次，名字用剧中最常用的称呼；不要新增剧本没有的实体。",
        ...(existing.length ? [`4. 以下设定已建档，不要重复产出：${existing.join("、")}。`] : []),
        ...(speakerHint.length ? [`本集说话人线索：${speakerHint.join("、")}。`] : []),
        ...(sceneHint.length ? [`本集场景线索：${sceneHint.join("、")}。`] : []),
    ].join("\n");
    const user = [
        `分集标题：${input.chapterTitle}`,
        "分场剧本：",
        input.synopsis,
    ].join("\n");
    return { system, user };
}

/** 从模型回包里取出 JSON：容忍 ```json 围栏与前后闲聊。 */
function extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("回包里没有 JSON 对象");
    return JSON.parse(body.slice(start, end + 1));
}

const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";

/**
 * 解析模型回包为设定列表；去重（同名同类型只留一个）、过滤空 appearance。
 * 容忍字段缺失与少量闲聊，但要求至少提取出一条，否则抛错让调用方走兜底。
 */
export function parseAssetExtract(text: string): ExtractedAsset[] {
    const json = extractJson(text) as Record<string, unknown>;
    const out: ExtractedAsset[] = [];
    const seen = new Set<string>();
    const push = (kind: AssetKind, items: unknown[]) => {
        for (const item of items) {
            const row = (item || {}) as Record<string, unknown>;
            const name = str(row.name);
            const appearance = str(row.appearance) || str(row.description);
            if (!name || !appearance) continue;
            const key = `${kind}:${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const voice = str(row.voice) || str(row.voice_description);
            out.push({ kind, name, appearance, ...(voice ? { voice } : {}) });
        }
    };
    push("character", arr(json.characters));
    push("prop", arr(json.props));
    push("scene", arr(json.scenes));
    if (!out.length) throw new Error("没有从剧本里提取出可建档的设定");
    return out;
}

/**
 * 规则兜底：模型不可用/回包不可解析时，从说话人+场景线索建最小设定。
 * 保真度低（外貌只能写占位），但能让资产库立起来，用户可在资产页补全后生成参考图。
 */
export function fallbackAssetExtract(input: AssetExtractPromptInput): ExtractedAsset[] {
    const out: ExtractedAsset[] = [];
    const seen = new Set<string>();
    for (const name of (input.speakers || []).filter(Boolean)) {
        const key = `character:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "character", name, appearance: `角色「${name}」：外貌待补充，请在资产页补全后生成参考图。` });
    }
    for (const name of (input.scenes || []).filter(Boolean)) {
        const key = `scene:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "scene", name, appearance: `场景「${name}」：环境外观待补充，请在资产页补全后生成参考图。` });
    }
    return out;
}
