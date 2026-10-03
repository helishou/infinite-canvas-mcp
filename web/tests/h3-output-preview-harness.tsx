import React, { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import type { CanvasNodeContext, CanvasMediaPreview } from "@infinite-canvas/plugin-sdk";
import { H3MaterialLibrary } from "../../plugins/canvas/minimax-h3/src/components/H3MaterialLibrary";
import type { H3Ref, H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import { MediaPreviewModal } from "../src/components/canvas/media-preview-modal";
import { getAntThemeConfig } from "../src/lib/app-theme";
import { canvasThemes } from "../src/lib/canvas-theme";
import i18n from "../src/i18n";
import "../src/styles/globals.css";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
const fixture = "/__h3_output_fixture__.mp4";
const outputs: H3Ref[] = [
    { type: "video", url: "old-a", storageKey: "a", name: "Output A", segmentId: "clip-a" },
    { type: "video", url: "old-b", storageKey: "b", name: "Output B", segmentId: "clip-b" },
    { type: "video", url: "old-c", storageKey: "c", name: "Output C", segmentId: "clip-a" },
];
const segments = [{ id: "clip-a", prompt: "keep this prompt", duration: 4, status: "success", result: "old-a", results: [outputs[0]] }, { id: "clip-b", prompt: "keep B", duration: 4, status: "success", result: "old-b" }] as H3Segment[];
const logs = { list: async () => [] };
function Harness() {
    const [preview, setPreview] = useState<CanvasMediaPreview | null>(null);
    const [writes, setWrites] = useState<Record<string, unknown>[]>([]);
    const [restores, setRestores] = useState(0);
    const [dark, setDark] = useState(false);
    const ctx = useMemo(() => ({
        projectId: "fixture", node: { id: "h3", type: "minimax-h3:video", metadata: { segments } }, scale: 1,
        theme: canvasThemes[dark ? "dark" : "light"], mediaUrl: (key: string) => `${fixture}?output=${key}`,
        generationLogs: logs, updateMetadata: (patch: Record<string, unknown>) => setWrites((items) => [...items, patch]),
        openMediaPreview: setPreview, ai: { restoreH3Output: async () => setRestores((value) => value + 1) },
    }) as unknown as CanvasNodeContext, [dark]);
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App>
        <main style={{ padding: 24 }}>
            <style>{".h3-output-fixture > .minimax-library { height: 220px; }"}</style>
            <Button onClick={() => setPreview({ url: `${fixture}?output=single`, type: "video", name: "Single preview" })}>Single preview</Button>
            <Button onClick={() => { setDark((value) => !value); void i18n.changeLanguage("en-US"); }}>English dark</Button>
            <div className="minimax-canvas-workbench h3-output-fixture" style={{ display: "block", width: 1100, height: 300, marginTop: 20 }}>
                <H3MaterialLibrary ctx={ctx} outputs={outputs} segments={segments} selected={segments[0]} patchSelected={() => { throw new Error("Preview must not edit Clips"); }} />
            </div>
            <output data-testid="evidence">{JSON.stringify({ writes, restores, segments })}</output>
        </main>
        <MediaPreviewModal item={preview} projectId="fixture" onClose={() => setPreview(null)} />
    </App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
