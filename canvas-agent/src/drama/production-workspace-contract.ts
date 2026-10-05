import { z } from "zod";
const id = z.string().trim().min(1);
const owner = z.object({ kind: z.enum(["canvas", "episode", "scene"]), id }).strict();
const episodeOwner = z.object({ kind: z.literal("episode"), id }).strict();
export const productionWorkspaceSchemas = {
    production_ensure_canvas: z.object({ kind: z.enum(["episode", "shared-assets", "scene"]), id }),
    production_get_canvas_context: z.object({ projectId: id }),
    production_list_scenes: z.object({ dramaId: id, episodeId: id.optional(), includeOrphaned: z.boolean().optional() }),
    production_get_scene: z.object({ sceneId: id }),
    production_get_scene_production: z.object({ sceneId: id }),
    production_edit_scene_production: z.object({ sceneId: id, operationId: id, expectedRevision: z.number().int().nonnegative(), ops: z.array(z.record(z.unknown())).min(1) }),
    production_publish_scene_production: z.object({ sceneId: id, operationId: id, expectedRevision: z.number().int().nonnegative(), stage: z.enum(["script", "shots", "director"]) }),
    production_get_scene_readiness: z.object({ sceneId: id, source: z.enum(["draft", "published"]).optional() }),
    production_list_scene_versions: z.object({ sceneId: id }),
    production_get_scene_version: z.object({ sceneId: id, version: z.number().int().positive() }),
    production_restore_scene_production: z.object({ sceneId: id, version: z.number().int().positive(), operationId: id, expectedRevision: z.number().int().nonnegative() }),
    production_prepare_targets: owner.extend({ expectedRevision: z.number().int().nonnegative(), operationId: id, targets: z.array(id).min(1) }),
    production_get_shared_assets: owner,
    production_adopt_shared_asset: episodeOwner.extend({ assetId: id, approvedId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
    production_retry_shared_update: episodeOwner.extend({ adoptionId: id, expectedRevision: z.number().int().nonnegative() }),
    production_arrange_scene: owner.extend({ sceneId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
};
export const productionWorkspaceToolNames = Object.keys(productionWorkspaceSchemas) as Array<keyof typeof productionWorkspaceSchemas>;
export const productionWorkspaceDescriptions = {
    production_ensure_canvas: "幂等准备分集固定画布、剧目共享资产画布或制作场次固定画布；不改绑、不提交媒体生成。",
    production_get_canvas_context: "读取画布制作角色、所属剧目/分集/场次与正式 production owner。",
    production_list_scenes: "列出一个剧目的制作场次目录，含环境引用、顺序、制作状态与已绑定画布；不创建场次或画布。",
    production_get_scene: "读取单个制作场次的身份、环境引用、内容哈希与已绑定画布上下文。",
    production_get_scene_production: "读取单个场次的独立导演制作稿、revision 与发布版本；不读取或修改所属分集制作稿。",
    production_edit_scene_production: "按 expectedRevision 与 operationId 编辑单场次独立制作草稿；编辑仅落到场次制作记录与其固定画布。",
    production_publish_scene_production: "发布单场次的导演制作稿新版本；不提交媒体生成。",
    production_get_scene_readiness: "读取单场次导演工作流就绪状态和当前制作焦点。",
    production_list_scene_versions: "列出单场次历史发布版本。",
    production_get_scene_version: "读取单场次指定发布版本。",
    production_restore_scene_production: "将单场次历史版本恢复到草稿；不删除历史或媒体。",
    production_prepare_targets: "在固定画布按 Backend 持久化布局计划准备正式 scene 剧本文本节点、asset/frame 节点或 segment Clip；返回布局回执，不发布或生成。",
    production_get_shared_assets: "读取同剧目最新批准共享资产及当前集持久更新状态。",
    production_adopt_shared_asset: "将同剧目批准资产采用到已登记的集内目标；核验来源、媒体和版本，不生成。",
    production_retry_shared_update: "核对当前 revision 后恢复一项被阻塞的共享引用更新；不授权新的生成范围。",
    production_arrange_scene: "显式整理一个正式剧本场次的已准备分镜节点；不修改镜头/Segment 或其他场次。",
};
export function productionWorkspaceRequest(name: string, raw: unknown) {
    if (!productionWorkspaceToolNames.includes(name as keyof typeof productionWorkspaceSchemas)) return undefined;
    const input = productionWorkspaceSchemas[name as keyof typeof productionWorkspaceSchemas].parse(raw) as Record<string, any>;
    if (name === "production_get_canvas_context") return { method: "GET" as const, path: `/canvas/projects/${encodeURIComponent(input.projectId)}/production-context` };
    if (name === "production_list_scenes") return { method: "GET" as const, path: `/dramas/${encodeURIComponent(input.dramaId)}/scenes${input.episodeId || input.includeOrphaned ? `?${new URLSearchParams({ ...(input.episodeId ? { episodeId: input.episodeId } : {}), ...(input.includeOrphaned ? { includeOrphaned: "true" } : {}) })}` : ""}` };
    if (name === "production_get_scene") return { method: "GET" as const, path: `/drama/scenes/${encodeURIComponent(input.sceneId)}` };
    const sceneProductionBase = `/drama/scenes/${encodeURIComponent(input.sceneId)}/production`;
    if (name === "production_get_scene_production") return { method: "GET" as const, path: sceneProductionBase };
    if (name === "production_edit_scene_production") { const { sceneId: _sceneId, ...body } = input; return { method: "POST" as const, path: `${sceneProductionBase}/ops`, body }; }
    if (name === "production_publish_scene_production") { const { sceneId: _sceneId, ...body } = input; return { method: "POST" as const, path: `${sceneProductionBase}/publish`, body }; }
    if (name === "production_get_scene_readiness") return { method: "GET" as const, path: `${sceneProductionBase}/readiness${input.source ? `?source=${input.source}` : ""}` };
    if (name === "production_list_scene_versions") return { method: "GET" as const, path: `${sceneProductionBase}/versions` };
    if (name === "production_get_scene_version") return { method: "GET" as const, path: `${sceneProductionBase}/versions/${input.version}` };
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
    if (name === "production_get_shared_assets") return { method: "GET" as const, path: `${base}/shared-assets` };
    if (name === "production_retry_shared_update") { const { adoptionId, ...request } = body; return { method: "POST" as const, path: `${base}/shared-assets/updates/${encodeURIComponent(adoptionId)}/retry`, body: request }; }
    const suffix = name === "production_adopt_shared_asset" ? "shared-assets/adopt" : name === "production_arrange_scene" ? "arrange-scene" : "prepare-targets";
    return { method: "POST" as const, path: `${base}/${suffix}`, body };
}
