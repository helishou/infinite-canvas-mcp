import { create } from "zustand";

import { fetchSettings, saveSettings } from "@/services/settings-api";
import { defaultImageQuickToolIds, normalizeImageQuickToolIds, type ImageQuickToolId } from "@/components/canvas/canvas-image-toolbar-tools";

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
        saveTimer = setTimeout(() => { saveTimer = null; void saveSettings({ imageQuickTools: { ...config, version: 2 } }); }, 500);
    },
}));

async function hydrate() {
    const settings = await fetchSettings();
    if (settings.imageQuickTools) {
        const data = settings.imageQuickTools as Partial<ImageQuickToolsConfig> & { version?: number };
        const savedIds = Array.isArray(data.ids) ? normalizeImageQuickToolIds(data.ids) : defaultImageQuickToolIds;
        const version = Number(data.version) || 1;
        const ids = version < 2 ? normalizeImageQuickToolIds([...savedIds, "autoLevels"]) : savedIds;
        const showLabels = data.showLabels === true;
        useImageQuickToolsStore.setState({ ids, showLabels });
        if (version < 2) void saveSettings({ imageQuickTools: { ids, showLabels, version: 2 } });
    }
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => { void hydrate(); });
}
