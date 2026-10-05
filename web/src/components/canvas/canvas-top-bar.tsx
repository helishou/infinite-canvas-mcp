import { useEffect, useRef, useState } from "react";
import { BookOpen, Bot, Download, FileText, Home, Images, LoaderCircle, Menu, PanelLeftClose, PanelLeftOpen, Plus, Redo2, Sparkles, Trash2, Undo2, Upload, UsersRound } from "lucide-react";
import { Button, Dropdown, Modal, Popover, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { DOCS_URL } from "@/constant/env";
import type { CanvasCollaborator } from "@/stores/canvas/use-canvas-store";
import { CanvasCollaborativeText } from "./canvas-collaborative-text";
import { CanvasDraftsButton } from "./canvas-drafts-button";
import { CanvasTaskCenterButton } from "./canvas-task-center";
import { CanvasTextSuggestionsButton } from "./canvas-text-suggestions-button";
import { CanvasProductionToolbar } from "@/components/production/canvas-production-workspace";

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
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
    globalPrompt,
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
    agentOpen: boolean;
    compactAgentStatus: { connected: boolean; enabled: boolean; activity: string };
    onToggleAgent: () => void;
    globalPrompt: string;
    onOpenGenerationLogs: () => void;
    collaborators: CanvasCollaborator[];
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const productionOrigin = searchParams.get("from") === "dramas" ? "?from=dramas" : "";
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between pl-1 pr-4">
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
                    {!productionOwner && <Link to={`/director/${encodeURIComponent(projectId)}${productionOrigin}`} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }}><Sparkles className="size-4" />{t("director.open")}</Link>}
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                ...(productionOwner ? [{ key: "production", icon: <Images className="size-4" />, label: <Link to="/production">{t("productionCanvas.backHome")}</Link> }] : []),
                                { key: "home", icon: <Home className="size-4" />, label: t("canvas.home"), onClick: onHome },
                                { key: "docs", icon: <BookOpen className="size-4" />, label: t("canvas.docs"), onClick: () => window.open(DOCS_URL, "_blank", "noopener,noreferrer") },
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
                    {!productionOwner && <CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} />}
                    <CanvasCollaborators collaborators={collaborators} />
                    {!productionOwner && <><CanvasDraftsButton /><CanvasTextSuggestionsButton projectId={projectId} /></>}
                    <Popover
                        trigger="click"
                        placement="bottomLeft"
                        content={<div className="w-80"><CanvasCollaborativeText projectId={projectId} target={{ field: "globalPrompt" }} placeholder={t("canvas.globalPromptPlaceholder")} /></div>}
                    >
                        <Tooltip title={t("canvas.globalPromptHint")}>
                                <button type="button" aria-label={t("canvas.globalPrompt")} className={`${productionOwner ? "hidden sm:flex" : "flex"} h-8 items-center gap-1 rounded-lg px-2 text-xs transition hover:bg-black/5 dark:hover:bg-white/10`} style={{ color: globalPrompt.trim() ? theme.node.text : theme.node.muted }}>
                                <Sparkles className="size-3.5" />
                                {!productionOwner && <span>{t("canvas.globalPrompt")}</span>}
                            </button>
                        </Tooltip>
                    </Popover>
                </div>

                <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
                    {productionOwner ? <Popover trigger="click" content={<div className="flex max-w-80 flex-col gap-3"><CompactAgentStatus status={compactAgentStatus} onClick={() => { useProductionWorkspaceStore.getState().setPanelTab("director"); useAgentStore.getState().openPanel(); }} /><CanvasDraftsButton /><CanvasTextSuggestionsButton projectId={projectId} /><CanvasTaskCenterButton projectId={projectId} /><button type="button" onClick={onOpenGenerationLogs}>{t("productionCanvas.generationLogs")}</button><UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} onOpenPlugins={onOpenPlugins} /></div>}><button type="button" className="grid size-8 place-items-center" aria-label={t("productionCanvas.tools")}><Menu className="size-4" /></button></Popover>
                        : <UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} onOpenPlugins={onOpenPlugins} />}
                    {!productionOwner && <><Tooltip title={t("productionCanvas.generationLogs")}><button type="button" aria-label={t("productionCanvas.generationLogs")} className="grid size-8 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={onOpenGenerationLogs}><FileText className="size-4" /></button></Tooltip><CanvasTaskCenterButton projectId={projectId} /></>}
                </div>
            </div>
            <Modal title={t("canvas.shortcuts")} open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["Ctrl / Cmd", "K"]} value={t("canvas.navigation.searchLabel")} />
                    <Shortcut keys={["F"]} value={t("canvas.navigation.focusSelection")} />
                    <Shortcut keys={["Shift", "F"]} value={t("canvas.navigation.fitAll")} />
                    <Shortcut keys={["Ctrl / Space", t("canvas.shortcut.drag")]} value={t("canvas.shortcut.toggleTool")} />
                    <Shortcut keys={[t("canvas.shortcut.wheel")]} value={t("canvas.shortcut.zoom")} />
                    <Shortcut keys={[t("canvas.shortcut.zoomSlider")]} value={t("canvas.shortcut.preciseZoom")} />
                    <Shortcut keys={[t("canvas.shortcut.drag")]} value={t("canvas.shortcut.boxSelect")} />
                    <Shortcut keys={["Shift / Cmd", t("canvas.shortcut.click")]} value={t("canvas.shortcut.addSelection")} />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value={t("canvas.shortcut.selectAll")} />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value={t("canvas.shortcut.copyPaste")} />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value={t("canvas.undo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Delete / Backspace"]} value={t("canvas.shortcut.delete")} />
                    <Shortcut keys={["Esc"]} value={t("canvas.shortcut.escape")} />
                    <Shortcut keys={[t("canvas.shortcut.dropMedia")]} value={t("canvas.shortcut.upload")} />
                </div>
            </Modal>
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

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const { t } = useTranslation();
    const label = status.connected ? t("canvas.agentConnected") : status.enabled ? t("canvas.agentConnecting", { activity: status.activity || t("canvas.connecting") }) : t("canvas.agentDisconnected");
    const dotColor = status.connected ? "#22c55e" : status.enabled ? "#f59e0b" : theme.node.muted;
    return (
        <button type="button" className="flex h-8 items-center gap-1.5 text-xs transition hover:opacity-75" style={{ color: status.connected ? "#16a34a" : status.enabled ? "#d97706" : theme.node.muted }} onClick={onClick} title={t("canvas.openAgent")}>
            <span className="size-2 rounded-full" style={{ background: dotColor }} />
            <span className="max-w-[140px] truncate">{label}</span>
        </button>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}
