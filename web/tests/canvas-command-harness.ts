// 静态导入让 Vite 使用与真实页面一致的 HMR 模块 URL；测试不可绕过版本后缀另建 Store。
export { useCanvasStore, hydrateCanvasProjects, ensureCanvasProjectLoaded, flushCanvasSyncNow, getCanvasAcknowledgedRevision } from "../src/stores/canvas/use-canvas-store";
export { useConfigStore } from "../src/stores/use-config-store";
export { getBackendUrl } from "../src/services/backend-api";
export { getCanvasTextSession } from "../src/services/api/canvas-text";
export { getCanvasTextSuggestions } from "../src/services/api/canvas-text-suggestions";
export { canvasDraftPersistence } from "../src/lib/canvas/canvas-draft-persistence";
