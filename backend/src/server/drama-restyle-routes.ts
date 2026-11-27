import crypto from "node:crypto";
import type { Request, Response, Router } from "express";
import type { BackendDatabase, CanvasProject } from "../db.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import type { Stores } from "../stores/types.js";
import type { CanvasGenerationService } from "../canvas/generation-service.js";

type Row = Record<string, any>;
type RestyleNode = { projectId: string; nodeId: string; type: string; metadata: Row };
const obj = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const str = (value: unknown) => value === undefined || value === null ? "" : String(value);

/** 一条被角色设定引用的剧情段（H3 Clip）。对齐影策 DramaShot 的 episodeId+segmentIndex。 */
export type RestyleTarget = {
    projectId: string;
    nodeId: string;
    segmentId: string;
    title: string;
    episodeId: string;
    resultStorageKey: string;
    inputOutdated: boolean;
    hasActiveTask: boolean;
};

export type RestylePlan = {
    /** 只读反查到的全部引用段，含未生成/已过期的。 */
    all: RestyleTarget[];
    /** 本次真要标记 inputOutdated 的段：引用它、已出片、未过期、且无在跑任务。 */
    toMark: RestyleTarget[];
    impact: { episodes: number; segments: number };
    skippedNotGenerated: number;
    skippedAlreadyOutdated: number;
    skippedActiveTask: number;
};

/** 从角色节点的 castId（characterAssetId / productionEntity.entityId / 节点 id）派生可匹配别名。 */
function characterAliases(nodes: RestyleNode[], assetId: string, groupId: string): Set<string> {
    const aliases = new Set<string>();
    if (assetId) aliases.add(assetId);
    if (groupId) aliases.add(groupId);
    for (const node of nodes) {
        if (node.type !== "character") continue;
        const md = obj(node.metadata), entity = obj(md.productionEntity);
        const ids = [str(md.characterAssetId), str(entity.entityId), node.nodeId].filter(Boolean);
        if (ids.some(id => id === assetId || id === groupId)) for (const id of ids) aliases.add(id);
    }
    return aliases;
}

/** 段是否引用该角色：与影策 DramaShotsReferencingCast 等价的本地结构化反查。 */
function segmentReferences(segment: Row, aliases: Set<string>, groupId: string): boolean {
    for (const [key, raw] of Object.entries(obj(segment.h3CharacterGroups))) {
        const group = obj(raw);
        if (groupId && (key === groupId || str(group.id) === groupId)) return true;
        const ids = [key, str(group.id), str(group.characterAssetId), str(group.characterNodeId), str(group.subjectId)];
        if (ids.some(id => id && aliases.has(id))) return true;
        for (const outfit of rows(group.outfits)) {
            if ([str(outfit.assetId), str(outfit.pictureBindingId), str(outfit.subjectId)].some(id => id && aliases.has(id))) return true;
        }
    }
    for (const ref of rows(segment.referenceBindings)) {
        if ([str(ref.assetId), str(ref.subjectId), str(ref.sourceNodeId), str(ref.nodeId), str(ref.pictureBindingId), str(ref.groupId), str(ref.outfitId)]
            .some(id => id && aliases.has(id))) return true;
    }
    return false;
}

/** canvas → episode 映射：分集画布直接命中，场景画布经 drama_scene_canvases→instances 命中。 */
function episodeByCanvas(db: BackendDatabase, dramaId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const episode of db.listDramaEpisodes(dramaId)) {
        if (episode.canvasId) map.set(episode.canvasId, episode.id);
    }
    try {
        const scenes = db.db.prepare("SELECT scene_id, canvas_id FROM drama_scene_canvases").all() as Row[];
        const instances = db.db.prepare("SELECT id, episode_id FROM drama_scene_instances WHERE drama_id = ?").all(dramaId) as Row[];
        const episodeByScene = new Map(instances.map(item => [str(item.id), str(item.episode_id)]));
        for (const scene of scenes) {
            const episodeId = episodeByScene.get(str(scene.scene_id));
            if (episodeId) map.set(str(scene.canvas_id), episodeId);
        }
    } catch { /* 老库缺场景表时只按分集画布计数 */ }
    return map;
}

export type RestylePlanOptions = {
    assetId?: string;
    groupId?: string;
    dramaId?: string;
    restyleSegments?: boolean;
    /** 判断该段是否已有在跑的生成任务；注入以便单测，不传则按段元数据保守判断。 */
    isActive?: (target: Pick<RestyleTarget, "projectId" | "nodeId" | "segmentId">) => boolean;
};

const ACTIVE_SEGMENT_STATUSES = new Set(["pending", "queued", "loading", "running", "generating", "awaiting_confirmation", "awaiting_review", "paused", "cancelling"]);

/** 只读规划：反查引用段 + 决定哪些段真要标脏；不修改任何画布数据。 */
export function planRestyle(db: BackendDatabase, options: RestylePlanOptions): RestylePlan {
    const assetId = str(options.assetId).trim(), groupId = str(options.groupId).trim();
    if (!assetId && !groupId) throw new Error("RESTYLE_ASSET_REQUIRED: 需要 assetId 或 groupId");
    const nodes = db.listCanvasNodesForRestyle();
    const aliases = characterAliases(nodes, assetId, groupId);
    const episodes = episodeByCanvas(db, str(options.dramaId));
    const all: RestyleTarget[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
        const metadata = obj(node.metadata);
        const segments = rows(metadata.segments);
        if (!segments.length) continue;
        for (const segment of segments) {
            if (!segmentReferences(segment, aliases, groupId)) continue;
            const segmentId = str(segment.id), nodeId = node.nodeId, projectId = node.projectId;
            const key = `${projectId}\0${nodeId}\0${segmentId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const status = str(segment.status).toLowerCase();
            const hasActiveTask = options.isActive
                ? options.isActive({ projectId, nodeId, segmentId })
                : ACTIVE_SEGMENT_STATUSES.has(status) || Boolean(segment.runtimeTaskId) && !["succeeded", "success", "failed", "error", "cancelled", "canceled"].includes(status);
            all.push({
                projectId, nodeId, segmentId,
                title: str(segment.title),
                episodeId: episodes.get(projectId) || "",
                resultStorageKey: str(segment.resultStorageKey || segment.result),
                inputOutdated: segment.inputOutdated === true,
                hasActiveTask,
            });
        }
    }
    const episodeSet = new Set(all.map(target => target.episodeId || target.projectId));
    const restyle = options.restyleSegments !== false;
    const toMark: RestyleTarget[] = [];
    let skippedNotGenerated = 0, skippedAlreadyOutdated = 0, skippedActiveTask = 0;
    if (restyle) for (const target of all) {
        if (!target.resultStorageKey) { skippedNotGenerated++; continue; }
        if (target.inputOutdated) { skippedAlreadyOutdated++; continue; }
        if (target.hasActiveTask) { skippedActiveTask++; continue; }
        toMark.push(target);
    }
    return {
        all, toMark,
        impact: { episodes: episodeSet.size, segments: all.length },
        skippedNotGenerated, skippedAlreadyOutdated, skippedActiveTask,
    };
}

/** 真写回：把规划中的段标记为 inputOutdated（对齐影策 MarkDramaSegmentVideoStale）。按项目分组、单次 op 提交。 */
export function applyRestylePlan(db: BackendDatabase, plan: RestylePlan, idempotencyBase: string): { marked: number } {
    const byProject = new Map<string, RestyleTarget[]>();
    for (const target of plan.toMark) byProject.set(target.projectId, [...(byProject.get(target.projectId) || []), target]);
    let marked = 0;
    for (const [projectId, targets] of byProject) {
        const project = db.getCanvasProject(projectId) as CanvasProject | null;
        if (!project) continue;
        const operations: CanvasOperation[] = targets.map(target => ({
            type: "update_h3_segment", nodeId: target.nodeId, segmentId: target.segmentId, patch: { inputOutdated: true },
        }));
        const operationId = `restyle-${crypto.createHash("sha256").update(`${idempotencyBase}\0${projectId}\0${targets.map(t => t.segmentId).join(",")}`).digest("hex").slice(0, 32)}`;
        db.applyCanvasProjectOperations(projectId, Number(project.revision || 0), operations, {
            operationId,
            // inputOutdated 是运行时字段（H3_RUNTIME_SEGMENT_FIELDS），只能由后台系统写；
            // 与 db.ts 的编辑输入过期检测同一权限级别，避免被当成客户端越权改动拒绝。
            runtimeWrite: true,
            source: { clientId: "system:drama-restyle", kind: "system", label: "设定重做（引用段标脏）" },
        });
        marked += targets.length;
    }
    return { marked };
}

/** 任务仓库判断在跑任务：幂等的核心——正在生成的段不再提交/标脏。 */
export function makeActiveTaskChecker(stores: Stores, db?: BackendDatabase) {
    let byProject: Map<string, Array<{ nodeIds: string[]; segmentIds: string[] }>> | null = null;
    return (target: Pick<RestyleTarget, "projectId" | "nodeId" | "segmentId">) => {
        try {
            if (db) {
                if (!byProject) {
                    byProject = new Map();
                    for (const task of db.listActiveTaskBindings()) {
                        const list = byProject.get(task.projectId) || [];
                        list.push({ nodeIds: task.nodeIds, segmentIds: task.segmentIds });
                        byProject.set(task.projectId, list);
                    }
                }
                return (byProject.get(target.projectId) || []).some(task =>
                    (!target.nodeId || task.nodeIds.includes(target.nodeId))
                    && (!target.segmentId || task.segmentIds.includes(target.segmentId)));
            }
            return stores.tasks.list({ projectId: target.projectId }).some(task =>
                ["queued", "running", "awaiting_confirmation"].includes(task.status)
                && (target.nodeId ? task.nodeId === target.nodeId || str((task.input as Row | undefined)?.nodeId) === target.nodeId : true)
                && (target.segmentId ? task.segmentId === target.segmentId || str((task.input as Row | undefined)?.segmentId) === target.segmentId : true));
        } catch { return false; }
    };
}

export function registerDramaRestyleRoutes(router: Router, db: BackendDatabase, stores: Stores, generation?: CanvasGenerationService) {
    const readPlan = (req: Request): RestylePlan => planRestyle(db, {
        assetId: String(req.params.assetId || ""),
        groupId: typeof req.query.groupId === "string" ? req.query.groupId : "",
        dramaId: String(req.params.dramaId || ""),
        restyleSegments: true,
        isActive: makeActiveTaskChecker(stores, db),
    });

    // 影策 GET /dramas/:id/cast/:castId/impact —— 只读预览影响集。
    router.get("/drama/:dramaId/cast/:assetId/impact", (req: Request, res: Response) => {
        try {
            const plan = readPlan(req);
            res.json({
                ok: true,
                ...plan.impact,
                targets: plan.all.map(target => ({
                    episodeId: target.episodeId, segmentId: target.segmentId, title: target.title,
                    hasVideo: Boolean(target.resultStorageKey), inputOutdated: target.inputOutdated, hasActiveTask: target.hasActiveTask,
                })),
            });
        } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 影策 POST /dramas/:id/cast/:castId/regenerate —— restyleSegments=true 标脏引用段。
    router.post("/drama/:dramaId/cast/:assetId/restyle", async (req: Request, res: Response) => {
        try {
            const body = obj(req.body);
            const restyleSegments = body.restyleSegments !== false;
            if (!restyleSegments) {
                // restyle=false 语义：只换参考图/造型，既有段视频保持不动。对齐影策 false 不标脏。
                return void res.json({ ok: true, affectedSegments: 0, unchanged: true, reason: "restyle_segments_disabled" });
            }
            const plan = planRestyle(db, {
                assetId: String(req.params.assetId || ""),
                groupId: typeof req.query.groupId === "string" ? req.query.groupId : str(body.groupId),
                dramaId: String(req.params.dramaId || ""),
                restyleSegments: true,
                isActive: makeActiveTaskChecker(stores, db),
            });
            const idempotencyBase = `${req.params.dramaId}\0${req.params.assetId}\0${str(body.groupId)}`;
            const { marked } = applyRestylePlan(db, plan, idempotencyBase);
            let submitted = 0;
            if (body.submitGeneration === true && generation) {
                for (const target of plan.toMark) {
                    try {
                        await generation.start({
                            mode: "video", operation: "h3-run",
                            projectId: target.projectId, nodeId: target.nodeId, segmentId: target.segmentId,
                            forceRegenerate: true,
                            idempotencyKey: `restyle-gen-${crypto.createHash("sha256").update(`${idempotencyBase}\0${target.projectId}\0${target.nodeId}\0${target.segmentId}`).digest("hex").slice(0, 32)}`,
                        });
                        submitted++;
                    } catch { /* 单点提交失败不影响其余段标脏；失败段保持 inputOutdated，可由原生成入口重试 */ }
                }
            }
            res.json({
                ok: true, affectedSegments: marked, submitted,
                impact: plan.impact,
                skipped: { notGenerated: plan.skippedNotGenerated, alreadyOutdated: plan.skippedAlreadyOutdated, activeTask: plan.skippedActiveTask },
            });
        } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
}
