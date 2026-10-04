import { z } from "zod";
const id = z.string().trim().min(1);
const owner = z.object({ kind: z.enum(["canvas", "episode"]), id });
export const productionWorkspaceSchemas = {
    production_ensure_canvas: z.object({ kind: z.enum(["episode", "shared-assets"]), id }),
    production_get_canvas_context: z.object({ projectId: id }),
    production_prepare_targets: owner.extend({ expectedRevision: z.number().int().nonnegative(), operationId: id, targets: z.array(id).min(1) }),
    production_get_shared_assets: owner,
    production_adopt_shared_asset: owner.extend({ assetId: id, approvedId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
    production_retry_shared_update: owner.extend({ adoptionId: id, expectedRevision: z.number().int().nonnegative() }),
    production_arrange_scene: owner.extend({ sceneId: id, expectedRevision: z.number().int().nonnegative(), operationId: id }),
};
export const productionWorkspaceToolNames = Object.keys(productionWorkspaceSchemas) as Array<keyof typeof productionWorkspaceSchemas>;
export const productionWorkspaceDescriptions = {
    production_ensure_canvas: "幂等准备分集固定画布或剧目共享资产画布；不改绑、不提交媒体生成。",
    production_get_canvas_context: "读取画布制作角色、所属剧目/分集与正式 production owner。",
    production_prepare_targets: "在固定画布准备正式 asset/frame/segment 对应节点或 Clip；保留原布局，不发布或生成。",
    production_get_shared_assets: "读取同剧目最新批准共享资产及当前集持久更新状态。",
    production_adopt_shared_asset: "将同剧目批准资产采用到已登记的集内目标；核验来源、媒体和版本，不生成。",
    production_retry_shared_update: "核对当前 revision 后恢复一项被阻塞的共享引用更新；不授权新的生成范围。",
    production_arrange_scene: "显式整理一个正式剧本场次的已准备分镜节点；不修改镜头/Segment 或其他场次。",
};
export function productionWorkspaceRequest(name: string, raw: unknown) {
    if (!productionWorkspaceToolNames.includes(name as keyof typeof productionWorkspaceSchemas)) return undefined;
    const input = productionWorkspaceSchemas[name as keyof typeof productionWorkspaceSchemas].parse(raw) as Record<string, any>;
    if (name === "production_get_canvas_context") return { method: "GET" as const, path: `/canvas/projects/${encodeURIComponent(input.projectId)}/production-context` };
    if (name === "production_ensure_canvas") return { method: "POST" as const, path: input.kind === "episode" ? `/drama/episodes/${encodeURIComponent(input.id)}/canvas/ensure` : `/drama/projects/${encodeURIComponent(input.id)}/asset-canvas/ensure`, body: {} };
    const { kind, id: ownerId, ...body } = input;
    const base = kind === "canvas" ? `/canvas/projects/${encodeURIComponent(ownerId)}/production` : `/drama/episodes/${encodeURIComponent(ownerId)}/production`;
    if (name === "production_get_shared_assets") return { method: "GET" as const, path: `${base}/shared-assets` };
    if (name === "production_retry_shared_update") { const { adoptionId, ...request } = body; return { method: "POST" as const, path: `${base}/shared-assets/updates/${encodeURIComponent(adoptionId)}/retry`, body: request }; }
    const suffix = name === "production_adopt_shared_asset" ? "shared-assets/adopt" : name === "production_arrange_scene" ? "arrange-scene" : "prepare-targets";
    return { method: "POST" as const, path: `${base}/${suffix}`, body };
}
