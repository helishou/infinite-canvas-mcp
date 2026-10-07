import React, { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import type { CanvasNodeContext, CanvasTextTarget } from "@infinite-canvas/plugin-sdk";
import { H3ContentExact } from "../../plugins/canvas/minimax-h3/src/components/H3Workbench";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getAntThemeConfig } from "../src/lib/app-theme";
import "../src/i18n";
import "../src/styles/globals.css";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>');
const originalPrompt = "summary:\nOriginal compiled prompt.\n\ndetailed_description:\n[Shot 1] <Picture 1> Hero waits.\n\noverall_soundscape:\nWind.\n\nnon_diegetic_music:\nN/A";
const original = {
    id: "formal-clip", duration: 5, mode: "ref2va", prompt: originalPrompt,
    productionClipProjection: { targetId: "formal-target", inputHash: "original-compiled-input" },
    referenceBindings: [{ id: "board", assetId: "approved-board", label: "Approved storyboard", role: "storyboard", tags: [], enabled: true, usage: "reference", mediaType: "image", url: image, storageKey: "image:approved", sourceNodeId: "source-image" }],
};
const node = { id: "formal-h3", type: "minimax-h3:video", width: 3000, height: 1100, metadata: { segments: [original] } };
const source = { id: "source-image", type: "image", metadata: { content: image, storageKey: "image:new-source" } };
let text = { ready: true, pending: 0, blocked: false, error: "", text: originalPrompt };
let local: Record<string, unknown> = {};
const textListeners = new Set<() => void>();
const viewListeners = new Set<() => void>();
const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
const writes: Record<string, unknown>[] = [];
const runs: Array<{ command: unknown; prompt: string; referenceBindings: unknown }> = [];
let flushes = 0;
const emptySuggestions = { items: [], pending: 0, error: "" };
const subscribe = (listeners: Set<() => void>, callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
const promptDocument = { getSnapshot: () => text, subscribe: (callback: () => void) => subscribe(textListeners, callback), getDocumentId: () => "formal-document", flush: async () => {} };

function Editor() {
    const snapshot = useSyncExternalStore(promptDocument.subscribe, promptDocument.getSnapshot);
    return <textarea aria-label="Clip prompt" value={snapshot.text} style={{ width: "100%", height: 180 }} onChange={(event) => {
        node.metadata = { ...node.metadata, segments: node.metadata.segments.map(clip => ({ ...clip, prompt: event.target.value })) };
        text = { ...text, text: event.target.value };
        writes.push({ type: "manual-text", text: event.target.value });
        for (const notify of textListeners) notify();
    }} />;
}

function Harness() {
    const [dark, setDark] = useState(false);
    const [, render] = useState(0);
    const emit = (name: string, payload: unknown) => { for (const callback of eventListeners.get(name) || []) callback(payload); };
    const ctx = {
        projectId: "in-memory-formal", node, scale: 1, theme: canvasThemes[dark ? "dark" : "light"],
        getNode: (id: string) => id === node.id ? node : id === source.id ? source : undefined,
        getNodes: () => [node, source], getConnections: () => [], getUpstream: () => [], getDownstream: () => [], mediaUrl: () => image,
        on: (name: string, callback: (payload: unknown) => void) => { const listeners = eventListeners.get(name) || new Set(); eventListeners.set(name, listeners); listeners.add(callback); return () => { listeners.delete(callback); }; }, emit,
        updateMetadata: (patch: Record<string, unknown>) => { writes.push(patch); node.metadata = { ...node.metadata, ...patch }; render(value => value + 1); },
        view: { subscribe: (callback: () => void) => subscribe(viewListeners, callback), getSnapshot: () => local, update: (patch: Record<string, unknown>) => { local = { ...local, ...patch }; for (const notify of viewListeners) notify(); } },
        textDocument: (_target: CanvasTextTarget) => promptDocument,
        textSuggestions: () => ({ getSnapshot: () => emptySuggestions, subscribe: () => () => {} }),
        references: { list: async () => [] }, generationLogs: { list: async () => [] }, storage: { get: async () => undefined, set: async () => {} }, TextEditor: Editor,
        replaceText: async (_target: CanvasTextTarget, _documentId: string, before: string, next: string) => {
            if (before !== text.text) return false;
            writes.push({ type: "replace-text", text: next }); text = { ...text, text: next }; for (const notify of textListeners) notify(); return true;
        },
        flush: async () => { flushes++; },
        ai: { listModels: () => [], defaultModel: () => "", listLocalH3Models: async () => ({ models: [], loras: [], textEncoders: [], videoVaes: [], audioVaes: [], nanfeng: {} }), runCanvasGeneration: async (command: unknown) => { runs.push({ command, prompt: node.metadata.segments[0].prompt, referenceBindings: node.metadata.segments[0].referenceBindings }); render(value => value + 1); } },
    } as unknown as CanvasNodeContext;
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main style={{ padding: 20 }}>
        <button onClick={() => setDark(value => !value)}>Toggle theme</button>
        <button onClick={() => { emit("canvas:node-metadata-updated", { projectId: ctx.projectId, nodeIds: [source.id] }); render(value => value + 1); }}>Refresh source event</button>
        <button onClick={() => emit("minimax-h3:run", { nodeId: node.id, segmentId: original.id })}>Run Clip</button>
        <div className="minimax-h3-node" style={{ width: 3000, height: 1100 }}><H3ContentExact ctx={ctx} /></div>
        <output data-testid="formal-evidence">{JSON.stringify({ writes, runs, flushes, prompt: text.text, segment: node.metadata.segments[0] })}</output>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
