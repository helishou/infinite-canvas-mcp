import { createHash } from "node:crypto";
import { h3PromptContent } from "./h3-params.js";
import type { Stores } from "../stores/types.js";

export type H3ClipDiagnosisRow = {
    nodeId: string; segmentId: string; title: string | null; sourceShotId: string | null;
    livePromptHash: string | null; publishedPromptHash: string | null;
    promptState: "match" | "different" | "unavailable";
    liveSourceHash: string | null; publishedSourceHash: string | null;
    sourceState: "match" | "different" | "unavailable";
    code: string; reason: string; next: string; severity: "info"; status: string;
};

export type H3ClipDiagnosis = {
    projectId: string; revision: number; ownerId: string | null;
    publishedVersion: number | null; productionRevision: number | null;
    total: number; offset: number; pageSize: number; truncated: boolean; nextOffset?: number;
    counts: { match: number; different: number; unavailable: number; missingLive: number };
    rows: H3ClipDiagnosisRow[];
};

const normalizedPromptHash = (prompt: unknown) =>
    typeof prompt === "string" && prompt.trim() ? createHash("sha256").update(h3PromptContent(prompt)).digest("hex") : null;

function compareRow(nodeId: string, segment: Record<string, unknown>, required: { promptContentHash?: string; sourceHash?: string } | null): H3ClipDiagnosisRow {
    const livePromptHash = normalizedPromptHash(segment.prompt);
    const publishedPromptHash = required?.promptContentHash || null;
    const promptState: H3ClipDiagnosisRow["promptState"] = !livePromptHash || !publishedPromptHash ? "unavailable"
        : livePromptHash === publishedPromptHash ? "match" : "different";
    const liveSourceHash = typeof segment.directorSourceHash === "string" ? segment.directorSourceHash : null;
    const publishedSourceHash = required?.sourceHash || null;
    const sourceState: H3ClipDiagnosisRow["sourceState"] = !liveSourceHash || !publishedSourceHash ? "unavailable"
        : liveSourceHash === publishedSourceHash ? "match" : "different";
    const code = promptState === "different" ? "CLIP_TEXT_DIFFERS_FROM_PUBLISHED"
        : promptState === "unavailable" ? "CLIP_TEXT_NOT_COMPARABLE"
        : sourceState === "different" ? "CLIP_SOURCE_HASH_DIFFERS" : "CLIP_MATCHES_PUBLISHED";
    const reason = promptState === "different" ? "现场正文与最新发布编译产物不同（画布契约允许手动编辑，仅供参考）。"
        : promptState === "unavailable" ? (livePromptHash ? "发布稿缺该段编译产物或哈希，无法比对。" : "现场该段没有正文，无法比对。")
        : sourceState === "different" ? "现场记录的导演源哈希落后于当前发布源。" : "现场正文与导演源哈希均与发布稿一致。";
    const next = promptState === "different" ? "若需两者一致：把画布侧改动经导演工作台采用并重新编译发布；仅排障则无需处理。"
        : promptState === "unavailable" ? "用 production_get_artifact_index(kind=canvas, id=画布ID, targetIds=[该段], pageSize=1) 确认编译产物是否存在。"
        : "";
    return {
        nodeId, segmentId: String(segment.id || ""),
        title: typeof segment.title === "string" ? segment.title : null,
        sourceShotId: typeof segment.sourceShotId === "string" ? segment.sourceShotId : null,
        livePromptHash, publishedPromptHash, promptState,
        liveSourceHash, publishedSourceHash, sourceState,
        code, reason, next, severity: "info", status: String(segment.status || "idle"),
    };
}

/** 只读：逐段比对现场 Clip 与最新发布编译产物。不写库、不改任务、不生成。 */
export function diagnoseH3Clips(stores: Stores, input: { projectId: string; nodeId?: string; nodeIds?: string[]; offset?: number; pageSize?: number }): H3ClipDiagnosis {
    const project = stores.projects.get(input.projectId);
    if (!project) throw new Error(`画布不存在: ${input.projectId}`);
    const requirements = stores.projects.getH3ProductionRequirements?.(input.projectId) || null;
    const wanted = input.nodeIds?.length ? new Set(input.nodeIds) : input.nodeId ? new Set([input.nodeId]) : null;
    const rows: H3ClipDiagnosisRow[] = [];
    const seen = new Set<string>();
    for (const node of project.nodes as Array<Record<string, unknown>>) {
        const nodeId = String(node.id || "");
        if (wanted && !wanted.has(nodeId)) continue;
        const metadata = node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata) ? node.metadata as Record<string, unknown> : {};
        const segments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
        for (const segment of segments) {
            const segmentId = String(segment.id || "");
            if (!segmentId) continue;
            const required = requirements?.clips.find(item => item.nodeId === nodeId && item.segmentId === segmentId);
            if (!required && !segment.directorEngine) continue;
            seen.add(`${nodeId}\u0000${segmentId}`);
            rows.push(compareRow(nodeId, segment, required || null));
        }
    }
    for (const clip of requirements?.clips || []) {
        if (wanted && !wanted.has(clip.nodeId)) continue;
        if (seen.has(`${clip.nodeId}\u0000${clip.segmentId}`)) continue;
        rows.push({
            nodeId: clip.nodeId, segmentId: clip.segmentId, title: null, sourceShotId: null,
            livePromptHash: null, publishedPromptHash: clip.promptContentHash || null, promptState: "unavailable",
            liveSourceHash: null, publishedSourceHash: clip.sourceHash || null, sourceState: "unavailable",
            code: "CLIP_MISSING_ON_CANVAS", reason: "发布稿仍引用该目标，但现场画布节点或片段已不存在。",
            next: "核对画布节点是否被删除，或在导演工作台重新准备该目标。", severity: "info", status: "missing",
        });
    }
    const offset = Math.max(0, input.offset || 0);
    const pageSize = Math.min(Math.max(1, input.pageSize || 200), 1000);
    const page = rows.slice(offset, offset + pageSize);
    const truncated = offset + page.length < rows.length;
    const counted = (state: H3ClipDiagnosisRow["promptState"]) => rows.filter(row => row.code !== "CLIP_MISSING_ON_CANVAS" && row.promptState === state).length;
    return {
        projectId: input.projectId, revision: Number(project.revision || 0), ownerId: requirements?.ownerId || null,
        publishedVersion: requirements?.version ?? null, productionRevision: requirements?.revision ?? null,
        total: rows.length, offset, pageSize, truncated, ...(truncated ? { nextOffset: offset + page.length } : {}),
        counts: {
            match: counted("match"), different: counted("different"), unavailable: counted("unavailable"),
            missingLive: rows.filter(row => row.code === "CLIP_MISSING_ON_CANVAS").length,
        },
        rows: page,
    };
}
