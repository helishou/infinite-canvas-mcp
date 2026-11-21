import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptBodySchema } from "./drama-planning-routes.js";

test("script-proposal 结构化接受 hook/cliffhanger/reasoningEffort（不再走400 fallback）", () => {
    const parsed = scriptBodySchema.safeParse({
        model: "some-model",
        hook: "夜路设伏突生变故",
        cliffhanger: "巨蟒竟是爱妻所化",
        reasoningEffort: "high",
        instruction: "保持古装写实",
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
    if (parsed.success) {
        assert.equal(parsed.data.hook, "夜路设伏突生变故");
        assert.equal(parsed.data.cliffhanger, "巨蟒竟是爱妻所化");
        assert.equal(parsed.data.reasoningEffort, "high");
    }
});

test("script-proposal 仍拒绝未知字段（strict 不被破坏）", () => {
    const parsed = scriptBodySchema.safeParse({ nonsense: 1 });
    assert.equal(parsed.success, false);
});
