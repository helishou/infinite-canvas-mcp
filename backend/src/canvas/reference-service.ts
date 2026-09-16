import crypto from "node:crypto";

import { compileReferenceSubmission, inferReferenceMediaType, inferReferenceRole, referenceCatalogOf, type ProjectReferenceAsset } from "@basketikun/canvas-agent/reference-contract";
import type { BackendEventBus } from "../events.js";
import type { Stores } from "../stores/types.js";

export class CanvasReferenceService {
    constructor(private readonly stores: Stores, private readonly events: BackendEventBus) {}

    list(projectId: string) {
        const project = this.project(projectId);
        return referenceCatalogOf(project);
    }

    upsert(projectId: string, input: Record<string, unknown>) {
        const project = this.project(projectId);
        const now = new Date().toISOString();
        const id = String(input.id || `reference-${crypto.randomUUID()}`);
        const existing = referenceCatalogOf(project).find((asset) => asset.id === id);
        const merged = { ...existing, ...input };
        const asset: ProjectReferenceAsset = {
            ...merged,
            id,
            label: String(input.label || input.name || existing?.label || id),
            mediaType: inferReferenceMediaType(merged),
            role: inferReferenceRole(merged),
            tags: Array.isArray(input.tags) ? input.tags.map(String) : existing?.tags || [],
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        } as ProjectReferenceAsset;
        const result = this.stores.projects.applyOperations(projectId, undefined, [{ type: "upsert_reference_asset", asset }]);
        this.publish(projectId, result);
        return asset;
    }

    remove(projectId: string, assetId: string) {
        this.project(projectId);
        const result = this.stores.projects.applyOperations(projectId, undefined, [{ type: "delete_reference_asset", assetId }]);
        this.publish(projectId, result);
        return !Boolean((result.operationResults[0] as { skipped?: boolean } | undefined)?.skipped);
    }

    validate(projectId: string, nodeId: string, segmentId: string) {
        const project = this.project(projectId);
        const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as Record<string, unknown> | undefined;
        if (!node) throw new Error(`找不到 H3 节点：${nodeId}`);
        const metadata = recordOf(node.metadata);
        const segments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
        const segment = segments.find((item) => String(item.id || "") === segmentId);
        if (!segment) throw new Error(`找不到 H3 Clip：${segmentId}`);
        return compileReferenceSubmission(project, segment);
    }

    private project(projectId: string) {
        const project = this.stores.projects.get(projectId);
        if (!project) throw new Error(`画布不存在：${projectId}`);
        return project;
    }

    private publish(projectId: string, result: ReturnType<Stores["projects"]["applyOperations"]>) {
        this.events.publishCanvasDelta({ entityId: projectId, revision: result.revision, operations: result.operations, updatedAt: String(result.project.updatedAt || ""), source: { clientId: "system:references", kind: "system", label: "参考资产" } });
    }
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
