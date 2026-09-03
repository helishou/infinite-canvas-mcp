import { create } from "zustand";

import { fetchSettings, saveSettings } from "@/services/settings-api";
import { defaultImageQuickToolIds, type ImageQuickToolId } from "@/components/canvas/canvas-image-toolbar-tools";

export type ImageQuickToolsConfig = {
    ids: ImageQuickToolId[];
    showLabels: boolean;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

type ImageQuickToolsStore = {
    ids: ImageQuickToolId[];
    showLabels: boolean;
    setConfig: (config: ImageQuickToolsConfig) => void;
};

export const useImageQuickToolsStore = create<ImageQuickToolsStore>((set) => ({
    ids: defaultImageQuickToolIds,
    showLabels: false,
    setConfig: (config) => {
        set({ ids: config.ids, showLabels: config.showLabels });
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; void saveSettings({ imageQuickTools: config }); }, 500);
    },
}));

async function hydrate() {
    const settings = await fetchSettings();
    if (settings.imageQuickTools) {
        const data = settings.imageQuickTools as Partial<ImageQuickToolsConfig>;
        const ids = Array.isArray(data.ids) ? (data.ids as ImageQuickToolId[]) : defaultImageQuickToolIds;
        const showLabels = data.showLabels === true;
        set({ ids, showLabels });
    }
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => { void hydrate(); });
}
