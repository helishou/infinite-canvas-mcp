import { Switch } from "antd";
import { useTranslation } from "react-i18next";
import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

export function SceneProductionSettings({ value, onChange }: { value: DramaProductionPlan; onChange: (patch: Partial<DramaProductionPlan>) => void }) {
    const { t } = useTranslation();
    return <div className="space-y-3">
        <div><label className="flex items-center justify-between gap-3"><span>{t("director.studio.backgroundMusic")}</span><Switch aria-label={t("director.studio.backgroundMusic")} checked={value.backgroundMusicEnabled === true} onChange={backgroundMusicEnabled => onChange({ backgroundMusicEnabled })} /></label><p className="mt-2 text-xs text-muted-foreground">{t("director.studio.backgroundMusicHint")}</p></div>
        <label className="flex items-center justify-between"><span>{t("sceneProduction.enable")}</span><Switch aria-label={t("sceneProduction.enable")} checked={Boolean(value.parallelScenes)} onChange={parallelScenes => onChange({ parallelScenes })} /></label>
        {value.parallelScenes && <p className="text-xs text-muted-foreground">{t("sceneProduction.settingsHint")}</p>}
    </div>;
}
