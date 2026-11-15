import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App as AntdApp, ConfigProvider } from "antd";

import { WorkspaceViewSwitcher } from "../src/components/production/workspace-view-switcher";
import type { WorkspaceViewMode } from "../src/components/production/workspace-view-switcher-model";
import "../src/i18n";
import "../src/styles/globals.css";

function Harness() {
    const [mode, setMode] = useState<WorkspaceViewMode>("production");
    const [events, setEvents] = useState<string[]>([]);
    return (
        <ConfigProvider>
            <AntdApp>
                <output data-test-mode>{mode}</output>
                <output data-test-events>{JSON.stringify(events)}</output>
                {mode === "canvas" && <div data-test-overlay className="fixed inset-0 z-[900] bg-background/80" />}
                <main className="p-8"><h1>制作台内容</h1><p>画布是全屏 overlay，切换器应始终浮在其上。</p></main>
                <WorkspaceViewSwitcher mode={mode} onSelect={next => { setEvents(value => [...value, next]); setMode(next); }} />
            </AntdApp>
        </ConfigProvider>
    );
}

// harness 不挂 AppProviders，手动切到项目默认暗色，截图才与真实工作台一致。
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")!).render(<Harness />);
