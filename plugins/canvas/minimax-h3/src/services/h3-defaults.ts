// 生成参数由 Backend 持久化（权威）；这里仅保留当前页面内存缓存，供同步的节点工厂读取。
// localStorage 旧 key（STORAGE_KEY）只由 Host 用于一次性迁移旧版本数据，不再作为生成参数读取路径。
// 「设为默认参数」的布局快照（节点宽高 + 各模块区域宽高）是浏览器本地视图设置：
// 不参与 Backend 生成参数集合，单独持久化在 LAYOUT_KEY（跨刷新/重启保留，与参数迁移互不干扰），
// 读取生成参数时剥掉 layout，避免混进 segment。
const LAYOUT_KEY = "minimax-h3-default-layout";
let cachedPayload: StoredPayload | null = null;

export interface StoredH3Defaults {
    type: "minimax-h3-settings";
    version: number;
    settings: Record<string, unknown>;
}

// 随默认参数保存的布局键：与 H3_PANE_META 的 metadataKey 一一对应。
export const H3_DEFAULT_LAYOUT_PANE_KEYS = ["minimaxPreviewH", "minimaxPreviewW", "minimaxPromptW", "minimaxTimelineH", "minimaxRefLaneH"];

export type H3DefaultLayout = { width?: number; height?: number; panes?: Record<string, number> };

type StoredPayload = { type?: string; version?: number; settings?: Record<string, unknown> };

export function setDefaultParamsCache(settings: Record<string, unknown>): void {
    cachedPayload = { type: "minimax-h3-settings", version: 2, settings };
}

if (typeof window !== "undefined") {
    window.addEventListener("minimax-h3-defaults-updated", (event) => {
        const settings = (event as CustomEvent<Record<string, unknown>>).detail;
        if (settings && typeof settings === "object") setDefaultParamsCache(settings);
    });
}

export function readDefaultParams(): Record<string, unknown> {
    const payload = cachedPayload;
    if (!payload) return {};
    // layout 是布局子对象，不是生成参数，剥掉再返回，避免混进 segment。
    const { layout: _layout, ...rest } = payload.settings as Record<string, unknown>;
    return rest;
}

export function readDefaultLayout(): H3DefaultLayout {
    // 布局持久化在独立 localStorage key（刷新后内存缓存为空，这里仍能恢复），
    // 内存缓存里若也带 layout（本页刚保存过）则优先用缓存，两者同源。
    let source: { width?: unknown; height?: unknown; panes?: Record<string, unknown> } | null = null;
    const cached = (cachedPayload as { settings?: Record<string, unknown> } | null)?.settings?.layout;
    if (cached && typeof cached === "object") source = cached;
    else {
        try {
            if (typeof localStorage !== "undefined") {
                const raw = localStorage.getItem(LAYOUT_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown; panes?: Record<string, unknown> };
                    if (parsed && typeof parsed === "object") source = parsed;
                }
            }
        } catch {
            source = null;
        }
    }
    if (!source) return {};
    const layout = source as H3DefaultLayout;
    const panesRaw = layout.panes && typeof layout.panes === "object" ? (layout.panes as Record<string, unknown>) : {};
    const panes: Record<string, number> = {};
    for (const key of H3_DEFAULT_LAYOUT_PANE_KEYS) {
        const value = Number(panesRaw[key]);
        if (Number.isFinite(value) && value > 0) panes[key] = value;
    }
    const result: H3DefaultLayout = {};
    const width = Number(layout.width);
    const height = Number(layout.height);
    if (Number.isFinite(width) && width > 0) result.width = width;
    if (Number.isFinite(height) && height > 0) result.height = height;
    if (Object.keys(panes).length) result.panes = panes;
    return result;
}

export function writeDefaultParams(settings: Record<string, unknown>): void {
    setDefaultParamsCache(settings);
    // 布局快照单独立户持久化（跨刷新保留）；没有 layout 时不动存储，避免清掉旧快照。
    const layout = settings.layout as { width?: unknown; height?: unknown; panes?: Record<string, unknown> } | undefined;
    if (layout && typeof layout === "object" && typeof localStorage !== "undefined") {
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
        } catch {
            // 隐私模式 / 配额满等场景无法写入，布局快照丢失可回退内置默认，忽略。
        }
    }
}

export function clearDefaultParams(): void {
    cachedPayload = null;
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(LAYOUT_KEY);
    } catch {
        // 忽略
    }
}
