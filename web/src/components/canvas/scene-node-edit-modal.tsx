import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Image as AntImage, Button, Input, Modal, message } from "antd";
import { ImagePlus, Save, Upload as UploadIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SceneColorPaletteEditor } from "@/components/canvas/scene-color-palette-editor";
import { extractSceneColorPalette, normalizeSceneColorPalette } from "@/lib/canvas/scene-color-palette";
import { uploadImage } from "@/services/image-storage";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";

type SceneImage = NonNullable<CanvasNodeMetadata["sceneImage"]>;
type SceneImagePick = { id: string; slot: "image" | "colorCard"; image: SceneImage } | null;

type Props = {
    open: boolean;
    selectingCanvasImage: boolean;
    canvasImagePick: SceneImagePick;
    node: CanvasNodeData | null;
    onClose: () => void;
    onPickCanvasImage: (slot: "image" | "colorCard") => void;
    onSave: (patch: { title: string; sceneName: string; sceneDescription: string; sceneImage: SceneImage; sceneColorCard?: SceneImage; sceneColorPalette?: string[]; sceneColorCardPrompt: string }) => void;
};

export function SceneNodeEditModal({ open, selectingCanvasImage, canvasImagePick, node, onClose, onPickCanvasImage, onSave }: Props) {
    const { t } = useTranslation();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [image, setImage] = useState<SceneImage | null>(null);
    const [colorCard, setColorCard] = useState<SceneImage | null>(null);
    const [colorPalette, setColorPalette] = useState<string[]>([]);
    const [extractingPalette, setExtractingPalette] = useState(false);
    const [colorCardPrompt, setColorCardPrompt] = useState("");
    const [saving, setSaving] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const colorCardInputRef = useRef<HTMLInputElement>(null);
    const lastPickRef = useRef("");
    const paletteExtractionIdRef = useRef(0);

    const extractPalette = useCallback(async (card: SceneImage) => {
        const extractionId = ++paletteExtractionIdRef.current;
        setExtractingPalette(true);
        try {
            const palette = await extractSceneColorPalette(card);
            if (extractionId !== paletteExtractionIdRef.current) return;
            setColorPalette(palette);
            if (!palette.length) message.info(t("canvas.scene.colorPaletteEmptyResult"));
        } catch {
            if (extractionId === paletteExtractionIdRef.current) message.warning(t("canvas.scene.colorPaletteExtractFailed"));
        } finally {
            if (extractionId === paletteExtractionIdRef.current) setExtractingPalette(false);
        }
    }, [t]);

    useEffect(() => {
        if (!open || !node || node.type !== CanvasNodeType.Scene) return;
        const meta = node.metadata || {};
        setTitle(node.title || "");
        setDescription(typeof meta.sceneDescription === "string" ? meta.sceneDescription : "");
        setImage(meta.sceneImage || null);
        setColorCard(meta.sceneColorCard || null);
        setColorPalette(Array.isArray(meta.sceneColorPalette) ? meta.sceneColorPalette : []);
        setColorCardPrompt(typeof meta.sceneColorCardPrompt === "string" ? meta.sceneColorCardPrompt : "");
        paletteExtractionIdRef.current++;
        setExtractingPalette(false);
    }, [node, open]);

    useEffect(() => {
        if (!canvasImagePick || canvasImagePick.id === lastPickRef.current) return;
        lastPickRef.current = canvasImagePick.id;
        if (canvasImagePick.slot === "image") setImage(canvasImagePick.image);
        else {
            setColorCard(canvasImagePick.image);
            setColorPalette([]);
            void extractPalette(canvasImagePick.image);
        }
    }, [canvasImagePick, extractPalette]);

    const uploadSceneImage = useCallback(async (file: File | undefined, slot: "image" | "colorCard") => {
        if (!file || !file.type.startsWith("image/")) return;
        const uploaded = await uploadImage(file, { category: "library" });
        const next: SceneImage = { url: uploaded.url, storageKey: uploaded.storageKey, name: file.name, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
        if (slot === "image") setImage(next);
        else {
            setColorCard(next);
            setColorPalette([]);
            void extractPalette(next);
        }
    }, [extractPalette]);

    const handleSave = () => {
        if (!image) {
            message.error(t("assets.sceneRequireImage"));
            return;
        }
        setSaving(true);
        const palette = normalizeSceneColorPalette(colorPalette);
        onSave({ title: title.trim() || t("canvas.nodeTypes.scene"), sceneName: title.trim(), sceneDescription: description.trim(), sceneImage: image, sceneColorCard: colorCard || undefined, sceneColorPalette: palette.length ? palette : undefined, sceneColorCardPrompt: colorCardPrompt.trim() });
        setSaving(false);
        onClose();
    };

    const imageSlot = (slot: "image" | "colorCard", value: SceneImage | null, inputRef: RefObject<HTMLInputElement | null>, required = false) => (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-xs text-stone-500">{slot === "image" ? t("canvas.scene.image") : t("canvas.scene.colorCard")}{required ? " *" : ""}</span>
                <div className="flex gap-1">
                    <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => onPickCanvasImage(slot)}>{t("canvas.scene.addFromCanvas")}</Button>
                    <Button size="small" icon={<UploadIcon className="size-3.5" />} onClick={() => inputRef.current?.click()}>{t("common.upload")}</Button>
                    {value ? <Button size="small" icon={<X className="size-3.5" />} onClick={() => {
                        if (slot === "image") setImage(null);
                        else {
                            paletteExtractionIdRef.current++;
                            setExtractingPalette(false);
                            setColorCard(null);
                            setColorPalette([]);
                        }
                    }} /> : null}
                </div>
            </div>
            {value ? (
                <div className="relative overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700">
                    <AntImage src={value.url} alt={value.name} preview={{ src: value.url }} className="!h-36 !w-full !object-cover" />
                    <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{value.name}</span>
                </div>
            ) : (
                <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-400 dark:border-stone-700">{required ? t("assets.sceneImageRequired") : t("assets.sceneNoColorCard")}</div>
            )}
            <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { void uploadSceneImage(event.target.files?.[0], slot); event.target.value = ""; }} />
        </div>
    );

    return (
        <Modal open={open && !selectingCanvasImage} onCancel={onClose} footer={null} width={720} destroyOnHidden title={t("canvas.scene.editTitle")}>
            <div className="space-y-4">
                <label className="block space-y-1">
                    <span className="text-xs text-stone-500">{t("canvas.scene.name")}</span>
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("canvas.scene.namePlaceholder")} />
                </label>
                {imageSlot("image", image, imageInputRef, true)}
                <label className="block space-y-1">
                    <span className="text-xs text-stone-500">{t("canvas.scene.description")}</span>
                    <Input.TextArea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("canvas.scene.descriptionPlaceholder")} />
                </label>
                {imageSlot("colorCard", colorCard, colorCardInputRef)}
                <SceneColorPaletteEditor colors={colorPalette} onChange={setColorPalette} hasColorCard={Boolean(colorCard)} reextracting={extractingPalette} onReextract={() => { if (colorCard) void extractPalette(colorCard); }} />
                <label className="block space-y-1">
                    <span className="text-xs text-stone-500">{t("canvas.scene.colorCardPrompt")}</span>
                    <Input.TextArea rows={3} value={colorCardPrompt} onChange={(event) => setColorCardPrompt(event.target.value)} placeholder={t("canvas.scene.colorCardPromptPlaceholder")} />
                </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
                <Button onClick={onClose}>{t("common.cancel")}</Button>
                <Button type="primary" icon={<Save className="size-3.5" />} loading={saving} onClick={handleSave}>{t("common.save")}</Button>
            </div>
        </Modal>
    );
}
