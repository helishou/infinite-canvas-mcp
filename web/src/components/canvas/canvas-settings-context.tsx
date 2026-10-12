import { useTranslation } from "react-i18next";

export function CanvasSettingsContext({ targetLabel, updatesImageDefaults = false }: { targetLabel?: string; updatesImageDefaults?: boolean }) {
    const { t } = useTranslation();
    if (!targetLabel) return null;
    return (
        <div className="mb-4 border-b border-current/10 pb-3" data-canvas-settings-context>
            <div className="text-xs opacity-60">{t("canvas.nodeActions.parameters")}</div>
            <div className="mt-1 break-words text-sm font-medium">{targetLabel}</div>
            {updatesImageDefaults ? <p className="mb-0 mt-2 text-xs leading-5 opacity-60">{t("canvas.nodeActions.imageDefaults")}</p> : null}
        </div>
    );
}
