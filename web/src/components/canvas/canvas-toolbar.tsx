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
    const selectionItems: MenuProps["items"] = [
        { key: "focus", icon: <Focus className="size-4" />, label: t("canvas.navigation.focusSelection"), onClick: onFocusSelection },
        ...(selectedCount > 1 ? [{ key: "rename", icon: <PencilLine className="size-4" />, label: t("canvas.navigation.rename"), onClick: onBatchRename }] : []),
        { key: "arrange", icon: <Grid2x2 className="size-4" />, label: t("canvas.toolbar.arrange"), onClick: onArrange },
        ...(groupSelection ? [{ key: "group", icon: <Group className="size-4" />, label: t("canvas.controls.group"), onClick: onAddGroup }] : []),
        { type: "divider" }, { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.deleteSelected"), onClick: onDelete },
    ];
    return <>
        <div data-canvas-create-tools className="canvas-create-dock" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }} onPointerDown={event => event.stopPropagation()}>
            <Tooltip title={t("canvas.toolbar.select")}><Button type="text" aria-label={t("canvas.toolbar.select")} aria-pressed={canvasTool === "select"} onClick={() => onCanvasToolChange("select")} icon={<MousePointer2 className="size-4" />} /></Tooltip>
            <Tooltip title={t("canvas.toolbar.pan")}><Button type="text" aria-label={t("canvas.toolbar.pan")} aria-pressed={canvasTool === "pan"} onClick={() => onCanvasToolChange("pan")} icon={<Hand className="size-4" />} /></Tooltip>
            <Tooltip title={t("canvas.undo")}><Button type="text" aria-label={t("canvas.undo")} disabled={!canUndo} onClick={onUndo} icon={<Undo2 className="size-4" />} /></Tooltip>
            <Tooltip title={t("canvas.redo")}><Button type="text" aria-label={t("canvas.redo")} disabled={!canRedo} onClick={onRedo} icon={<Redo2 className="size-4" />} /></Tooltip>
            <span className="mx-1 h-5 border-l border-border" />
            <Dropdown destroyOnHidden trigger={["click"]} placement="top" popupRender={menu => <div className="canvas-create-menu">{menu}</div>} menu={{ items: creationItems, style: { maxHeight: "min(520px, 65dvh)", overflowY: "auto" } }}><Button type="text" icon={<Plus className="size-4" />}>{t("canvasChrome.add")}</Button></Dropdown>
            <Tooltip title={t("canvas.toolbar.upload")}><Button type="text" aria-label={t("canvas.toolbar.upload")} onClick={onUpload} icon={<Upload className="size-4" />} /></Tooltip>
            <Dropdown destroyOnHidden trigger={["click"]} placement="topRight" menu={{ items: [{ type: "group", label: t("canvasChrome.danger"), children: [{ key: "clear", danger: true, label: t("canvas.toolbar.clear"), onClick: onClear }] }] }}><Button type="text" aria-label={t("canvasChrome.canvasActions")} icon={<Ellipsis className="size-4" />} /></Dropdown>
        </div>
        {showSelectionActions && selectedCount > 0 && <div className="canvas-selection-actions" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }} onPointerDown={event => event.stopPropagation()}><Tooltip title={t("canvas.navigation.focusSelection")}><Button type="text" aria-label={t("canvas.navigation.focusSelection")} onClick={onFocusSelection} icon={<Focus className="size-4" />} /></Tooltip><Dropdown destroyOnHidden trigger={["click"]} menu={{ items: selectionItems }}><Button type="text" icon={<Ellipsis className="size-4" />}>{t("canvasChrome.selected", { count: selectedCount })}</Button></Dropdown></div>}
    </>;
}
