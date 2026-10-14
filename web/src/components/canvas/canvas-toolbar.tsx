import { Button, Dropdown, Tooltip, type MenuProps } from "antd";
import { Plus, Upload, MousePointer2, Hand, Undo2, Redo2, Ellipsis, Focus, PencilLine, Grid2x2, Trash2, Group } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getNodePluginId, listNodeDefinitions, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { getNodeSpec } from "@/constant/canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasToolbar({
    onFocusSelection,
    onBatchRename,
    selectedCount,
    deleteDisabled = false,
    showSelectionActions,
    canvasTool,
    canUndo,
    canRedo,
    onAddImage,
    onAddVideo,
    onAddH3,
    onAddAudio,
    onAddText,
    onAddConfig,
    onAddLoop,
    onAddGroup,
    groupSelection,
    onAddCharacter,
    onAddScene,
    onAddProp,
    onAddExtensionNode,
    onUndo,
    onRedo,
    onUpload,
    onDelete,
    onArrange,
    onClear,
    onCanvasToolChange,
}: {
    onFocusSelection: () => void;
    onBatchRename: () => void;
    selectedCount: number;
    deleteDisabled?: boolean;
    showSelectionActions: boolean;
    canvasTool: "select" | "pan";
    canUndo: boolean;
    canRedo: boolean;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddH3: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddConfig: () => void;
    onAddLoop: () => void;
    onAddGroup: () => void;
    /** 当前选中的普通节点 ≥2：点「组」会把它们装进新组，而不是新建空组。 */
    groupSelection: boolean;
    onAddCharacter: () => void;
    onAddScene: () => void;
    onAddProp: () => void;
    onAddExtensionNode: (type: string) => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onArrange: () => void;
    onClear: () => void;
    onCanvasToolChange: (tool: "select" | "pan") => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    useNodeRegistryVersion();
    const extensionDefs = listNodeDefinitions().filter(def => def.showInCreateMenu !== false && getNodePluginId(def.type) !== "builtin");
    const item = (key: string, onClick: () => void) => ({ key, label: t(`canvas.toolbar.${key}`), onClick });
    const creationItems: MenuProps["items"] = [
        { type: "group", label: t("canvasChrome.media"), children: [item("text", onAddText), item("image", onAddImage), item("video", onAddVideo), item("audio", onAddAudio)] },
        { type: "group", label: t("canvasChrome.production"), children: [{ key: "h3", label: "MiniMax H3", onClick: onAddH3 }, item("character", onAddCharacter), item("scene", onAddScene), item("prop", onAddProp)] },
        { type: "group", label: t("canvasChrome.structure"), children: [item("config", onAddConfig), item("loop", onAddLoop), { key: "group", label: t(groupSelection ? "canvas.controls.group" : "canvas.toolbar.group"), onClick: onAddGroup }] },
        ...(extensionDefs.length ? [{ type: "group" as const, label: t("canvas.toolbar.extensions"), children: extensionDefs.map(def => ({ key: `extension:${def.type}`, label: getNodeSpec(def.type).title, icon: <span>{def.icon}</span>, onClick: () => onAddExtensionNode(def.type) })) }] : []),
    ];
    return <>
        <div data-canvas-create-tools className="canvas-create-dock" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }} onPointerDown={event => event.stopPropagation()}>
            <Tooltip title={t(canvasTool === "select" ? "canvas.toolbar.select" : "canvas.toolbar.pan")}><Button type="text" aria-label={t(canvasTool === "select" ? "canvas.toolbar.select" : "canvas.toolbar.pan")} onClick={() => onCanvasToolChange(canvasTool === "select" ? "pan" : "select")} icon={canvasTool === "select" ? <MousePointer2 className="size-4" /> : <Hand className="size-4" />} /></Tooltip>
            <Tooltip title={t("canvas.undo")}><Button type="text" aria-label={t("canvas.undo")} disabled={!canUndo} onClick={onUndo} icon={<Undo2 className="size-4" />} /></Tooltip>
            <Tooltip title={t("canvas.redo")}><Button type="text" aria-label={t("canvas.redo")} disabled={!canRedo} onClick={onRedo} icon={<Redo2 className="size-4" />} /></Tooltip>
            <span className="mx-1 h-5 border-l border-border" />
            <Dropdown destroyOnHidden trigger={["click"]} placement="top" popupRender={menu => <div className="canvas-create-menu">{menu}</div>} menu={{ items: creationItems, style: { maxHeight: "min(520px, 65dvh)", overflowY: "auto" } }}><Button type="text" icon={<Plus className="size-4" />}>{t("canvasChrome.add")}</Button></Dropdown>
            <Tooltip title={t("canvas.toolbar.upload")}><Button type="text" aria-label={t("canvas.toolbar.upload")} onClick={onUpload} icon={<Upload className="size-4" />} /></Tooltip>
            <Dropdown destroyOnHidden trigger={["click"]} placement="topRight" menu={{ items: [{ type: "group", label: t("canvasChrome.danger"), children: [{ key: "clear", danger: true, label: t("canvas.toolbar.clear"), onClick: onClear }] }] }}><Button type="text" aria-label={t("canvasChrome.canvasActions")} icon={<Ellipsis className="size-4" />} /></Dropdown>
        </div>
        {showSelectionActions && selectedCount > 0 && <div className="canvas-selection-actions" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }} onPointerDown={event => event.stopPropagation()}>
            <span className="px-2 text-sm whitespace-nowrap">{t("canvasChrome.selected", { count: selectedCount })}</span>
            <Tooltip title={t("canvas.navigation.focusSelection")}><Button type="text" onClick={onFocusSelection} icon={<Focus className="size-4" />}>{t("canvas.navigation.focusSelection")}</Button></Tooltip>
            {selectedCount > 1 && <Tooltip title={t("canvas.navigation.rename")}><Button type="text" onClick={onBatchRename} icon={<PencilLine className="size-4" />}>{t("canvas.navigation.rename")}</Button></Tooltip>}
            {groupSelection && <Tooltip title={t("canvas.controls.group")}><Button type="text" onClick={onAddGroup} icon={<Group className="size-4" />}>{t("canvas.controls.group")}</Button></Tooltip>}
            <Tooltip title={t("canvas.toolbar.arrange")}><Button type="text" onClick={onArrange} icon={<Grid2x2 className="size-4" />}>{t("canvas.toolbar.arrange")}</Button></Tooltip>
            <Tooltip title={t("canvas.deleteSelected")}><Button type="text" danger disabled={deleteDisabled} onClick={onDelete} icon={<Trash2 className="size-4" />}>{t("canvas.deleteSelected")}</Button></Tooltip>
        </div>}
    </>;
}
