import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { summarizeCanvasState } from "@basketikun/canvas-agent/state-summary";

test("SQLite 节点目录与 revision 来自同次查询，不读取节点 metadata", (t) => {
  const db = new BackendDatabase(":memory:");
  t.after(() => db.close());
  db.createCanvasProject({
    id: "index", title: "目录画布", revision: 0, updatedAt: "2026-09-25T00:00:00.000Z",
    nodes: [
      { id: "same", type: "image", title: "同名", position: { x: 1, y: 2 }, metadata: { storageKey: "secret-media" } },
      { id: "other", type: "config", title: "同名", position: { x: 3, y: 4 }, metadata: { generationMode: "image", content: "private-prompt" } },
      { id: "untitled", type: "minimax-h3", title: "", position: { x: 5, y: 6 }, metadata: { segments: [{ id: "clip-1" }] } },
    ],
    connections: [{ id: "edge", fromNodeId: "same", toNodeId: "other" }],
  });
  const index = db.getCanvasProjectIndex("index")!;
  assert.equal(index.revision, 0);
  assert.equal(index.nodeCount, 3);
  assert.equal(index.connectionCount, 1);
  assert.deepEqual((index.nodes as Array<{ id: string }>).map((node) => node.id), ["same", "other", "untitled"]);
  const directory = summarizeCanvasState(index, {});
  assert.ok("nodes" in directory);
  const projected = directory.nodes as Array<Record<string, unknown>>;
  assert.deepEqual(projected.map((node) => node.title), ["同名", "同名", ""]);
  assert.equal(projected[1].generationMode, "image");
  assert.equal(projected[2].generationMode, "video");
  assert.equal(JSON.stringify(index).includes("secret-media"), false);
  assert.equal(JSON.stringify(index).includes("private-prompt"), false);
  const unchanged = db.getCanvasProjectIndex("index", 0)!;
  assert.equal(unchanged.unchanged, true);
  assert.equal("nodes" in unchanged, false);
  assert.equal(db.getCanvasProjectIndex("missing", 0), null);
});

test("单项目目录 HTTP 接口明确区分未变化、缺失项目和无效 revision", async () => {
  const db = new BackendDatabase(":memory:");
  db.createCanvasProject({ id: "index-http", title: "HTTP 画布", revision: 0, nodes: [
    { id: "image", type: "image", title: "图片", metadata: { storageKey: "media/private.png" } },
  ], connections: [] });
  const { app } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: ["*"] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = (path: string) => fetch(base + path, { headers: { Authorization: "Bearer test" } });
  try {
    const fresh = await read("/canvas/projects/index-http?view=index");
    assert.equal(fresh.status, 200);
    const body = await fresh.json() as { project: Record<string, unknown> };
    assert.deepEqual((body.project.nodes as Array<{ id: string }>).map((node) => node.id), ["image"]);
    assert.equal(JSON.stringify(body).includes("media/private.png"), false);
    const unchanged = await read("/canvas/projects/index-http?view=index&ifRevision=0");
    assert.equal(unchanged.status, 200);
    const current = await unchanged.json() as { project: Record<string, unknown> };
    assert.equal(current.project.unchanged, true);
    assert.equal("nodes" in current.project, false);
    assert.equal((await read("/canvas/projects/index-http?view=index&ifRevision=bad")).status, 400);
    assert.equal((await read("/canvas/projects/missing?view=index")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
