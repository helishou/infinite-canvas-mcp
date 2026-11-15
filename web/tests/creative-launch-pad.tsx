import React from "react";
import { createRoot } from "react-dom/client";
import { App as AntdApp, ConfigProvider } from "antd";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

import { CreativeLaunchPad } from "../src/pages/home/creative-launch-pad";
import { useAgentStore } from "../src/stores/use-agent-store";
import { useAssetStore } from "../src/stores/use-asset-store";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import "../src/i18n";
import "../src/styles/globals.css";

const now = "2026-01-01T00:00:00.000Z";
const image = (id: string, title: string) => ({
    id, kind: "image", title, coverUrl: "", tags: [id], source: "", note: "", createdAt: now, updatedAt: now,
    data: { dataUrl: `data:image/png;base64,${id}`, storageKey: `img/${id}`, width: 320, height: 180, bytes: 1024, mimeType: "image/png" },
});
const assets = [
    ...["a1", "a2", "a3", "a4", "a5", "a6"].map((id, index) => image(id, `测试图片-${index + 1}`)),
    {
        id: "v1", kind: "video", title: "测试视频", coverUrl: "", tags: [], source: "", note: "", createdAt: now, updatedAt: now,
        data: { url: "/media/test.mp4", storageKey: "vid/v1", width: 640, height: 360, bytes: 2048, mimeType: "video/mp4" },
    },
    {
        id: "c1", kind: "character", title: "测试角色", coverUrl: "", tags: [], source: "", note: "", createdAt: now, updatedAt: now,
        data: {
            name: "角色", englishName: "", description: "", voice: "", voiceName: "", voiceDescription: "", voiceAssetId: "", primaryIndex: 0,
            images: [{ url: "/media/char.png", storageKey: "char/c1", name: "正面", width: 300, height: 400, bytes: 900, mimeType: "image/png", outfit: "", outfitDescription: "" }],
        },
    },
    {
        id: "s1", kind: "audio", title: "测试音频", coverUrl: "", tags: [], source: "", note: "", createdAt: now, updatedAt: now,
        data: { url: "/media/test.wav", storageKey: "aud/s1", bytes: 512, mimeType: "audio/wav" },
    },
];

// 纯内存替换：不调用 addAsset / createProject，不写 localforage、不写后端、不碰真实 Agent 草稿。
useAssetStore.setState({ assets: assets as never, hydrated: true });
useCanvasStore.setState({
    hydrated: true,
    projects: [],
    createProject: (title?: string) => {
        (window as unknown as Record<string, unknown>).__createdTitle = title || "";
        return "TEST_CANVAS_ID";
    },
});
useAgentStore.setState({
    setAgentState: (patch: Record<string, unknown>) => { (window as unknown as Record<string, unknown>).__agentPatch = patch; },
    openPanel: () => { (window as unknown as Record<string, unknown>).__panelOpened = true; },
});

function CanvasRoute() {
    const { id } = useParams();
    return <output data-test-route>{id}</output>;
}

function Harness() {
    return (
        <ConfigProvider>
            <AntdApp>
                <MemoryRouter initialEntries={["/"]}>
                    <Routes>
                        <Route path="/" element={<main className="p-6"><CreativeLaunchPad /></main>} />
                        <Route path="/canvas/:id" element={<CanvasRoute />} />
                    </Routes>
                </MemoryRouter>
            </AntdApp>
        </ConfigProvider>
    );
}

createRoot(document.getElementById("root")!).render(<Harness />);
