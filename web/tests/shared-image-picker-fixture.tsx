import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import { SubjectShotEditor } from "../src/pages/drama/subject-shot-editor";
import "../src/i18n";
import "../src/styles/globals.css";
const assets = { adopted: { version: "v1", status: "approved", sharedSource: { sourceProjectId: "picker-shared", sourceNodeId: "same", dramaId: "drama", assetId: "original", approvedId: "accepted" } } };
const nodes = [{ id: "same", title: "同名图片", type: "config", metadata: { smart: true, generationMode: "image" } }];
function Fixture() {
    const [draft, setDraft] = useState<string>(), [saved, setSaved] = useState<unknown>();
    const [shot, setShot] = useState<any>({ id: "S1", title: "镜头", duration_frames: 96, visual: "院落中的动作。", camera: { framing: "CU" }, subject_usages: [], keyframes: [] });
    return <ConfigProvider><App><MemoryRouter><main className="p-8"><SubjectShotEditor shot={shot} source={{ fps_num: 24, fps_den: 1, subject_registry: [], ledger: {}, asset_plan: [{ asset_id: "adopted", asset_name: "同名图片" }] }} canvasNodes={nodes} assets={assets} canvasId="picker-current" busy={false} draftValue={draft} onDraftChange={setDraft} onSave={async (_id, patch, frames) => { setSaved({ patch, frames }); setShot((current: any) => ({ ...current, ...patch, ...(frames ? { keyframes: frames } : {}) })); return true; }} /><pre aria-label="保存内容">{JSON.stringify(saved)}</pre></main></MemoryRouter></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
