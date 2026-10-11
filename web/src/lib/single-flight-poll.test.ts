import assert from "node:assert/strict";
import test from "node:test";
import { startSingleFlightPoller, type PollTimerScheduler } from "./single-flight-poll";

class FakeTimers implements PollTimerScheduler {
    private nextId = 1;
    readonly jobs = new Map<number, { callback: () => void; delayMs: number }>();
    setTimeout = (callback: () => void, delayMs: number): unknown => {
        const id = this.nextId++;
        this.jobs.set(id, { callback, delayMs });
        return id;
    };
    clearTimeout = (handle: unknown): void => { this.jobs.delete(handle as number); };
    runNext() {
        const entry = this.jobs.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
        if (!entry) throw new Error("No scheduled timer");
        this.jobs.delete(entry[0]);
        entry[1].callback();
        return entry[1].delayMs;
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flushMicrotasks() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("polls never overlap and concurrent refresh signals coalesce into one follow-up", async () => {
    const timers = new FakeTimers();
    const first = deferred<void>();
    let calls = 0;
    let running = 0;
    let maxRunning = 0;
    const poller = startSingleFlightPoller({
        intervalMs: 5000,
        scheduler: timers,
        poll: () => {
            calls++;
            running++;
            maxRunning = Math.max(maxRunning, running);
            const result = calls === 1 ? first.promise : Promise.resolve();
            return result.finally(() => { running--; });
        },
    });

    assert.equal(calls, 1);
    poller.refreshNow();
    poller.refreshNow();
    assert.equal(calls, 1);

    first.resolve();
    await flushMicrotasks();
    assert.equal(calls, 2);
    assert.equal(maxRunning, 1);
    await flushMicrotasks();
    assert.equal(timers.jobs.size, 1);
    assert.equal(timers.runNext(), 5000);
    assert.equal(calls, 3);

    poller.stop();
    assert.equal(timers.jobs.size, 0);
});

test("pausing clears the timer and resuming refreshes immediately", async () => {
    const timers = new FakeTimers();
    let calls = 0;
    const poller = startSingleFlightPoller({
        intervalMs: 5000,
        initiallyPaused: true,
        scheduler: timers,
        poll: async () => { calls++; },
    });

    assert.equal(calls, 0);
    poller.resume();
    assert.equal(calls, 1);
    await flushMicrotasks();
    assert.equal(timers.jobs.size, 1);

    poller.pause();
    assert.equal(timers.jobs.size, 0);
    poller.refreshNow();
    assert.equal(calls, 1);

    poller.resume();
    assert.equal(calls, 2);
    await flushMicrotasks();
    poller.stop();
});
