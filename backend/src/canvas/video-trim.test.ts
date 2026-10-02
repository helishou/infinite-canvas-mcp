import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Set media roots before importing config consumers; never write test output to user storage.
const testRoot = await mkdtemp(path.join(os.tmpdir(), "canvas-trim-storage-"));
process.env.INFINITE_CANVAS_DATA_DIR = testRoot;
process.env.INFINITE_CANVAS_MEDIA_DIR = path.join(testRoot, "media");
after(() => rm(testRoot, { recursive: true, force: true }));
const { BackendDatabase } = await import("../db.js");
const { createStores } = await import("../stores/index.js");
const { VideoConcatBackend } = await import("../runtime/video-concat.js");
const { CanvasVideoDispatcher, CANVAS_VIDEO_TRIM_MODEL } = await import("./video-dispatcher.js");
const { prepareCanvasVideoTrimTarget } = await import("./generation-target.js");

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");

async function fixture(t: TestContext, audio = false) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-trim-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sourceFile = path.join(directory, "source.mp4");
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30",
        ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []), "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac"] : []), sourceFile]);
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    const stored = stores.media.store(await readFile(sourceFile), { name: "source.mp4", mimeType: "video/mp4", width: 160, height: 90, durationMs: 4000 });
    db.createCanvasProject({ id: "p", nodes: [{ id: "source", type: "video", position: { x: 0, y: 0 }, width: 340, height: 190,
        metadata: { content: stores.media.url(stored), storageKey: stored.storageKey, status: "success" } }], connections: [] });
    const backend = new VideoConcatBackend(stores.tasks, ffmpeg, undefined, stores.media);
    const dispatcher = new CanvasVideoDispatcher(stores, {} as never, {} as never, {} as never, backend);
    const input = { projectId: "p", model: CANVAS_VIDEO_TRIM_MODEL, prompt: "裁剪片段", videoReferences: [{ storageKey: stored.storageKey }], params: { start: 0.5, end: 2.5 }, clientTaskId: "trim-parent" };
    const node = (id: string) => (db.getCanvasProject("p")!.nodes as Array<Record<string, any>>).find((node) => node.id === id);
    return { directory, db, stores, backend, dispatcher, input, node, original: await stores.media.read(stored.storageKey) };
}

async function settle(stores: ReturnType<typeof createStores>, id: string) {
    while (["queued", "running"].includes(stores.tasks.get(id)!.status)) await new Promise((resolve) => setTimeout(resolve, 20));
    return stores.tasks.get(id)!;
}

test("真实 FFmpeg 裁剪有声与无声视频：幂等父子任务、独立节点、音轨、归档和原素材保护", { timeout: 30000 }, async (t) => {
    for (const audio of [true, false]) {
        const f = await fixture(t, audio);
        const source = structuredClone(f.node("source"));
        f.dispatcher.start(f.input);
        f.dispatcher.start(f.input);
        assert.equal(f.stores.tasks.list({ kind: "canvas-video" }).length, 1);
        const result = await settle(f.stores, "trim-parent");
        assert.equal(result.status, "succeeded", result.error || "");
        const media = (result.result!.media as any[])[0];
        const output = f.node(result.nodeId!);
        assert.ok(output);
        assert.equal(output.metadata.storageKey, media.storageKey);
        assert.equal(output.metadata.durationMs, 2000);
        assert.equal(output.metadata.generationTaskId, result.id);
        assert.equal(output.metadata.status, "success");
        assert.ok(f.stores.media.meta(media.storageKey));
        assert.equal(f.stores.tasks.get("video-trim-child-trim-parent")!.params.parentTaskId, result.id);
        assert.deepEqual(f.node("source"), source);
        assert.deepEqual(await f.stores.media.read(f.input.videoReferences[0].storageKey), f.original);
        const outputFile = path.join(f.directory, "trim.mp4");
        await writeFile(outputFile, await f.stores.media.read(media.storageKey));
        const { stdout } = await exec(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputFile]);
        const probe = JSON.parse(stdout);
        assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.1);
        assert.equal(probe.streams.some((stream: any) => stream.codec_type === "audio"), audio);
        assert.equal(probe.streams.find((stream: any) => stream.codec_type === "video").width, 160);
        f.dispatcher.start(f.input);
        assert.equal(f.stores.tasks.list({ kind: "canvas-video" }).length, 1);
        assert.throws(() => f.dispatcher.start({ ...f.input, params: { start: 1, end: 2 } }), /不同输入/);
    }
});

test("无效范围不建任务；超出真实时长只写失败结果节点", { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    for (const params of [{ start: -1, end: 2 }, { start: 2, end: 2 }, { start: 3, end: 2 }, { start: NaN, end: 2 }, { start: 0, end: Infinity }, { start: 0, end: "2" }]) {
        assert.throws(() => f.dispatcher.start({ ...f.input, params }), /时间无效/);
    }
    assert.equal(f.stores.tasks.list().length, 0);
    f.dispatcher.start({ ...f.input, params: { start: 0, end: 5 } });
    const result = await settle(f.stores, "trim-parent");
    assert.equal(result.status, "failed");
    assert.match(result.error!, /超出/);
    assert.equal(f.node(result.nodeId!)!.metadata.status, "error");
    assert.equal(f.node("source")!.metadata.status, "success");
});

test("准备阶段取消不能复活裁剪、归档输出或改写原视频", { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    let release!: (value: Buffer) => void;
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => { reading = resolve; });
    t.mock.method(f.stores.media, "read", () => { reading(); return new Promise<Buffer>((resolve) => { release = resolve; }); });
    f.dispatcher.start(f.input);
    await entered;
    const result = f.dispatcher.cancel("trim-parent");
    release(f.original);
    await settle(f.stores, "video-trim-child-trim-parent");
    // Let the parent's existing 500ms child-task observer finish before closing its database.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(f.stores.tasks.get(result.id)!.status, "cancelled");
    assert.equal(f.stores.tasks.get("video-trim-child-trim-parent")!.status, "cancelled");
    assert.equal(f.node(result.nodeId!)!.metadata.status, "cancelled");
    assert.equal(f.stores.media.list().length, 1);
});

test("重启恢复复用原裁剪子任务与结果节点，不再次执行 FFmpeg", { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    await f.backend.trim(f.input.videoReferences[0].storageKey, 0.5, 2.5, "video-trim-child-trim-parent", "trim-parent");
    assert.equal((await settle(f.stores, "video-trim-child-trim-parent")).status, "succeeded");
    const prepared = prepareCanvasVideoTrimTarget(f.stores, { ...f.input, mode: "video" }, "trim-parent");
    const task = f.stores.tasks.create("trim-parent", "canvas-video", prepared.command, {
        projectId: "p", nodeId: prepared.command.nodeId, executor: "trim", model: CANVAS_VIDEO_TRIM_MODEL, videoTargetSize: prepared.targetSize,
    });
    f.stores.projects.applyOperations("p", Number(prepared.project!.revision || 0), [
        ...prepared.createOperations,
        { type: "update_node", id: task.nodeId!, metadata: { runtimeTaskId: task.id, status: "loading" } },
    ], { runtimeWrite: true });
    const mediaCount = f.stores.media.list().length;
    t.mock.method(f.backend as any, "spawnFfmpeg", () => { throw new Error("恢复不应重跑 FFmpeg"); });
    f.dispatcher.resume(task);
    const result = await settle(f.stores, "trim-parent");
    assert.equal(result.status, "succeeded", result.error || "");
    assert.equal(f.stores.media.list().length, mediaCount);
    assert.equal(f.node(task.nodeId!)!.metadata.generationTaskId, task.id);
    assert.equal((f.db.getCanvasProject("p")!.nodes as any[]).filter((node) => node.type === "video").length, 2);
});
