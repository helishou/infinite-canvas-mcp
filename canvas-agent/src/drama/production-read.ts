import { z } from "zod";

export const productionReadSchema = z.object({
    view: z.enum(["summary", "source", "artifacts", "artifact_index", "full"]).default("summary"),
    snapshot: z.enum(["draft", "published"]).default("draft"),
    targetIds: z.array(z.string().min(1)).optional(),
    sourceSection: z.enum(["context", "asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "ledger.facts", "ledger.timelines", "ledger.initial", "ledger.events", "ledger.requirements", "ledger.coverage"]).optional(),
    pageSize: z.coerce.number().int().positive().optional(),
    cursor: z.string().optional(),
    chunkBytes: z.coerce.number().int().positive().optional(),
});
export function productionReadQuery(raw: unknown) {
    const input = productionReadSchema.parse(raw);
    const query = new URLSearchParams({ view: input.view, snapshot: input.snapshot });
    if (input.targetIds) query.set("targetIds", input.targetIds.join(","));
    for (const key of ["sourceSection", "pageSize", "cursor", "chunkBytes"] as const) if (input[key] !== undefined) query.set(key, String(input[key]));
    return `?${query}`;
}

/** MCP reads select one complete payload instead of repeating source/prompts/history. */
export function projectProductionRead(production: any, raw: unknown = {}, digest?: (value: string) => string, fullValue: unknown = production) {
    const input = productionReadSchema.parse(raw);
    if (input.view === "full" && !input.chunkBytes) return fullValue;
    const header = { episodeId: production.episodeId, ...(production.sceneId ? { sceneId: production.sceneId } : {}), ...(production.projectId ? { projectId: production.projectId } : {}), revision: production.revision, publishedVersion: production.publishedVersion, updatedAt: production.updatedAt };
    const selected = production[input.snapshot];
    const d = selected?.director;
    const selection = JSON.stringify({ owner: production.episodeId, snapshot: input.snapshot, revision: production.revision, versionHash: production.versionHash, sourceHash: d?.sourceHash, view: input.view, targetIds: input.targetIds, section: input.sourceSection, chunkBytes: input.chunkBytes });
    let offset = 0;
    if (input.cursor) {
        let cursor: any;
        try { cursor = JSON.parse(decodeURIComponent(input.cursor)); } catch { throw new Error("INVALID_CURSOR"); }
        if (cursor.selection !== selection) throw new Error("READ_CURSOR_EXPIRED: 读取对象或版本已变化，请从当前版本重新读取");
        offset = z.number().int().nonnegative().parse(cursor.offset);
    }
    const next = (index: number) => encodeURIComponent(JSON.stringify({ selection, offset: index }));
    const paginate = (items: any[]) => {
        if (input.cursor && !input.pageSize && !input.chunkBytes) throw new Error("游标读取必须携带 pageSize 或 chunkBytes");
        const end = input.pageSize ? offset + input.pageSize : items.length;
        return { items: items.slice(offset, end), total: items.length, nextCursor: end < items.length ? next(end) : null };
    };
    const chunk = (value: string) => {
        if (!digest) throw new Error("分块读取需要 Backend 完整性摘要");
        const bytes = new TextEncoder().encode(value);
        if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error("INVALID_CURSOR: 非 UTF-8 边界");
        let end = Math.min(bytes.length, offset + input.chunkBytes!);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        if (end === offset && offset < bytes.length) throw new Error("CHUNK_TOO_SMALL: chunkBytes 无法容纳下一个字符");
        return { sha256: digest(value), bytes: bytes.length, offset, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset, end)), nextCursor: end < bytes.length ? next(end) : null };
    };
    if (input.view === "full") return { ...header, snapshot: input.snapshot, chunk: chunk(JSON.stringify(fullValue)) };
    const selectedArtifacts = (d?.artifacts || []).filter((a: any) => !input.targetIds || input.targetIds.includes(a.targetId));
    if (input.view === "source") {
        if (input.targetIds && !input.sourceSection) throw new Error("定向源稿读取必须指定 sourceSection");
        const source = d?.source || null;
        const section = input.sourceSection === "context" ? Object.fromEntries(Object.entries(source || {}).filter(([key]) => !["asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "ledger"].includes(key))) : input.sourceSection?.startsWith("ledger.") ? source?.ledger?.[input.sourceSection.split(".")[1]] : input.sourceSection ? source?.[input.sourceSection] : source;
        const filtered = Array.isArray(section) && input.targetIds ? section.filter((item: any) => input.targetIds!.includes(String(item.id || item.asset_id || item.shot_id || item.segment_id || item.fact_id))) : section;
        if (input.chunkBytes) {
            const value = Array.isArray(filtered) ? (filtered.length === 1 ? filtered[0] : undefined) : filtered;
            if (value === undefined) throw new Error("分块读取必须选定一个源稿对象");
            return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, chunk: chunk(JSON.stringify(value)) };
        }
        return { ...header, snapshot: input.snapshot, engine: d?.engine, sourceHash: d?.sourceHash,
            ...(input.sourceSection === "context" ? { omittedSourceSections: ["asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "ledger"], ledgerSummary: source?.ledger ? { contractVersion: source.ledger.contract_version, counts: Object.fromEntries(["facts", "timelines", "initial", "events", "requirements", "coverage"].map(key => [key, Array.isArray(source.ledger[key]) ? source.ledger[key].length : 0])) } : null } : {}),
            ...(Array.isArray(filtered) && input.pageSize ? { source: paginate(filtered) } : { source: filtered }) };
    }
    if (input.view === "artifacts" || input.view === "artifact_index") {
        if (input.chunkBytes) {
            if (input.view !== "artifacts" || selectedArtifacts.length !== 1) throw new Error("分块读取必须选定一个产物");
            return { ...header, snapshot: input.snapshot, targetId: selectedArtifacts[0].targetId, chunk: chunk(selectedArtifacts[0].prompt) };
        }
        const artifacts = input.view === "artifact_index" ? selectedArtifacts.map(({ prompt, references = [], ...a }: any) => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, sourceHash: a.sourceHash, promptBytes: new TextEncoder().encode(prompt).length, referenceCount: references.length })) : selectedArtifacts;
        return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, ...(input.pageSize ? { artifacts: paginate(artifacts) } : { artifacts }) };
    }
    const summarize = (data: any) => data ? {
        director: data.director ? { engine: data.director.engine, sourceHash: data.director.sourceHash,
            executionAuthorized: data.director.executionAuthorized,
            modules: Object.fromEntries(Object.entries(data.director.modules || {}).map(([key, value]) => [key, pick(value, ["status"])])),
            workflow: { ...pick(data.director.workflow, ["contentDeliveryMode", "mediaProductionMode", "agentThreadId"]), currentWork: pick(data.director.workflow?.currentWork, ["workId", "module", "action", "inputRevision", "runId", "taskId", "status", "targetId", "targetKind"]) },
            counts: { modules: count(data.director.modules), assets: count(data.director.assets), artifacts: count(data.director.artifacts), unresolved: count(data.director.unresolved) },
            source: pick(data.director.source, ["production_total_duration", "fps_num", "fps_den"]),
        } : null,
        counts: { scenes: count(data.scenes), shots: count(data.shots), clipGroups: count(data.clipGroups), keyframes: count(data.keyframes), keyframeReviews: count(data.keyframeReviews) },
    } : null;
    const owner = production.sceneId ? { tool: "production_get_scene_production", input: { sceneId: production.sceneId } }
        : production.projectId ? { tool: "canvas_get_production", input: { projectId: production.projectId } } : { tool: "drama_get_production", input: { episodeId: production.episodeId } };
    return { ...header, view: "summary", snapshot: input.snapshot, [input.snapshot]: summarize(selected),
        omitted: ["source", "artifacts", "references", "scenes", "shots", "clipGroups", "keyframes", "keyframeReviews", "settings"],
        nextRead: { tool: owner.tool, input: { ...owner.input, snapshot: input.snapshot, view: "artifact_index", ...(input.targetIds ? { targetIds: input.targetIds } : {}) } },
        readOptions: { views: ["source", "artifact_index", "artifacts", "full"], selectors: ["sourceSection", "targetIds", "pageSize", "cursor", "chunkBytes"] } };
}

function count(value: any): number { return Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0; }
function pick(value: any, keys: string[]): Record<string, unknown> {
    return Object.fromEntries(keys.filter(key => ["string", "number", "boolean"].includes(typeof value?.[key])).map(key => [key, value[key]]));
}

/** Project the frozen version itself: live draft revisions never enter its cursor identity. */
export function projectProductionVersion(owner: { episodeId: string; projectId?: string; sceneId?: string }, version: any, raw: unknown, digest: (value: string) => string) {
    const snapshot = version.snapshot;
    const versionHash = digest(JSON.stringify(snapshot));
    const input = productionReadSchema.parse(raw);
    const projected = projectProductionRead({ ...owner, revision: version.version, publishedVersion: version.version, updatedAt: version.createdAt,
        versionHash, draft: snapshot, published: snapshot }, input, digest, snapshot);
    if (input.view === "summary") {
        const summary = projected as any;
        summary.nextRead = { tool: owner.sceneId ? "production_get_scene_version" : owner.projectId ? "canvas_get_production_version" : "drama_get_production_version",
            input: { [owner.sceneId ? "sceneId" : owner.projectId ? "projectId" : "episodeId"]: owner.sceneId || owner.projectId || owner.episodeId, version: version.version, view: "artifact_index" } };
    }
    return { ...pick(version, ["version", "stage", "createdAt"]), ...owner, sha256: versionHash,
        ...(input.view === "full" && !input.chunkBytes ? { impact: version.impact } : {}), snapshot: projected };
}

/** Only scalar identities and counts cross the MCP write boundary. Never spread backend payloads. */
export function productionWriteReceipt(result: any, context: { tool?: string; input?: Record<string, any> } = {}) {
    if (context.tool === "production_hash_source") return result;
    // Non-production endpoints (continuity checks, adoption retries) own their separate receipts.
    if (!result.production && !result.project) return result;
    const input = context.input || {};
    const p = result.production || {};
    const layout = result.layoutReceipt || p.layoutReceipt || {};
    const syncReceipt = p.syncReceipt || result.syncReceipt;
    const sync = Array.isArray(p.referenceSync) ? p.referenceSync : [];
    const diagnosticCodes = [...new Set([...sync.flatMap((item: any) => item.diagnostics || []), ...(layout.diagnostics || [])].map((item: any) => String(item.code || "UNKNOWN")))];
    const ownerId = input.id || input.projectId || input.sceneId || input.episodeId || p.episodeId;
    const kind = input.kind || (input.sceneId && !input.episodeId && !input.projectId ? "scene" : input.projectId || context.tool?.startsWith("canvas_") ? "canvas" : "episode");
    const tool = kind === "scene" ? "production_get_scene_production" : kind === "canvas" ? "canvas_get_production" : "drama_get_production";
    const readInput = { [kind === "scene" ? "sceneId" : kind === "canvas" ? "projectId" : "episodeId"]: ownerId, view: "summary" };
    return { ...pick(result, ["ok", "replayed", "mediaSubmitted", "mediaAuthorized", "operationId", "workId", "runId", "status", "updated", "created", "reused", "skipped"]),
        ...pick(input, ["operationId", "sceneId", "projectId", "episodeId"]),
        production: { ...pick(p, ["episodeId", "revision", "publishedVersion", "updatedAt", "replayed"]), sourceHash: p.draft?.director?.sourceHash, engine: p.draft?.director?.engine },
        ...(result.canvas ? { canvas: { ...pick(result.canvas, ["id", "projectId", "revision"]), nodeCount: count(result.canvas.nodes), connectionCount: count(result.canvas.connections) } } : {}),
        ...(result.project ? { project: { ...pick(result.project, ["id", "revision", "title"]), nodeCount: count(result.project.nodes), connectionCount: count(result.project.connections) }, context: pick(result.context, ["role", "canvasId", "episodeId", "dramaId", "sceneId", "sharedAssetCanvasId"]) } : {}),
        ...(result.sharedReview ? { sharedReview: { ...pick(result.sharedReview, ["inputHash"]), mediaCount: count(result.sharedReview.media) } } : {}),
        ...(result.layoutReceipt || p.layoutReceipt ? { layoutReceipt: { ...pick(layout, ["planHash", "algorithmVersion", "canvasRevision"]), created: count(layout.created), reused: count(layout.reused), diagnostics: count(layout.diagnostics) } } : {}),
        counts: { created: count(layout.created), reused: count(layout.reused), ready: sync.filter((item: any) => item.status === "ready").length,
            updated: syncReceipt?.updated ?? (typeof result.updated === "number" ? result.updated : sync.filter((item: any) => item.status === "updated").length),
            skipped: syncReceipt?.skipped ?? (typeof result.skipped === "number" ? result.skipped : sync.filter((item: any) => item.status === "unchanged" || item.status === "skipped").length),
            ...(syncReceipt ? pick(syncReceipt, ["bound", "reordered"]) : {}),
            blocked: sync.filter((item: any) => item.status === "blocked").length,
            conflicts: sync.filter((item: any) => (item.diagnostics || []).some((d: any) => String(d.code).includes("CONFLICT"))).length, referenceSync: sync.length },
        warnings: { count: sync.reduce((n: number, item: any) => n + count(item.diagnostics), 0) + count(layout.diagnostics), codes: diagnosticCodes },
        ...(result.project ? { nextRead: { tool: "production_get_canvas_context", input: { projectId: result.project.id } } } : ownerId ? { nextRead: { tool: context.tool?.includes("scene_work") || context.tool === "production_start_shared_review" ? "production_get_scene_work" : tool,
            input: context.tool?.includes("scene_work") || context.tool === "production_start_shared_review" ? { kind, id: ownerId } : readInput } } : {}) };
}
