import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type H3ContinuationIdentity = { workflow: string; group: string; run: string };

/** Match NanFeng V15's json.dumps([...], ensure_ascii=False) namespace exactly. */
export function h3ContinuationFolder(identity: H3ContinuationIdentity) {
    for (const value of [identity.workflow, identity.group, identity.run]) {
        if (!value || value.length > 256) throw new Error("无效的 H3 潜空间续写身份");
    }
    const encoded = `[${[identity.workflow, "nf_v15", identity.group, identity.run].map((value) => JSON.stringify(value)).join(", ")}]`;
    return path.join("nanfeng_v15_context", createHash("sha256").update(encoded).digest("hex"));
}

/** Seed a NEW run with the completed predecessor's AV latent; never write to the source run. */
export async function stageH3ContinuationSeed(rootDir: string, source: H3ContinuationIdentity, target: H3ContinuationIdentity, previousIndex: number) {
    if (!Number.isInteger(previousIndex) || previousIndex < 1 || previousIndex > 9998) throw new Error("无效的 H3 续写段号");
    if (source.workflow !== target.workflow || source.group !== target.group || source.run === target.run) throw new Error("H3 续写来源与新任务不匹配");
    const name = `clip_${String(previousIndex).padStart(5, "0")}.safetensors`;
    const output = path.join(rootDir, "output");
    const sourcePath = path.join(output, h3ContinuationFolder(source), name);
    const targetDir = path.join(output, h3ContinuationFolder(target));
    const targetPath = path.join(targetDir, name);
    await inspectLatent(sourcePath);
    await mkdir(targetDir, { recursive: true });
    if (await exists(targetPath)) {
        if (await sameFileContent(sourcePath, targetPath)) return targetPath;
        throw new Error("H3 新任务的潜变量种子已存在但与来源不同，拒绝覆盖");
    }
    const temporary = path.join(targetDir, `${name}.${randomUUID()}.tmp`);
    try {
        await copyFile(sourcePath, temporary);
        if (!await sameFileContent(sourcePath, temporary)) throw new Error("H3 潜变量复制校验失败");
        await rename(temporary, targetPath);
        return targetPath;
    } finally {
        await unlink(temporary).catch(() => undefined);
    }
}

async function inspectLatent(file: string) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size < 32) throw new Error("上一段 H3 AV 潜变量不存在或不完整，请从组首重新运行");
    const handle = await open(file, "r");
    try {
        const prefix = Buffer.alloc(8);
        if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error("H3 潜变量文件头不完整");
        const headerLength = Number(prefix.readBigUInt64LE());
        if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > Math.min(info.size - 8, 1024 * 1024)) throw new Error("H3 潜变量文件头无效");
        const header = Buffer.alloc(headerLength);
        if ((await handle.read(header, 0, headerLength, 8)).bytesRead !== headerLength) throw new Error("H3 潜变量文件头不完整");
        const parsed = JSON.parse(header.toString("utf8")) as Record<string, any>;
        if (parsed.__metadata__?.format !== "h3_motion_context_av_v1" || !Array.isArray(parsed.video?.shape) || !Array.isArray(parsed.audio?.shape)) {
            throw new Error("来源文件不是完整的 H3 画面与音频潜变量");
        }
        const videoEnd = Number(parsed.video?.data_offsets?.[1]);
        const audioEnd = Number(parsed.audio?.data_offsets?.[1]);
        if (!Number.isSafeInteger(videoEnd) || !Number.isSafeInteger(audioEnd) || Math.max(videoEnd, audioEnd) !== info.size - 8 - headerLength) {
            throw new Error("H3 潜变量数据长度不完整");
        }
    } finally {
        await handle.close();
    }
}

async function exists(file: string) { return Boolean(await stat(file).catch(() => null)); }

async function sameFileContent(left: string, right: string) {
    await inspectLatent(right);
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    if (leftStat.size !== rightStat.size) return false;
    const hash = async (file: string) => {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(file)) digest.update(chunk);
        return digest.digest("hex");
    };
    const [a, b] = await Promise.all([hash(left), hash(right)]);
    return a === b;
}
