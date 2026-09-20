import { useSyncExternalStore } from "react";

export type CanvasTransferKind = "import" | "export";

let activeTransfer: CanvasTransferKind | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notify() {
    listeners.forEach((listener) => listener());
}

export function acquireCanvasTransfer(kind: CanvasTransferKind) {
    if (activeTransfer) return false;
    activeTransfer = kind;
    notify();
    return true;
}

export function releaseCanvasTransfer(kind: CanvasTransferKind) {
    if (activeTransfer !== kind) return;
    activeTransfer = null;
    notify();
}

export function useCanvasTransfer() {
    return useSyncExternalStore(subscribe, () => activeTransfer, () => null);
}
