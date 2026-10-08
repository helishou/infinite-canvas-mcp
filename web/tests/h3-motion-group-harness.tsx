import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { H3ClipCard } from "../../plugins/canvas/minimax-h3/src/components/H3ClipCard";
import { H3ClipSettingsPanel } from "../../plugins/canvas/minimax-h3/src/components/H3ClipSettingsPanel";
import { H3Runner } from "../../plugins/canvas/minimax-h3/src/components/H3Runner";
import { segmentsFor } from "../../plugins/canvas/minimax-h3/src/hooks/useH3Segments";
import { patchSelectedSegment } from "../../plugins/canvas/minimax-h3/src/services/h3-segment-utils";
import { setDefaultParamsCache } from "../../plugins/canvas/minimax-h3/src/services/h3-defaults";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getAntThemeConfig } from "../src/lib/app-theme";
import "../src/i18n";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
setDefaultParamsCache({ motionContextEnabled: false });
function Harness() {
    const [dark, setDark] = useState(false);
    const [, render] = useState(0);
    const metadata = useRef<Record<string, unknown>>({ selectedSegmentId: "a", segments: [
        { id: "a", duration: 5, mode: "t2v", prompt: "A", motionContextEnabled: true },
        { id: "b", duration: 5, mode: "t2v", prompt: "B", motionContextEnabled: false },
        { id: "outside", duration: 5, mode: "t2v", prompt: "Outside", motionContextEnabled: false },
    ] });
    const calls = useRef<unknown[]>([]);
    const flushes = useRef(0);
    const handlers = useRef(new Map<string, Set<(value: unknown) => void>>());
    const node = { id: "h3", type: "minimax-h3:video", metadata: metadata.current };
    const ctx = {
        projectId: "motion-fixture", node, scale: 1, theme: canvasThemes[dark ? "dark" : "light"],
        getNode: () => ({ ...node, metadata: metadata.current }), openPanel() {},
        updateMetadata(patch: Record<string, unknown>) { metadata.current = { ...metadata.current, ...patch }; render(n => n + 1); },
        flush: async () => { flushes.current++; },
        emit(name: string, value: unknown) { handlers.current.get(name)?.forEach(handler => handler(value)); },
        on(name: string, handler: (value: unknown) => void) {
            if (!handlers.current.has(name)) handlers.current.set(name, new Set());
            handlers.current.get(name)!.add(handler);
            return () => handlers.current.get(name)!.delete(handler);
        },
        ai: {
            listModels: () => [], listLocalH3Models: async () => ({ models: [], loras: [], textEncoders: [], videoVaes: [], audioVaes: [], nanfeng: {} }),
            runCanvasGeneration: async (command: unknown) => { calls.current.push(command); render(n => n + 1); },
        },
        storage: { get: async () => undefined, set: async () => {} },
    } as unknown as CanvasNodeContext;
    const clips = segmentsFor(metadata.current);
    const selected = clips.find(clip => clip.id === metadata.current.selectedSegmentId)!;
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main style={{ padding: 20, background: dark ? "#222" : "#fafafa", color: dark ? "#eee" : "#222" }}>
        <button onClick={() => setDark(!dark)}>Theme</button>
        <div style={{ position: "relative", width: 1500, height: 140 }}>{clips.map((clip, index) => <H3ClipCard key={clip.id} ctx={ctx} segment={clip} index={index} segments={clips} selectedId={selected.id} fmt={String} />)}</div>
        <div style={{ width: 850 }}><H3ClipSettingsPanel ctx={ctx} metadata={metadata.current} selected={selected} patchSelected={patch => patchSelectedSegment(ctx, metadata.current, patch)} patchAllSettings={() => {}} /></div>
        <H3Runner ctx={ctx} />
        <output data-testid="evidence">{JSON.stringify({ calls: calls.current, flushes: flushes.current })}</output>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
