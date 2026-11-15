import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { SubjectStoryboardWorkbench } from "../src/pages/drama/subject-storyboard-workbench";
import { SubjectShotEditor } from "../src/pages/drama/subject-shot-editor";
import "../src/i18n";
import "../src/styles/globals.css";

const prompt = "test prompt", promptHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt))), byte => byte.toString(16).padStart(2, "0")).join("");
const initialShots = ["S1", "S2", "S3"].map((id, story_order) => ({ id, story_order, source_scene_id: "SCENE", timeline_id: "T", title: id,
    duration_frames: 96, visual: "原画面", camera: { framing: "CU", editorial_reason: "看清反应", attention_subject_ids: [] }, subject_usages: [], keyframes: [], utterance_refs: [] }));
function Harness() {
    const [shots, setShots] = useState(initialShots);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [phase, setPhase] = useState("ready");
    const [events, setEvents] = useState<unknown[]>([]);
    const engine = { runtimeId: "test", compilerHash: "test" };
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], utterances: [],
        script_scenes: [{ id: "SCENE", title: "场次" }], ledger: { contract_version: 2, facts: [], timelines: [], events: [], initial: [] }, shots,
        segments: [{ id: "C1", shot_ids: ["S1", "S2"], mode: "Ref2VA", locked: phase === "locked" }, { id: "C2", shot_ids: ["S3"], mode: "Ref2VA" }] };
    const sourceHash = JSON.stringify(shots);
    const director: any = { source, sourceHash, engine, assets: {}, shotInputs: {}, boundaries: [], artifacts: ["C1", "C2"].map(targetId => ({ id: targetId, kind: "h3", targetId, prompt, sha256: promptHash, status: "ready",
        sourceHash: ["ready", "running", "locked"].includes(phase) ? sourceHash : "old", receipt: { engine, sourceHash, promptHash } })) };
    const nodes = [{ id: "H3", type: "minimax-h3", metadata: { segments: ["C1", "C2"].map(id => ({ id, status: phase === "running" ? "running" : "idle", productionClipProjection: { targetId: id, promptHash } })) } }];
    const production: any = { revision: 1, draft: { director, settings: {}, clipGroups: [], shots: [], scenes: [], keyframes: {}, keyframeReviews: {} }, clipRefreshes: ["compiling", "failed"].includes(phase) ? [{ segmentId: "C1", savedRevision: 1, sourceHash, status: phase, blockingDiagnostic: phase === "failed" ? { code: "TEST", message: "参考图片无法解析" } : undefined }] : [] };
    return <ConfigProvider><App><main className="p-4">
        <div data-test-controls>{["ready", "compiling", "failed", "running", "locked"].map(value => <button key={value} className="mr-4" onClick={() => setPhase(value)}>{value}</button>)}
            <button onClick={() => setDrafts({})}>clear drafts</button></div>
        <SubjectStoryboardWorkbench director={director} production={production} owner={{ projectId: "SHOT_CLIP_TEST" }} activeView="shots" canvasId="SHOT_CLIP_TEST" canvasNodes={nodes}
            shotDrafts={drafts} clipEditor={() => null} onClip={() => {}} onDiscuss={() => {}} onNavigate={() => {}}
            onCompile={(_scene, clipId) => { setEvents(value => [...value, { compile: clipId }]); setPhase("ready"); }}
            onGenerateClip={clipId => setEvents(value => [...value, { generate: clipId }])}
            renderEditor={(shot, workbench, footerActions) => <SubjectShotEditor key={shot.id} shot={shot} source={source} workbench={workbench} canvasNodes={[]} canvasId="SHOT_CLIP_TEST" busy={false}
                footerActions={footerActions} draftValue={drafts[`v2shot:${shot.id}`]} onDraftChange={value => setDrafts(current => { const next = { ...current }; if (value === undefined) delete next[`v2shot:${shot.id}`]; else next[`v2shot:${shot.id}`] = value; return next; })}
                onSave={async (id, patch) => { setEvents(value => [...value, { save: id, patch }]); setShots(value => value.map(item => item.id === id ? { ...item, ...patch } : item)); setPhase("compiling"); return true; }} />}
        />
        <output data-test-events>{JSON.stringify(events)}</output>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
