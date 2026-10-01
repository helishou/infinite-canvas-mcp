import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { MAX_IMPORT_BYTES } from "./import-local-image.js";
import { DATA_DIR } from "../config.js";

/** A single source root; no arbitrary filesystem access and no new UI configuration fields. */
export function preparedH3SourceRoot() {
    return path.resolve(process.env.INFINITE_CANVAS_PREPARED_UPDATES_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "hermes", "cache", "scratch"));
}
function contained(root: string, target: string) {
    const relative = path.relative(root, target);
    return !!relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
function sha(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }

/** Immutable Backend-owned preparation artifacts, not a second Canvas persistence path. */
export class PreparedH3UpdateFiles {
    constructor(readonly sourceRoot = preparedH3SourceRoot(), readonly archiveRoot = path.join(DATA_DIR, "mcp-prepared-h3-updates")) {}

    async readSource(filePath: string, fileSha256: string) {
        if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("修改文件必须使用绝对路径");
        if (path.extname(filePath).toLowerCase() !== ".json") throw new Error("修改文件必须是 JSON (.json)");
        if (!/^[a-f0-9]{64}$/.test(fileSha256)) throw new Error("fileSha256 必须为小写 SHA-256 十六进制摘要");
        const root = await realpath(this.sourceRoot), resolved = await realpath(filePath);
        if (!contained(root, resolved)) throw new Error("修改文件超出允许的准备目录范围");
        const data = await this.readCheckedFile(filePath, root);
        if (sha(data) !== fileSha256) throw new Error("修改文件 SHA-256 摘要不符，文件可能已变化");
        return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)), sha256: fileSha256, bytes: data.length };
    }

    private async readCheckedFile(filePath: string, root: string) {
        const resolved = await realpath(filePath);
        if (!contained(root, resolved)) throw new Error("文件超出允许目录范围");
        const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.size === 0) throw new Error("准备稿不是非空普通文件");
            // Same 32 MiB ceiling as the existing Backend local-file import; no new media/upload limits.
            if (before.size > MAX_IMPORT_BYTES) throw new Error("准备稿超过现有本地文件导入上限");
            const data = await handle.readFile(), after = await handle.stat();
            const finalPath = await realpath(filePath);
            if (finalPath !== resolved || !contained(root, finalPath) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || data.length !== after.size || data.length > MAX_IMPORT_BYTES) throw new Error("准备稿读取期间发生变化");
            return data;
        } finally { await handle.close(); }
    }

    private async archive() {
        await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
        return realpath(this.archiveRoot);
    }

    async save(plan: Record<string, unknown>) {
        const root = await this.archive(), uuid = randomUUID(), data = Buffer.from(JSON.stringify(plan));
        if (data.length > MAX_IMPORT_BYTES) throw new Error("冻结方案超过现有本地文件导入上限");
        const file = path.join(root, uuid + ".json");
        const handle = await open(file, "wx", 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        return `h3-plan:${uuid}:${sha(data)}`;
    }

    private parse(id: string) {
        const match = /^h3-plan:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([a-f0-9]{64})$/.exec(id);
        if (!match) throw new Error("preparedId 格式无效");
        return { uuid: match[1], digest: match[2] };
    }

    async read(id: string): Promise<Record<string, unknown>> {
        const { uuid, digest } = this.parse(id), root = await this.archive();
        const data = await this.readCheckedFile(path.join(root, uuid + ".json"), root);
        if (sha(data) !== digest) throw new Error("冻结方案 SHA-256 摘要不符，不允许提交");
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    }

    async discard(id: string) {
        const { uuid } = this.parse(id), root = await this.archive();
        try { await unlink(path.join(root, uuid + ".json")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
}
