import { useEffect, useState } from "react";
import { Button, Checkbox, Modal, Segmented, Slider } from "antd";
import { ArrowRight, Palette, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

export type CanvasImageStyleTransferParams = {
    strength: number;
    kind: "auto" | "scene" | "region" | "character";
    keepBlack: boolean;
    bgFollow: boolean;
};

const defaultParams: CanvasImageStyleTransferParams = {
    strength: 1,
    kind: "auto",
    keepBlack: false,
    bgFollow: false,
};

export function CanvasNodeStyleTransferDialog({ targetUrl, styleUrl, open, onClose, onConfirm }: { targetUrl: string; styleUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageStyleTransferParams) => void }) {
    const { t } = useTranslation();
    const [params, setParams] = useState(defaultParams);

    useEffect(() => {
        if (open) setParams(defaultParams);
    }, [targetUrl, styleUrl, open]);

    const update = <Key extends keyof CanvasImageStyleTransferParams>(key: Key, value: CanvasImageStyleTransferParams[Key]) => setParams((current) => ({ ...current, [key]: value }));

    return (
        <Modal title={null} open={open && Boolean(targetUrl && styleUrl)} onCancel={onClose} footer={null} width={860} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.styleTransferTitle")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.editors.styleTransferDescription")}</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_360px]">
                    <div className="flex min-h-[300px] flex-col justify-between rounded-xl border p-4">
                        <div className="grid flex-1 place-items-center">
                            <div className="flex items-center gap-3">
                                <figure className="flex flex-col items-center gap-2">
                                    <img src={targetUrl} alt="" className="size-40 rounded-2xl object-cover shadow-2xl" draggable={false} />
                                    <figcaption className="text-xs opacity-60">{t("canvas.editors.styleTarget")}</figcaption>
                                </figure>
                                <ArrowRight className="size-5 shrink-0 opacity-40" />
                                <figure className="flex flex-col items-center gap-2">
                                    <img src={styleUrl} alt="" className="size-40 rounded-2xl object-cover shadow-2xl" draggable={false} />
                                    <figcaption className="text-xs opacity-60">{t("canvas.editors.styleSource")}</figcaption>
                                </figure>
                            </div>
                        </div>
                        <Button className="w-fit" icon={<RotateCcw className="size-4" />} onClick={() => setParams(defaultParams)}>
                            {t("canvas.editors.reset")}
                        </Button>
                    </div>
                    <div className="space-y-6 py-2">
                        <div className="grid grid-cols-[88px_1fr_72px] items-center gap-4">
                            <span className="font-medium opacity-75">{t("canvas.editors.styleStrength")}</span>
                            <Slider min={0} max={2} step={0.05} value={params.strength} onChange={(value) => update("strength", value)} />
                            <span className="whitespace-nowrap text-right font-semibold">{params.strength.toFixed(2)}</span>
                        </div>
                        <div className="grid grid-cols-[88px_1fr] items-center gap-4">
                            <span className="font-medium opacity-75">{t("canvas.editors.styleKind")}</span>
                            <Segmented
                                className="w-fit"
                                value={params.kind}
                                options={[
                                    { label: t("canvas.editors.styleKindAuto"), value: "auto" },
                                    { label: t("canvas.editors.styleKindScene"), value: "scene" },
                                    { label: t("canvas.editors.styleKindRegion"), value: "region" },
                                    { label: t("canvas.editors.styleKindCharacter"), value: "character" },
                                ]}
                                onChange={(value) => update("kind", value as CanvasImageStyleTransferParams["kind"])}
                            />
                        </div>
                        <div className="space-y-3">
                            <Checkbox checked={params.keepBlack} onChange={(event) => update("keepBlack", event.target.checked)}>
                                {t("canvas.editors.styleKeepBlack")}
                            </Checkbox>
                            <p className="pl-6 text-xs opacity-50">{t("canvas.editors.styleKeepBlackHint")}</p>
                            <Checkbox checked={params.bgFollow} onChange={(event) => update("bgFollow", event.target.checked)}>
                                {t("canvas.editors.styleBgFollow")}
                            </Checkbox>
                            <p className="pl-6 text-xs opacity-50">{t("canvas.editors.styleBgFollowHint")}</p>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="primary" size="large" icon={<Palette className="size-4" />} onClick={() => onConfirm(params)}>
                        {t("canvas.editors.runStyleTransfer")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}