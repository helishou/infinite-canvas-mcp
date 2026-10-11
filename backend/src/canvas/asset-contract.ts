import { z } from "zod";

/**
 * 场景/角色资产里的一张图。前端优先读 storageKey 再退回 url（见 assets/index.tsx 的
 * useResolvedCoverUrl 与导出分支），所以两者至少要有一个；width/height 可缺，缺失时
 * 前端不会崩，只是不显示尺寸。
 */
export const assetImageSchema = z.object({
    url: z.string().min(1).optional(),
    storageKey: z.string().min(1).optional(),
    name: z.string().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().min(1).optional(),
}).passthrough().refine(
    (image) => Boolean(image.url || image.storageKey),
    { message: "图片必须有 url 或 storageKey 之一" },
);

/** 场景资产业务数据契约：前端 SceneAsset.data 只认这组字段名。 */
export const sceneAssetDataSchema = z.object({
    name: z.string().min(1),
    description: z.string(),
    image: assetImageSchema,
    colorCard: assetImageSchema.optional(),
    colorPalette: z.array(z.string()).optional(),
    colorCardPrompt: z.string().optional(),
}).passthrough();

/** 角色资产业务数据契约：前端直接读 images.length 与 images[].width，数组不能空。 */
export const characterAssetDataSchema = z.object({
    name: z.string().min(1),
    images: z.array(assetImageSchema).min(1),
    description: z.string().optional(),
    primaryIndex: z.number().int().nonnegative().optional(),
}).passthrough();

/** 画布节点 metadata 字段名 → 资产契约字段名。写错字段名的资产靠这张表归一化。 */
const SCENE_ALIASES: ReadonlyArray<readonly [field: string, node: string]> = [
    ["name", "sceneName"],
    ["description", "sceneDescription"],
    ["image", "sceneImage"],
    ["colorCard", "sceneColorCard"],
    ["colorCardPrompt", "sceneColorCardPrompt"],
];

/**
 * 把一条场景资产归一化到前端契约：节点字段名回填成资产字段名、裸 URL 升级成图片对象、
 * description 缺失补空串、coverUrl 跟随主图。幂等：已是契约形状的资产原样返回。
 */
export function normalizeSceneAsset(asset: Record<string, unknown>): { asset: Record<string, unknown>; changed: boolean } {
    const original = recordOf(asset.data);
    const data = { ...original };
    let changed = false;

    const assign = (field: string, value: unknown) => {
        if (data[field] === value) return;
        data[field] = value;
        changed = true;
    };

    for (const [field, nodeField] of SCENE_ALIASES) {
        if (data[field] === undefined && original[nodeField] !== undefined) assign(field, original[nodeField]);
    }
    // 画布节点习惯把图写成裸 URL 字符串，资产契约要求图片对象。
    if (typeof data.image === "string") assign("image", { url: data.image, storageKey: original.storageKey || undefined });
    if (typeof data.colorCard === "string") assign("colorCard", { url: data.colorCard });
    if (data.name === undefined) assign("name", String(asset.title || ""));
    if (data.description === undefined) assign("description", "");

    const cover = imageUrl(data.image);
    if (cover && !String(asset.coverUrl || "")) return { asset: { ...asset, data, coverUrl: cover }, changed: true };
    return changed ? { asset: { ...asset, data }, changed } : { asset, changed: false };
}

/** 按 kind 返回数据契约；null 表示该 kind 的 data 是自由结构，不校验。 */
export function assetDataSchema(kind: string): z.ZodType | null {
    if (kind === "scene") return sceneAssetDataSchema;
    if (kind === "character") return characterAssetDataSchema;
    return null;
}

/** 把 zod 报错压成可读的一行，便于写进 MCP 错误信息。 */
export function describeAssetIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageUrl(value: unknown): string {
    if (typeof value === "string") return value;
    const image = recordOf(value);
    return String(image.url || "");
}