import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbenchCanvas } from "@/lib/canvas/canvas-host";
export function referenceNodePath(projectId: string, nodeId?: string) {
    return `/canvas/${encodeURIComponent(projectId)}${nodeId ? `?${new URLSearchParams({ nodeId })}` : ""}`;
}
export function ReferenceNodeLink({ sourceNode }: { sourceNode?: { projectId?: string; nodeId?: string } }) {
    const { t } = useTranslation();
    const canvas = useWorkbenchCanvas();
    return sourceNode?.projectId ? <Link className="inline-flex items-center gap-1 text-xs text-primary" to={referenceNodePath(sourceNode.projectId, sourceNode.nodeId)} onClick={event => {
        if (!canvas || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); canvas.openCanvas({ projectId: sourceNode.projectId!, nodeId: sourceNode.nodeId });
    }}>{t("director.crud.locateImage")}<ArrowUpRight className="size-3" /></Link> : null;
}
