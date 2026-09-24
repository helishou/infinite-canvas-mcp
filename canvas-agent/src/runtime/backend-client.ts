import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type { RuntimeTask, RuntimeTaskEvent } from "./types.js";
import type {
  CanvasGenerationCommand,
  CanvasGenerationStartResult,
} from "../canvas/generation-contract.js";
import {
  CANVAS_GENERATION_PATH,
  CANVAS_TASKS_PATH,
  canvasTaskActionPath,
  canvasTaskPath,
  h3ConfirmationPath,
} from "../canvas/generation-api.js";

export type BackendClientErrorKind =
  | "http"
  | "network"
  | "timeout"
  | "invalid_response";

export class BackendClientError extends Error {
  readonly kind: BackendClientErrorKind;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    details: {
      kind: BackendClientErrorKind;
      method: string;
      path: string;
      status?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "BackendClientError";
    this.kind = details.kind;
    this.method = details.method;
    this.path = details.path;
    this.status = details.status;
    this.code = details.code;
  }
}

function errorPayload(value: unknown) {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const nested = body.error && typeof body.error === "object" && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : {};
  const message = typeof nested.message === "string"
    ? nested.message
    : typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : undefined;
  const code = typeof nested.code === "string"
    ? nested.code
    : typeof body.code === "string"
      ? body.code
      : undefined;
  return { message, code };
}

function isTimeoutError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError" || error.name === "TimeoutError"
    : error instanceof Error && /timeout|timed out|aborted/i.test(error.message);
}

/** 总后台 API 客户端（canvas-agent 作为调用方）。 */
export class BackendClient {
  backendUrl: string;
  backendToken: string;

  constructor(backendUrl: string, backendToken: string) {
    this.backendUrl = backendUrl.replace(/\/$/, "");
    this.backendToken = backendToken;
  }

  static async fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): Promise<BackendClient> {
    const port = Number(env.INFINITE_CANVAS_BACKEND_PORT) || 17370;
    return new BackendClient(
      env.INFINITE_CANVAS_BACKEND_URL || `http://127.0.0.1:${port}`,
      env.INFINITE_CANVAS_BACKEND_TOKEN || "",
    );
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.backendUrl}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.backendToken)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const kind = isTimeoutError(error) ? "timeout" : "network";
      throw new BackendClientError(
        kind === "timeout"
          ? `Backend ${method} ${path} timed out`
          : `Backend ${method} ${path} network request failed`,
        { kind, method, path, cause: error },
      );
    }
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      const details = errorPayload(data);
      throw new BackendClientError(
        `Backend ${method} ${path} failed: HTTP ${res.status}${details.code ? ` ${details.code}` : ""}${details.message ? ` ${details.message}` : ""}`,
        {
          kind: "http",
          method,
          path,
          status: res.status,
          code: details.code,
        },
      );
    }
    return data;
  }

  get<T = unknown>(path: string, signal?: AbortSignal) {
    return this.request<T>("GET", path, undefined, signal);
  }
  post<T = unknown>(path: string, body?: unknown, signal?: AbortSignal) {
    return this.request<T>("POST", path, body, signal);
  }
  put<T = unknown>(path: string, body?: unknown, signal?: AbortSignal) {
    return this.request<T>("PUT", path, body, signal);
  }
  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body);
  }

  // ── Health ───────────────────────────────────────────────────────────

  async health(): Promise<{
    ok: boolean;
    protocolVersion?: number;
    node?: string;
    pid?: number;
  }> {
    try {
      const res = await fetch(`${this.backendUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false };
      return await res.json();
    } catch {
      return { ok: false };
    }
  }

  async getAiConfig(): Promise<Record<string, unknown>> {
    const data = await this.get<{
      ok: boolean;
      config?: Record<string, unknown> | null;
    }>("/settings/ai-config");
    return data.config && typeof data.config === "object" ? data.config : {};
  }

  // ── Canvas projects ──────────────────────────────────────────────────

  async listCanvasProjects(
    options: { episodeId?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    if (options.episodeId) params.set("episodeId", options.episodeId);
    const qs = params.toString();
    const data = await this.get<{
      ok: boolean;
      projects?: Record<string, unknown>[];
    }>(`/canvas/projects${qs ? `?${qs}` : ""}`);
    return Array.isArray(data.projects) ? data.projects : [];
  }

  async getCanvasProject(projectId: string): Promise<Record<string, unknown>> {
    const path = `/canvas/projects/${encodeURIComponent(projectId)}`;
    const data = await this.get<{ ok: boolean; project?: Record<string, unknown> }>(path);
    if (!data.project)
      throw new BackendClientError(`Backend ${path} returned no project`, {
        kind: "invalid_response",
        method: "GET",
        path,
        code: "BACKEND_INVALID_RESPONSE",
      });
    return data.project;
  }

  async listDramaEpisodes(dramaId: string) {
    const data = await this.get<{
      ok: boolean;
      dramaId: string;
      episodes?: Record<string, unknown>[];
    }>(`/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
    return Array.isArray(data.episodes) ? data.episodes : [];
  }

  async getDramaEpisode(episodeId: string) {
    return this.get<{
      ok: boolean;
      episode?: Record<string, unknown>;
      canvas?: Record<string, unknown> | null;
    }>(`/drama/episodes/${encodeURIComponent(episodeId)}`);
  }

  async createDramaEpisode(dramaId: string, input: Record<string, unknown>) {
    return this.post<{ ok: boolean; episode?: Record<string, unknown> }>(
      `/drama/projects/${encodeURIComponent(dramaId)}/episodes`,
      input,
    );
  }

  async updateDramaEpisode(episodeId: string, patch: Record<string, unknown>) {
    return this.patch<{
      ok: boolean;
      episode?: Record<string, unknown>;
      canvas?: Record<string, unknown> | null;
    }>(`/drama/episodes/${encodeURIComponent(episodeId)}`, patch);
  }

  async deleteDramaEpisode(episodeId: string) {
    return this.delete<{ ok: boolean; deleted?: number }>(
      `/drama/episodes/${encodeURIComponent(episodeId)}`,
    );
  }

  async applyCanvasOperations(
    projectId: string,
    operations: Record<string, unknown>[],
    expectedRevision?: number,
    operationId = crypto.randomUUID(),
  ) {
    const data = await this.post<{
      ok: boolean;
      project?: Record<string, unknown>;
      revision?: number;
      operationResults?: unknown[];
    }>(`/canvas/projects/${encodeURIComponent(projectId)}/ops`, {
      expectedRevision,
      operations,
      operationId,
      source: {
        clientId: `agent:${process.pid}`,
        kind: "agent",
        label: "Canvas Agent",
      },
    });
    if (!data.project)
      throw new Error(`Backend canvas ops returned no project: ${projectId}`);
    return {
      project: data.project,
      revision: Number(data.revision ?? data.project.revision ?? 0),
      operationResults: data.operationResults || [],
    };
  }

  async diagnoseCanvasProject(projectId: string) {
    return this.get<{
      ok: boolean;
      projectId: string;
      revision: number;
      issues: unknown[];
    }>(`/canvas/projects/${encodeURIComponent(projectId)}/diagnostics`);
  }

  async canvasRunGeneration(input: CanvasGenerationCommand) {
    const data = await this.post<{ ok: boolean } & CanvasGenerationStartResult>(
      CANVAS_GENERATION_PATH,
      input,
    );
    if (!data.task && !data.taskId)
      throw new BackendClientError(
        "Backend canvas generation returned no task",
        {
          kind: "invalid_response",
          method: "POST",
          path: CANVAS_GENERATION_PATH,
          code: "BACKEND_INVALID_RESPONSE",
        },
      );
    return data;
  }

  // ── Assets ───────────────────────────────────────────────────────────

  async listAssets(options: { kind?: string; folderId?: string } = {}) {
    const params = new URLSearchParams();
    if (options.kind) params.set("kind", options.kind);
    if (options.folderId) params.set("folderId", options.folderId);
    const qs = params.toString();
    const data = await this.get<{
      ok: boolean;
      assets?: unknown[];
      folders?: unknown[];
    }>(`/canvas/assets${qs ? `?${qs}` : ""}`);
    return { assets: data.assets || [], folders: data.folders || [] };
  }

  async upsertAsset(asset: Record<string, unknown>) {
    const data = await this.post<{ asset?: Record<string, unknown> }>(
      "/canvas/assets",
      asset,
    );
    return data.asset || asset;
  }

  async replaceAssets(assets: unknown[], folders: unknown[]) {
    return this.put<{ ok: boolean }>("/canvas/assets", { assets, folders });
  }

  async listPluginDeclarations() {
    const data = await this.get<{ ok: boolean; declarations?: unknown[] }>(
      "/plugins/mcp",
    );
    return data.declarations || [];
  }

  async replacePluginDeclarations(declarations: unknown[]) {
    const data = await this.put<{ ok: boolean; declarations?: unknown[] }>(
      "/plugins/mcp",
      { declarations },
    );
    return data.declarations || [];
  }

  // ── Media ────────────────────────────────────────────────────────────

  async uploadMedia(options: {
    name: string;
    dataUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
  }): Promise<{
    storageKey: string;
    url: string;
    mimeType: string;
    bytes: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  }> {
    const data = await this.post<{
      ok: boolean;
      media: {
        storageKey: string;
        url: string;
        mimeType: string;
        bytes: number;
        width: number | null;
        height: number | null;
        durationMs: number | null;
      };
    }>("/media/upload", options);
    return data.media;
  }

  // ── Generation logs ──────────────────────────────────────────────────

  async listGenerationLogs(
    options: {
      projectId?: string;
      nodeId?: string;
      segmentId?: string;
      runtimeTaskId?: string;
      platform?: string;
      model?: string;
      status?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.nodeId) params.set("nodeId", options.nodeId);
    if (options.segmentId) params.set("segmentId", options.segmentId);
    if (options.runtimeTaskId)
      params.set("runtimeTaskId", options.runtimeTaskId);
    if (options.platform) params.set("platform", options.platform);
    if (options.model) params.set("model", options.model);
    if (options.status) params.set("status", options.status);
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    const data = await this.get<{ ok: boolean; logs?: unknown[] }>(
      `/generation-logs${qs ? `?${qs}` : ""}`,
    );
    return data.logs || [];
  }

  async createGenerationLog(input: Record<string, unknown>) {
    const data = await this.post<{ ok: boolean; log?: unknown }>(
      "/generation-logs",
      input,
    );
    return data.log;
  }

  async updateGenerationLog(id: string, patch: Record<string, unknown>) {
    const data = await this.patch<{ ok: boolean; log?: unknown }>(
      `/generation-logs/${encodeURIComponent(id)}`,
      patch,
    );
    return data.log;
  }

  async deleteGenerationLogs(options: {
    id?: string;
    projectId?: string;
    nodeId?: string;
  }) {
    const data = await this.delete<{ ok: boolean; deleted?: number }>(
      `/generation-logs`,
      options,
    );
    return data.deleted || 0;
  }

  // ── H3 节点历史运行产物（按需取，替代老的 metadata.materials 字段）──
  async getH3NodeMaterials(
    projectId: string,
    nodeId: string,
    limit?: number,
    segmentId?: string,
  ): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (segmentId) qs.set("segmentId", segmentId);
    const tail = qs.toString();
    const data = await this.get<{ ok: boolean; materials?: unknown[] }>(
      `/canvas/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/materials${tail ? `?${tail}` : ""}`,
    );
    return data.materials || [];
  }

  // ── Tasks ────────────────────────────────────────────────────────────

  async getTask(
    id: string,
  ): Promise<{ task: RuntimeTask; events: RuntimeTaskEvent[] }> {
    const data = await this.get<{
      ok: boolean;
      task?: RuntimeTask;
      events?: RuntimeTaskEvent[];
    }>(canvasTaskPath(id));
    if (!data.task)
      throw new BackendClientError(
        `Backend ${canvasTaskPath(id)} returned no task`,
        {
          kind: "invalid_response",
          method: "GET",
          path: canvasTaskPath(id),
          code: "BACKEND_INVALID_RESPONSE",
        },
      );
    return { task: data.task, events: data.events || [] };
  }

  async *streamEvents(signal?: AbortSignal, cursor?: string): AsyncGenerator<Record<string, unknown>> {
    const path = `/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    let response: Response;
    try {
      response = await fetch(`${this.backendUrl}${path}`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${this.backendToken}` },
        signal,
      });
    } catch (error) {
      throw new BackendClientError(`Backend GET /events failed`, {
        kind: isTimeoutError(error) ? "timeout" : "network",
        method: "GET",
        path: "/events",
        cause: error,
      });
    }
    if (!response.ok || !response.body)
      throw new BackendClientError(`Backend GET /events failed: HTTP ${response.status}`, {
        kind: "http",
        method: "GET",
        path: "/events",
        status: response.status,
        code: response.status === 401 || response.status === 403 ? "AUTH_REQUIRED" : undefined,
      });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parseBlock = (block: string) => {
      const eventType = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const eventId = block.split("\n").find((line) => line.startsWith("id:"))?.slice(3).trim();
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) return undefined;
      try {
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        return { ...parsed as Record<string, unknown>, ...(eventType && !("type" in parsed) ? { type: eventType } : {}), ...(eventId && !("id" in parsed) ? { id: eventId } : {}) };
      } catch {
        return undefined;
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = parseBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) yield event;
          boundary = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode();
      const trailing = parseBlock(buffer);
      if (trailing) yield trailing;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async listTasks(
    options: {
      status?: string;
      kind?: string;
      model?: string;
      scope?: "all" | "canvas" | "image" | "video";
      projectId?: string;
      nodeIds?: string[];
      segmentIds?: string[];
      taskId?: string;
      taskIds?: string[];
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    if (options.kind) query.set("kind", options.kind);
    if (options.model) query.set("model", options.model);
    if (options.scope) query.set("scope", options.scope);
    if (options.projectId) query.set("projectId", options.projectId);
    if (options.nodeIds?.length)
      query.set("nodeIds", options.nodeIds.join(","));
    if (options.segmentIds?.length)
      query.set("segmentIds", options.segmentIds.join(","));
    if (options.taskId) query.set("taskId", options.taskId);
    if (options.taskIds?.length)
      query.set("taskIds", options.taskIds.join(","));
    if (options.limit) query.set("limit", String(options.limit));
    if (options.offset) query.set("offset", String(options.offset));
    const data = await this.get<{ tasks?: RuntimeTask[] }>(
      `${CANVAS_TASKS_PATH}${query.size ? `?${query.toString()}` : ""}`,
    );
    return data.tasks || [];
  }

  async createTask(
    kind: string,
    input: Record<string, unknown> = {},
    params: Record<string, unknown> = {},
  ) {
    const data = await this.post<{ ok: boolean; task?: unknown }>(
      CANVAS_TASKS_PATH,
      { kind, input, params },
    );
    return data.task;
  }

  async updateTask(id: string, patch: Record<string, unknown>) {
    const data = await this.patch<{ ok: boolean; task?: unknown }>(
      canvasTaskPath(id),
      patch,
    );
    return data.task;
  }

  async cancelTask(id: string): Promise<RuntimeTask> {
    const data = await this.post<{ ok: boolean; task?: RuntimeTask }>(
      canvasTaskActionPath(id, "cancel"),
    );
    if (!data.task)
      throw new Error(`backend task cancel returned no task: ${id}`);
    return data.task;
  }

  async retryTask(id: string): Promise<RuntimeTask> {
    const data = await this.post<{ ok: boolean; task?: RuntimeTask }>(
      canvasTaskActionPath(id, "retry"),
    );
    if (!data.task)
      throw new Error(`backend task retry returned no task: ${id}`);
    return data.task;
  }

  async resolveH3Confirmation(id: string, request: { action: "confirm" | "keep_first_pass" | "discard"; segmentIds: string[]; firstPassFingerprint: string; retry?: boolean }): Promise<RuntimeTask> {
    const data = await this.post<{ ok: boolean; task?: RuntimeTask }>(h3ConfirmationPath(id), request);
    if (!data.task) throw new Error(`backend H3 confirmation returned no task: ${id}`);
    return data.task;
  }

  // ── runtime media（H3 ref 落地，总后台 media store 权威） ─────────────

  /**
   * 落地一个 runtime media。
   * 传 `storageKey` 时直接复用总后台 media store 里已有的媒体（零拷贝，不回传 base64）；
   * 否则走 dataUrl 上传。storageKey 可能带 URL 编码（如 `image%3A<uuid>`），
   * 总后台会自行 decodeURIComponent，这里原样透传即可。
   */
  async runtimeMediaStore(
    name: string,
    dataUrl: string,
    storageKey?: string,
  ): Promise<{
    id: string;
    path: string;
    name: string;
    mimeType: string;
    bytes: number;
    url: string;
  }> {
    const payload = storageKey ? { name, storageKey } : { name, dataUrl };
    const data = await this.post<{
      ok: boolean;
      media: {
        id: string;
        path: string;
        name: string;
        mimeType: string;
        bytes: number;
        url: string;
      };
    }>("/runtime/media", payload);
    return data.media;
  }

  async runtimeMediaRead(name: string): Promise<ArrayBuffer> {
    const res = await fetch(
      `${this.backendUrl}/runtime/media-file?name=${encodeURIComponent(name)}&token=${encodeURIComponent(this.backendToken)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok)
      throw new Error(`Backend runtime media-file failed: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  async runtimeMediaPath(ref: string): Promise<string> {
    if (path.isAbsolute(ref)) return ref;
    const url = new URL(ref, this.backendUrl);
    if (!url.pathname.startsWith("/media/")) return ref;
    const storageKey = decodeURIComponent(url.pathname.slice("/media/".length));
    // 直接用 storageKey 复用总后台已有媒体：不再整段下载再 base64 回传（H3 串 clip 时极易撑爆请求体 → 413）
    return (
      await this.runtimeMediaStore(
        `h3-motion-context-${storageKey}`,
        "",
        storageKey,
      )
    ).path;
  }

  // ── ComfyUI Bridge（总后台权威 /comfy/*） ─────────────────────────────

  async comfyStatus(): Promise<Record<string, unknown>> {
    const data = await this.get<{
      ok: boolean;
      connected?: boolean;
      url?: string;
      error?: string | null;
      [k: string]: unknown;
    }>("/comfy/status");
    return data as Record<string, unknown>;
  }

  async comfyModels(
    signal?: AbortSignal,
  ): Promise<{
    models: string[];
    loras: string[];
    textEncoders: string[];
    videoVaes: string[];
    audioVaes: string[];
    latentUpscaleModels: string[];
    nanfeng?: Record<string, unknown[]>;
    refreshedAt: string;
    error?: string;
  }> {
    const data = await this.get<{
      ok: boolean;
      data?: {
        models: string[];
        loras: string[];
        textEncoders: string[];
        videoVaes: string[];
        audioVaes: string[];
        latentUpscaleModels?: string[];
        nanfeng?: Record<string, unknown[]>;
        refreshedAt: string;
        error?: string;
      };
    }>("/comfy/models", signal);
    if (!data.data) throw new Error("backend comfy models missing data");
    return {
      ...data.data,
      latentUpscaleModels: data.data.latentUpscaleModels || [],
    };
  }

  async comfyRun(
    preset: string,
    input: Record<string, unknown>,
    params: Record<string, unknown>,
    baseUrl?: string,
    clientTaskId?: string,
  ) {
    const data = await this.post<{ ok: boolean; task?: RuntimeTask }>(
      "/comfy/tasks",
      {
        preset,
        input,
        params,
        ...(baseUrl ? { comfyUrl: baseUrl } : {}),
        ...(clientTaskId ? { clientTaskId } : {}),
      },
    );
    if (!data.task)
      throw new BackendClientError(
        "Backend ComfyUI run returned no task",
        {
          kind: "invalid_response",
          method: "POST",
          path: "/comfy/run",
          code: "BACKEND_INVALID_RESPONSE",
        },
      );
    return data.task;
  }

  async comfyGetTask(
    id: string,
    after = 0,
  ): Promise<{ task: RuntimeTask; events: RuntimeTaskEvent[] }> {
    const data = await this.get<{
      ok: boolean;
      task?: RuntimeTask;
      events?: RuntimeTaskEvent[];
    }>(
      `/comfy/tasks/${encodeURIComponent(id)}${after ? `?after=${after}` : ""}`,
    );
    if (!data.task)
      throw new BackendClientError(
        `Backend /comfy/tasks/${id} returned no task`,
        {
          kind: "invalid_response",
          method: "GET",
          path: `/comfy/tasks/${encodeURIComponent(id)}`,
          code: "BACKEND_INVALID_RESPONSE",
        },
      );
    return { task: data.task, events: data.events || [] };
  }

  async comfyCancel(id: string): Promise<RuntimeTask> {
    const data = await this.post<{ ok: boolean; task?: RuntimeTask }>(
      `/comfy/tasks/${encodeURIComponent(id)}/cancel`,
    );
    if (!data.task) throw new Error("backend comfy cancel missing task");
    return data.task;
  }

  async comfyConfig(): Promise<{ url: string }> {
    const data = await this.get<{ ok: boolean; url: string }>("/comfy/config");
    return { url: data.url };
  }

  async comfyPresets() {
    const data = await this.get<{ data?: unknown[] }>("/comfy/presets");
    return data.data || [];
  }

  async comfySetConfig(url: string): Promise<{ url: string }> {
    const data = await this.put<{ ok: boolean; url: string }>("/comfy/config", {
      url,
    });
    return { url: data.url };
  }

  async getH3Defaults(): Promise<Record<string, unknown>> {
    const data = await this.get<{ defaults?: Record<string, unknown> | null }>(
      "/plugins/minimax-h3/defaults",
    );
    return data.defaults && typeof data.defaults === "object"
      ? data.defaults
      : {};
  }

  async setH3Defaults(
    settings: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await this.put<{ defaults?: Record<string, unknown> }>(
      "/plugins/minimax-h3/defaults",
      settings,
    );
    return data.defaults || settings;
  }

  async resetH3Defaults(): Promise<void> {
    await this.delete("/plugins/minimax-h3/defaults");
  }
}

/** 默认总后台地址常量（供 config 使用）。 */
export const DEFAULT_BACKEND_URL = `http://127.0.0.1:${Number(process.env.INFINITE_CANVAS_BACKEND_PORT) || 17370}`;
export const DEFAULT_BACKEND_PORT = 17370;
