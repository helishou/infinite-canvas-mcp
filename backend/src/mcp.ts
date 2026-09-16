import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import { nanoid } from "nanoid";

import { loadConfig } from "./config.js";
import { PluginMcpRegistry, buildPluginMcpContext, loadPluginMcpDeclarationsFromBackend, type PluginMcpBackend } from "@basketikun/canvas-agent/plugin-mcp";
import type { CanvasProject } from "./db.js";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "@basketikun/canvas-agent/schemas";
import { buildCanvasToolRequest, sanitizeCanvasPrompt } from "@basketikun/canvas-agent/operations";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasImageGenerationInput } from "./canvas/image-dispatcher.js";
import { splitImageBuffer } from "./canvas/image-split.js";
import { backendComfyUi, createBackendClient } from "@basketikun/canvas-agent/runtime/comfy-client";

/** 当前活动画布 ID（MCP 进程内状态，用于多画布路由）。 */
let activeProjectId: string | null = null;

/** Backend 进程外的 MCP stdio 入口：所有业务写入都经由常驻 Backend API。 */
export async function startBackendMcpServer() {
    const config = loadConfig(true);
    // 插件 MCP（尤其 H3）只通过常驻 Backend API 访问画布、任务、媒体和设置，
    // 不再在 MCP 进程内创建自己的 ComfyUI/SQLite 业务副本。
    const backendApi = createBackendClient(config.url);
    const backendComfy = backendComfyUi(backendApi, () => []);
    const directBackend: PluginMcpBackend = {
        listCanvasProjects: () => backendApi.listCanvasProjects(),
        applyCanvasOperations: (projectId, operations, expectedRevision) => backendApi.applyCanvasOperations(projectId, operations, expectedRevision),
        replacePluginDeclarations: (declarations) => backendApi.replacePluginDeclarations(declarations),
        canvasRunGeneration: (input) => backendApi.canvasRunGeneration(input),
        getTask: (id) => backendApi.getTask(id),
        cancelTask: (id) => backendApi.cancelTask(id),
        getH3Defaults: () => backendApi.getH3Defaults(),
        setH3Defaults: (settings) => backendApi.setH3Defaults(settings),
        resetH3Defaults: () => backendApi.resetH3Defaults(),
    };
    const server = new McpServer({ name: "infinite-canvas-backend", version: "0.1.0" });
    registerDirectCanvasTools(server, config, backendApi);
    registerDirectComfyTools(server, backendApi);
    registerBrowserCompatibilityTools(server, config);
    const context = buildPluginMcpContext(
        { url: config.url, token: config.token, backendUrl: config.url },
        directBackend,
        backendComfy,
        (name, input) => executeDirectCanvasTool(config, backendApi, name, input),
    );
    const registry = new PluginMcpRegistry(server, context);
    await registry.apply(await loadPluginMcpDeclarationsFromBackend(backendApi));
    const declarationSync = setInterval(() => {
        void loadPluginMcpDeclarationsFromBackend(backendApi).then((declarations) => registry.apply(declarations)).catch((error) => console.error("plugin MCP sync failed", error));
    }, 3000);
    declarationSync.unref();
    await server.connect(new StdioServerTransport());
}

const DIRECT_CANVAS_TOOLS = [
    "canvas_list_projects", "canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "canvas_apply_ops",
    "canvas_create_node", "canvas_create_text_node", "canvas_create_text_nodes", "canvas_create_config_node",
    "canvas_create_image_prompt_flow", "canvas_create_generation_flow", "canvas_generate_text", "canvas_generate_image", "canvas_generate_video", "canvas_generate_audio",
    "canvas_update_node", "canvas_update_node_text", "canvas_move_nodes", "canvas_resize_node", "canvas_delete_nodes", "canvas_connect_nodes", "canvas_set_generation_references", "canvas_select_nodes", "canvas_run_generation", "generation_get_status",
] as ToolName[];
const DIRECT_TOOL_NAMES = new Set<ToolName>([...DIRECT_CANVAS_TOOLS, "assets_list", "assets_add", "comfyui_status", "comfyui_list_presets", "comfyui_run", "comfyui_get_task", "comfyui_cancel_task", "generation_get_status"]);

async function executeDirectCanvasTool(config: ReturnType<typeof loadConfig>, backendApi: ReturnType<typeof createBackendClient>, name: ToolName, input: Record<string, unknown>) {
    if (name === "canvas_list_projects") {
        // folderId 字符串 → 取该剧目下画布；null（显式传 null）或字符串 "__null__"/"" → 只取未挂剧目的；
        // 不传 → 不过滤（旧行为）。keyword 在过滤后做模糊匹配（不查全表）。
        const folderIdParam = input.folderId;
        let folderFilter: { folderId?: string | null } | undefined;
        if (typeof folderIdParam === "string") {
            if (folderIdParam === "__null__" || folderIdParam === "") folderFilter = { folderId: null };
            else folderFilter = { folderId: folderIdParam };
        } else if (folderIdParam === null) {
            folderFilter = { folderId: null };
        }
        const keyword = String(input.keyword || "").trim().toLowerCase();
        const all = (await fetchCanvasProjects(config, folderFilter))
            .filter((project) => !keyword || String(project.title || project.name || "").toLowerCase().includes(keyword))
            .map((project) => ({ id: project.id, title: project.title, updatedAt: project.updatedAt, folderId: project.folderId ?? null, nodeCount: Array.isArray(project.nodes) ? project.nodes.length : 0, connectionCount: Array.isArray(project.connections) ? project.connections.length : 0 }));
        const pageSize = Math.max(1, Math.min(100, Number(input.pageSize || 20)));
        const page = Math.max(1, Number(input.page || 1));
        return { projects: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize };
    }
    if (name === "generation_get_status") return listTasksFromBackend(backendApi, input);
    const projectId = String(input.projectId || activeProjectId || "");
    const project = await fetchCurrentCanvasProject(config, projectId);
    const state = project as Record<string, unknown>;
    if (name === "canvas_get_state" || name === "canvas_export_snapshot") return compactProject(state);
    if (name === "canvas_get_selection") {
        const ids = new Set(Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : []);
        return { nodes: nodesOf(state).filter((node) => ids.has(String(node.id))) };
    }
    const toolInput = name === "canvas_create_node" ? await applyNodeFactoryDefaults(input, backendApi) : input;
    const request = buildCanvasToolRequest(name, toolInput, { nodes: nodesOf(state) as never, connections: connectionsOf(state) as never });
    const rawOps = Array.isArray(request.input.ops) ? request.input.ops as Array<Record<string, unknown>> : [];
    const ops = await Promise.all(rawOps.map(async (op) => op.type === "add_node" && String(op.nodeType || "") === "minimax-h3:video"
        ? await applyNodeFactoryDefaults(op, backendApi)
        : op));
    const operationResponse = await applyBackendCanvasOperations(config, project.id, Number(project.revision || 0), ops);
    const operationResults = operationResponse.operationResults;
    const saved = operationResponse.project;
    const directTasks: Array<{ taskId: string; nodeId: string; model: string }> = [];
    let withLoadingState = saved;
    for (const op of ops) {
        if (op.type !== "run_generation") continue;
        const currentState = withLoadingState as Record<string, unknown>;
        const source = nodesOf(currentState).find((node) => String(node.id) === String(op.nodeId));
        if (!source) continue;
        const sourceMetadata = recordOf(source.metadata);
        const sourceId = String(source.id);
        const mode = String(op.mode || "image");
        if (mode === "image") {
            const selectedModel = String(sourceMetadata.model || "").trim();
            if (!selectedModel) continue;
            const imageRequest = buildCanvasImageRequest(source, currentState, op, selectedModel);
            const loading = await applyBackendCanvasOperations(config, project.id, Number(withLoadingState.revision || 0), [{
                type: "update_node", id: sourceId, metadata: { status: "loading", runtimeTaskId: imageRequest.clientTaskId, errorDetails: undefined },
            }]);
            withLoadingState = loading.project;
            const task = await backendApi.canvasRunGeneration({ ...imageRequest, mode: "image" });
            directTasks.push({ taskId: task.taskId, nodeId: sourceId, model: selectedModel });
        } else if (mode === "video") {
            const videoRequest = await buildCanvasVideoRequest(source, currentState, project.id, backendApi, op);
            const task = await backendApi.canvasRunGeneration(videoRequest);
            directTasks.push({ taskId: task.taskId, nodeId: sourceId, model: String(videoRequest.model || "") });
        } else {
            throw new Error(`Backend 画布生成执行器暂未注册模式：${mode}`);
        }
    }
    return { ok: true, projectId: withLoadingState.id, operationResults, directTasks, state: compactProject(withLoadingState as Record<string, unknown>) };
}

function registerDirectCanvasTools(server: McpServer, config: ReturnType<typeof loadConfig>, backendApi: ReturnType<typeof createBackendClient>) {
    for (const name of DIRECT_CANVAS_TOOLS) {
        const schema = toolInputSchemas[name];
        // Pass zod schema (not schema.shape) so MCP SDK walks each property and
        // serializes the .describe() text into JSON Schema "description" fields.
        // Using .shape bypasses the conversion and drops every field description,
        // making OpenAI tool-use guess at fields like items/tags/x-vs-dx.
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema }, async (rawInput: Record<string, unknown>) => {
            const input = schema.parse(rawInput) as Record<string, unknown>;
            return textResult(await executeDirectCanvasTool(config, backendApi, name, input));
        });
    }
    // ── H3 节点历史运行产物（按需取，替代 metadata.materials 字段）──
    server.registerTool("h3_get_node_materials", {
        description: toolDescriptions.h3_get_node_materials,
        inputSchema: toolInputSchemas.h3_get_node_materials,
    }, async (rawInput: Record<string, unknown>) => {
        const input = toolInputSchemas.h3_get_node_materials.parse(rawInput) as { projectId?: string; nodeId: string; segmentId?: string; limit?: number };
        const projectId = String(input.projectId || activeProjectId || "");
        if (!projectId) throw new Error("缺少 projectId（先调用 canvas_set_active_project 或显式传入）");
        const project = await fetchCurrentCanvasProject(config, projectId);
        if (!project) throw new Error(`画布不存在: ${projectId}`);
        const materials = await backendApi.getH3NodeMaterials(project.id, String(input.nodeId), Number(input.limit || 200), input.segmentId ? String(input.segmentId) : undefined);
        return textResult({ ok: true, projectId: project.id, nodeId: String(input.nodeId), materials });
    });
    for (const name of ["assets_list", "assets_add"] as ToolName[]) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (rawInput: Record<string, unknown>) => {
            const input = schema.parse(rawInput) as Record<string, unknown>;
            if (name === "assets_list") return textResult((await backendApi.listAssets({ kind: input.kind && input.kind !== "all" ? String(input.kind) : undefined })).assets);
            const now = new Date().toISOString();
            const asset = await backendApi.upsertAsset({ id: `asset-${crypto.randomUUID()}`, kind: String(input.kind || "text"), title: String(input.title || ""), coverUrl: String(input.imageUrl || ""), tags: Array.isArray(input.tags) ? input.tags.map(String) : [], folderId: null, data: { content: input.content || "", imageUrl: input.imageUrl || "" }, note: input.note ? String(input.note) : null, source: input.source ? String(input.source) : null, metadata: {}, createdAt: now, updatedAt: now });
            return textResult(asset);
        });
    }
    // ── 画布管理（创建/删除/切换） ──────────────────────────────────────
    server.registerTool("canvas_split_image", {
        description: "把画布上的一张图片节点按 rows×columns 等分切分，生成多个新的图片节点（与前端「分割」工具同一算法）。适合把宫格分镜图切成单格。切出的节点自动排在被切节点右侧并连线。",
        inputSchema: z.object({
            projectId: z.string().optional(),
            nodeId: z.string(),
            rows: z.number().optional(),
            columns: z.number().optional(),
            horizontalLines: z.array(z.number()).optional(),
            verticalLines: z.array(z.number()).optional(),
            inset: z.number().optional(),
            gap: z.number().optional(),
            keepEmptySlots: z.boolean().optional(),
        }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const nodeId = String(rawInput.nodeId || "");
        const rows = Math.max(1, Math.min(12, Math.floor(Number(rawInput.rows ?? 2))));
        const columns = Math.max(1, Math.min(12, Math.floor(Number(rawInput.columns ?? 2))));
        const gap = Number(rawInput.gap ?? 24);
        const projectId = rawInput.projectId ? String(rawInput.projectId) : "";
        const project = await fetchCurrentCanvasProject(config, projectId);
        const node = nodesOf(project).find((item) => String(item.id) === nodeId);
        if (!node) throw new Error(`画布上找不到节点：${nodeId}`);
        const meta = (node.metadata || {}) as Record<string, unknown>;
        const storageKey = meta.storageKey ? String(meta.storageKey) : "";
        if (!storageKey) throw new Error(`节点 ${nodeId} 没有 storageKey（不是图片结果节点？）`);

        const source = await fetchMediaBuffer(config, storageKey);
        const inset = Math.max(0, Math.min(40, Math.floor(Number(rawInput.inset ?? 0))));
        const { pieces } = await splitImageBuffer(source, {
            rows, columns, inset,
            horizontalLines: Array.isArray(rawInput.horizontalLines) ? rawInput.horizontalLines.map(Number) : undefined,
            verticalLines: Array.isArray(rawInput.verticalLines) ? rawInput.verticalLines.map(Number) : undefined,
        });
        if (!pieces.length) throw new Error("切分结果为空");

        const pos = (node.position || {}) as Record<string, number>;
        const nodeW = Number(node.width || 0) || 340;
        const nodeH = Number(node.height || 0) || 240;
        const cellW = Math.round(nodeW / columns);
        const cellH = Math.round(nodeH / rows);
        const baseX = (pos.x || 0) + nodeW + 96;
        const baseY = pos.y || 0;
        const parentTitle = String(node.title || "图片");

        const created: Array<{ id: string; row: number; column: number; storageKey: string; width: number; height: number }> = [];
        const operations: Array<Record<string, unknown>> = [];
        for (const piece of pieces) {
            const media = await uploadMediaBinary(config, piece.data, {
                name: `split_${String(nodeId).replace(/[^\w.-]/g, "_")}_r${piece.row + 1}c${piece.column + 1}.png`,
                mimeType: "image/png",
                category: "output",
                width: piece.width,
                height: piece.height,
            });
            const id = `image-${crypto.randomUUID()}`;
            operations.push({
                type: "add_node",
                nodeType: "image",
                id,
                title: `${parentTitle} · r${piece.row + 1}c${piece.column + 1}`,
                position: { x: baseX + piece.column * (cellW + gap), y: baseY + piece.row * (cellH + gap) },
                width: cellW,
                height: cellH,
                metadata: {
                    content: media.url,
                    storageKey: media.storageKey,
                    status: "success",
                    naturalWidth: piece.width,
                    naturalHeight: piece.height,
                    bytes: media.bytes,
                    mimeType: "image/png",
                    ...(meta.prompt ? { prompt: meta.prompt } : {}),
                },
            });
            operations.push({ type: "connect_nodes", fromNodeId: nodeId, toNodeId: id });
            created.push({ id, row: piece.row, column: piece.column, storageKey: media.storageKey, width: piece.width, height: piece.height });
        }

        const applied = await applyBackendCanvasOperations(config, project.id, Number(project.revision || 0), operations);
        return textResult({ ok: true, sourceNodeId: nodeId, rows, columns, count: created.length, created, revision: applied.revision });
    });
    server.registerTool("canvas_create_project", {
        description: "创建新画布。返回 id、title、createdAt。可选 title（默认「未命名画布」）、folderId（挂到指定剧目下；不传或 null = 未挂剧目）。先调用 drama_create_project 拿到 folder id 再传进来；不在剧目下时省略。",
        inputSchema: z.object({ title: z.string().optional(), folderId: z.string().nullable().optional() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const title = String(rawInput.title || "未命名画布").trim() || "未命名画布";
        const folderIdRaw = typeof rawInput.folderId === "string" ? rawInput.folderId.trim() : "";
        const folderId = folderIdRaw || null;
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
            id, title, createdAt: now, updatedAt: now,
            revision: 0,
            folderId,
            nodes: [], connections: [], chatSessions: [], activeChatId: null,
            backgroundMode: "lines", showImageInfo: false, globalPrompt: "",
            viewport: { x: 0, y: 0, zoom: 1 },
        };
        const saved = await saveCanvasProject(config, project);
        activeProjectId = id;
        return textResult({ ok: true, id: saved.id, title: saved.title, createdAt: saved.createdAt, folderId: saved.folderId ?? null });
    });
    const dramaCreateProjectSchema = z.object({
        name: z.string().trim().min(1).max(200),
        outline: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        coverStorageKey: z.string().nullable().optional(),
    });
    server.registerTool("drama_create_project", {
        description: "在短剧制作台创建新的剧目。返回剧目 id、名称和资料；创建后会同步到短剧制作台。",
        inputSchema: dramaCreateProjectSchema.shape,
    }, async (rawInput: Record<string, unknown>) => {
        const input = dramaCreateProjectSchema.parse(rawInput);
        const now = new Date().toISOString();
        const folder = {
            id: nanoid(),
            name: input.name,
            createdAt: now,
            updatedAt: now,
            outline: input.outline?.trim() || "",
            description: input.description?.trim() || "",
            coverStorageKey: input.coverStorageKey ?? null,
            tags: (input.tags || []).map((tag) => tag.trim()).filter(Boolean),
        };
        const saved = await backendApi.post<{ ok: boolean; folder?: Record<string, unknown> }>("/canvas/folders", folder);
        return textResult({ ok: true, folder: saved.folder || folder });
    });
    server.registerTool("drama_delete_project", {
        description: "删除短剧制作台中的剧目。只删除剧目归档，剧目下的场景画布会保留并回到待编排场景。",
        inputSchema: z.object({ id: z.string().trim().min(1) }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const input = z.object({ id: z.string().trim().min(1) }).parse(rawInput);
        const result = await backendApi.delete<{ ok: boolean; deleted?: number }>(`/canvas/folders/${encodeURIComponent(input.id)}`);
        return textResult({ ok: true, id: input.id, deleted: Number(result.deleted || 0) > 0 });
    });
    server.registerTool("canvas_delete_project", {
        description: "按 id 删除画布。删除后 activeProjectId 自动清空（若指向被删画布）。",
        inputSchema: z.object({ id: z.string() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const id = String(rawInput.id);
        const deleted = await deleteCanvasProject(config, id);
        if (activeProjectId === id) activeProjectId = null;
        return textResult({ ok: true, deleted: deleted > 0 });
    });
    server.registerTool("canvas_set_active_project", {
        description: "设置当前活动画布（后续 MCP 操作目标）。不传 id 则清空；存在多个画布时不会自动挑选目标。",
        inputSchema: z.object({ id: z.string().optional() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const id = rawInput.id ? String(rawInput.id) : "";
        if (id) {
            const project = (await fetchCanvasProjects(config)).find((item) => item.id === id);
            if (!project) throw new Error(`画布不存在: ${id}`);
            activeProjectId = id;
        } else {
            activeProjectId = null;
        }
        return textResult({ ok: true, activeProjectId: activeProjectId || null });
    });
    server.registerTool("canvas_diagnose_project", {
        description: "只读诊断指定画布，检查悬空连线、重复连线、二次生成残留参考、丢失媒体和孤立结果节点。",
        inputSchema: z.object({ projectId: z.string() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const projectId = String(rawInput.projectId || "").trim();
        if (!projectId) throw new Error("projectId 必填");
        return textResult(await backendApi.diagnoseCanvasProject(projectId));
    });
    server.registerTool("canvas_fix_diagnostics", {
        description: "按 issueId 应用诊断建议。必须明确传 projectId 和 issueIds；实际修改仍由 revision 保护的画布操作事务完成。",
        inputSchema: z.object({ projectId: z.string(), issueIds: z.array(z.string()).min(1), expectedRevision: z.number().optional() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const projectId = String(rawInput.projectId || "").trim();
        const report = await backendApi.diagnoseCanvasProject(projectId);
        const wanted = new Set((rawInput.issueIds as string[]).map(String));
        const selected = report.issues.filter((issue) => issue && typeof issue === "object" && wanted.has(String((issue as Record<string, unknown>).issueId || "")));
        if (selected.length !== wanted.size) throw new Error("存在无效或已消失的 issueId，请重新诊断后再修复");
        const operations = selected.flatMap((issue) => Array.isArray((issue as Record<string, unknown>).suggestedOperations) ? (issue as Record<string, unknown>).suggestedOperations as Array<Record<string, unknown>> : []);
        if (!operations.length) return textResult({ ok: true, fixed: [], message: "选中的问题没有自动修复建议，请人工处理" });
        const result = await backendApi.applyCanvasOperations(projectId, operations, rawInput.expectedRevision === undefined ? report.revision : Number(rawInput.expectedRevision));
        return textResult({ ok: true, fixed: selected.map((issue) => String((issue as Record<string, unknown>).issueId)), ...result });
    });
}

async function buildCanvasVideoRequest(source: Record<string, unknown>, project: Record<string, unknown>, projectId: string, backend: ReturnType<typeof createBackendClient>, op: Record<string, unknown>): Promise<CanvasGenerationCommand> {
    const metadata = recordOf(source.metadata);
    const segments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
    const segmentId = String(op.segmentId || metadata.selectedSegmentId || segments[0]?.id || "");
    const segment = segments.find((item) => String(item.id || "") === segmentId) || segments[0] || {};
    const refs = (Array.isArray(segment.refItems) ? segment.refItems as Array<Record<string, unknown>> : [
        ...(Array.isArray(recordOf(segment.refs).image) ? recordOf(segment.refs).image as Array<Record<string, unknown>> : []),
        ...(Array.isArray(recordOf(segment.refs).video) ? recordOf(segment.refs).video as Array<Record<string, unknown>> : []),
        ...(Array.isArray(recordOf(segment.refs).audio) ? recordOf(segment.refs).audio as Array<Record<string, unknown>> : []),
    ]).filter((ref) => ref.role !== "character_identity");
    const paths = await Promise.all(refs.map(async (ref): Promise<Record<string, unknown> & { path: string }> => {
        const value = String(ref.storageKey || ref.url || "");
        return { ...ref, path: value ? await backend.runtimeMediaPath(value) : "" };
    }));
    const images = paths.filter((ref) => String(ref.type || "image") === "image" && ref.path).map((ref) => ref.path);
    const videos = paths.filter((ref) => String(ref.type || "") === "video" && ref.path).map((ref) => ref.path);
    const audios = paths.filter((ref) => String(ref.type || "") === "audio" && ref.path).map((ref) => ref.path);
    const previousIndex = Math.max(0, segments.findIndex((item) => String(item.id || "") === String(segment.id || "")) - 1);
    const previous = previousIndex >= 0 ? String(segments[previousIndex]?.result || "") : "";
    const previousVideo = previous ? await backend.runtimeMediaPath(previous) : "";
    const params: Record<string, unknown> = { ...recordOf(metadata.comfyParams), ...metadata, ...segment, ...recordOf(op.params), modelName: String(segment.modelName || metadata.modelName || metadata.minimaxBaseModel || ""), canvasBinding: { projectId, nodeId: String(source.id || ""), segmentId } };
    for (const key of ["segments", "refs", "refItems", "result", "results", "content", "url", "storageKey"]) delete params[key];
    return {
        mode: "video",
        model: "minimax-h3:video",
        preset: "minimax-h3",
        projectId,
        nodeId: String(source.id || ""),
        segmentId,
        input: { prompt: String(op.prompt || segment.prompt || metadata.prompt || ""), references: images, video: videos[0], audios, ...(previousVideo ? { previousVideo } : {}) },
        params,
        idempotencyKey: String(op.idempotencyKey || `canvas-${crypto.randomUUID()}`),
    };
}

async function applyNodeFactoryDefaults(input: Record<string, unknown>, backend: ReturnType<typeof createBackendClient>) {
    if (String(input.nodeType || "") !== "minimax-h3:video") return input;
    const defaults = await backend.getH3Defaults();
    const metadata = recordOf(input.metadata);
    return {
        ...input,
        width: input.width ?? 1960,
        height: input.height ?? 1080,
        metadata: createH3NodeMetadata(defaults, metadata),
    };
}

function buildCanvasImageRequest(source: Record<string, unknown>, project: Record<string, unknown>, op: Record<string, unknown>, model: string): CanvasImageGenerationInput {
    const metadata = recordOf(source.metadata);
    const incomingConnections = connectionsOf(project).filter((connection) => String(connection.toNodeId) === String(source.id));
    const connectedTextPrompts = incomingConnections.flatMap((connection) => {
        const node = nodesOf(project).find((item) => String(item.id) === String(connection.fromNodeId));
        if (!node || String(node.type) !== "text") return [];
        const textMetadata = recordOf(node.metadata);
        const content = String(textMetadata.content || "").trim();
        return content ? [content] : [];
    });
    const rawPrompt = sanitizeCanvasPrompt(String(op.prompt || connectedTextPrompts.join("\n\n") || metadata.composerContent || metadata.prompt || ""));
    const referencedIds = new Set<string>();
    for (const match of rawPrompt.matchAll(/@\[node:([^\]]+)\]/g)) referencedIds.add(match[1]);
    for (const connection of incomingConnections) {
        const node = nodesOf(project).find((item) => String(item.id) === String(connection.fromNodeId));
        if (node && String(node.type) === "image") referencedIds.add(String(node.id));
    }
    if (String(source.type) === "image" && (metadata.content || metadata.url || metadata.storageKey)) referencedIds.add(String(source.id));

    const prompt = rawPrompt.replace(/@\[node:([^\]]+)\]/g, (_token, id: string) => {
        const node = nodesOf(project).find((item) => String(item.id) === id);
        return node && String(node.type) === "text" ? String(recordOf(node.metadata).content || "") : "";
    }).trim();
    if (!prompt) throw new Error("画布图片提示词为空");

    const references = [...referencedIds].flatMap((id) => {
        const node = nodesOf(project).find((item) => String(item.id) === id);
        if (!node || String(node.type) !== "image") return [];
        const nodeMetadata = recordOf(node.metadata);
        return [{
            id,
            name: `${String(node.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.png`,
            storageKey: String(nodeMetadata.storageKey || "") || undefined,
            dataUrl: String(nodeMetadata.content || "").startsWith("data:") ? String(nodeMetadata.content) : undefined,
            url: String(nodeMetadata.content || nodeMetadata.url || "") || undefined,
            mimeType: String(nodeMetadata.mimeType || "image/png"),
        }];
    });
    const params = { ...recordOf(metadata.params || metadata.customFieldValues), ...recordOf(op.params) };
    const size = normalizeGptImageSize(metadata.size);
    const [width, height] = size.split("x").map(Number);
    return {
        projectId: String(project.id || "") || undefined,
        nodeId: String(source.id || "") || undefined,
        model,
        prompt,
        references,
        size,
        width,
        height,
        quality: String(metadata.quality || "auto"),
        count: Math.max(1, Math.min(4, Number(metadata.count || 1))),
        params,
        clientTaskId: String(op.idempotencyKey || `canvas-${crypto.randomUUID()}`),
        resultPolicy: String(op.resultPolicy || "replace-active") === "append" ? "append" : "replace-active",
    };
}

function normalizeGptImageSize(value: unknown) {
    const size = String(value || "1024x1024").trim().toLowerCase();
    if (/^\d+x\d+$/.test(size)) return size;
    if (size === "16:9") return "1536x1024";
    if (size === "9:16") return "1024x1536";
    return "1024x1024";
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function listTasksFromBackend(backend: ReturnType<typeof createBackendClient>, input: Record<string, unknown>) {
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const source = (taskId ? [await backend.getTask(taskId).then((value) => value.task).catch(() => null)] : await backend.listTasks({
        scope: ["all", "canvas", "image", "video"].includes(String(input.scope || "all")) ? String(input.scope || "all") as "all" | "canvas" | "image" | "video" : "all",
        projectId: typeof input.projectId === "string" ? input.projectId : undefined,
        nodeIds: Array.isArray(input.nodeIds) ? input.nodeIds.map(String) : undefined,
        segmentIds: Array.isArray(input.segmentIds) ? input.segmentIds.map(String) : undefined,
    })) as Array<{ id?: string; kind: string; input?: Record<string, unknown>; params?: Record<string, unknown>; status: string; progress: number; result?: unknown; error?: string | null; createdAt: string; updatedAt: string; executor?: string; model?: string; projectId?: string; nodeId?: string; segmentId?: string }>;
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.map(String) : []);
    const segmentIds = new Set(Array.isArray(input.segmentIds) ? input.segmentIds.map(String) : []);
    const projectId = String(input.projectId || "");
    const scope = String(input.scope || "all");
    const tasks = source.filter((task): task is NonNullable<typeof task> => Boolean(task)).filter((task) => {
        const taskInput = task.input || {};
        const params = task.params || {};
        const taskProjectId = String(task.projectId || taskInput.projectId || params.projectId || "");
        const taskNodeId = String(task.nodeId || taskInput.nodeId || params.nodeId || "");
        const taskSegmentId = String(task.segmentId || taskInput.segmentId || params.segmentId || "");
        const taskExecutor = String(task.executor || params.executor || "");
        const taskModel = String(task.model || params.model || params.modelName || taskInput.model || "");
        if (projectId && taskProjectId !== projectId) return false;
        if (nodeIds.size && !nodeIds.has(taskNodeId)) return false;
        if (segmentIds.size && !segmentIds.has(taskSegmentId)) return false;
        if (scope === "canvas" && !taskProjectId) return false;
        if (scope === "image" && !/image/i.test(`${task.kind} ${taskExecutor} ${taskModel}`)) return false;
        if (scope === "video" && !/video|h3/i.test(`${task.kind} ${taskExecutor} ${taskModel}`)) return false;
        return true;
    }).slice(0, Math.max(1, Math.min(500, Number(input.limit || 100)))).map(toCanvasTask);
    return { tasks };
}

function toCanvasTask(task: { id?: string; kind: string; input?: Record<string, unknown>; params?: Record<string, unknown>; status: string; progress: number; result?: unknown; error?: string | null; createdAt: string; updatedAt: string; parentTaskId?: string; projectId?: string; nodeId?: string; segmentId?: string; executor?: string; model?: string; outputs?: Array<Record<string, unknown>> }) {
    const input = task.input || {};
    const params = task.params || {};
    const binding = params.canvasBinding && typeof params.canvasBinding === "object" ? params.canvasBinding as Record<string, unknown> : {};
    const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
    return {
        taskId: String(task.id || ""),
        parentTaskId: task.parentTaskId || (typeof params.parentTaskId === "string" ? params.parentTaskId : undefined),
        projectId: task.projectId || String(input.projectId || params.projectId || binding.projectId || "") || undefined,
        nodeId: task.nodeId || String(input.nodeId || params.nodeId || binding.nodeId || "") || undefined,
        segmentId: task.segmentId || String(input.segmentId || params.segmentId || binding.segmentId || "") || undefined,
        executor: task.executor || String(params.executor || (task.kind.startsWith("comfyui:") ? "comfy" : task.kind)),
        model: task.model || String(params.model || params.modelName || input.model || "") || undefined,
        status: task.status,
        progress: Number(task.progress || 0),
        outputs: Array.isArray(task.outputs) ? task.outputs : Array.isArray(result.media) ? result.media : Array.isArray(result.images) ? result.images : [],
        error: task.error || undefined,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

async function fetchCanvasProjects(config: ReturnType<typeof loadConfig>, filter?: { folderId?: string | null }): Promise<CanvasProject[]> {
    const params = new URLSearchParams();
    if (filter && "folderId" in filter) {
        if (filter.folderId === null) params.set("folderId", "__null__");
        else if (filter.folderId) params.set("folderId", filter.folderId);
    }
    const query = params.toString();
    const url = `${config.url.replace(/\/$/, "")}/canvas/projects${query ? `?${query}` : ""}&token=${encodeURIComponent(config.token)}`;
    const response = await fetch(url);
    const body = await response.json().catch(() => ({})) as { projects?: CanvasProject[]; error?: string };
    if (!response.ok || !Array.isArray(body.projects)) throw new Error(body.error || `读取画布失败: HTTP ${response.status}`);
    return body.projects;
}

async function fetchCurrentCanvasProject(config: ReturnType<typeof loadConfig>, projectId: string): Promise<CanvasProject> {
    const projects = await fetchCanvasProjects(config);
    if (projectId) {
        const found = projects.find((project) => project.id === projectId);
        if (found) return found;
        throw new Error(`画布不存在: ${projectId}`);
    }
    if (projects.length !== 1) throw new Error("请显式指定 projectId 或先设置唯一活动画布");
    return projects[0];
}

function nodesOf(project: Record<string, unknown>) { return Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []; }
function connectionsOf(project: Record<string, unknown>) { return Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : []; }
function compactProject(project: Record<string, unknown>) {
    const { viewport: _viewport, ...withoutViewport } = project;
    return { ...withoutViewport, nodes: nodesOf(project), connections: connectionsOf(project) };
}

function textResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }

async function saveCanvasProject(config: ReturnType<typeof loadConfig>, project: CanvasProject): Promise<CanvasProject> {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/canvas/projects?token=${encodeURIComponent(config.token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(project),
    });
    const body = await response.json().catch(() => ({})) as { project?: CanvasProject; error?: string };
    if (!response.ok || !body.project) throw new Error(body.error || `画布写入失败: HTTP ${response.status}`);
    return body.project;
}

async function applyBackendCanvasOperations(config: ReturnType<typeof loadConfig>, projectId: string, expectedRevision: number, operations: Array<Record<string, unknown>>) {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/canvas/projects/${encodeURIComponent(projectId)}/ops?token=${encodeURIComponent(config.token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision, operations }),
    });
    const body = await response.json().catch(() => ({})) as { project?: CanvasProject; operationResults?: unknown[]; revision?: number; error?: string };
    if (!response.ok || !body.project) throw new Error(body.error || `画布操作失败: HTTP ${response.status}`);
    return { project: body.project, operationResults: body.operationResults || [], revision: Number(body.revision || body.project.revision || 0) };
}

async function deleteCanvasProject(config: ReturnType<typeof loadConfig>, id: string): Promise<number> {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/canvas/projects/${encodeURIComponent(id)}?token=${encodeURIComponent(config.token)}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({})) as { deleted?: number; error?: string };
    if (!response.ok) throw new Error(body.error || `画布删除失败: HTTP ${response.status}`);
    return Number(body.deleted || 0);
}

/** 按 storageKey 取回媒体二进制（走 Backend 的 /media 读取接口）。 */
async function fetchMediaBuffer(config: ReturnType<typeof loadConfig>, storageKey: string): Promise<Buffer> {
    const base = config.url.replace(/\/$/, "");
    const url = `${base}/media/${encodeURIComponent(storageKey)}?token=${encodeURIComponent(config.token)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取媒体失败（HTTP ${response.status}）：${storageKey}`);
    return Buffer.from(await response.arrayBuffer());
}

/** 上传二进制媒体到 Backend，返回 storageKey / url / bytes。 */
async function uploadMediaBinary(
    config: ReturnType<typeof loadConfig>,
    data: Buffer,
    options: { name: string; mimeType: string; category?: "input" | "output" | "library"; width?: number | null; height?: number | null },
): Promise<{ storageKey: string; url: string; bytes: number }> {
    const base = config.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
        "content-type": options.mimeType,
        "x-media-name": encodeURIComponent(options.name),
        "x-media-category": options.category || "output",
    };
    if (options.width) headers["x-media-width"] = String(options.width);
    if (options.height) headers["x-media-height"] = String(options.height);
    const response = await fetch(`${base}/media/upload-binary?token=${encodeURIComponent(config.token)}`, {
        method: "POST",
        headers,
        body: new Uint8Array(data),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; media?: { storageKey?: string; url?: string; bytes?: number }; error?: string };
    if (!response.ok || !body.media?.storageKey) throw new Error(body.error || `媒体上传失败: HTTP ${response.status}`);
    return { storageKey: String(body.media.storageKey), url: String(body.media.url || ""), bytes: Number(body.media.bytes || data.length) };
}

function registerDirectComfyTools(server: McpServer, backend: ReturnType<typeof createBackendClient>) {
    server.registerTool("comfyui_status", { description: "检查本地 ComfyUI 连接和系统状态。", inputSchema: z.object({}).shape }, async () => ({ content: [{ type: "text", text: JSON.stringify(await backend.comfyStatus()) }] }));
    server.registerTool("comfyui_list_presets", { description: "列出本地 ComfyUI 内置预设。", inputSchema: z.object({}).shape }, async () => ({ content: [{ type: "text", text: JSON.stringify(await backend.comfyPresets()) }] }));
    server.registerTool("comfyui_run", { description: "运行本地 ComfyUI 预设。", inputSchema: z.object({ preset: z.string(), input: z.record(z.unknown()).optional(), params: z.record(z.unknown()).optional(), clientTaskId: z.string().optional() }).shape }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await backend.comfyRun(input.preset, input.input || {}, input.params || {}, undefined, input.clientTaskId)) }] }));
    server.registerTool("comfyui_get_task", { description: "查询 ComfyUI 任务。", inputSchema: z.object({ taskId: z.string() }).shape }, async ({ taskId }) => { const result = await backend.comfyGetTask(taskId); return { content: [{ type: "text", text: JSON.stringify(result) }] }; });
    server.registerTool("comfyui_cancel_task", { description: "取消 ComfyUI 任务。", inputSchema: z.object({ taskId: z.string() }).shape }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(await backend.comfyCancel(taskId)) }] }));
}

/** 工作台、网页导航和对话工具仍需要当前浏览器会话，保留旧协议兼容入口。 */
function registerBrowserCompatibilityTools(server: McpServer, config: ReturnType<typeof loadConfig>) {
    for (const name of toolNames.filter((item) => !DIRECT_TOOL_NAMES.has(item) && !item.startsWith("h3_"))) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: Record<string, unknown>) => {
            const response = await fetch(`${config.url.replace(/\/$/, "")}/agent/api/tools`, {
                method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
                body: JSON.stringify({ name, input: schema.parse(input) }),
            });
            const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; error?: string };
            if (!response.ok || !body.ok) throw new Error(body.error || `浏览器 Agent 工具调用失败：HTTP ${response.status}`);
            return textResult(body.result);
        });
    }
}
