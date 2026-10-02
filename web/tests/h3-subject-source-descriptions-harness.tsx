import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import { H3PromptSection } from "../../plugins/canvas/minimax-h3/src/components/H3PromptSection";
import { canvasThemes } from "../src/lib/canvas-theme";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
const thumb = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="${color}"/><circle cx="40" cy="25" r="12" fill="white"/><path d="M20 60 Q40 20 60 60" fill="white"/></svg>`)}`;
const baseRefs: H3Ref[] = [
    { type: "image", bindingId: "face", assetId: "face", role: "character_identity", url: thumb("#658791"), name: "脸部与发型参考", enabled: true, usage: "reference", subjectId: "hero" },
    { type: "image", bindingId: "body", assetId: "body", role: "character_turnaround", url: thumb("#957e6b"), name: "服装与蛇身形态参考", enabled: true, usage: "reference", subjectId: "hero" },
];
const bindingsFor = (refs: H3Ref[]) => refs.map((ref) => ({ id: ref.bindingId!, assetId: ref.assetId!, label: ref.name, role: ref.role!, tags: [], enabled: true, usage: "reference" as const, mediaType: ref.type, url: ref.url, subjectId: "hero" }));
const snapshot = { ready: true, pending: 0, blocked: false, error: "", text: "subject_definitions:\n<Subject 1> is 苏青璃. Identity from <Picture 1> and <Picture 2>.\n\nsummary:\nOne shot.\n\ndetailed_description:\n[Shot 1] 苏青璃 looks toward the camera.\n\noverall_soundscape:\nWind.\n\nnon_diegetic_music:\nN/A" };
const promptDocument = { getSnapshot: () => snapshot, getDocumentId: () => "in-memory-doc", subscribe: () => () => {}, flush: async () => {} };
const suggestionSnapshot = { items: [], pending: 0, error: "" };
function Harness() {
    const [dark, setDark] = useState(true);
    const [refs, setRefs] = useState(baseRefs);
    const [segment, setSegment] = useState<H3Segment>({ id: "clip", mode: "ref2va", duration: 5, prompt: snapshot.text, referenceBindings: bindingsFor(baseRefs), subjectDefinitions: [{ id: "hero", name: "苏青璃", pictures: ["<Picture 1>", "<Picture 2>"], profile: "旧主体整体说明", outfits: [] }] });
    const [view, setView] = useState<Record<string, unknown>>({});
    const segmentRef = useRef(segment);
    segmentRef.current = segment;
    const patchSegment = (patch: Partial<H3Segment>) => {
        segmentRef.current = { ...segmentRef.current, ...patch };
        setSegment(segmentRef.current);
    };
    const node = { id: "test-h3", type: "minimax-h3:video", metadata: { segments: [segment], selectedSegmentId: segment.id } };
    const ctx = {
        node, projectId: "in-memory-test", theme: dark ? canvasThemes.dark : canvasThemes.light,
        getNode: (id: string) => id === node.id ? { ...node, metadata: { ...node.metadata, segments: [segmentRef.current] } } : undefined, getNodes: () => [],
        flush: async () => {},
        updateMetadata: (patch: { segments?: H3Segment[] }) => { if (patch.segments?.[0]) patchSegment(patch.segments[0]); },
        replaceText: async (_target: unknown, _id: string, expected: string, next: string) => {
            if (snapshot.text !== expected) return false;
            snapshot.text = next;
            patchSegment({ prompt: next });
            return true;
        },
        textDocument: () => promptDocument,
        textSuggestions: () => ({ getSnapshot: () => suggestionSnapshot, subscribe: () => () => {} }),
        references: { list: async () => [] },
        view: { getSnapshot: () => view, update: (patch: Record<string, unknown>) => setView((v) => ({ ...v, ...patch })) },
        ai: { listModels: () => [], defaultModel: () => "" },
        TextEditor: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => <textarea value={value ?? snapshot.text} onChange={(e) => onChange?.(e.target.value)} />,
    } as unknown as CanvasNodeContext;
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <main style={{ minHeight: "100vh", padding: 24, background: dark ? "#242320" : "#f5f4f1", color: dark ? "#e8e5df" : "#292722", fontFamily: "sans-serif" }}>
            <style>{"*,*::before,*::after{box-sizing:border-box}"}</style>
            <h1>每个视觉来源分别描述</h1>
            <p>内存测试页：编辑后关闭再打开；交换参考顺序后，描述应跟随来源。</p>
            <button onClick={() => setDark((v) => !v)}>切换测试主题</button>
            <button onClick={() => { const next = [...refs].reverse(); setRefs(next); patchSegment({ referenceBindings: bindingsFor(next) }); }}>交换来源顺序</button>
            <H3PromptSection ctx={ctx} selected={segment} imageRefs={refs} videoRefs={[]} audioRefs={[]} patchSelected={patchSegment} onOpenStoryboard={() => {}} />
            <pre aria-label="保存证据">{JSON.stringify(segment.subjectDefinitions, null, 2)}</pre>
            <pre aria-label="提示词证据">{segment.prompt}</pre>
        </main>
    </ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
