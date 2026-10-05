import { create } from "zustand";

import { fetchSettings, saveSettings } from "@/services/settings-api";
import { useAgentStore } from "@/stores/use-agent-store";

export const CANVAS_SIDE_PANEL_MOTION_MS = 500;
export const CANVAS_SIDE_PANEL_MIN_WIDTH = 220;
export const CANVAS_SIDE_PANEL_MAX_WIDTH = 480;
export const CANVAS_SIDE_PANEL_DEFAULT_WIDTH = 280;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

type CanvasSidePanelStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    nodeSearchFocusRequest: number;
    setWidth: (width: number) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    focusNodeSearch: () => void;
    clearNodeSearchFocusRequest: (request: number) => void;
};

export const useCanvasSidePanelStore = create<CanvasSidePanelStore>((set, get) => ({
    width: CANVAS_SIDE_PANEL_DEFAULT_WIDTH,
    panelOpen: false,
    panelMounted: false,
    panelClosing: false,
    nodeSearchFocusRequest: 0,
    setWidth: (width) => {
        const clamped = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, width));
        set({ width: clamped });
        // Debounced 持久化
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; void saveSettings({ canvasSidePanelWidth: clamped }); }, 500);
    },
    openPanel: () => {
        useAgentStore.getState().closePanel();
        set({ panelOpen: true, panelMounted: true, panelClosing: false });
        void saveSettings({ canvasSidePanelOpen: true });
    },
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelMounted: false, panelClosing: false });
        }, CANVAS_SIDE_PANEL_MOTION_MS);
        void saveSettings({ canvasSidePanelOpen: false });
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
    focusNodeSearch: () => {
        set((state) => ({ nodeSearchFocusRequest: state.nodeSearchFocusRequest + 1 }));
        get().openPanel();
    },
    clearNodeSearchFocusRequest: (request) => {
        if (get().nodeSearchFocusRequest === request) set({ nodeSearchFocusRequest: 0 });
    },
}));

async function hydrateCanvasSidePanelSettings() {
    const settings = await fetchSettings();
    const patch: Partial<CanvasSidePanelStore> = {};
    if (settings.canvasSidePanelWidth) {
        patch.width = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, settings.canvasSidePanelWidth));
    }
    if (settings.canvasSidePanelOpen !== undefined && !/^\/canvas\/[^/]+/.test(window.location.pathname)) {
        patch.panelOpen = settings.canvasSidePanelOpen;
        patch.panelMounted = settings.canvasSidePanelOpen;
        patch.panelClosing = false;
    }
    if (Object.keys(patch).length > 0) useCanvasSidePanelStore.setState(patch);
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => { void hydrateCanvasSidePanelSettings(); });
}
