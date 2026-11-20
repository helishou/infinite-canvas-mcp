import assert from "node:assert/strict";
import { after as afterAll, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { StudioSettingsTab, loadStudioSettings, type StudioProductionSettings } from "./studio-settings-tab";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

const originalConfig = useConfigStore.getInitialState().config;
afterAll(() => {
    // Zustand v5 的 SSR 快照取 getInitialState()，静态渲染测试必须还原初始对象。
    useConfigStore.getInitialState().config = originalConfig;
    useConfigStore.setState({ config: originalConfig });
});

function renderWith(modelFields: Record<string, unknown>, override: Partial<StudioProductionSettings> = {}) {
    const config = {
        ...originalConfig,
        channels: [{
            id: "engine-local", name: "本地引擎", baseUrl: "http://127.0.0.1:8300", apiKey: "", apiFormat: "openai", kind: "local",
            models: [{ name: "H3 测试", capability: "video", ...modelFields }],
        }],
    } as unknown as AiConfig;
    useConfigStore.setState({ config });
    useConfigStore.getInitialState().config = config;
    useCanvasStore.setState({ folders: [] } as never);
    const settings: StudioProductionSettings = { ...loadStudioSettings(null), videoModel: "engine-local::H3 测试", ...override };
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(StudioSettingsTab, {
        dramaId: "drama",
        settings,
        onChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        saving: false,
    })));
}

test("分辨率档位告警：未登记 videoResolutions 不告警；显式 [] 与具体档位按真值告警", () => {
    const unknown = renderWith({}, { videoResolution: "1080p" });
    assert.doesNotMatch(unknown, /data-studio-video-warning="resolution"/);

    const none = renderWith({ videoResolutions: [] }, { videoResolution: "1080p" });
    assert.match(none, /data-studio-video-warning="resolution"/);
    assert.match(none, /不提供可选分辨率/);

    const one = renderWith({ videoResolutions: ["720p"] }, { videoResolution: "1080p" });
    assert.match(one, /data-studio-video-warning="resolution"/);
    assert.match(one, /不支持 1080p 分辨率（可选 720p）/);

    const supported = renderWith({ videoResolutions: ["1080p", "720p"] }, { videoResolution: "1080p" });
    assert.doesNotMatch(supported, /data-studio-video-warning="resolution"/);
});

test("设置页显式登记提示词字数上限：字段可见，登记值可读，8000 明确标为参考默认", () => {
    const blank = renderWith({});
    assert.match(blank, /data-studio-prompt-max-chars/);
    assert.match(blank, /8000（影策参考默认）/);
    assert.match(blank, /不是本地模型实测值/);

    const registered = renderWith({ promptMaxChars: 8000 });
    assert.match(registered, /value="8000"/);
    assert.match(registered, /已登记 8000 字/);
});
