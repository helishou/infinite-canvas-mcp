import { create } from "zustand";
import type { EpisodeProduction, ProductionCanvasContext, ProductionReadiness } from "@/services/backend-api";
import type { ProductionObject } from "@/lib/production-object";
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";

/** 目录/画布都能发起的制作命令（与制作页 sendCommand 的子集对齐）。 */
export type ProductionCommand =
    | { kind: "prepare"; targets: string[] }
    | { kind: "arrange"; sceneId: string }
    | { kind: "edit"; ops: ProductionOperation[] };

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
    /** 制作页注册的命令执行器；没有它时（画布页）目录里的操作会直接打后端。 */
    commandRunner: ((command: ProductionCommand) => Promise<void>) | null;
    setCommandRunner: (runner: ((command: ProductionCommand) => Promise<void>) | null) => void;
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
    commandRunner: null,
    setCommandRunner: runner => set({ commandRunner: runner }),
}));
