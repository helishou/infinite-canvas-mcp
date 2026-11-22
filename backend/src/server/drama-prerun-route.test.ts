/**
 * 真端点集成测试：POST/GET /drama/episodes/:episodeId/prerun 从真实 canvas_nodes.metadata.segments[]
 * + media_files + 物理文件装配体检结果；并证明端点全程只读（不建任务、不写库）。
 */
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "../drama/production.js";
import { registerDramaPrerunRoutes } from "./drama-prerun-routes.js";

function binding(storageKey: string, label = "<Picture 1> 角色") {
    return { id: `b-${storageKey}`, label, storageKey, mediaType: "image", enabled: true, role: "identity" };
}

test("prerun 真端点：逐段绿/黄/红来自画布 H3 段与 media_files，且全程只读", async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prerun-route-"));
    const db = new BackendDatabase(path.join(root, "fixture.sqlite"));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

    db.upsertCanvasFolder({ id: "drama", name: "fixture", createdAt: new Date().toISOString(), isDrama: true });
    const imagePath = path.join(root, "hero.png");
    fs.writeFileSync(imagePath, "image-bytes");
    db.upsertMediaFile({ storageKey: "image:hero", filePath: imagePath, mimeType: "image/png",
        bytes: fs.statSync(imagePath).size, width: 512, height: 512, durationMs: null,
        createdAt: new Date().toISOString(), sha256: "hero-sha" });

    db.createCanvasProject({ id: "canvas", title: "fixture", connections: [], nodes: [{
        id: "h3-node", type: "minimax-h3:video", title: "Clip", position: { x: 0, y: 0 }, width: 300, height: 200,
        metadata: {
            productionOwnerKind: "episode", productionOwnerId: "ep",
            segments: [
                { id: "seg-ok", title: "正常段", prompt: "角色进门。<Picture 1>", duration: 5, referenceBindings: [binding("image:hero")] },
                { id: "seg-missing", title: "参考缺失", prompt: "角色进门。<Picture 1>", duration: 5, referenceBindings: [binding("image:missing")] },
                { id: "seg-bad-tag", title: "标签越界", prompt: "角色进门。<Picture 2>", duration: 5, referenceBindings: [binding("image:hero")] },
                { id: "seg-no-ref", title: "无参考图", prompt: "纯文本镜头。", duration: 5, referenceBindings: [] },
                { id: "seg-empty", title: "空提示词", prompt: "  ", duration: 5, referenceBindings: [binding("image:hero")] },
                { id: "seg-done", title: "已生成", prompt: "已生成段。<Picture 1>", duration: 5, resultStorageKey: "video:done", status: "success", referenceBindings: [binding("image:hero")] },
            ],
        },
    }] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "", canvasId: "canvas" });

    const before = {
        tasks: db.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number },
        media: db.db.prepare("SELECT COUNT(*) n FROM media_files").get() as { n: number },
        drafts: db.db.prepare("SELECT COUNT(*) n FROM episode_productions").get() as { n: number },
    };

    const service = new EpisodeProductionService(db, undefined, root);
    const app = express();
    app.use(express.json());
    registerDramaPrerunRoutes(app, service);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as any).port}/drama/episodes/ep/prerun`;

    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "engine-local::H3 展开流" }) });
    assert.equal(response.status, 200);
    const report = await response.json() as any;
    assert.equal(report.ok, false);
    assert.equal(report.total, 5, "已有成功结果的段按 skipCompleted 口径跳过");
    assert.equal(report.failed, 3);
    assert.equal(report.warnings, 1);
    assert.deepEqual(report.items.map((item: any) => item.segmentId), ["seg-ok", "seg-missing", "seg-bad-tag", "seg-no-ref", "seg-empty"]);
    assert.equal(report.items[0].status, "ok");
    assert.equal(report.items[1].status, "error");
    assert.ok(report.items[1].issues.some((issue: string) => issue.includes("媒体文件未入库")));
    assert.equal(report.items[2].status, "error");
    assert.ok(report.items[2].issues.some((issue: string) => issue.includes("没有对应的参考连线")));
    assert.equal(report.items[3].status, "warning");
    assert.ok(report.items[4].issues.some((issue: string) => issue.includes("提示词为空")));
    assert.match(report.items[0].spec || "", /engine-local::H3 展开流/);
    assert.ok(report.notes.some((note: string) => note.includes("跳过")));
    assert.ok(report.notes.some((note: string) => note.includes("1 段已有成功结果")));

    // GET 同一实现、同样只读。
    const get = await (await fetch(base)).json() as any;
    assert.equal(get.total, 5);
    assert.deepEqual(get.items.map((item: any) => item.status), report.items.map((item: any) => item.status));

    // 只读证明：任务数 / 媒体数 / 制作稿行数完全不变，画布段内容不变。
    assert.deepEqual(db.db.prepare("SELECT COUNT(*) n FROM tasks").get(), before.tasks);
    assert.deepEqual(db.db.prepare("SELECT COUNT(*) n FROM media_files").get(), before.media);
    assert.deepEqual(db.db.prepare("SELECT COUNT(*) n FROM episode_productions").get(), before.drafts);
    const segments = (db.getCanvasProject("canvas")!.nodes[0] as any).metadata.segments;
    assert.equal(segments[0].prompt, "角色进门。<Picture 1>");
    assert.equal(segments[3].referenceBindings.length, 0);
});

test("prerun 端点：未绑定画布的剧集返回结构化错误而非伪造报告", async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prerun-no-canvas-"));
    const db = new BackendDatabase(path.join(root, "fixture.sqlite"));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "fixture", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const service = new EpisodeProductionService(db, undefined, root);
    const app = express();
    app.use(express.json());
    registerDramaPrerunRoutes(app, service);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/drama/episodes/ep/prerun`, { method: "POST" });
    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.code, "PRERUN_CANVAS_MISSING");
});
