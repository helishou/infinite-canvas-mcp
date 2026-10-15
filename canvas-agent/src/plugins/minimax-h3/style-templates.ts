/**
 * 视觉风格模板：H3 设置里可选择的固定英文风格词。
 *
 * 模板正文仅在运行时注入 summary；旧版保存在描述段落中的模板前缀可识别并迁移。
 */

export type H3StyleTemplate = {
    id: string;
    /** UI 显示名（中文），对应提示词库里的模板标题。 */
    label: string;
    /** 注入提示词的英文风格词。 */
    text: string;
};

export type H3CustomStyleTemplate = H3StyleTemplate;

export function normalizeH3CustomStyleTemplates(value: unknown): H3StyleTemplate[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: H3StyleTemplate[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const template = item as Record<string, unknown>;
        const id = typeof template.id === "string" ? template.id.trim() : "";
        const label = typeof template.label === "string" ? template.label.trim() : "";
        const text = typeof template.text === "string" ? template.text.trim() : "";
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/i.test(id) || seen.has(id) || !label || !text) continue;
        seen.add(id);
        result.push({ id, label: label.slice(0, 80), text: text.slice(0, 12000) });
    }
    return result;
}

// 保留旧正文用于识别历史提示词；修订后的模板运行时替换旧前缀，不改写已保存内容。
const ORIGINAL_H3_STYLE_TEMPLATES: readonly H3StyleTemplate[] = [
    {
        id: "japanese-ccd",
        label: "日式CCD",
        text: [
            "Visual style: Japanese CCD film-camera portrait; fair cool-toned skin, smooth and dewy, with an idol-like beauty.",
            "Long-lens candid dynamic framing, shallow depth of field, high-key bright exposure, pale and fresh delicate color palette with strong airy presence.",
            "Hair strands carry a soft sheen, pink lips slightly parted, fair translucent skin, a faint gloss along the shoulders and neck.",
            "Facial soft light stays even, the shadows beside the nose wings and under the chin stay gentle with no hard edges, pearl-white skin tone.",
        ].join(" "),
    },
    {
        id: "cold-xianxia",
        label: "清冷仙侠风",
        text: [
            "Visual style: cold and ethereal xianxia, dreamlike ancient-Chinese aesthetic.",
            "Filter and color: low-saturation Morandi tonality with a soft bloom and a light film grain; the palette settles into cool cyan-blue and soft gray-white, accented locally by the flushed crimson of eye makeup and lip color.",
            "Atmosphere: ultra-shallow depth of field and dreamy defocus, building a cold, aloof and faintly lethal sense of a destined fighter, where divinity and fragmentation intertwine.",
        ].join(" "),
    },
    {
        id: "hong-kong-retro",
        label: "港风",
        text: [
            "Visual style: retro Hong Kong street style, 1990s film-cinema look.",
            "Filter and color: high-ISO film grain filter with heavy, murky green-yellow shadow tones. A direct on-camera flash hits the subject, creating a high-contrast hard-light quality.",
        ].join(" "),
    },
    {
        id: "french-cream",
        label: "法式奶油",
        text: [
            "Visual style: creamy backlit film, languid and elegant, in the golden hour of the afternoon.",
            "Hair glows and lens flare blooms; cream white and warm brown, low-contrast Morandi tonality, light film grain.",
            "Skin stays supple, highlights spill softly, daylight leans warm. Sunlight passes through the hair into a golden-brown rim, fine dust drifts in the air.",
            "Cream, oat, dusty pink and sage green, with a soft misty halo over the frame.",
        ].join(" "),
    },
    {
        id: "modern-korean",
        label: "现代韩系",
        text: [
            "Visual style: smooth dewy luminous skin with an idol-like beauty; long-lens candid dynamic framing with shallow depth of field; high-key bright exposure; pale, fresh, delicate color palette.",
            "Modern Korean webtoon / Korean-manhwa aesthetic, low-contrast soft-focus matte filter with diffusion glow, low-saturation color grading mixing cool and warm tones.",
            "The background is bright overexposed cool white window light; the character carries a faint warm daylight and natural skin tone, producing a soft, delicate film texture.",
            "For atmosphere, use a wide-aperture shallow depth of field with dreamy blurred falloff, shaping a sun-drenched, gently tipsy mood that is tensioned yet gentle, feminine and restrained.",
        ].join(" "),
    },
    {
        id: "soft-light",
        label: "柔光",
        text: [
            "Visual style: smooth dewy luminous skin with an idol-like beauty; long-lens candid dynamic framing with shallow depth of field; high-key bright exposure; pale, fresh, delicate color palette with strong airy presence.",
            "Modern Korean webtoon / Korean-manhwa aesthetic, low-contrast soft-focus matte filter with diffusion glow, low-saturation color grading mixing cool and warm tones.",
            "The background is bright overexposed cool white window light; the character carries a faint warm daylight and natural skin tone, producing a soft, delicate film texture.",
            "For atmosphere, use a wide-aperture shallow depth of field with dreamy blurred falloff, shaping a sun-drenched, gently tipsy mood that is tensioned yet gentle, feminine and restrained.",
        ].join(" "),
    },
] as const;

const SCENE_PRESERVING_STYLES: Readonly<Record<string, string>> = {
    "modern-korean": [
        "Visual style: modern Korean webtoon / Korean-manhwa aesthetic, delicate low-saturation colors with balanced cool and warm tones, soft-focus matte texture and subtle diffusion glow.",
        "Keep natural skin tones and gently rolled highlights, with clear environmental detail and restrained contrast.",
        "Apply this style consistently as color grading and image texture to the specified scene. Preserve the described location, background, time of day, lighting direction, framing, character appearance and actions throughout every shot; scene and shot instructions take priority over the style treatment.",
    ].join(" "),
    "soft-light": [
        "Visual style: gentle photographic diffusion, smooth highlight rolloff, soft tonal transitions and a delicate film texture, with natural skin tones and balanced cool and warm colors.",
        "Retain background detail and readable shadows at the exposure specified by the scene.",
        "Apply this style consistently as color grading and image texture to the specified scene. Preserve the described location, background, time of day, lighting direction, framing, character appearance and actions throughout every shot; scene and shot instructions take priority over the style treatment.",
    ].join(" "),
};

export const H3_STYLE_TEMPLATES: readonly H3StyleTemplate[] = ORIGINAL_H3_STYLE_TEMPLATES.map((template) => ({
    ...template,
    text: SCENE_PRESERVING_STYLES[template.id] ?? template.text,
}));

export function resolveH3StyleTemplates(custom: unknown): H3StyleTemplate[] {
    const overrides = normalizeH3CustomStyleTemplates(custom);
    const byId = new Map(overrides.map((item) => [item.id, item]));
    return [
        ...H3_STYLE_TEMPLATES.map((item) => byId.get(item.id) || item),
        ...overrides.filter((item) => !H3_STYLE_TEMPLATES.some((base) => base.id === item.id)),
    ];
}

/** 空串 = 不加模板（null 选项）。 */
export type H3StyleTemplateId = string;

export function styleTemplateText(id: H3StyleTemplateId | null | undefined, custom: unknown = []): string {
    if (!id) return "";
    return resolveH3StyleTemplates(custom).find((template) => template.id === id)?.text || "";
}

export function isH3StyleTemplateId(id: unknown, custom: unknown = []): id is H3StyleTemplateId {
    return typeof id === "string" && resolveH3StyleTemplates(custom).some((template) => template.id === id);
}

/**
 * 识别旧提示词开头区域中的模板。兼容旧版分镜编辑的直接前缀，
 * 以及 MCP 在分镜指导语之后写入的模板。
 */
export function matchStyleTemplatePrefix(text: string, custom: unknown = []): { id: H3StyleTemplateId; rest: string } | null {
    const body = text.trim();
    if (!body) return null;
    // 模板之间有共享句，先按文本长度降序匹配最长的完整段落。
    const candidates = [...resolveH3StyleTemplates(custom), ...ORIGINAL_H3_STYLE_TEMPLATES]
        .sort((left, right) => right.text.length - left.text.length);
    for (const template of candidates) {
        const index = body.indexOf(template.text);
        if (index < 0 || (index > 0 && !body.slice(0, index).endsWith("\n\n"))) continue;
        const after = index + template.text.length;
        if (after < body.length && !body.slice(after).startsWith("\n\n")) continue;
        return { id: template.id, rest: [body.slice(0, index).trim(), body.slice(after).trim()].filter(Boolean).join("\n\n") };
    }
    return null;
}

/**
 * 载入分镜编辑时，把旧版已保存的风格词从开头总体描述里剥掉，
 * 否则用户会看到（并编辑）一段不可编辑的重复前缀。未知前缀原样保留。
 */
export function stripStyleTemplatePrefix(text: string, custom: unknown = []): string {
    return matchStyleTemplatePrefix(text, custom)?.rest ?? text.trim();
}

/** 旧版保存提示词所用的组合方式；运行时注入使用 applyH3StyleTemplate。 */
export function composeStoryboardOpening(styleTemplateId: H3StyleTemplateId | null | undefined, openingDescription: string, custom: unknown = []): string {
    return [styleTemplateText(styleTemplateId, custom), openingDescription.trim()].filter(Boolean).join("\n\n");
}

function promptSection(prompt: string, name: string) {
    const header = new RegExp(`^${name}\\s*[:：][ \\t]*(?:\\r?\\n)?`, "mi").exec(prompt);
    if (!header) return null;
    const start = header.index + header[0].length;
    const remainder = prompt.slice(start);
    const next = /^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*[:：]/mi.exec(remainder);
    return { start, end: start + (next?.index ?? remainder.length) };
}

function descriptionSection(prompt: string, mode: string) {
    return promptSection(prompt, mode === "ref2va" ? "detailed_description" : "integrated_multimodal_description");
}

function summaryTemplate(summary: string, custom: unknown = []) {
    const marker = /^(\s*\[[^\]]+\]\s*)([\s\S]*)$/u.exec(summary);
    const prefix = marker?.[1] || "";
    const body = marker ? marker[2] : summary;
    const match = matchStyleTemplatePrefix(body, custom);
    return match ? { id: match.id, prefix, rest: match.rest } : null;
}

function summaryWithTemplate(summary: string, style: string, custom: unknown = []) {
    const existing = summaryTemplate(summary, custom);
    const marker = /^(\s*\[[^\]]+\]\s*)([\s\S]*)$/u.exec(summary);
    const prefix = existing?.prefix || marker?.[1] || "";
    const body = existing?.rest ?? (marker ? marker[2].trim() : summary.trim());
    return [prefix.trim(), style, body].filter(Boolean).join("\n\n");
}

export function styleTemplateFromPrompt(prompt: string, mode: string, custom: unknown = []): H3StyleTemplateId | null {
    const section = descriptionSection(prompt, mode);
    const summary = promptSection(prompt, "summary");
    const summaryMatch = summary && summaryTemplate(prompt.slice(summary.start, summary.end), custom)?.id;
    if (summaryMatch) return summaryMatch;
    if (!section) return null;
    const body = prompt.slice(section.start, section.end);
    const firstShot = /^[ \t]*\[Shot[ \t]+\d+\]/mi.exec(body);
    return matchStyleTemplatePrefix(body.slice(0, firstShot?.index ?? body.length), custom)?.id ?? null;
}

/** Apply a Clip setting to this submission only. A recognized saved legacy prefix is replaced, never stacked. */
export function applyH3StyleTemplate(prompt: string, mode: string, selectedId: H3StyleTemplateId | null | undefined, custom: unknown = []): string {
    const section = descriptionSection(prompt, mode);
    const legacyId = styleTemplateFromPrompt(prompt, mode, custom);
    const effectiveId = selectedId === undefined ? legacyId : selectedId;
    const style = styleTemplateText(effectiveId, custom);
    if (!style && !legacyId) return prompt;
    let result = prompt;
    if (section) {
        const body = result.slice(section.start, section.end);
        const firstShot = /^[ \t]*\[Shot[ \t]+\d+\]/mi.exec(body);
        const opening = body.slice(0, firstShot?.index ?? body.length);
        const rest = body.slice(firstShot?.index ?? body.length).trim();
        const cleanOpening = matchStyleTemplatePrefix(opening, custom)?.rest ?? opening.trim();
        const nextBody = [cleanOpening, rest].filter(Boolean).join("\n\n");
        const suffix = result.slice(section.end).trimStart();
        result = `${result.slice(0, section.start)}${nextBody}${suffix ? `\n\n${suffix}` : ""}`;
    }
    const summary = promptSection(result, "summary");
    if (summary) {
        const body = result.slice(summary.start, summary.end);
        const nextBody = summaryWithTemplate(body, style, custom);
        const suffix = result.slice(summary.end).trimStart();
        result = `${result.slice(0, summary.start)}${nextBody}${suffix ? `\n\n${suffix}` : ""}`;
    } else if (style) {
        result = `summary:\n${style}\n\n${result.trimStart()}`;
    }
    return result;
}
