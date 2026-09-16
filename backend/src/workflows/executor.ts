import fs from "node:fs/promises";
import type { WorkflowConfig, WorkflowField, RuntimeTask, BackendDatabase } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import { collectOutputMedia } from "../comfyui/bridge.js";
import type { MediaStore, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { redactInlineMedia } from "../runtime/redact-inline-media.js";

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
function buildParams(fields: WorkflowField[], values: FieldValues, workflow: Record<string, unknown>): RunParams {
    const params: RunParams = {};
    for (const field of fields) {
        if (!field.input) continue;
        if (!(field.id in values)) continue;
        // 跳过多节点字段（在 run() 中单独处理）
        if (field.node.includes(",")) continue;
        let value = values[field.id];
        if (isImageField(field, workflow)) {
            // LoadImage 字段即使配置类型被错误保存为 number/text，也必须按图片文件名处理。
        } else if (field.type === "number" || field.type === "slider") {
            const num = typeof value === "number" ? value : Number(value);
            if (!Number.isNaN(num)) {
                value = field.step && field.step < 1 ? num : Math.round(num);
            }
        } else if (field.type === "boolean") {
            value = Boolean(value);
        } else if (field.type === "dropdown") {
            // 下拉框（ComfyUI COMBO）的选项都是字符串且必须命中 options 列表。
            // 不能做数字强制转换，否则 "16" 会被变成数字 16，导致 ComfyUI 校验
            // 「value_not_in_list」失败。值不合法时回退到第一个选项。
            const str = typeof value === "string" ? value : String(value);
            const opts = field.options;
            if (Array.isArray(opts) && opts.length > 0 && !opts.includes(str)) {
                value = opts[0];
            } else {
                value = str;
            }
        }
        if (!params[field.node]) params[field.node] = {};
        (params[field.node] as Record<string, unknown>)[field.input] = value;
    }
    return params;
}

function isImageField(field: WorkflowField, workflow: Record<string, unknown>) {
    if (field.type === "image") return true;
    return field.node.split(",").some((id) => (workflow[id] as { class_type?: string } | null | undefined)?.class_type === "LoadImage");
}

/**
 * 收集标记为「提示词」的文本字段值，用于任务与生成日志的 prompt 字段。
 */
function buildPrompt(fields: WorkflowField[], values: FieldValues): string | undefined {
    const prompts: string[] = [];
    for (const field of fields) {
        if (field.type !== "text" || !field.isPrompt) continue;
        const value = values[field.id];
        if (typeof value === "string" && value.trim()) prompts.push(value.trim());
    }
    return prompts.length > 0 ? prompts.join("\n") : undefined;
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
        const node = result[nodeId] as Record<string, unknown> | null;
        if (!node || typeof node !== "object") continue;
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

type WfNode = { class_type?: string; inputs?: Record<string, unknown> } | null;

/**
 * 从「注入参数后的最终 graph」判定哪些 LoadImage 节点真正“被提供”。
 * 这是 ComfyUI 实际会看到的真相来源：只要某 LoadImage 节点的 inputs.image
 * 是非空字符串（上传后得到的文件名，或工作流预置文件名），即视为已提供。
 *
 * 之所以不直接用 processedValues 判断，是因为 processImageFields 上传失败/返回异常时
 * processedValues 可能为 null，进而 injectParams 会把该 LoadImage 的 inputs.image 删掉，
 * 此时 graph 才是唯一可靠的“是否提供”判据。
 */
function getPresentLoadImages(workflow: Record<string, unknown>): Set<string> {
    const present = new Set<string>();
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const item = node as WfNode;
        if (item!.class_type !== "LoadImage") continue;
        const img = item!.inputs?.image;
        if (typeof img === "string" && img.trim().length > 0) present.add(id);
    }
    return present;
}

/**
 * 判断 workflow 中某个节点 id 是否真实存在（非空对象、有 class_type）。
 * 用于容忍原始 workflow JSON 里可能存在的 null 节点。
 */
function isNodePresent(workflow: Record<string, unknown>, id: string): boolean {
    const n = workflow[id] as WfNode;
    return !!n && typeof n === "object" && typeof (n as { class_type?: string }).class_type === "string";
}

/**
 * 字段级裁剪（替代原先的“全图递归删除”）。
 *
 * 关键修正：原实现用 `some` 判定——只要某个节点的「任一」连线输入指向已删除节点
 * 就把它整节点删掉，结果会把 ComfySwitchNode、尺寸链、甚至输出路径一起误删，
 * 导致 ComfyUI 返回 HTTP 400 / Prompt has no outputs。
 *
 * 正确规则（对齐参考项目 rhPruneWorkflowForMissingFields 的“只删字段所在节点及直接连接”思路，
 * 并修正 Flux2-Klein 这类多分支共用输出/尺寸链的工作流）：
 * 1. 只移除空图片字段对应的 LoadImage 节点本身。
 * 2. 级联裁剪：
 *    - 普通节点：只要「任一」连线输入指向已删除节点就移除（它已无法产出有效输出）。
 *    - ComfySwitchNode：仅当「选中分支」指向已删除节点才移除；未选中分支悬空不影响执行。
 *    - SaveImage / PreviewImage 永远保留（但其悬空输入会在提交前被校验捕获）。
 * 3. 清理存活节点上指向已删除节点的悬空连线（删除该 input 而不是删节点）。
 */
function removeEmptyImageNodes(workflow: Record<string, unknown>, fields: WorkflowField[], values: FieldValues) {
    // 用 graph 真相判断“哪些 LoadImage 未被提供”：只要节点的 inputs.image 为空即视为缺失。
    // 不再依赖 values[field.id]（processedValues 在上传异常时可能为 null）。
    const present = getPresentLoadImages(workflow);
    const removed = new Set<string>();
    // 1) 收集空图片字段对应的 LoadImage 节点（field.node 可能是逗号分隔的多个 id）
    for (const field of fields) {
        if (!isImageField(field, workflow)) continue;
        let fieldMissing = false;
        for (const id of field.node.split(",").map((value) => value.trim())) {
            if (isNodePresent(workflow, id) && (workflow[id] as WfNode)!.class_type === "LoadImage" && !present.has(id)) {
                removed.add(id);
                fieldMissing = true;
            }
        }
        if (fieldMissing && field.required === true) {
            throw new Error(`工作流缺少必选图片：${field.name || field.id}`);
        }
    }
    if (!removed.size) return workflow;

    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    for (const id of removed) delete result[id];

    // 2) 级联裁剪
    let changed = true;
    while (changed) {
        changed = false;
        for (const [nodeId, node] of Object.entries(result)) {
            if (removed.has(nodeId) || !node || typeof node !== "object") continue;
            const item = node as WfNode;
            const cls = item!.class_type;
            if (cls === "SaveImage" || cls === "PreviewImage") continue;
            const inputs = item!.inputs;
            if (!inputs) continue;
            const linkEntries = Object.entries(inputs).filter(
                ([, v]) => Array.isArray(v) && typeof (v as unknown[])[0] === "string",
            );
            if (!linkEntries.length) continue;
            let shouldRemove = false;
            if (cls === "ComfySwitchNode") {
                const sel = selectedSwitchBranch(result, item!);
                if (sel === null) {
                    // 开关来源缺失，无法判定选中分支 -> 视为无效，移除并级联
                    shouldRemove = true;
                } else {
                    const selLink = inputs[sel] as unknown[];
                    if (Array.isArray(selLink) && removed.has(String(selLink[0]))) shouldRemove = true;
                }
            } else {
                shouldRemove = linkEntries.some(([, v]) => removed.has(String((v as unknown[])[0])));
            }
            if (shouldRemove) {
                removed.add(nodeId);
                delete result[nodeId];
                changed = true;
            }
        }
    }

    // 3) 清理存活节点上指向已删除节点的悬空连线（含 ComfySwitchNode 的未选中分支）
    for (const node of Object.values(result)) {
        if (!node || typeof node !== "object") continue;
        const inputs = (node as WfNode)!.inputs;
        if (!inputs) continue;
        for (const [name, value] of Object.entries(inputs)) {
            if (Array.isArray(value) && typeof value[0] === "string" && removed.has(value[0])) {
                delete inputs[name];
            }
        }
    }
    return result;
}

/**
 * 解析 ComfySwitchNode 当前选中的分支名（on_true / on_false）。
 * 通过 switch 输入追溯 PrimitiveBoolean 节点的 value 判定；来源缺失/不可判定时返回 null。
 */
function selectedSwitchBranch(graph: Record<string, unknown>, node: WfNode): "on_true" | "on_false" | null {
    const sw = node!.inputs?.switch;
    if (Array.isArray(sw) && isNodePresent(graph, String(sw[0]))) {
        const swNode = graph[String(sw[0])] as WfNode;
        if (swNode && swNode.class_type === "PrimitiveBoolean") {
            return swNode.inputs?.value === true ? "on_true" : "on_false";
        }
    }
    return null;
}

/**
 * 智能路由（Flux2-Klein 类「尺寸/主参考来自单一图片」工作流的容错）。
 *
 * 某些工作流的输出尺寸由 `GetImageSize` 取自某一张参考图（本例为 LoadImage 278 -> ImageScaleToTotalPixels 291），
 * 且默认开关下主参考 latent 也来自同一张图。若用户只提供了其它参考图（270/292）而未提供该「尺寸源」图，
 * 直接裁剪会让尺寸链 / 主参考链断裂。这里在裁剪前把 `GetImageSize` 上游 scaler 的 image 输入改接到
 * 用户实际提供的某张图上，使「任意单图」都能拼出有效工作流。
 *
 * 仅当检测到 GetImageSize -> ImageScaleToTotalPixels 结构、且尺寸源 LoadImage 确实缺失但存在其它已提供
 * 的 LoadImage 时才生效；否则原样返回（对其它工作流零影响）。
 */
function routeSizeImage(workflow: Record<string, unknown>, presentLoadImages: Set<string>): void {
    const getImgEntry = Object.entries(workflow).find(
        ([, n]) => n && typeof n === "object" && (n as WfNode)!.class_type === "GetImageSize",
    );
    if (!getImgEntry) return;
    const gnode = getImgEntry[1] as WfNode;
    const imgLink = gnode!.inputs?.image;
    if (!Array.isArray(imgLink) || typeof imgLink[0] !== "string") return;
    const scaNode = workflow[String(imgLink[0])] as WfNode;
    if (!scaNode || scaNode.class_type !== "ImageScaleToTotalPixels") return;
    const srcLoad = scaNode.inputs?.image;
    if (!Array.isArray(srcLoad) || typeof srcLoad[0] !== "string") return;
    const srcId = String(srcLoad[0]);
    if (presentLoadImages.has(srcId)) return; // 尺寸源已提供，无需改接
    const alt = [...presentLoadImages].find((id) => id !== srcId);
    if (!alt) return;
    (scaNode.inputs as Record<string, unknown>).image = [alt, 0];
}

/**
 * 提交给 ComfyUI 前的静态图校验。
 *
 * 注意：被检查的对象必须是**裁剪 + 清理后**的最终 workflow（prepared），不是裁剪前的 full。
 * 原因：`removeEmptyImageNodes` 第 3 步会清掉存活节点上指向已删节点的悬空 input，
 * 拿裁剪前的 full 校验会把「已经被清掉的」悬空引用再次当错报上来。
 *
 * 校验内容：
 *   1) 兜底：prepared 至少要有一个 SaveImage / PreviewImage 输出节点，否则
 *      ComfyUI 会返回 400 "Prompt has no outputs"，提前抛更清晰。
 *   2) 兜底悬空：prepared 里若还存在「input 引用了不在 prepared 中的节点」（说明第 3
 *      步漏掉），按 ComfySwitchNode 选中分支例外放过；其它情况列出。
 *
 * @param prepared 裁剪 + 清理后的最终 workflow（即将提交给 ComfyUI）
 */
function validatePromptGraph(prepared: Record<string, unknown>): void {
    // 1) 兜底：没有任何 SaveImage / PreviewImage 输出节点
    const hasOutput = Object.values(prepared).some(
        (n) =>
            !!n &&
            typeof n === "object" &&
            ((n as WfNode)!.class_type === "SaveImage" || (n as WfNode)!.class_type === "PreviewImage"),
    );
    if (!hasOutput) {
        throw new Error(
            "工作流裁剪后没有任何 SaveImage / PreviewImage 输出节点，无法提交 ComfyUI。" +
                "（说明：当前传入的参考图不足以覆盖工作流开关/分支依赖——Flux2-Klein 默认开关下「图 B(278)」为必选槽位，请提供该图片，或调整工作流开关后再试）",
        );
    }
    // 2) 兜底悬空：prepared 中还存在的 input 是否指向 prepared 中不存在的节点 id
    const dangling: string[] = [];
    for (const [id, node] of Object.entries(prepared)) {
        if (!node || typeof node !== "object" || !(node as WfNode)!.inputs) continue;
        const item = node as WfNode;
        const cls = item!.class_type;
        const sel = cls === "ComfySwitchNode" ? selectedSwitchBranch(prepared, item!) : null;
        for (const [name, value] of Object.entries(item!.inputs!)) {
            if (!Array.isArray(value) || typeof (value as unknown[])[0] !== "string") continue;
            const target = String((value as unknown[])[0]);
            if (!isNodePresent(prepared, target)) {
                // ComfySwitchNode 未选中分支悬空是允许的
                if (cls === "ComfySwitchNode" && (name === "on_true" || name === "on_false") && name !== sel) continue;
                dangling.push(`节点 ${id} (${cls}) 的输入 ${name} 指向不存在的节点 ${target}`);
            }
        }
    }
    if (dangling.length) {
        throw new Error(
            `工作流裁剪后存在未满足的依赖，无法提交 ComfyUI：\n- ${dangling.join("\n- ")}\n` +
                `（说明：当前传入的参考图不足以覆盖工作流开关/分支依赖，请检查已提供的图片槽位与开关配置是否匹配）`,
        );
    }
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
    workflow: Record<string, unknown>,
    fieldValues: FieldValues,
    comfyUrl: string,
    signal: AbortSignal,
): Promise<FieldValues> {
    const result: FieldValues = { ...fieldValues };
    for (const field of fields) {
        if (!isImageField(field, workflow)) continue;
        const value = fieldValues[field.id];
        // 空图片槽位必须显式删除工作流中的原始文件名，否则 ComfyUI 会继续校验
        // workflow JSON 里预置的 LoadImage 文件；这样一个工作流可以支持 0-N 张图。
        if (!value || typeof value !== "string") {
            result[field.id] = null;
            continue;
        }
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
    private readonly controllers = new Map<string, AbortController>();
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
        clientTaskId?: string,
        // 画布生成日志关联：项目 id + 触发节点 id（为空时仍允许走，但没有日志）
        projectId?: string,
        nodeId?: string,
        parentTaskId?: string,
    ): Promise<RunResult> {
        const controller = new AbortController();
        const url = comfyUrl ?? this.bridge.getUrl();
        // 先处理 image 字段：上传 dataURL → 获取文件名
        const processedValues = await processImageFields(config.fields, workflowJson, fieldValues, url, controller.signal);
        const promptText = buildPrompt(config.fields, processedValues) || config.title;
        const persistedFieldValues = redactInlineMedia(fieldValues);
        // 处理 seed=-1 随机化
        for (const field of config.fields || []) {
            if ((field.id === "seed" || field.id === "noise_seed") && processedValues[field.id] === -1) {
                processedValues[field.id] = Math.floor(Math.random() * 1125899906842624);
            }
        }

        // 处理多节点字段（node 含逗号，如 Flux2-Klein 的 width/height 需同时注入到 152 和 156）
        const multiNodeParams: RunParams = {};
        for (const field of config.fields || []) {
            if (!field.node.includes(",")) continue;
            const value = processedValues[field.id];
            if (value === undefined) continue;
            for (const nodeId of field.node.split(",")) {
                if (!multiNodeParams[nodeId]) multiNodeParams[nodeId] = {};
                (multiNodeParams[nodeId] as Record<string, unknown>)[field.input] = value;
            }
        }

        const params = buildParams(config.fields, processedValues, workflowJson);
        // 合并多节点参数
        for (const [nodeId, inputs] of Object.entries(multiNodeParams)) {
            if (!params[nodeId]) params[nodeId] = {};
            Object.assign(params[nodeId] as Record<string, unknown>, inputs);
        }
        const full = injectParams(workflowJson, params);
        // 智能路由：若尺寸源 LoadImage 缺失但用户提供了其它参考图，把尺寸链(GETImageSize 上游 scaler)
        // 改接到用户提供的图上，使 Flux2-Klein 这类工作流在任意单图下都能拼出有效图。
        // 用 graph 真相（LoadImage.inputs.image 是否非空）判定“已提供”，不再依赖 processedValues。
        const presentLoadImages = getPresentLoadImages(full);
        routeSizeImage(full, presentLoadImages);
        // 调试：打印注入后各 LoadImage 的 inputs.image，确认“已提供”判定是否准确
        console.log("[workflows:run] image presence", {
            name,
            present: [...presentLoadImages],
            loadImageInputs: Object.fromEntries(
                Object.entries(full)
                    .filter(([, n]) => (n as WfNode)?.class_type === "LoadImage")
                    .map(([id, n]) => [id, (n as WfNode)!.inputs?.image]),
            ),
        });
        const prepared = removeEmptyImageNodes(full, config.fields, processedValues);
        // 提交前静态校验：必须用「裁剪+清理后」的最终图 prepared，不能用裁剪前的 full；
        // 否则 removeEmptyImageNodes 第 3 步已经清掉的悬空 input 会被误判为「指向已被裁剪的节点」。
        try {
            validatePromptGraph(prepared);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[workflows:run] graph validation failed", {
                name,
                remainingNodes: Object.keys(prepared).length,
            });
            throw new Error(`工作流裁剪校验未通过：${msg}`);
        }
        console.log("[workflows:run] pruned graph", {
            name,
            remainingNodeCount: Object.keys(prepared).length,
            saveImagePresent: Object.values(prepared).some((n) => (n as WfNode)?.class_type === "SaveImage"),
        });
        const task = clientTaskId
            ? this.tasks.create(clientTaskId, "workflow", { workflow: "custom", fields: persistedFieldValues, prompt: promptText }, { ...params, ...(parentTaskId ? { parentTaskId } : {}) })
            : this.tasks.create("workflow", { workflow: "custom", fields: persistedFieldValues, prompt: promptText }, { ...params, ...(parentTaskId ? { parentTaskId } : {}) });
        this.controllers.set(task.id, controller);
        this.events?.publish({ type: "task.updated", entityId: task.id, payload: task });

        try {
            this.tasks.update(task.id, { status: "running", progress: 0.05 });
            const finalResult = await this.executeWorkflow(task, prepared, url, controller, clientId);
            this.tasks.update(task.id, { status: "succeeded", progress: 1, result: finalResult });
            this.events?.publish({ type: "task.completed", entityId: task.id, payload: finalResult });
            this.db?.createGenerationLog({
                projectId: projectId || "workflow",
                nodeId,
                status: "success",
                platform: "workflow",
                workflow: name || "unknown",
                prompt: promptText,
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
                params: { fields: persistedFieldValues, configTitle: config.title },
            });
            return { taskId: task.id, ...finalResult };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.tasks.get(task.id)?.status !== "cancelled") {
                this.tasks.update(task.id, { status: "failed", error: message });
                this.events?.publish({ type: "task.failed", entityId: task.id, payload: { error: message } });
            }
            this.db?.createGenerationLog({
                projectId: projectId || "workflow",
                nodeId,
                status: "failed",
                platform: "workflow",
                workflow: name || "unknown",
                prompt: promptText,
                references: [],
                inputCounts: {},
                startedAt: new Date().toISOString(),
                durationMs: 0,
                outputs: [],
                error: message,
                params: { fields: persistedFieldValues, configTitle: config.title },
            });
            throw error;
        } finally {
            this.controllers.delete(task.id);
        }
    }

    cancel(id: string) {
        this.controllers.get(id)?.abort();
        this.controllers.delete(id);
        const task = this.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        const updated = this.tasks.cancel(id);
        this.events?.publish({ type: "task.updated", entityId: id, payload: updated });
        return updated;
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
                                if (msg.type === "execution_success") wsExecuted = true;
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
                    const useOutputs = wsOutputs ?? wsExecutionSuccessOutputs;
                    if (useOutputs && Object.keys(useOutputs).length > 0) {
                        const media = await collectOutputMedia(useOutputs, comfyUrl, this.media, controller.signal);
                        if (media.length) return { promptId, outputs: useOutputs, media, status: { status_str: "success", completed: true } };
                    }
                    if (Date.now() - startedAt > 60000) throw new Error("ComfyUI 已在 WebSocket 报告完成但取回结果");
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
                        if (media.length) return { promptId, outputs: item.outputs, media, status: item.status || {} };
                        if (Date.now() - startedAt > 60000) throw new Error("ComfyUI 执行结束但输出中没有可用媒体");
                    }
                }
                await new Promise((r) => setTimeout(r, 1500));
            }
        } finally {
            try { ws?.close(); } catch {}
        }
    }
}
