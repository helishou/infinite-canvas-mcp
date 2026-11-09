import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findH3ContinuationLatent, h3ContinuationFolder, normalizeH3ContinuationSlot, stageH3ContinuationSeed } from "./continuation-seed.js";

const workflow = "JQrB0Mx2q0_XOfOY6ufm4";
const group = "phoebe-date-pov-60s:S01";

function latent(bytes: string) {
    const data = Buffer.from(bytes);
    const header = Buffer.from(JSON.stringify({
        __metadata__: { format: "h3_motion_context_av_v1" },
        audio: { dtype: "F32", shape: [1, 1], data_offsets: [0, 2] },
        video: { dtype: "F32", shape: [1, 1], data_offsets: [2, data.length] },
    }));
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    return Buffer.concat([length, header, data]);
}

test("续写目录与 V15 json.dumps 命名空间一致", () => {
    // 必须是正斜杠字面量：这个字符串会当 latent_path/folder 交给南风 V15 的
    // NanFengV15CommitContinuation，它用 re.fullmatch(r"nanfeng_v15_context/[0-9a-f]{64}", folder)
    // 校验，Windows 的 path.join 反斜杠形式会被直接拒绝。
    assert.equal(h3ContinuationFolder({ workflow, group, run: "d9cb803c-5cac-458b-a793-91449249f9c9" }),
        "nanfeng_v15_context/46d69df1ec6e86b9f5aac04a64864c7a691f80c8a9498e90ec603056b444d333");
});

test("仅复制已完成上一段潜变量到新任务目录，重放幂等且不覆盖来源", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-resume-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = { workflow, group, run: "prior-task" };
    const target = { workflow, group, run: "new-task" };
    const sourceDir = path.join(root, "output", h3ContinuationFolder(source));
    await mkdir(sourceDir, { recursive: true });
    const content = latent("audio-and-video-payload");
    const sourceFile = path.join(sourceDir, "clip_00002.safetensors");
    await writeFile(sourceFile, content);
    const staged = await stageH3ContinuationSeed(root, source, target, 2);
    assert.deepEqual(await readFile(staged), content);
    assert.deepEqual(await readFile(sourceFile), content);
    assert.equal(await stageH3ContinuationSeed(root, source, target, 2), staged);
    await writeFile(staged, latent("different-complete-payload"));
    await assert.rejects(stageH3ContinuationSeed(root, source, target, 2), /拒绝覆盖/);
    assert.deepEqual(await readFile(sourceFile), content);
});

test("缺失或截断的来源潜变量在提交前拒绝", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-resume-missing-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = { workflow, group, run: "prior-task" };
    const target = { workflow, group, run: "new-task" };
    await assert.rejects(stageH3ContinuationSeed(root, source, target, 2), /不存在或不完整/);
    const sourceDir = path.join(root, "output", h3ContinuationFolder(source));
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "clip_00002.safetensors"), Buffer.from("partial"));
    await assert.rejects(stageH3ContinuationSeed(root, source, target, 2), /不存在或不完整/);
});

test("来源槽位探测只认完整的 clip_00001，返回正斜杠相对路径", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-find-latent-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const folder = h3ContinuationFolder({ workflow, group, run: "prior-task" });
    assert.equal(await findH3ContinuationLatent(root, folder), null);
    const dir = path.join(root, "output", folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "clip_00002.safetensors"), latent("wrong-slot"));
    assert.equal(await findH3ContinuationLatent(root, folder), null, "2 号槽不是通用路径的输出约定");
    await writeFile(path.join(dir, "clip_00001.safetensors"), Buffer.from("partial"));
    assert.equal(await findH3ContinuationLatent(root, folder), null);
    await writeFile(path.join(dir, "clip_00001.safetensors"), latent("complete-av"));
    assert.equal(await findH3ContinuationLatent(root, folder), `${folder}/clip_00001.safetensors`);
});

test("V15 二槽输出归一到 clip_00001，校验失败不落半成品", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "h3-normalize-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const folder = h3ContinuationFolder({ workflow, group, run: "v15-run" });
    const dir = path.join(root, "output", folder);
    await mkdir(dir, { recursive: true });
    await assert.rejects(normalizeH3ContinuationSlot(root, folder), /不存在或不完整/);
    const seed = latent("staged-seed");
    const output = latent("run-output-av");
    await writeFile(path.join(dir, "clip_00001.safetensors"), seed);
    await writeFile(path.join(dir, "clip_00002.safetensors"), output);
    await normalizeH3ContinuationSlot(root, folder);
    assert.deepEqual(await readFile(path.join(dir, "clip_00001.safetensors")), output);
    assert.deepEqual(await readFile(path.join(dir, "clip_00002.safetensors")), output, "归一不删 2 号槽原件");
});
