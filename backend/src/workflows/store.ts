import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { BackendDatabase } from "../db.js";
import type { WorkflowConfig, WorkflowField } from "../db.js";

const CUSTOM_SUBDIR = "custom";
const NAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fff.\-]+\.json$/;
const MEDIA_INPUT_KEYS = ["image", "video", "audio", "mask", "filename", "file"];
const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|aac|ogg|flac)(?:\?|$)/i;

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

function workflowDir(): string {
    return path.join(DATA_DIR, "workflows");
}

function workflowFilePath(name: string): string {
    // 允许 "custom/filename.json" 格式，但 basename 必须匹配 NAME_RE
    const parts = name.split('/');
    const basename = parts[parts.length - 1];
    if (!NAME_RE.test(basename)) {
        throw new Error("工作流名称不合法，请使用中文/英文/数字/_-.");
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
    const basename = path.basename(name);
    return !name.includes("/") && [
        "Z-Image.json", "Z-Image-Enhance.json", "2511.json",
        "klein-enhance.json", "Flux2-Klein.json", "upscale.json",
    ].includes(basename);
}

export class WorkflowStore {
    constructor(private readonly db: BackendDatabase) {}

    async list(): Promise<WorkflowListItem[]> {
        const dir = workflowDir();
        try { await fs.access(dir); } catch { return []; }
        const items: WorkflowListItem[] = [];
        const customDir = path.join(dir, CUSTOM_SUBDIR);
        try {
            const files = await fs.readdir(customDir);
            for (const fn of files) {
                if (!fn.endsWith(".json") || fn.endsWith(".config.json")) continue;
                const name = `${CUSTOM_SUBDIR}/${fn}`;
                const config = this.getConfig(name);
                items.push({
                    name,
                    title: config?.title || fn.replace(".json", ""),
                    builtin: false,
                    fieldCount: config?.fields?.length ?? 0,
                });
            }
        } catch { /* custom dir may not exist */ }
        items.sort((a, b) => a.title.localeCompare(b.title));
        return items;
    }

    async get(name: string): Promise<WorkflowDetail> {
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
            throw new Error("工作流名称不合法，请使用中文/英文/数字/_-.");
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

    getConfig(name: string): WorkflowConfig | null {
        const row = this.db.getWorkflowConfig(name);
        if (!row) return null;
        try {
            return {
                title: row.title,
                backend: row.backend,
                operation: row.operation,
                description: row.description,
                fields: JSON.parse(row.fieldsJson) as WorkflowField[],
                mediaInputs: JSON.parse(row.mediaInputsJson),
                miniCards: JSON.parse(row.miniCardsJson),
            };
        } catch { return null; }
    }

    async delete(name: string): Promise<{ ok: true }> {
        if (isBuiltin(name)) throw new Error("内置工作流不可删除");
        const filePath = workflowFilePath(name);
        try { await fs.access(filePath); } catch { throw new Error("Workflow not found"); }
        await fs.unlink(filePath);
        this.db.deleteWorkflowConfig(name);
        return { ok: true };
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
}
