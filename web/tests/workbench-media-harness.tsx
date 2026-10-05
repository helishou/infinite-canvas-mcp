import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkbenchMediaPreview } from "../src/pages/home/workbench-media";
import { useProjectCoverResults } from "../src/pages/home/use-workbench-data";
import { useBackendStore } from "../src/stores/use-backend-store";
import "../src/styles/globals.css";

useBackendStore.setState({ connected: true });
const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } } });
function Covers() {
    const cover = useProjectCoverResults([["fast", "v1"], ["slow", "v1"]]);
    return <output data-testid="covers">{JSON.stringify([cover("fast", "v1"), cover("slow", "v1")])}</output>;
}
function Harness() {
    const [controls, setControls] = useState(false);
    const [covers, setCovers] = useState(true);
    return <>
        <button onClick={() => setControls((value) => !value)}>Toggle original</button>
        <button onClick={() => setCovers((value) => !value)}>Toggle covers</button>
        {covers && <Covers />}
        <div data-testid="image" style={{ width: 320, height: 180 }}><WorkbenchMediaPreview media={{ kind: "image", storageKey: "image:large" }} label="Large" controls={controls} /></div>
        <div data-testid="missing" style={{ width: 320, height: 180 }}><WorkbenchMediaPreview media={{ kind: "image", storageKey: "image:missing" }} label="Missing" /></div>
        <div style={{ height: 4000 }} />
        <div data-testid="offscreen" style={{ width: 320, height: 180 }}><WorkbenchMediaPreview media={{ kind: "video", storageKey: "video:offscreen" }} label="Video" /></div>
    </>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><Harness /></QueryClientProvider></StrictMode>);
