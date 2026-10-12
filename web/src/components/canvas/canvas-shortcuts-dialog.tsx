import { Modal } from "antd";
import { useTranslation } from "react-i18next";

export function CanvasShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const shortcuts = [
        ["Ctrl / Cmd + K", "canvas.navigation.searchLabel"], ["F", "canvas.navigation.focusSelection"], ["Shift + F", "canvas.navigation.fitAll"],
        [`Ctrl / Space + ${t("canvas.shortcut.drag")}`, "canvas.shortcut.toggleTool"], [t("canvas.shortcut.wheel"), "canvas.shortcut.zoom"], [t("canvas.shortcut.zoomSlider"), "canvas.shortcut.preciseZoom"],
        [t("canvas.shortcut.drag"), "canvas.shortcut.boxSelect"], [`Shift / Cmd + ${t("canvas.shortcut.click")}`, "canvas.shortcut.addSelection"], ["Ctrl / Cmd + A", "canvas.shortcut.selectAll"],
        ["Ctrl / Cmd + C / V", "canvas.shortcut.copyPaste"], ["Ctrl / Cmd + Z", "canvas.undo"], ["Ctrl / Cmd + Shift + Z / Y", "canvas.redo"],
        ["Delete / Backspace", "canvas.shortcut.delete"], ["Esc", "canvas.shortcut.escape"], [t("canvas.shortcut.dropMedia"), "canvas.shortcut.upload"],
    ];
    return <Modal title={t("canvas.shortcuts")} open={open} onCancel={onClose} footer={null} centered styles={{ body: { maxHeight: "min(65dvh, 520px)", overflowY: "auto", overscrollBehavior: "contain" } }}><dl className="divide-y divide-border">{shortcuts.map(([key, label]) => <div key={label} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><dt className="font-medium">{key}</dt><dd className="m-0 text-muted-foreground">{t(label)}</dd></div>)}</dl></Modal>;
}
