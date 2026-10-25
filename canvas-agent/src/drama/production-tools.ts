import { z } from "zod";
import { productionEditSchema, productionOperationSchema, productionPreflightSchema, productionSplitSceneSchema, type ProductionOperation } from "./production-contract.js";
import { productionReadQuery, productionSourceSectionSchema, productionWriteReceipt } from "./production-read.js";
import { productionOwnerPath } from "./production-owner.js";
import { createHash } from "node:crypto";
export { productionOwnerPath } from "./production-owner.js";

const owner = { kind: z.enum(["episode", "canvas"]), id: z.string().min(1) };
const identity = z.object(owner).strict();
const stage = z.enum(["script", "shots", "director"]);
const run = identity.extend({ runId: z.string().min(1) });
const batchRead = run.extend({ view: z.enum(["summary", "full"]).default("summary") });
const version = identity.extend({ version: z.number().int().min(1) });
const runRead = version.extend({ view: z.enum(["summary", "full"]).default("summary") });
const readSnapshot = { snapshot: z.enum(["draft", "published"]).default("draft"), ifRevision: z.number().int().nonnegative().optional() };
const sourceRead = z.object({ ...owner, ...readSnapshot, sourceSection: productionSourceSectionSchema, targetIds: z.array(z.string().min(1)).optional(), pageSize: z.number().int().min(1).max(50).default(20), chunkBytes: z.number().int().min(1).max(65536).optional(), cursor: z.string().optional() }).strict();
const artifactIndexRead = z.object({ ...owner, ...readSnapshot, targetIds: z.array(z.string().min(1)).optional(), pageSize: z.number().int().min(1).max(50).default(20), cursor: z.string().optional() }).strict();
const artifactRead = z.object({ ...owner, ...readSnapshot, targetId: z.string().min(1), chunkBytes: z.number().int().min(1).max(65536).default(32768), cursor: z.string().optional() }).strict();
const versionSourceRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), sourceSection: sourceRead.shape.sourceSection, targetIds: sourceRead.shape.targetIds, pageSize: sourceRead.shape.pageSize, chunkBytes: sourceRead.shape.chunkBytes, cursor: sourceRead.shape.cursor }).strict();
const versionArtifactIndexRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), targetIds: artifactIndexRead.shape.targetIds, pageSize: artifactIndexRead.shape.pageSize, cursor: artifactIndexRead.shape.cursor }).strict();
const versionArtifactRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), targetId: artifactRead.shape.targetId, chunkBytes: artifactRead.shape.chunkBytes, cursor: artifactRead.shape.cursor }).strict();
const workbenchRead = z.object({ ...owner, ...readSnapshot, targetId: z.string().min(1), view: z.enum(["subject_workbench", "shot_workbench", "clip_workbench"]), includeContext: z.boolean().default(false), includeRuntime: z.boolean().default(false), chunkBytes: z.number().int().min(1).max(65536).default(32768), cursor: z.string().optional() }).strict();
const write = { operationId: z.string().min(1), expectedRevision: z.number().int().nonnegative() };
const edit = productionEditSchema.extend(owner).strict();
export const productionToolSchemas = {
    production_preflight: productionPreflightSchema.extend(owner).extend({ view: z.enum(["summary", "diagnostics", "targets"]).default("summary"), pageSize: z.number().int().positive().max(50).default(20), cursor: z.string().optional(), chunkBytes: z.number().int().positive().max(65536).optional() }).strict(),
    production_get: z.object({ ...owner, ...readSnapshot }).strict(),
    production_get_source: sourceRead,
    production_get_artifact_index: artifactIndexRead,
    production_get_artifact: artifactRead,
    production_get_workbench: workbenchRead,
    production_get_readiness: identity.extend({ source: z.enum(["draft", "published"]).default("draft"), view: z.enum(["summary", "targets"]).default("summary"), pageSize: z.number().int().positive().max(50).default(20), cursor: z.string().optional() }),
    production_start_run: identity.extend({ runId: z.string().min(1), idempotencyKey: z.string().min(1), workId: z.string().min(1).optional(),
        expectedRevision: z.number().int().nonnegative(), version: z.number().int().nonnegative().optional(), inputBasis: z.enum(["canvas", "published"]).optional(),
        expectedCanvasRevision: z.number().int().nonnegative().optional(), expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        targets: z.array(z.string().min(1)).min(1), scope: z.enum(["selected", "all_ready"]).optional() }),
    production_get_batch: batchRead, production_pause_run: run, production_resume_run: run,
    production_retire_run: run.extend({ reason: z.string().trim().min(8).max(400) }),
    production_list_versions: identity,
    production_get_version: version.extend(readSnapshot).strict(),
    production_get_version_source: versionSourceRead,
    production_get_version_artifact_index: versionArtifactIndexRead,
    production_get_version_artifact: versionArtifactRead,
    production_preview_impact: identity.extend({ stage }),
    production_edit: edit,
    production_split_scene: productionSplitSceneSchema.extend(owner).strict(),
    production_publish: identity.extend({ ...write, stage }),
    production_restore: version.extend(write),
    production_sync_clips: identity,
    production_get_run: runRead,
    production_export_markdown: identity.extend({ stage, version: z.number().int().min(1).optional() }),
};
export type ProductionToolName = keyof typeof productionToolSchemas;
export const productionToolNames = Object.keys(productionToolSchemas) as ProductionToolName[];
export const isProductionTool = (name: string): name is ProductionToolName => Object.hasOwn(productionToolSchemas, name);
export const productionToolDescriptions: Record<ProductionToolName, string> = {
    production_preflight: "按显式 kind/id 检查制作请求；只读，不提交媒体。默认仅返回摘要；view=diagnostics 或 targets 分页读取完整诊断/目标，默认每页 20 条、最多 50 条，使用 cursor 续页。单条超大诊断使用同工具 chunkBytes 分块。request 必须符合 action 对应的请求结构：compile 需 request.expectedRevision（范围编译还要 operationId/scope）；edit/publish 需 operationId 和 expectedRevision；generate 需 runId、idempotencyKey、expectedRevision 和 targets。",
    production_get: "只读取 kind/id 制作摘要。源稿、产物目录、单个提示词或单目标工作台内容分别使用 production_get_source、production_get_artifact_index、production_get_artifact、production_get_workbench；本工具不接受全量视图。",
    production_get_source: "只读取一个指定 sourceSection；script、production_shots、clip_groups、keyframes、keyframe_reviews、settings 是制作正文分区，其余章节来自导演源稿。默认每页 20 条、最多 50 条；用 cursor 续页。读取单个对象可传唯一 targetIds 和 chunkBytes 分块。",
    production_get_artifact_index: "分页读取轻量产物目录，不含提示词和引用；默认每页 20 条，最多 50 条。",
    production_get_artifact: "按 targetId 分块读取正式编译提示词及引用绑定；Picture 编号对应本产物引用列表。Clip 应用时若画布参考顺序不同，Backend 按绑定身份同步重编号。使用 cursor 读完并核对 sha256。",
    production_get_workbench: "只读取一个 targetId 的指定 Subject、Shot 或 Clip 工作台，默认返回 32 KiB 内容块及完整性摘要；用 cursor 续读到 nextCursor=null。核对单镜姿势时用 shot_workbench；Shot/Clip 默认只返回正文核心（Shot/Segment）。需要连续性和解析上下文时传 includeContext=true，需要画布 Prompt、导演基线、参考与运行状态时传 includeRuntime=true。两者都传 true 可读取完整工作台。audio_bindings 是导演源稿正式音频绑定，audioRuntime 是 H3 画布设置的只读映射；映射依来源节点和 storageKey 确认，H3 referenceBindingId 与 authoredBindingId 不可互换。Subject 草稿返回 entityNodeSource 时，用真实 projectId/nodeId 定位实体节点。检查状态优先用 production_get_artifact_index。",
    production_get_readiness: "默认读取制作就绪摘要、目标总数和状态计数；view='targets' 分页读取目标级 blocker/warning，默认每页 20 条、最多 50 条，用 cursor 续读。",
    production_start_run: "按 kind/id 启动已有授权的制作运行；inputBasis 默认 canvas，冻结当前有效画布输入，显式 published 核验指定发布稿。Backend 在提交边界执行一次权威预检并返回 ready/blocked 目标，输入未变化时不要先重复调用 production_preflight。默认返回紧凑批次回执；完整冻结快照用 production_get_batch({ view: \"full\" }) 按需读取。保留 runId/idempotencyKey 与版本边界；保存、编译、审核和发布不授权生成。",
    production_get_batch: "按 kind/id/runId 读取固定生产范围、状态与任务 ID。默认返回紧凑摘要；传 view: \"full\" 读取完整执行快照、逐目标诊断与运行参数。",
    production_pause_run: "先用 production_get_batch 按原 kind/id/runId 核对批次；已结束的批次不能暂停。在途任务会完成后停在边界，不取消已提交任务。",
    production_resume_run: "先用 production_get_batch 核对状态；仅继续可恢复的原 kind/id/runId，复用原快照和任务，不自动重生成失败任务。",
    production_retire_run: "结束已暂停或待审核的 kind/id/runId，释放其未执行目标；必须提供原因。仅当批次没有在途或状态未知的任务时接受，已完成任务和媒体保留。",
    production_list_versions: "列出 kind/id 的历史发布版本。",
    production_get_version: "只读取 kind/id/version 历史摘要。历史源稿、产物目录、单个提示词和工作台内容使用对应的 production_get_version_* 工具。",
    production_get_version_source: "分页读取指定历史版本的 sourceSection；默认每页 50 条，最多 100 条。",
    production_get_version_artifact_index: "分页读取指定历史版本的轻量产物目录，不含提示词和引用。",
    production_get_version_artifact: "按 targetId 分块读取历史正式编译提示词及引用绑定；Picture 编号对应该产物引用列表。Clip 应用时若画布参考顺序不同，Backend 按绑定身份同步重编号。使用 cursor 读完并核对 sha256。",
    production_preview_impact: "按 kind/id/stage 预览发布影响，不提交媒体。",
    production_edit: "以 operationId/expectedRevision 原子编辑 Subject Prompt Assembly v2 + continuity ledger v2 制作稿。expectedRevision 是基线游标，旧于当前 revision 时 patch 仍按事务顺序应用到 Backend 读取的最新稿；不同字段自动保留，同字段后提交的写入生效。revision 增长本身不要求重读全部分区。set_director_production 将 source 作为整体原子字段，只有基于当前稿重建的完整 source 才可用于替换，不能提交旧快照覆盖后来编辑。patch_director_source 的 patch 字段按 entity 校验，可读取 production_get_contract.patchFields 查看 allowlist；Shot 的 camera/performance 对象按嵌套字段合并，数组、null 和标量按提交值替换。写入的新模型指令文本会检查注册的 Shot/Segment/连续性内部 ID，命中时返回 INTERNAL_ID_IN_PROMPT 并拒绝本次编辑；对白和带引号的可见文字沿用编译校验的豁免规则。Shot、局部帧事件、Subject 图片绑定、关键帧、对白与 Clip 分区均写入唯一当前格式；Clip 音频引用使用 audio_bindings。人工 Prompt 仅在编译器 SourceMap 可唯一定位时用 reverse_sync_director_prompt 回写，否则保留画布文本并返回诊断。选择正式历史媒体时可传精确 generationLogId 或 canvas_task_status 返回的 taskId。一次编辑可登记多个明确 Clip 目标的后台局部编译同步，不提交媒体或发布；回执汇总目标状态并提供 production_get_compilation 单次查询入口。阻塞/冲突目标会在 syncIssues 中返回 targetId 与首条诊断。响应丢失恢复原 operationId 回执。",
    production_split_scene: "原子拆分一条正式导演场次：缩减原场次正文/节拍，新增独立 script_scenes 场次，把连续镜头段迁到指定场景环境，并绑定该环境 Subject 的指定图片。要求先按 production_get_source 读取当前 source、revision、镜头、Clip 边界和 Subject 图片绑定；shotIds 必须连续且属于原场次，不能跨 Segment/Clip。不会生成媒体。",
    production_publish: "按 kind/id 发布指定制作阶段；保留 operationId、expectedRevision，返回短回执。",
    production_restore: "按 kind/id 恢复历史版本为草稿；保留 operationId 和 expectedRevision，不修改历史快照。",
    production_sync_clips: "同步 kind/id 当前发布 Clip 输入，不提交媒体；相同输入、绑定和顺序不推进版本。",
    production_get_run: "读取 kind/id 指定发布版本的制作运行。默认返回状态、目标和任务摘要；传 view: \"full\" 读取完整运行参数与执行快照。",
    production_export_markdown: "按 kind/id/stage 导出指定或当前发布版本的制作文档。",
};

export function productionToolRequest(name: ProductionToolName, raw: unknown) {
    const parsed = productionToolSchemas[name].parse(raw);
    const { kind, id, ...input } = parsed as typeof parsed & Record<string, any>;
    const base = productionOwnerPath({ kind, id });
    const get = (path: string) => ({ method: "GET" as const, path });
    const post = (path: string, body: unknown) => ({ method: "POST" as const, path, body });
    switch (name) {
        case "production_get": return get(base + productionReadQuery({ ...input, view: "summary" }));
        case "production_get_source": return get(base + productionReadQuery({ ...input, view: "source" }));
        case "production_get_artifact_index": return get(base + productionReadQuery({ ...input, view: "artifact_index" }));
        case "production_get_artifact": return get(base + productionReadQuery({ ...input, view: "artifacts", targetIds: [input.targetId] }));
        case "production_get_workbench": return get(base + productionReadQuery({ ...input, targetIds: [input.targetId] }));
        case "production_get_readiness": return get(base + `/readiness?${new URLSearchParams({ source: input.source, view: input.view, pageSize: String(input.pageSize), ...(input.cursor ? { cursor: input.cursor } : {}) })}`);
        case "production_preflight": return post(base + "/preflight", { action: input.action, request: input.request });
        case "production_start_run": return post(base + "/runs", input);
        case "production_get_batch": return get(`${base}/batches/${encodeURIComponent(input.runId)}${input.view === "full" ? "?view=inputs" : ""}`);
        case "production_pause_run": return post(`${base}/batches/${encodeURIComponent(input.runId)}/pause`, {});
        case "production_resume_run": return post(`${base}/batches/${encodeURIComponent(input.runId)}/resume`, {});
        case "production_retire_run": return post(`${base}/batches/${encodeURIComponent(input.runId)}/retire`, { reason: input.reason });
        case "production_list_versions": return get(base + "/versions");
        case "production_get_version": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "summary" })}`);
        case "production_get_version_source": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "source" })}`);
        case "production_get_version_artifact_index": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "artifact_index" })}`);
        case "production_get_version_artifact": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "artifacts", targetIds: [input.targetId] })}`);
        case "production_preview_impact": return get(`${base}/impact?stage=${input.stage}`);
        case "production_edit": return post(base + "/ops", input);
        case "production_split_scene": {
            const { operationId, expectedRevision, ...operation } = input;
            return post(base + "/ops", { operationId, expectedRevision, ops: [{ type: "split_director_scene", ...operation }] });
        }
        case "production_publish": return post(base + "/publish", input);
        case "production_restore": return post(base + "/restore", input);
        case "production_sync_clips": return post(base + "/sync-clips", {});
        case "production_get_run": return get(`${base}/runs/${input.version}`);
        case "production_export_markdown": return get(`${base}/export?stage=${input.stage}${input.version ? `&version=${input.version}` : ""}`);
    }
}

function projectPreflight(response: any, input: { kind: string; id: string; action: string; request: unknown; view: "summary" | "diagnostics" | "targets"; pageSize: number; cursor?: string; chunkBytes?: number }) {
    const source = response?.preflight;
    if (!source || typeof source !== "object") return response;
    const requestHash = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
    const revision = source.revision ?? source.canvasRevision ?? null;
    const binding = { kind: input.kind, id: input.id, action: input.action, revision, requestHash, view: input.view, pageSize: input.pageSize };
    const decode = () => {
        if (!input.cursor) return { offset: 0, chunkIndex: null as number | null, byteOffset: 0 };
        try {
            const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
            if (JSON.stringify(parsed.binding) !== JSON.stringify(binding)) throw new Error("READ_CURSOR_EXPIRED: 制作请求或诊断版本已变化，请重新读取");
            return { offset: Number(parsed.offset || 0), chunkIndex: parsed.chunkIndex == null ? null : Number(parsed.chunkIndex), byteOffset: Number(parsed.byteOffset || 0) };
        } catch (error) { if (error instanceof Error && error.message.startsWith("READ_CURSOR_EXPIRED")) throw error; throw new Error("INVALID_CURSOR"); }
    };
    const encode = (value: { offset?: number; chunkIndex?: number; byteOffset?: number }) => Buffer.from(JSON.stringify({ binding, ...value })).toString("base64url");
    if (input.view === "summary") {
        const { diagnostics = [], readyTargets = [], blockedTargets = [], warnings = [], ...meta } = source;
        return { ...response, preflight: { ...meta, view: "summary", counts: { diagnostics: diagnostics.length, readyTargets: readyTargets.length, blockedTargets: blockedTargets.length, warnings: warnings.length }, nextRead: { tool: "production_preflight", input: { kind: input.kind, id: input.id, action: input.action, request: input.request, view: "diagnostics", pageSize: 20 } } } };
    }
    const list = input.view === "targets" ? [...(source.readyTargets || []).map((targetId: string) => ({ targetId, status: "ready" })), ...(source.blockedTargets || []), ...(source.warnings || []).map((item: any) => ({ ...item, status: "warning" }))] : (source.diagnostics || []);
    const position = decode();
    if (position.chunkIndex !== null) {
        if (!input.chunkBytes) throw new Error("分块续读必须继续提供 chunkBytes");
        const value = JSON.stringify(list[position.chunkIndex]);
        const bytes = Buffer.from(value, "utf8");
        if (position.byteOffset > bytes.length) throw new Error("INVALID_CURSOR");
        if (position.byteOffset < bytes.length && (bytes[position.byteOffset] & 0xc0) === 0x80) throw new Error("INVALID_CURSOR");
        let end = Math.min(bytes.length, position.byteOffset + input.chunkBytes);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        if (end === position.byteOffset && end < bytes.length) throw new Error("CHUNK_TOO_SMALL");
        const nextCursor = end < bytes.length ? encode({ chunkIndex: position.chunkIndex, byteOffset: end }) : position.offset + 1 < list.length ? encode({ offset: position.offset + 1 }) : null;
        return { ...response, preflight: { ...metaPreflight(source), view: input.view, diagnosticChunk: { index: position.chunkIndex, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, offset: position.byteOffset, text: bytes.subarray(position.byteOffset, end).toString("utf8"), nextCursor } } };
    }
    const items: unknown[] = [];
    let nextOffset = position.offset;
    while (nextOffset < list.length && items.length < input.pageSize) {
        const item = list[nextOffset];
        const itemChars = JSON.stringify(item).length;
        if (itemChars > 90000) break;
        const candidate = [...items, item];
        if (JSON.stringify(candidate).length > 90000 && items.length) break;
        items.push(item);
        nextOffset++;
    }
    const oversized = nextOffset < list.length && JSON.stringify(list[nextOffset]).length > 90000;
    const nextCursor = oversized
        ? encode({ chunkIndex: nextOffset, byteOffset: 0 })
        : nextOffset < list.length ? encode({ offset: nextOffset }) : null;
    return { ...response, preflight: { ...metaPreflight(source), view: input.view, items, total: list.length, nextCursor,
        ...(oversized ? { chunkBytes: 32768, chunkRead: "继续调用 production_preflight，传 view、cursor 和 chunkBytes:32768" } : {}) } };
}

function metaPreflight(source: Record<string, any>) {
    const { diagnostics, readyTargets, blockedTargets, warnings, ...meta } = source;
    return meta;
}

function productionBatchSummary(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const envelope = value as Record<string, any>;
    const batch = envelope.run;
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) return value;
    const snapshot = batch.executionSnapshot && typeof batch.executionSnapshot === "object" ? batch.executionSnapshot : undefined;
    const plan = batch.plan && typeof batch.plan === "object" ? batch.plan : undefined;
    return {
        ...envelope,
        run: {
            runId: batch.runId,
            episodeId: batch.episodeId,
            version: batch.version,
            sourceRevision: batch.sourceRevision,
            idempotencyKey: batch.idempotencyKey,
            status: batch.status,
            targets: batch.targets,
            submitted: Array.isArray(batch.submitted) ? batch.submitted.map((item: Record<string, any>) => ({
                kind: item.kind, id: item.id, taskId: item.taskId, status: item.status,
            })) : batch.submitted,
            error: batch.error,
            pauseRequested: batch.pauseRequested,
            createdAt: batch.createdAt,
            updatedAt: batch.updatedAt,
            plan: plan ? {
                changedSceneCount: plan.changedSceneIds?.length,
                affectedShotCount: plan.affectedShotIds?.length,
                imageShotCount: plan.imageShotIds?.length,
                clipGroupCount: plan.clipGroupIds?.length,
                missingAssetNodeCount: plan.missingAssetNodeIds?.length,
                assetCount: plan.assetIds?.length,
            } : undefined,
            executionSnapshot: snapshot ? {
                schemaVersion: snapshot.schemaVersion,
                inputBasis: snapshot.inputBasis,
                canvasId: snapshot.canvasId,
                canvasRevision: snapshot.canvasRevision,
                planHash: snapshot.planHash,
                targetCount: Array.isArray(snapshot.targets) ? snapshot.targets.length : undefined,
                blockedTargetCount: Array.isArray(snapshot.blockedTargets) ? snapshot.blockedTargets.length : undefined,
                warningCount: Array.isArray(snapshot.warnings) ? snapshot.warnings.length : undefined,
            } : batch.executionSnapshot,
        },
    };
}

export async function executeProductionTool(api: { get(path: string): Promise<unknown>; post(path: string, body: unknown): Promise<unknown> }, name: ProductionToolName, raw: unknown) {
    const request = productionToolRequest(name, raw);
    const result = request.method === "GET" ? await api.get(request.path) : await api.post(request.path, request.body);
    if (name === "production_preflight") {
        const input = productionToolSchemas.production_preflight.parse(raw);
        return projectPreflight(result, { ...input, action: input.action, request: input.request });
    }
    const projected = ["production_edit", "production_split_scene", "production_publish", "production_restore", "production_sync_clips"].includes(name)
        ? productionWriteReceipt(result, { tool: name, input: raw as Record<string, any> }) : result;
    if (name === "production_start_run" || (["production_get_batch", "production_get_run"].includes(name) && (raw as Record<string, any>)?.view !== "full")) return productionBatchSummary(projected);
    return projected;
}
