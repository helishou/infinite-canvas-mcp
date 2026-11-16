import { withArtStyle } from "./art-style.js";
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
