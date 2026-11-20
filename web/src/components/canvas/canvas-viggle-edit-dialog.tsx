import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Select, Slider, Input, Tooltip } from "antd";
import { Film, ImagePlus, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { backendMediaUrl } from "@/services/backend-api";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasViggleEditPayload = {
    model: string;
    prompt: string;
    referenceNodeIds: string[];
    shortEdge: number;
};

type Props = {
    open: boolean;
    node: CanvasNodeData | null;
    /** 画布上可当参考图的图片节点。 */
    imageNodes: CanvasNodeData[];
    /** 可选的视频模型名（含 Viggle 视频编辑）。 */
    models: string[];
    onClose: () => void;
    onConfirm: (payload: CanvasViggleEditPayload) => Promise<void> | void;
};

function nodeImageUrl(node: CanvasNodeData) {
    const metadata = node.metadata || {};
    if (metadata.storageKey) return backendMediaUrl(metadata.storageKey);
    return String(metadata.content || "");
}

/**
 * 视频编辑（Viggle Remake）：源视频保动作/镜头/音轨，参考图决定改成谁、什么场景。
 * 弹窗只做输入与参数，节点创建与生成交给画布现有生成链。
 */
export function CanvasViggleEditDialog({ open, node, imageNodes, models, onClose, onConfirm }: Props) {
    const { t } = useTranslation();
    const [model, setModel] = useState("");
    const [prompt, setPrompt] = useState("");
    const [selected, setSelected] = useState<string[]>([]);
    const [shortEdge, setShortEdge] = useState(480);
    const [submitting, setSubmitting] = useState(false);

    const sourceUrl = useMemo(() => {
        const metadata = node?.metadata || {};
        if (metadata.storageKey) return backendMediaUrl(metadata.storageKey);
        return String(metadata.content || metadata.url || "");
    }, [node]);

    const candidates = useMemo(() => imageNodes.filter((item) => Boolean(nodeImageUrl(item))), [imageNodes]);

    useEffect(() => {
        if (!open) return;
        // 视频编辑弹窗默认选 Viggle 系模型，避免落到纯生成/超分模型上。
        const preferred = models.find((item) => /viggle/i.test(item)) || models[0] || "";
        setModel((current) => (models.includes(current) ? current : preferred));
        setPrompt("");
        setSelected([]);
        setShortEdge(480);
        setSubmitting(false);
    }, [models, open, node?.id]);

    const toggle = (nodeId: string) => {
        setSelected((current) => {
            if (current.includes(nodeId)) return current.filter((item) => item !== nodeId);
            if (current.length >= 4) return current;
            return [...current, nodeId];
        });
    };

    const canSubmit = Boolean(node && sourceUrl && model && prompt.trim() && selected.length);

    const submit = async () => {
        if (!canSubmit || submitting) return;
        setSubmitting(true);
        try {
            await onConfirm({ model, prompt: prompt.trim(), referenceNodeIds: selected, shortEdge });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={1080} centered destroyOnHidden>
            <div className="space-y-4">
                <div>
                    <h2 className="flex items-center gap-2 text-xl font-semibold">
                        <WandSparkles className="size-5" />
                        {t("canvas.viggleEdit.title")}
                    </h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.viggleEdit.description")}</p>
                </div>

                <div className="grid gap-5 md:grid-cols-[minmax(320px,1fr)_420px]">
                    <div className="rounded-xl border p-3">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium opacity-75">
                            <Film className="size-4" />
                            {t("canvas.viggleEdit.sourceVideo")}
                        </div>
                        <div className="overflow-hidden rounded-lg bg-black">
                            {sourceUrl ? <video src={sourceUrl} className="max-h-[380px] w-full object-contain" controls playsInline /> : <div className="grid h-[240px] place-items-center text-sm opacity-60">{t("canvas.viggleEdit.missingVideo")}</div>}
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div className="grid grid-cols-[76px_1fr] items-center gap-3">
                            <span className="text-sm font-medium opacity-75">{t("canvas.viggleEdit.model")}</span>
                            <Select value={model || undefined} onChange={setModel} options={models.map((item) => ({ value: item, label: item }))} placeholder={t("canvas.viggleEdit.modelPlaceholder")} />
                        </div>

                        <div>
                            <div className="mb-2 flex items-center justify-between text-sm">
                                <span className="font-medium opacity-75">{t("canvas.viggleEdit.references")}</span>
                                <span className="opacity-50">{selected.length}/4</span>
                            </div>
                            {candidates.length ? (
                                <div className="grid max-h-[190px] grid-cols-4 gap-2 overflow-y-auto pr-1">
                                    {candidates.map((item) => {
                                        const order = selected.indexOf(item.id);
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                onClick={() => toggle(item.id)}
                                                className={`relative aspect-square overflow-hidden rounded-lg border-2 transition ${order >= 0 ? "border-blue-500" : "border-transparent opacity-80 hover:opacity-100"}`}
                                            >
                                                <img src={nodeImageUrl(item)} alt={item.title || ""} className="size-full object-cover" draggable={false} />
                                                {order >= 0 ? <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-blue-500 text-[11px] font-semibold text-white">{order + 1}</span> : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm opacity-60">
                                    <ImagePlus className="size-4" />
                                    {t("canvas.viggleEdit.noReferences")}
                                </div>
                            )}
                        </div>

                        <div>
                            <div className="mb-2 text-sm font-medium opacity-75">{t("canvas.viggleEdit.prompt")}</div>
                            <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} placeholder={t("canvas.viggleEdit.promptPlaceholder")} />
                        </div>

                        <div className="grid grid-cols-[76px_1fr_64px] items-center gap-3">
                            <span className="text-sm font-medium opacity-75">{t("canvas.viggleEdit.shortEdge")}</span>
                            <Slider min={360} max={1080} step={120} value={shortEdge} onChange={setShortEdge} />
                            <span className="text-right text-sm font-semibold">{shortEdge}</span>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between">
                    <p className="text-xs opacity-50">{t("canvas.viggleEdit.hint")}</p>
                    <Tooltip title={canSubmit ? "" : t("canvas.viggleEdit.incomplete")}>
                        <Button type="primary" size="large" loading={submitting} disabled={!canSubmit} icon={<WandSparkles className="size-4" />} onClick={submit}>
                            {t("canvas.viggleEdit.generate")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </Modal>
    );
}
