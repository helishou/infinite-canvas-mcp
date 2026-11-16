/**
 * 角色／场景／道具底稿的画布归属。
 *
 * 本仓 SOP：四视图、场景概念图、道具卡一律落在剧目的共享资产画布，分集画布只放本集镜头产物
 * 并对共享资产做反向引用。这样第二集以后能直接复用同一份底稿，而不是每集各建一遍。
 * 只有没有共享资产画布的场景（自由画布、独立单集）才落本集画布。
 */
export function assetCanvasScope(context: { role?: string | null; sharedAssetCanvasId?: string | null } | null | undefined): "episode" | "shared" {
    if (!context) return "episode";
    if (context.role === "shared-assets") return "shared";
    return context.sharedAssetCanvasId ? "shared" : "episode";
}
