import test from "node:test";
import assert from "node:assert/strict";
import { projectModelCatalog } from "./model-catalog.js";
import type { ComfyModelCatalog } from "./comfyui-types.js";

const catalog: ComfyModelCatalog = { models: Array.from({ length: 10000 }, (_, i) => `H3-${i}.safetensors`), loras: ["other", "H3-style"], textEncoders: [], videoVaes: [], audioVaes: [], latentUpscaleModels: [], nanfeng: { unet: ["H3-special"] }, refreshedAt: "2026-01-01" };
test("model summary excludes filenames and filtered pages cover the complete matching catalog", () => {
    const summary: any = projectModelCatalog(catalog, {});
    assert.equal(summary.counts.models, 10000); assert.ok(JSON.stringify(summary).length < 1000);
    const input = { view: "entries" as const, categories: ["loras", "nanfeng"] as const, query: "h3", pageSize: 1 };
    const pages: any[] = []; let cursor: string | undefined;
    do { const page: any = projectModelCatalog(catalog, { ...input, categories: [...input.categories], cursor }); pages.push(...page.entries); cursor = page.nextCursor || undefined; } while (cursor);
    assert.deepEqual(pages.map(item => item.value), ["H3-style", "H3-special"]);
    assert.equal(pages[1].group, "unet");
    assert.throws(() => projectModelCatalog(catalog, { view: "entries", categories: ["models"] }), /pageSize/);
    const first: any = projectModelCatalog(catalog, { view: "entries", categories: ["models"], pageSize: 1 });
    assert.throws(() => projectModelCatalog({ ...catalog, models: ["changed"] }, { view: "entries", categories: ["models"], pageSize: 1, cursor: first.nextCursor }), /READ_CURSOR_EXPIRED/);
    assert.throws(() => projectModelCatalog(catalog, { view: "entries", categories: ["models"], query: "9", pageSize: 1, cursor: first.nextCursor }), /READ_CURSOR_EXPIRED/);
    assert.deepEqual((projectModelCatalog(catalog, { view: "full" }) as any).models, catalog.models);
    assert.equal((projectModelCatalog(catalog, { view: "entries", categories: ["models"], query: "missing", pageSize: 1 }) as any).total, 0);
    console.log(`model projection: ${Buffer.byteLength(JSON.stringify(catalog))} -> ${Buffer.byteLength(JSON.stringify(summary))} bytes`);
});
