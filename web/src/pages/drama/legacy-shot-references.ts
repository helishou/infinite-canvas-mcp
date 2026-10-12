import { isSubjectPromptAssembly, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

/** Update the original storyboard image fields while keeping ordinary and keyframe references separate. */
export function updateLegacyShotReferences(
    director: DirectorProduction,
    shotId: string,
    assetIds: string[],
    keyframeAssetId: string | null,
) {
    if (isSubjectPromptAssembly(director.source)) return undefined;
    const next = structuredClone(director);
    const shot = (next.source.shots as Array<Record<string, any>> | undefined)?.find(item => String(item.id) === shotId);
    if (!shot) return undefined;
    const uniqueAssetIds = [...new Set(assetIds.map(String).filter(Boolean))];
    shot.required_assets = uniqueAssetIds;
    const previous = next.shotInputs[shotId] || { keyframePolicy: "none" as const, assetIds: [] };
    next.shotInputs[shotId] = {
        ...previous,
        assetIds: uniqueAssetIds,
        keyframePolicy: keyframeAssetId ? "reuse" : "none",
        ...(keyframeAssetId ? { keyframeAssetId } : {}),
    };
    if (!keyframeAssetId) delete next.shotInputs[shotId].keyframeAssetId;
    return next;
}
