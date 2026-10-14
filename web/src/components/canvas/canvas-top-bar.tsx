import { useCanvasHost, useCanvasRoute, useCanvasTransientEscape } from "@/lib/canvas/canvas-host";
import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, Clapperboard, MessagesSquare, Download, FileText, Home, Images, LoaderCircle, Menu, PanelLeftClose, PanelLeftOpen, Plus, Redo2, Trash2, Undo2, Upload, UsersRound } from "lucide-react";
import { Button, Dropdown, Popover, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import type { CanvasCollaborator } from "@/stores/canvas/use-canvas-store";
import { CanvasDraftsDialog } from "./canvas-drafts-button";
import { CanvasTextSuggestionsDialog } from "./canvas-text-suggestions-dialog";
import { CanvasShortcutsDialog } from "./canvas-shortcuts-dialog";
import { CanvasTaskCenterButton } from "./canvas-task-center";
import { CanvasProductionToolbar } from "@/components/production/canvas-production-workspace";
import { markProductionEntry } from "@/lib/production-navigation";

export function CanvasTopBar({
    projectId,
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onExportProject,
    exporting,
    transferBusy,
    onImportImage,
    onOpenPlugins,
    onUndo,
    onRedo,
    onOpenGenerationLogs,
    collaborators,
}: {
    projectId: string;
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onExportProject: () => void;
    exporting: boolean;
    transferBusy: boolean;
    onImportImage: () => void;
    onOpenPlugins: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onOpenGenerationLogs: () => void;
    collaborators: CanvasCollaborator[];
}) {
    const host = useCanvasHost();
    const colorTheme = useThemeStore((state) => state.theme);
    const { t } = useTranslation();
    const { search: searchParams } = useCanvasRoute();
    const productionOrigin = searchParams.get("from") === "dramas" ? "?from=dramas" : "";
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [toolsOpen, setToolsOpen] = useState(false);
    const [recoveryDialog, setRecoveryDialog] = useState<"suggestions" | "drafts" | null>(null);
    useCanvasTransientEscape(toolsOpen, () => setToolsOpen(false));
    const sidePanelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleSidePanel = useCanvasSidePanelStore((state) => state.togglePanel);
    const productionOwner = useProductionWorkspaceStore(state => state.context?.owner);
    const productionDramaId = useProductionWorkspaceStore(state => state.context?.dramaId);
    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div data-canvas-topbar data-hosted={Boolean(host)} className="canvas-topbar">
                <div className={`pointer-events-auto flex min-w-0 flex-1 items-center whitespace-nowrap ${productionOwner ? "gap-1 sm:gap-2" : "gap-2"}`}>
                    <Tooltip title={sidePanelOpen ? t("canvas.collapsePanel") : t("canvas.expandPanel")}>
                        <button
                            type="button"
                            onClick={toggleSidePanel}
                            aria-label={sidePanelOpen ? t("canvas.collapsePanel") : t("canvas.expandPanel")}
                            className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                            style={{ color: theme.node.text }}
                        >
                            {sidePanelOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                        </button>
                    </Tooltip>
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                ...(productionDramaId ? [{ key: "drama", icon: <Images className="size-4" />, label: <Link to={`/production?dramaId=${encodeURIComponent(productionDramaId)}&workspace=series`}>{t("productionCanvas.backDrama")}</Link> }] : []),
                                { key: "home", icon: <Home className="size-4" />, label: t("productionCanvas.backHome"), onClick: onHome },
                                ...(!productionOwner ? [{ key: "production-view", icon: <Clapperboard className="size-4" />, label: <Link to={`/director/${encodeURIComponent(projectId)}`} onClick={() => markProductionEntry()}>{t("productionCanvas.enter")}</Link> }] : []),
                                { key: "projects", icon: <Images className="size-4" />, label: t("canvas.projects"), onClick: onProjects },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: t("canvas.create"), onClick: onCreateProject },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.deleteCurrent"), onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: t("canvas.importAsset"), onClick: onImportImage },
                                { key: "export", disabled: transferBusy, icon: exporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />, label: exporting ? t("canvas.projectPage.exporting") : t("canvas.exportCurrent"), onClick: onExportProject },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text={t("canvas.undo")} shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text={t("canvas.redo")} shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("canvas.openMenu")}>
                            <Menu className="size-4" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className={`${productionDramaId ? "hidden" : "flex"} min-w-0 items-center gap-2`}>
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className={`${productionOwner ? "max-w-[100px] sm:max-w-[180px] lg:max-w-[280px]" : "max-w-[280px]"} truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current`}
                                onDoubleClick={onStartTitleEditing}
                                title={t("canvas.renameHint")}
                            >
                                {title}
                            </button>
                        )}
                    </div>
                    {productionOwner && <CanvasProductionToolbar />}
                    <CanvasCollaborators collaborators={collaborators} />
                </div>

                <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
                    {<Popover destroyOnHidden open={toolsOpen} onOpenChange={setToolsOpen} trigger="click" content={<div data-canvas-transient-tool className="flex max-w-80 flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <button type="button" className="flex h-8 items-center gap-2 rounded px-2 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={() => { setToolsOpen(false); setRecoveryDialog("suggestions"); }}><MessagesSquare className="size-3.5" />{t("canvasRecovery.suggestions")}</button>
                            <button type="button" className="flex h-8 items-center gap-2 rounded px-2 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={() => { setToolsOpen(false); setRecoveryDialog("drafts"); }}><ArchiveRestore className="size-3.5" />{t("canvasRecovery.localDrafts")}</button>
                        </div>
                        <UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} onOpenPlugins={onOpenPlugins} /></div>}><button type="button" className="grid size-8 place-items-center" aria-label={t("productionCanvas.tools")}><Menu className="size-4" /></button></Popover>}
                    <Tooltip title={t("productionCanvas.generationLogs")}><button type="button" aria-label={t("productionCanvas.generationLogs")} className="grid size-8 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={onOpenGenerationLogs}><FileText className="size-4" /></button></Tooltip>
                    <CanvasTaskCenterButton projectId={projectId} />
                </div>
            </div>
            <CanvasTextSuggestionsDialog key={projectId} projectId={projectId} open={recoveryDialog === "suggestions"} onClose={() => setRecoveryDialog(null)} />
            <CanvasDraftsDialog open={recoveryDialog === "drafts"} onClose={() => setRecoveryDialog(null)} />
            <CanvasShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </>
    );
}

function CanvasCollaborators({ collaborators }: { collaborators: CanvasCollaborator[] }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    if (!collaborators.length) return null;
    const label = collaborators.map((item) => `${item.label} · ${item.kind === "mcp" ? "MCP" : item.kind === "agent" ? "Agent" : item.kind === "browser" ? "浏览器" : "后台"}`).join("\n");
    return (
        <Tooltip title={<span className="whitespace-pre-line">最近参与画布操作<br />{label}</span>}>
            <div className="flex h-8 items-center gap-1.5 px-1 text-xs" style={{ color: theme.node.muted }} aria-label={`最近协作者 ${collaborators.length} 个`}>
                <UsersRound className="size-3.5" />
                <span className="flex -space-x-1.5">
                    {collaborators.slice(0, 4).map((item) => (
                        <span key={item.clientId} className="grid size-5 place-items-center rounded-full border text-[9px] font-semibold" style={{ borderColor: theme.toolbar.panel, background: collaboratorColor(item.clientId), color: "#fff" }}>
                            {(item.label || item.kind).slice(0, 1).toUpperCase()}
                        </span>
                    ))}
                </span>
            </div>
        </Tooltip>
    );
}

function collaboratorColor(clientId: string) {
    const colors = ["#0f766e", "#b45309", "#be123c", "#1d4ed8", "#6d28d9", "#3f6212"];
    let hash = 0;
    for (let index = 0; index < clientId.length; index += 1) hash = (hash * 31 + clientId.charCodeAt(index)) | 0;
    return colors[Math.abs(hash) % colors.length];
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}
