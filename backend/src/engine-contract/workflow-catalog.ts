/**
 * 画布侧的工作流目录客户端：只通过 HTTP 访问执行引擎 `comfyui2api` 的 `/api/workflows*`，
 * 不再 import 引擎的 WorkflowStore / 工作流转换代码。
 *
 * 为什么带缓存：画布的执行器里有同步调用（`getConfig(name)` 用来决定走哪条分支），
 * 而 HTTP 只能异步。所以这里维护一份 `name → config` 的只读快照，同步读缓存、
 * 后台按 TTL 刷新；真正需要最新数据的操作（get/save/upload…）一律直连引擎。
 */

export type EngineTarget = { baseUrl: string; token?: string };

import type { WorkflowConfig, WorkflowField } from "./contracts.js";

export type WorkflowSourceLink = {
    instance: string;
    relativePath: string;
    syncedSha256?: string;
    syncedAt?: string;
    syncState?: "current" | "changed" | "missing";
};

/** 引擎 `GET /api/workflows/{name}` 的返回；config 已经被引擎归一化，不会是 null。 */
export type WorkflowDetail = {
    name: string;
    title?: string;
    workflow: Record<string, unknown>;
    config: WorkflowConfig;
    source?: WorkflowSourceLink | null;
    imageInputCounts?: Record<string, number>;
    imageInputFieldIds?: string[];
    [key: string]: unknown;
};

export type WorkflowPackage = {
    name: string;
    config?: WorkflowConfig;
    workflow: Record<string, unknown>;
    [key: string]: unknown;
};

export type WorkflowListItem = {
    name: string;
    title: string;
    config: WorkflowConfig;
    builtin?: boolean;
    fieldCount?: number;
    addedAt?: string;
    [key: string]: unknown;
};

const CACHE_TTL_MS = 15_000;

/**
 * 从画布的 ai.config 里挑出「可能是执行引擎」的渠道，按可信度排序：
 * 1. kind=engine（显式引擎渠道）
 * 2. kind=local + openai（本地 OpenAI 兼容服务，引擎属于这一类）
 * 3. kind=comfyui + openai（早期直连 ComfyUI 的本地渠道）
 * 同一档里 baseUrl 去重。真正用哪个要等探测结果。
 */
export function engineTargets(aiConfig: unknown): EngineTarget[] {
    const config = typeof aiConfig === "string" ? safeJson(aiConfig) : aiConfig;
    const channels = (config as { channels?: unknown[] } | null | undefined)?.channels;
    if (!Array.isArray(channels)) return [];
    const ranked: Array<{ rank: number; target: EngineTarget }> = [];
    for (const raw of channels) {
        const channel = raw as Record<string, unknown>;
        const baseUrl = String(channel.baseUrl ?? "").trim().replace(/\/+$/, "");
        if (!baseUrl) continue;
        const kind = String(channel.kind ?? "");
        const apiFormat = String(channel.apiFormat ?? "");
        const rank = kind === "engine" ? 0 : kind === "local" && apiFormat === "openai" ? 1 : kind === "comfyui" && apiFormat === "openai" ? 2 : -1;
        if (rank < 0) continue;
        const apiKey = typeof channel.apiKey === "string" ? channel.apiKey.trim() : "";
        ranked.push({ rank, target: { baseUrl, ...(apiKey ? { token: apiKey } : {}) } });
    }
    const seen = new Set<string>();
    return ranked
        .sort((a, b) => a.rank - b.rank)
        .map((item) => item.target)
        .filter((target) => (seen.has(target.baseUrl) ? false : (seen.add(target.baseUrl), true)));
}

/**
 * 按候选顺序探测 `/health`，返回第一个能连上的渠道。
 * ai.config 里可能留着已经停掉的本地渠道（例如指向 3900 的旧 local），不能盲取第一个。
 */
export async function probeEngineTarget(candidates: EngineTarget[], timeoutMs = 1500): Promise<EngineTarget | null> {
    for (const target of candidates) {
        try {
            const response = await fetch(`${target.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
            if (response.ok) return target;
        } catch {
            // 下一个
        }
    }
    return null;
}

/** 兼容旧调用：只取最可信的那个候选，不探测。 */
export function resolveEngineTarget(aiConfig: unknown): EngineTarget | null {
    return engineTargets(aiConfig)[0] ?? null;
}

function safeJson(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export class WorkflowCatalog {
    private readonly cache = new Map<string, WorkflowConfig | null>();
    private refreshedAt = 0;
    private refreshing: Promise<void> | null = null;
    private picked: { target: EngineTarget; at: number } | null = null;

    constructor(private readonly candidates: () => EngineTarget[]) {}

    /** 探测候选渠道，选第一个 /health 有响应的；结果缓存 60 秒。 */
    private async resolve(): Promise<EngineTarget | null> {
        if (this.picked && Date.now() - this.picked.at < 60_000) return this.picked.target;
        const target = await probeEngineTarget(this.candidates());
        this.picked = target ? { target, at: Date.now() } : null;
        return target;
    }

    private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
        const target = await this.resolve();
        if (!target) throw new Error("找不到可用的执行引擎渠道，无法访问工作流");
        const response = await fetch(`${target.baseUrl}${path}`, {
            method: init?.method ?? "GET",
            headers: {
                ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
                ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
        const text = await response.text();
        const payload = text ? safeJson(text) : null;
        if (!response.ok) {
            // 引擎的错误体有两种形态：{error:"..."} 和 {error:{message:"..."}}
            const raw = (payload as { error?: unknown } | null)?.error;
            const message =
                typeof raw === "string"
                    ? raw
                    : raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
                      ? String((raw as { message: string }).message)
                      : `${response.status} ${response.statusText}`;
            throw new Error(message);
        }
        return (payload ?? {}) as T;
    }

    /** 重新拉一次工作流列表，刷新 `getConfig` 用的同步快照。 */
    async refresh(): Promise<void> {
        // 还没配引擎渠道时不算错误：启动阶段目录为空，配好渠道后自动填上。
        if (!(await this.resolve())) return;
        if (this.refreshing) return this.refreshing;
        this.refreshing = (async () => {
            try {
                const list = await this.request<{ data?: WorkflowListItem[] }>("/api/workflows");
                this.cache.clear();
                for (const item of list.data ?? []) {
                    this.cache.set(item.name, item.config ?? null);
                }
                this.refreshedAt = Date.now();
            } finally {
                this.refreshing = null;
            }
        })();
        return this.refreshing;
    }

    private maybeRefresh() {
        if (!this.refreshedAt || Date.now() - this.refreshedAt > CACHE_TTL_MS) void this.refresh().catch(() => {});
    }

    /** 同步读取工作流配置快照；未命中时触发后台刷新并返回 null。 */
    getConfig(name: string): WorkflowConfig | null {
        this.maybeRefresh();
        return this.cache.get(name) ?? null;
    }

    /** 按字段 id 反查字段定义（跨工作流），供失效字段提示使用。 */
    getFieldDefinitionsByIds(ids: string[]): Array<WorkflowField & { sourceWorkflow: string }> {
        this.maybeRefresh();
        const wanted = new Set(ids);
        const found: Array<WorkflowField & { sourceWorkflow: string }> = [];
        for (const [name, config] of this.cache) {
            for (const field of config?.fields ?? []) {
                if (wanted.has(field.id)) found.push({ ...field, sourceWorkflow: name });
            }
        }
        return found;
    }

    async list(): Promise<WorkflowListItem[]> {
        if (!(await this.resolve())) return [];
        const list = await this.request<{ data?: WorkflowListItem[] }>("/api/workflows");
        this.cache.clear();
        for (const item of list.data ?? []) this.cache.set(item.name, item.config ?? null);
        this.refreshedAt = Date.now();
        return list.data ?? [];
    }

    async get(name: string): Promise<WorkflowDetail> {
        return this.request<WorkflowDetail>(`/api/workflows/${encodeURIComponent(name)}`);
    }

    async upload(name: string, workflow: Record<string, unknown>): Promise<{ name: string }> {
        return this.request<{ name: string }>("/api/workflows", { method: "POST", body: { name, workflow } });
    }

    async importPackage(fallbackName: string, value: unknown): Promise<{ name: string }> {
        return this.request<{ name: string }>("/api/workflows/import", { method: "POST", body: { fallbackName, package: value } });
    }

    async exportPackage(name: string): Promise<WorkflowPackage> {
        return this.request<WorkflowPackage>(`/api/workflows/${encodeURIComponent(name)}/export`);
    }

    async delete(name: string): Promise<{ ok: true }> {
        return this.request<{ ok: true }>(`/api/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
    }

    async renameTitle(name: string, title: string): Promise<{ name: string; title: string }> {
        return this.request<{ name: string; title: string }>(`/api/workflows/${encodeURIComponent(name)}/title`, {
            method: "PUT",
            body: { title },
        });
    }

    async saveWorkflow(name: string, workflow: Record<string, unknown>): Promise<{ workflow: Record<string, unknown> }> {
        return this.request<{ workflow: Record<string, unknown> }>(`/api/workflows/${encodeURIComponent(name)}/workflow`, {
            method: "PUT",
            body: { workflow },
        });
    }

    async saveConfig(name: string, config: WorkflowConfig): Promise<{ config: WorkflowConfig }> {
        const saved = await this.request<{ config: WorkflowConfig }>(`/api/workflows/${encodeURIComponent(name)}/config`, {
            method: "PUT",
            body: { config },
        });
        this.cache.set(name, saved.config ?? null);
        return saved;
    }

    /** 在某个工作流上起一次后台运行；执行在引擎里，返回引擎任务 id。 */
    async run(name: string, fields: Record<string, unknown>, clientTaskId?: string): Promise<{ taskId: string }> {
        return this.request<{ taskId: string }>(`/api/workflows/${encodeURIComponent(name)}/run`, {
            method: "POST",
            body: { fields, ...(clientTaskId ? { clientTaskId } : {}) },
        });
    }

    async getComboOptions(name: string): Promise<Record<string, Record<string, string[]>>> {
        const result = await this.request<{ options?: Record<string, Record<string, string[]>> }>(
            `/api/workflows/${encodeURIComponent(name)}/combo-options`,
        );
        return result.options ?? {};
    }

    async getSourceLink(name: string): Promise<WorkflowSourceLink | null> {
        const detail = await this.get(name);
        return detail.source ?? null;
    }

    async saveSourceLink(name: string, source: WorkflowSourceLink): Promise<void> {
        // 引擎把来源信息存在工作流详情的 source 字段；这里只透传，不做本地落库。
        await this.request(`/api/workflows/${encodeURIComponent(name)}/source`, { method: "PUT", body: { source } });
    }

    /** UI 格式 → API 格式（引擎侧转换，画布不再自带转换器）。 */
    async convertGraph(workflow: Record<string, unknown>): Promise<Record<string, unknown>> {
        const result = await this.request<{ workflow?: Record<string, unknown> }>("/api/workflows/convert-graph", {
            method: "POST",
            body: { workflow },
        });
        return result.workflow ?? workflow;
    }
}
