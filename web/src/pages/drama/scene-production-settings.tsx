import { Switch } from "antd";
import { useTranslation } from "react-i18next";
import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

export function SceneProductionSettings({ value, onChange }: { value: DramaProductionPlan; onChange: (patch: Partial<DramaProductionPlan>) => void }) {
    const { t } = useTranslation();
    return <div className="space-y-3">
        <label className="flex items-center justify-between"><span>{t("sceneProduction.enable")}</span><Switch aria-label={t("sceneProduction.enable")} checked={Boolean(value.parallelScenes)} onChange={parallelScenes => onChange({ parallelScenes })} /></label>
        {value.parallelScenes && <p className="text-xs text-muted-foreground">{t("sceneProduction.settingsHint")}</p>}
    </div>;
}
