import { create } from "zustand";

import type { CanvasMediaPreview } from "@/types/canvas-plugin";

/**
 * 全局唯一的媒体预览入口：画布节点、插件素材、素材库、提示词库、Agent 附件等
 * 任何位置的「放大预览」都通过这里打开同一个宿主弹窗（MediaPreviewHost）。
 */
type MediaPreviewRequest = { item: CanvasMediaPreview; projectId?: string };

type MediaPreviewState = {
    request: MediaPreviewRequest | null;
    open: (item: CanvasMediaPreview, options?: { projectId?: string }) => void;
    close: () => void;
};

export const useMediaPreviewStore = create<MediaPreviewState>((set) => ({
    request: null,
    open: (item, options) => set({ request: { item, projectId: options?.projectId } }),
    close: () => set({ request: null }),
}));

// 开发期排查用：浏览器控制台可直接读 window.__mediaPreviewStore.getState()。
if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__mediaPreviewStore = useMediaPreviewStore;
}
