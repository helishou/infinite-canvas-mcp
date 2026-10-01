import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import { MediaPreviewModal } from "../src/components/canvas/media-preview-modal";
import { getAntThemeConfig } from "../src/lib/app-theme";
import i18n from "../src/i18n";
import "../src/styles/globals.css";

// Independent UI harness: no requests reach the user's Backend or canvas.
// Fixture preparation from repository root:
// ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -t 4 -c:v libx264 -y .tmp/canvas-trim-fixture.mp4
const originalFetch = window.fetch.bind(window);
let taskStatus = "running";
const submissions: Record<string, unknown>[] = [];
const fixture = new URL("../../.tmp/canvas-trim-fixture.mp4", import.meta.url).href;
let update: () => void = () => {};
window.fetch = async (url, init) => {
    const parsed = new URL(String(url), window.location.origin);
    if (parsed.pathname === "/canvas/generation") {
        submissions.push(JSON.parse(String(init?.body)));
        taskStatus = "running";
        update();
        return Response.json({ ok: true, taskId: "test-trim", executor: "trim" });
    }
    if (parsed.pathname.includes("/tasks/test-trim")) {
        if (parsed.pathname.endsWith("/cancel")) { taskStatus = "cancelled"; update(); }
        return Response.json({ ok: true, task: { id: "test-trim", kind: "canvas-video", status: taskStatus, result: { media: [] } } });
    }
    if (parsed.pathname === "/media/upload-binary") return Response.json({ ok: true, media: { storageKey: "test-video", mimeType: "video/mp4" } });
    if (parsed.pathname === new URL(fixture).pathname) return originalFetch(url, init);
    throw new Error(`Harness blocked unexpected request: ${parsed.pathname}`);
};

function Harness() {
    const [open, setOpen] = useState(true);
    const [video, setVideo] = useState(1);
    const [dark, setDark] = useState(false);
    const [english, setEnglish] = useState(false);
    const [, render] = useState(0);
    update = () => render((n) => n + 1);
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App>
        <div style={{ padding: 24 }}>
            <Button onClick={() => setOpen(true)}>Open preview</Button>
            <Button onClick={() => setVideo((n) => n === 1 ? 2 : 1)}>Switch video</Button>
            <Button onClick={() => { setEnglish(!english); void i18n.changeLanguage(english ? "zh-CN" : "en-US"); }}>Language</Button>
            <Button onClick={() => setDark(!dark)}>Theme</Button>
            <Button onClick={() => { taskStatus = "succeeded"; update(); }}>Finish trim</Button>
            <output data-testid="submissions">{JSON.stringify({ count: submissions.length, status: taskStatus, latest: submissions.at(-1) })}</output>
        </div>
        <MediaPreviewModal projectId="test-only-project" item={open ? { type: "video", url: `${fixture}?video=${video}`, name: `Test video ${video}` } : null} onClose={() => setOpen(false)} />
    </App></ConfigProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
