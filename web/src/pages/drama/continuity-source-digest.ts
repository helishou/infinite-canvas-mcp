type Row = Record<string, any>;

/** 与 Acheng continuity_v2.coverage_digest 保持一致的展示字段剔除范围。 */
const DISPLAY_ONLY_BLOCK_KEYS = new Set(["note", "notes", "color", "layout", "bounds", "collapsed", "hidden"]);

const normalizedText = (value: any) => typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/\s+$/u, "")).join("\n").trim()
    : value;

/** 覆盖证据只绑定剧本块的叙事内容；忽略排版字段、缺失 text 与换行差异。 */
export function projectedContinuityBlock(block: any): any {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const projected: Row = {};
    for (const key of Object.keys(block).sort()) {
        if (key.startsWith("display_") || DISPLAY_ONLY_BLOCK_KEYS.has(key)) continue;
        const value = block[key];
        projected[key] = key === "text" ? normalizedText(value) : key === "blocks" && Array.isArray(value) ? value.map(projectedContinuityBlock) : value;
    }
    if (projected.text === undefined) projected.text = "";
    return projected;
}

/** 新登记使用的规范化摘要输入；与 Skill 侧 coverage_digest 序列化一致。 */
export const continuityCoverageDigestValue = (sceneId: any, block: any) => ({ scene_id: sceneId === null || sceneId === undefined ? "" : String(sceneId), block: projectedContinuityBlock(block) });

/** 旧版摘要输入；只用于继续接受已写入的历史覆盖行。 */
export const continuityLegacyDigestValue = (sceneId: any, block: any) => ({ scene_id: sceneId, block });
