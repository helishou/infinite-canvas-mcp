import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { H3ClipSettingsPanel } from "../../plugins/canvas/minimax-h3/src/components/H3ClipSettingsPanel";
import { patchSelectedSegment } from "../../plugins/canvas/minimax-h3/src/services/h3-segment-utils";
import { patchAllH3Clips } from "../../plugins/canvas/minimax-h3/src/services/h3-global-settings";
import type { H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import { setDefaultParamsCache, useDefaultParams } from "../../plugins/canvas/minimax-h3/src/services/h3-defaults";
import { segmentsFor } from "../../plugins/canvas/minimax-h3/src/hooks/useH3Segments";
import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getAntThemeConfig } from "../src/lib/app-theme";
import "../src/i18n";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
let defaults: Record<string, unknown> = { videoSteps: 12, modelName: "default-model", megapixels: 0.4, denoise: 0.6 };
setDefaultParamsCache(defaults);

function Harness() {
    const liveDefaults = useDefaultParams();
    const [dark, setDark] = useState(false);
    const [failSave, setFailSave] = useState(false);
    const [, render] = useState(0);
    const writes = useRef<Record<string, unknown>[]>([]);
    const defaultWrites = useRef<Record<string, unknown>[]>([]);
    const flushes = useRef(0);
    const metadata = useRef<Record<string, unknown>>({ selectedSegmentId: "a", h3SettingsScope: "clip", nanFengExpandedSections: { sampling: true }, segments: [
        { id: "a", start: 0, duration: 5, prompt: "Untouched", motionContextEnabled: false },
        { id: "b", start: 5, duration: 5, prompt: "Editing B", h3ParameterPolicy: "defaults", videoSteps: 99, motionContextEnabled: false, tailFrameContinuation: false },
    ] });
    const node = { id: "h3", type: "minimax-h3:video", width: 1200, height: 1100, metadata: metadata.current };
    const ctx = {
        node, projectId: "h3-state-test", theme: canvasThemes[dark ? "dark" : "light"], scale: 1,
        getNode: () => ({ ...node, metadata: metadata.current }),
        updateMetadata: (patch: Record<string, unknown>) => { writes.current.push(structuredClone(patch)); metadata.current = { ...metadata.current, ...patch }; render(n => n + 1); },
        ai: { listModels: () => [], listLocalH3Models: async () => ({ models: [], loras: [], textEncoders: [], videoVaes: [], audioVaes: [], nanfeng: {} }) },
        storage: { get: async () => undefined, set: async () => {} },
        h3Defaults: {
            get: async () => defaults,
            set: async (settings: Record<string, unknown>) => { defaultWrites.current.push(settings); defaults = { ...settings, videoSteps: 17 }; return defaults; },
        },
        flush: async () => { flushes.current++; render(n => n + 1); if (failSave) throw new Error("测试：Backend 保存未确认"); },
    } as unknown as CanvasNodeContext;
    const selected = segmentsFor(metadata.current).find(clip => clip.id === "b")!;
    const saved = (metadata.current.segments as Record<string, unknown>[]).find(clip => clip.id === "b")!;
    const effective = resolveH3Runtime(saved, {}, metadata.current, liveDefaults).params;
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main style={{ padding: 20 }}>
        <button onClick={() => { defaults = { ...defaults, videoSteps: 16, denoise: 0.7 }; setDefaultParamsCache(defaults); }}>Update Backend defaults</button>
        <button onClick={() => setFailSave(value => !value)}>Toggle save failure</button>
        <button onClick={() => setDark(value => !value)}>Toggle theme</button>
        <div className="minimax-h3-node" style={{ width: 1100 }}><H3ClipSettingsPanel ctx={ctx} metadata={metadata.current} selected={selected} patchSelected={patch => patchSelectedSegment(ctx, { selectedSegmentId: "b" }, patch)} patchAllSettings={patch => ctx.updateMetadata(patchAllH3Clips(metadata.current, metadata.current.segments as H3Segment[], patch))} /></div>
        <output data-testid="state-evidence">{JSON.stringify({ saved: metadata.current.segments, effective, writes: writes.current, defaultWrites: defaultWrites.current, flushes: flushes.current })}</output>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
