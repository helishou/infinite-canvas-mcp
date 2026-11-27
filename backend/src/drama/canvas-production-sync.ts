import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import type { DirectorProduction, EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import type { CanvasCommandContext } from "../canvas/collaboration.js";
import { directorHash, withoutDirectorProjection } from "./director.js";

const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

type Owner = { id: string; kind: string; table: string; column: string };

function ownerOf(db: BackendDatabase, projectId: string, nodes: Array<Record<string, any>>): Owner | null {
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    if (episode) return { id: episode.id, kind: "episode", table: "episode_productions", column: "episode_id" };
    if (db.db.prepare("SELECT 1 FROM canvas_productions WHERE project_id=?").get(projectId))
        return { id: projectId, kind: "canvas", table: "canvas_productions", column: "project_id" };
    return null;
}

/** 画布 H3 节点的段列表（按 nodeId 聚合，保留画布顺序）。 */
function canvasSegments(nodes: Array<Record<string, any>>, owner: Owner): Map<string, Array<Record<string, any>>> {
    const out = new Map<string, Array<Record<string, any>>>();
    for (const node of nodes) {
        if (!String(node.type || "").startsWith("minimax-h3:")) continue;
        const md = record(node.metadata);
        if (md.productionArchiveLabel) continue;
        if (md.productionOwnerId && String(md.productionOwnerId) !== owner.id) continue;
        if (md.productionOwnerKind && String(md.productionOwnerKind) !== owner.kind) continue;
        out.set(String(node.id), rows(md.segments));
    }
    return out;
}

/**
 * 方案二：画布与制作台对等维护 Clip。
 * 把画布 H3 段结构的增删/重排同步回制作稿 draft.source.segments，统一数据源。
 * 只在结构变化（段 id 集合或顺序变化）时写回；内容编辑（prompt/参考图）不在此处理。
 */
export function syncH3SegmentStructureEdits(
    db: BackendDatabase,
    projectId: string,
    before: Record<string, any>,
    after: Record<string, any>,
    context?: CanvasCommandContext,
): Array<{ entityId: string; revision: number }> {
    // 防循环：运行时写回、系统调用、制作稿→画布同步都不再回写，避免 A→B→A 死循环。
    if (context?.runtimeWrite || context?.source?.kind === "system" || String(context?.source?.clientId || "").startsWith("production:")) return [];

    const owner = ownerOf(db, projectId, rows(after.nodes));
    if (!owner) return [];
    const beforeSegs = canvasSegments(rows(before.nodes), owner);
    const afterSegs = canvasSegments(rows(after.nodes), owner);
    if (!afterSegs.size) return [];

    // 画布段结构是否变化：合并所有节点，按稳定标识（targetId 或段 id）比较集合与顺序。
    const signature = (map: Map<string, Array<Record<string, any>>>) =>
        [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([nodeId, segs]) => `${nodeId}:${segs.map(s => String(record(s.productionClipProjection).targetId || s.id || "")).join(",")}`).join("|");
    if (signature(beforeSegs) === signature(afterSegs)) return [];

    const row = db.db.prepare(`SELECT revision, draft_json FROM ${owner.table} WHERE ${owner.column}=?`).get(owner.id) as { revision: number; draft_json: string } | undefined;
    if (!row) return [];
    const draft = JSON.parse(row.draft_json) as EpisodeProductionData;
    if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) return [];

    const source = draft.director.source;
    const beforeFlattened = [...beforeSegs.values()].flat().map(s => String(record(s.productionClipProjection).targetId || ""));
    const afterFlattened = [...afterSegs.values()].flat().map(s => String(record(s.productionClipProjection).targetId || ""));
    const beforeTargets = new Set(beforeFlattened.filter(Boolean));
    const afterTargets = new Set(afterFlattened.filter(Boolean));
    let changed = false;

    // 1) 删除：画布已移除的制作绑定段，从 source.segments 移除。
    const kept = rows(source.segments).filter(seg => !beforeTargets.has(String(seg.id || "")) || afterTargets.has(String(seg.id || "")));
    if (kept.length !== rows(source.segments).length) { (source as any).segments = kept; changed = true; }

    // 2) 重排：按画布顺序排列仍存在的制作稿段。
    const orderById = new Map(afterFlattened.filter(Boolean).map((id, index) => [id, index]));
    const reordered = [...((source as any).segments as Array<Record<string, any>>)].sort((a, b) => {
        const ia = orderById.get(String(a.id || "")), ib = orderById.get(String(b.id || ""));
        if (ia === undefined && ib === undefined) return 0;
        if (ia === undefined) return 1;
        if (ib === undefined) return -1;
        return ia - ib;
    });
    if (reordered.some((seg, i) => seg !== (source as any).segments[i])) { (source as any).segments = reordered; changed = true; }

    // 3) 新增：画布新增的段（无制作绑定 targetId）在制作稿补最小段，后续由 repartition 补全 shot_ids。
    const existingIds = new Set(rows(source.segments).map(seg => String(seg.id || "")));
    let added = 0;
    for (const seg of [...afterSegs.values()].flat()) {
        if (record(seg.productionClipProjection).targetId || !seg.id) continue;
        let newId = String(seg.id);
        if (existingIds.has(newId)) newId = `${newId}_${++added}`;
        existingIds.add(newId);
        (source as any).segments.push({ id: newId, shot_ids: [], mode: "T2VA" });
        changed = true;
    }

    if (!changed) return [];
    // 只同步 source.segments 分组结构；不调用 projectDirector（它会从 source.shots 重建分组，冲掉本次画布改动）。
    (draft.director as DirectorProduction).sourceHash = directorHash(source);
    const revision = row.revision + 1;
    db.db.prepare(`UPDATE ${owner.table} SET revision=?, draft_json=?, updated_at=? WHERE ${owner.column}=?`)
        .run(revision, JSON.stringify(withoutDirectorProjection(draft)), new Date().toISOString(), owner.id);
    return [{ entityId: owner.id, revision }];
}
