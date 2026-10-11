import type { To } from "react-router-dom";

/** Resolve canvas destinations without borrowing the workbench pathname or query. */
export function canvasHostLocation(to: To, projectId: string) {
    const base = `https://canvas.invalid/canvas/${encodeURIComponent(projectId)}`;
    const url = new URL(typeof to === "string" ? to : to.pathname || base, base);
    if (typeof to !== "string") {
        if (to.search !== undefined) url.search = to.search;
        if (to.hash !== undefined) url.hash = to.hash;
    }
    if (url.origin !== "https://canvas.invalid" || !url.pathname.startsWith("/canvas/")) return null;
    return { projectId: decodeURIComponent(url.pathname.slice(8)), search: url.searchParams };
}
