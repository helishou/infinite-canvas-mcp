/** 前端配置的读写 API（结构化数据统一存储在 backend SQLite）。 */
import { request } from "./backend-api";

export type StructuredSettingScope = "webdav" | "prompt-sources" | "custom-prompts" | "image-workbench-references";

export type FrontendSettings = {
    agentModel?: string;
    agentReasoningEffort?: string;
    agentPermissionMode?: string;
    agentPanelWidth?: number;
    canvasSidePanelWidth?: number;
    canvasSidePanelOpen?: boolean;
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
