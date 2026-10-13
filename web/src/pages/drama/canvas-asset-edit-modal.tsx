import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, message } from "antd";
import { ImagePlus, Save, Trash2, Upload as UploadIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MediaImage } from "@/components/media/media-image";
import { VoiceAssetSelect } from "@/components/assets/voice-asset-select";
import { uploadMediaFile } from "@/services/file-storage";
import { useAssetStore, type AudioAsset } from "@/stores/use-asset-store";
import { findCharacterVoiceAsset, hasCharacterVoiceSource, resolveCharacterVoiceName } from "@/lib/character-voice";
import { backendMediaUrl } from "@/services/backend-api";

// CanvasNodeOption 是 director-panel.tsx 内的局部 type（未 export），这里镜像一份。
type CanvasNodeOption = { id: string; title?: string; type?: string; metadata?: Record<string, unknown> };

// 与 web/src/types/canvas.ts 的 CanvasNodeMetadata 内联类型一致。
type CharacterImage = { url: string; storageKey?: string; name: string; outfit: string; outfitDescription: string; role?: string; width: number; height: number; bytes: number; mimeType: string };
type SceneImage = { url: string; storageKey?: string; name: string; width: number; height: number; bytes: number; mimeType: string };
type PropImage = SceneImage;

export type CanvasAssetEditPayload = {
    title: string;
    characterName?: string;
    characterDescription?: string;
    characterImages?: CharacterImage[];
    characterPrimaryIndex?: number;
    characterVoiceUrl?: string;
    characterVoiceName?: string;
    characterVoiceDescription?: string;
    characterVoiceStorageKey?: string;
    characterVoiceAssetId?: string;
    sceneName?: string;
    sceneDescription?: string;
    sceneImage?: SceneImage;
    propName?: string;
    propDescription?: string;
    propImage?: PropImage;
};

const IMAGE_ROLE_OPTIONS = [
    "character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe",
    "motion_reference", "style", "palette", "prop", "other",
] as const;

type CardImages = Array<{ storageKey?: string; url?: string; label: string; primary?: boolean }>;

type Props = {
    open: boolean;
    item: { node: CanvasNodeOption; kind: string; name: string; description: string; images: CardImages };
    busy: boolean;
    onCancel: () => void;
    onSave: (payload: CanvasAssetEditPayload) => Promise<boolean>;
};

/** 制作台素材弹窗编辑：名称/说明 + 参考图/主图 + 角色声线。对齐画布节点编辑弹窗的字段。 */
export function CanvasAssetEditModal({ open, item, busy, onCancel, onSave }: Props) {
    const { t } = useTranslation();
    const nodeType = String(item.node.type || "");
    const metadata = (item.node.metadata || {}) as Record<string, unknown>;

    const [title, setTitle] = useState("");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [images, setImages] = useState<CharacterImage[]>([]);
    const [primaryIndex, setPrimaryIndex] = useState(0);
    const [sceneImage, setSceneImage] = useState<SceneImage | undefined>(undefined);
    const [propImage, setPropImage] = useState<PropImage | undefined>(undefined);
    const [voiceUrl, setVoiceUrl] = useState("");
    const [voiceName, setVoiceName] = useState("");
    const [voiceDescription, setVoiceDescription] = useState("");
    const [voiceStorageKey, setVoiceStorageKey] = useState("");
    const [voiceAssetId, setVoiceAssetId] = useState("");
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const voiceInputRef = useRef<HTMLInputElement>(null);

    const audioAssets = useAssetStore((state) => state.assets).filter((asset): asset is AudioAsset => asset.kind === "audio");
    const voiceAsset = findCharacterVoiceAsset(audioAssets, { assetId: voiceAssetId, storageKey: voiceStorageKey, url: voiceUrl });

    // 打开时从节点 metadata 读初始值（只读展示用的 item.images 不含 role/outfit，必须读 node.metadata）。
    useEffect(() => {
        if (!open) return;
        setTitle(String(item.node.title || ""));
        setName(nodeType === "character" ? (typeof metadata.characterName === "string" ? metadata.characterName : String(item.node.title || "")) : "");
        setDescription(typeof metadata.characterDescription === "string" ? metadata.characterDescription
            : typeof metadata.sceneDescription === "string" ? metadata.sceneDescription
            : typeof metadata.propDescription === "string" ? metadata.propDescription : item.description || "");
        setImages(Array.isArray(metadata.characterImages) ? (metadata.characterImages as CharacterImage[]) : []);
        setPrimaryIndex(Math.min(Math.max(Number(metadata.characterPrimaryIndex) || 0, 0), Math.max(images.length - 1, 0)));
        setSceneImage((metadata.sceneImage && typeof metadata.sceneImage === "object") ? metadata.sceneImage as SceneImage : undefined);
        setPropImage((metadata.propImage && typeof metadata.propImage === "object") ? metadata.propImage as PropImage : undefined);
        setVoiceUrl(typeof metadata.characterVoiceUrl === "string" ? metadata.characterVoiceUrl : "");
        setVoiceName(typeof metadata.characterVoiceName === "string" ? metadata.characterVoiceName : "");
        setVoiceDescription(typeof metadata.characterVoiceDescription === "string" ? metadata.characterVoiceDescription : "");
        setVoiceStorageKey(typeof metadata.characterVoiceStorageKey === "string" ? metadata.characterVoiceStorageKey : "");
        setVoiceAssetId(typeof metadata.characterVoiceAssetId === "string" ? metadata.characterVoiceAssetId : "");
        setSaving(false);
        setUploading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, item.node.id]);

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
            if (primaryIndex === idx) setPrimaryIndex(target);
            else if (primaryIndex === target) setPrimaryIndex(idx);
            return next;
        });
    };

    const uploadImageFile = async () => {
        const file = imageInputRef.current?.files?.[0];
        if (imageInputRef.current) imageInputRef.current.value = "";
        if (!file || !file.type.startsWith("image/")) return;
        setUploading(true);
        try {
            const uploaded = await uploadMediaFile(file, "asset", "library");
            const base = { url: uploaded.url, storageKey: uploaded.storageKey, name: file.name, width: uploaded.width || 0, height: uploaded.height || 0, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
            if (nodeType === "character") {
                setImages((current) => [...current, { ...base, outfit: "", outfitDescription: "", role: "character_turnaround" }]);
            } else if (nodeType === "scene") setSceneImage(base);
            else setPropImage(base);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setUploading(false);
        }
    };

    const uploadVoiceFile = async () => {
        const file = voiceInputRef.current?.files?.[0];
        if (voiceInputRef.current) voiceInputRef.current.value = "";
        if (!file) return;
        setUploading(true);
        try {
            const result = await uploadMediaFile(file, "voice", "library", { characterVoiceCompression: true });
            setVoiceUrl(result.url);
            setVoiceName(result.compression ? `${file.name.replace(/\.[^.]+$/, "")}-24k-64kbps.mp3` : file.name);
            setVoiceStorageKey(result.storageKey || "");
            setVoiceAssetId("");
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            message.error(reason === "CHARACTER_VOICE_COMPRESSION_UNAVAILABLE"
                ? t("canvas.character.voiceBackendRestartRequired")
                : t("canvas.character.voiceUploadFailed", { reason }));
        } finally {
            setUploading(false);
        }
    };

    const voiceSource = hasCharacterVoiceSource({ url: voiceUrl, storageKey: voiceStorageKey, assetId: voiceAssetId });

    const handleSave = async () => {
        if (saving || busy || uploading) return;
        setSaving(true);
        try {
            const payload: CanvasAssetEditPayload = { title: title.trim() || name.trim() || t("director.crud.unnamedAsset") };
            if (nodeType === "character") {
                payload.characterName = name.trim();
                payload.characterDescription = description.trim();
                payload.characterImages = images.map((image) => ({ ...image, role: image.role || "character_turnaround" }));
                payload.characterPrimaryIndex = images.length ? Math.min(primaryIndex, images.length - 1) : 0;
                payload.characterVoiceUrl = voiceUrl;
                payload.characterVoiceName = resolveCharacterVoiceName(voiceName);
                payload.characterVoiceDescription = voiceDescription.trim();
                payload.characterVoiceStorageKey = voiceStorageKey;
                payload.characterVoiceAssetId = voiceAssetId;
            } else if (nodeType === "scene") {
                payload.sceneName = name.trim() || title.trim();
                payload.sceneDescription = description.trim();
                payload.sceneImage = sceneImage;
            } else {
                payload.propName = name.trim() || title.trim();
                payload.propDescription = description.trim();
                payload.propImage = propImage;
            }
            if (await onSave(payload)) onCancel();
        } finally {
            setSaving(false);
        }
    };

    const labelClass = "text-xs text-stone-500";
    const imageUrlOf = (image: { url?: string; storageKey?: string }) => image.url || (image.storageKey ? backendMediaUrl(image.storageKey) : "");

    return <Modal open={open} onCancel={onCancel} footer={null} width={760} destroyOnHidden title={t("director.crud.editCanvasAsset")}>
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                    <span className={labelClass}>{t("director.crud.nameLabel")}</span>
                    <Input value={nodeType === "character" ? name : title} onChange={event => { nodeType === "character" ? setName(event.target.value) : setTitle(event.target.value); }} placeholder={t("director.crud.namePlaceholder")} />
                </label>
                {nodeType === "character" && <label className="space-y-1">
                    <span className={labelClass}>{t("director.crud.voiceLabel")}</span>
                    <div className="flex gap-2">
                        <Input
                            value={voiceName || voiceUrl}
                            onChange={event => { setVoiceName(event.target.value); setVoiceAssetId(""); }}
                            placeholder={t("canvas.character.editVoicePlaceholder")}
                            addonAfter={<button type="button" className="text-stone-500 hover:text-stone-700" onClick={() => voiceInputRef.current?.click()}><UploadIcon className="size-3.5" /></button>}
                        />
                        {voiceSource ? <Button icon={<X className="size-3.5" />} onClick={() => { setVoiceUrl(""); setVoiceName(""); setVoiceDescription(""); setVoiceStorageKey(""); setVoiceAssetId(""); }} /> : null}
                    </div>
                    {audioAssets.length || voiceSource ? <VoiceAssetSelect
                        assets={audioAssets}
                        placeholder={t("canvas.character.editPickVoiceAsset")}
                        value={voiceAssetId || undefined}
                        preview={voiceSource ? { id: voiceAssetId, url: voiceUrl, storageKey: voiceStorageKey, name: voiceName } : undefined}
                        onChange={asset => {
                            if (!asset) return;
                            setVoiceAssetId(asset.id);
                            setVoiceUrl(asset.data.url);
                            setVoiceName(asset.title);
                            setVoiceStorageKey(asset.data.storageKey || "");
                        }}
                    /> : null}
                    <Input.TextArea rows={2} value={voiceDescription} onChange={event => setVoiceDescription(event.target.value)} placeholder={t("assets.character.voiceDescriptionPlaceholder")} />
                </label>}
            </div>
            <label className="block space-y-1">
                <span className={labelClass}>{t("director.crud.descriptionLabel")}</span>
                <Input.TextArea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder={t("director.crud.descriptionPlaceholder")} />
            </label>

            {nodeType === "character" && <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className={labelClass}>{t("director.crud.characterImagesLabel")}</span>
                    <div className="flex gap-1">
                        <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => imageInputRef.current?.click()}>{t("director.crud.uploadImage")}</Button>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {images.map((image, idx) => <div key={`${image.storageKey || image.url}:${idx}`} className="relative rounded-md border border-stone-200 p-2 dark:border-stone-700">
                        <MediaImage src={imageUrlOf(image)} alt={image.outfit || image.name} name={image.outfit || image.name} className="!h-24 !w-full !rounded !object-cover" />
                        <div className="mt-1 space-y-1">
                            <Input size="small" value={image.outfit} onChange={event => updateImage(idx, { outfit: event.target.value })} placeholder={t("assets.character.outfitPlaceholder")} />
                            <label className="block space-y-1">
                                <span className={labelClass}>{t("director.crud.imageRoleLabel")}</span>
                                <Select size="small" className="w-full" value={image.role || "character_turnaround"} options={IMAGE_ROLE_OPTIONS.map(role => ({ value: role, label: t(`canvas.character.imageRoles.${role}`) }))} onChange={role => updateImage(idx, { role })} />
                            </label>
                            <Input.TextArea size="small" rows={2} value={image.outfitDescription} onChange={event => updateImage(idx, { outfitDescription: event.target.value })} placeholder={t("assets.character.outfitDescriptionPlaceholder")} />
                        </div>
                        <div className="mt-1 flex flex-wrap justify-between gap-1">
                            <div className="flex gap-1">
                                <Button size="small" disabled={idx === 0} onClick={() => moveImage(idx, -1)}>↑</Button>
                                <Button size="small" disabled={idx === images.length - 1} onClick={() => moveImage(idx, 1)}>↓</Button>
                            </div>
                            <div className="flex gap-1">
                                <Button size="small" type={idx === primaryIndex ? "primary" : "default"} onClick={() => setPrimaryIndex(idx)}>{idx === primaryIndex ? t("canvas.character.primary") : t("canvas.character.setPrimary")}</Button>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => removeImage(idx)} />
                            </div>
                        </div>
                    </div>)}
                </div>
                {images.length === 0 && <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-400 dark:border-stone-700">{t("director.crud.noImages")}</div>}
            </div>}

            {(nodeType === "scene" || nodeType === "prop") && <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <span className={labelClass}>{nodeType === "scene" ? t("director.crud.sceneImageLabel") : t("director.crud.propImageLabel")}</span>
                    <div className="flex gap-1">
                        <Button size="small" icon={<UploadIcon className="size-3.5" />} onClick={() => imageInputRef.current?.click()}>{t("director.crud.uploadImage")}</Button>
                        {(sceneImage || propImage) ? <Button size="small" icon={<X className="size-3.5" />} onClick={() => { nodeType === "scene" ? setSceneImage(undefined) : setPropImage(undefined); }} /> : null}
                    </div>
                </div>
                {(() => {
                    const image = nodeType === "scene" ? sceneImage : propImage;
                    if (!image) return <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-400 dark:border-stone-700">{t("director.crud.noImage")}</div>;
                    return <div className="relative overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700">
                        <MediaImage src={imageUrlOf(image)} alt={image.name} name={image.name} className="!h-36 !w-full !object-contain" />
                        <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">{image.name}</span>
                    </div>;
                })()}
            </div>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
            <Button onClick={onCancel}>{t("common.cancel")}</Button>
            <Button type="primary" icon={<Save className="size-3.5" />} loading={saving} disabled={busy || uploading} onClick={() => void handleSave()}>{t("common.save")}</Button>
        </div>
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={() => void uploadImageFile()} />
        <input ref={voiceInputRef} type="file" accept="audio/*" className="hidden" onChange={() => void uploadVoiceFile()} />
    </Modal>;
}
