import os from "node:os";
import path from "node:path";

import type { RuntimeTask, RuntimeTaskEvent } from "./types.js";

/** 总后台 API 客户端（canvas-agent 作为调用方）。 */
export class BackendClient {
    backendUrl: string;
    backendToken: string;

    constructor(backendUrl: string, backendToken: string) {
        this.backendUrl = backendUrl.replace(/\/$/, "");
        this.backendToken = backendToken;
    }

    static async fromEnv(env: Record<string, string | undefined> = process.env): Promise<BackendClient> {
        const port = Number(env.INFINITE_CANVAS_BACKEND_PORT) || 17370;
        return new BackendClient(
            env.INFINITE_CANVAS_BACKEND_URL || `http://127.0.0.1:${port}`,
            env.INFINITE_CANVAS_BACKEND_TOKEN || "",
        );
    }

    private async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        const url = `${this.backendUrl}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.backendToken)}`;
        const res = await fetch(url, {
            method,
            headers: body ? { "content-type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined,
            signal: signal ?? AbortSignal.timeout(15_000),
        });
        const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
        if (!res.ok) throw new Error(`Backend ${method} ${path} failed: HTTP ${res.status} ${data.error || ""}`);
        return data;
    }

    get<T = unknown>(path: string, signal?: AbortSignal) { return this.request<T>("GET", path, undefined, signal); }
    post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal) { return this.request<T>("POST", path, body, signal); }
    put<T = unknown>(path: string, body?: unknown, signal?: AbortSignal) { return this.request<T>("PUT", path, body, signal); }
    patch<T = unknown>(path: string, body?: unknown) { return this.request<T>("PATCH", path, body); }
    delete<T = unknown>(path: string, body?: unknown) { return this.request<T>("DELETE", path, body); }

    // ── Health ───────────────────────────────────────────────────────────

    async health(): Promise<{ ok: boolean; protocolVersion?: number; node?: string; pid?: number }> {
        try {
            const res = await fetch(`${this.backendUrl}/health`, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) return { ok: false };
            return await res.json();
        } catch {
            return { ok: false };
        }
    }

    // ── Canvas projects ──────────────────────────────────────────────────

    async listCanvasProjects(): Promise<Record<string, unknown>[]> {
        const data = await this.get<{ ok: boolean; projects?: Record<string, unknown>[] }>("/canvas/projects");
        return Array.isArray(data.projects) ? data.projects : [];
    }

    async replaceCanvasProjects(projects: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
        const data = await this.put<{ ok: boolean; projects?: Record<string, unknown>[] }>("/canvas/projects", { projects });
        return Array.isArray(data.projects) ? data.projects : [];
    }

    async upsertCanvasProject(project: Record<string, unknown>): Promise<Record<string, unknown>> {
        const data = await this.post<{ ok: boolean; project?: Record<string, unknown> }>("/canvas/projects", project);
        return data.project || project;
    }

    // ── Assets ───────────────────────────────────────────────────────────

    async listAssets(options: { kind?: string; folderId?: string } = {}) {
        const params = new URLSearchParams();
        if (options.kind) params.set("kind", options.kind);
        if (options.folderId) params.set("folderId", options.folderId);
        const qs = params.toString();
        const data = await this.get<{ ok: boolean; assets?: unknown[]; folders?: unknown[] }>(`/canvas/assets${qs ? `?${qs}` : ""}`);
        return { assets: data.assets || [], folders: data.folders || [] };
    }

    async replaceAssets(assets: unknown[], folders: unknown[]) {
        return this.put<{ ok: boolean }>("/canvas/assets", { assets, folders });
    }

    async listPluginDeclarations() {
        const data = await this.get<{ ok: boolean; declarations?: unknown[] }>("/plugins/mcp");
        return data.declarations || [];
    }

    async replacePluginDeclarations(declarations: unknown[]) {
        const data = await this.put<{ ok: boolean; declarations?: unknown[] }>("/plugins/mcp", { declarations });
        return data.declarations || [];
    }

    // ── Media ────────────────────────────────────────────────────────────

    async uploadMedia(options: { name: string; dataUrl?: string; mimeType?: string; width?: number; height?: number; durationMs?: number }): Promise<{ storageKey: string; url: string; mimeType: string; bytes: number; width: number | null; height: number | null; durationMs: number | null }> {
        const data = await this.post<{ ok: boolean; media: { storageKey: string; url: string; mimeType: string; bytes: number; width: number | null; height: number | null; durationMs: number | null } }>("/media/upload", options);
        return data.media;
    }

    // ── Generation logs ──────────────────────────────────────────────────

    async listGenerationLogs(options: { projectId?: string; nodeId?: string; status?: string; limit?: number } = {}) {
        const params = new URLSearchParams();
        if (options.projectId) params.set("projectId", options.projectId);
        if (options.nodeId) params.set("nodeId", options.nodeId);
        if (options.status) params.set("status", options.status);
        if (options.limit) params.set("limit", String(options.limit));
        const qs = params.toString();
        const data = await this.get<{ ok: boolean; logs?: unknown[] }>(`/generation-logs${qs ? `?${qs}` : ""}`);
        return data.logs || [];
    }

    async createGenerationLog(input: Record<string, unknown>) {
        const data = await this.post<{ ok: boolean; log?: unknown }>("/generation-logs", input);
        return data.log;
    }

    async updateGenerationLog(id: string, patch: Record<string, unknown>) {
        const data = await this.patch<{ ok: boolean; log?: unknown }>(`/generation-logs/${encodeURIComponent(id)}`, patch);
        return data.log;
    }

    async deleteGenerationLogs(options: { id?: string; projectId?: string; nodeId?: string }) {
        const data = await this.delete<{ ok: boolean; deleted?: number }>(`/generation-logs`, options);
        return data.deleted || 0;
    }

    // ── Tasks ────────────────────────────────────────────────────────────

    async getTask(id: string) {
        const data = await this.get<{ ok: boolean; task?: unknown; events?: unknown[] }>(`/tasks/${encodeURIComponent(id)}`);
        return { task: data.task, events: data.events || [] };
    }

    async createTask(kind: string, input: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
        const data = await this.post<{ ok: boolean; task?: unknown }>("/tasks", { kind, input, params });
        return data.task;
    }

    async updateTask(id: string, patch: Record<string, unknown>) {
        const data = await this.patch<{ ok: boolean; task?: unknown }>(`/tasks/${encodeURIComponent(id)}`, patch);
        return data.task;
    }

    async cancelTask(id: string) {
        const data = await this.post<{ ok: boolean; task?: unknown }>(`/tasks/${encodeURIComponent(id)}/cancel`);
        return data.task;
    }

    // ── runtime media（H3 ref 落地，总后台 media store 权威） ─────────────

    /**
     * 落地一个 runtime media。
     * 传 `storageKey` 时直接复用总后台 media store 里已有的媒体（零拷贝，不回传 base64）；
     * 否则走 dataUrl 上传。storageKey 可能带 URL 编码（如 `image%3A<uuid>`），
     * 总后台会自行 decodeURIComponent，这里原样透传即可。
     */
    async runtimeMediaStore(name: string, dataUrl: string, storageKey?: string): Promise<{ id: string; path: string; name: string; mimeType: string; bytes: number; url: string }> {
        const payload = storageKey ? { name, storageKey } : { name, dataUrl };
        const data = await this.post<{ ok: boolean; media: { id: string; path: string; name: string; mimeType: string; bytes: number; url: string } }>("/runtime/media", payload);
        return data.media;
    }

    async runtimeMediaRead(name: string): Promise<ArrayBuffer> {
        const res = await fetch(`${this.backendUrl}/runtime/media-file?name=${encodeURIComponent(name)}&token=${encodeURIComponent(this.backendToken)}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Backend runtime media-file failed: HTTP ${res.status}`);
        return res.arrayBuffer();
    }

    async runtimeMediaPath(ref: string): Promise<string> {
        if (path.isAbsolute(ref)) return ref;
        const url = new URL(ref, this.backendUrl);
        if (!url.pathname.startsWith("/media/")) return ref;
        const storageKey = decodeURIComponent(url.pathname.slice("/media/".length));
        // 直接用 storageKey 复用总后台已有媒体：不再整段下载再 base64 回传（H3 串 clip 时极易撑爆请求体 → 413）
        return (await this.runtimeMediaStore(`h3-motion-context-${storageKey}`, "", storageKey)).path;
    }

    // ── ComfyUI Bridge（总后台权威 /comfy/*） ─────────────────────────────

    async comfyStatus(): Promise<Record<string, unknown>> {
        const data = await this.get<{ ok: boolean; connected?: boolean; url?: string; error?: string | null; [k: string]: unknown }>("/comfy/status");
        return data as Record<string, unknown>;
    }

    async comfyModels(signal?: AbortSignal): Promise<{ models: string[]; loras: string[]; refreshedAt: string; error?: string }> {
        const data = await this.get<{ ok: boolean; data?: { models: string[]; loras: string[]; refreshedAt: string; error?: string } }>("/comfy/models", signal);
        if (!data.data) throw new Error("backend comfy models missing data");
        return data.data;
    }

    async comfyRun(preset: string, input: Record<string, unknown>, params: Record<string, unknown>, baseUrl?: string) {
        const data = await this.post<{ ok: boolean; task?: RuntimeTask }>("/comfy/tasks", { preset, input, params, ...(baseUrl ? { comfyUrl: baseUrl } : {}) });
        if (!data.task) throw new Error("backend comfy run missing task");
        return data.task;
    }

    async comfyGetTask(id: string, after = 0): Promise<{ task: RuntimeTask; events: RuntimeTaskEvent[] }> {
        const data = await this.get<{ ok: boolean; task?: RuntimeTask; events?: RuntimeTaskEvent[] }>(`/comfy/tasks/${encodeURIComponent(id)}${after ? `?after=${after}` : ""}`);
        if (!data.task) throw new Error(`backend comfy task not found: ${id}`);
        return { task: data.task, events: data.events || [] };
    }

    async comfyCancel(id: string): Promise<RuntimeTask> {
        const data = await this.post<{ ok: boolean; task?: RuntimeTask }>(`/comfy/tasks/${encodeURIComponent(id)}/cancel`);
        if (!data.task) throw new Error("backend comfy cancel missing task");
        return data.task;
    }

    async comfyConfig(): Promise<{ url: string }> {
        const data = await this.get<{ ok: boolean; url: string }>("/comfy/config");
        return { url: data.url };
    }

    async comfySetConfig(url: string): Promise<{ url: string }> {
        const data = await this.put<{ ok: boolean; url: string }>("/comfy/config", { url });
        return { url: data.url };
    }

}

/** 默认总后台地址常量（供 config 使用）。 */
export const DEFAULT_BACKEND_URL = `http://127.0.0.1:${Number(process.env.INFINITE_CANVAS_BACKEND_PORT) || 17370}`;
export const DEFAULT_BACKEND_PORT = 17370;
