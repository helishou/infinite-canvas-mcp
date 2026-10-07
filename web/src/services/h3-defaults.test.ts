import assert from "node:assert/strict";
import test from "node:test";
import { fetchBackendH3Defaults, saveBackendH3Defaults, resetBackendH3Defaults } from "./backend-api";

test("H3 defaults use the acknowledged response and reject incomplete or failed replies", async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => Response.json({ ok: true, defaults: { videoSteps: 17, noDub: false } });
    assert.deepEqual(await saveBackendH3Defaults({ videoSteps: 99 }), { videoSteps: 17, noDub: false });
    globalThis.fetch = async () => Response.json({ ok: true });
    await assert.rejects(fetchBackendH3Defaults(), /未返回有效/);
    await assert.rejects(saveBackendH3Defaults({ videoSteps: 99 }), /未确认/);
    await assert.rejects(resetBackendH3Defaults(), /未确认/);
    globalThis.fetch = async () => Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    await assert.rejects(fetchBackendH3Defaults(), /503/);
    globalThis.fetch = async () => Response.json({ ok: true, defaults: null });
    assert.deepEqual(await fetchBackendH3Defaults(), {});
    await resetBackendH3Defaults();
});
