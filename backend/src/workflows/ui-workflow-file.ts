/**
 * 在 ComfyUI 的 `user/default/workflows` 里找原始 UI 格式工作流。
 *
 * 为什么需要归一化：
 * 本地库（workflow_configs）里的名字和磁盘文件名未必完全一致，典型情况是多一个副本后缀——
 * 库名 `xxx.json`、磁盘上是 `xxx (1).json`（复制/重下过的文件）。严格同名匹配会扑空，
 * 结果上传到 RunningHub 时悄悄退回 API 格式，平台解析不出节点、编辑器里等于空的。
 *
 * 归一化只处理结尾后缀，不动中间文字，避免把「2.1 文生图」和「2.1 文生图-加速开关」认成同一个。
 */
import fs from "node:fs/promises";
import path from "node:path";

type Parsed = Record<string, unknown>;

/**
 * 去掉文件名里的派生后缀：
 * - `-api` / `_api`：本应用导入 RunningHub 工作流时会存成 `xxx-api.json`，
 *   而 ComfyUI 编辑器里的原件叫 `xxx.json`，不剥掉这个后缀就永远匹配不上（会退回 API 格式上传）；
 * - 副本后缀：`xxx (1)`、`xxx（2）`、`xxx - 副本`、`xxx_1`、`xxx-2`。
 *
 * 顺序很重要：`终极资产图 (1)-api` 要先剥 `-api`，才会露出结尾的 ` (1)`。
 */
export function normalizeWorkflowStem(fileName: string): string {
    return fileName
        .replace(/\.json$/i, "")
        .replace(/\s*[-_]api\s*$/i, "")
        .replace(/\s*[(（]\d+[)）]\s*$/u, "")
        .replace(/\s*-\s*副本(\s*[(（]\d+[)）])?\s*$/u, "")
        .replace(/\s*[_\-]\d+\s*$/, "")
        .trim()
        .toLowerCase();
}

function isUiWorkflow(value: unknown): value is Parsed {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { nodes?: unknown }).nodes);
}

async function readUiJson(file: string): Promise<Parsed | null> {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
        return isUiWorkflow(parsed) ? parsed : null;
    } catch {
        return null; // 坏文件跳过，继续找下一个
    }
}

type Candidate = { file: string; mtime: number };

async function collectJsonFiles(directory: string, accept: (fileName: string) => boolean): Promise<Candidate[]> {
    const found: Candidate[] = [];
    const walk = async (dir: string): Promise<void> => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const absolutePath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(absolutePath);
                continue;
            }
            if (!entry.isFile()) continue;
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith(".json") || lower.endsWith(".config.json")) continue;
            if (!accept(lower)) continue;
            try {
                found.push({ file: absolutePath, mtime: (await fs.stat(absolutePath)).mtimeMs });
            } catch {
                /* 读不到时间就跳过 */
            }
        }
    };
    await walk(directory);
    return found;
}

/**
 * 按工作流名字（可以是 `custom/xxx.json` 这种带目录的）在 workflows 目录里找 UI 原件。
 * 先精确同名，再忽略副本后缀重比一遍；多个候选取最近修改的（副本里通常最新那份是完整版）。
 */
export async function findUiWorkflowFile(directory: string, name: string): Promise<Parsed | null> {
    const base = (name.split("/").pop() || name).toLowerCase();
    const targetBase = base.endsWith(".json") ? base : `${base}.json`;
    const targetStem = normalizeWorkflowStem(base);

    const exact = await collectJsonFiles(directory, (fileName) => fileName === targetBase);
    exact.sort((left, right) => right.mtime - left.mtime);
    for (const hit of exact) {
        const parsed = await readUiJson(hit.file);
        if (parsed) return parsed;
    }

    const fuzzy = await collectJsonFiles(directory, (fileName) => normalizeWorkflowStem(fileName) === targetStem);
    fuzzy.sort((left, right) => right.mtime - left.mtime);
    for (const hit of fuzzy) {
        const parsed = await readUiJson(hit.file);
        if (parsed) return parsed;
    }
    return null;
}
