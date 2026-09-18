import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as AntImage, Modal, Input, Button, message } from "antd";
import { ImagePlus, Save, Trash2, Upload as UploadIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { uploadMediaFile } from "@/services/file-storage";
import { VoiceAssetSelect } from "@/components/assets/voice-asset-select";
import { useAssetStore, type AudioAsset } from "@/stores/use-asset-store";
import { findCharacterVoiceAsset, hasCharacterVoiceSource, resolveCharacterVoiceName } from "@/lib/character-voice";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";

type CharacterImage = NonNullable<CanvasNodeMetadata["characterImages"]>[number];

type Props = {
    open: boolean;
    selectingCanvasImage: boolean;
    canvasImagePick: { id: string; image: CharacterImage } | null;
    node: CanvasNodeData | null;
    onClose: () => void;
    onPickCanvasImage: () => void;
    onSave: (patch: {
        title: string;
        characterName: string;
        characterDescription: string;
        characterImages: CharacterImage[];
        characterPrimaryIndex: number;
        characterVoiceUrl: string;
        characterVoiceName: string;
        characterVoiceDescription: string;
        characterVoiceStorageKey: string;
        characterVoiceAssetId: string;
    }) => void;
};

/** 角色节点双击打开的完整编辑面板：标题/描述/参考图/声线。 */
export function CharacterNodeEditModal({ open, selectingCanvasImage, canvasImagePick, node, onClose, onPickCanvasImage, onSave }: Props) {
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const audioAssets = useMemo(() => assets.filter((asset): asset is AudioAsset => asset.kind === "audio"), [assets]);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [images, setImages] = useState<CharacterImage[]>([]);
    const [primaryIndex, setPrimaryIndex] = useState(0);
    const [voiceUrl, setVoiceUrl] = useState("");
    const [voiceName, setVoiceName] = useState("");
    const [voiceDescription, setVoiceDescription] = useState("");
    const [voiceStorageKey, setVoiceStorageKey] = useState("");
    const [voiceAssetId, setVoiceAssetId] = useState("");
    const [saving, setSaving] = useState(false);
    const voiceInputRef = useRef<HTMLInputElement>(null);
    const lastCanvasImagePickRef = useRef("");

    // 同步打开的节点到本地状态
    useEffect(() => {
        if (!open || !node || node.type !== CanvasNodeType.Character) return;
        const meta = node.metadata || {};
        setTitle(node.title || "");
        setDescription(typeof meta.characterDescription === "string" ? meta.characterDescription : "");
        setImages(Array.isArray(meta.characterImages) ? meta.characterImages : []);
        setPrimaryIndex(Math.min(Math.max(meta.characterPrimaryIndex || 0, 0), Math.max((meta.characterImages?.length || 1) - 1, 0)));
        const storedVoiceUrl = typeof meta.characterVoiceUrl === "string" ? meta.characterVoiceUrl : "";
        const storedVoiceStorageKey = typeof meta.characterVoiceStorageKey === "string" ? meta.characterVoiceStorageKey : "";
        const storedVoiceAssetId = typeof meta.characterVoiceAssetId === "string" ? meta.characterVoiceAssetId : "";
        const voiceAsset = findCharacterVoiceAsset(audioAssets, { assetId: storedVoiceAssetId, storageKey: storedVoiceStorageKey, url: storedVoiceUrl });
        setVoiceUrl(storedVoiceUrl || voiceAsset?.data.url || "");
        setVoiceName(resolveCharacterVoiceName(typeof meta.characterVoiceName === "string" ? meta.characterVoiceName : "", voiceAsset));
        setVoiceDescription(typeof meta.characterVoiceDescription === "string" ? meta.characterVoiceDescription : "");
        setVoiceStorageKey(storedVoiceStorageKey || voiceAsset?.data.storageKey || "");
        setVoiceAssetId(storedVoiceAssetId || voiceAsset?.id || "");
    }, [audioAssets, open, node]);

    useEffect(() => {
        if (!canvasImagePick || canvasImagePick.id === lastCanvasImagePickRef.current) return;
        lastCanvasImagePickRef.current = canvasImagePick.id;
        setImages((current) => current.some((image) => image.storageKey && image.storageKey === canvasImagePick.image.storageKey || image.url === canvasImagePick.image.url) ? current : [...current, canvasImagePick.image]);
    }, [canvasImagePick]);

    const handleVoiceUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const result = await uploadMediaFile(file, "audio", "library");
        setVoiceUrl(result.url);
        setVoiceName(file.name);
        setVoiceStorageKey(result.storageKey || "");
        setVoiceAssetId("");
    }, []);

    const updateImage = (idx: number, patch: Partial<CharacterImage>) => {
        setImages((current) => current.map((image, i) => (i === idx ? { ...image, ...patch } : image)));
    };
    const removeImage = (idx: number) => {
        setImages((current) => {
            const next = current.filter((_, i) => i !== idx);
            if (primaryIndex >= next.length) setPrimaryIndex(Math.max(0, next.length - 1));
            return next;
        });
    };
    const moveImage = (idx: number, dir: -1 | 1) => {
        setImages((current) => {
            const target = idx + dir;
            if (target < 0 || target >= current.length) return current;
            const next = [...current];
            [next[idx], next[target]] = [next[target], next[idx]];
            return next;
        });
    };

    const handleSave = () => {
        if (!images.length) {
            message.error(t("assets.characterRequireOneImage"));
            return;
        }
        setSaving(true);
        onSave({
            title: title.trim() || t("canvas.nodeTypes.character"),
            characterName: title.trim(),
            characterDescription: description.trim(),
            characterImages: images,
            characterPrimaryIndex: Math.min(primaryIndex, images.length - 1),
            characterVoiceUrl: voiceUrl,
            characterVoiceName: resolveCharacterVoiceName(voiceName),
            characterVoiceDescription: voiceDescription.trim(),
            characterVoiceStorageKey: voiceStorageKey,
            characterVoiceAssetId: voiceAssetId,
        });
        setSaving(false);
        onClose();
    };

    const voiceSource = hasCharacterVoiceSource({ url: voiceUrl, storageKey: voiceStorageKey, assetId: voiceAssetId });

    return (
        <Modal open={open && !selectingCanvasImage} onCancel={onClose} footer={null} width={720} destroyOnHidden title={t("canvas.character.editTitle")}>
            <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                        <span className="text-xs text-stone-500">{t("canvas.character.editName")}</span>
                        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("canvas.character.editNamePlaceholder")} />
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-stone-500">{t("canvas.character.voice")}</span>
                        <div className="flex gap-2">
                            <Input
                                value={voiceName || voiceUrl}
                                onChange={(e) => { setVoiceName(e.target.value); setVoiceAssetId(""); }}
                                placeholder={t("canvas.character.editVoicePlaceholder")}
                                addonAfter={
                                    <button type="button" className="text-stone-500 hover:text-stone-700" onClick={() => voiceInputRef.current?.click()}>
                                        <UploadIcon className="size-3.5" />
                                    </button>
                                }
                            />
                            {voiceSource ? (
                                <Button icon={<X className="size-3.5" />} onClick={() => { setVoiceUrl(""); setVoiceName(""); setVoiceDescription(""); setVoiceStorageKey(""); setVoiceAssetId(""); }} />
                            ) : null}
                        </div>
                        {audioAssets.length || voiceSource ? (
                            <VoiceAssetSelect
                                assets={audioAssets}
                                placeholder={t("canvas.character.editPickVoiceAsset")}
                                value={voiceAssetId || undefined}
                                preview={voiceSource ? { id: voiceAssetId, url: voiceUrl, storageKey: voiceStorageKey, name: voiceName } : undefined}
                                onChange={(asset) => {
                                    if (!asset) return;
                                    setVoiceAssetId(asset.id);
                                    setVoiceUrl(asset.data.url);
                                    setVoiceName(asset.title);
                                    setVoiceStorageKey(asset.data.storageKey || "");
                                }}
                            />
                        ) : null}
                        <Input.TextArea rows={2} value={voiceDescription} onChange={(event) => setVoiceDescription(event.target.value)} placeholder={t("assets.character.voiceDescriptionPlaceholder")} />
                    </label>
                </div>
                <label className="block space-y-1">
                    <span className="text-xs text-stone-500">{t("canvas.character.editDescription")}</span>
                    <Input.TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("canvas.character.editDescriptionPlaceholder")} />
                </label>
                <div className="space-y-1">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-stone-500">{t("canvas.character.editImages")}</span>
                        <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={onPickCanvasImage}>
                            {t("canvas.character.addImageFromCanvas")}
                        </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {images.map((image, idx) => (
                            <div key={idx} className="relative rounded-md border border-stone-200 p-2 dark:border-stone-700">
                                <AntImage src={image.url} alt={image.outfit || image.name} preview={{ src: image.url }} className="!h-24 !w-full !rounded !object-cover" />
                                <div className="mt-1 space-y-1">
                                    <Input
                                        size="small"
                                        value={image.outfit}
                                        onChange={(e) => updateImage(idx, { outfit: e.target.value })}
                                        placeholder={t("assets.character.outfitPlaceholder")}
                                    />
                                    <Input.TextArea
                                        size="small"
                                        rows={2}
                                        value={image.outfitDescription}
                                        onChange={(e) => updateImage(idx, { outfitDescription: e.target.value })}
                                        placeholder={t("assets.character.outfitDescriptionPlaceholder")}
                                    />
                                </div>
                                <div className="mt-1 flex justify-between gap-1">
                                    <Button size="small" disabled={idx === 0} onClick={() => moveImage(idx, -1)}>↑</Button>
                                    <Button size="small" disabled={idx === images.length - 1} onClick={() => moveImage(idx, 1)}>↓</Button>
                                    <Button size="small" onClick={() => setPrimaryIndex(idx)} type={idx === primaryIndex ? "primary" : "default"}>
                                        {idx === primaryIndex ? t("canvas.character.primary") : t("canvas.character.setPrimary")}
                                    </Button>
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => removeImage(idx)} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
                <Button onClick={onClose}>{t("common.cancel")}</Button>
                <Button type="primary" icon={<Save className="size-3.5" />} loading={saving} onClick={handleSave}>
                    {t("common.save")}
                </Button>
            </div>
            <input ref={voiceInputRef} type="file" accept="audio/*" className="hidden" onChange={handleVoiceUpload} />
        </Modal>
    );
}
