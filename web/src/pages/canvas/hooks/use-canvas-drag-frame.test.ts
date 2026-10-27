import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createCanvasDragFrameScheduler, useCanvasDragFrame } from "./use-canvas-drag-frame";

function createFrameDriver() {
    let nextId = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    return {
        callbacks,
        cancelled,
        request: (callback: FrameRequestCallback) => {
            const id = nextId++;
            callbacks.set(id, callback);
            return id;
        },
        cancel: (id: number) => {
            cancelled.push(id);
            callbacks.delete(id);
        },
        run(id: number) {
            const callback = callbacks.get(id);
            assert.ok(callback, `frame ${id} should be pending`);
            callbacks.delete(id);
            callback(0);
        },
    };
}

test("canvas drag frame scheduler replaces a stale frame with the latest preview", () => {
    const frames = createFrameDriver();
    const calls: string[] = [];
    const scheduler = createCanvasDragFrameScheduler(frames.request, frames.cancel);

    scheduler.schedule(() => calls.push("old"));
    scheduler.schedule(() => calls.push("latest"));

    assert.deepEqual(frames.cancelled, [1]);
    assert.equal(frames.callbacks.size, 1);
    frames.run(2);
    assert.deepEqual(calls, ["latest"]);
});

test("canvas drag frame cancellation drops pending preview work", () => {
    const frames = createFrameDriver();
    const calls: string[] = [];
    const scheduler = createCanvasDragFrameScheduler(frames.request, frames.cancel);

    scheduler.schedule(() => calls.push("preview"));
    scheduler.cancel();

    assert.deepEqual(frames.cancelled, [1]);
    assert.equal(frames.callbacks.size, 0);
    assert.deepEqual(calls, []);
});

test("canvas drag frame hook can initialize during server rendering", () => {
    function FrameConsumer() {
        useCanvasDragFrame();
        return null;
    }

    assert.doesNotThrow(() => renderToString(createElement(FrameConsumer)));
});
