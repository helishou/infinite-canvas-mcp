import { create } from "zustand";
import type { EpisodeProduction, ProductionCanvasContext, ProductionReadiness } from "@/services/backend-api";
import type { ProductionObject } from "@/lib/production-object";

type WorkspaceState = {
    context: ProductionCanvasContext | null; production: EpisodeProduction | null; readiness: ProductionReadiness | null;
    panelTab: "director" | "object";
    commandBusy: boolean;
    selectedObject: ProductionObject | null;
    recoveryPending: boolean;
    setContext: (context: ProductionCanvasContext | null) => void;
    setSnapshot: (ownerId: string, production: EpisodeProduction, readiness: ProductionReadiness | null) => void;
    setPanelTab: (tab: "director" | "object") => void;
    setCommandBusy: (ownerId: string, busy: boolean) => void;
    setSelectedObject: (object: ProductionObject | null) => void;
    setRecoveryPending: (ownerId: string, pending: boolean) => void;
};
export const useProductionWorkspaceStore = create<WorkspaceState>((set, get) => ({
    context: null, production: null, readiness: null, panelTab: "director", commandBusy: false, selectedObject: null, recoveryPending: false,
    setContext: context => {
        const previous = get().context;
        const sameOwner = context && previous && context.canvasId === previous.canvasId && context.role === previous.role && context.owner?.kind === previous.owner?.kind && context.owner?.id === previous.owner?.id;
        if (sameOwner) set({ context });
        else set({ context, production: null, readiness: null, commandBusy: false, selectedObject: null, recoveryPending: false });
    },
    setSnapshot: (ownerId, production, readiness) => {
        if (get().context?.owner?.id === ownerId) set({ production, readiness });
    },
    setPanelTab: panelTab => set({ panelTab }),
    setCommandBusy: (ownerId, commandBusy) => { if (get().context?.owner?.id === ownerId) set({ commandBusy }); },
    setSelectedObject: selectedObject => set({ selectedObject }),
    setRecoveryPending: (ownerId, recoveryPending) => { if (get().context?.owner?.id === ownerId) set({ recoveryPending }); },
}));
