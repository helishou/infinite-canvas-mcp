import { z } from "zod";
import { productionReadSchema, productionReadQuery } from "./production-read.js";
const id = z.string().trim().min(1);
const owner = z.object({ kind: z.enum(["canvas", "episode", "scene"]), id }).strict();
const workOwner = z.object({ kind: z.enum(["canvas", "episode"]), id }).strict();
const episodeOwner = z.object({ kind: z.literal("episode"), id }).strict();
export const productionWorkspaceSchemas = {
    production_hash_source: z.object({ source: z.record(z.unknown()) }).strict(),
    production_get_scene_work: workOwner,
    production_start_shared_review: workOwner.extend({ operationId: id, expectedRevision: z.number().int().nonnegative(), model: id.optional(), effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional() }),
    production_start_scene_work: workOwner.extend({ operationId: id, expectedRevision: z.number().int().nonnegative(), sceneIds: z.array(id).min(1), generateMedia: z.boolean().default(false), model: id.optional(), effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional() }),
    production_resume_scene_work: workOwner.extend({ workId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
    production_pause_scene_work: workOwner.extend({ workId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
    production_review_scene_work: workOwner.extend({ workId: id.optional(), assetIds: z.array(id).min(1).optional(), expectedRevision: z.number().int().nonnegative(), operationId: id, inputHash: z.string().regex(/^[a-f0-9]{64}$/), verdict: z.enum(["approved", "rejected"]), evidence: id }),
    production_ensure_canvas: z.object({ kind: z.enum(["episode", "shared-assets", "scene"]), id }),
    production_get_canvas_context: z.object({ projectId: id }),
    production_list_scenes: z.object({ dramaId: id, episodeId: id.optional(), includeOrphaned: z.boolean().optional() }),
    production_get_scene: z.object({ sceneId: id }),
    production_get_scene_production: productionReadSchema.extend({ sceneId: id }),
    production_edit_scene_production: z.object({ sceneId: id, operationId: id, expectedRevision: z.number().int().nonnegative(), ops: z.array(z.record(z.unknown())).min(1) }),
    production_publish_scene_production: z.object({ sceneId: id, operationId: id, expectedRevision: z.number().int().nonnegative(), stage: z.enum(["script", "shots", "director"]) }),
    production_get_scene_readiness: z.object({ sceneId: id, source: z.enum(["draft", "published"]).optional() }),
    production_list_scene_versions: z.object({ sceneId: id }),
    production_get_scene_version: productionReadSchema.extend({ sceneId: id, version: z.number().int().positive() }),
    production_restore_scene_production: z.object({ sceneId: id, version: z.number().int().positive(), operationId: id, expectedRevision: z.number().int().nonnegative() }),
    production_prepare_targets: owner.extend({ expectedRevision: z.number().int().nonnegative(), operationId: id, targets: z.array(id).min(1) }),
    production_get_continuity: owner.extend({ snapshot: z.enum(["draft", "published"]).default("draft"), view: z.enum(["summary", "issues", "timeline", "shot"]).default("summary"), targetId: id.optional(), objectId: id.optional(), pageSize: z.number().int().positive().optional(), cursor: z.string().optional() }),
    production_check_continuity: owner.extend({ expectedRevision: z.number().int().nonnegative(), operationId: id, snapshot: z.enum(["draft", "published"]).optional(), targetIds: z.array(id).optional() }),
    production_preview_continuity_upgrade: owner.extend({ expectedRevision: z.number().int().nonnegative(), operationId: id, fromSourceHash: z.string().regex(/^[a-f0-9]{64}$/), ledger: z.record(z.unknown()) }),
    production_get_shared_assets: owner,
    production_adopt_shared_asset: episodeOwner.extend({ assetId: id, approvedId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
    production_retry_shared_update: episodeOwner.extend({ adoptionId: id, expectedRevision: z.number().int().nonnegative() }),
    production_arrange_scene: owner.extend({ sceneId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
};
export const productionWorkspaceToolNames = Object.keys(productionWorkspaceSchemas) as Array<keyof typeof productionWorkspaceSchemas>;
export const productionWorkspaceDescriptions = {
    production_hash_source: "仅在首次或明确整稿替换、准备提交新的完整 source 对象时计算 canonical sourceHash；同一候选对象复用已算哈希。读取已保存源稿使用返回的 sourceHash；局部修改用 production_edit 的 patch_director_source/patch_director_continuity，由 Backend 重算，不回读整稿逐次哈希。只读，不保存、发布或生成。",
    production_start_shared_review: "启动当前就绪共同资产或完整共同基础的自动审核；沿用生产代理池，不提交图片或视频，不自动重生成。",
    production_get_scene_work: "读取场次工作、当前审核输入哈希、源稿与真实媒体摘要；只读，不启动代理、编译或生成。",
    production_start_scene_work: "启动选定正式场次的隔离代理制作；generateMedia 显式授权这些场次的媒体生成，false 只制作源稿。默认三代理与三编译任务并行。",
    production_resume_scene_work: "核对原工作版本后恢复场次制作；不会重复提交已有媒体任务或自动重做失败目标。",
    production_pause_scene_work: "在当前工作边界暂停场次制作；不取消已经提交的媒体任务。",
    production_review_scene_work: "审核共同基础或指定场次；inputHash 绑定实际输入，证据与真实媒体由 Backend 核对后保存。",
    production_ensure_canvas: "幂等准备分集固定画布、剧目共享资产画布或制作场次固定画布；不改绑、不提交媒体生成。",
    production_get_canvas_context: "读取画布制作角色、所属剧目/分集/场次与正式 production owner。",
    production_list_scenes: "列出一个剧目的制作场次目录，含环境引用、顺序、制作状态与已绑定画布；不创建场次或画布。",
    production_get_scene: "读取单个制作场次的身份、环境引用、内容哈希与已绑定画布上下文。",
    production_get_scene_production: "默认读取单场次制作摘要；通过 view、sourceSection 和 targetIds 定向读取源对象或产物。不会读取或修改所属分集制作稿。",
    production_edit_scene_production: "按 expectedRevision 与 operationId 编辑单场次独立制作草稿；编辑仅落到场次制作记录与其固定画布。",
    production_publish_scene_production: "发布单场次的导演制作稿新版本；不提交媒体生成。",
    production_get_scene_readiness: "读取单场次导演工作流就绪状态和当前制作焦点。",
    production_list_scene_versions: "列出单场次历史发布版本。",
    production_get_scene_version: "默认读取场次发布版本摘要；用 view、sourceSection、targetIds、pageSize/cursor、chunkBytes 读取详情。",
    production_restore_scene_production: "将单场次历史版本恢复到草稿；不删除历史或媒体。",
    production_prepare_targets: "在固定画布按 Backend 持久化布局计划准备正式 scene 剧本文本节点、asset/frame 节点或 segment Clip；返回布局回执，不发布或生成。",
    production_get_continuity: "只读读取正式连续性检查状态、问题、对象轨迹或单镜状态；不会触发检查或修改制作稿。",
    production_check_continuity: "按正式 owner 和 revision 执行 Acheng 固定 runtime 的连续性检查并持久化回执；检查完成不表示 verdict passed，不发布或生成。",
    production_preview_continuity_upgrade: "只读预览旧连续性源稿升级到 ledger v2 的诊断与版本影响；不会改动制作稿、发布版、历史媒体或生成任务。",
    production_get_shared_assets: "读取同剧目最新批准共享资产及当前集持久更新状态。",
    production_adopt_shared_asset: "将同剧目批准资产采用到已登记的集内目标；核验来源、媒体和版本，不生成。",
    production_retry_shared_update: "核对当前 revision 后恢复一项被阻塞的共享引用更新；不授权新的生成范围。",
    production_arrange_scene: "显式整理一个正式剧本场次的已准备分镜节点；不修改镜头/Segment 或其他场次。",
};
export function productionWorkspaceRequest(name: string, raw: unknown) {
    if (!productionWorkspaceToolNames.includes(name as keyof typeof productionWorkspaceSchemas)) return undefined;
    const input = productionWorkspaceSchemas[name as keyof typeof productionWorkspaceSchemas].parse(raw) as Record<string, any>;
    if (name === "production_hash_source") return { method: "POST" as const, path: "/canvas/production/hash", body: { source: input.source } };
    if (name === "production_get_canvas_context") return { method: "GET" as const, path: `/canvas/projects/${encodeURIComponent(input.projectId)}/production-context` };
    if (name === "production_list_scenes") return { method: "GET" as const, path: `/dramas/${encodeURIComponent(input.dramaId)}/scenes${input.episodeId || input.includeOrphaned ? `?${new URLSearchParams({ ...(input.episodeId ? { episodeId: input.episodeId } : {}), ...(input.includeOrphaned ? { includeOrphaned: "true" } : {}) })}` : ""}` };
    if (name === "production_get_scene") return { method: "GET" as const, path: `/drama/scenes/${encodeURIComponent(input.sceneId)}` };
    if (["production_get_continuity", "production_check_continuity", "production_preview_continuity_upgrade"].includes(name)) {
        const base = input.kind === "canvas" ? `/canvas/projects/${encodeURIComponent(input.id)}/production` : input.kind === "scene" ? `/drama/scenes/${encodeURIComponent(input.id)}/production` : `/drama/episodes/${encodeURIComponent(input.id)}/production`;
        if (name === "production_get_continuity") {
            const { kind: _kind, id: _id, ...query } = input;
            return { method: "GET" as const, path: `${base}/continuity?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])))}` };
        }
        const { kind: _kind, id: _id, ...body } = input;
        return name === "production_preview_continuity_upgrade"
            ? { method: "POST" as const, path: `${base}/continuity/upgrade-preview`, body }
            : { method: "POST" as const, path: `${base}/continuity/check`, body };
    }
    const sceneProductionBase = `/drama/scenes/${encodeURIComponent(input.sceneId)}/production`;
    if (name === "production_get_scene_production") return { method: "GET" as const, path: `${sceneProductionBase}${productionReadQuery(input)}` };
    if (name === "production_edit_scene_production") { const { sceneId: _sceneId, ...body } = input; return { method: "POST" as const, path: `${sceneProductionBase}/ops`, body }; }
    if (name === "production_publish_scene_production") { const { sceneId: _sceneId, ...body } = input; return { method: "POST" as const, path: `${sceneProductionBase}/publish`, body }; }
    if (name === "production_get_scene_readiness") return { method: "GET" as const, path: `${sceneProductionBase}/readiness${input.source ? `?source=${input.source}` : ""}` };
    if (name === "production_list_scene_versions") return { method: "GET" as const, path: `${sceneProductionBase}/versions` };
    if (name === "production_get_scene_version") return { method: "GET" as const, path: `${sceneProductionBase}/versions/${input.version}${productionReadQuery(input)}` };
    if (name === "production_restore_scene_production") { const { sceneId: _sceneId, ...body } = input; return { method: "POST" as const, path: `${sceneProductionBase}/restore`, body }; }
    if (name === "production_ensure_canvas") {
        if (input.kind === "scene") return { method: "POST" as const, path: `/drama/scenes/${encodeURIComponent(input.id)}/canvas/ensure`, body: {} };
        return { method: "POST" as const, path: input.kind === "episode" ? `/drama/episodes/${encodeURIComponent(input.id)}/canvas/ensure` : `/drama/projects/${encodeURIComponent(input.id)}/asset-canvas/ensure`, body: {} };
    }
    const { kind, id: ownerId, ...body } = input;
    // Scene production routes keep reads and edits under the scene owner namespace; media generation remains blocked until its runner is integrated.
    const base = kind === "canvas" ? `/canvas/projects/${encodeURIComponent(ownerId)}/production`
        : kind === "scene" ? `/drama/scenes/${encodeURIComponent(ownerId)}/production`
        : `/drama/episodes/${encodeURIComponent(ownerId)}/production`;
    if (name === "production_start_shared_review") return { method: "POST" as const, path: `${base}/scene-work/shared-review`, body };
    if (name === "production_get_scene_work") return { method: "GET" as const, path: `${base}/scene-work` };
    if (name.startsWith("production_") && name.endsWith("scene_work")) {
        const action = name.replace("production_", "").replace("_scene_work", "");
        return { method: "POST" as const, path: `${base}/scene-work/${action}`, body };
    }
    if (name === "production_get_shared_assets") return { method: "GET" as const, path: `${base}/shared-assets` };
    if (name === "production_retry_shared_update") { const { adoptionId, ...request } = body; return { method: "POST" as const, path: `${base}/shared-assets/updates/${encodeURIComponent(adoptionId)}/retry`, body: request }; }
    const suffix = name === "production_adopt_shared_asset" ? "shared-assets/adopt" : name === "production_arrange_scene" ? "arrange-scene" : "prepare-targets";
    return { method: "POST" as const, path: `${base}/${suffix}`, body };
}
