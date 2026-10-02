import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { H3ReferenceModal } from "../../plugins/canvas/minimax-h3/src/components/H3ReferenceModal";
import { H3MaterialCard } from "../../plugins/canvas/minimax-h3/src/components/H3MaterialCard";
import { applyCharacterGroupEdits, refsForSegment } from "../../plugins/canvas/minimax-h3/src/services/h3-data";
import { characterGroupBindings, compileReferenceSubmission } from "../../canvas-agent/src/canvas/reference-contract";
import type { H3Segment } from "../../plugins/canvas/minimax-h3/src/types";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { canvasThemes } from "../src/lib/canvas-theme";

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
    id: "clip", mode: "ref2va", taskMode: "ref2va", prompt: "角色来自 <Picture 1>，场景来自 <Picture 2>。", h3CharacterGroups: { g: group },
    referenceBindings: [...characterGroupBindings(group), { id: "scene", assetId: "scene", label: "场景", role: "scene", mediaType: "image", url: image, storageKey: "image:scene", tags: [], enabled: true, usage: "reference" }],
};

function Harness() {
    const [segment, setSegment] = useState(initial);
    const [open, setOpen] = useState(false);
    const refs = refsForSegment(segment);
    const compiled = compileReferenceSubmission(project, { ...segment });
    const currentGroup = segment.h3CharacterGroups!.g;
    const ctx = { theme: canvasThemes.light, scale: 1, getNode: () => project.nodes[0], mediaUrl: () => image, openMediaPreview: () => {}, references: { list: async () => [] } } as unknown as CanvasNodeContext;
    return <main style={{ margin: 24 }}>
        <h1>H3 reference compatibility · in-memory test</h1>
        <button onClick={() => setOpen(true)}>编辑角色参考</button>
        <div aria-label="参考卡" style={{ display: "flex", gap: 16 }}>
            {refs.map((ref) => <div key={ref.bindingId} data-media-key={ref.storageKey}><H3MaterialCard ctx={ctx} ref={ref} locale="zh-CN" /></div>)}
        </div>
        <pre aria-label="验证结果">{JSON.stringify({
            cards: refs.map((ref) => ref.storageKey), submitted: compiled.references.map((ref) => ref.storageKey),
            prompt: segment.prompt, compiledPrompt: compiled.compiledPrompt, outfitEnabled: currentGroup.outfitEnabled,
            selected: currentGroup.outfits.map((outfit) => outfit.enabled),
        })}</pre>
        {open ? <H3ReferenceModal ctx={ctx} refItem={refs.find((ref) => ref.groupId === "g")!} group={currentGroup} characters={[]}
            onApply={(_ref, patch) => { if (patch) setSegment((old) => applyCharacterGroupEdits(old, "g", patch)); setOpen(false); }}
            onClose={() => setOpen(false)} onReplaceFromCanvas={() => {}} onRemoveRef={() => {}} onRemoveStoryboardImage={() => {}} /> : null}
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
