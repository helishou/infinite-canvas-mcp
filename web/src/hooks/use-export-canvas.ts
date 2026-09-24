import { useCallback } from "react";
import { App } from "antd";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { acquireCanvasTransfer, releaseCanvasTransfer, useCanvasTransfer } from "@/lib/canvas/canvas-transfer";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export function useExportCanvas() {
    const { message } = App.useApp();
    const transfer = useCanvasTransfer();
    const exportProjects = useCallback(async (projects: CanvasProject[], fileName?: string) => {
        if (!acquireCanvasTransfer("export")) return false;
        try {
            await exportCanvasProjects(projects, fileName);
            return true;
        } catch (error) {
            console.error(error);
            void message.error(error instanceof Error ? error.message : "画布导出失败");
            return false;
        } finally {
            releaseCanvasTransfer("export");
        }
    }, [message]);
    return { exportCanvasProjects: exportProjects, exporting: transfer === "export", busy: transfer !== null };
}
