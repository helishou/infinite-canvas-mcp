import assert from "node:assert/strict";
import test from "node:test";
import { runCanvasStorageBenchmark } from "./canvas-storage-benchmark.js";

test("synthetic benchmark compares legacy and split single-node edits", () => {
    const report = runCanvasStorageBenchmark({ sizes: [8], warmups: 1, samples: 2, seed: 123 });
    assert.equal(report.results.length, 26);
    for (const result of report.results) {
        assert.ok(Number.isFinite(result.medianMs));
        assert.ok(Number.isFinite(result.p95Ms));
        assert.ok(Number.isFinite(result.walBytes));
        assert.ok(Number.isFinite(result.heapDeltaBytes));
    }
});
