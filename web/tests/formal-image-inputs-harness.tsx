import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { initializeCanvasDraftSession } from "@/lib/canvas/canvas-draft-session";
import type { ProductionImageInput } from "@basketikun/canvas-agent/reference-contract";
import type { CanvasNodeData } from "@/types/canvas";
import "@/styles/globals.css";

await initializeCanvasDraftSession();
const [{ CanvasNodeReferenceBar }, { buildNodeGenerationContext }, { getNodeImageReferenceCount }, { useBackendStore }, { useThemeStore }, { getAntThemeConfig }, { default: i18n }] = await Promise.all([
    import("@/components/canvas/canvas-node-reference-bar"), import("@/components/canvas/canvas-node-generation"), import("@/components/canvas/canvas-node-image-reference-count"),
    import("@/stores/use-backend-store"), import("@/stores/use-theme-store"), import("@/lib/app-theme"), import("@/i18n"),
]);
useBackendStore.setState({ url: window.location.origin, connected: true, token: "fixture" });
const ids = ["CUIZI", "SHUANZI", "NEIGHBOR", "COURTYARD", "STYLE"];
const base: ProductionImageInput = { schemaVersion: 1, targetId: "FRAME", sourceNodeId: "source", sourceHash: "a".repeat(64), promptHash: "b".repeat(64), inputHash: "c".repeat(64),
    references: ids.map((id, index) => ({ label: `<Picture ${index + 1}>`, nodeId: id, assetId: id, assetVersion: "v1", storageKey: `image:fixture-${index}`, sha256: String(index).repeat(64), role: index < 3 ? "identity" : index === 3 ? "scene" : "style" })) };
function Harness() {
    const [input, setInput] = useState(base), [event, setEvent] = useState(""), [language, setLanguage] = useState("zh-CN");
    const theme = useThemeStore(state => state.theme);
    const nodes: CanvasNodeData[] = [...ids.map(id => ({ id, type: "character", title: id, position: { x: 0, y: 0 }, width: 340, height: 260,
        metadata: { characterImages: [{ storageKey: "image:wrong-extra-outfit" }, { storageKey: "image:wrong-primary" }], characterPrimaryIndex: 1 } })),
        { id: "source", type: "config", title: "Shot", position: { x: 0, y: 0 }, width: 340, height: 160, metadata: { smart: true, generationMode: "image", productionImageInput: input } },
        { id: "frame", type: "image", title: "Output", position: { x: 0, y: 0 }, width: 340, height: 260, metadata: { content: "wrong previous result", productionImageInput: input } }];
    const context = buildNodeGenerationContext("frame", nodes, [], "Complete approved prompt");
    return <ConfigProvider theme={getAntThemeConfig(theme === "dark")}><App><main className="mx-auto max-w-md p-4">
        <CanvasNodeReferenceBar nodeId="frame" nodes={nodes} connectedNodes={[]} reorderableSourceNodeIds={new Set(ids)}
            onReorder={(from, over) => { setEvent(`order:${from}:${over}`); const refs = [...input.references], start = refs.findIndex(ref => ref.nodeId === from), end = refs.findIndex(ref => ref.nodeId === over); refs.splice(end, 0, refs.splice(start, 1)[0]); setInput({ ...input, references: refs.map((ref, i) => ({ ...ref, label: `<Picture ${i + 1}>` })) }); }}
            onDisconnect={(from, to) => { setEvent(`remove:${from}:${to}`); setInput({ ...input, references: input.references.filter(ref => ref.nodeId !== from), stale: true }); }}
            onStartSelection={target => setEvent(`pick:${target}`)} />
        <output aria-label="context">{JSON.stringify(context)}</output><output aria-label="count">{getNodeImageReferenceCount(nodes.at(-1)!, nodes, [], context.prompt)}</output><output aria-label="event">{event}</output>
        <button onClick={() => useThemeStore.setState({ theme: theme === "dark" ? "light" : "dark" })}>theme</button>
        <button onClick={() => { const next = language === "zh-CN" ? "en-US" : "zh-CN"; setLanguage(next); void i18n.changeLanguage(next); }}>language</button>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
