import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import i18n from "../src/i18n";
import "../src/styles/globals.css";

// Every request stays in this fixture; no real channel, session or media task is modified.
const submitted: unknown[] = [];
window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const payload = url.pathname === "/config" ? { ok: true, token: "fixture-token" }
        : url.pathname === "/agent/codex/models" ? { ok: true, data: [{ model: "native-fixture" }, { model: "hidden-fixture", hidden: true }] }
        : url.pathname === "/canvas/generation" ? (() => { submitted.push(JSON.parse(String(init?.body))); return { ok: true, taskId: "cli-fixture", executor: "direct-text" }; })()
        : url.pathname.endsWith("/tasks/cli-fixture") ? { ok: true, task: { id: "cli-fixture", status: "succeeded", result: { texts: [{ content: "CLI fixture result" }] } } }
        : { ok: true, config: null, settings: {} };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};

async function mount() {
    const { ChannelEditorDrawer } = await import("../src/components/layout/channel-editor-drawer");
    const { createModelChannel, defaultConfig } = await import("../src/stores/use-config-store");
    const { requestImageQuestion } = await import("../src/services/api/image");
    await i18n.changeLanguage("zh-CN");
    function Harness() {
        const [channel, setChannel] = useState(() => createModelChannel({ id: "cli-test", name: "Codex test" }));
        const [open, setOpen] = useState(true), [dark, setDark] = useState(false), [answer, setAnswer] = useState("");
        const [, redraw] = useState(0);
        return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App><main className={`${dark ? "dark bg-slate-950 text-white" : "bg-white text-slate-900"} min-h-screen p-4`}>
            <button onClick={() => setOpen(true)}>Open</button><button onClick={() => setDark(!dark)}>Theme</button><button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN").then(() => redraw(value => value + 1))}>Language</button>
            <button onClick={() => void requestImageQuestion({ ...defaultConfig, channels: [channel], model: "cli-test::native-fixture", textModel: "cli-test::native-fixture" }, [{ role: "user", content: [{ type: "text", text: "描述图片" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] }], setAnswer).then(() => redraw(value => value + 1))}>Request text</button>
            <ChannelEditorDrawer open={open} channel={channel} onSave={setChannel} onClose={() => setOpen(false)} />
            <output data-testid="channel">{JSON.stringify(channel)}</output><output data-testid="answer">{answer}</output><output data-testid="submitted">{JSON.stringify(submitted)}</output>
        </main></App></ConfigProvider>;
    }
    createRoot(document.getElementById("root")!).render(<Harness />);
}
void mount();
