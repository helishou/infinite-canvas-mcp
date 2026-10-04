import { create } from "zustand";
import type { EpisodeProduction, ProductionCanvasContext, ProductionReadiness } from "@/services/backend-api";

type WorkspaceState = {
    context: ProductionCanvasContext | null; production: EpisodeProduction | null; readiness: ProductionReadiness | null;
    panelTab: "director" | "object";
    commandBusy: boolean;
    setContext: (context: ProductionCanvasContext | null) => void;
    setSnapshot: (ownerId: string, production: EpisodeProduction, readiness: ProductionReadiness | null) => void;
    setPanelTab: (tab: "director" | "object") => void;
    setCommandBusy: (ownerId: string, busy: boolean) => void;
};
export const useProductionWorkspaceStore = create<WorkspaceState>((set, get) => ({
    context: null, production: null, readiness: null, panelTab: "director", commandBusy: false,
    setContext: context => set({ context, production: null, readiness: null, commandBusy: false }),
    setSnapshot: (ownerId, production, readiness) => {
        if (get().context?.owner?.id === ownerId) set({ production, readiness });
    },
    setPanelTab: panelTab => set({ panelTab }),
    setCommandBusy: (ownerId, commandBusy) => { if (get().context?.owner?.id === ownerId) set({ commandBusy }); },
}));
