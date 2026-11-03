import { useEffect, useState } from "react";
import { App, Image as AntImage, Button, Input, Modal } from "antd";
import { ImagePlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";
import { backendMediaUrl } from "@/services/backend-api";

type PropImage = NonNullable<CanvasNodeMetadata["propImage"]>;
type PropImagePick = { id: string; image: PropImage } | null;
type Props = {
    open: boolean;
    selectingCanvasImage: boolean;
    canvasImagePick: PropImagePick;
    node: CanvasNodeData | null;
    onClose: () => void;
    onPickCanvasImage: () => void;
    onSave: (patch: { title: string; propName: string; propDescription: string; propImage?: PropImage }) => void | Promise<void>;
};

export function PropNodeEditModal({ open, selectingCanvasImage, canvasImagePick, node, onClose, onPickCanvasImage, onSave }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [image, setImage] = useState<PropImage>();
    const [lastPickId, setLastPickId] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open || !node || node.type !== CanvasNodeType.Prop) return;
        setName(String(node.metadata?.propName || node.title || ""));
        setDescription(String(node.metadata?.propDescription || ""));
        setImage(node.metadata?.propImage);
    }, [node, open]);

    useEffect(() => {
        if (!canvasImagePick || canvasImagePick.id === lastPickId) return;
        setLastPickId(canvasImagePick.id);
        setImage(canvasImagePick.image);
    }, [canvasImagePick, lastPickId]);

    const imageUrl = image?.storageKey ? backendMediaUrl(image.storageKey) : image?.url || "";
    const save = async () => {
        if (saving) return;
        const title = name.trim() || t("canvas.nodeTypes.prop");
        setSaving(true);
        try {
            await onSave({ title, propName: title, propDescription: description.trim(), propImage: image });
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    return <Modal open={open && !selectingCanvasImage} title={t("canvas.prop.editTitle")} onCancel={() => { if (!saving) onClose(); }} onOk={save} confirmLoading={saving} cancelButtonProps={{ disabled: saving }} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
        <div className="space-y-4">
            <label className="block space-y-1"><span className="text-xs text-muted-foreground">{t("canvas.prop.name")}</span><Input value={name} disabled={saving} onChange={event => setName(event.target.value)} placeholder={t("canvas.prop.namePlaceholder")} /></label>
            <section className="space-y-2">
                <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{t("canvas.prop.image")}</span><div className="flex gap-1"><Button size="small" disabled={saving} icon={<ImagePlus className="size-3.5" />} onClick={onPickCanvasImage}>{t("canvas.prop.addFromCanvas")}</Button>{image && <Button size="small" disabled={saving} onClick={() => setImage(undefined)}>{t("common.remove")}</Button>}</div></div>
                {imageUrl ? <AntImage src={imageUrl} alt={image?.name || ""} preview={{ src: imageUrl }} className="!h-36 !w-full !object-contain" /> : <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground ">{t("canvas.prop.noImage")}</div>}
            </section>
            <label className="block space-y-1"><span className="text-xs text-muted-foreground">{t("canvas.prop.description")}</span><Input.TextArea rows={3} value={description} disabled={saving} onChange={event => setDescription(event.target.value)} placeholder={t("canvas.prop.descriptionPlaceholder")} /></label>
        </div>
    </Modal>;
}
