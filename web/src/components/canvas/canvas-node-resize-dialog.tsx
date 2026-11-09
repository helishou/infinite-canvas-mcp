import { useEffect, useMemo, useState } from "react";
import { Button, InputNumber, Modal, Segmented, Slider } from "antd";
import { ImagePlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readImageMeta } from "@/lib/image-utils";
import { MAX_RESIZE_LONG_EDGE, MIN_RESIZE_LONG_EDGE, resolveResizeSize, type ImageResizeAlgorithm, type ImageResizeParams } from "@/lib/canvas/canvas-image-data";

export type CanvasImageResizeParams = ImageResizeParams;

const algorithms: ImageResizeAlgorithm[] = ["high", "bilinear", "nearest"];

const targetOptions = [
    { label: "256", value: 256 },
    { label: "512", value: 512 },
    { label: "1K", value: 1024 },
    { label: "2K", value: 2048 },
    { label: "4K", value: MAX_RESIZE_LONG_EDGE },
];

const defaultAlgorithm: ImageResizeAlgorithm = "high";

export function CanvasNodeResizeDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageResizeParams) => void }) {
    const { t } = useTranslation();
    const [targetLongEdge, setTargetLongEdge] = useState<number | null>(null);
    const [algorithm, setAlgorithm] = useState<ImageResizeAlgorithm>(defaultAlgorithm);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const sourceLongEdge = image ? Math.max(image.width, image.height) : 0;
    const outputSize = useMemo(() => (image && targetLongEdge !== null ? resolveResizeSize(image.width, image.height, targetLongEdge) : null), [image, targetLongEdge]);
    const inRange = targetLongEdge !== null && targetLongEdge >= MIN_RESIZE_LONG_EDGE && targetLongEdge <= MAX_RESIZE_LONG_EDGE;
    const unchanged = Boolean(image && outputSize && outputSize.width === image.width && outputSize.height === image.height);
    const canResize = Boolean(image && outputSize && inRange && !unchanged);
    const ratio = image && outputSize ? outputSize.width / image.width : 1;
    const direction = ratio > 1 ? t("canvas.editors.enlarge") : ratio < 1 ? t("canvas.editors.shrink") : t("canvas.editors.sameSize");

    const updateTarget = (value: string | number | null | undefined) => {
        if (value === null || value === undefined || value === "") {
            setTargetLongEdge(null);
            return;
        }
        const parsed = Number(value);
        setTargetLongEdge(Number.isFinite(parsed) ? parsed : null);
    };

    useEffect(() => {
        if (!open) return;
        setTargetLongEdge(null);
        setAlgorithm(defaultAlgorithm);
        setImage(null);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void readImageMeta(dataUrl).then((meta) => {
            if (!cancelled) setImage(meta);
        });
        return () => {
            cancelled = true;
        };
    }, [dataUrl, open]);

    useEffect(() => {
        if (!image) return;
        // 小于 4K 的图默认给下一档放大目标；已达到或超过 4K 的图默认给 2K，打开即可直接缩小。
        const nextTarget = sourceLongEdge < MAX_RESIZE_LONG_EDGE
            ? targetOptions.find((option) => option.value > sourceLongEdge)?.value || MAX_RESIZE_LONG_EDGE
            : targetOptions[targetOptions.length - 2].value;
        setTargetLongEdge((current) => current ?? nextTarget);
    }, [image, sourceLongEdge]);

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={820} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.resizeTitle")}</h2>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_360px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[280px] place-items-center rounded-lg bg-black/5">
                            <img src={dataUrl} alt="" className="max-h-[320px] max-w-full rounded-lg object-contain shadow-xl" draggable={false} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("canvas.editors.source")}</span>
                            <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : t("canvas.editors.loading")}</span>
                        </div>
                    </div>
                    <div className="space-y-5 py-2">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-medium opacity-75">{t("canvas.editors.targetPixels")}</span>
                                <span className="text-xs opacity-55">{t("canvas.editors.targetHint", { min: MIN_RESIZE_LONG_EDGE, max: MAX_RESIZE_LONG_EDGE })}</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <Slider
                                    className="flex-1"
                                    aria-label={t("canvas.editors.targetPixels")}
                                    min={MIN_RESIZE_LONG_EDGE}
                                    max={MAX_RESIZE_LONG_EDGE}
                                    step={1}
                                    value={targetLongEdge ?? MIN_RESIZE_LONG_EDGE}
                                    tooltip={{ formatter: (value) => `${value ?? 0} px` }}
                                    onChange={(value) => updateTarget(Array.isArray(value) ? value[0] : value)}
                                />
                                <InputNumber
                                    className="w-[104px]"
                                    aria-label={t("canvas.editors.targetPixels")}
                                    min={MIN_RESIZE_LONG_EDGE}
                                    max={MAX_RESIZE_LONG_EDGE}
                                    precision={0}
                                    value={targetLongEdge}
                                    onChange={updateTarget}
                                />
                            </div>
                            <div className="text-xs opacity-55">{t("canvas.editors.quickTargets")}</div>
                            <Segmented
                                block
                                value={targetLongEdge !== null && targetOptions.some((option) => option.value === targetLongEdge) ? targetLongEdge : undefined}
                                options={targetOptions.map((option) => ({ label: option.label, value: option.value, disabled: Boolean(image && sourceLongEdge === option.value) }))}
                                onChange={(value) => updateTarget(value)}
                            />
                            {image && targetLongEdge !== null && !canResize ? (
                                <div className="text-xs font-medium text-[#ef4444]">
                                    {inRange ? t("canvas.editors.targetReached") : t("canvas.editors.invalidTarget", { min: MIN_RESIZE_LONG_EDGE, max: MAX_RESIZE_LONG_EDGE })}
                                </div>
                            ) : null}
                        </div>
                        <div className="space-y-2">
                            <div className="font-medium opacity-75">{t("canvas.editors.algorithm")}</div>
                            <Segmented
                                block
                                value={algorithm}
                                options={algorithms.map((item) => ({
                                    value: item,
                                    label: (
                                        <span className="flex min-h-12 flex-col justify-center text-left leading-5">
                                            <span className="font-medium">{t(`canvas.editors.${item}`)}</span>
                                            <span className="text-xs opacity-55">{t(`canvas.editors.${item}Description`)}</span>
                                        </span>
                                    ),
                                }))}
                                onChange={(value) => setAlgorithm(value as ImageResizeAlgorithm)}
                            />
                        </div>
                        <div className="space-y-1 rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.outputSize")}</span>
                                <span className="font-semibold">{outputSize ? `${outputSize.width} x ${outputSize.height} px` : t("canvas.editors.unknown")}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.scale")}</span>
                                <span className="font-semibold">{outputSize ? `×${ratio.toFixed(2)} · ${direction}` : t("canvas.editors.unknown")}</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button
                        type="primary"
                        size="large"
                        icon={<ImagePlus className="size-4" />}
                        disabled={!canResize || targetLongEdge === null}
                        onClick={() => {
                            if (targetLongEdge === null || !canResize) return;
                            onConfirm({ targetLongEdge, algorithm });
                        }}
                    >
                        {t("canvas.editors.applyResize")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
