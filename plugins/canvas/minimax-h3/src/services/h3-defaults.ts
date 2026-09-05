// 永久默认参数：把「设为默认参数」按钮当前节点的生成参数持久化到浏览器 localStorage，
// 供新建 H3 节点时作为初始参数（见 node-definition.ts 的 defaultMetadata getter）。
// 仅保存生成类参数（与导出/导入同一套键），不含 prompt 文本。
const STORAGE_KEY = "minimax-h3-default-params";

export interface StoredH3Defaults {
    type: "minimax-h3-settings";
    version: number;
    settings: Record<string, unknown>;
}

export function readDefaultParams(): Record<string, unknown> {
    try {
        if (typeof localStorage === "undefined") return {};
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Partial<StoredH3Defaults>;
        if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
            return parsed.settings as Record<string, unknown>;
        }
    } catch {
        // 解析失败（如手动改坏）时静默忽略，回退到内置默认。
    }
    return {};
}

export function writeDefaultParams(settings: Record<string, unknown>): void {
    try {
        if (typeof localStorage === "undefined") return;
        const payload: StoredH3Defaults = { type: "minimax-h3-settings", version: 1, settings };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // 隐私模式 / 配额满等场景无法写入，忽略即可。
    }
}

export function clearDefaultParams(): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 忽略
    }
}
