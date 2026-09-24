# Infinite Canvas Performance Benchmark

## Fixture

- Graph: 1000 nodes + 3000 connections
- Serialized project bytes: 538,533
- Samples: 5 per scenario, with 2 warmups
- Machine: Windows 11, Node v24.19.0, AMD Ryzen 5 7500F, 12 logical CPUs
- Command: `node --import ../backend/node_modules/tsx/dist/loader.mjs src/lib/canvas/canvas-operations.bench.ts`

## Baseline source

Baseline is an isolated detached worktree at `dd463b7a2c7de10fa9c33b63aee3d2524e36316b` (`perf(h3): stabilize reference catalog effects`). The benchmark harness was copied into that checkout; the production code under test remained the pre-coordinator commit. The same machine, Node process, fixture, iterations and command were used.

## Relative results

| Scenario | Baseline median (ms) | Optimized median (ms) | Relative median | Counts |
|---|---:|---:|---:|---|
| metadata-no-op × 1000 | 5657.691 | 6508.367 | +15.04% | 1000 operations/sample |
| single-node-update × 1000 | 5908.568 | 7154.995 | +21.10% | 1000 operations/sample |
| reference-sync × 100 | 0.107 | 0.410 | +283.18% | 500 Backend batch calls, 20 inputs/call |

The graph-diff paths were not structurally optimized in this task; their timing variance shows that these are measurement-sensitive full-graph costs, not a claimed coordinator improvement. The reference-sync scenario is intentionally a transport-count contract check: both runs issue one `upsertMany` Backend batch per iteration. The production coordinator is exercised on the optimized checkout; the isolated baseline predates that file, so the baseline reference-sync comparison is a contract smoke baseline rather than a like-for-like implementation comparison.

All benchmark assertions passed: 1000 nodes, 3000 connections, and `backendBatchCalls === 500`.

## Reproduction

```bash
cd web
node --import ../backend/node_modules/tsx/dist/loader.mjs src/lib/canvas/canvas-operations.bench.ts
```

No absolute millisecond threshold is used as a pass/fail gate. The deferred field-level mutation, graph index, media streaming, SQLite index, and generic no-op receipt work remains deferred.
