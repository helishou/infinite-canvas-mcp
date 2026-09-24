import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("媒体 GET 免 token，但上传和删除仍要求 token", async (t) => {
  const db = new BackendDatabase(":memory:");
  const app = startServer(db, { url: "http://127.0.0.1", token: "test-secret", port: 0, origins: [] }).app;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${url}/media/upload`, {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:text/plain;base64,aGVsbG8=", name: "x.txt" }),
    });
    assert.equal(created.status, 201);
    const { media } = await created.json() as { media: { url: string } };
    const readMedia = await fetch(`${url}${media.url}`);
    assert.equal(readMedia.status, 200);
    const upload = await fetch(`${url}/media/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:text/plain;base64,aGVsbG8=", name: "y.txt" }),
    });
    assert.equal(upload.status, 401);
    const del = await fetch(`${url}/media/missing`, { method: "DELETE" });
    assert.equal(del.status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
