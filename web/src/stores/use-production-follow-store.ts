import { create } from "zustand";

import type { ProductionPresentation } from "@/services/backend-api";

export type ProductionFollowTarget = {
    kind?: "canvas" | "episode";
    id?: string;
    workId: string;
    runId?: string;
    threadId?: string;
    mode?: "asset" | "drama";
};

type StoredState = { target?: ProductionFollowTarget; following: boolean; pauseReason: string; lastPath: string; tabOrigin: number };
type ProductionFollowStore = {
    target?: ProductionFollowTarget;
    presentation: ProductionPresentation | null;
    pendingPresentation: ProductionPresentation | null;
    following: boolean;
    pauseReason: string;
    guardReason: string;
    guardReasons: Record<string, string>;
    lastPath: string;
    expectedPath: string;
    setTarget: (target: ProductionFollowTarget) => void;
    setPresentation: (presentation: ProductionPresentation) => void;
    setPendingPresentation: (presentation: ProductionPresentation | null) => void;
    setGuardReason: (key: string, reason: string) => void;
    pause: (reason: string) => void;
    resume: () => void;
    expectPath: (path: string) => void;
    consumeExpectedPath: (path: string) => boolean;
    setLastPath: (path: string) => void;
};

const STORAGE_KEY = "production-follow-v1";

function readState(): StoredState {
    const empty: StoredState = { following: false, pauseReason: "", lastPath: "", tabOrigin: 0 };
    if (typeof window === "undefined") return empty;
    try {
        const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") as Partial<StoredState> | null;
        if (!parsed || typeof parsed !== "object") return empty;
        const navigationType = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const clonedTab = Number(parsed.tabOrigin || 0) !== 0 && Number(parsed.tabOrigin) !== performance.timeOrigin && navigationType?.type !== "reload";
        return {
            target: parsed.target,
            following: Boolean(parsed.following) && !clonedTab,
            pauseReason: clonedTab ? "此标签页是复制窗口；跟随已暂停" : String(parsed.pauseReason || ""),
            lastPath: clonedTab ? "" : String(parsed.lastPath || ""),
            tabOrigin: performance.timeOrigin,
        };
    } catch { return { ...empty, tabOrigin: performance.timeOrigin }; }
}

const initial = readState();

function persist(state: Pick<ProductionFollowStore, "target" | "following" | "pauseReason" | "lastPath">) {
    if (typeof window === "undefined") return;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, tabOrigin: performance.timeOrigin } satisfies StoredState));
    } catch { /* Follow state is a small, recoverable view preference. */ }
}

export const useProductionFollowStore = create<ProductionFollowStore>((set, get) => ({
    target: initial.target,
    presentation: null,
    pendingPresentation: null,
    following: initial.following,
    pauseReason: initial.pauseReason,
    guardReason: "",
    guardReasons: {},
    lastPath: initial.lastPath,
    expectedPath: "",
    setTarget: (target) => {
        set({ target, presentation: null, pendingPresentation: null, following: true, pauseReason: "" });
        persist({ target, following: true, pauseReason: "", lastPath: get().lastPath });
    },
    setPresentation: (presentation) => set({ presentation }),
    setPendingPresentation: (pendingPresentation) => set({ pendingPresentation }),
    setGuardReason: (key, reason) => {
        const guardReasons = { ...get().guardReasons };
        if (reason) guardReasons[key] = reason; else delete guardReasons[key];
        const guardReason = Object.values(guardReasons).join(" · ");
        set({ guardReasons, guardReason });
        if (!guardReason && get().pendingPresentation && typeof window !== "undefined") window.dispatchEvent(new Event("production-follow-resume"));
    },
    pause: (reason) => {
        set({ following: false, pauseReason: reason || "已暂停自动跟随" });
        persist({ target: get().target, following: false, pauseReason: get().pauseReason, lastPath: get().lastPath });
    },
    resume: () => {
        set({ following: true, pauseReason: "" });
        persist({ target: get().target, following: true, pauseReason: "", lastPath: get().lastPath });
        if (typeof window !== "undefined") window.dispatchEvent(new Event("production-follow-resume"));
    },
    expectPath: (expectedPath) => set({ expectedPath }),
    consumeExpectedPath: (path) => {
        if (get().expectedPath !== path) return false;
        set({ expectedPath: "" });
        return true;
    },
    setLastPath: (lastPath) => {
        set({ lastPath });
        persist({ target: get().target, following: get().following, pauseReason: get().pauseReason, lastPath });
    },
}));
