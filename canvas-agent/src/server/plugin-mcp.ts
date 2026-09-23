import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";

import { BackendClient } from "../runtime/backend-client.js";
import type { ComfyUiClient } from "../runtime/comfy-client.js";
import { logger } from "../utils/logger.js";
import type { CanvasGenerationCommand, CanvasGenerationStartResult } from "../canvas/generation-contract.js";
import { H3_PLUGIN_VERSION } from "../plugins/minimax-h3/version.js";

// 画布节点在 Agent 侧的轻量形态(避免与 web 类型耦合)
export type AgentCanvasNode = {
    id: string;
    type: string;
    title: string;
    position: { x: number; y: number };
    width: number;
    height: number;
    metadata?: Record<string, unknown>;
};

// ---- 浏览器 -> Agent 的声明线类型 ----
export type PluginMcpToolWire = {
    id: string;
    version: string;
    name: string;
    description: string;
    inputJsonSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
};

export type PluginMcpDeclaration = {
    id: string;
    name: string;
    version: string;
    mcp: { tools: PluginMcpToolWire[]; enabled: boolean };
};

// ---- Backend MCP 注入给插件 handler 的上下文 ----
export type PluginMcpContext = {
    /** 画布/素材/媒体/日志的唯一业务数据源。 */
    backend: PluginMcpBackend;
    /** Read one authoritative canvas snapshot by id. Concurrent H3 reads share only the in-flight fetch. */
    getCanvasProject: (projectId: string) => Promise<Record<string, unknown>>;
    /** ComfyUI 能力（Backend 唯一权威；见 comfy-client.ts）。 */
    comfyUi: ComfyUiClient;
    getCanvasNodes: () => Promise<AgentCanvasNode[]>;
    getCanvasNode: (id: string) => Promise<AgentCanvasNode | null>;
    updateCanvasNode: (id: string, patch: Partial<AgentCanvasNode>, metadataPatch?: Record<string, unknown>) => Promise<void>;
    /** H3 单段原子更新；可选 nodeMetadataPatch 用于把当前面板配置同步到节点级投影。 */
    updateH3Segment: (nodeId: string, segmentId: string, patch: Record<string, unknown>, nodeMetadataPatch?: Record<string, unknown>) => Promise<void>;
    addH3Segment: (nodeId: string, segment: Record<string, unknown>, placement?: { beforeSegmentId?: string; afterSegmentId?: string }) => Promise<void>;
    deleteH3Segment: (nodeId: string, segmentId: string) => Promise<void>;
    /** 完全替换 H3 节点的 segments（plan 重排等场景）。 */
    replaceH3Segments: (nodeId: string, segments: Array<Record<string, unknown>>) => Promise<void>;
};

/** 插件 MCP 实际使用的最小 Backend 能力。 */
export type PluginMcpBackend = {
    backendUrl?: string;
    listCanvasProjects(): Promise<Record<string, unknown>[]>;
    getCanvasProject(projectId: string): Promise<Record<string, unknown>>;
    applyCanvasOperations(projectId: string, operations: Record<string, unknown>[], expectedRevision?: number): Promise<{ project: Record<string, unknown>; revision: number; operationResults: unknown[] }>;
    replacePluginDeclarations(declarations: unknown[]): Promise<unknown[]>;
    canvasRunGeneration(input: CanvasGenerationCommand): Promise<{ ok?: boolean } & CanvasGenerationStartResult>;
    getTask(id: string): Promise<{ task: import("../runtime/types.js").RuntimeTask; events: import("../runtime/types.js").RuntimeTaskEvent[] }>;
    cancelTask(id: string): Promise<import("../runtime/types.js").RuntimeTask>;
    getH3Defaults(): Promise<Record<string, unknown>>;
    setH3Defaults(settings: Record<string, unknown>): Promise<Record<string, unknown>>;
    resetH3Defaults(): Promise<void>;
};

export type McpToolHandler = (input: Record<string, unknown>, context: PluginMcpContext) => Promise<unknown>;

// 插件 MCP 模块(Backend 侧经 allowlist 加载)
export type PluginMcpModule = {
    id: string;
    version: string;
    tools: PluginMcpToolWire[];
    createHandler: (context: PluginMcpContext) => Record<string, McpToolHandler>;
};

// ---- 官方/本地插件白名单:其 MCP 模块由 Agent 直接打包,走本地 import ----
type FirstPartyEntry = { version: string; load: () => Promise<PluginMcpModule> };
export const KNOWN_FIRST_PARTY: Record<string, FirstPartyEntry> = {
    "minimax-h3": {
        version: H3_PLUGIN_VERSION,
        load: async () => (await import("../plugins/minimax-h3/mcp.js")).pluginMcp,
    },
};

export async function loadPluginMcpDeclarationsFromBackend(backend: Pick<BackendClient, "listPluginDeclarations">): Promise<PluginMcpDeclaration[]> {
    const declarations = await backend.listPluginDeclarations();
    return declarations.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as { id?: string; name?: string; version?: string; enabled?: boolean; tools?: PluginMcpToolWire[] };
        return item.id ? [{ id: item.id, name: item.name || item.id, version: item.version || "0.0.0", mcp: { enabled: Boolean(item.enabled), tools: Array.isArray(item.tools) ? item.tools : [] } }] : [];
    });
}

export async function savePluginMcpDeclarationsToBackend(backend: Pick<BackendClient, "replacePluginDeclarations">, declarations: PluginMcpDeclaration[]) {
    await backend.replacePluginDeclarations(declarations.map((declaration) => ({
        id: declaration.id,
        name: declaration.name,
        version: declaration.version,
        enabled: Boolean(declaration.mcp?.enabled),
        tools: declaration.mcp?.tools || [],
        updatedAt: new Date().toISOString(),
    })));
}

// 构造插件 MCP 运行上下文(Agent 侧)
const inFlightCanvasProjectReads = new Map<string, Promise<Record<string, unknown>>>();

async function readCanvasProjectOnce(backend: PluginMcpBackend, projectId: string) {
    const key = `${backend.backendUrl || "default"}\u0000${projectId}`;
    let pending = inFlightCanvasProjectReads.get(key);
    if (!pending) {
        let request!: Promise<Record<string, unknown>>;
        request = backend.getCanvasProject(projectId).finally(() => {
            if (inFlightCanvasProjectReads.get(key) === request) inFlightCanvasProjectReads.delete(key);
        });
        pending = request;
        inFlightCanvasProjectReads.set(key, request);
    }
    const project = await pending;
    return structuredClone(project);
}

export function buildPluginMcpContext(backend: PluginMcpBackend, comfyUi: ComfyUiClient): PluginMcpContext {
    const readNodes = async (): Promise<AgentCanvasNode[]> => {
        const projects = await backend.listCanvasProjects() as Array<{ nodes?: AgentCanvasNode[] }>;
        return projects.flatMap((project) => (Array.isArray(project.nodes) ? project.nodes : []) as AgentCanvasNode[]);
    };
    return {
        backend,
        getCanvasProject: (projectId) => readCanvasProjectOnce(backend, projectId),
        comfyUi,
        getCanvasNodes: readNodes,
        getCanvasNode: async (id) => (await readNodes()).find((node) => node.id === id) ?? null,
        updateCanvasNode: async (id, patch, metadataPatch) => {
            // updateCanvasNode 只用于普通字段 + 节点级 metadata；H3 的 metadata.segments 走细粒度 op。
            if (metadataPatch && Object.prototype.hasOwnProperty.call(metadataPatch, "segments")) {
                throw new Error("updateCanvasNode 不允许传 metadata.segments；H3 节点请用 updateH3Segment / addH3Segment / deleteH3Segment");
            }
            const projects = await backend.listCanvasProjects() as Array<{ id?: string; nodes?: AgentCanvasNode[] }>;
            const target = projects.find((project) => Array.isArray(project.nodes) && project.nodes.some((node) => node.id === id));
            if (!target) throw new Error(`找不到画布节点：${id}`);
            const operation = { type: "update_node", id, patch: { ...patch }, ...(metadataPatch ? { metadata: metadataPatch } : {}) };
            await backend.applyCanvasOperations(String(target.id), [operation], Number((target as Record<string, unknown>).revision || 0));
        },
        updateH3Segment: async (nodeId, segmentId, patch, nodeMetadataPatch) => {
            const projects = await backend.listCanvasProjects() as Array<{ id?: string; revision?: number; nodes?: AgentCanvasNode[] }>;
            const target = projects.find((project) => Array.isArray(project.nodes) && project.nodes.some((node) => node.id === nodeId));
            if (!target) throw new Error(`找不到画布节点：${nodeId}`);
            const operations: Record<string, unknown>[] = [{ type: "update_h3_segment", nodeId, segmentId, patch }];
            if (nodeMetadataPatch && Object.keys(nodeMetadataPatch).length) operations.push({ type: "update_node", id: nodeId, metadata: nodeMetadataPatch });
            await backend.applyCanvasOperations(String(target.id), operations, Number(target.revision || 0));
        },
        addH3Segment: async (nodeId, segment, placement) => {
            const projects = await backend.listCanvasProjects() as Array<{ id?: string; revision?: number; nodes?: AgentCanvasNode[] }>;
            const target = projects.find((project) => Array.isArray(project.nodes) && project.nodes.some((node) => node.id === nodeId));
            if (!target) throw new Error(`找不到画布节点：${nodeId}`);
            const op = { type: "add_h3_segment", nodeId, segment, ...(placement || {}) };
            await backend.applyCanvasOperations(String(target.id), [op], Number(target.revision || 0));
        },
        deleteH3Segment: async (nodeId, segmentId) => {
            const projects = await backend.listCanvasProjects() as Array<{ id?: string; revision?: number; nodes?: AgentCanvasNode[] }>;
            const target = projects.find((project) => Array.isArray(project.nodes) && project.nodes.some((node) => node.id === nodeId));
            if (!target) throw new Error(`找不到画布节点：${nodeId}`);
            const op = { type: "delete_h3_segment", nodeId, segmentId };
            await backend.applyCanvasOperations(String(target.id), [op], Number(target.revision || 0));
        },
        replaceH3Segments: async (nodeId, segments) => {
            const projects = await backend.listCanvasProjects() as Array<{ id?: string; revision?: number; nodes?: AgentCanvasNode[] }>;
            const target = projects.find((project) => Array.isArray(project.nodes) && project.nodes.some((node) => node.id === nodeId));
            if (!target) throw new Error(`找不到画布节点：${nodeId}`);
            const op = { type: "replace_h3_segments", nodeId, segments };
            await backend.applyCanvasOperations(String(target.id), [op], Number(target.revision || 0));
        },
    };
}

// 已注册插件记录
type RegisteredPlugin = {
    id: string;
    version: string;
    enabled: boolean;
    firstParty: boolean;
    tools: PluginMcpToolWire[];
    handlers: Record<string, McpToolHandler>;
};

/**
 * 插件 MCP 动态注册表。
 *
 * 设计要点:
 * - 官方/本地插件(minimax-h3)经 KNOWN_FIRST_PARTY 白名单加载本地打包的 MCP 模块;
 *   其工具在 enable 时注册,disable 时通过 enabled 标志隐藏(MCP SDK 无 removeTool)。
 * - 第三方远程插件仅加载前端节点,MCP 执行需显式授权;当前未授权时只记录、不注册工具,
 *   满足「远程插件 MCP 需用户显式安装 + Agent 授权」的安全边界。
 * - 声明持久化到 SQLite:浏览器(HTTP 进程)启用/禁用写入,stdio MCP 进程冷启动/轮询读取,
 *   从而跨进程、跨重启保持工具可见性。
 */
export class PluginMcpRegistry {
    private plugins = new Map<string, RegisteredPlugin>();

    constructor(private readonly server: McpServer, private readonly context: PluginMcpContext) {}

    /** 浏览器启用/禁用时调用:持久化声明并在当前进程立即应用。 */
    async syncFromBrowser(declarations: PluginMcpDeclaration[]) {
        await savePluginMcpDeclarationsToBackend(this.context.backend, declarations);
        await this.apply(declarations);
    }

    /** 应用一组声明:启用则注册,禁用/缺失则注销。幂等。 */
    async apply(declarations: PluginMcpDeclaration[]) {
        const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]));
        for (const id of [...this.plugins.keys()]) {
            if (!byId.has(id)) this.unregister(id);
        }
        for (const declaration of declarations) {
            if (declaration.mcp?.enabled) await this.enable(declaration);
            else this.unregister(declaration.id);
        }
    }

    private async enable(declaration: PluginMcpDeclaration) {
        const existing = this.plugins.get(declaration.id);
        if (existing?.enabled && existing.version === declaration.version && existing.tools.length === declaration.mcp.tools.length) {
            return; // 已注册且未变,跳过(避免重复注册抛错)
        }
        const firstParty = KNOWN_FIRST_PARTY[declaration.id];
        if (!firstParty) {
            // 第三方远程插件:MCP 执行需显式授权,未授权仅记录、不注册工具
            logger.warn(`插件 ${declaration.id} 的 MCP 执行未获授权(非官方/本地白名单),仅注册前端节点`);
            this.plugins.set(declaration.id, { id: declaration.id, version: declaration.version, enabled: false, firstParty: false, tools: declaration.mcp.tools, handlers: {} });
            return;
        }
        if (firstParty.version !== declaration.version) {
            logger.warn(`插件 ${declaration.id} MCP 模块版本(${firstParty.version}) 与声明(${declaration.version})不一致,以本地模块为准`);
        }
        const mod = await firstParty.load();
        if (mod.id !== declaration.id) throw new Error(`MCP 模块 id 不匹配: ${mod.id} != ${declaration.id}`);
        const handlers = mod.createHandler(this.context);
        const plugin: RegisteredPlugin = { id: declaration.id, version: mod.version, enabled: true, firstParty: true, tools: mod.tools, handlers };
        this.plugins.set(declaration.id, plugin);
        this.registerTools(plugin);
    }

    private registerTools(plugin: RegisteredPlugin) {
        for (const tool of plugin.tools) {
            const handler = plugin.handlers[tool.id];
            if (!handler) continue;
            const entry = (this.server as unknown as { _registeredTools?: Record<string, { enabled: boolean }> })._registeredTools?.[tool.id];
            if (entry) {
                entry.enabled = true; // 已存在(曾注册后隐藏),直接重新启用
                continue;
            }
            const shape = jsonSchemaToZodShape(tool.inputJsonSchema);
            this.server.registerTool(tool.id, {
                title: tool.name,
                description: tool.description,
                inputSchema: shape,
                ...(tool.annotations ? { annotations: tool.annotations as never } : {}),
            }, async (input: Record<string, unknown>) => {
                const result = await handler(input, this.context);
                return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
            });
        }
        this.server.sendToolListChanged();
    }

    private unregister(id: string) {
        const plugin = this.plugins.get(id);
        if (!plugin) return;
        plugin.enabled = false;
        // MCP SDK 无 removeTool:通过 enabled 标志隐藏工具
        const registered = (this.server as unknown as { _registeredTools?: Record<string, { enabled: boolean }> })._registeredTools;
        if (registered) {
            for (const tool of plugin.tools) {
                const entry = registered[tool.id];
                if (entry) entry.enabled = false;
            }
        }
        this.server.sendToolListChanged();
    }

    /** 当前已注册插件与工具清单(供调试/状态查询)。 */
    listTools() {
        return [...this.plugins.values()].map((plugin) => ({
            id: plugin.id,
            version: plugin.version,
            enabled: plugin.enabled,
            firstParty: plugin.firstParty,
            tools: plugin.tools.map((tool) => {
                const registered = (this.server as unknown as { _registeredTools?: Record<string, { enabled: boolean }> })._registeredTools?.[tool.id];
                return { id: tool.id, name: tool.name, registered: Boolean(registered), enabled: Boolean(registered?.enabled) };
            }),
        }));
    }
}

// ---- JSON Schema -> Zod raw shape 转换(支持常见子集) ----
function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodRawShape {
    const props = (schema.properties as Record<string, unknown> | undefined) || {};
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const shape: ZodRawShape = {};
    for (const [key, value] of Object.entries(props)) {
        const zodType = jsonTypeToZod(value);
        shape[key] = required.includes(key) ? zodType : zodType.optional();
    }
    return shape;
}

function jsonTypeToZod(node: unknown): ZodTypeAny {
    if (!node || typeof node !== "object") return z.any();
    const spec = node as Record<string, unknown>;
    if (Array.isArray(spec.enum) && spec.enum.length) return z.enum(spec.enum.map(String) as [string, ...string[]]);
    if (Array.isArray(spec.oneOf)) {
        const options = (spec.oneOf as unknown[]).map(jsonTypeToZod);
        return options.length >= 2 ? z.union(options as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]) : (options[0] ?? z.any());
    }
    switch (spec.type) {
        case "string":
            return z.string();
        case "number":
        case "integer":
            return z.coerce.number();
        case "boolean":
            return z.boolean();
        case "array": {
            const item = spec.items ? jsonTypeToZod(spec.items) : z.any();
            return z.array(item);
        }
        case "object":
            // JSON Schema 默认 additionalProperties=true,故对象需 passthrough,
            // 否则 Zod 默认 strip 会丢弃 patch/params 等开放字段。
            return z.object(jsonSchemaToZodShape(spec)).passthrough();
        default:
            return z.any();
    }
}
