import { ArrowUpRight, Check, Clapperboard, Download, LayoutGrid, Pencil, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useExportCanvas } from "@/hooks/use-export-canvas";
import { canvasProjectDestination } from "@/pages/projects/directory-data";
import { cn } from "@/lib/utils";

export function CanvasProjectCard({ project }: { project: CanvasProject }) {
    const { exportCanvasProjects, exporting, busy } = useExportCanvas();
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const open = (view: "canvas" | "production" = "canvas") => {
        const destination = canvasProjectDestination(project.id, view, searchParams.toString(), window.location.hash);
        navigate(destination.to, { replace: destination.replace });
    };
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };

    return (
        <article className={cn("group flex min-h-56 cursor-pointer flex-col rounded-xl border border-border bg-card p-5 text-foreground transition-colors hover:border-primary/40", selected && "border-primary/60 bg-primary/5")} onClick={() => !editing && open()}>
            <div className="mb-6 flex items-center justify-between">
                <LayoutGrid className="size-5 stroke-[1.5] text-primary" aria-hidden="true" />
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    className="size-4 cursor-pointer accent-primary"
                    aria-label={t("canvas.project.select", { name: project.title })}
                />
            </div>
            <div className="flex min-w-0 flex-1 items-start gap-3">
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-primary"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-lg font-medium tracking-tight">{project.title}</h2>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                            {t("canvas.project.stats", { nodes: (project.summary?.nodeCount ?? project.nodes.length), connections: (project.summary?.connectionCount ?? project.connections.length) })}
                        </p>
                    </button>
                )}
                {!editing ? <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden="true" /> : null}
            </div>
            {!editing && <div className="mt-5 flex flex-wrap gap-2" onClick={event => event.stopPropagation()}>
                <Button size="small" icon={<LayoutGrid className="size-3.5" />} onClick={() => open()}>{t("projects.openCanvas")}</Button>
                <Button size="small" icon={<Clapperboard className="size-3.5" />} onClick={() => open("production")}>{t("projects.openProduction")}</Button>
            </div>}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <p className="text-[11px] text-muted-foreground">{t("canvas.project.updated", { date: new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}</p>
                <div className="-mr-1 flex items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label={t("canvas.project.saveName")} />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label={t("canvas.project.cancelRename")} />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" loading={exporting} disabled={busy} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects([project], project.title || t("canvas.title"))} aria-label={t("canvas.project.export")} />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label={t("canvas.project.rename")} />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label={t("canvas.project.delete")} />
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
