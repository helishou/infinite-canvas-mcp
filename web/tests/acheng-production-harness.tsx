import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import { DirectorPanel } from "../src/pages/drama/director-panel";
import i18n from "../src/i18n";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import "../src/styles/globals.css";

const hash = "a".repeat(64);
const initial: DirectorProduction = {
    schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "4.3.9" },
    source: { fps_num: 24, fps_den: 1, shots: [{ id: "s1", start_frame: 0, end_frame: 120 }, { id: "s2", start_frame: 120, end_frame: 240 }], segments: [{ id: "SEG1", shot_ids: ["s1"], start_frame: 0, end_frame: 120, generation_clip_duration: 5 }, { id: "SEG2", shot_ids: ["s2"], start_frame: 120, end_frame: 240, generation_clip_duration: 5 }] },
    sourceHash: hash, modules: { story: { status: "committed", evidence: [], unresolved: [] } }, assets: {}, shotInputs: {}, boundaries: [{ from: "SEG1", to: "SEG2", tailFrame: false, motionContext: false, reason: "Same action, new view" }],
    artifacts: [{ id: "a", targetId: "SEG1", kind: "h3", prompt: "Complete original prompt — never summarized", sha256: hash, sourceHash: hash, status: "ready", references: [], receipt: { sourceHash: hash, promptHash: hash, engineRuntimeId: "test", validator: "test" } }],
    executionAuthorized: false, unresolved: [], workflow: {},
};
function Harness() {
    const [director, setDirector] = useState(initial), [dark, setDark] = useState(false), [locale, setLocale] = useState("zh-CN");
    const [saves, setSaves] = useState(0), [published, setPublished] = useState(0);
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><main className="p-8">
        <button onClick={() => setDark(!dark)}>theme</button><button onClick={() => { const next = locale === "zh-CN" ? "en-US" : "zh-CN"; setLocale(next); void i18n.changeLanguage(next); }}>language</button>
        <DirectorPanel director={director} busy={false} onSave={async d => { setDirector(d); setSaves(n => n + 1); }} onPublish={() => setPublished(n => n + 1)} />
        <output aria-label="evidence">{JSON.stringify({ saves, published, director })}</output>
    </main></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
