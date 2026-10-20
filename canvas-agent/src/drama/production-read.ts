import { z } from "zod";

export const productionSourceSectionSchema = z.enum(["context", "script", "production_shots", "clip_groups", "keyframes", "keyframe_reviews", "settings", "asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "subject_registry", "utterances", "ledger.facts", "ledger.timelines", "ledger.initial", "ledger.events", "ledger.requirements", "ledger.coverage"]);
export const productionReadSchema = z.object({
    view: z.enum(["summary", "source", "artifacts", "artifact_index", "full", "subject_workbench", "shot_workbench", "clip_workbench"]).default("summary"),
    snapshot: z.enum(["draft", "published"]).default("draft"),
    targetIds: z.array(z.string().min(1)).optional(),
    sourceSection: productionSourceSectionSchema.optional(),
    pageSize: z.coerce.number().int().positive().optional(),
    cursor: z.string().optional(),
    chunkBytes: z.coerce.number().int().positive().optional(),
    includeContext: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean().optional()),
    includeRuntime: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean().optional()),
    ifRevision: z.coerce.number().int().nonnegative().optional().describe("仅当已完整持有同一对象、snapshot、view 和筛选范围的数据时传其读取 revision；相同则返回 unchanged 短确认。分页续读 cursor 不使用此参数。写回执 revision 不能替代已读内容的版本。"),
});
export function productionReadQuery(raw: unknown) {
    const input = productionReadSchema.parse(raw);
    const query = new URLSearchParams({ view: input.view, snapshot: input.snapshot });
    if (input.targetIds) query.set("targetIds", input.targetIds.join(","));
    for (const key of ["sourceSection", "pageSize", "cursor", "chunkBytes", "includeContext", "includeRuntime", "ifRevision"] as const) if (input[key] !== undefined) query.set(key, String(input[key]));
    return `?${query}`;
}

/** MCP reads select one complete payload instead of repeating source/prompts/history. */
export function projectProductionRead(production: any, raw: unknown = {}, digest?: (value: string) => string, fullValue: unknown = production, artifactStaleReason?: (artifact: any) => string | undefined) {
    const input = productionReadSchema.parse(raw);
    const header = { episodeId: production.episodeId, ...(production.sceneId ? { sceneId: production.sceneId } : {}), ...(production.projectId ? { projectId: production.projectId } : {}), revision: production.revision, publishedVersion: production.publishedVersion, updatedAt: production.updatedAt,
        ...(production.storageFormat === "v2-projection-migration-required" ? { storageFormat: production.storageFormat } : {}),
        ...(production.publishedFormatStatus ? { publishedFormatStatus: production.publishedFormatStatus } : {}) };
    const selected = production[input.snapshot];
    if (input.snapshot === "published" && selected?.director && !subjectPromptV2(selected.director.source)) throw new Error("UNSUPPORTED_PRODUCTION_FORMAT: 历史发布稿是旧版 Director 格式，只能通过维护命令检查；当前 v2 草稿仍可继续编辑。");
    const d = selected?.director;
    const selection = JSON.stringify({ owner: production.episodeId, snapshot: input.snapshot, revision: production.revision, versionHash: production.versionHash, workbenchVersion: production.workbenchVersion, sourceHash: d?.sourceHash, view: input.view, targetIds: input.targetIds, section: input.sourceSection, chunkBytes: input.chunkBytes, includeContext: input.includeContext, includeRuntime: input.includeRuntime });
    let offset = 0;
    if (input.cursor) {
        let cursor: any;
        try { cursor = JSON.parse(decodeURIComponent(input.cursor)); } catch { throw new Error("INVALID_CURSOR"); }
        if (cursor.selection !== selection) throw new Error("READ_CURSOR_EXPIRED: 读取对象或版本已变化，请从当前版本重新读取");
        offset = z.number().int().nonnegative().parse(cursor.offset);
    }
    // 续页仍须返回未读部分；不能让条件读取把同版本的下一页吞掉。
    if (!["clip_workbench", "shot_workbench", "subject_workbench"].includes(input.view) && !input.cursor && input.ifRevision !== undefined && input.ifRevision === production.revision) {
        return { ...header, snapshot: input.snapshot, view: input.view, sourceHash: d?.sourceHash, unchanged: true };
    }
    if (input.view === "full" && !input.chunkBytes) return withoutDirectorProjection(fullValue);
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
    if (input.view === "full") return { ...header, snapshot: input.snapshot, chunk: chunk(JSON.stringify(withoutDirectorProjection(fullValue))) };
    if (["clip_workbench", "shot_workbench", "subject_workbench"].includes(input.view)) {
        if (input.targetIds?.length !== 1) throw new Error("CLIP_WORKBENCH_TARGET: select exactly one Segment");
        const workbench = input.view === "subject_workbench" ? production.subjectWorkbench
            : input.view === "shot_workbench" ? production.shotWorkbench : production.clipWorkbench;
        if (!workbench) throw new Error("CLIP_WORKBENCH_UNAVAILABLE: use the live production read endpoint");
        const selectedWorkbench = input.view === "subject_workbench" || (input.includeContext && input.includeRuntime)
            ? workbench
            : Object.fromEntries(Object.entries(workbench).filter(([key]) => {
                if (key === "context") return input.includeContext === true;
                if (key === "runtime") return input.includeRuntime === true;
                return true;
            }));
        return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, workbenchVersion: production.workbenchVersion,
            ...(input.chunkBytes ? { chunk: chunk(JSON.stringify(selectedWorkbench)) } : { workbench: selectedWorkbench }) };
    }
    const selectedArtifacts = (d?.artifacts || []).filter((a: any) => !input.targetIds || input.targetIds.includes(a.targetId));
    if (input.view === "source") {
        if (input.targetIds && !input.sourceSection) throw new Error("定向源稿读取必须指定 sourceSection");
        const source = d?.source || null;
        if (subjectPromptV2(source) && (input.sourceSection === "production_shots" || input.sourceSection === "clip_groups")) throw new Error("UNSUPPORTED_PRODUCTION_FORMAT: Acheng v2 的 Shot/Segment 只能从 source.shots/source.segments 读取");
        const rootSections: Record<string, unknown> = { script: subjectPromptV2(source) ? source.script_scenes : selected?.scenes,
            production_shots: selected?.shots, clip_groups: selected?.clipGroups, keyframes: selected?.keyframes, keyframe_reviews: selected?.keyframeReviews, settings: selected?.settings };
        const section = input.sourceSection === "context" ? Object.fromEntries(Object.entries(source || {}).filter(([key]) => !["asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "subject_registry", "utterances", "ledger"].includes(key))) : input.sourceSection && Object.hasOwn(rootSections, input.sourceSection) ? rootSections[input.sourceSection] : input.sourceSection?.startsWith("ledger.") ? source?.ledger?.[input.sourceSection.split(".")[1]] : input.sourceSection ? source?.[input.sourceSection] : source;
        const filtered = Array.isArray(section) && input.targetIds ? section.filter((item: any) => input.targetIds!.includes(String(item.id || item.asset_id || item.shot_id || item.segment_id || item.fact_id))) : section;
        if (input.chunkBytes) {
            const value = Array.isArray(filtered) ? (filtered.length === 1 ? filtered[0] : undefined) : filtered;
            if (value === undefined) throw new Error("分块读取必须选定一个源稿对象");
            return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, chunk: chunk(JSON.stringify(value)) };
        }
        return { ...header, snapshot: input.snapshot, engine: d?.engine, sourceHash: d?.sourceHash,
            ...(input.sourceSection === "context" ? { omittedSourceSections: ["script", "production_shots", "clip_groups", "keyframes", "keyframe_reviews", "settings", "asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "subject_registry", "utterances", "ledger"], ledgerSummary: source?.ledger ? { contractVersion: source.ledger.contract_version, counts: Object.fromEntries(["facts", "timelines", "initial", "events", "requirements", "coverage"].map(key => [key, Array.isArray(source.ledger[key]) ? source.ledger[key].length : 0])) } : null } : {}),
            ...(Array.isArray(filtered) && input.pageSize ? { source: paginate(filtered) } : { source: filtered }) };
    }
    if (input.view === "artifacts" || input.view === "artifact_index") {
        if (input.chunkBytes) {
            if (input.view !== "artifacts" || selectedArtifacts.length !== 1) throw new Error("分块读取必须选定一个产物");
            return { ...header, snapshot: input.snapshot, targetId: selectedArtifacts[0].targetId, chunk: chunk(selectedArtifacts[0].prompt) };
        }
        const artifacts = input.view === "artifact_index" ? selectedArtifacts.map((artifact: any) => {
            const { prompt, references = [], ...a } = artifact;
            return {
                id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, sourceHash: a.sourceHash,
                promptBytes: new TextEncoder().encode(typeof prompt === "string" ? prompt : "").length, referenceCount: references.length,
                ...(a.status === "stale" ? { staleReason: artifactStaleReason?.(artifact) || "marked_stale" } : {}),
            };
        }) : selectedArtifacts;
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
        counts: data.director && subjectPromptV2(data.director.source)
            ? { scenes: count(data.director.source.script_scenes), shots: count(data.director.source.shots), clipGroups: count(data.director.source.segments), keyframes: count(data.keyframes), keyframeReviews: count(data.keyframeReviews) }
            : { scenes: count(data.scenes), shots: count(data.shots), clipGroups: count(data.clipGroups), keyframes: count(data.keyframes), keyframeReviews: count(data.keyframeReviews) },
    } : null;
    const owner = production.sceneId ? { tool: "production_get_scene_production", input: { sceneId: production.sceneId } }
        : production.projectId ? { tool: "production_get_artifact_index", input: { kind: "canvas", id: production.projectId } } : { tool: "production_get_artifact_index", input: { kind: "episode", id: production.episodeId } };
    return { ...header, view: "summary", snapshot: input.snapshot, [input.snapshot]: summarize(selected),
        omitted: ["source", "artifacts", "references", "scenes", "shots", "clipGroups", "keyframes", "keyframeReviews", "settings"],
        nextRead: { tool: owner.tool, input: { ...owner.input, snapshot: input.snapshot, pageSize: 50, ...(input.targetIds ? { targetIds: input.targetIds } : {}) } },
        readOptions: production.sceneId ? { tool: "production_get_scene_production", selectors: ["sourceSection", "targetIds", "pageSize", "cursor", "chunkBytes"] }
            : { tools: ["production_get_source", "production_get_artifact_index", "production_get_artifact", "production_get_workbench"] } };
}

function count(value: any): number { return Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0; }
function subjectPromptV2(source: any) { return source?.version === 2 && source?.prompt_assembly?.version === 2 && source?.ledger?.contract_version === 2; }
function withoutDirectorProjection(value: any): any {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const result = { ...value };
    if (result.director && subjectPromptV2(result.director.source)) {
        delete result.scenes;
        delete result.shots;
        delete result.clipGroups;
    }
    for (const key of ["draft", "published"]) {
        const snapshot = result[key];
        if (!snapshot?.director || !subjectPromptV2(snapshot.director.source)) continue;
        const canonical = { ...snapshot };
        delete canonical.scenes;
        delete canonical.shots;
        delete canonical.clipGroups;
        result[key] = canonical;
    }
    if (result.draft?.director && subjectPromptV2(result.draft.director.source) && result.published?.director && !subjectPromptV2(result.published.director.source)) {
        result.published = null;
        result.publishedFormatStatus = "legacy-maintenance-required";
    }
    return result;
}
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
        summary.nextRead = { tool: owner.sceneId ? "production_get_scene_version" : "production_get_version_artifact_index",
            input: { ...(owner.sceneId ? { sceneId: owner.sceneId } : { kind: owner.projectId ? "canvas" : "episode", id: owner.projectId || owner.episodeId }), version: version.version, pageSize: 50 } };
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
    const clipRefreshJobs = Array.isArray(p.clipRefreshes) ? p.clipRefreshes : p.clipRefresh ? [p.clipRefresh] : [];
    const utteranceWriteChecks = (Array.isArray(input.ops) ? input.ops : []).flatMap((operation: any) => operation?.type === "set_director_shot_utterances"
        ? (Array.isArray(operation.utterances) ? operation.utterances : []).flatMap((utterance: any) => {
            if (!utterance?.utteranceId || !Object.hasOwn(utterance, "delivery")) return [];
            const saved = (Array.isArray(p.draft?.director?.source?.utterances) ? p.draft.director.source.utterances : [])
                .find((row: any) => String(row.id || "") === String(utterance.utteranceId));
            return [{ path: `utterances.${utterance.utteranceId}.delivery`, status: saved && saved.delivery === utterance.delivery ? "verified" : "mismatch" }];
        })
        : []);
    const clipRefreshes = clipRefreshJobs.map((job: any) => ({
        operationId: job.operationId, status: job.status, segmentId: job.segmentId, savedRevision: job.savedRevision,
        compilationOperationId: job.compilationOperationId, selectedTargets: job.selectedTargets, affectedTargets: job.affectedTargets,
        blockingDiagnostic: job.blockingDiagnostic, applicationRevision: job.application?.revision,
        referenceSync: Array.isArray(job.application?.referenceSync) ? job.application.referenceSync.map((item: any) => ({ targetId: item.targetId, status: item.status, diagnostics: item.diagnostics })) : [],
        mediaSubmitted: false,
    }));
    const clipRefreshSummary = clipRefreshes.length ? {
        sourceSaved: true, targetCount: clipRefreshes.length, targetIds: clipRefreshes.map((job: any) => job.segmentId),
        ready: clipRefreshes.filter((job: any) => job.status === "succeeded").length,
        running: clipRefreshes.filter((job: any) => ["queued", "checking", "compiling", "applying"].includes(job.status)).length,
        blocked: clipRefreshes.filter((job: any) => job.status === "blocked").length,
        failed: clipRefreshes.filter((job: any) => ["failed", "interrupted"].includes(job.status)).length,
        mediaSubmitted: false,
    } : undefined;
    const syncIssues = sync.flatMap((item: any) => {
        const diagnostics = Array.isArray(item.diagnostics) ? item.diagnostics : [];
        const relevant = item.status === "blocked" ? diagnostics : diagnostics.filter((diagnostic: any) => String(diagnostic.code || "").includes("CONFLICT"));
        if (item.status !== "blocked" && !relevant.length) return [];
        return [{ targetId: item.targetId, status: item.status, diagnostics: relevant.slice(0, 1).map((diagnostic: any) => ({
            code: String(diagnostic.code || "UNKNOWN"), message: String(diagnostic.message || ""),
        })) }];
    });
    const diagnosticCodes = [...new Set([...sync.flatMap((item: any) => item.diagnostics || []), ...(layout.diagnostics || [])].map((item: any) => String(item.code || "UNKNOWN")))];
    const ownerId = input.id || input.projectId || input.sceneId || input.episodeId || p.episodeId;
    const kind = input.kind || (input.sceneId && !input.episodeId && !input.projectId ? "scene" : input.projectId || context.tool?.startsWith("canvas_") ? "canvas" : "episode");
    const tool = kind === "scene" ? "production_get_scene_production" : "production_get";
    const readInput = kind === "scene" ? { sceneId: ownerId, view: "summary" } : { kind, id: ownerId };
    return { ...pick(result, ["ok", "replayed", "mediaSubmitted", "mediaAuthorized", "operationId", "workId", "runId", "status", "updated", "created", "reused", "skipped"]),
        ...(clipRefreshes.length ? { sourceSaved: true, clipRefreshes, ...(clipRefreshes.length === 1 ? { clipRefresh: clipRefreshes[0] } : {}), mediaSubmitted: false } : {}),
        ...(clipRefreshSummary ? { clipRefreshSummary, ...(input.operationId ? { nextAction: { tool: "production_get_compilation", input: { kind, id: ownerId, operationId: input.operationId } } } : {}) } : {}),
        ...pick(input, ["operationId", "sceneId", "projectId", "episodeId"]),
        production: { ...pick(p, ["episodeId", "revision", "publishedVersion", "updatedAt", "replayed"]), sourceHash: p.draft?.director?.sourceHash, engine: p.draft?.director?.engine },
        ...(utteranceWriteChecks.length ? { writeVerification: { status: utteranceWriteChecks.every((item: any) => item.status === "verified") ? "verified" : "mismatch", fields: utteranceWriteChecks } } : {}),
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
        ...(syncIssues.length ? { syncIssues } : {}),
        warnings: { count: sync.reduce((n: number, item: any) => n + count(item.diagnostics), 0) + count(layout.diagnostics), codes: diagnosticCodes },
        ...(["production_edit", "production_publish", "production_restore", "production_sync_clips"].includes(context.tool || "") ? { readPolicy: { nextReadRequired: false, guidance: "成功回执已给出 revision/sourceHash；复用已知输入。仅缺少任务所需字段或遇到冲突时定向读取，不整稿回读或对已保存源稿重复计算哈希。" } } : {}),
        ...(result.project ? { nextRead: { tool: "production_get_canvas_context", input: { projectId: result.project.id } } } : ownerId ? { nextRead: { tool: context.tool?.includes("scene_work") || context.tool === "production_start_shared_review" ? "production_get_scene_work" : tool,
            input: context.tool?.includes("scene_work") || context.tool === "production_start_shared_review" ? { kind, id: ownerId } : readInput } } : {}) };
}
