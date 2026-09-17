import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasCollaborativeText } from "../src/components/canvas/canvas-collaborative-text";
import { getCanvasTextSession, replaceCanvasText } from "../src/services/api/canvas-text";
import { getCanvasTextSuggestions } from "../src/services/api/canvas-text-suggestions";
import { connectCanvasRealtime } from "../src/services/api/canvas-realtime";
import type { CanvasTextTarget } from "../src/types/canvas-plugin";

// 仅供独立 Playwright 页面载入；不在应用入口/生产构建中引用。
const projectId = new URL(location.href).searchParams.get("projectId")!;
const root = createRoot(document.getElementById("root")!);
let target: CanvasTextTarget = { field: "globalPrompt" };
function mount(next = target) {
    target = next;
    root.render(<React.StrictMode><CanvasCollaborativeText
        projectId={projectId} target={target} autoFocus chips
        references={[{ label: "图片1", title: "场景参考图", kind: "image" }]}
        style={{ width: 600, height: 240, fontSize: 16 }}
    /></React.StrictMode>);
}
const realtime = connectCanvasRealtime(projectId, () => {}, () => {});
window.addEventListener("pagehide", () => realtime.close(), { once: true });
Object.assign(window, { canvasTextTest: {
    mount, session: () => getCanvasTextSession(projectId, target),
    suggestions: () => getCanvasTextSuggestions(projectId, target),
    replace: (id: string, expected: string, text: string) => replaceCanvasText(projectId, target, id, expected, text),
} });
mount();
