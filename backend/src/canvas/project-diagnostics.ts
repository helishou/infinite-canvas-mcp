import fs from "node:fs";

import type { CanvasProject } from "../db.js";
import type { CanvasOperation } from "./project-ops.js";
import type { Stores } from "../stores/types.js";

export type CanvasDiagnosticSeverity = "error" | "warning";
export type CanvasDiagnostic = {
    issueId: string;
    kind: "dangling_connection" | "duplicate_connection" | "mixed_references" | "missing_media" | "orphan_result";
    severity: CanvasDiagnosticSeverity;
    message: string;
    nodeIds: string[];
    connectionIds: string[];
    suggestedOperations: CanvasOperation[];
};

/**
 * 只读检查画布快照。修复建议只返回标准 CanvasOperation，绝不在诊断阶段修改项目或媒体。
 */
export function diagnoseCanvasProject(project: CanvasProject, stores: Stores): CanvasDiagnostic[] {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
    const nodeIds = new Set(nodes.map((node) => String(node.id || "")).filter(Boolean));
    const diagnostics: CanvasDiagnostic[] = [];
    const issue = (input: Omit<CanvasDiagnostic, "issueId">) => diagnostics.push({ ...input, issueId: `canvas-${input.kind}-${diagnostics.length + 1}` });

    for (const connection of connections) {
        const id = String(connection.id || "");
        const fromNodeId = String(connection.fromNodeId || "");
        const toNodeId = String(connection.toNodeId || "");
        const missing = [!nodeIds.has(fromNodeId) ? `起点 ${fromNodeId || "空"}` : "", !nodeIds.has(toNodeId) ? `终点 ${toNodeId || "空"}` : ""].filter(Boolean);
        if (missing.length) issue({
            kind: "dangling_connection", severity: "error", message: `连线 ${id || "未命名"} 引用了不存在的${missing.join("、")}`,
            nodeIds: [fromNodeId, toNodeId].filter(Boolean), connectionIds: [id].filter(Boolean),
            suggestedOperations: [{ type: "delete_connections", ids: [id] }],
        });
    }

    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const connection of connections) {
        const key = [connection.fromNodeId, connection.toNodeId, connection.role || ""].map(String).join("\u0000");
        const group = groups.get(key) || [];
        group.push(connection);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const duplicates = group.slice(1).map((connection) => String(connection.id || "")).filter(Boolean);
        issue({
            kind: "duplicate_connection", severity: "warning", message: `同一来源、目标和角色存在 ${group.length} 条重复连线，保留第一条`,
            nodeIds: [...new Set(group.flatMap((connection) => [String(connection.fromNodeId || ""), String(connection.toNodeId || "")].filter(Boolean)))],
            connectionIds: group.map((connection) => String(connection.id || "")).filter(Boolean),
            suggestedOperations: duplicates.length ? [{ type: "delete_connections", ids: duplicates }] : [],
        });
    }

    const incoming = new Map<string, Array<{ connection: Record<string, unknown>; node: Record<string, unknown> }>>();
    for (const connection of connections) {
        const node = nodes.find((item) => String(item.id || "") === String(connection.fromNodeId || ""));
        if (!node) continue;
        const list = incoming.get(String(connection.toNodeId || "")) || [];
        list.push({ connection, node });
        incoming.set(String(connection.toNodeId || ""), list);
    }
    for (const target of nodes) {
        if (!isGenerationNode(target)) continue;
        const refs = (incoming.get(String(target.id)) || []).filter(({ node }) => ["image", "video", "audio"].includes(String(node.type)));
        const byStorageKey = new Map<string, typeof refs>();
        for (const ref of refs) {
            const storageKey = String(recordOf(ref.node.metadata).storageKey || "");
            if (!storageKey) continue;
            const same = byStorageKey.get(storageKey) || [];
            same.push(ref);
            byStorageKey.set(storageKey, same);
        }
        for (const same of byStorageKey.values()) {
            if (same.length < 2) continue;
            issue({
                kind: "mixed_references", severity: "warning", message: `生成节点「${String(target.title || target.id)}」同时挂载了同一媒体的多条参考线，可能是二次生成未替换旧参考`,
                nodeIds: [String(target.id), ...same.map(({ node }) => String(node.id || ""))].filter(Boolean),
                connectionIds: same.map(({ connection }) => String(connection.id || "")).filter(Boolean),
                suggestedOperations: [{ type: "delete_connections", ids: same.slice(1).map(({ connection }) => String(connection.id || "")).filter(Boolean) }],
            });
        }
    }

    const storageKeys = new Map<string, string[]>();
    for (const node of nodes) collectStorageKeys(node, storageKeys, String(node.id || ""));
    for (const [storageKey, owners] of storageKeys) {
        const media = stores.media.meta(storageKey);
        if (media && fs.existsSync(media.filePath)) continue;
        issue({
            kind: "missing_media", severity: "error", message: `媒体 ${storageKey} 不存在或文件已丢失`,
            nodeIds: [...new Set(owners)].filter(Boolean), connectionIds: [], suggestedOperations: [],
        });
    }

    for (const node of nodes) {
        const metadata = recordOf(node.metadata);
        const sourceId = String(metadata.generatedFromNodeId || metadata.sourceNodeId || metadata.resultOf || "");
        if (!sourceId || nodeIds.has(sourceId)) continue;
        if (!["image", "video", "audio"].includes(String(node.type))) continue;
        issue({
            kind: "orphan_result", severity: "warning", message: `结果节点「${String(node.title || node.id)}」引用的生成节点 ${sourceId} 已不存在`,
            nodeIds: [String(node.id || "")].filter(Boolean), connectionIds: [], suggestedOperations: [],
        });
    }
    return diagnostics;
}

function isGenerationNode(node: Record<string, unknown>) {
    const type = String(node.type || "").toLowerCase();
    const metadata = recordOf(node.metadata);
    return type === "config" || type.includes("generation") || type.includes("minimax-h3") || ["image", "video", "audio"].includes(String(metadata.mode || ""));
}

function collectStorageKeys(value: unknown, owners: Map<string, string[]>, ownerId: string) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach((item) => collectStorageKeys(item, owners, ownerId));
        return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.storageKey === "string" && record.storageKey.includes(":")) {
        const list = owners.get(record.storageKey) || [];
        list.push(ownerId);
        owners.set(record.storageKey, list);
    }
    Object.values(record).forEach((item) => collectStorageKeys(item, owners, ownerId));
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
