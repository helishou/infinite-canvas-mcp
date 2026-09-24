// 生成参数由 Backend 持久化（权威）；这里仅保留当前页面内存缓存，供同步的节点工厂读取。
// localStorage 旧 key（STORAGE_KEY）只由 Host 用于一次性迁移旧版本数据，不再作为生成参数读取路径。
// 「设为默认参数」的布局快照（节点宽高 + 各模块区域宽高）随默认参数一起保存：Host 注入的
// settings.layout 是主来源（跨浏览器/客户端一致），localStorage LAYOUT_KEY 只作兜底副本；
// 读取生成参数时仍剥掉 layout，避免混进 segment。
import { readH3Layout } from "../../../../../canvas-agent/src/plugins/minimax-h3/node-factory";

const LAYOUT_KEY = "minimax-h3-default-layout";
let cachedPayload: StoredPayload | null = null;
let cachedLayoutPanes: Record<string, number> | null = null;

export interface StoredH3Defaults {
    type: "minimax-h3-settings";
    version: number;
    settings: Record<string, unknown>;
}

export type H3DefaultLayout = { width?: number; height?: number; panes?: Record<string, number> };

type StoredPayload = { type?: string; version?: number; settings?: Record<string, unknown> };

export function setDefaultParamsCache(settings: Record<string, unknown>): void {
    cachedPayload = { type: "minimax-h3-settings", version: 2, settings };
    cachedLayoutPanes = null;
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
    // 布局快照两处同源同结构：内存缓存（本页刚保存过，或 Host 从后端默认参数灌进来的 layout）
    // 优先；缓存为空（刷新后）再读 localStorage 副本。校验统一走 readH3Layout，脏值丢弃。
    let source: unknown = null;
    const cached = (cachedPayload as { settings?: Record<string, unknown> } | null)?.settings?.layout;
    if (cached && typeof cached === "object") source = cached;
    else {
        try {
            if (typeof localStorage !== "undefined") {
                const raw = localStorage.getItem(LAYOUT_KEY);
                if (raw) source = JSON.parse(raw);
            }
        } catch {
            source = null;
        }
    }
    const { width, height, panes } = readH3Layout(source);
    const result: H3DefaultLayout = {};
    if (width !== undefined) result.width = width;
    if (height !== undefined) result.height = height;
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
    cachedLayoutPanes = null;
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(LAYOUT_KEY);
    } catch {
        // 忽略
    }
}

// 默认布局里的模块宽高：节点自己还没有任何布局值时的初值（渲染路径每帧都要读，这里做一层缓存）。
export function readDefaultLayoutPanes(): Record<string, number> {
    cachedLayoutPanes ??= readDefaultLayout().panes || {};
    return cachedLayoutPanes;
}
