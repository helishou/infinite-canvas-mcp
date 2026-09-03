/** 总后台 API client（Web 端）。 */

import { getBackendTokenShared } from "@/lib/backend-token";

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

export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = getBackendTokenShared();
    const url = `${getBackendUrl().replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok) throw new Error(`Backend ${method} ${path} failed: HTTP ${res.status} ${data.error || ""}`);
    return data;
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

export function fetchBackendGenerationLogs(options: { projectId?: string; nodeId?: string; status?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.nodeId) params.set("nodeId", options.nodeId);
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
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

export function fetchBackendTask(id: string) {
    return request<{ ok: boolean; task?: Record<string, unknown>; events?: unknown[] }>("GET", `/tasks/${encodeURIComponent(id)}`);
}

export function createBackendTask(kind: string, input: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
    return request<{ ok: boolean; task?: Record<string, unknown> }>("POST", "/tasks", { kind, input, params });
}

export function cancelBackendTask(id: string) {
    return request<{ ok: boolean; task?: Record<string, unknown> }>("POST", `/tasks/${encodeURIComponent(id)}/cancel`);
}
