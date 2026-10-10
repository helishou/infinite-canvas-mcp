import { useEffect, useState } from "react";

/** Re-read Backend-selected references when a bound node changes, including shared canvases. */
export function useReferenceResultVersion(sources: Array<{ projectId?: string; nodeId?: string }>) {
    const scope = JSON.stringify(sources.filter(source => source.projectId && source.nodeId));
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const bindings = JSON.parse(scope) as typeof sources;
        const updated = (event: Event) => {
            const value = (event as CustomEvent).detail;
            if (value?.type !== "canvas.updated") return;
            const operations = value.payload?.operations || [];
            if (bindings.some(binding => binding.projectId === value.entityId && operations.some((op: { id?: string; type?: string; metadata?: Record<string, unknown> }) => op.id === binding.nodeId && (op.type === "delete_node" || op.metadata && ["images", "storageKey", "smartImageReferenceSelection"].some(key => key in op.metadata!))))) setVersion(current => current + 1);
        };
        window.addEventListener("backend-event", updated);
        return () => window.removeEventListener("backend-event", updated);
    }, [scope]);
    return version;
}
