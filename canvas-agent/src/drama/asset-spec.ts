import { normalizeArtStyle, withArtStyle } from "./art-style.js";
import { z } from "zod";

/**
 * 角色 / 场景 / 道具的设定卡：字段照抄「导演大师」的资产设定，
 * 三种资产各有一份提示词骨架和对应技能文件——生图时不是"写一段描述"，而是按类型的固定结构写。
 *
 * 真值落在资产自身（asset.metadata.assetSpec），不新建第二份资产，
 * 分镜与编译用的摘要由 `assetSpecSummary()` 现场生成。
 */

export const assetSpecKinds = ["character", "scene", "prop"] as const;
export type AssetSpecKind = (typeof assetSpecKinds)[number];

const line = z.string().max(4000).optional();

export const characterSpecSchema = z.object({
    age: line.describe("年龄，可带状态说明（如「四十余岁（殁年）」）"),
    gender: line.describe("性别"),
    identity: line.describe("公开身份"),
    trueIdentity: line.describe("真实身份 / 暗线身份，与公开身份分开写"),
    personality: line.describe("性格，用顿号连写六到八个词"),
    appearance: line.describe("外形：身形、面容、惯穿衣物、随身物件，写具体材质与颜色"),
    motivation: line.describe("欲望：这一层要什么"),
    conflict: line.describe("冲突：什么让他难做"),
    catchphrase: line.describe("口头禅或标志台词"),
    role: z.enum(["hero", "supporting", "cameo"]).optional(),
    arc: line.describe("弧光：从哪到哪"),
    tags: z.array(z.string()).default([]),
    relationships: z.array(z.object({ name: z.string(), relation: z.string() }).strict()).default([]),
    negativePrompt: line.describe("负面词：不要出现的东西"),
}).strict();

export const sceneSpecSchema = z.object({
    lighting: line.describe("光线：时段、主光方向、明暗关系"),
    landmarks: line.describe("陈设与方位：正堂居中、东厢靠窗……按空间顺序写"),
    styleNotes: line.describe("质感与风格：写实电影/工笔、主色、氛围"),
    negativePrompt: line.describe("负面词：默认排除人物、文字、水印、分格"),
}).strict();

export const propSpecSchema = z.object({
    material: line.describe("材质、工艺、磨损与污渍"),
    sizeNote: line.describe("尺寸与比例：高宽厚、可否佩戴、与人体关系"),
    styleNotes: line.describe("质感与风格"),
    negativePrompt: line.describe("负面词：真人、使用动作、多余道具、文字、标注"),
}).strict();

export const assetSpecSchema = z.object({
    kind: z.enum(assetSpecKinds),
    character: characterSpecSchema.optional(),
    scene: sceneSpecSchema.optional(),
    prop: propSpecSchema.optional(),
    updatedAt: z.string().optional(),
}).strict();

export type CharacterSpec = z.infer<typeof characterSpecSchema>;
export type SceneSpec = z.infer<typeof sceneSpecSchema>;
export type PropSpec = z.infer<typeof propSpecSchema>;
export type AssetSpec = z.infer<typeof assetSpecSchema>;

/** 三种资产各自的技能文件：生图前必须先读对应那份，不凭手感写提示词。 */
export const ASSET_KIND_SKILL: Record<AssetSpecKind, { skill: string; path: string; section: string; imageKind: string }> = {
    character: {
        skill: "canvas-video-production-sop",
        path: ".agents/skills/canvas-video-production-sop/references/角色资产与场景生成-即梦5或MJ.md",
        section: "二、角色提示词",
        imageKind: "角色设定三视图",
    },
    scene: {
        skill: "canvas-video-production-sop",
        path: ".agents/skills/canvas-video-production-sop/references/角色资产与场景生成-即梦5或MJ.md",
        section: "三、场景提示词（空镜、无人、无物）",
        imageKind: "场景主图",
    },
    prop: {
        skill: "canvas-video-production-sop",
        path: ".agents/skills/canvas-video-production-sop/references/角色资产与场景生成-即梦5或MJ.md",
        section: "四、道具提示词",
        imageKind: "道具设定图",
    },
};

const filled = (value?: string) => Boolean(String(value || "").trim());

/** 这一种资产要填哪些字段、现在缺哪些——生成前拿来自查，不写完不出图。 */
export function requiredAssetSpecFields(kind: AssetSpecKind): Array<{ key: string; label: string }> {
    if (kind === "character") {
        return [
            { key: "age", label: "年龄" }, { key: "gender", label: "性别" }, { key: "identity", label: "公开身份" },
            { key: "personality", label: "性格" }, { key: "appearance", label: "外形" },
            { key: "motivation", label: "欲望" }, { key: "conflict", label: "冲突" },
        ];
    }
    if (kind === "scene") return [{ key: "lighting", label: "光线" }, { key: "landmarks", label: "陈设与方位" }, { key: "styleNotes", label: "质感与风格" }];
    return [{ key: "material", label: "材质" }, { key: "sizeNote", label: "尺寸与比例" }, { key: "styleNotes", label: "质感与风格" }];
}

export function missingAssetSpecFields(kind: AssetSpecKind, spec: AssetSpec | null | undefined): string[] {
    const bucket = spec?.[kind] as Record<string, unknown> | undefined;
    return requiredAssetSpecFields(kind)
        .filter(field => !filled(String(bucket?.[field.key] ?? "")))
        .map(field => field.label);
}

/**
 * 按类型拼生图提示词。三段结构分别对应技能文件里的模板：
 * - 角色：三视图（正/侧/背，同一人同一衣）+ 面部特写；
 * - 场景：无人空镜主图，横版 16:9，近/中/远景分层 + 光线；
 * - 道具：左侧大特写 + 右侧 2×2 四角度，材质与尺寸必须写死。
 */
export function buildAssetImagePrompt(kind: AssetSpecKind, spec: AssetSpec, name: string, options: { aspect?: string; extra?: string; artStyle?: string; language?: string } = {}): string {
    return withArtStyle(buildAssetBasePrompt(kind, spec, name, options), options.artStyle, options.language);
}

/** 不含画风的骨架句；画风由 buildAssetImagePrompt 统一追加，避免两处各拼一遍。 */
function buildAssetBasePrompt(kind: AssetSpecKind, spec: AssetSpec, name: string, options: { aspect?: string; extra?: string } = {}): string {
    const negative = String((spec[kind] as Record<string, unknown> | undefined)?.negativePrompt || "").trim();
    const tail = [options.extra ? options.extra.trim() : "", negative ? `【负面】${negative}` : ""].filter(Boolean).join("\n");

    if (kind === "character") {
        const s = (spec.character || {}) as CharacterSpec;
        return [
            `角色设定三视图｜${name}`,
            `【三视图】同一人同一身衣服的正面、侧面、背面三个全身站姿并排，双脚站在同一条地平线上，身高一致、衣纹一致：${name}，${s.age || ""}，${s.gender || ""}，${s.appearance || ""}`,
            `【神态】${s.personality || "克制、自然"}，神情与身份相符（${s.identity || "主要角色"}），不摆夸张动作。`,
            `【构图】左侧三分之二给三视图，右侧三分之一给一张面部特写；背景干净纯色，全身完整入画，不裁切，不出现第二个人。`,
            tail,
        ].filter(Boolean).join("\n");
    }
    if (kind === "scene") {
        const s = (spec.scene || {}) as SceneSpec;
        return [
            `场景主图｜${name}`,
            `【主场景】平视略俯机位，横版${options.aspect || "16:9"}铺满画面，画面里没有人。近景、中景、远景分层写清空间关系：${s.landmarks || ""}`,
            `【光线】${s.lighting || ""}`,
            `【质感】${s.styleNotes || ""}`,
            tail,
        ].filter(Boolean).join("\n");
    }
    const s = (spec.prop || {}) as PropSpec;
    return [
        `道具设定图｜${name}`,
        `【主视图】画面左侧约占宽度六成，是${name}的大特写，3/4 视角，器物完整入画，四周留白，背景干净；轮廓高大于宽大于厚。`,
        `【材质】${s.material || ""}`,
        `【尺寸】${s.sizeNote || ""}`,
        `【多角度】画面右侧是一块正方形区域，严格 2×2 四格等大、细线分隔：同一件器物、同一磨损、同一光线，只改观察角度（正面、侧面、背面、俯视局部）。`,
        `【质感】${s.styleNotes || ""}`,
        tail,
    ].filter(Boolean).join("\n");
}

/** 给分镜/编译用的简短设定摘要：只取外形、光线、材质这类必须一致的部分。 */
export function assetSpecSummary(kind: AssetSpecKind, spec: AssetSpec | null | undefined): string {
    if (!spec) return "";
    if (kind === "character") {
        const s = spec.character; if (!s) return "";
        return [s.age, s.gender, s.appearance, s.personality].filter(Boolean).join("；");
    }
    if (kind === "scene") {
        const s = spec.scene; if (!s) return "";
        return [s.landmarks, s.lighting].filter(Boolean).join("；");
    }
    const s = spec.prop; if (!s) return "";
    return [s.material, s.sizeNote].filter(Boolean).join("；");
}

/** 缺字段时也允许先存草稿，但提示词生成要能看出缺口（不静默出图）。 */
export function assetSpecReadiness(kind: AssetSpecKind, spec: AssetSpec | null | undefined) {
    const missing = missingAssetSpecFields(kind, spec);
    const skill = ASSET_KIND_SKILL[kind];
    return {
        ready: missing.length === 0,
        missing,
        skill,
        hint: missing.length ? `先把${missing.join("、")}补上，再按「${skill.section}」写提示词` : `按「${skill.section}」写${skill.imageKind}`,
    };
}


/** 参考图方案：对齐影策 AssetScheme（assets.go）。内置方案全部横版 16:9。 */
export const ASSET_SCHEMES = [
    { id: "portrait", name: "定妆照", kinds: ["character"], defaultFor: "character",
      description: "单人正面半身，五官最清晰，适合对话多的短剧。",
      frameHint: "参考图为角色定妆照，只沿用五官、发型与服装" },
    { id: "turnaround", name: "三视图设定板", kinds: ["character"], defaultFor: "",
      description: "正面/侧面/背面全身同图，服装体型一致性最好，适合打戏与全身镜头。",
      frameHint: "参考图为三视图设定板，只沿用时外貌服装体型，不复制排版" },
    { id: "fourview", name: "四格资产板", kinds: ["character"], defaultFor: "",
      description: "面部特写+正侧背无脸四格，脸只出现一次，适合长剧跨集一致性。",
      frameHint: "参考图为四格资产板，面部以特写为准，服装体型以全身格为准" },
    { id: "scene", name: "场景空镜", kinds: ["scene"], defaultFor: "scene",
      description: "横版宽景、无人物空镜，前中后景分层。",
      frameHint: "参考图为场景空镜，只沿用空间布局与光线" },
    { id: "prop", name: "道具设定图", kinds: ["prop"], defaultFor: "prop",
      description: "横版单件道具居中、无人物，材质细节清晰。",
      frameHint: "参考图为道具设定图，只沿用道具外形材质颜色" },
] as const;
export type AssetSchemeId = (typeof ASSET_SCHEMES)[number]["id"];

/** 按资产类型取默认方案（角色=定妆照 / 场景=场景空镜 / 道具=道具设定图）。 */
export function defaultSchemeFor(kind: AssetSpecKind): AssetSchemeId {
    const found = ASSET_SCHEMES.find((s) => (s.defaultFor as string) === kind);
    return (found?.id as AssetSchemeId) || "portrait";
}

/** 方案是否适用于该资产类型。 */
export function schemeAppliesTo(scheme: AssetSchemeId, kind: AssetSpecKind): boolean {
    const found = ASSET_SCHEMES.find((s) => s.id === scheme);
    return Boolean(found && (found.kinds as readonly string[]).includes(kind));
}

/**
 * 按「方案 + 资产名 + 外观描述」拼参考图提示词（影策 CastImagePrompt 的本地等价）。
 * 直接渲染 `defaultAssetPromptTemplate()`，与模板路径逐字一致：不再追加「【参考图用法】」和画幅说明，
 * 用户长期规则只落在模板自带的 `{{画面规则}}` 位置（影策 CastImagePrompt 传 visualRules）。
 */
export function buildSchemePrompt(kind: AssetSpecKind, name: string, appearance: string,
    scheme: AssetSchemeId, options: { artStyle?: string; language?: string; rules?: string } = {}): string {
    const schemeInfo = ASSET_SCHEMES.find((s) => s.id === scheme);
    const template = defaultAssetPromptTemplate(kind, scheme);
    const rendered = fillAssetPromptTemplate(template, {
        项目画风: normalizeArtStyle(options.artStyle),
        资产名称: String(name ?? "").trim(),
        资产设定: String(appearance ?? "").trim(),
        画面规则: String(options.rules ?? "").trim(),
        方案名称: schemeInfo?.name || "",
        方案要求: schemeInfo?.frameHint || "",
    });
    return withTemplateArtStyle(rendered, template, options.artStyle, options.language);
}

/** 归一化后判断画风正文是否已渲染进提示词：忽略空白与标点，避免「全片统一画风：」前缀导致漏判。 */
function promptContainsStyle(prompt: string, style: string): boolean {
    const squash = (value: string) => value.replace(/[\s\p{P}]/gu, "");
    const needle = squash(style);
    return Boolean(needle) && squash(prompt).includes(needle);
}

/** 模板自带 `{{项目画风}}` 且画风已渲染时不再追加「全片统一画风」后缀，同一画风只出现一次。 */
function withTemplateArtStyle(prompt: string, template: string, style: unknown, language?: string): string {
    if (/\{\{\s*项目画风\s*\}\}/.test(template) && promptContainsStyle(prompt, normalizeArtStyle(style))) return prompt;
    return withArtStyle(prompt, stripFrameDirectives(style), language);
}

/** 去掉画风文本里与横版画幅冲突的指令（对齐影策 StripFrameDirectives）。 */export function stripFrameDirectives(style: unknown): string {
    return String(style ?? "")
        .replace(/最终输出画幅[^。\n]*[。\n]/g, "")
        .replace(/画幅(必须)?(为)?\s*(9:16|竖屏|竖版|2:3|3:4)/gi, "")
        .replace(/(9:16|竖屏|竖版)/gi, "")
        .replace(/[，,]{2,}/g, "，").replace(/^，|，$/g, "")
        .trim();
}

/**
 * 影策 `assets.go` 的内置参考图提示词模板，逐字照抄；只把影策变量名换成本地变量体系：
 * `{{角色名称}}/{{道具名称}}/{{场景名称}}` → `{{资产名称}}`，`{{角色设定}}/{{道具设定}}/{{场景设定}}` → `{{资产设定}}`。
 * 画幅由生成参数传，不写进文本；用户长期规则只落在模板自带的 `{{画面规则}}`。
 */
const propPrompt = "{{项目画风}}。道具设定图：{{资产名称}}。{{资产设定}}。\n横版构图，单件道具居中完整展示，四周留白，干净浅灰背景，柔和棚拍光，外形、材质、颜色与细节清晰；无人物、无手部。\n禁止文字、水印、边框。{{画面规则}}";

const scenePrompt = "{{项目画风}}。场景概念设定图：{{资产名称}}。{{资产设定}}。\n横版宽景构图，无人物，空镜，构图完整，主体空间与出入口清晰，前中后景层次分明；光源方向明确，色调与时代服化道统一。\n禁止文字、水印、边框。{{画面规则}}";

/** 角色定妆照 */
const portraitPrompt = "{{项目画风}}。角色定妆照：{{资产名称}}。{{资产设定}}。\n横版构图，单人居中，正面半身，中性表情，目视镜头；干净浅色纯背景，柔和均匀的正面光，五官、发型与服装细节清晰。\n禁止文字、水印、道具遮挡面部、额外人物。{{画面规则}}";

/** 三视图设定板 */
const turnaroundPrompt = "{{项目画风}}。专业人物三视图设定板：{{资产名称}}。{{资产设定}}。\n画面严格分成三个等宽竖向区域，从左到右依次为正面全身、右侧面全身、背面全身；三个视角是同一角色、同一服装、同一发型、同一体型与比例。\n站立中性姿势，完整显示头顶到脚底，不裁切头部和脚。纯净中性浅色背景，均匀设定稿光线，不改变项目画风的绘画或渲染媒介。\n禁止文字、边框、道具说明、表情变化和额外人物。{{画面规则}}";

/** 四格资产板 · 声纹 */
const fourViewPrompt = "{{项目画风}}。角色四格资产参考图：{{资产名称}}。{{资产设定}}。\n横版白色纯背景，全图共 4 格，等高排列：\n① 面部特写：唯一一张清晰的脸，五官、脸型、发际线、眉眼、鼻唇、肤色、痣与疤痕等特征完整锁定；\n② 正面全身（面部弱化）；③ 90° 侧面全身（面部弱化）；④ 背面全身。\n全身格从头顶到鞋底完整入画，不裁切头部；四格中的服装、发型、体型与配饰完全一致。\n画面底部一条细横带：声纹波形 / 频谱可视化图形，旁边一行不超过 8 个英文单词的音色标签。\n除音色标签外不出现任何文字。负面：全身格出现清晰五官、第二张可辨认的脸、马赛克或像素化遮挡、额外人物。{{画面规则}}";

/** 与影策 `renderAssetTemplate` 同口径：替换变量，未知变量原样保留，并清掉空变量残留的「。。」「：。」。 */
function fillAssetPromptTemplate(template: string, values: Record<string, string>, unknownVars?: string[]): string {
    const rendered = template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, key: string) => {
        if (key in values) return values[key];
        if (unknownVars && !unknownVars.includes(key)) unknownVars.push(key);
        return all;
    }).replace(/。。/g, "。").replace(/：。/g, "。").trim();
    // 影策 CastImagePrompt 总会兜底画风，本地画风可能为空；别让模板首句以孤立句号开头。
    if (!String(values["项目画风"] ?? "").trim() && /^\{\{\s*项目画风\s*\}\}。/.test(template)) {
        return rendered.replace(/^。\s*/, "");
    }
    return rendered;
}

/** 未单独覆盖的组合的通用模板：变量齐全、可直接渲染，不写死任何真实资产名。设置页「默认」档预填这一句。 */
export const ASSET_PROMPT_FALLBACK_TEMPLATE = "{{项目画风}}。{{方案名称}}：{{资产名称}}。{{资产设定}}\n{{方案要求}}\n{{画面规则}}";

/**
 * 某资产类型 + 方案的内置提示词模板（变量用 {{项目画风}}/{{资产名称}}/{{资产设定}}/{{画面规则}}）。
 * 正文与影策 `assets.go` 逐字一致；未单独覆盖的组合返回通用回退模板。
 */
export function defaultAssetPromptTemplate(kind: AssetSpecKind, scheme: AssetSchemeId): string {
    if (kind === "prop" && scheme === "prop") return propPrompt;
    if (kind === "scene" && scheme === "scene") return scenePrompt;
    if (kind === "character" && scheme === "portrait") return portraitPrompt;
    if (kind === "character" && scheme === "turnaround") return turnaroundPrompt;
    if (kind === "character" && scheme === "fourview") return fourViewPrompt;
    return ASSET_PROMPT_FALLBACK_TEMPLATE;
}

/**
 * 剧目级参考图提示词模板（对齐影策「角色提示词 / 场景提示词 / 默认」）。
 * 三档按资产类型取：character/scene/prop 各自覆盖，未填则落 `default`，都为空表示沿用内置方案模板。
 */
export type AssetPromptTemplates = { default?: string; character?: string; scene?: string; prop?: string };

/** 模板可用变量（前端插入按钮与渲染共用同一份清单）。 */
export const ASSET_PROMPT_VARIABLES = ["项目画风", "资产名称", "资产设定", "画面规则", "方案名称", "方案要求"] as const;
export type AssetPromptVariable = (typeof ASSET_PROMPT_VARIABLES)[number];

export type AssetPromptTemplateVars = Partial<Record<AssetPromptVariable, string>> & { language?: string };

/** 取某类资产实际生效的模板：本类覆盖优先，其次 default；空白视为未配置。 */
export function assetPromptTemplateFor(kind: AssetSpecKind, templates: AssetPromptTemplates | null | undefined): string {
    const t = templates || {};
    const own = kind === "character" ? t.character : kind === "scene" ? t.scene : t.prop;
    return String(own ?? "").trim() || String(t.default ?? "").trim();
}

/**
 * 用剧目模板渲染参考图提示词。
 * - 模板为空 → 回退 `buildSchemePrompt`（同一套内置模板与渲染口径）。
 * - 未知变量 `{{xxx}}` 原样保留并回报，绝不静默删内容。
 * - 规则只由模板的 `{{画面规则}}` 承载，缺失时不再追加「用户长期规则：」段。
 * - 模板自带 `{{项目画风}}` 时画风只出现一次，不再追加「全片统一画风」后缀。
 * - 画幅作为生成参数传递，不在文本里补画幅行。
 */
export function renderAssetPromptWithTemplate(
    kind: AssetSpecKind,
    name: string,
    appearance: string,
    scheme: AssetSchemeId,
    templates: AssetPromptTemplates | null | undefined,
    vars: AssetPromptTemplateVars = {},
): { prompt: string; usedTemplate: boolean; unknownVars: string[] } {
    const template = assetPromptTemplateFor(kind, templates);
    const schemeInfo = ASSET_SCHEMES.find((s) => s.id === scheme);
    const values: Record<string, string> = {
        项目画风: String(vars["项目画风"] ?? "").trim(),
        资产名称: String(vars["资产名称"] ?? name ?? "").trim(),
        资产设定: String(vars["资产设定"] ?? appearance ?? "").trim(),
        画面规则: String(vars["画面规则"] ?? "").trim(),
        方案名称: String(vars["方案名称"] ?? schemeInfo?.name ?? "").trim(),
        方案要求: String(vars["方案要求"] ?? schemeInfo?.frameHint ?? "").trim(),
    };
    const options = { artStyle: values["项目画风"], language: vars.language, rules: values["画面规则"] };
    if (!template) return { prompt: buildSchemePrompt(kind, name, appearance, scheme, options), usedTemplate: false, unknownVars: [] };

    const unknownVars: string[] = [];
    const rendered = fillAssetPromptTemplate(template, values, unknownVars);
    if (!rendered) return { prompt: buildSchemePrompt(kind, name, appearance, scheme, options), usedTemplate: false, unknownVars };
    const prompt = withTemplateArtStyle(rendered, template, options.artStyle, options.language);
    return { prompt, usedTemplate: true, unknownVars };
}
