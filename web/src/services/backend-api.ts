/** 总后台 API client（Web 端）。 */

import { getBackendTokenShared } from "@/lib/backend-token";
import type { CanvasGenerationCommand, CanvasGenerationStartResult } from "@basketikun/canvas-agent/generation-contract";

export type BackendMediaResult = {
    storageKey: string;
    url: string;
    mimeType: string;
    bytes: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
};

export type BackendTokenResponse = { ok: boolean; token: string };

const DEFAULT_URL = "http://127.0.0.1:17370";

export function getBackendUrl(): string {
    if (typeof window === "undefined") return DEFAULT_URL;
    return localStorage.getItem("backend-url") || DEFAULT_URL;
}

export class BackendApiError extends Error {
    constructor(message: string, readonly status: number, readonly details: Record<string, unknown> = {}) { super(message); this.name = "BackendApiError"; }
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    const token = getBackendTokenShared();
    const url = `${getBackendUrl().replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: options?.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok) {
        // 把后端返回的 error 字符串完整透传（之前 30 字符截断导致 500 错看不到）
        const errText = (data && typeof data === "object" && "error" in data && typeof data.error === "string") ? data.error : "";
        const extra = errText || (res.headers.get("content-type")?.includes("application/json") ? "" : (await res.text().catch(() => "")));
        throw new BackendApiError(`Backend ${method} ${path} failed: HTTP ${res.status} ${extra}`.trim(), res.status, data && typeof data === "object" ? data as Record<string, unknown> : {});
    }
    return data;
}

export type BackendRuntimeTask = {
    id: string;
    kind?: string;
    parentTaskId?: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    executor?: string;
    model?: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    progress: number;
    input?: Record<string, unknown>;
    params?: Record<string, unknown>;
    result?: { media?: BackendMediaResult[]; images?: BackendMediaResult[] } | null;
    outputs?: Array<Record<string, unknown>>;
    error?: string | null;
    createdAt?: string;
    updatedAt?: string;
};

/** 所有画布生成来源共用的任务提交客户端。 */
export function startCanvasGeneration(input: CanvasGenerationCommand, signal?: AbortSignal) {
    return request<{ ok: boolean } & CanvasGenerationStartResult>("POST", "/canvas/generation", input, { signal });
}

export function syncBackendAiConfig(config: unknown) {
    return request<{ ok: boolean }>("PUT", "/settings/ai-config", { config });
}


export async function backendHealth(): Promise<{ ok: boolean; protocolVersion?: number; node?: string; pid?: number }> {
    try {
        const res = await fetch(`${getBackendUrl().replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ok: false };
        return await res.json();
    } catch {
        return { ok: false };
    }
}

/** 自动发现 backend token（读 backend.json）。 */
export async function discoverBackendToken(): Promise<BackendTokenResponse> {
    try {
        const res = await fetch(`${getBackendUrl().replace(/\/$/, "")}/config`);
        if (!res.ok) return { ok: false, token: "" };
        const data = await res.json();
        return { ok: Boolean(data.ok), token: data.token || "" };
    } catch {
        return { ok: false, token: "" };
    }
}

// ── Canvas projects ──────────────────────────────────────────────────────

export function fetchBackendProjects() {
    return request<{ ok: boolean; projects?: Record<string, unknown>[] }>("GET", "/canvas/projects");
}

export function saveBackendProjects(projects: Record<string, unknown>[]) {
    return request<{ ok: boolean; projects?: Record<string, unknown>[] }>("PUT", "/canvas/projects", { projects });
}

export function upsertBackendProject(project: Record<string, unknown>) {
    return request<{ ok: boolean; project?: Record<string, unknown> }>("POST", "/canvas/projects", project);
}

export function applyBackendCanvasOperations(projectId: string, operations: Array<Record<string, unknown>>, expectedRevision?: number) {
    return request<{ ok: boolean; project?: Record<string, unknown>; revision?: number; operationResults?: unknown[] }>(
        "POST", `/canvas/projects/${encodeURIComponent(projectId)}/ops`, { expectedRevision, operations },
    );
}

export function deleteBackendProject(id: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/projects/${encodeURIComponent(id)}`);
}

// ── Assets ───────────────────────────────────────────────────────────────

export function fetchBackendAssets(options: { kind?: string; folderId?: string } = {}) {
    const params = new URLSearchParams();
    if (options.kind) params.set("kind", options.kind);
    if (options.folderId) params.set("folderId", options.folderId);
    const qs = params.toString();
    return request<{ ok: boolean; assets?: unknown[]; folders?: unknown[] }>("GET", `/canvas/assets${qs ? `?${qs}` : ""}`);
}

export function saveBackendAssets(assets: unknown[], folders: unknown[]) {
    return request<{ ok: boolean }>("PUT", "/canvas/assets", { assets, folders });
}

export function upsertBackendAsset(asset: Record<string, unknown>) {
    return request<{ ok: boolean; asset?: Record<string, unknown> }>("POST", "/canvas/assets", asset);
}

export function deleteBackendAsset(id: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/assets/${encodeURIComponent(id)}`);
}

export function upsertBackendAssetFolder(folder: Record<string, unknown>) {
    return request<{ ok: boolean; folder?: Record<string, unknown> }>("POST", "/canvas/assets/folders", folder);
}

export function deleteBackendAssetFolder(id: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/canvas/assets/folders/${encodeURIComponent(id)}`);
}

export type InstalledPluginRecord = {
    id: string; name: string; version: string; description?: string; url: string; source: string;
    enabled: boolean; local?: boolean; official?: boolean; installedAt: string; mcp?: { enabled: boolean; toolCount: number };
};

export function fetchBackendInstalledPlugins() {
    return request<{ ok: boolean; plugins?: InstalledPluginRecord[] }>("GET", "/plugins/installed");
}

export function saveBackendInstalledPlugins(plugins: InstalledPluginRecord[]) {
    return request<{ ok: boolean; plugins?: InstalledPluginRecord[] }>("PUT", "/plugins/installed", { plugins });
}

export function getBackendPluginStorage<T = unknown>(pluginId: string, key: string) {
    return request<{ ok: boolean; value: T | null }>("GET", `/plugins/storage?pluginId=${encodeURIComponent(pluginId)}&key=${encodeURIComponent(key)}`);
}

export function setBackendPluginStorage(pluginId: string, key: string, value: unknown) {
    return request<{ ok: boolean }>("PUT", "/plugins/storage", { pluginId, key, value });
}

export function deleteBackendPluginStorage(pluginId: string, key: string) {
    return request<{ ok: boolean }>("DELETE", `/plugins/storage?pluginId=${encodeURIComponent(pluginId)}&key=${encodeURIComponent(key)}`);
}

export function fetchBackendPromptCache<T = unknown>(sourceId: string) {
    return request<{ ok: boolean; cache: T | null }>("GET", `/prompts/cache?sourceId=${encodeURIComponent(sourceId)}`);
}

export function saveBackendPromptCache(sourceId: string, cache: unknown) {
    return request<{ ok: boolean }>("PUT", "/prompts/cache", { sourceId, cache });
}

// ── Media ────────────────────────────────────────────────────────────────

export async function uploadBackendMedia(options: {
    name: string;
    blob: Blob;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    category?: "input" | "output" | "library";
}): Promise<BackendMediaResult> {
    const { useBackendStore } = await import("@/stores/use-backend-store");
    const token = useBackendStore.getState().token || "";
    const headers: Record<string, string> = {
        "content-type": options.mimeType || options.blob.type || "application/octet-stream",
        "x-media-name": encodeURIComponent(options.name),
    };
    if (options.width !== undefined) headers["x-media-width"] = String(options.width);
    if (options.height !== undefined) headers["x-media-height"] = String(options.height);
    if (options.durationMs !== undefined) headers["x-media-duration-ms"] = String(options.durationMs);
    if (options.category) headers["x-media-category"] = options.category;
    if (options.storageKey) headers["x-media-storage-key"] = options.storageKey;
    const url = `${getBackendUrl().replace(/\/$/, "")}/media/upload-binary?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { method: "POST", headers, body: options.blob });
    const data = (await res.json().catch(() => ({}))) as { media?: BackendMediaResult; error?: string };
    if (!res.ok || !data.media) throw new Error(`Backend POST /media/upload-binary failed: HTTP ${res.status} ${data.error || ""}`);
    return data.media;
}

export async function uploadBackendMediaDataUrl(options: {
    name: string;
    dataUrl: string;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    category?: "input" | "output" | "library";
}): Promise<BackendMediaResult> {
    const data = await request<{ ok: boolean; media: BackendMediaResult }>("POST", "/media/upload", options);
    return data.media;
}

export function backendMediaUrl(storageKey: string): string {
    const token = encodeURIComponent(getBackendTokenShared());
    const key = encodeURIComponent(storageKey);
    const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
    const base = getBackendUrl().replace(/\/$/, "");
    // 开发模式且指向本地总后台时，走 Vite 代理（同源相对路径），避免跨域 CORS。
    const isLocal = base === DEFAULT_URL || base === "http://localhost:17370" || base === "";
    if (isDev && isLocal) return `/media/${key}?token=${token}`;
    return `${base}/media/${key}?token=${token}`;
}

/**
 * 把历史 ComfyUI /view 地址改成总后台代理地址。
 * 画布数据可能来自旧版本，节点里只保存了 127.0.0.1:8188 的临时地址；
 * 直接交给浏览器加载会受运行环境影响，统一通过现有 /comfy/media 读取。
 */
export function resolveComfyMediaUrl(rawUrl: string): string {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return rawUrl;
    try {
        const parsed = new URL(rawUrl, typeof window === "undefined" ? DEFAULT_URL : window.location.origin);
        if (parsed.pathname.endsWith("/comfy/media") || parsed.pathname.endsWith("/media")) return rawUrl;
        const isLocalComfy = parsed.pathname === "/view" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.port === "8188");
        if (!isLocalComfy || !parsed.searchParams.get("filename")) return rawUrl;
        const query = new URLSearchParams();
        for (const key of ["filename", "subfolder", "type"]) {
            const value = parsed.searchParams.get(key);
            if (value !== null) query.set(key, value);
        }
        query.set("token", getBackendTokenShared());
        const base = getBackendUrl().replace(/\/$/, "");
        const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
        const isLocalBackend = base === DEFAULT_URL || base === "http://localhost:17370" || base === "";
        const path = `/agent/comfy/media?${query.toString()}`;
        return isDev && isLocalBackend ? path : `${base}${path}`;
    } catch {
        return rawUrl;
    }
}

export function deleteBackendMedia(storageKey: string) {
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/media/${encodeURIComponent(storageKey)}`);
}

// ── Generation logs ──────────────────────────────────────────────────────

export type BackendGenerationLog = {
    id: string; projectId: string; nodeId?: string; segmentId?: string;
    status: "queued" | "running" | "success" | "failed" | "cancelled";
    platform: string; workflow?: string; model?: string; taskMode?: string; prompt?: string;
    references: Array<Record<string, unknown>>; inputCounts: Record<string, number>;
    runtimeTaskId?: string; promptId?: string;
    startedAt: string; finishedAt?: string; durationMs: number;
    outputs: Array<Record<string, unknown>>; error?: string;
    params: Record<string, unknown>; createdAt: string; updatedAt: string;
};

export function fetchBackendGenerationLogs(options: { projectId?: string; nodeId?: string; segmentId?: string; runtimeTaskId?: string; platform?: string; model?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.nodeId) params.set("nodeId", options.nodeId);
    if (options.segmentId) params.set("segmentId", options.segmentId);
    if (options.runtimeTaskId) params.set("runtimeTaskId", options.runtimeTaskId);
    if (options.platform) params.set("platform", options.platform);
    if (options.model) params.set("model", options.model);
    if (options.status) params.set("status", options.status);
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.limit) params.set("limit", String(options.limit));
    if (typeof options.offset === "number" && options.offset > 0) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<{ ok: boolean; logs?: BackendGenerationLog[] }>("GET", `/generation-logs${qs ? `?${qs}` : ""}`);
}

export function createBackendGenerationLog(input: Record<string, unknown>) {
    return request<{ ok: boolean; log?: BackendGenerationLog }>("POST", "/generation-logs", input);
}

export function updateBackendGenerationLog(id: string, patch: Record<string, unknown>) {
    return request<{ ok: boolean; log?: BackendGenerationLog }>("PATCH", `/generation-logs/${encodeURIComponent(id)}`, patch);
}

export function deleteBackendGenerationLogs(options: { id?: string; projectId?: string; nodeId?: string }) {
    const params = new URLSearchParams(Object.entries(options).filter(([, v]) => v) as [string, string][]);
    const qs = params.toString();
    return request<{ ok: boolean; deleted?: number }>("DELETE", `/generation-logs${qs ? `?${qs}` : ""}`);
}

// ── Data dir ───────────────────────────────────────────────────────────

export async function fetchDataDir(): Promise<{ dataDir: string; configuredDataDir: string | null }> {
    const data = await request<{ ok: boolean; dataDir: string; configuredDataDir: string | null }>("GET", "/data-dir");
    return { dataDir: data.dataDir, configuredDataDir: data.configuredDataDir };
}

export async function saveDataDir(dataDir: string): Promise<{ dataDir: string; configuredDataDir: string | null }> {
    const data = await request<{ ok: boolean; dataDir: string; configuredDataDir: string | null }>("POST", "/data-dir", { dataDir });
    return { dataDir: data.dataDir, configuredDataDir: data.configuredDataDir };
}

// ── Tasks ────────────────────────────────────────────────────────────────

export function fetchBackendTask(id: string, signal?: AbortSignal) {
    return request<{ ok: boolean; task?: BackendRuntimeTask; events?: unknown[] }>("GET", `/tasks/${encodeURIComponent(id)}`, undefined, { signal });
}

export function fetchBackendTasks(options: { projectId?: string; nodeIds?: string[]; segmentIds?: string[]; scope?: "all" | "canvas" | "image" | "video"; status?: string; kind?: string; model?: string; taskId?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.nodeIds?.length) params.set("nodeIds", options.nodeIds.join(","));
    if (options.segmentIds?.length) params.set("segmentIds", options.segmentIds.join(","));
    if (options.scope) params.set("scope", options.scope);
    if (options.status) params.set("status", options.status);
    if (options.kind) params.set("kind", options.kind);
    if (options.model) params.set("model", options.model);
    if (options.taskId) params.set("taskId", options.taskId);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<{ ok: boolean; tasks?: BackendRuntimeTask[] }>("GET", `/tasks${qs ? `?${qs}` : ""}`);
}

export function createBackendTask(kind: string, input: Record<string, unknown> = {}, params: Record<string, unknown> = {}, clientTaskId?: string) {
    return request<{ ok: boolean; task?: Record<string, unknown> }>("POST", "/tasks", { kind, input, params, ...(clientTaskId ? { clientTaskId } : {}) });
}

export function updateBackendTask(id: string, patch: { status?: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress?: number; error?: string | null }) {
    return request<{ ok: boolean; task?: BackendRuntimeTask }>("PATCH", `/tasks/${encodeURIComponent(id)}`, patch);
}

export function cancelBackendTask(id: string) {
    return request<{ ok: boolean; task?: Record<string, unknown> }>("POST", `/tasks/${encodeURIComponent(id)}/cancel`);
}

export function retryBackendTask(id: string) {
    return request<{ ok: boolean; task?: BackendRuntimeTask; parentTaskId?: string }>("POST", `/tasks/${encodeURIComponent(id)}/retry`);
}

export function diagnoseBackendCanvasProject(projectId: string) {
    return request<{ ok: boolean; projectId: string; revision: number; issues: Array<Record<string, unknown>> }>("GET", `/canvas/projects/${encodeURIComponent(projectId)}/diagnostics`);
}
