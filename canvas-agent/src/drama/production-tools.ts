import { z } from "zod";
import { productionEditSchema, productionOperationSchema, productionPreflightSchema, type ProductionOperation } from "./production-contract.js";
import { productionReadSchema, productionReadQuery, productionWriteReceipt } from "./production-read.js";
import { migrateToolGuidance } from "../canvas/tool-migrations.js";
import { productionOwnerPath } from "./production-owner.js";
export { productionOwnerPath } from "./production-owner.js";

const owner = { kind: z.enum(["episode", "canvas"]), id: z.string().min(1) };
const identity = z.object(owner).strict();
const stage = z.enum(["script", "shots", "director"]);
const run = identity.extend({ runId: z.string().min(1) });
const version = identity.extend({ version: z.number().int().min(1) });
const readSnapshot = { snapshot: z.enum(["draft", "published"]).default("draft"), ifRevision: z.number().int().nonnegative().optional() };
const sourceRead = z.object({ ...owner, ...readSnapshot, sourceSection: z.enum(["context", "asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry", "subject_registry", "utterances", "ledger.facts", "ledger.timelines", "ledger.initial", "ledger.events", "ledger.requirements", "ledger.coverage"]), targetIds: z.array(z.string().min(1)).optional(), pageSize: z.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict();
const artifactIndexRead = z.object({ ...owner, ...readSnapshot, targetIds: z.array(z.string().min(1)).optional(), pageSize: z.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict();
const artifactRead = z.object({ ...owner, ...readSnapshot, targetId: z.string().min(1), chunkBytes: z.number().int().min(1).max(65536).default(32768), cursor: z.string().optional() }).strict();
const versionSourceRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), sourceSection: sourceRead.shape.sourceSection, targetIds: sourceRead.shape.targetIds, pageSize: sourceRead.shape.pageSize, cursor: sourceRead.shape.cursor }).strict();
const versionArtifactIndexRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), targetIds: artifactIndexRead.shape.targetIds, pageSize: artifactIndexRead.shape.pageSize, cursor: artifactIndexRead.shape.cursor }).strict();
const versionArtifactRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), targetId: artifactRead.shape.targetId, chunkBytes: artifactRead.shape.chunkBytes, cursor: artifactRead.shape.cursor }).strict();
const workbenchRead = z.object({ ...owner, ...readSnapshot, targetId: z.string().min(1), view: z.enum(["subject_workbench", "shot_workbench", "clip_workbench"]), chunkBytes: z.number().int().min(1).max(65536).optional() }).strict();
const versionWorkbenchRead = z.object({ kind: owner.kind, id: owner.id, version: z.number().int().min(1), snapshot: z.enum(["draft", "published"]).default("published"), targetId: z.string().min(1), view: z.enum(["subject_workbench", "shot_workbench", "clip_workbench"]), chunkBytes: z.number().int().min(1).max(65536).optional() }).strict();
const write = { operationId: z.string().min(1), expectedRevision: z.number().int().nonnegative() };
const edit = productionEditSchema.extend(owner).strict();
export const productionToolSchemas = {
    production_preflight: productionPreflightSchema.extend(owner).strict(),
    production_get: z.object({ ...owner, ...readSnapshot }).strict(),
    production_get_source: sourceRead,
    production_get_artifact_index: artifactIndexRead,
    production_get_artifact: artifactRead,
    production_get_workbench: workbenchRead,
    production_get_readiness: identity,
    production_start_run: identity.extend({ runId: z.string().min(1), idempotencyKey: z.string().min(1), workId: z.string().min(1).optional(),
        expectedRevision: z.number().int().nonnegative(), version: z.number().int().nonnegative().optional(), inputBasis: z.enum(["canvas", "published"]).optional(),
        expectedCanvasRevision: z.number().int().nonnegative().optional(), expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        targets: z.array(z.string().min(1)).min(1), scope: z.enum(["selected", "all_ready"]).optional() }),
    production_get_batch: run, production_pause_run: run, production_resume_run: run,
    production_list_versions: identity,
    production_get_version: version.extend(readSnapshot).strict(),
    production_get_version_source: versionSourceRead,
    production_get_version_artifact_index: versionArtifactIndexRead,
    production_get_version_artifact: versionArtifactRead,
    production_get_version_workbench: versionWorkbenchRead,
    production_list_legacy: identity,
    production_preview_impact: identity.extend({ stage }),
    production_edit: edit,
    production_publish: identity.extend({ ...write, stage }),
    production_restore: version.extend(write),
    production_sync_clips: identity,
    production_get_run: version,
    production_export_markdown: identity.extend({ stage, version: z.number().int().min(1).optional() }),
};
export type ProductionToolName = keyof typeof productionToolSchemas;
export const productionToolNames = Object.keys(productionToolSchemas) as ProductionToolName[];
export const isProductionTool = (name: string): name is ProductionToolName => Object.hasOwn(productionToolSchemas, name);
export const productionToolDescriptions: Record<ProductionToolName, string> = {
    production_preflight: "按显式 kind/id 检查制作请求；只读，不提交媒体。",
    production_get: "只读取 kind/id 制作摘要。source、artifact index、单个提示词或工作台内容请分别使用 production_get_source、production_get_artifact_index、production_get_artifact、production_get_workbench；不接受全量视图。",
    production_get_source: "读取指定 sourceSection，默认每页 50 条、最多 100 条；用 cursor 续页。不要请求完整 source 对象。",
    production_get_artifact_index: "分页读取轻量产物目录，不含提示词和引用；默认每页 50 条，最多 100 条。",
    production_get_artifact: "按 targetId 分块读取单个产物提示词；使用返回的 cursor 读完并核对 sha256。",
    production_get_workbench: "只读取一个 targetId 的指定 Subject、Shot 或 Clip 工作台；动态工作包按 workbenchVersion 核验。",
    production_get_readiness: "读取 kind/id 的制作依赖、缺项和下一步。",
    production_start_run: "按 kind/id 启动已有授权的制作运行；inputBasis 默认 canvas，冻结当前有效画布输入，显式 published 核验指定发布稿。保留 runId/idempotencyKey 与版本边界，先执行 preflight，阻塞时不提交媒体。保存、编译、审核和发布不授权生成。",
    production_get_batch: "按 kind/id/runId 读取固定生产范围、状态与任务 ID。",
    production_pause_run: "暂停 kind/id/runId；在途任务完成后停在边界。",
    production_resume_run: "继续原 kind/id/runId，复用原快照和任务，不自动重生成失败任务。",
    production_list_versions: "列出 kind/id 的历史发布版本。",
    production_get_version: "只读取 kind/id/version 历史摘要。历史源稿、产物目录、单个提示词和工作台内容使用对应的 production_get_version_* 工具。",
    production_get_version_source: "分页读取指定历史版本的 sourceSection；默认每页 50 条，最多 100 条。",
    production_get_version_artifact_index: "分页读取指定历史版本的轻量产物目录，不含提示词和引用。",
    production_get_version_artifact: "按 targetId 分块读取指定历史版本的单个产物提示词；使用 cursor 读完并核对 sha256。",
    production_get_version_workbench: "只读取指定历史版本中一个 targetId 的工作台数据。",
    production_list_legacy: "读取 kind/id 的旧剧情与剧本文件及哈希，供明确选择导入。",
    production_preview_impact: "按 kind/id/stage 预览发布影响，不提交媒体。",
    production_edit: "以 operationId/expectedRevision 原子编辑 kind/id draft。Subject Prompt v2 用 upsert_director_subject/delete_director_subject、原实体字段、Shot/关键帧字段、edit_director_continuity 和 repartition_director_clips；人工 Prompt 仅在编译器 SourceMap 可唯一定位时用 reverse_sync_director_prompt 回写，否则保留画布文本并返回诊断。新合同编辑会登记真实受影响 Clip 的后台局部编译同步，不提交媒体或发布。响应丢失恢复原 operationId 回执。",
    production_publish: "按 kind/id 发布指定制作阶段；保留 operationId、expectedRevision，返回短回执。",
    production_restore: "按 kind/id 恢复历史版本为草稿；保留 operationId 和 expectedRevision，不修改历史快照。",
    production_sync_clips: "同步 kind/id 当前发布 Clip 输入，不提交媒体；相同输入、绑定和顺序不推进版本。",
    production_get_run: "读取 kind/id 指定发布版本的制作运行。",
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
        case "production_get_readiness": return get(base + "/readiness");
        case "production_preflight": return post(base + "/preflight", input);
        case "production_start_run": return post(base + "/runs", input);
        case "production_get_batch": return get(`${base}/batches/${encodeURIComponent(input.runId)}`);
        case "production_pause_run": return post(`${base}/batches/${encodeURIComponent(input.runId)}/pause`, {});
        case "production_resume_run": return post(`${base}/batches/${encodeURIComponent(input.runId)}/resume`, {});
        case "production_list_versions": return get(base + "/versions");
        case "production_get_version": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "summary" })}`);
        case "production_get_version_source": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "source" })}`);
        case "production_get_version_artifact_index": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "artifact_index" })}`);
        case "production_get_version_artifact": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, view: "artifacts", targetIds: [input.targetId] })}`);
        case "production_get_version_workbench": return get(`${base}/versions/${input.version}${productionReadQuery({ ...input, targetIds: [input.targetId] })}`);
        case "production_list_legacy": return get(base + "/legacy");
        case "production_preview_impact": return get(`${base}/impact?stage=${input.stage}`);
        case "production_edit": return post(base + "/ops", input);
        case "production_publish": return post(base + "/publish", input);
        case "production_restore": return post(base + "/restore", input);
        case "production_sync_clips": return post(base + "/sync-clips", {});
        case "production_get_run": return get(`${base}/runs/${input.version}`);
        case "production_export_markdown": return get(`${base}/export?stage=${input.stage}${input.version ? `&version=${input.version}` : ""}`);
    }
}
export async function executeProductionTool(api: { get(path: string): Promise<unknown>; post(path: string, body: unknown): Promise<unknown> }, name: ProductionToolName, raw: unknown) {
    const request = productionToolRequest(name, raw);
    const result = request.method === "GET" ? await api.get(request.path) : await api.post(request.path, request.body);
    const projected = ["production_edit", "production_publish", "production_restore", "production_sync_clips"].includes(name)
        ? productionWriteReceipt(result, { tool: name, input: raw as Record<string, any> }) : result;
    return migrateToolGuidance(projected);
}
