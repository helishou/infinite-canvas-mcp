import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import type { CanvasNodeContext, CanvasTextTarget, GenerateTextOptions } from "@infinite-canvas/plugin-sdk";
import { H3PromptSection } from "../../plugins/canvas/minimax-h3/src/components/H3PromptSection";
import { h3ThemeVars } from "../../plugins/canvas/minimax-h3/src/h3-theme";
import type { H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import { canvasThemes } from "../src/lib/canvas-theme";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
const longPrompt = [
    "subject_definitions:", "<Subject 1> is Alex.", "", "detailed_description:",
    ...Array.from({ length: 20 }, (_, index) => `  [Shot ${index + 1}] <Picture 1> ${"Camera follows the hero. ".repeat(50)}`),
    "", "overall_soundscape:", "Final wind sound.", "", "non_diegetic_music:", "N/A",
].join("\n");
const segments: H3Segment[] = [
    { id: "a", mode: "ref2va", duration: 8, prompt: longPrompt },
    { id: "b", mode: "i2v", duration: 5, prompt: "summary:\nB takes a breath.\n\nnon_diegetic_music:\nN/A" },
];
const snapshots = Object.fromEntries(segments.map((segment) => [segment.id, { ready: true, pending: 0, blocked: false, error: "", text: segment.prompt! }]));
const documents = Object.fromEntries(segments.map((segment) => [segment.id, {
    getSnapshot: () => snapshots[segment.id], getDocumentId: () => `translation-${segment.id}`, subscribe: () => () => {}, flush: async () => {},
}]));
const suggestions = { items: [], pending: 0, error: "" };
const requests: Array<{ segmentId?: string; prompt: string; aborted: boolean }> = [];
const pending: Array<() => void> = [];
const translate = (text: string) => text.replaceAll("Camera follows the hero.", "镜头跟随主角。").replace("Final wind sound.", "最终风声。").replace("B takes a breath.", "B深吸一口气。").replace("<Subject 1> is Alex.", "<Subject 1>是Alex。");

function Harness() {
    const [selectedId, setSelectedId] = useState("a");
    const [dark, setDark] = useState(false);
    const [mode, setMode] = useState("success");
    const [view, setView] = useState<Record<string, unknown>>({});
    const [, render] = useState(0);
    const selected = segments.find((segment) => segment.id === selectedId)!;
    const node = { id: "translation-h3", type: "minimax-h3:video", metadata: { segments, selectedSegmentId: selectedId } };
    const ctx = {
        node, projectId: "in-memory-translation", theme: dark ? canvasThemes.dark : canvasThemes.light,
        getNode: () => node, getNodes: () => [],
        textDocument: (target: CanvasTextTarget) => documents[target.segmentId!],
        textSuggestions: () => ({ getSnapshot: () => suggestions, subscribe: () => () => {}, save: async () => { throw new Error("Translation must not write a candidate"); } }),
        references: { list: async () => [] },
        view: { getSnapshot: () => view, update: (patch: Record<string, unknown>) => setView((previous) => ({ ...previous, ...patch })) },
        TextEditor: ({ target }: { target: CanvasTextTarget }) => <textarea aria-label="Original prompt" readOnly value={snapshots[target.segmentId!].text} />,
        ai: {
            listModels: () => [{ value: "mock-text", label: "In-memory translation" }], defaultModel: () => "mock-text",
            generateText: async (prompt: string, options?: GenerateTextOptions) => {
                const request = { segmentId: options?.log?.segmentId, prompt, aborted: false };
                requests.push(request);
                options?.signal?.addEventListener("abort", () => { request.aborted = true; render((value) => value + 1); }, { once: true });
                render((value) => value + 1);
                if (mode === "hold") await new Promise<void>((resolve) => pending.push(resolve));
                const source = JSON.parse(prompt).source as Array<{ id: number; text: string }>;
                if (mode === "refusal" && source.some((record) => record.text.startsWith("[Shot 2]"))) return { text: "（原文过长，超出单次回复长度限制，无法在单次回复中完整输出翻译。）" };
                return { text: JSON.stringify({ translations: source.map(({ id, text }) => ({ id, text: translate(text) })) }), taskId: `mock-${requests.length}` };
            },
        },
    } as unknown as CanvasNodeContext;
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <main style={{ maxWidth: 900, margin: "24px auto", color: dark ? "#eee" : "#222", background: dark ? "#171717" : "white", fontFamily: "sans-serif" }}>
            <h1>H3 prompt translation regression</h1>
            <p>In-memory model and documents; no Backend data or paid requests.</p>
            <button onClick={() => setDark((value) => !value)}>Toggle theme</button>
            <select aria-label="Model scenario" value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="success">Success</option><option value="refusal">Length refusal</option><option value="hold">Hold response</option>
            </select>
            <button onClick={() => setSelectedId((id) => id === "a" ? "b" : "a")}>Switch Clip</button>
            <button onClick={() => { snapshots[selectedId] = { ...snapshots[selectedId], text: "summary:\nEdited prompt." }; render((value) => value + 1); }}>Edit source</button>
            <button onClick={() => pending.shift()?.()}>Finish next response</button>
            <div className="minimax-h3-node" style={{ ...h3ThemeVars(ctx.theme), padding: 12 }}><H3PromptSection ctx={ctx} selected={selected} imageRefs={[]} videoRefs={[]} audioRefs={[]} patchSelected={() => { throw new Error("Translation must not write the source"); }} onOpenStoryboard={() => {}} /></div>
            <output data-testid="translation-evidence">{JSON.stringify({ selectedId, requests: requests.map(({ segmentId, prompt, aborted }) => ({ segmentId, length: prompt.length, aborted })), sourceUnchanged: snapshots.a.text === longPrompt })}</output>
        </main>
    </ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
