import assert from "node:assert/strict";
import test from "node:test";
import { runBackendConnectionMonitorCycle } from "./backend-connection-monitor";

function dependencies(health: boolean) {
    const calls = { health: 0, full: 0, disconnected: 0 };
    return {
        calls,
        value: {
            healthCheck: async () => { calls.health++; return { ok: health }; },
            fullCheck: async () => { calls.full++; },
            markDisconnected: () => { calls.disconnected++; },
        },
    };
}

test("connected periodic checks only probe health", async () => {
    const deps = dependencies(true);
    const result = await runBackendConnectionMonitorCycle({ connected: true, checking: false }, false, deps.value);
    assert.equal(result, "healthy");
    assert.deepEqual(deps.calls, { health: 1, full: 0, disconnected: 0 });
});

test("a disconnected service performs the full recovery check", async () => {
    const deps = dependencies(true);
    const result = await runBackendConnectionMonitorCycle({ connected: false, checking: false }, false, deps.value);
    assert.equal(result, "full");
    assert.deepEqual(deps.calls, { health: 0, full: 1, disconnected: 0 });
});

test("an authorization signal forces a full token/business check", async () => {
    const deps = dependencies(true);
    const result = await runBackendConnectionMonitorCycle({ connected: true, checking: false }, true, deps.value);
    assert.equal(result, "full");
    assert.deepEqual(deps.calls, { health: 0, full: 1, disconnected: 0 });
});

test("a concurrent connection check skips another probe", async () => {
    const deps = dependencies(true);
    const result = await runBackendConnectionMonitorCycle({ connected: true, checking: true }, true, deps.value);
    assert.equal(result, "skipped");
    assert.deepEqual(deps.calls, { health: 0, full: 0, disconnected: 0 });
});

test("an unhealthy health probe marks the backend disconnected without a duplicate full probe", async () => {
    const deps = dependencies(false);
    const result = await runBackendConnectionMonitorCycle({ connected: true, checking: false }, false, deps.value);
    assert.equal(result, "disconnected");
    assert.deepEqual(deps.calls, { health: 1, full: 0, disconnected: 1 });
});
