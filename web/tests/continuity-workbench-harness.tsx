import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ContinuityPanel } from "../src/pages/drama/continuity-panel";
import "../src/i18n";
import "../src/styles/globals.css";

// The subject timeline is only mounted when a v2 source and ledger both exist, so
// this fixture supplies both to exercise the direct add/edit entry points.
const subject = { id: "SUB_CUI", entityRef: { kind: "character", id: "C_CUI" }, display_name: "翠子" };
const fact = {
    id: "F_GRIP", object_kind: "character", object_id: "C_CUI", display_name: "抓握状态",
    allowed_values: ["not_holding", "holding", "released"],
    value_descriptions: { not_holding: "尚未抓住顺子的手臂", holding: "左手握住顺子的右上臂", released: "已松开顺子的手臂" },
};
const shots = [
    { id: "SH01", title: "翠子伸手抓住顺子", scene_id: "SC02", source_scene_id: "SC02", story_order: 0, timeline_id: "T", duration_frames: 96, subject_usages: [{ subjectId: "SUB_CUI", presentation: "visible", localStartFrame: 0, localEndFrame: 96 }] },
    { id: "SH02", title: "顺子回头看向翠子", scene_id: "SC02", source_scene_id: "SC02", story_order: 1, timeline_id: "T", duration_frames: 96, subject_usages: [{ subjectId: "SUB_CUI", presentation: "visible", localStartFrame: 0, localEndFrame: 96 }] },
];
const segments = [{ id: "C1", shot_ids: ["SH01", "SH02"] }];
const scenes = [{ id: "SC02", scene_id: "SC02", scene_name: "第二场 · 院子", blocks: [{ id: "B01", kind: "action", text: "翠子抓住顺子的手臂。" }] }];
const ledger = {
    contract_version: 2, facts: [fact], timelines: [{ id: "T", display_name: "主时间线" }],
    initial: [{ timeline_id: "T", fact_id: "F_GRIP", value: "not_holding" }],
    events: [{ id: "EV_GRIP", timeline_id: "T", fact_id: "F_GRIP", shot_id: "SH01", local_frame: 24, before: "not_holding", after: "holding", reason: "翠子伸出左手抓住顺子的右上臂。", source_anchor: { block_id: "B01" } }],
    requirements: [{ id: "R1", timeline_id: "T", shot_id: "SH01", fact_id: "F_GRIP", kind: "change", event_ids: ["EV_GRIP"], source_anchor: { block_id: "B01" } }],
    coverage: [{ id: "COV1", timeline_id: "T", evidence_kind: "explicit_change", fact_ids: ["F_GRIP"], event_ids: ["EV_GRIP"], shot_ids: ["SH01"], source_anchor: { block_id: "B01" }, source_digest: "fixture" }],
};
const source = { prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [subject], shots, segments, script_scenes: scenes, ledger };

function Panel() {
    const [saved, setSaved] = useState<Record<string, any>>(ledger);
    const [draft, setDraft] = useState<string>();
    return <main className="p-4" style={{ height: "100vh" }}>
        <ContinuityPanel ledger={saved} source={source} sourceHash={JSON.stringify(saved)} scenes={scenes}
            locations={[{ id: "ENV_YARD", name: "院子" }]} characters={[{ id: "C_CUI", name: "翠子" }]} assets={[]}
            shots={shots} segments={segments} boundaries={[]} subjectAssembly titleAlreadyVisible
            draftValue={draft} onDraftChange={setDraft} busy={false} editable
            onSave={async next => { setSaved(structuredClone(next)); return true; }}
            onCheck={async () => {}} onLocate={() => {}} onBoundary={() => {}} onSnapshot={() => {}} />
    </main>;
}
const router = createMemoryRouter([{ path: "/", element: <Panel /> }]);
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><RouterProvider router={router} /></App></ConfigProvider>);
