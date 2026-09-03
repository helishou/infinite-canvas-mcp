/** 前端配置的读写 API（数据存储在 backend 的 settings.json）。 */
import { request } from "./backend-api";

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
