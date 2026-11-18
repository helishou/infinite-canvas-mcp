/** 前端配置的读写 API（结构化数据统一存储在 backend SQLite）。 */
import { request } from "./backend-api";

export type StructuredSettingScope = "webdav" | "prompt-sources" | "custom-prompts" | "image-workbench-references" | "engine";

/** 独立执行引擎（media-engine）配置：填了 url 画布的图片/视频生成改走引擎的 OpenAI 协议。 */
export type EngineSetting = { url?: string; token?: string };

export type FrontendSettings = {
    /** Individual keys let concurrent windows pin different projects without replacing a shared list. */
    [key: `homePinnedProject:${string}`]: boolean | undefined;
    /** 导演运行时渠道：hermes(acp) 或 codex(原生)。设置页只管切这个，模型由对话面板决定。 */
    agentEngine?: "hermes" | "codex";
    /** 每个渠道上次选用的模型，作为该渠道新对话的初始模型。 */
    agentModelByEngine?: Partial<Record<"hermes" | "codex", string>>;
    agentModel?: string;
    agentReasoningEffort?: string;
    agentPermissionMode?: string;
    agentPanelWidth?: number;
    canvasSidePanelWidth?: number;
    canvasSidePanelOpen?: boolean;
    canvasSidePanelNodeView?: "list" | "grid";
    locale?: string;
    imageQuickTools?: Record<string, unknown>;
};

export async function fetchSettings(): Promise<FrontendSettings> {
    try {
        const data = await request<{ ok: boolean; settings: FrontendSettings }>("GET", "/settings");
        return data.settings ?? {};
    } catch {
        return {};
    }
}

export async function saveSettings(patch: Partial<FrontendSettings>): Promise<void> {
    await request<{ ok: boolean }>("PATCH", "/settings", patch);
}

export async function fetchStructuredSetting<T>(scope: StructuredSettingScope): Promise<T | null> {
    const data = await request<{ ok: boolean; value: T | null }>("GET", `/settings/data/${scope}`);
    return data.value ?? null;
}

export async function saveStructuredSetting<T>(scope: StructuredSettingScope, value: T): Promise<void> {
    await request<{ ok: boolean }>("PUT", `/settings/data/${scope}`, { value });
}
