import type { EpisodeProduction } from "@/services/backend-api";

type CanvasNode = { id: string; metadata?: Record<string, unknown> };
type PreviewMedia = { storageKey: string; inputOutdated: boolean };

/** Overview shows archived results only through the current draft's exact bindings. */
export function productionOverviewMedia(production: Pick<EpisodeProduction, "draft">, canvasNodes: CanvasNode[], shotId: string): {
  frame?: PreviewMedia;
  clip?: PreviewMedia & { id: string };
} {
  const director = production.draft.director;
  const assetId = director?.shotInputs[shotId]?.keyframeAssetId;
  const asset = assetId ? director?.assets[assetId] : undefined;
  const keyframe = production.draft.keyframes[shotId];
  const frameKey = assetId ? asset?.storageKey : keyframe?.storageKey;
  const frameNode = canvasNodes.find(node => node.id === (assetId ? asset?.nodeId : keyframe?.nodeId));
  const group = production.draft.clipGroups.find(item => item.shotIds.includes(shotId));
  const clipNode = group?.nodeId ? canvasNodes.find(node => node.id === group.nodeId) : undefined;
  const segments = Array.isArray(clipNode?.metadata?.segments) ? clipNode.metadata.segments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  const segment = group?.segmentId ? segments.find(item => item.id === group.segmentId) : undefined;
  const clipKey = typeof segment?.resultStorageKey === "string" ? segment.resultStorageKey : "";
  return {
    ...(frameKey ? { frame: { storageKey: frameKey, inputOutdated: Boolean(asset?.inputOutdated || frameNode?.metadata?.inputOutdated) } } : {}),
    ...(group && clipKey ? { clip: { id: group.id, storageKey: clipKey, inputOutdated: Boolean(group.inputOutdated || segment?.inputOutdated) } } : {}),
  };
}
