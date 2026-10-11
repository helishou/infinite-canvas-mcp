import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { SubjectShotEditor } from "../src/pages/drama/subject-shot-editor";
import { PictureBindingEditor } from "../src/pages/drama/picture-binding-editor";
import { ContinuityPanel } from "../src/pages/drama/continuity-panel";
import { SubjectStoryboardWorkbench } from "../src/pages/drama/subject-storyboard-workbench";
import "../src/i18n";
import "../src/styles/globals.css";

const clipDirector: any = { sourceHash: "fixture", artifacts: [], assets: {}, boundaries: [], shotInputs: {}, source: { prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, subject_registry: [], ledger: { facts: [], timelines: [], events: [], initial: [] },
    shots: ["S1", "S2"].map((id, story_order) => ({ id, story_order, timeline_id: "T", duration_frames: 96, title: id, subject_usages: [], camera: { framing: "CU" } })),
    segments: [{ id: "C1", shot_ids: ["S1"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "理由甲" }, { id: "C2", shot_ids: ["S2"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "理由乙" }] } };

function Harness() {
    const [shot, setShot] = useState({ id: "S1", title: "窗外观察", duration_frames: 96, visual: "孩子扶着窗沿。", camera: { framing: "CU", path: "静止", attention_subject_ids: [], editorial_reason: "看清反应" }, subject_usages: [], keyframes: [], utterance_refs: [] });
    const [shotDraft, setShotDraft] = useState<string>();
    const [picture, setPicture] = useState({ provides: ["identity"], retain: ["脸部身份"], exclude: ["站姿"], applicableState: {} });
    const [pictureDraft, setPictureDraft] = useState<string>();
    const [ledger, setLedger] = useState<any>({ contract_version: 2, facts: [{ id: "F1", object_kind: "character", object_id: "P", display_name: "人物位置", property: "position", allowed_values: ["outside"], value_descriptions: { outside: "在窗外" } }], timelines: [{ id: "T" }], initial: [{ timeline_id: "T", fact_id: "F1", value: "outside" }], events: [], requirements: [], coverage: [] });
    const [ledgerDraft, setLedgerDraft] = useState<string>();
    const [records, setRecords] = useState<any>({});
    return <App><MemoryRouter><main className="space-y-8 p-6">
        <section data-testid="shot-editor"><button onClick={() => setShot(value => ({ ...value, title: "远端新名称" }))}>更新镜头名称</button><button onClick={() => setShot(value => ({ ...value, visual: "远端也修改了画面。" }))}>更新同一画面字段</button>
        <SubjectShotEditor shot={shot} source={{ fps_num: 24, fps_den: 1, subject_registry: [], utterances: [] }} canvasNodes={[]} canvasId="TEST" busy={false} draftValue={shotDraft} onDraftChange={setShotDraft} onSave={async (_id, patch) => { setRecords(value => ({ ...value, shot: patch })); return true; }} /></section>
        <section data-testid="picture-editor"><button onClick={() => setPicture(value => ({ ...value, exclude: ["站姿", "背景"] }))}>更新图片排除范围</button><PictureBindingEditor binding={picture} draftValue={pictureDraft} onDraftChange={setPictureDraft} busy={false} onSave={async patch => { setRecords(value => ({ ...value, picture: patch })); return true; }} /></section>
        <section data-testid="ledger-editor"><button onClick={() => setLedger((value: any) => ({ ...value, facts: value.facts.map((fact: any) => ({ ...fact, display_name: "远端新名称" })) }))}>更新事实名称</button>
        <ContinuityPanel ledger={ledger} sourceHash={JSON.stringify(ledger)} subjectAssembly draftValue={ledgerDraft} onDraftChange={setLedgerDraft} scenes={[]} shots={[]} segments={[]} boundaries={[]} characters={[{ id: "P", name: "孩子" }]} assets={[]} busy={false} editable onSave={async value => { setRecords(previous => ({ ...previous, ledger: value })); return true; }} onPreviewUpgrade={async () => ({})} onCheck={async () => {}} onLocate={() => {}} onBoundary={() => {}} /></section>
        <section data-testid="clip-editor"><SubjectStoryboardWorkbench director={clipDirector} production={{ draft: { director: clipDirector, clipGroups: [], keyframes: {}, keyframeReviews: {}, shots: [], scenes: [], settings: {} }, revision: 1 } as any} owner={{ projectId: "TEST_EFFICIENCY" }} canvasNodes={[]} renderEditor={() => <div />} clipEditor={<div />} busy={false} onRefresh={() => {}} onClip={() => {}} onDiscuss={() => {}} onNavigate={() => {}} onRepartitionClips={async (_ids, groups) => { setRecords(previous => ({ ...previous, clips: groups })); return true; }} /></section>
        <pre aria-label="保存记录">{JSON.stringify(records)}</pre>
    </main></MemoryRouter></App>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider><Harness /></ConfigProvider>);
