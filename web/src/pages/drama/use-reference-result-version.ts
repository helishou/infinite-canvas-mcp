import { useEffect, useState } from "react";

/** Re-read Backend-selected references when a bound node changes, including shared canvases. */
export function useReferenceResultVersion(sources: Array<{ projectId?: string; nodeId?: string }>) {
    const scope = JSON.stringify(sources.filter(source => source.projectId && source.nodeId));
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const bindings = JSON.parse(scope) as typeof sources;
        const referenceFields = ["images", "storageKey", "smartImageReferenceSelection"];
        const updated = (event: Event) => {
            const value = (event as CustomEvent).detail;
            if (value?.type !== "canvas.updated") return;
            const operations = value.payload?.operations || [];
            if (bindings.some(binding => binding.projectId === value.entityId && operations.some((op: { id?: string; ids?: string[]; type?: string; metadata?: Record<string, unknown>; metadataDelete?: string[] }) => {
                if (op.type === "delete_node") return op.id === binding.nodeId || Boolean(op.ids?.includes(binding.nodeId!));
                return op.id === binding.nodeId && (Boolean(op.metadata && referenceFields.some(key => key in op.metadata!)) || Boolean(op.metadataDelete?.some(key => referenceFields.includes(key))));
            }))) setVersion(current => current + 1);
        };
        window.addEventListener("backend-event", updated);
        return () => window.removeEventListener("backend-event", updated);
    }, [scope]);
    return version;
}
