import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { h3ContinuationFolder, stageH3ContinuationSeed } from "./continuation-seed.js";

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
    assert.equal(h3ContinuationFolder({ workflow, group, run: "d9cb803c-5cac-458b-a793-91449249f9c9" }),
        path.join("nanfeng_v15_context", "46d69df1ec6e86b9f5aac04a64864c7a691f80c8a9498e90ec603056b444d333"));
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
