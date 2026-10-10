import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Input } from "antd";
import { MemoryRouter } from "react-router-dom";
import { WorkbenchCanvas } from "../src/pages/drama/workbench-canvas";
import { useWorkbenchCanvas } from "../src/lib/canvas/canvas-host";
import { ReferenceNodeLink } from "../src/pages/drama/reference-node-link";
import "../src/i18n";
import "../src/styles/globals.css";

function Editor({ changeOwner }: { changeOwner: () => void }) {
    const canvas = useWorkbenchCanvas()!;
    const [draft, setDraft] = useState("");
    return <main className="space-y-4 p-8">
        <Input aria-label="制作草稿" value={draft} onChange={event => setDraft(event.target.value)} />
        <Button onClick={() => canvas.hasCanvas ? canvas.restoreCanvas() : canvas.openCanvas({ projectId: "overlay-test-main" })}>{canvas.hasCanvas ? "展开画布" : "打开画布"}</Button>
        <ReferenceNodeLink sourceNode={{ projectId: "overlay-test-shared", nodeId: "overlay-test-shared-node" }} />
        <Button onClick={changeOwner}>切换制作对象</Button>
    </main>;
}
function Fixture() {
    const [owner, setOwner] = useState(0);
    return <ConfigProvider><App><MemoryRouter initialEntries={["/production?episodeId=fixture"]}><WorkbenchCanvas key={owner}><Editor changeOwner={() => setOwner(value => value + 1)} /></WorkbenchCanvas></MemoryRouter></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
