import assert from "node:assert/strict";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { BackendDatabase } from "./db.js";
import { BackendEventBus } from "./events.js";
import { CanvasRealtimeHub } from "./canvas/realtime-hub.js";
import { startServer, setSelectionRealtime } from "./server.js";

test("canvas selection view 合并网页实时选区（presence），不依赖持久化 selectedNodeIds", { timeout: 15_000 }, async (t) => {
  const db = new BackendDatabase(":memory:");
  const events = new BackendEventBus();
  db.createCanvasProject({
    id: "sel",
    title: "选区画布",
    revision: 0,
    nodes: [
      { id: "n1", type: "image", title: "节点一", position: { x: 0, y: 0 } },
      { id: "n2", type: "image", title: "节点二", position: { x: 1, y: 1 } },
      { id: "n3", type: "image", title: "节点三", position: { x: 2, y: 2 } },
    ],
    connections: [],
  });
  console.error("after create, project:", JSON.stringify(db.getCanvasProject("sel"))?.slice?.(0, 120));

  const config = { url: "http://127.0.0.1:0", token: "test", port: 0, origins: [], listenHost: "127.0.0.1" } as unknown as import("./config.js").ResolvedConfig;
  const { app } = startServer(db, config, { events });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  console.error("listening on", port);

  let ws: WebSocket | undefined;
  try {
    const hub = new CanvasRealtimeHub(config, db, events);
    setSelectionRealtime(hub);
    hub.attach(server);

    ws = new WebSocket(`ws://127.0.0.1:${port}/canvas/realtime?token=test&projectId=sel&clientId=browser`);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "presence", selectedNodeIds: ["n1", "n3"], revision: 0, color: "#0f766e" }));

    for (let i = 0; i < 50 && hub.participants("sel").every((p) => (p.selectedNodeIds ?? []).length === 0); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    console.error("hub participants selection:", JSON.stringify(hub.participants("sel").map((p) => p.selectedNodeIds)));

    const res = await fetch(`http://127.0.0.1:${port}/canvas/projects/sel?view=selection&token=test`);
    const text = await res.text();
    console.error("status:", res.status, "body:", text.slice(0, 400));
    const body = JSON.parse(text) as { ok: boolean; project?: { nodeCount: number; nodes: Array<{ id: string }> } };
    const ids = (body.project?.nodes ?? []).map((n) => n.id).sort();
    assert.deepEqual(ids, ["n1", "n3"], "网页实时选区应被 view=selection 合并读出");
  } finally {
    ws?.close();
    server.close();
    db.close();
  }
});
