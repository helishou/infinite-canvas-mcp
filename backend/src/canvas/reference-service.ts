import crypto from "node:crypto";

import { compileReferenceSubmission, inferReferenceMediaType, inferReferenceRole, referenceCatalogOf, type ProjectReferenceAsset } from "@basketikun/canvas-agent/reference-contract";
import type { Stores } from "../stores/types.js";
import { ReferenceWriteMonitor, type ReferenceWriteMonitorAlert } from "./write-monitor.js";

export class CanvasReferenceService {
    private readonly writeMonitor: ReferenceWriteMonitor;

    constructor(private readonly stores: Stores, onWriteAlert?: (alert: ReferenceWriteMonitorAlert) => void) {
        this.writeMonitor = new ReferenceWriteMonitor(onWriteAlert);
    }

    list(projectId: string) {
        const project = this.project(projectId);
        return referenceCatalogOf(project);
    }

    upsert(projectId: string, input: Record<string, unknown>) {
        const project = this.project(projectId);
        const result = this.buildUpsert(projectId, project, input);
        if (result.changed) {
            this.stores.projects.applyOperations(projectId, undefined, [{ type: "upsert_reference_asset", asset: result.asset }], { source: { clientId: "system:references", kind: "system", label: "参考资产" } });
        }
        return result.asset;
    }

    upsertMany(projectId: string, inputs: Array<Record<string, unknown>>) {
        const project = this.project(projectId);
        const existing = new Map(referenceCatalogOf(project).map((asset) => [asset.id, asset]));
        const assets: ProjectReferenceAsset[] = [];
        const operations: Array<{ type: "upsert_reference_asset"; asset: ProjectReferenceAsset }> = [];
        for (const input of inputs) {
            const result = this.buildUpsert(projectId, project, input, existing);
            assets.push(result.asset);
            if (result.changed) operations.push({ type: "upsert_reference_asset", asset: result.asset });
            existing.set(result.asset.id, result.asset);
        }
        if (operations.length) {
            this.stores.projects.applyOperations(projectId, undefined, operations, { source: { clientId: "system:references", kind: "system", label: "参考资产" } });
        }
        return assets;
    }

    private buildUpsert(projectId: string, project: ReturnType<CanvasReferenceService["project"]>, input: Record<string, unknown>, existingById?: Map<string, ProjectReferenceAsset>) {
        const now = new Date().toISOString();
        const id = String(input.id || `reference-${crypto.randomUUID()}`);
        const existing = existingById?.get(id) || referenceCatalogOf(project).find((asset) => asset.id === id);
        // subjectId belongs to the binding context. One project asset can be reused
        // by clips that map the same media to different character subjects; do not
        // let those bindings overwrite each other in the shared catalog.
        const subjectId = existing?.subjectId || (typeof input.subjectId === "string" ? input.subjectId.trim() : "") || undefined;
        const merged = { ...existing, ...input, ...(subjectId ? { subjectId } : {}) };
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
        if (existing && sameReferenceAsset(existing, asset)) {
            this.writeMonitor.record({ projectId, assetId: id, changed: false });
            return { asset: existing, changed: false };
        }
        this.writeMonitor.record({ projectId, assetId: id, changed: true });
        return { asset, changed: true };
    }

    monitor(projectId: string) {
        this.project(projectId);
        return this.writeMonitor.snapshot(projectId);
    }

    remove(projectId: string, assetId: string) {
        this.project(projectId);
        const result = this.stores.projects.applyOperations(projectId, undefined, [{ type: "delete_reference_asset", assetId }], { source: { clientId: "system:references", kind: "system", label: "参考资产" } });
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

}

function sameReferenceAsset(left: ProjectReferenceAsset, right: ProjectReferenceAsset) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => key !== "createdAt" && key !== "updatedAt"));
    return [...keys].every((key) => sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function sameValue(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    if ((left && typeof left === "object") || (right && typeof right === "object")) {
        try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
    }
    return String(left ?? "") === String(right ?? "");
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
