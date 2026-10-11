import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { initializeCanvasDraftSession } from "../src/lib/canvas/canvas-draft-session";
import { H3ClipCard } from "../../plugins/canvas/minimax-h3/src/components/H3ClipCard";
import { compactSegmentStarts } from "../../plugins/canvas/minimax-h3/src/hooks/useH3Segments";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getAntThemeConfig } from "../src/lib/app-theme";
import "../src/styles/globals.css";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

await initializeCanvasDraftSession();
const { diffCanvasProject, applyBackendCanvasDelta, detectCanvasConflicts } = await import("../src/stores/canvas/use-canvas-store");
Object.assign(window, { InfiniteCanvasRuntime: { React } });
const initial = compactSegmentStarts([{ id: "a", duration: 5, prompt: "A" }, { id: "b", duration: 5, prompt: "B" }] as H3Segment[]);
const project = (segments: H3Segment[]) => ({ id: "fixture", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments } }], connections: [] }) as any;
function Harness() {
    const [segments, setSegments] = useState(initial);
    const [operations, setOperations] = useState<any[]>([]);
    const [dark, setDark] = useState(false);
    const [verified, setVerified] = useState(false);
    const update = (next: H3Segment[]) => {
        const before = project(segments);
        const after = project(next);
        const ops = diffCanvasProject(before, after);
        const replayed = applyBackendCanvasDelta(before, ops);
        setVerified(detectCanvasConflicts(ops, before, before).length === 0 && JSON.stringify(replayed.nodes[0].metadata.segments) === JSON.stringify(next));
        setOperations(ops);
        setSegments(next);
    };
    const ctx = { projectId: "fixture", node: { id: "h3", metadata: { segments } }, scale: 1, theme: canvasThemes[dark ? "dark" : "light"], updateMetadata: (patch: any) => { if (patch.segments) update(patch.segments); } } as unknown as CanvasNodeContext;
    return <ConfigProvider theme={getAntThemeConfig(dark)}><main style={{ padding: 24, background: dark ? "#222" : "#fafafa", color: dark ? "#eee" : "#222" }}>
        <button onClick={() => setDark(!dark)}>Theme</button>
        <button onClick={() => update(compactSegmentStarts(segments.map((s) => s.id === "a" ? { ...s, duration: 8 } : s)))}>Duration A = 8</button>
        <button onClick={() => update(compactSegmentStarts([...segments.slice(0, 1), { id: "c", prompt: "C", duration: 3 }, ...segments.slice(1)]))}>Insert C</button>
        <div className="minimax-tl-track" style={{ position: "relative", width: 1800, height: 150 }}>{segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segments={segments} segment={segment} index={index} fmt={String} />)}</div>
        <pre data-testid="segments">{JSON.stringify(segments.map(({ id, start, duration }) => ({ id, start, duration })))}</pre>
        <pre data-testid="operations">{JSON.stringify(operations)}</pre>
        <output data-testid="verified">{String(verified)}</output>
    </main></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
