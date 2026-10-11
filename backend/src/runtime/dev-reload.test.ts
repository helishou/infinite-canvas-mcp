import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createDevReloadGate } from "./dev-reload.js";

test("reload waits for business work and in-flight mutations, then fences new writes", () => {
    const gate = createDevReloadGate();
    const response = Object.assign(new EventEmitter(), { status: () => response, json: (_body: unknown) => response });
    let entered = 0;
    gate.middleware({ method: "POST" } as never, response as never, () => { entered++; });
    assert.equal(gate.tryReload(() => false), false);
    response.emit("finish"); response.emit("close");
    assert.equal(gate.tryReload(() => true), false);
    assert.equal(gate.tryReload(() => false), true);
    let rejectedStatus = 0;
    const rejection = { status: (status: number) => { rejectedStatus = status; return rejection; }, json: () => {} };
    gate.middleware({ method: "POST" } as never, rejection as never, () => { entered++; });
    assert.equal(rejectedStatus, 503);
    assert.equal(entered, 1, "a reload cannot race with a newly submitted task");
});

test("read-only streams do not prevent reload, interrupted writes release their fence", () => {
    const gate = createDevReloadGate();
    gate.middleware({ method: "GET" } as never, {} as never, () => {});
    const response = new EventEmitter();
    gate.middleware({ method: "PATCH" } as never, response as never, () => {});
    assert.equal(gate.tryReload(() => false), false);
    response.emit("close");
    assert.equal(gate.tryReload(() => false), true);
});
