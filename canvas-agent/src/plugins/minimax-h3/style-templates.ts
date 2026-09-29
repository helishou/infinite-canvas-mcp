/**
 * 视觉风格模板：H3 设置里可选择的固定英文风格词。
 *
 * 模板正文仅在运行时插到对应描述段落的最前面；旧版保存的模板前缀可识别并剥离。
 */

export type H3StyleTemplate = {
    id: string;
    /** UI 显示名（中文），对应提示词库里的模板标题。 */
    label: string;
    /** 注入提示词的英文风格词。 */
    text: string;
};

export const H3_STYLE_TEMPLATES: readonly H3StyleTemplate[] = [
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

/** 空串 = 不加模板（null 选项）。 */
export type H3StyleTemplateId = string;

export function styleTemplateText(id: H3StyleTemplateId | null | undefined): string {
    if (!id) return "";
    return H3_STYLE_TEMPLATES.find((template) => template.id === id)?.text || "";
}

export function isH3StyleTemplateId(id: unknown): id is H3StyleTemplateId {
    return typeof id === "string" && H3_STYLE_TEMPLATES.some((template) => template.id === id);
}

/**
 * 识别旧提示词开头区域中的模板。兼容旧版分镜编辑的直接前缀，
 * 以及 MCP 在分镜指导语之后写入的模板。
 */
export function matchStyleTemplatePrefix(text: string): { id: H3StyleTemplateId; rest: string } | null {
    const body = text.trim();
    if (!body) return null;
    // 模板之间有共享句，先按文本长度降序匹配最长的完整段落。
    const candidates = [...H3_STYLE_TEMPLATES].sort((left, right) => right.text.length - left.text.length);
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
export function stripStyleTemplatePrefix(text: string): string {
    return matchStyleTemplatePrefix(text)?.rest ?? text.trim();
}

/** 旧版保存提示词所用的组合方式；运行时注入使用 applyH3StyleTemplate。 */
export function composeStoryboardOpening(styleTemplateId: H3StyleTemplateId | null | undefined, openingDescription: string): string {
    return [styleTemplateText(styleTemplateId), openingDescription.trim()].filter(Boolean).join("\n\n");
}

function descriptionSection(prompt: string, mode: string) {
    const name = mode === "ref2va" ? "detailed_description" : "integrated_multimodal_description";
    const header = new RegExp(`^${name}\\s*[:：][ \\t]*(?:\\r?\\n)?`, "mi").exec(prompt);
    if (!header) return null;
    const start = header.index + header[0].length;
    const remainder = prompt.slice(start);
    const next = /^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*[:：]/mi.exec(remainder);
    return { start, end: start + (next?.index ?? remainder.length) };
}

export function styleTemplateFromPrompt(prompt: string, mode: string): H3StyleTemplateId | null {
    const section = descriptionSection(prompt, mode);
    if (!section) return null;
    const body = prompt.slice(section.start, section.end);
    const firstShot = /^[ \t]*\[Shot[ \t]+\d+\]/mi.exec(body);
    return matchStyleTemplatePrefix(body.slice(0, firstShot?.index ?? body.length))?.id ?? null;
}

/** Apply a Clip setting to this submission only. A recognized saved legacy prefix is replaced, never stacked. */
export function applyH3StyleTemplate(prompt: string, mode: string, selectedId: H3StyleTemplateId | null | undefined): string {
    const section = descriptionSection(prompt, mode);
    const legacyId = styleTemplateFromPrompt(prompt, mode);
    const effectiveId = selectedId === undefined ? legacyId : selectedId;
    const style = styleTemplateText(effectiveId);
    if (!section) return style ? `${style}\n\n${prompt}` : prompt;
    if (!style && !legacyId) return prompt;
    const body = prompt.slice(section.start, section.end);
    const firstShot = /^[ \t]*\[Shot[ \t]+\d+\]/mi.exec(body);
    const opening = body.slice(0, firstShot?.index ?? body.length);
    const rest = body.slice(firstShot?.index ?? body.length).trim();
    const cleanOpening = matchStyleTemplatePrefix(opening)?.rest ?? opening.trim();
    const nextBody = [style, cleanOpening, rest].filter(Boolean).join("\n\n");
    const suffix = prompt.slice(section.end).trimStart();
    return `${prompt.slice(0, section.start)}${nextBody}${suffix ? `\n\n${suffix}` : ""}`;
}
