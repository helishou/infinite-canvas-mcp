import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("H3 确认 HTTP 入口校验快照，普通取消不能取消暂停任务", async () => {
  const db = new BackendDatabase(":memory:");
  db.createTask("parent", "canvas-h3-run", { projectId: "p", nodeId: "n" }, {});
  db.updateTask("parent", { status: "awaiting_confirmation", result: { confirmation: { pending: [{ segmentId: "clip-1", firstPassFingerprint: "fingerprint" }] } } });
  const calls: unknown[] = [];
  const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-secret", port: 0, origins: [] }, {
    resolveH3Confirmation: (id, input) => { calls.push({ id, input }); return db.getTask(id)!; },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: "Bearer test-secret", "content-type": "application/json" };
  try {
    const unauthenticated = await fetch(`${url}/tasks/parent/h3-confirmation`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthenticated.status, 401);
    const invalid = await fetch(`${url}/tasks/parent/h3-confirmation`, { method: "POST", headers, body: JSON.stringify({ action: "confirm", segmentId: "" }) });
    assert.equal(invalid.status, 400);
    const cancelled = await fetch(`${url}/tasks/parent/cancel`, { method: "POST", headers });
    assert.equal(cancelled.status, 409);
    assert.equal(db.getTask("parent")!.status, "awaiting_confirmation");
    const input = { action: "keep_first_pass", segmentId: "clip-1", expectedRevision: 0 };
    const response = await fetch(`${url}/tasks/parent/h3-confirmation`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { task: { id: string } }).task.id, "parent");
    assert.deepEqual(calls, [{ id: "parent", input }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
