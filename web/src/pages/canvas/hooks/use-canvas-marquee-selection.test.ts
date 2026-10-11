import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasSelectionFrameScheduler } from "./use-canvas-marquee-selection";

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

test("canvas marquee frame scheduler coalesces pointer moves and renders the latest position", () => {
    const frames = createFrameDriver();
    const updates: Array<{ clientX: number; clientY: number }> = [];
    const scheduler = createCanvasSelectionFrameScheduler((point) => updates.push(point), frames.request, frames.cancel);

    scheduler.schedule({ clientX: 10, clientY: 20 });
    scheduler.schedule({ clientX: 30, clientY: 40 });

    assert.equal(frames.callbacks.size, 1);
    assert.deepEqual(updates, []);
    frames.run(1);
    assert.deepEqual(updates, [{ clientX: 30, clientY: 40 }]);
});

test("canvas marquee flush cancels a pending frame and renders its final pointer once", () => {
    const frames = createFrameDriver();
    const updates: Array<{ clientX: number; clientY: number }> = [];
    const scheduler = createCanvasSelectionFrameScheduler((point) => updates.push(point), frames.request, frames.cancel);

    scheduler.schedule({ clientX: 10, clientY: 20 });
    scheduler.setPointer({ clientX: 50, clientY: 60 });
    scheduler.flush();

    assert.deepEqual(frames.cancelled, [1]);
    assert.deepEqual(updates, [{ clientX: 50, clientY: 60 }]);
    assert.equal(frames.callbacks.size, 0);
});

test("canvas marquee cancel discards pending pointer work without updating selection", () => {
    const frames = createFrameDriver();
    const updates: Array<{ clientX: number; clientY: number }> = [];
    const scheduler = createCanvasSelectionFrameScheduler((point) => updates.push(point), frames.request, frames.cancel);

    scheduler.schedule({ clientX: 10, clientY: 20 });
    scheduler.cancel();

    assert.deepEqual(frames.cancelled, [1]);
    assert.deepEqual(updates, []);
    assert.equal(frames.callbacks.size, 0);
});
