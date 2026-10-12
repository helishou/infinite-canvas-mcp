import { Segmented, Switch } from "antd";
import { useTranslation } from "react-i18next";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";

export function CanvasAppearancePanel({ backgroundMode, showImageInfo, onBackgroundModeChange, onShowImageInfoChange }: { backgroundMode: CanvasBackgroundMode; showImageInfo: boolean; onBackgroundModeChange: (mode: CanvasBackgroundMode) => void; onShowImageInfoChange: (show: boolean) => void }) {
    const { t } = useTranslation();
    const theme = useThemeStore(state => state.theme), setTheme = useThemeStore(state => state.setTheme);
    return <div className="w-64 space-y-4" data-canvas-transient-tool>
        <div><p className="mb-2 text-sm font-medium">{t("canvas.toolbar.themeMode")}</p><div className="flex gap-2">{(["light", "dark"] as const).map(mode => <AnimatedThemeToggler key={mode} theme={theme} targetTheme={mode} onThemeChange={setTheme} className="min-h-10 flex-1 rounded-md px-3 text-sm hover:bg-muted" aria-pressed={theme === mode}>{t(`canvas.toolbar.${mode}`)}</AnimatedThemeToggler>)}</div></div>
        <div><p className="mb-2 text-sm font-medium">{t("canvas.toolbar.gridStyle")}</p><Segmented block value={backgroundMode} onChange={value => onBackgroundModeChange(value as CanvasBackgroundMode)} options={(["dots", "lines", "blank"] as const).map(mode => ({ value: mode, label: t(`canvas.toolbar.${mode}`) }))} /></div>
        <label className="flex items-center justify-between gap-3 text-sm">{t("canvas.toolbar.imageInfo")}<Switch checked={showImageInfo} onChange={onShowImageInfoChange} /></label>
    </div>;
}
