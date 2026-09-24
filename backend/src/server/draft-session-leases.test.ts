import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("Backend 草稿租约路由鉴权、续期、冲突与立即释放", async () => {
  const db = new BackendDatabase(":memory:");
  const { app } = startServer(db, {
    url: "http://127.0.0.1",
    token: "test",
    port: 0,
    origins: ["*"],
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, holderId: string, token = "test") =>
    fetch(url + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ holderId }),
    });
  try {
    assert.equal(
      (await post("/canvas/draft-sessions/owner/acquire", "a", "wrong")).status,
      401,
    );
    const acquired = await post("/canvas/draft-sessions/owner/acquire", "a");
    assert.equal(acquired.status, 200);
    assert.equal(
      ((await acquired.json()) as { lease: { owned: boolean } }).lease.owned,
      true,
    );
    assert.equal(
      (await post("/canvas/draft-sessions/owner/acquire", "a")).status,
      200,
    );
    const held = await post("/canvas/draft-sessions/owner/acquire", "b");
    assert.equal(held.status, 409);
    assert.equal(
      ((await held.json()) as { code: string }).code,
      "DRAFT_SESSION_LEASE_HELD",
    );
    const status = await fetch(
      `${url}/canvas/draft-sessions/owner/lease?holderId=b`,
      { headers: { Authorization: "Bearer test" } },
    );
    const lease = (
      (await status.json()) as {
        lease: { active: boolean; owned: boolean; expiresAt: number | null };
      }
    ).lease;
    assert.equal(lease.active, true);
    assert.equal(lease.owned, false);
    assert.equal(typeof lease.expiresAt, "number");
    const released = await post("/canvas/draft-sessions/owner/release", "a");
    assert.equal(released.status, 200);
    assert.equal(
      ((await released.json()) as { released: boolean }).released,
      true,
    );
    assert.equal(
      (await post("/canvas/draft-sessions/owner/acquire", "b")).status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
