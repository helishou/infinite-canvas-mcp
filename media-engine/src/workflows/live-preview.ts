/**
 * 自定义 ComfyUI 工作流的「生成态预览帧」注册表。
 *
 * 与 H3 的 bridge.livePreviews 是两条独立的采集链：
 * - H3 展开流用 /comfy/tasks/:id 读 bridge 的内存；
 * - 自定义工作流由 WorkflowExecutor 写这里，画布节点用 /tasks/:id 读。
 * 两者共用下发的字段形状（dataUrl / mime / step / total / promptId），前端不必区分。
 *
 * 预览帧只存在于内存：不写 task.result、不写生成日志、不进媒体库，
 * 因此不会混进归档与「以图生图」的参考链。
 */

export type WorkflowLivePreview = {
    dataUrl: string;
    mime?: string;
    step?: number;
    total?: number;
    /** 声明的预览桥节点 id。逐帧事件本身不带身份，靠单选配置归属。 */
    nodeId?: string;
    /** step = 采样逐帧（KJ 预览桥）；node = 节点执行完成帧。 */
    source: "step" | "node";
    promptId?: string;
    updatedAt: number;
};

export type WorkflowLivePreviewFrame = Omit<WorkflowLivePreview, "updatedAt">;

const FRAME_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 256;

const frames = new Map<string, WorkflowLivePreview>();

function prune(now: number) {
    for (const [taskId, frame] of frames) {
        if (now - frame.updatedAt > FRAME_TTL_MS) frames.delete(taskId);
    }
    if (frames.size <= MAX_ENTRIES) return;
    const oldest = [...frames.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(0, frames.size - MAX_ENTRIES);
    for (const [taskId] of oldest) frames.delete(taskId);
}

/**
 * 同一个任务按多个 id 登记：子任务 id（工作流运行）与画布父任务 id。
 * 画布节点只认 metadata.runtimeTaskId（父任务），不需要反查子任务。
 */
export function publishWorkflowLivePreview(taskIds: Array<string | undefined>, frame: WorkflowLivePreviewFrame) {
    const now = Date.now();
    const stored: WorkflowLivePreview = { ...frame, updatedAt: now };
    for (const taskId of taskIds) {
        if (typeof taskId === "string" && taskId) frames.set(taskId, stored);
    }
    prune(now);
}

export function readWorkflowLivePreview(taskId: string): WorkflowLivePreview | null {
    const frame = frames.get(taskId);
    if (!frame) return null;
    if (Date.now() - frame.updatedAt > FRAME_TTL_MS) {
        frames.delete(taskId);
        return null;
    }
    return frame;
}

export function clearWorkflowLivePreview(taskIds: Array<string | undefined>) {
    for (const taskId of taskIds) {
        if (typeof taskId === "string" && taskId) frames.delete(taskId);
    }
}

/**
 * KJ 系预览桥（ModelPreviewOverrideKJ / KJPreviewBridge 等）发的自定义事件不带
 * prompt_id，也不带节点 id。归属靠两件事：task 专属 clientId 的 WS 连接 +
 * 用户在配置里声明的唯一预览桥节点。传入 previewNodeId 为空时一律不收，
 * 避免同一 ComfyUI 实例上并发任务的逐帧画面串台。
 */
export function decodeKjPreviewMessage(message: unknown, previewNodeId: string, promptId: string): WorkflowLivePreviewFrame | null {
    const msg = message as { type?: unknown; data?: Record<string, unknown> } | null;
    if (!msg || msg.type !== "kj_preview_override" || !previewNodeId || !promptId) return null;
    const data = msg.data || (message as Record<string, unknown>);
    const encoded = typeof data?.image === "string" ? data.image : "";
    if (!encoded) return null;
    const mime = typeof data?.mime === "string" && data.mime ? data.mime : "image/jpeg";
    const step = Number(data?.step);
    const total = Number(data?.total);
    return {
        dataUrl: `data:${mime};base64,${encoded}`,
        mime,
        ...(Number.isFinite(step) ? { step } : {}),
        ...(Number.isFinite(total) ? { total } : {}),
        nodeId: previewNodeId,
        source: "step",
        promptId,
    };
}

export type ComfyPreviewImageRef = { filename: string; subfolder: string; type: string };

/**
 * `executed` 事件里 PreviewImage/SaveImage 给的是 temp 文件引用，不是 base64。
 * 只取第一张图；视频/音频产物不塞进预览帧（几 MB 的 dataUrl 不适合 1.5s 轮询）。
 */
export function previewImageRefFromOutput(output: unknown): ComfyPreviewImageRef | null {
    const images = (output as { images?: unknown } | null)?.images;
    if (!Array.isArray(images)) return null;
    for (const entry of images) {
        const item = entry as { filename?: unknown; subfolder?: unknown; type?: unknown } | null;
        const filename = typeof item?.filename === "string" ? item.filename : "";
        if (!filename) continue;
        return {
            filename,
            subfolder: typeof item?.subfolder === "string" ? item.subfolder : "",
            type: typeof item?.type === "string" && item.type ? item.type : "temp",
        };
    }
    return null;
}
