/**
 * Agent 写入镜头时必须齐备的结构：
 * - 文戏（performance）：五轨 gaze / breath / shoulder / body_hands / dialogue
 * - 武戏（combat）：七层 force_source / trajectory / contact / resistance / impact_hold / transfer / recoil
 *
 * 这两套结构只做数据契约，不参与正文渲染；编译仍只用 shot.visual 正文。
 */

export const PERFORMANCE_TRACKS = ["gaze", "breath", "shoulder", "body_hands", "dialogue"] as const;
export const COMBAT_LAYERS = [
    "force_source", "trajectory", "contact", "resistance", "impact_hold", "transfer", "recoil",
] as const;

type Row = Record<string, unknown>;

export type StructureIssue = { code: string; message: string };

function asRow(value: unknown): Row {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function filled(value: unknown): boolean {
    return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

/** 武戏七层是否齐备（合并已存载荷与本次补丁）。 */
export function combatIssues(shot: Row, patch: Row): StructureIssue[] {
    const payload = { ...asRow(shot.combat), ...asRow(patch.combat) };
    const missing = COMBAT_LAYERS.filter(key => !filled(payload[key]));
    return missing.length
        ? [{ code: "SHOT_COMBAT_STRUCTURE", message: `武戏缺少 ${missing.join("、")}；武戏必须写齐七层：${COMBAT_LAYERS.join("、")}` }]
        : [];
}

/** 文戏五轨是否齐备（tracks 下每轨需 cue）。 */
export function performanceIssues(shot: Row, patch: Row): StructureIssue[] {
    const merged = { ...asRow(shot.performance), ...asRow(patch.performance) };
    const tracks = asRow(merged.tracks);
    const missing = PERFORMANCE_TRACKS.filter(key => !filled(asRow(tracks[key]).cue));
    return missing.length
        ? [{ code: "SHOT_PERFORMANCE_STRUCTURE", message: `文戏缺少 ${missing.join("、")} 轨的 cue；文戏必须写齐五轨：${PERFORMANCE_TRACKS.join("、")}` }]
        : [];
}

/**
 * 判定本镜属于哪一侧：
 * - features.combat 为 true → 武戏，校验七层
 * - 显式给了 combat 载荷 → 武戏
 * - 其余 → 文戏，校验五轨
 */
export function shotStructureIssues(shot: Row, patch: Row): StructureIssue[] {
    const features = { ...asRow(shot.features), ...asRow(patch.features) };
    const isCombat = features.combat === true || (patch.combat !== undefined && patch.combat !== null);
    const issues = isCombat ? combatIssues(shot, patch) : performanceIssues(shot, patch);
    if (isCombat && patch.performance !== undefined) {
        return [...issues, { code: "SHOT_STRUCTURE_MIXED", message: "同一镜不能同时按文戏五轨与武戏七层写入；请二选一" }];
    }
    return issues;
}
