import test from "node:test";
import assert from "node:assert/strict";
import { deriveFinalStale } from "./use-studio-data";

const production = (finalResource?: Record<string, unknown>) => ({
    revision: 1,
    draft: { director: { workflow: finalResource ? { finalResource } : {} } },
}) as never;

const clip = (overrides: Record<string, unknown>) => ({
    id: "c1", title: "段1", storageKey: "video:x", duration: 5, status: "success", inputOutdated: false, ...overrides,
});

test("无成片 / stale=true 字段都不算过期（不读只写字段）", () => {
    assert.equal(deriveFinalStale(production(), [clip({})]), false);
    assert.equal(deriveFinalStale(production({ storageKey: "video:final", stale: true }), [clip({})]), false);
});

test("段输入 hash 变化 → 成片过期", () => {
    assert.equal(deriveFinalStale(production({ storageKey: "video:final", at: "2026-01-01T00:00:00Z" }), [clip({ inputOutdated: true })]), true);
});

test("段视频晚于成片合成 → 成片过期；早于则不过期", () => {
    const p = production({ storageKey: "video:final", at: "2026-01-01T00:00:00Z" });
    assert.equal(deriveFinalStale(p, [clip({ generatedAt: "2026-01-01T00:10:00Z" })]), true);
    assert.equal(deriveFinalStale(p, [clip({ generatedAt: "2025-12-31T23:00:00Z" })]), false);
    assert.equal(deriveFinalStale(p, [clip({})]), false);
});
