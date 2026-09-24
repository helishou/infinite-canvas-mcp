import { Button, Input } from "antd";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { normalizeSceneHexColor } from "@/lib/canvas/scene-color-palette";

type Props = {
    colors: string[];
    onChange: (colors: string[]) => void;
    onReextract: () => void;
    reextracting?: boolean;
    hasColorCard: boolean;
};

export function SceneColorPaletteEditor({ colors, onChange, onReextract, reextracting = false, hasColorCard }: Props) {
    const { t } = useTranslation();
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t("canvas.scene.colorPalette")}</span>
                <div className="flex gap-1">
                    <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} loading={reextracting} disabled={!hasColorCard} onClick={onReextract}>{t("canvas.scene.reextractColorPalette")}</Button>
                    <Button type="text" size="small" icon={<Plus className="size-3.5" />} onClick={() => onChange([...colors, "#FFFFFF"])}>{t("canvas.scene.addPaletteColor")}</Button>
                </div>
            </div>
            {colors.length ? (
                <div className="grid grid-cols-2 gap-2">
                    {colors.map((color, index) => {
                        const normalized = normalizeSceneHexColor(color);
                        return (
                            <div key={index} className="flex min-w-0 items-center gap-2">
                                <span className="size-5 shrink-0 rounded border border-border" style={{ backgroundColor: normalized || "transparent" }} />
                                <Input
                                    size="small"
                                    value={color}
                                    status={color.trim() && !normalized ? "error" : undefined}
                                    aria-label={t("canvas.scene.colorHexLabel", { index: index + 1 })}
                                    placeholder={t("canvas.scene.colorHexPlaceholder")}
                                    onChange={(event) => onChange(colors.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                                />
                                <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={t("canvas.scene.removePaletteColor")} onClick={() => onChange(colors.filter((_, itemIndex) => itemIndex !== index))} />
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="text-xs text-muted-foreground">{t("canvas.scene.emptyColorPalette")}</div>
            )}
        </div>
    );
}
