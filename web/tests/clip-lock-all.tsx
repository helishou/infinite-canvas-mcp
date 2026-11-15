import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { SubjectStoryboardWorkbench } from "../src/pages/drama/subject-storyboard-workbench";
import "../src/i18n";
import "../src/styles/globals.css";

type Segment = { id: string; shot_ids: string[]; mode: string; locked?: boolean };
const initialSegments: Segment[] = [
    { id: "C1", shot_ids: ["S1"], mode: "Ref2VA", locked: true },
    { id: "C2", shot_ids: ["S2"], mode: "Ref2VA" },
];
const shots = ["S1", "S2"].map((id, story_order) => ({ id, story_order, duration_frames: 96, timeline_id: "main", title: id, source_scene_id: "SCENE",
    visual: "测试画面", camera: { framing: "CU", editorial_reason: "测试", attention_subject_ids: [] }, subject_usages: [], keyframes: [], utterance_refs: [] }));

function Harness() {
    const [segments, setSegments] = useState(initialSegments);
    const [events, setEvents] = useState<unknown[]>([]);
    const [failNext, setFailNext] = useState(false);
    const source = { version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], utterances: [],
        script_scenes: [{ id: "SCENE", title: "场次" }], ledger: { contract_version: 2, facts: [], timelines: [], events: [], initial: [] }, shots, segments };
    const sourceHash = JSON.stringify(segments);
    const engine = { runtimeId: "test", compilerHash: "test" };
    const director: any = { source, sourceHash, engine, assets: {}, shotInputs: {}, boundaries: [], artifacts: [] };
    const production: any = { revision: 1, draft: { director, settings: {}, clipGroups: [], shots: [], scenes: [], keyframes: {}, keyframeReviews: {} }, clipRefreshes: [] };
    return <ConfigProvider><App><main className="p-4">
        <div data-test-controls>
            <button data-test-fail-next onClick={() => setFailNext(true)}>fail next</button>
        </div>
        <SubjectStoryboardWorkbench director={director} production={production} owner={{ projectId: "CLIP_LOCK_TEST" }} activeView="clips" canvasId="CLIP_LOCK_TEST" canvasNodes={[]}
            shotDrafts={{}} clipEditor={() => null} renderEditor={() => null} onClip={() => {}} onDiscuss={() => {}} onNavigate={() => {}}
            onToggleClipLock={async () => true}
            onToggleAllClipLocks={async (ids, locked) => {
                setEvents(value => [...value, { ids, locked }]);
                if (failNext) { setFailNext(false); return false; }
                setSegments(current => current.map(segment => ids.includes(String(segment.id)) ? { ...segment, locked } : segment));
                return true;
            }} />
        <output data-test-events>{JSON.stringify(events)}</output>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
