import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams, useSearchParams, type NavigateFunction } from "react-router-dom";

export type CanvasTarget = { projectId: string; nodeId?: string; segmentId?: string };
export const WorkbenchCanvasContext = createContext<{ openCanvas: (target: CanvasTarget) => void; restoreCanvas: () => void; visible: boolean; hasCanvas: boolean } | null>(null);
export const CanvasHostContext = createContext<{ projectId: string; active: boolean; search: URLSearchParams; requestId: number; navigate: NavigateFunction; collapse: () => void; popupContainer: () => HTMLElement } | null>(null);
export const useWorkbenchCanvas = () => useContext(WorkbenchCanvasContext);
export const useCanvasHost = () => useContext(CanvasHostContext);
export function CanvasPortal({ children }: { children: ReactNode }) {
    const host = useCanvasHost();
    return host && !host.active ? null : createPortal(children, host?.popupContainer() || document.body);
}
/** Transient tools consume Escape before the canvas host collapses. */
export function useCanvasTransientEscape(open: boolean, close: () => void) {
    const active = useCanvasHost()?.active ?? true;
    useEffect(() => {
        if (!open || !active) return;
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || document.querySelector(".ant-modal-wrap:not([style*='display: none']), .ant-select-dropdown:not(.ant-select-dropdown-hidden)")) return;
            event.preventDefault(); event.stopImmediatePropagation(); close();
        };
        window.addEventListener("keydown", escape, true);
        return () => window.removeEventListener("keydown", escape, true);
    }, [open, active, close]);
}

/** Embedded canvas navigation stays inside its host; standalone canvas uses the router. */
export function useCanvasRoute() {
    const host = useCanvasHost();
    const params = useParams();
    const navigate = useNavigate();
    const [search] = useSearchParams();
    const location = useLocation();
    return { projectId: host?.projectId ?? params.id ?? "", navigate: host?.navigate ?? navigate,
        search: host?.search ?? search, navigationKey: host ? String(host.requestId) : location.key, active: host?.active ?? true };
}
