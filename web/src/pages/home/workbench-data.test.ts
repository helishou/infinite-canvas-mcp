import assert from "node:assert/strict";
import test from "node:test";
import { CREATIVE_LAUNCH_LIMIT, CREATIVE_LAUNCH_STORAGE_KEY, collectOutputs, launchStatus, launchTextResults, nextCreativeLaunches, outputDisplayName, outputMedia, projectCover, pruneCreativeLaunches, readCreativeLaunches, resolveLaunchOutputs, retainProjectCovers, shortModelName, taskDestination, writeCreativeLaunches, type CreativeLaunch } from "./workbench-data";
import type { BackendGenerationLog } from "../../services/backend-api";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";

function generationLog(patch: Pick<BackendGenerationLog, "id"> & Partial<BackendGenerationLog>): BackendGenerationLog {
    return {
        projectId: "p", status: "success", platform: "test", references: [], inputCounts: {},
        startedAt: "", durationMs: 0, outputs: [], params: {}, createdAt: "", updatedAt: "",
        ...patch,
    };
}

test("recent results keep only completed media and do not misclassify text or unknown files", () => {
    assert.equal(outputMedia({ type: "text", content: "a paragraph" }), null);
    assert.equal(outputMedia({ storageKey: "file:unknown", url: "/report.pdf" }), null);
    assert.equal(outputMedia({ storageKey: "file:clip", mimeType: "video/mp4" })?.kind, "video");
    assert.equal(outputMedia({ localUrl: "https://host/clip.mp4?token=secret" })?.kind, "video");
    const logs = [
        { id: "old", status: "success", createdAt: "2026-01-01", outputs: [{ storageKey: "image:a" }] },
        {
            id: "new",
            status: "success",
            createdAt: "2026-02-01",
            outputs: [
                { type: "text", text: "hello" },
                { storageKey: "file:b", mimeType: "audio/wav" },
            ],
        },
        { id: "failed", status: "failed", createdAt: "2026-03-01", outputs: [{ storageKey: "image:c" }] },
    ].map((log) => generationLog({ ...log, status: log.status as BackendGenerationLog["status"] }));
    assert.deepEqual(
        collectOutputs(logs).map((x) => x.id),
        ["new:1", "old:0"],
    );
});

test("late log snapshots cannot replace a shown project cover, but a new project version can", () => {
    const cachedPortrait = { kind: "image", storageKey: "image:portrait" } as const;
    const lateLandscape = { kind: "image", storageKey: "image:landscape" } as const;
    const initial = retainProjectCovers({}, [{ key: "backend/project/v1", media: null }]);
    const shown = retainProjectCovers(initial, [{ key: "backend/project/v1", media: cachedPortrait }]);
    const late = retainProjectCovers(shown, [{ key: "backend/project/v1", media: lateLandscape }]);
    assert.equal(late, shown);
    assert.equal(late["backend/project/v1"], cachedPortrait);
    const changed = retainProjectCovers(late, [{ key: "backend/project/v2", media: lateLandscape }]);
    assert.equal(changed["backend/project/v2"], lateLandscape);
    assert.equal(retainProjectCovers(changed, [{ key: "another-backend/project/v1", media: lateLandscape }])["another-backend/project/v1"], lateLandscape);
});

test("project covers never borrow another project's output or use audio as an image", () => {
    const project = { id: "p", nodes: [], summary: { nodeCount: 5, connectionCount: 3 } } as unknown as CanvasProject;
    const outputs = collectOutputs([
        generationLog({ id: "1", projectId: "other", status: "success", createdAt: "2026-01-01", outputs: [{ storageKey: "image:other" }] }),
        generationLog({ id: "2", projectId: "p", status: "success", createdAt: "2026-01-02", outputs: [{ storageKey: "audio:voice" }] }),
    ]);
    assert.equal(projectCover(project, outputs), null);
    assert.deepEqual(projectCover(project, outputs, { id: "f", name: "Drama", createdAt: "", isDrama: true, coverStorageKey: "image:cover" }), { kind: "image", storageKey: "image:cover" });
});

test("task navigation preserves project ownership, including deleted projects", () => {
    const ids = new Set(["p/one"]);
    assert.equal(taskDestination({ id: "existing", status: "succeeded", progress: 1, projectId: "p/one" }, ids), "/canvas/p%2Fone");
    assert.equal(taskDestination({ id: "deleted", status: "succeeded", progress: 1, projectId: "deleted", input: { scope: "image" } }, ids), null);
    assert.equal(taskDestination({ id: "workbench", status: "succeeded", progress: 1, input: { scope: "video" } }, ids), "/?mode=video");
});

test("covers use the selected character image and never old image-mode results on a video node", () => {
    const project = { id: "p", nodes: [{ type: "character", metadata: { characterPrimaryIndex: 1, characterImages: [{ storageKey: "image:first" }, { storageKey: "image:selected" }] } }] } as unknown as CanvasProject;
    assert.equal(projectCover(project, [])?.storageKey, "image:selected");
    project.nodes = [{ type: "config", metadata: { smart: true, generationMode: "video", mimeType: "video/mp4", storageKey: "video:current", images: [{ id: "old", status: "success", content: "", storageKey: "image:old" }] } }] as CanvasProject["nodes"];
    assert.equal(projectCover(project, [])?.storageKey, "video:current");
});


test("retired ordinary folders cannot supply canvas previews, while canvas media stays available", () => {
    const project = { id: "p", nodes: [] } as unknown as CanvasProject;
    const oldFolder = { id: "f", name: "Retired folder", createdAt: "", coverStorageKey: "image:folder-cover" };
    assert.equal(projectCover(project, [], oldFolder), null);
    project.nodes = [{ type: "image", metadata: { images: [{ id: "own", status: "success", storageKey: "image:canvas" }] } }] as CanvasProject["nodes"];
    assert.equal(projectCover(project, [], oldFolder)?.storageKey, "image:canvas");
    assert.equal(oldFolder.coverStorageKey, "image:folder-cover", "legacy metadata remains untouched");
});

function launch(patch: Partial<CreativeLaunch> & Pick<CreativeLaunch, "taskId">): CreativeLaunch {
    return { projectId: `project-${patch.taskId}`, nodeId: "node", mode: "image", prompt: "a cat", model: "local-comfyui::2.1", createdAt: "2026-11-15T10:00:00.000Z", params: {}, ...patch };
}

function memoryStorage(initial?: string) {
    const map = new Map<string, string>();
    if (initial !== undefined) map.set(CREATIVE_LAUNCH_STORAGE_KEY, initial);
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
    };
}

test("launch feed keeps the newest submissions, dedupes retries and caps the list", () => {
    const base = launch({ taskId: "t1" });
    let list = nextCreativeLaunches([], base);
    list = nextCreativeLaunches(list, launch({ taskId: "t2" }));
    list = nextCreativeLaunches(list, { ...base, prompt: "updated" });
    assert.deepEqual(list.map(item => item.taskId), ["t1", "t2"]);
    assert.equal(list[0].prompt, "updated");
    for (let index = 0; index < CREATIVE_LAUNCH_LIMIT + 2; index++) list = nextCreativeLaunches(list, launch({ taskId: `extra-${index}` }));
    assert.equal(list.length, CREATIVE_LAUNCH_LIMIT);
    assert.equal(list[0].taskId, `extra-${CREATIVE_LAUNCH_LIMIT + 1}`);
});

test("launch feed persists across reloads but drops stale or corrupted entries", () => {
    const now = Date.parse("2026-11-15T12:00:00.000Z");
    const fresh = launch({ taskId: "fresh", createdAt: "2026-11-15T10:00:00.000Z" });
    const stale = launch({ taskId: "stale", createdAt: "2026-11-13T10:00:00.000Z" });
    assert.deepEqual(pruneCreativeLaunches([fresh, stale], now), [fresh]);
    assert.deepEqual(pruneCreativeLaunches([launch({ taskId: "bad-date", createdAt: "not-a-date" })], now), []);

    const storage = memoryStorage();
    writeCreativeLaunches(storage, [fresh, stale]);
    assert.deepEqual(readCreativeLaunches(storage, now), [fresh]);
    assert.deepEqual(readCreativeLaunches(memoryStorage("{corrupted"), now), []);
    assert.deepEqual(readCreativeLaunches(memoryStorage('{"taskId":"x"}'), now), []);
    const badMode = { ...fresh, taskId: "bad-mode", mode: "hologram" as CreativeLaunch["mode"] };
    assert.deepEqual(readCreativeLaunches(memoryStorage(JSON.stringify([fresh, { taskId: "" }, null, 42, badMode])), now), [fresh]);
    const many = Array.from({ length: CREATIVE_LAUNCH_LIMIT + 3 }, (_, index) => launch({ taskId: `many-${index}` }));
    writeCreativeLaunches(storage, many);
    assert.equal(readCreativeLaunches(storage, now).length, CREATIVE_LAUNCH_LIMIT);
    assert.deepEqual(readCreativeLaunches(undefined, now), []);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.deepEqual(readCreativeLaunches(throwing, now), []);
    writeCreativeLaunches(throwing, [fresh]);
});

test("launch status falls back to generation logs when the task left the recent list", () => {
    assert.equal(launchStatus({ id: "t", status: "running", progress: 0.4 }, []), "running");
    assert.equal(launchStatus(undefined, [generationLog({ id: "l", status: "success" })]), "succeeded");
    assert.equal(launchStatus(undefined, [generationLog({ id: "l", status: "failed" })]), "failed");
    assert.equal(launchStatus(undefined, [generationLog({ id: "l", status: "cancelled" })]), "cancelled");
    assert.equal(launchStatus(undefined, [generationLog({ id: "l", status: "running" })]), "queued");
    assert.equal(launchStatus(undefined, []), "queued");
});

test("canvas-free conversation launches persist and surface task media without a project", () => {
    const canvasFree: CreativeLaunch = { taskId: "conversation-1", mode: "image", prompt: "a cat", model: "local-comfyui::2.1", createdAt: "2026-11-16T05:00:00.000Z", params: {} };
    const storage = memoryStorage(JSON.stringify([canvasFree]));
    assert.deepEqual(readCreativeLaunches(storage, Date.parse(canvasFree.createdAt) + 1000).map(item => item.taskId), ["conversation-1"]);
    const task = {
        id: "conversation-1", status: "succeeded" as const, progress: 1,
        result: { media: [{ url: "/media/cat.png", storageKey: "image:cat", mimeType: "image/png", filename: "cat.png", bytes: 1, width: 1024, height: 1024, durationMs: null }] },
    };
    const outputs = resolveLaunchOutputs(task, [], canvasFree);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].kind, "image");
    assert.equal(outputs[0].log.projectId, "");
    // 新建画布补日志后，同一份媒体同时出现在日志与任务详情里，只保留一条。
    const log = generationLog({ id: "l", status: "success", createdAt: canvasFree.createdAt, outputs: [{ url: "/media/cat.png", storageKey: "image:cat", mimeType: "image/png" }] });
    assert.equal(resolveLaunchOutputs(task, [log], canvasFree).length, 1);
});

test("summary tasks expose media via top-level outputs when result.media was trimmed", () => {
    const canvasFree: CreativeLaunch = { taskId: "summary-1", mode: "image", prompt: "姿态图", model: "全能图片模型P", createdAt: "2026-11-17T16:50:00.000Z", params: {} };
    // 后端 ?summary=true：result 被裁成 null，媒体引用只留在顶层 outputs。
    const task = {
        id: "summary-1", status: "succeeded" as const, progress: 1, result: null,
        outputs: [{ url: "/media/image%3A28a1cf37", storageKey: "image:28a1cf37", mimeType: "image/png", bytes: 40544 }],
    } as never;
    const outputs = resolveLaunchOutputs(task, [], canvasFree);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].kind, "image");
    assert.equal(outputs[0].storageKey, "image:28a1cf37");
});

test("text results prefer the task payload and only read completed text outputs", () => {
    const task = { id: "t", status: "succeeded" as const, progress: 1, result: { texts: [{ content: "from task" }, { content: "  " }] } };
    const logs = [generationLog({ id: "l", status: "success", outputs: [{ mimeType: "text/plain", content: "from log" }, { mimeType: "image/png", storageKey: "image:x" }] })];
    assert.deepEqual(launchTextResults(task, logs), ["from task"]);
    assert.deepEqual(launchTextResults(undefined, logs), ["from log"]);
    assert.deepEqual(launchTextResults(undefined, [generationLog({ id: "l", status: "failed", outputs: [{ type: "text/plain", content: "partial" }] })]), []);
    assert.deepEqual(launchTextResults(undefined, []), []);
});

test("recent output titles use project, then prompt, then model without the channel prefix", () => {
    assert.equal(shortModelName("engine-local::全能图片模型P"), "全能图片模型P");
    assert.equal(shortModelName("engine-local::H3 展开流"), "H3 展开流");
    assert.equal(shortModelName("gpt-image-2"), "gpt-image-2");
    assert.equal(shortModelName(""), "");

    const log = { model: "engine-local::全能图片模型P", prompt: "文生图16:9，美女，失眠熊。" };
    assert.equal(outputDisplayName(log, "七绝山·蟒妻"), "七绝山·蟒妻", "有画布时用画布名");
    assert.equal(outputDisplayName(log), "文生图16:9，美女，失眠熊。", "会话级生成用提示词首行");
    assert.equal(outputDisplayName({ model: log.model }), "全能图片模型P", "无提示词时退到去前缀的模型名");
    assert.equal(outputDisplayName({}, undefined, "生成结果"), "生成结果");

    const longPrompt = " ".repeat(4) + "一只橘猫坐在窗台，午后逆光写实照片，毛发细节丰富，暖色调电影感人像风格，浅景深背景虚化，高清写实摄影";
    assert.equal(outputDisplayName({ prompt: longPrompt }), `${longPrompt.trim().slice(0, 24)}…`);
    assert.equal(outputDisplayName({ prompt: "subject_definitions:\n<Subject 1> 崇良" }), "<Subject 1> 崇良", "跳过结构化前缀行，取第一条有内容的行");
});
