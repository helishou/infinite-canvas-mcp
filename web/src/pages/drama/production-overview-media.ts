import type { EpisodeProduction } from "@/services/backend-api";
import { productionSegments, productionSegmentRuntimeMatches, segmentShotIds } from "@/lib/production-source";

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
  const sourceSegment = productionSegments(production).find(item => segmentShotIds(item).includes(shotId));
  const matches = sourceSegment ? productionSegmentRuntimeMatches(canvasNodes as any, String(sourceSegment.id)) : [];
  const runtime = matches.length === 1 ? matches[0] : undefined;
  const segment = runtime?.segment;
  const clipKey = typeof segment?.resultStorageKey === "string" ? segment.resultStorageKey : "";
  return {
    ...(frameKey ? { frame: { storageKey: frameKey, inputOutdated: Boolean(asset?.inputOutdated || frameNode?.metadata?.inputOutdated) } } : {}),
    ...(sourceSegment && clipKey ? { clip: { id: String(sourceSegment.id), storageKey: clipKey, inputOutdated: Boolean(segment?.inputOutdated) } } : {}),
  };
}
