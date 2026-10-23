import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { H3ReferenceModal } from "../../plugins/canvas/minimax-h3/src/components/H3ReferenceModal";
import { H3Timeline } from "../../plugins/canvas/minimax-h3/src/components/H3Timeline";
import { H3MaterialCard } from "../../plugins/canvas/minimax-h3/src/components/H3MaterialCard";
import { applyCharacterGroupEdits, refsForSegment, withSegmentRefs } from "../../plugins/canvas/minimax-h3/src/services/h3-data";
import { characterGroupBindings, compileReferenceSubmission } from "../../canvas-agent/src/canvas/reference-contract";
import type { H3Ref, H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getAntThemeConfig } from "../src/lib/app-theme";
import { h3ThemeVars } from "../../plugins/canvas/minimax-h3/src/h3-theme";
import "../src/i18n";
import "../src/styles/globals.css";
import "../../plugins/canvas/minimax-h3/src/styles/h3.css";

Object.assign(window, { InfiniteCanvasRuntime: { React } });
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>');
const group = {
    id: "g", characterName: "角色", characterNodeId: "hero", characterAssetId: "hero-asset", subjectId: "hero",
    outfitEnabled: true, voiceEnabled: true, voice: { name: "声线", url: "data:audio/wav;base64,", storageKey: "audio:voice" },
    outfits: [{ id: "outfit", name: "常服", role: "character_turnaround" as const, url: image, storageKey: "image:hero", enabled: true }],
};
const project = { nodes: [{ id: "hero", type: "character", metadata: {
    characterName: "角色", characterAssetId: "hero-asset", characterImages: [{ url: image, storageKey: "image:hero", outfit: "常服", role: "character_turnaround" }],
} }] };
const initial: H3Segment = {
    id: "clip", duration: 10, mode: "ref2va", taskMode: "ref2va", prompt: "角色来自 <Picture 1>，场景来自 <Picture 2>。", h3CharacterGroups: { g: group },
    referenceBindings: [{ id: "scene", assetId: "scene", label: "场景", role: "scene", mediaType: "image", url: image, storageKey: "image:scene", tags: [], enabled: true, usage: "reference" }, ...characterGroupBindings(group),
        { id: "smart", assetId: "smart", label: "智能生成", role: "character_turnaround", mediaType: "image", url: image, storageKey: "image:smart", tags: [], enabled: true, usage: "reference" }],
};

function Harness() {
    const [segment, setSegment] = useState(initial);
    const [editingId, setEditingId] = useState<string>();
    const [refresh, setRefresh] = useState(false);
    const [tick, setTick] = useState(0);
    const [dark, setDark] = useState(false);
    const dragEvents = useRef<string[]>([]);
    const [lastDrag, setLastDrag] = useState<string[]>([]);
    useEffect(() => {
        if (!refresh) return;
        const timer = setInterval(() => setTick(value => value + 1), 250);
        return () => clearInterval(timer);
    }, [refresh]);
    const refs = refsForSegment(segment);
    const compiled = compileReferenceSubmission(project, { ...segment });
    const currentGroup = segment.h3CharacterGroups!.g;
    const ctx = { node: { id: "h3", metadata: { segments: [segment] } }, theme: canvasThemes[dark ? "dark" : "light"], scale: 1, getNode: (id: string) => project.nodes.find(node => node.id === id), getNodes: () => project.nodes, mediaUrl: () => image, openMediaPreview: () => {}, references: { list: async () => [] }, updateMetadata: () => {}, h3Defaults: { get: async () => ({}) } } as unknown as CanvasNodeContext;
    const editingRef = refs.find(ref => ref.bindingId === editingId);
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main style={{ margin: 24 }}>
        <h1>H3 reference compatibility · in-memory test</h1>
        <button onClick={() => setEditingId(refs.find(ref => ref.groupId === "g")!.bindingId)}>编辑角色参考</button>
        <button onClick={() => setEditingId("smart")}>编辑普通参考</button>
        <button onClick={() => setDark(value => !value)}>切换主题</button>
        <label><input type="checkbox" checked={refresh} onChange={event => setRefresh(event.target.checked)} />模拟父界面持续刷新</label>
        <output aria-label="刷新次数">{tick}</output>
        <output aria-label="拖拽事件">{JSON.stringify(lastDrag)}</output>
        <div aria-label="参考卡" style={{ display: "flex", gap: 16 }}>
            {refs.map((ref) => <div key={ref.bindingId} data-media-key={ref.storageKey}><H3MaterialCard ctx={ctx} ref={ref} locale="zh-CN" /></div>)}
        </div>
        <pre aria-label="验证结果">{JSON.stringify({
            cards: refs.map((ref) => ref.storageKey), submitted: compiled.references.map((ref) => ref.storageKey),
            prompt: segment.prompt, compiledPrompt: compiled.compiledPrompt, outfitEnabled: currentGroup.outfitEnabled,
            selected: currentGroup.outfits.map((outfit) => outfit.enabled),
            order: refs.map(ref => ref.bindingId), roles: refs.map(ref => ref.role),
            referenceOrder: segment.referenceOrder,
        })}</pre>
        <style>{`.reference-regression .minimax-edit-timeline { height: 560px; } .reference-regression .minimax-ref-row { flex-basis: 330px; }`}</style>
        <div className="minimax-canvas-workbench reference-regression" style={{ ...h3ThemeVars(ctx.theme), position: "relative", width: 1300, height: 600 }} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
            onDragStartCapture={() => { dragEvents.current = ["start"]; }} onDragOverCapture={() => { if (dragEvents.current.at(-1) !== "over") dragEvents.current.push("over"); }} onDropCapture={() => { dragEvents.current.push("drop"); }} onDragEndCapture={() => { setLastDrag([...dragEvents.current, "end"]); }}>
            <H3Timeline ctx={ctx} segments={[segment]} selected={segment} total={10} onRemoveRef={() => {}} onEditRef={(_id, ref) => setEditingId(ref.bindingId)} onRequestReplaceRef={() => {}} onRequestPickRef={() => {}} onRequestPickStoryboardShot={() => {}} onSegmentChange={setSegment} onPlayAll={() => {}} fmt={String} />
            {editingRef ? <H3ReferenceModal key={editingRef.bindingId} ctx={ctx} refItem={editingRef} group={editingRef.groupId ? currentGroup : undefined} characters={[]}
                onApply={(next: H3Ref, patch) => { setSegment(old => patch ? applyCharacterGroupEdits(old, "g", patch) : withSegmentRefs(old, refsForSegment(old).map(ref => ref.bindingId === next.bindingId ? next : ref))); setEditingId(undefined); }}
                onClose={() => setEditingId(undefined)} onReplaceFromCanvas={() => {}} onRemoveRef={() => {}} onRemoveStoryboardImage={() => {}} /> : null}
        </div>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
