import { App } from "antd";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export function useExportCanvas() {
    const { message } = App.useApp();
    return async (projects: CanvasProject[], fileName?: string) => {
        try { await exportCanvasProjects(projects, fileName); }
        catch (error) { void message.error(error instanceof Error ? error.message : "画布导出失败"); }
    };
}
