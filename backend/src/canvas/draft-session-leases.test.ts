import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_DRAFT_LEASE_HEARTBEAT_MS,
  CANVAS_DRAFT_LEASE_TTL_MS,
  CanvasDraftSessionLeases,
} from "./draft-session-leases.js";

test("草稿租约同持有者可续期，其他窗口在 30 秒内不能接管", () => {
  let now = 1_000;
  const leases = new CanvasDraftSessionLeases(() => now);
  const first = leases.acquire("owner", "window-a");
  assert.equal(first.owned, true);
  assert.equal(first.expiresAt, now + CANVAS_DRAFT_LEASE_TTL_MS);

  now += CANVAS_DRAFT_LEASE_HEARTBEAT_MS;
  const renewed = leases.acquire("owner", "window-a");
  assert.equal(renewed.owned, true);
  assert.equal(renewed.expiresAt, now + CANVAS_DRAFT_LEASE_TTL_MS);
  assert.equal(leases.acquire("owner", "window-b").owned, false);

  now = renewed.expiresAt! - 1;
  assert.equal(leases.status("owner").active, true);
  assert.equal(leases.acquire("owner", "window-b").owned, false);
  now += 1;
  assert.deepEqual(leases.status("owner"), {
    active: false,
    owned: false,
    expiresAt: null,
  });
  assert.equal(leases.acquire("owner", "window-b").owned, true);
});

test("草稿租约只允许当前持有者立即释放且重复释放安全", () => {
  const leases = new CanvasDraftSessionLeases(() => 100);
  leases.acquire("owner", "window-a");
  assert.equal(leases.release("owner", "window-b"), false);
  assert.equal(leases.status("owner").active, true);
  assert.equal(leases.release("owner", "window-a"), true);
  assert.equal(leases.release("owner", "window-a"), false);
  assert.equal(leases.acquire("owner", "window-b").owned, true);
});
