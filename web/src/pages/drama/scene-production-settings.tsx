import { Select, Switch } from "antd";
import { useTranslation } from "react-i18next";
import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

export function SceneProductionSettings({ value, onChange }: { value: DramaProductionPlan; onChange: (patch: Partial<DramaProductionPlan>) => void }) {
    const { t } = useTranslation();
    const reviewPolicy = value.reviewPolicy;
    return <div className="space-y-3">
        <label className="flex items-center justify-between"><span>{t("sceneProduction.enable")}</span><Switch aria-label={t("sceneProduction.enable")} checked={Boolean(value.parallelScenes)} onChange={parallelScenes => onChange({ parallelScenes })} /></label>
        {value.parallelScenes && <>
            <Select className="w-full" aria-label={t("sceneProduction.reviewRequired")} value={reviewPolicy?.mode || "none"} onChange={(mode: "none" | "automatic" | "mixed" | "manual") => onChange({ reviewPolicy: mode === "none" ? { mode, shared: "none", scene: "none" } : { mode, shared: mode === "automatic" ? "automatic" : "manual", scene: mode === "manual" ? "manual" : "automatic" } })} options={["none", "automatic", "mixed", "manual"].map(option => ({ value: option, label: t(`sceneProduction.mode.${option}`) }))} />
            {reviewPolicy?.mode === "mixed" && (["shared", "scene"] as const).map(gate => <label key={gate} className="flex items-center justify-between gap-3"><span>{t(`sceneProduction.gate.${gate}`)}</span><Select aria-label={t(`sceneProduction.gate.${gate}`)} value={reviewPolicy![gate]} onChange={(mode: "none" | "automatic" | "manual") => onChange({ reviewPolicy: { ...reviewPolicy!, [gate]: mode } })} options={["none", "automatic", "manual"].map(option => ({ value: option, label: t(`sceneProduction.mode.${option}`) }))} /></label>)}
            <p className="text-xs text-muted-foreground">{t("sceneProduction.settingsHint")}</p>
        </>}
    </div>;
}
