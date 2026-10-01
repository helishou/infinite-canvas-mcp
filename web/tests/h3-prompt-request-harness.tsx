import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { H3PromptSection } from "../../plugins/canvas/minimax-h3/src/components/H3PromptSection";
import { canvasThemes } from "../src/lib/canvas-theme";
import type { CanvasNodeContext, CanvasTextTarget } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../../plugins/canvas/minimax-h3/src/types";

// Independent test page: model and candidate writes stay in memory.
Object.assign(window, { InfiniteCanvasRuntime: { React } });
const segments: H3Segment[] = [
    { id: "a", mode: "ref2va", prompt: "CLIP_A_ONLY: bridge fight", duration: 8 },
    { id: "b", mode: "i2v", prompt: "CLIP_B_ONLY: pond dialogue", duration: 5 },
];
const documents = Object.fromEntries(segments.map((segment) => {
    const snapshot = { ready: true, pending: 0, blocked: false, error: "", text: segment.prompt! };
    return [segment.id, { getSnapshot: () => snapshot, getDocumentId: () => `document-${segment.id}`, subscribe: () => () => {}, flush: async () => {} }];
}));
const suggestionSnapshot = { items: [], pending: 0, error: "" };
const requests: Array<{ segmentId?: string; prompt: string; system?: string }> = [];
const writes: Array<{ segmentId: string; kind: string; documentId: string; base: string }> = [];
let finishModel: (() => void) | undefined;
let view: Record<string, unknown> = {};

function Harness() {
    const [selectedId, setSelectedId] = useState("a");
    const [, render] = useState(0);
    const [earlyEnhance, setEarlyEnhance] = useState(false);
    const container = useRef<HTMLDivElement>(null);
    const selected = segments.find((segment) => segment.id === selectedId)!;
    const node = { id: "test-h3", type: "minimax-h3:video", metadata: { segments, selectedSegmentId: selectedId } };
    const ctx = {
        node, projectId: "in-memory-test", theme: canvasThemes.light,
        getNode: () => node, getNodes: () => [],
        textDocument: (target: CanvasTextTarget) => documents[target.segmentId!],
        textSuggestions: (target: CanvasTextTarget) => ({
            getSnapshot: () => suggestionSnapshot, subscribe: () => () => {},
            save: async (input: { documentId: string; base: string }) => {
                writes.push({ segmentId: target.segmentId!, kind: "save", documentId: input.documentId, base: input.base }); render((n) => n + 1);
            },
            apply: async (_id: string, documentId: string, base: string) => {
                if (documentId !== `document-${target.segmentId}`) throw new Error("Candidate document belongs to another Clip");
                writes.push({ segmentId: target.segmentId!, kind: "apply", documentId, base }); render((n) => n + 1);
            },
        }),
        references: { list: async () => [] },
        view: { getSnapshot: () => view, update: (patch: Record<string, unknown>) => { view = { ...view, ...patch }; render((n) => n + 1); } },
        TextEditor: ({ target }: { target: CanvasTextTarget }) => <textarea aria-label="Current Clip text" value={documents[target.segmentId!].getSnapshot().text} readOnly />,
        ai: {
            listModels: () => [{ value: "mock-model", label: "In-memory mock" }], defaultModel: () => "mock-model",
            generateText: (prompt: string, options: { system?: string; log?: { segmentId?: string } }) => {
                requests.push({ segmentId: options.log?.segmentId, prompt, system: options.system }); render((n) => n + 1);
                return new Promise((resolve) => { finishModel = () => resolve({ text: "Enhanced Clip B", taskId: "mock-task" }); });
            },
        },
    } as unknown as CanvasNodeContext;
    useLayoutEffect(() => {
        if (!earlyEnhance || selectedId !== "b") return;
        const button = [...container.current!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "增强提示词");
        button!.click();
        setEarlyEnhance(false);
    }, [earlyEnhance, selectedId]);
    return <main style={{ maxWidth: 900, margin: "24px auto", fontFamily: "sans-serif" }}>
        <h1>H3 prompt request regression · Selected Clip {selectedId.toUpperCase()}</h1>
        <p>In-memory model; no production data or paid requests.</p>
        <button onClick={() => { setSelectedId("b"); setEarlyEnhance(true); }}>Switch to B and enhance before passive effects</button>
        <button onClick={() => setSelectedId("a")}>Switch to A while B is running</button>
        <button onClick={() => finishModel?.()}>Finish mock model</button>
        <div ref={container}><H3PromptSection ctx={ctx} selected={selected} imageRefs={[]} videoRefs={[]} audioRefs={[]} patchSelected={() => {}} onOpenStoryboard={() => {}} /></div>
        <pre aria-label="Request and candidate evidence">{JSON.stringify({
            selectedId,
            requests: requests.map((request) => ({ segmentId: request.segmentId, containsA: request.prompt.includes("CLIP_A_ONLY"), containsB: request.prompt.includes("CLIP_B_ONLY"), modeB: request.system?.includes("I2VA"), durationB: request.system?.includes("5.00 seconds") })),
            writes,
        }, null, 2)}</pre>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
