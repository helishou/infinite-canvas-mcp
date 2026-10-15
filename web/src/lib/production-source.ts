import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import type { EpisodeProduction } from "@/services/backend-api";
import type { CanvasNodeData } from "@/types/canvas";

export type ProductionRecordView = "draft" | "published";
export type ProductionSourceRow = Record<string, any>;

export function productionSource(production: Pick<EpisodeProduction, "draft"> & Partial<Pick<EpisodeProduction, "published">>, view: ProductionRecordView = "draft") {
    const snapshot = production[view];
    return snapshot?.director?.source as Record<string, any> | undefined;
}

export function productionShots(production: Pick<EpisodeProduction, "draft"> & Partial<Pick<EpisodeProduction, "published">>, view: ProductionRecordView = "draft"): ProductionSourceRow[] {
    const source = productionSource(production, view);
    if (source && isSubjectPromptAssembly(source)) return Array.isArray(source.shots) ? source.shots : [];
    return production[view]?.shots || [];
}

export function productionSegments(production: Pick<EpisodeProduction, "draft"> & Partial<Pick<EpisodeProduction, "published">>, view: ProductionRecordView = "draft"): ProductionSourceRow[] {
    const source = productionSource(production, view);
    if (source && isSubjectPromptAssembly(source)) return Array.isArray(source.segments) ? source.segments : [];
    return production[view]?.clipGroups || [];
}

export function segmentShotIds(segment: ProductionSourceRow): string[] {
    const ids = Array.isArray(segment.shot_ids) ? segment.shot_ids : Array.isArray(segment.shotIds) ? segment.shotIds : [];
    return ids.map(String);
}

export function shotTitle(shot: ProductionSourceRow | undefined, fallback = "") {
    return String(shot?.title || shot?.display_name || shot?.id || fallback);
}

export type ProductionSegmentRuntimeMatch = {
    node: CanvasNodeData;
    segment: Record<string, any>;
    index: number;
};

/** Resolve runtime identity from Canvas metadata; never synthesize a second source segment record. */
export function productionSegmentRuntimeMatches(
    nodes: readonly CanvasNodeData[],
    targetId: string,
    owner?: { kind: string; id: string },
): ProductionSegmentRuntimeMatch[] {
    const matches: ProductionSegmentRuntimeMatch[] = [];
    for (const node of nodes) {
        const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata as Record<string, any> : {};
        if (owner && (metadata.productionOwnerKind && metadata.productionOwnerKind !== owner.kind
            || metadata.productionOwnerId && metadata.productionOwnerId !== owner.id)) continue;
        const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
        for (const [index, value] of segments.entries()) {
            const segment = value && typeof value === "object" ? value as Record<string, any> : {};
            const projection = segment.productionClipProjection && typeof segment.productionClipProjection === "object"
                ? segment.productionClipProjection as Record<string, any> : {};
            if (String(projection.targetId || "") === targetId) matches.push({ node, segment, index });
        }
    }
    return matches;
}
