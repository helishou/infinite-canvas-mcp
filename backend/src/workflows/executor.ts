import fs from "node:fs/promises";
import type { WorkflowConfig, WorkflowField, RuntimeTask, BackendDatabase } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import { collectOutputMedia } from "../comfyui/bridge.js";
import type { MediaStore, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";

type RunParams = Record<string, unknown>;
type FieldValues = Record<string, unknown>;

type RunResult = {
    taskId: string;
    promptId: string;
    outputs: Record<string, unknown>;
    media: Array<{ url: string; storageKey?: string; mimeType: string; filename: string }>;
    status: { status_str: string; completed: boolean };
};

/**
 * 将用户字段值转换为 {node_id: {input_name: value}} 格式
 * 对应 Python run_workflow() L15690-15711
 */
function buildParams(fields: WorkflowField[], values: FieldValues): RunParams {
    const params: RunParams = {};
    for (const field of fields) {
        if (!field.node || !field.input) continue;
        if (!(field.id in values)) continue;
        let value = values[field.id];
        if (field.type === "number" || field.type === "slider") {
            const num = typeof value === "number" ? value : Number(value);
            if (!Number.isNaN(num)) {
                value = field.step && field.step < 1 ? num : Math.round(num);
            }
        } else if (field.type === "boolean") {
            value = Boolean(value);
        } else if (field.type === "dropdown" && typeof value === "string") {
            const s = value.trim();
            if (s && (s.includes(".") || s.toLowerCase().includes("e"))) {
                const f = parseFloat(s); if (!Number.isNaN(f)) value = f;
            } else if (s && /^-?\d+$/.test(s)) {
                const i = parseInt(s, 10); if (!Number.isNaN(i)) value = i;
            }
        }
        if (!params[field.node]) params[field.node] = {};
        (params[field.node] as Record<string, unknown>)[field.input] = value;
    }
    return params;
}

/**
 * 注入参数到 workflow JSON 副本
 * 对应 Python generate() L15098-15108
 */
function injectParams(
    workflow: Record<string, unknown>,
    params: RunParams,
): Record<string, unknown> {
    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    for (const [nodeId, nodeInputs] of Object.entries(params)) {
        if (!(nodeId in result)) continue;
        const node = result[nodeId] as Record<string, unknown>;
        if (!node.inputs) node.inputs = {};
        for (const [inputName, value] of Object.entries(nodeInputs as Record<string, unknown>)) {
            if (value === null) {
                delete (node.inputs as Record<string, unknown>)[inputName];
            } else {
                (node.inputs as Record<string, unknown>)[inputName] = value;
            }
        }
    }
    return result;
}

/**
 * 将 dataURL 上传到 ComfyUI，获取文件名
 */
async function uploadDataUrlToComfy(
    dataUrl: string,
    fieldId: string,
    comfyUrl: string,
    signal: AbortSignal,
): Promise<string> {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) throw new Error(`Invalid dataURL for field ${fieldId}`);
    const mimeType = match[1] || "image/png";
    const base64 = match[2];
    const ext = mimeType.split("/")[1]?.split(";")[0] || "png";
    const filename = `workflow_${fieldId}_${Date.now()}.${ext}`;

    const blob = Buffer.from(base64, "base64");
    const form = new FormData();
    form.set("image", new Blob([blob], { type: mimeType }), filename);
    form.set("overwrite", "true");

    const response = await fetch(`${comfyUrl.replace(/\/$/, "")}/upload/image`, {
        method: "POST",
        body: form,
        signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`ComfyUI upload failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const body = (await response.json()) as { name?: string };
    if (!body.name) throw new Error("ComfyUI 未返回文件名");
    return body.name;
}

/**
 * 处理 image 类型的 field：如果是 dataURL 则上传到 ComfyUI 获取文件名，否则保持原值
 */
async function processImageFields(
    fields: WorkflowField[],
    fieldValues: FieldValues,
    comfyUrl: string,
    signal: AbortSignal,
): Promise<FieldValues> {
    const result: FieldValues = { ...fieldValues };
    for (const field of fields) {
        if (field.type !== "image") continue;
        const value = fieldValues[field.id];
        if (!value || typeof value !== "string") continue;
        if (value.startsWith("data:image")) {
            result[field.id] = await uploadDataUrlToComfy(value, field.id, comfyUrl, signal);
        } else if (/^https?:\/\//.test(value) || value.startsWith("/media/")) {
            // 生图工作站的参考图是 URL 或 /media/ 路径，需要 fetch 后上传到 ComfyUI
            let url = value;
            if (value.startsWith("/media/")) {
                // /media/ 路径由本 backend 服务（默认 17370），不从 ComfyUI 取
                const backendBase = `http://127.0.0.1:${process.env.PORT || 17370}`;
                url = `${backendBase}${value}`;
            }
            const resp = await fetch(url, { signal });
            if (!resp.ok) throw new Error(`为字段 ${field.id} 拉取图片失败: HTTP ${resp.status}`);
            const blob = await resp.blob();
            const ext = blob.type.split("/")[1]?.split(";")[0] || "png";
            const filename = `workflow_${field.id}_${Date.now()}.${ext}`;
            const form = new FormData();
            form.set("image", blob, filename);
            form.set("overwrite", "true");
            const uploadResp = await fetch(`${comfyUrl.replace(/\/$/, "")}/upload/image`, {
                method: "POST",
                body: form,
                signal,
            });
            if (!uploadResp.ok) {
                const text = await uploadResp.text().catch(() => "");
                throw new Error(`ComfyUI 上传失败: HTTP ${uploadResp.status} ${text.slice(0, 200)}`);
            }
            const body = (await uploadResp.json()) as { name?: string };
            if (!body.name) throw new Error("ComfyUI 未返回文件名");
            result[field.id] = body.name;
        }
    }
    return result;
}

export class WorkflowExecutor {
    constructor(
        private readonly bridge: ComfyUiBackend,
        private readonly tasks: TaskStore,
        private readonly media: MediaStore,
        private readonly events?: BackendEventBus,
        private readonly db?: BackendDatabase,
    ) {}

    async run(
        workflowJson: Record<string, unknown>,
        config: WorkflowConfig,
        fieldValues: FieldValues,
        clientId: string,
        comfyUrl?: string,
        name?: string,
    ): Promise<RunResult> {
        const controller = new AbortController();
        const url = comfyUrl ?? this.bridge.getUrl();
        // 调试：把 fields / config 摘要写到 backend stdout，
        // 下次 processImageFields / buildParams / injectParams 抛错时
        // 能直接看到收到什么数据。生产环境可去掉。
        const imageFields = (config.fields || []).filter((f) => f.type === "image");
        console.log("[workflows:run] start", {
            name,
            comfyUrl: url,
            totalFields: (config.fields || []).length,
            imageFieldCount: imageFields.length,
            imageFieldIds: imageFields.map((f) => f.id),
            fieldValueKeys: Object.keys(fieldValues),
            fieldValueTypes: Object.fromEntries(Object.entries(fieldValues).map(([k, v]) => [k, typeof v === "string" && v.startsWith("data:") ? `dataUrl(${v.length} chars)` : typeof v])),
        });
        // 先处理 image 字段：上传 dataURL → 获取文件名
        const processedValues = await processImageFields(config.fields, fieldValues, url, controller.signal);
        const params = buildParams(config.fields, processedValues);
        const prepared = injectParams(workflowJson, params);
        const task = this.tasks.create("workflow", { workflow: "custom", fields: fieldValues }, params);
        this.events?.publish({ type: "task.updated", entityId: task.id, payload: task });

        try {
            this.tasks.update(task.id, { status: "running", progress: 0.05 });
            const finalResult = await this.executeWorkflow(task, prepared, url, controller, clientId);
            this.tasks.update(task.id, { status: "succeeded", progress: 1, result: finalResult });
            this.events?.publish({ type: "task.completed", entityId: task.id, payload: finalResult });
            this.db?.createGenerationLog({
                projectId: "workflow",
                status: "success",
                platform: "workflow",
                workflow: name || "unknown",
                prompt: config.title,
                references: [],
                inputCounts: {},
                startedAt: new Date().toISOString(),
                durationMs: 0,
                outputs: finalResult.media.map((m) => ({
                    url: m.url,
                    storageKey: m.storageKey,
                    mimeType: m.mimeType,
                    name: m.filename,
                })),
                params: { fields: fieldValues, configTitle: config.title },
            });
            return { taskId: task.id, ...finalResult };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.tasks.update(task.id, { status: "failed", error: message });
            this.events?.publish({ type: "task.failed", entityId: task.id, payload: { error: message } });
            this.db?.createGenerationLog({
                projectId: "workflow",
                status: "failed",
                platform: "workflow",
                workflow: name || "unknown",
                prompt: config.title,
                references: [],
                inputCounts: {},
                startedAt: new Date().toISOString(),
                durationMs: 0,
                outputs: [],
                error: message,
                params: { fields: fieldValues, configTitle: config.title },
            });
            throw error;
        }
    }

    private async executeWorkflow(
        task: RuntimeTask,
        workflow: Record<string, unknown>,
        comfyUrl: string,
        controller: AbortController,
        clientId: string,
    ) {
        const Ctor = (globalThis as any).WebSocket;
        let capturedPromptId: string | null = null;
        let ws: any = null;
        let wsExecuted = false;
        let wsOutputs: Record<string, unknown> | null = null;
        let wsClosed = false;
        let wsError: Error | null = null;
        let wsExecutionSuccessOutputs: Record<string, unknown> | null = null;

        try {
            if (typeof Ctor === "function") {
                try {
                    const wsBase = comfyUrl.replace(/^http/, "ws");
                    const socket = new Ctor(`${wsBase}/ws?clientId=${encodeURIComponent(task.id)}`);
                    socket.onmessage = (event: any) => {
                        try {
                            const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
                            if (!raw) return;
                            const msg = JSON.parse(raw);
                            if (!msg?.type || !capturedPromptId || msg?.data?.prompt_id !== capturedPromptId) return;
                            if (msg.type === "executed" || msg.type === "execution_success") {
                                wsExecuted = true;
                                if (msg.data?.output && typeof msg.data.output === "object") {
                                    wsOutputs = { ...(wsOutputs || {}), ...(msg.data.output as Record<string, unknown>) };
                                }
                                if (msg.type === "execution_success" && msg.data?.output) {
                                    wsExecutionSuccessOutputs = msg.data.output;
                                }
                            } else if (msg.type === "execution_error") {
                                const d = msg.data || {};
                                wsError = new Error(`ComfyUI 节点 ${d.node_id ?? "?"} (${d.node_type ?? "?"}) 报错：${d.exception_message || d.exception_type || "未知错误"}`);
                            }
                        } catch {}
                    };
                    socket.onerror = () => { wsClosed = true; wsError = wsError ?? new Error("ComfyUI WebSocket 连接出错"); };
                    socket.onclose = () => { wsClosed = true; };
                    ws = socket;
                } catch {}
            }

            const response = await fetch(`${comfyUrl}/prompt`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: workflow, client_id: task.id }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const details = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 4000);
                throw new Error(`ComfyUI /prompt failed: HTTP ${response.status}${details ? `: ${details}` : ""}`);
            }
            const body = await response.json() as { prompt_id?: string; node_errors?: unknown };
            if (!body.prompt_id) {
                throw new Error(body.node_errors ? JSON.stringify(body.node_errors) : "ComfyUI did not return prompt_id");
            }
            const promptId = body.prompt_id;
            capturedPromptId = promptId;
            this.tasks.addEvent(task.id, "submitted", { promptId });

            const startedAt = Date.now();
            const maxExecutionMs = 30 * 60 * 1000;
            for (;;) {
                if (controller.signal.aborted) throw new Error("任务已取消");
                if (Date.now() - startedAt > maxExecutionMs) throw new Error("ComfyUI 任务执行超时（30 分钟）");
                if (wsError) throw wsError;

                if (wsExecuted) {
                    const useOutputs = wsExecutionSuccessOutputs ?? wsOutputs;
                    if (useOutputs && Object.keys(useOutputs).length > 0) {
                        const media = await collectOutputMedia(useOutputs, comfyUrl, this.media, controller.signal);
                        return { promptId, outputs: useOutputs, media, status: { status_str: "success", completed: true } };
                    }
                    if (Date.now() - startedAt > 60000) throw new Error("ComfyUI 已在 WebSocket 报告完成但取回结果");
                    await new Promise((r) => setTimeout(r, 1500));
                    continue;
                }

                if (wsClosed) throw new Error("WebSocket 已关闭但未收到 executed");

                const historyRes = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal: controller.signal });
                if (historyRes.ok) {
                    const history = await historyRes.json() as Record<string, any>;
                    const item = history[promptId];
                    const statusStr = item?.status?.status_str;
                    if (statusStr === "error" || statusStr === "failed") throw new Error(`ComfyUI 执行失败：${statusStr}`);
                    const hasOutputs = !!(item?.outputs && typeof item.outputs === "object" && Object.keys(item.outputs).length > 0);
                    if (statusStr === "success" || item?.status?.completed || hasOutputs) {
                        if (!hasOutputs) throw new Error("ComfyUI 执行结束但无输出");
                        const media = await collectOutputMedia(item.outputs, comfyUrl, this.media, controller.signal);
                        return { promptId, outputs: item.outputs, media, status: item.status || {} };
                    }
                }
                await new Promise((r) => setTimeout(r, 1500));
            }
        } finally {
            try { ws?.close(); } catch {}
        }
    }
}
