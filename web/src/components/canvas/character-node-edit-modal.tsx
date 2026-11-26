import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as AntImage, Modal, Input, Button, message, Select } from "antd";
import { ImagePlus, Save, Trash2, Upload as UploadIcon, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { uploadMediaFile } from "@/services/file-storage";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { VoiceAssetSelect } from "@/components/assets/voice-asset-select";
import { useAssetStore, type AudioAsset } from "@/stores/use-asset-store";
import { findCharacterVoiceAsset, hasCharacterVoiceSource, resolveCharacterVoiceName } from "@/lib/character-voice";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";

type CharacterImage = NonNullable<CanvasNodeMetadata["characterImages"]>[number];

const IMAGE_ROLE_KEYS = [
    "character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe",
    "motion_reference", "style", "palette", "prop", "other",
] as const;

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
        characterAliases: string[];
        characterRole: string;
    }) => void;
};

/** 角色节点双击打开的完整编辑面板：标题/描述/参考图/声线。 */
export function CharacterNodeEditModal({ open, selectingCanvasImage, canvasImagePick, node, onClose, onPickCanvasImage, onSave }: Props) {
    const { t } = useTranslation();
    const imageRoleOptions = IMAGE_ROLE_KEYS.map((role) => ({ value: role, label: t(`canvas.character.imageRoles.${role}`) }));
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
    const [uploadingVoice, setUploadingVoice] = useState(false);
    const [replaceImageIndex, setReplaceImageIndex] = useState<number | null>(null);
    const voiceInputRef = useRef<HTMLInputElement>(null);
    const imageUploadRef = useRef<HTMLInputElement>(null);
    const lastCanvasImagePickRef = useRef("");
    // 影策三 tab 工作台：设定(profile) / 形象(visual) / 声音(voice)。
    const [tab, setTab] = useState<"profile" | "visual" | "voice">("profile");
    const [aliases, setAliases] = useState("");
    const [role, setRole] = useState("");
    const [libraryPickOpen, setLibraryPickOpen] = useState(false);

    // 同步打开的节点到本地状态
    useEffect(() => {
        if (!open || !node || node.type !== CanvasNodeType.Character) return;
        const meta = node.metadata || {};
        setTitle(node.title || "");
        setDescription(typeof meta.characterDescription === "string" ? meta.characterDescription : "");
        setAliases(Array.isArray(meta.characterAliases) ? meta.characterAliases.map(String).join("，") : "");
        setRole(typeof meta.characterRole === "string" ? meta.characterRole : "");
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
        if (replaceImageIndex !== null) {
            setImages((current) => current.map((image, index) => index === replaceImageIndex
                ? { ...image, ...canvasImagePick.image, outfit: image.outfit, outfitDescription: image.outfitDescription, role: image.role }
                : image));
            setReplaceImageIndex(null);
            return;
        }
        setImages((current) => current.some((image) => image.storageKey && image.storageKey === canvasImagePick.image.storageKey || image.url === canvasImagePick.image.url) ? current : [...current, canvasImagePick.image]);
    }, [canvasImagePick, replaceImageIndex]);

    useEffect(() => {
        if (!selectingCanvasImage && replaceImageIndex !== null && (!canvasImagePick || canvasImagePick.id === lastCanvasImagePickRef.current)) {
            setReplaceImageIndex(null);
        }
    }, [canvasImagePick, replaceImageIndex, selectingCanvasImage]);

    const handleVoiceUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setUploadingVoice(true);
        try {
            const result = await uploadMediaFile(file, "audio", "library", { characterVoiceCompression: true });
            setVoiceUrl(result.url);
            setVoiceName(result.compression ? `${file.name.replace(/\.[^.]+$/, "")}-24k-64kbps.mp3` : file.name);
            setVoiceStorageKey(result.storageKey || "");
            setVoiceAssetId("");
            if (result.compression) message.success(t("canvas.character.voiceCompressed", { before: Math.round(file.size / 1024), after: Math.round(result.bytes / 1024) }));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            message.error(reason === "CHARACTER_VOICE_COMPRESSION_UNAVAILABLE"
                ? t("canvas.character.voiceBackendRestartRequired")
                : t("canvas.character.voiceUploadFailed", { reason }));
        } finally {
            setUploadingVoice(false);
        }
    }, [t]);

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

    // 影策 visual tab：从素材库选图采用，作为一张参考图加入本角色（不造假 storageKey）。
    const handleLibraryPick = (payload: InsertAssetPayload) => {
        if (payload.kind !== "image") return;
        const image: CharacterImage = {
            id: `lib:${payload.storageKey || payload.dataUrl}`,
            name: payload.title, outfit: "", outfitDescription: "", role: "character_turnaround",
            url: payload.storageKey ? `/media/${encodeURIComponent(payload.storageKey)}` : payload.dataUrl,
            storageKey: payload.storageKey || undefined,
            width: 0, height: 0, bytes: 0, mimeType: "image/png",
        } as CharacterImage;
        setImages((current) => current.some((item) => item.storageKey && item.storageKey === image.storageKey) ? current : [...current, image]);
        setLibraryPickOpen(false);
    };
    // 影策 visual tab 第一格：上传本地图片作为参考图（真实归档到媒体库）。
    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setUploadingVoice(true);
        try {
            const result = await uploadMediaFile(file, "image", "library");
            const image: CharacterImage = {
                id: `upload:${result.storageKey || result.url}`,
                name: file.name, outfit: "", outfitDescription: "", role: "character_turnaround",
                url: result.url, storageKey: result.storageKey || undefined,
                width: Number(result.width || 0), height: Number(result.height || 0), bytes: Number(result.bytes || 0), mimeType: String(result.mimeType || file.type || "image/png"),
            } as CharacterImage;
            setImages((current) => [...current, image]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setUploadingVoice(false);
        }
    };

    const handleSave = () => {
        if (uploadingVoice) return;
        if (!node?.metadata?.productionEntity && !images.length && !hasCharacterVoiceSource({ url: voiceUrl, storageKey: voiceStorageKey, assetId: voiceAssetId })) {
            message.error(t("assets.characterRequireReference"));
            return;
        }
        setSaving(true);
        onSave({
            title: title.trim() || t("canvas.nodeTypes.character"),
            characterName: title.trim(),
            characterDescription: description.trim(),
            characterImages: images.map((image) => ({ ...image, role: image.role || "character_turnaround" })),
            characterPrimaryIndex: images.length ? Math.min(primaryIndex, images.length - 1) : 0,
            characterVoiceUrl: voiceUrl,
            characterVoiceName: resolveCharacterVoiceName(voiceName),
            characterVoiceDescription: voiceDescription.trim(),
            characterVoiceStorageKey: voiceStorageKey,
            characterVoiceAssetId: voiceAssetId,
            characterAliases: aliases.split(/[，,、]/).map((a) => a.trim()).filter(Boolean),
            characterRole: role.trim(),
        });
        setSaving(false);
        onClose();
    };

    const voiceSource = hasCharacterVoiceSource({ url: voiceUrl, storageKey: voiceStorageKey, assetId: voiceAssetId });

    return (
        <Modal open={open && !selectingCanvasImage} onCancel={onClose} footer={null} width={720} destroyOnHidden title={t("canvas.character.editTitle")}>
            <div className="min-h-[320px]">
                <div className="mb-4 flex gap-1 border-b border-border">
                    {([["profile", t("canvas.character.tabProfile")], ["visual", t("canvas.character.tabVisual")], ["voice", t("canvas.character.tabVoice")]] as const).map(([key, label]) => (
                        <button key={key} type="button" onClick={() => setTab(key)}
                            className={`px-4 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${tab === key ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                            {label}
                        </button>
                    ))}
                </div>
                {tab === "profile" ? (
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="space-y-1">
                                <span className="text-xs text-muted-foreground">{t("canvas.character.editName")}</span>
                                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("canvas.character.editNamePlaceholder")} />
                            </label>
                            <label className="space-y-1">
                                <span className="text-xs text-muted-foreground">{t("canvas.character.roleLabel")}</span>
                                <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("canvas.character.rolePlaceholder")} />
                            </label>
                        </div>
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("canvas.character.aliasesLabel")}</span>
                            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder={t("canvas.character.aliasesPlaceholder")} />
                        </label>
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("canvas.character.editDescription")}</span>
                            <Input.TextArea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("canvas.character.editDescriptionPlaceholder")} />
                        </label>
                    </div>
                ) : null}
                {tab === "visual" ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">{t("canvas.character.editImages")}</span>
                            <span className="flex gap-2">
                                <Button size="small" icon={<UploadIcon className="size-3.5" />} onClick={() => imageUploadRef.current?.click()}>
                                    {t("canvas.character.uploadLocalImage")}
                                </Button>
                                <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => setLibraryPickOpen(true)}>
                                    {t("canvas.character.pickFromLibrary")}
                                </Button>
                                <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={onPickCanvasImage}>
                                    {t("canvas.character.addImageFromCanvas")}
                                </Button>
                            </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {images.map((image, idx) => (
                                <div key={idx} className="relative rounded-md border border-border p-2 ">
                                    <AntImage src={image.url} alt={image.outfit || image.name} preview={{ src: image.url }} className="!h-24 !w-full !rounded !object-cover" />
                                    <div className="mt-1 space-y-1">
                                        <Input size="small" value={image.outfit} onChange={(e) => updateImage(idx, { outfit: e.target.value })} placeholder={t("assets.character.outfitPlaceholder")} />
                                        <label className="block space-y-1">
                                            <span className="text-xs text-muted-foreground">{t("canvas.character.imageRole")}</span>
                                            <Select size="small" className="w-full" value={image.role || "character_turnaround"} options={imageRoleOptions} onChange={(role) => updateImage(idx, { role })} />
                                        </label>
                                        <Input.TextArea size="small" rows={2} value={image.outfitDescription} onChange={(e) => updateImage(idx, { outfitDescription: e.target.value })} placeholder={t("assets.character.outfitDescriptionPlaceholder")} />
                                    </div>
                                    <div className="mt-1 flex justify-between gap-1">
                                        <Button size="small" disabled={idx === 0} onClick={() => moveImage(idx, -1)}>↑</Button>
                                        <Button size="small" disabled={idx === images.length - 1} onClick={() => moveImage(idx, 1)}>↓</Button>
                                        <Button size="small" onClick={() => setPrimaryIndex(idx)} type={idx === primaryIndex ? "primary" : "default"}>
                                            {idx === primaryIndex ? t("canvas.character.primary") : t("canvas.character.setPrimary")}
                                        </Button>
                                        <Button size="small" icon={<ImagePlus className="size-3.5" />} title={t("canvas.character.replaceImageFromCanvas")} aria-label={t("canvas.character.replaceImageFromCanvas")} onClick={() => { setReplaceImageIndex(idx); onPickCanvasImage(); }} />
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => removeImage(idx)} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}
                {tab === "voice" ? (
                    <div className="space-y-3">
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">{t("canvas.character.voice")}</span>
                            <div className="flex gap-2">
                                <Input
                                    value={voiceName || voiceUrl}
                                    onChange={(e) => { setVoiceName(e.target.value); setVoiceAssetId(""); }}
                                    placeholder={t("canvas.character.editVoicePlaceholder")}
                                    addonAfter={
                                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => voiceInputRef.current?.click()}>
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
                            <Input.TextArea rows={3} value={voiceDescription} onChange={(event) => setVoiceDescription(event.target.value)} placeholder={t("assets.character.voiceDescriptionPlaceholder")} />
                        </label>
                    </div>
                ) : null}
            </div>
            <div className="mt-6 flex justify-end gap-2">
                <Button onClick={onClose}>{t("common.cancel")}</Button>
                <Button type="primary" icon={<Save className="size-3.5" />} loading={saving || uploadingVoice} onClick={handleSave}>
                    {t("common.save")}
                </Button>
            </div>
            <input ref={voiceInputRef} type="file" accept="audio/*" className="hidden" onChange={handleVoiceUpload} />
            <input ref={imageUploadRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageUpload} />
            <AssetPickerModal open={libraryPickOpen} allowedKinds={["image"]} onInsert={handleLibraryPick} onClose={() => setLibraryPickOpen(false)} />
        </Modal>
    );
}
