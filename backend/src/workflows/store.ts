import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../config.js";
import type { BackendDatabase } from "../db.js";
import type { WorkflowConfig, WorkflowField } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";

const CUSTOM_SUBDIR = "custom";
// 放宽：允许空格、全角符号、生僻字等任意可见字符；仅禁控制字符和路径非法字符（防穿越另由 workflowFilePath 兜底）
const NAME_RE = /^[^\x00-\x1f\\/:*?"<>|]+\.json$/;
const MEDIA_INPUT_KEYS = ["image", "video", "audio", "mask", "filename", "file"];
const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|aac|ogg|flac)(?:\?|$)/i;
const BUNDLED_WORKFLOWS = ["IndexTTS-2.5.json", "MiniMax_H3.json", "custom/视频修复FlashVSR1.1.json"];
const BUILTIN_CONFIGS: Record<string, WorkflowConfig> = {
    "IndexTTS-2.5.json": {
        title: "IndexTTS 2.5 配音",
        backend: "comfyui",
        operation: "tts",
        description: "使用参考音频克隆音色，并通过本地 IndexTTS 2.5 生成语音。",
        fields: [
            { id: "reference_audio", node: "20", input: "audio", name: "参考音频", type: "audio", required: true },
            { id: "text", node: "30", input: "text", name: "配音文本", type: "text", required: true, default: "", isPrompt: true },
            { id: "language", node: "30", input: "language", name: "语言", type: "dropdown", default: "ZH", options: ["ZH", "EN", "JA", "ES", "AR"] },
            { id: "duration_factor", node: "30", input: "duration_factor", name: "时长系数（越小越快）", type: "slider", default: 1, min: 0.5, max: 2, step: 0.05 },
            { id: "seed", node: "30", input: "seed", name: "随机种子", type: "number", default: 0, randomEnabled: true },
            { id: "filename_prefix", node: "40", input: "filename_prefix", name: "输出文件前缀", type: "text", default: "tts_audio/IndexTTS_2_5" },
        ],
    },
    "MiniMax_H3.json": {
        title: "MiniMax H3 图生视频",
        backend: "comfyui",
        operation: "image-to-video",
        description: "使用参考图和提示词生成带音频的视频，可自定义宽度、高度和时长。",
        fields: [
            { id: "reference_image", node: "137", input: "image", name: "参考图片", type: "image", required: true },
            { id: "prompt", node: "138", input: "value", name: "视频提示词", type: "text", required: true, default: "", isPrompt: true },
            { id: "width", node: "140", input: "value", name: "宽度（像素）", type: "number", default: 864, step: 32 },
            { id: "height", node: "141", input: "value", name: "高度（像素）", type: "number", default: 480, step: 32 },
            { id: "duration", node: "132", input: "value", name: "时长（秒）", type: "number", default: 8 },
            { id: "noise_seed", node: "129", input: "noise_seed", name: "随机种子", type: "number", default: -1, randomEnabled: true },
        ],
    },
    "custom/视频修复FlashVSR1.1.json": {
        title: "FlashVSR 1.1 视频修复",
        backend: "comfyui",
        operation: "video-restore",
        description: "使用 FlashVSR 1.1 放大并修复输入视频。",
        fields: [
            { id: "video", node: "10", input: "video", name: "输入视频", type: "video", required: true },
            { id: "scale", node: "2", input: "value", name: "放大倍数", type: "number", default: 4 },
            { id: "longer_edge", node: "40", input: "longer_edge", name: "预处理长边", type: "number", default: 960 },
        ],
    },
};

export type WorkflowListItem = {
    name: string;
    title: string;
    builtin: boolean;
    fieldCount: number;
};

export type WorkflowDetail = {
    name: string;
    workflow: Record<string, unknown>;
    config: WorkflowConfig;
    builtin: boolean;
};

export type WorkflowPackage = {
    format: "infinite-canvas-workflow";
    version: 1;
    name: string;
    workflow: Record<string, unknown>;
    config: WorkflowConfig;
};

function workflowDir(): string {
    return path.join(DATA_DIR, "workflows");
}

function bundledWorkflowDir(): string {
    return path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "workflows");
}

function workflowFilePath(name: string): string {
    // 允许 "custom/filename.json" 格式，但 basename 必须匹配 NAME_RE
    const parts = name.split('/');
    const basename = parts[parts.length - 1];
    if (!NAME_RE.test(basename)) {
        throw new Error('工作流名称不合法：不能含路径符 / \\ : * ? " < > | 或控制字符');
    }
    const fullPath = path.resolve(workflowDir(), ...parts);
    const rootPath = path.resolve(workflowDir());
    const rel = path.relative(rootPath, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error("工作流名称不合法：路径穿越");
    }
    return fullPath;
}

function isBuiltin(name: string): boolean {
    if (BUNDLED_WORKFLOWS.includes(name)) return true;
    const basename = path.basename(name);
    return !name.includes("/") && [
        "Z-Image.json", "Z-Image-Enhance.json", "2511.json",
        "klein-enhance.json", "Flux2-Klein.json", "upscale.json",
    ].includes(basename);
}

export class WorkflowStore {
    constructor(private readonly db: BackendDatabase) {}

    private async ensureBundledWorkflows() {
        await fs.mkdir(workflowDir(), { recursive: true, mode: 0o700 });
        for (const name of BUNDLED_WORKFLOWS) {
            const target = path.join(workflowDir(), name);
            try { await fs.access(target); continue; } catch { /* install missing bundled workflow */ }
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await fs.copyFile(path.join(bundledWorkflowDir(), name), target);
        }
    }

    async list(): Promise<WorkflowListItem[]> {
        await this.ensureBundledWorkflows();
        const dir = workflowDir();
        try { await fs.access(dir); } catch { return []; }
        const items: WorkflowListItem[] = [];
        const seen = new Set<string>();

        // 扫描根目录（内置工作流）
        try {
            const rootFiles = await fs.readdir(dir);
            for (const fn of rootFiles) {
                if (!fn.endsWith(".json") || fn.endsWith(".config.json")) continue;
                const name = fn;
                const config = this.getConfig(name);
                items.push({
                    name,
                    title: config?.title || fn.replace(".json", ""),
                    builtin: true,
                    fieldCount: config?.fields?.length ?? 0,
                });
                seen.add(fn);
            }
        } catch { /* ignore */ }

        // 扫描 custom 子目录（用户上传）
        const customDir = path.join(dir, CUSTOM_SUBDIR);
        try {
            const files = await fs.readdir(customDir);
            for (const fn of files) {
                if (!fn.endsWith(".json") || fn.endsWith(".config.json")) continue;
                if (seen.has(fn)) continue;
                const name = `${CUSTOM_SUBDIR}/${fn}`;
                const config = this.getConfig(name);
                items.push({
                    name,
                    title: config?.title || fn.replace(".json", ""),
                    builtin: isBuiltin(name),
                    fieldCount: config?.fields?.length ?? 0,
                });
            }
        } catch { /* custom dir may not exist */ }
        items.sort((a, b) => a.title.localeCompare(b.title));
        return items;
    }

    async get(name: string): Promise<WorkflowDetail> {
        await this.ensureBundledWorkflows();
        const filePath = workflowFilePath(name);
        let workflow: Record<string, unknown>;
        try {
            workflow = JSON.parse(await fs.readFile(filePath, "utf8"));
        } catch {
            throw new Error("Workflow not found");
        }
        const config = this.getConfig(name) ?? {
            title: name.split('/').pop()!.replace(/\.json$/, ""),
            backend: "",
            operation: "",
            description: "",
            fields: [],
        };
        return { name, workflow, config, builtin: isBuiltin(name) };
    }

    async upload(name: string, workflow: Record<string, unknown>): Promise<{ name: string }> {
        const cleanName = path.basename(name.trim());
        const finalName = cleanName.endsWith(".json") ? cleanName : `${cleanName}.json`;
        if (!NAME_RE.test(finalName)) {
            throw new Error('工作流名称不合法：不能含路径符 / \\ : * ? " < > | 或控制字符');
        }
        if (typeof workflow !== "object" || workflow === null || Object.keys(workflow).length === 0) {
            throw new Error("工作流 JSON 为空");
        }
        const sample = Object.values(workflow)[0];
        if (typeof sample !== "object" || sample === null || !("class_type" in sample)) {
            throw new Error("不是有效的 ComfyUI API 工作流 JSON（需包含 class_type）");
        }
        const storedName = `${CUSTOM_SUBDIR}/${finalName}`;
        const dir = path.join(workflowDir(), CUSTOM_SUBDIR);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.writeFile(workflowFilePath(storedName), JSON.stringify(workflow, null, 2), "utf8");
        return { name: storedName };
    }

    async exportPackage(name: string): Promise<WorkflowPackage> {
        const detail = await this.get(name);
        return {
            format: "infinite-canvas-workflow",
            version: 1,
            name: detail.name,
            workflow: detail.workflow,
            config: detail.config,
        };
    }

    async importPackage(fallbackName: string, value: unknown): Promise<{ name: string }> {
        if (!value || typeof value !== "object") throw new Error("工作流包格式不正确");
        const pkg = value as Partial<WorkflowPackage>;
        if (pkg.format !== "infinite-canvas-workflow") throw new Error("不是无限画布工作流包");
        if (pkg.version !== 1) throw new Error(`不支持的工作流包版本：${String(pkg.version)}`);
        if (!pkg.config || typeof pkg.config !== "object"
            || typeof pkg.config.title !== "string"
            || typeof pkg.config.backend !== "string"
            || typeof pkg.config.operation !== "string"
            || typeof pkg.config.description !== "string"
            || !Array.isArray(pkg.config.fields)) {
            throw new Error("工作流包缺少有效的字段配置");
        }
        const result = await this.upload(typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : fallbackName, pkg.workflow as Record<string, unknown>);
        await this.saveConfig(result.name, pkg.config);
        return result;
    }

    async saveConfig(name: string, config: WorkflowConfig): Promise<{ config: WorkflowConfig }> {
        const filePath = workflowFilePath(name);
        try { await fs.access(filePath); } catch { throw new Error("Workflow not found"); }
        this.db.upsertWorkflowConfig(name, {
            title: config.title,
            backend: config.backend,
            operation: config.operation,
            description: config.description,
            fieldsJson: JSON.stringify(config.fields),
            mediaInputsJson: JSON.stringify(config.mediaInputs ?? {}),
            miniCardsJson: JSON.stringify(config.miniCards ?? {}),
        });
        return { config };
    }

    async saveWorkflow(name: string, workflow: Record<string, unknown>): Promise<{ workflow: Record<string, unknown> }> {
        const filePath = workflowFilePath(name);
        try { await fs.access(filePath); } catch { throw new Error("Workflow not found"); }
        if (!workflow || typeof workflow !== "object" || Object.keys(workflow).length === 0) throw new Error("工作流不能为空");
        await fs.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");
        return { workflow };
    }

    getConfig(name: string): WorkflowConfig | null {
        const row = this.db.getWorkflowConfig(name);
        if (!row) return BUILTIN_CONFIGS[name] ? structuredClone(BUILTIN_CONFIGS[name]) : null;
        try {
            const config: WorkflowConfig = {
                title: row.title,
                backend: row.backend,
                operation: row.operation,
                description: row.description,
                fields: JSON.parse(row.fieldsJson) as WorkflowField[],
                mediaInputs: JSON.parse(row.mediaInputsJson),
                miniCards: JSON.parse(row.miniCardsJson),
            };
            if (name === "custom/视频修复FlashVSR1.1.json") {
                config.fields = config.fields.map((field) => field.node === "10" && field.input === "video" ? { ...field, type: "video", required: true } : field);
            }
            return config;
        } catch { return null; }
    }

    async delete(name: string): Promise<{ ok: true }> {
        const filePath = workflowFilePath(name);
        try { await fs.access(filePath); } catch { throw new Error("Workflow not found"); }
        await fs.unlink(filePath);
        this.db.deleteWorkflowConfig(name);
        return { ok: true };
    }

    /** 仅重命名显示标题（title），不动文件名与 config 其他字段 */
    async renameTitle(name: string, title: string): Promise<{ name: string; title: string }> {
        const filePath = workflowFilePath(name);
        try { await fs.access(filePath); } catch { throw new Error("Workflow not found"); }
        const existing = this.getConfig(name);
        const config: WorkflowConfig = existing ?? {
            title: name.split('/').pop()!.replace(/\.json$/, ""),
            backend: "",
            operation: "",
            description: "",
            fields: [],
        };
        config.title = title;
        this.db.upsertWorkflowConfig(name, {
            title: config.title,
            backend: config.backend,
            operation: config.operation,
            description: config.description,
            fieldsJson: JSON.stringify(config.fields),
            mediaInputsJson: JSON.stringify(config.mediaInputs ?? {}),
            miniCardsJson: JSON.stringify(config.miniCards ?? {}),
        });
        return { name, title: config.title };
    }

    /** 扫描工作流中所有媒体输入引用 */
    scanMediaInputs(workflow: Record<string, unknown>): string[] {
        const required: string[] = [];
        for (const nodeId of Object.keys(workflow)) {
            const node = workflow[nodeId];
            if (typeof node !== "object" || node === null) continue;
            const inputs = (node as any).inputs;
            if (typeof inputs !== "object" || inputs === null) continue;
            for (const [inputName, value] of Object.entries(inputs)) {
                if (this.isMediaValue(inputName, value)) {
                    required.push(String(value));
                }
            }
        }
        return [...new Set(required)];
    }

    private isMediaValue(inputName: string, value: unknown): boolean {
        if (typeof value !== "string" || !value.trim()) return false;
        const key = inputName.toLowerCase();
        if (MEDIA_INPUT_KEYS.some((token) => key.includes(token))) return true;
        return MEDIA_EXT_RE.test(value);
    }

    getWorkflowPath(name: string): string {
        return workflowFilePath(name);
    }

    /**
     * 查询 ComfyUI 获取当前 workflow 中各节点 COMBO 输入的选项列表。
     * 返回 { node_id: { input_name: [choice, ...] } }；ComfyUI 不可达时返回空对象。
     */
    async getComboOptions(name: string, bridge: ComfyUiBackend, signal?: AbortSignal): Promise<Record<string, Record<string, string[]>>> {
        let workflow: Record<string, unknown>;
        try {
            workflow = JSON.parse(await fs.readFile(workflowFilePath(name), "utf8"));
        } catch { return {}; }

        const classTypes = new Map<string, string>();
        for (const [nodeId, rawNode] of Object.entries(workflow)) {
            const node = typeof rawNode === "object" && rawNode !== null ? (rawNode as Record<string, unknown>) : {};
            const classType = typeof node.class_type === "string" ? node.class_type : "";
            if (classType) classTypes.set(nodeId, classType);
        }

        const options: Record<string, Record<string, string[]>> = {};
        const uniqueClassTypes = [...new Set(classTypes.values())];
        const classOptionsMap = new Map<string, Record<string, string[]>>();
        await Promise.all(
            uniqueClassTypes.map(async (classType) => {
                const opts = await bridge.getNodeComboOptions(classType, signal);
                if (Object.keys(opts).length > 0) classOptionsMap.set(classType, opts);
            }),
        );

        for (const [nodeId, classType] of classTypes) {
            const nodeOptions = classOptionsMap.get(classType);
            if (nodeOptions && Object.keys(nodeOptions).length > 0) options[nodeId] = nodeOptions;
        }
        return options;
    }
}
