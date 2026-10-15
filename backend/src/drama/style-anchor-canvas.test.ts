import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";
import { promptHash } from "./director.js";
import { ensureProductionCanvas } from "./production-canvas.js";

function fixture(t: test.TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "style-anchor-canvas-"));
    const db = new BackendDatabase(join(dir, "production.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "测试剧目", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "第一集", revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "首集", synopsis: "梗概", fullPlot: "剧情", canvasId: "canvas" });
    // 共享画布只能由正式准备接口绑定，测试沿用同一入口。
    const sharedCanvasId = ensureProductionCanvas(db, "shared-assets", "drama").project.id;
    const filePath = join(dir, "style-mother.png");
    fs.writeFileSync(filePath, "style mother bytes");
    db.upsertMediaFile({ storageKey: "style-mother.png", filePath, mimeType: "image/png", bytes: fs.statSync(filePath).size, width: 1, height: 1, durationMs: null, createdAt: new Date().toISOString() });
    db.applyCanvasProjectOperations(sharedCanvasId, undefined, [{ type: "add_node", id: "STYLE_NODE", nodeType: "image", position: { x: 0, y: 0 }, metadata: { storageKey: "style-mother.png" } }]);
    const service = new EpisodeProductionService(db, undefined, dir);
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { db, service, filePath };
}

const anchorDirector = (nodeId: string) => ({ source: { style_anchor_node_id: nodeId } } as any);

test("a style anchor living on the drama shared asset canvas resolves for an episode", t => {
    const { service, filePath } = fixture(t);
    const resolved = service.canvasStyleAnchorInput("episode", anchorDirector("STYLE_NODE"));
    assert.equal(resolved?.nodeId, "STYLE_NODE");
    assert.equal(resolved?.storageKey, "style-mother.png");
    assert.equal(resolved?.filePath, filePath);
});

test("an anchor missing from both the episode and shared canvases is still rejected", t => {
    const { service } = fixture(t);
    assert.throws(() => service.canvasStyleAnchorInput("episode", anchorDirector("MISSING_NODE")), /风格锚点画布节点不存在/);
    assert.equal(service.canvasStyleAnchorInput("episode", anchorDirector("")), undefined);
});

test("compilation bindings accept the shared-canvas style anchor and keep rejecting other cross-canvas nodes", t => {
    const { service, filePath } = fixture(t);
    const styleReference = { label: "风格母版", nodeId: "STYLE_NODE", role: "style", storageKey: "style-mother.png", sha256: promptHash(fs.readFileSync(filePath, "utf8")) };
    const sourceHash = "c".repeat(64), compilerHash = "e".repeat(64), prompt = "current prompt", sha256 = promptHash(prompt);
    const compiled = (nodeId: string) => ({
        sourceHash, engine: { compilerHash }, assets: {},
        source: { style_anchor_node_id: nodeId, segments: [] },
        artifacts: [{ id: "STYLE_TARGET", targetId: "STYLE_TARGET", kind: "h3", status: "ready", prompt, sourceHash, sha256, receipt: { sourceHash, promptHash: sha256, engine: { compilerHash } }, references: [styleReference] }],
    } as any);
    service.verifyCompilationBindings("episode", compiled("STYLE_NODE"));
    assert.throws(() => service.verifyCompilationBindings("episode", {
        ...compiled("STYLE_NODE"),
        artifacts: [{ ...compiled("STYLE_NODE").artifacts[0], references: [{ ...styleReference, nodeId: "EPISODE_MISSING" }] }],
    }), /图片已不在制作画布的对应节点上/);
});

test("stale artifact references do not block compilation after a source image is replaced", t => {
    const { service, filePath } = fixture(t);
    const staleReference = { label: "<Picture 1>", nodeId: "STYLE_NODE", role: "style", storageKey: "superseded-style.png", sha256: "0".repeat(64) };
    const sourceHash = "c".repeat(64), compilerHash = "e".repeat(64), prompt = "current prompt", sha256 = promptHash(prompt);
    service.verifyCompilationBindings("episode", {
        sourceHash, engine: { compilerHash }, assets: {},
        source: { style_anchor_node_id: "STYLE_NODE", segments: [] },
        artifacts: [{ id: "OLD_STYLE_TARGET", targetId: "STYLE_TARGET", kind: "image", status: "stale", sha256: "d".repeat(64), references: [staleReference] }],
    } as any);
    assert.ok(fs.existsSync(filePath));
    assert.throws(() => service.verifyCompilationBindings("episode", {
        sourceHash, engine: { compilerHash }, assets: {},
        source: { style_anchor_node_id: "STYLE_NODE", segments: [] },
        artifacts: [{ id: "CURRENT_STYLE_TARGET", targetId: "STYLE_TARGET", kind: "h3", status: "ready", sourceHash, prompt, sha256, receipt: { sourceHash, promptHash: sha256, engine: { compilerHash } }, references: [staleReference] }],
    } as any), /图片已不在制作画布的对应节点上/);
});
