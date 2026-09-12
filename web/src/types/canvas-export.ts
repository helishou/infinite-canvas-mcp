import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasExportFile = {
    app: "infinite-canvas";
    version: 3 | 4;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

export type CanvasProjectExportItem = {
    project: CanvasProject;
    files: CanvasExportAsset[];
    logs?: Array<Record<string, unknown>>;
    taskSummaries?: Array<Record<string, unknown>>;
};

export type CanvasExportAsset = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
    sha256?: string;
};
