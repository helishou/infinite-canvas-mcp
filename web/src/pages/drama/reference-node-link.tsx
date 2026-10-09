import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
export function referenceNodePath(projectId: string, nodeId?: string) {
    return `/canvas/${encodeURIComponent(projectId)}${nodeId ? `?${new URLSearchParams({ nodeId })}` : ""}`;
}
export function ReferenceNodeLink({ sourceNode }: { sourceNode?: { projectId?: string; nodeId?: string } }) {
    const { t } = useTranslation();
    return sourceNode?.projectId ? <Link className="inline-flex items-center gap-1 text-xs text-primary" to={referenceNodePath(sourceNode.projectId, sourceNode.nodeId)}>{t("director.crud.locateImage")}<ArrowUpRight className="size-3" /></Link> : null;
}
