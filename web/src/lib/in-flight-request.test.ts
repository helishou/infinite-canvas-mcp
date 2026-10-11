import assert from "node:assert/strict";
import test from "node:test";
import { coalesceInFlightRequest } from "./in-flight-request";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("identical concurrent reads share one promise, then a later read starts fresh", async () => {
    const pending = deferred<string>();
    let calls = 0;
    const first = coalesceInFlightRequest("GET /same", () => { calls++; return pending.promise; });
    const duplicate = coalesceInFlightRequest("GET /same", () => { calls++; return Promise.resolve("wrong"); });

    assert.strictEqual(duplicate, first);
    assert.equal(calls, 1);
    pending.resolve("same response");
    assert.equal(await first, "same response");

    const later = coalesceInFlightRequest("GET /same", () => { calls++; return Promise.resolve("fresh response"); });
    assert.equal(await later, "fresh response");
    assert.equal(calls, 2);
});

test("failed reads are removed so a later request can retry", async () => {
    let calls = 0;
    const request = () => coalesceInFlightRequest("GET /retry", () => {
        calls++;
        return Promise.reject(new Error("temporary failure"));
    });

    await assert.rejects(request(), /temporary failure/);
    await assert.rejects(request(), /temporary failure/);
    assert.equal(calls, 2);
});
