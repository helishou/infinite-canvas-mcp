import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BASE_H3_NODE_METADATA } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { captureCanvasInputs } from "./canvas-inputs.js";

const makeProject = (prompt: string) => ({
    id: "CANVAS",
    revision: 1,
    nodes: [{ id: "H3", type: "minimax-h3:video", metadata: { ...BASE_H3_NODE_METADATA, segments: [{ id: "PHYSICAL_CLIP", taskMode: "t2v", duration: 4, megapixels: 0.4, prompt }] } }],
    connections: [],
});

const production = {
    director: {
        assets: {}, shotInputs: {},
        source: {
            fps_num: 24, fps_den: 1,
            script_scenes: [{ id: "SCENE", scene_id: "ROOM", scene_name: "厨房", text: "", beat_ids: ["BEAT"] }],
            shots: [{ id: "SHOT", scene_id: "ROOM", story_beat_ids: ["BEAT"] }],
            segments: [{ id: "CLIP", shot_ids: ["SHOT"] }],
        },
    },
    clipGroups: [{ id: "CLIP", nodeId: "H3", segmentId: "PHYSICAL_CLIP", shotIds: ["SHOT"] }],
    settings: {},
} as any;

test("canvas generation blocks an empty H3 format scaffold but accepts a substantive saved prompt", () => {
    const emptyScaffold = "integrated_multimodal_description:\n\noverall_soundscape:\n\nnon_diegetic_music:";
    const capture = (prompt: string) => captureCanvasInputs(makeProject(prompt) as any, production, ["segment:CLIP"], {}, () => null);

    const blocked = capture(emptyScaffold);
    assert.equal(blocked.blockedTargets[0]?.targetId, "segment:CLIP");
    assert.match(blocked.blockedTargets[0]?.message || "", /提示词为空/);

    const ready = capture("integrated_multimodal_description:\n固定镜头中，一名成年女性走进厨房，雨声渐弱。\n\noverall_soundscape:\n雨声与脚步声。\n\nnon_diegetic_music:\nN/A");
    assert.equal(ready.targets.length, 1);
    assert.equal(ready.blockedTargets.length, 0);
});

const compiled = (() => {
    const prompt = "integrated_multimodal_description:\n[Shot 1] 固定镜头中，一名成年女性走进厨房。\n\noverall_soundscape:\n雨声。\n\nnon_diegetic_music:\nN/A";
    const sha256 = createHash("sha256").update(prompt).digest("hex");
    const engine = { commit: "a".repeat(40), patchVersion: "test", runtimeId: "runtime", version: "4.3.9", compilerHashes: { h3: "h3", image: "image" } };
    return { prompt, sha256, engine };
})();
const formalProject = (projection: Record<string, unknown>) => {
    const project = makeProject(compiled.prompt);
    (project.nodes[0].metadata.segments[0] as any).productionClipProjection = projection;
    return project;
};
const formalProduction = () => ({
    ...production,
    director: {
        ...production.director,
        engine: compiled.engine,
        sourceHash: "source",
        artifacts: [{ id: "ARTIFACT", targetId: "CLIP", kind: "h3", prompt: compiled.prompt, sha256: compiled.sha256, sourceHash: "source",
            status: "ready", references: [], receipt: { sourceHash: "source", promptHash: compiled.sha256, engineRuntimeId: "runtime", engine: compiled.engine } }],
    },
});

test("a formal Clip that applied the current artifact is executable", () => {
    const capture = captureCanvasInputs(formalProject({ artifactId: "ARTIFACT", promptHash: compiled.sha256 }) as any, formalProduction() as any, ["segment:CLIP"], {}, () => null);
    assert.equal(capture.blockedTargets.length, 0, JSON.stringify(capture.blockedTargets));
    assert.equal(capture.targets.length, 1);
});

test("a formal Clip can generate its live prompt while its applied artifact is stale", () => {
    const capture = captureCanvasInputs(formalProject({ artifactId: "OLD-ARTIFACT", promptHash: "old" }) as any, formalProduction() as any, ["segment:CLIP"], {}, () => null);
    assert.equal(capture.blockedTargets.length, 0, JSON.stringify(capture.blockedTargets));
    assert.equal(capture.targets.length, 1);
});
