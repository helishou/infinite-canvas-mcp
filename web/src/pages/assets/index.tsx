import { Check, Clapperboard, Copy, Download, FolderPlus, PencilLine, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { App, Button, Card, Drawer, Dropdown, Empty, Form, Image, Input, Modal, Pagination, Select, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { nanoid } from "nanoid";
import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { cn } from "@/lib/utils";
import { VoiceAssetSelect } from "@/components/assets/voice-asset-select";
import { findCharacterVoiceAsset, hasCharacterVoiceSource, resolveCharacterVoiceName } from "@/lib/character-voice";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset, type AssetKind, type CharacterAsset, type CharacterImage, type ImageAsset, type VideoAsset, type AudioAsset } from "@/stores/use-asset-store";
import { exportAssets, exportCharacterImages, readAssetPackage } from "./asset-transfer";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
    dramaId?: string;
};

type ImageDraft = ImageAsset["data"] | null;
type VideoDraft = VideoAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video", "audio", "character"] as const;
const ALL_DRAMAS = "__all-dramas__";
const UNASSIGNED_DRAMA = "__unassigned-drama__";

export default function AssetsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const characterVoiceInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const dramas = useCanvasStore((state) => state.folders);
    const assets = useAssetStore((state) => state.assets);
    const folders = useAssetStore((state) => state.folders);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const removeAssets = useAssetStore((state) => state.removeAssets);
    const addFolder = useAssetStore((state) => state.addFolder);
    const renameFolder = useAssetStore((state) => state.renameFolder);
    const removeFolder = useAssetStore((state) => state.removeFolder);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [dramaFilter, setDramaFilter] = useState(ALL_DRAMAS);
    const [folderFilter, setFolderFilter] = useState<string | null>(null);
    const [selection, setSelection] = useState<string[]>([]);
    const selectionHasTaggableAsset = useMemo(() => selection.some((id) => assets.some((asset) => asset.id === id && asset.kind !== "character")), [assets, selection]);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [videoDraft, setVideoDraft] = useState<VideoDraft>(null);
    const [audioDraft, setAudioDraft] = useState<AudioAsset["data"] | null>(null);
    const [characterImages, setCharacterImages] = useState<CharacterImage[]>([]);
    const [characterPrimaryIndex, setCharacterPrimaryIndex] = useState(0);
    const [characterVoice, setCharacterVoice] = useState<{ url: string; name: string; description: string; storageKey?: string; assetId: string }>({ url: "", name: "", description: "", assetId: "" });
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const characterCoverUrl = characterImages[Math.min(Math.max(characterPrimaryIndex, 0), Math.max(0, characterImages.length - 1))]?.url || "";
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "character"), [assets]);
    const audioAssets = useMemo(() => assets.filter((asset): asset is AudioAsset => asset.kind === "audio"), [assets]);
    const dramaOptions = useMemo(() => [
        { label: t("assets.drama.all"), value: ALL_DRAMAS },
        { label: t("assets.drama.unassigned"), value: UNASSIGNED_DRAMA },
        ...dramas.map((drama) => ({ label: drama.name, value: drama.id })),
    ], [dramas, t]);
    const matchesDrama = useCallback((asset: Asset) => (
        dramaFilter === ALL_DRAMAS
        || (dramaFilter === UNASSIGNED_DRAMA ? !asset.dramaId || !dramas.some((drama) => drama.id === asset.dramaId) : asset.dramaId === dramaFilter)
    ), [dramaFilter, dramas]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (!matchesDrama(asset)) return false;
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (folderFilter) {
                if (folderFilter.startsWith("tag:")) {
                    if (asset.kind === "character") return false;
                    if (!(asset.tags || []).includes(folderFilter.slice(4))) return false;
                } else if ((asset.folderId ?? null) !== folderFilter) return false;
            }
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter, folderFilter, matchesDrama]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    const rootFolders = useMemo(() => folders.filter((folder) => !folder.parentId), [folders]);
    const childFoldersOf = (id: string) => folders.filter((folder) => folder.parentId === id);
    const legacyTagFolders = useMemo(() => {
        const counts = new Map<string, number>();
        for (const asset of assets) if (asset.kind !== "character") for (const tag of asset.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
        return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
    }, [assets]);
    const currentFolderName = useMemo(() => {
        if (!folderFilter) return t("assets.allAssets");
        if (folderFilter.startsWith("tag:")) return folderFilter.slice(4);
        const folder = folders.find((item) => item.id === folderFilter);
        return folder ? folder.name : t("assets.allAssets");
    }, [folderFilter, folders, t]);
    const currentDramaName = dramaFilter === ALL_DRAMAS
        ? t("assets.drama.all")
        : dramaFilter === UNASSIGNED_DRAMA
            ? t("assets.drama.unassigned")
            : dramas.find((drama) => drama.id === dramaFilter)?.name || t("assets.drama.all");
    const folderCounts = (id: string | null) => {
        if (id === null) return validAssets.filter((asset) => matchesDrama(asset) && !asset.folderId).length;
        return validAssets.filter((asset) => matchesDrama(asset) && asset.folderId === id).length;
    };

    useEffect(() => {
        if (dramaFilter !== ALL_DRAMAS && dramaFilter !== UNASSIGNED_DRAMA && !dramas.some((drama) => drama.id === dramaFilter)) setDramaFilter(UNASSIGNED_DRAMA);
    }, [dramaFilter, dramas]);

    useEffect(() => {
        setSelection((prev) => prev.filter((id) => filteredAssets.some((asset) => asset.id === id)));
    }, [filteredAssets]);
    const toggleSelect = (id: string) => setSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    const selectAllFiltered = () => setSelection(filteredAssets.map((asset) => asset.id));
    const selectNone = () => setSelection([]);
    const confirmBulkDelete = () => {
        if (!selection.length) return;
        removeAssets(selection);
        setSelection([]);
        message.success(t("assets.deletedBulk", { count: selection.length }));
    };
    const bulkMoveToFolder = (folderId: string | null) => {
        const now = new Date().toISOString();
        selection.forEach((id) => {
            const asset = useAssetStore.getState().assets.find((a) => a.id === id);
            if (asset) updateAsset(id, { folderId, updatedAt: now });
        });
        setSelection([]);
        message.success(t("assets.movedToFolder", { count: selection.length }));
    };
    const bulkAddTag = (tag: string) => {
        let count = 0;
        selection.forEach((id) => {
            const asset = useAssetStore.getState().assets.find((a) => a.id === id);
            if (asset && asset.kind !== "character" && !(asset.tags || []).includes(tag)) {
                updateAsset(id, { tags: [...(asset.tags || []), tag] });
                count += 1;
            }
        });
        if (count) message.success(t("assets.tagged", { count, tag }));
    };
    const bulkMoveToDrama = (dramaId: string | null) => {
        const count = selection.length;
        selection.forEach((id) => updateAsset(id, { dramaId }));
        setSelection([]);
        message.success(t("assets.drama.moved", { count }));
    };

    const [isDragging, setIsDragging] = useState(false);
    const dragDepth = useRef(0);
    const dropFolderId = folderFilter && !folderFilter.startsWith("tag:") ? folderFilter : null;
    const dropDramaId = dramaFilter !== ALL_DRAMAS && dramaFilter !== UNASSIGNED_DRAMA ? dramaFilter : null;
    const addDroppedFiles = useCallback(async (files: File[]) => {
        const importable = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("audio/") || file.type.startsWith("video/"));
        if (!importable.length) {
            if (files.length) message.warning(t("assets.dropUnsupported"));
            return;
        }
        let added = 0;
        let failed = 0;
        for (const file of importable) {
            const title = file.name.replace(/\.[^.]+$/, "") || file.name;
            const base = { title, coverUrl: "", tags: [], source: t("assets.droppedSource"), note: "", folderId: dropFolderId, dramaId: dropDramaId };
            try {
                if (file.type.startsWith("image/")) {
                    const image = await uploadImage(file, { category: "library" });
                    addAsset({ ...base, kind: "image", data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                } else if (file.type.startsWith("audio/")) {
                    const result = await uploadMediaFile(file, "audio", "library");
                    addAsset({ ...base, kind: "audio", data: { url: result.url, storageKey: result.storageKey, bytes: result.bytes, mimeType: result.mimeType, durationMs: result.durationMs } });
                } else {
                    const result = await uploadMediaFile(file, "video", "library");
                    addAsset({ ...base, kind: "video", data: { url: result.url, storageKey: result.storageKey, width: result.width, height: result.height, bytes: result.bytes, mimeType: result.mimeType } });
                }
                added += 1;
            } catch {
                failed += 1;
            }
        }
        if (added) message.success(t("assets.filesImported", { count: added }));
        const skipped = files.length - importable.length + failed;
        if (skipped > 0) message.warning(t("assets.filesSkipped", { count: skipped }));
    }, [addAsset, dropDramaId, dropFolderId, message, t]);

    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            const files = event.clipboardData?.files;
            if (files?.length) {
                event.preventDefault();
                void addDroppedFiles(Array.from(files));
            }
        };
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
    }, [addDroppedFiles]);

    const onDragEnter = (event: ReactDragEvent) => {
        event.preventDefault();
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setIsDragging(true);
    };
    const onDragOver = (event: ReactDragEvent) => { event.preventDefault(); };
    const onDragLeave = (event: ReactDragEvent) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setIsDragging(false);
    };
    const onDrop = (event: ReactDragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setIsDragging(false);
        void addDroppedFiles(Array.from(event.dataTransfer.files));
    };

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [filteredAssets.length, pageSize]);

    const openCreate = () => {
            setEditingAsset(null);
            setImageDraft(null);
            setVideoDraft(null);
            setAudioDraft(null);
            setCharacterImages([]);
            setCharacterPrimaryIndex(0);
            setCharacterVoice({ url: "", name: "", description: "", assetId: "" });
            setFormKind("text");
            form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "", dramaId: dropDramaId || UNASSIGNED_DRAMA });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data as ImageAsset["data"] : null);
        setVideoDraft(asset.kind === "video" ? asset.data as VideoAsset["data"] : null);
        setAudioDraft(asset.kind === "audio" ? asset.data as AudioAsset["data"] : null);
        setCharacterImages(asset.kind === "character" ? asset.data.images : []);
        if (asset.kind === "character") {
            const coverIndex = asset.data.images.findIndex((image) => image.url === asset.coverUrl);
            setCharacterPrimaryIndex(Math.min(Math.max(asset.data.primaryIndex ?? (coverIndex >= 0 ? coverIndex : 0), 0), Math.max(asset.data.images.length - 1, 0)));
            const voiceAsset = findCharacterVoiceAsset(assets.filter((candidate): candidate is AudioAsset => candidate.kind === "audio"), {
                assetId: asset.data.voiceAssetId,
                storageKey: asset.data.voiceStorageKey,
                url: asset.data.voice,
            });
            setCharacterVoice({
                url: asset.data.voice || (voiceAsset?.kind === "audio" ? voiceAsset.data.url : ""),
                name: resolveCharacterVoiceName(asset.data.voiceName, voiceAsset),
                description: asset.data.voiceDescription || "",
                storageKey: asset.data.voiceStorageKey || (voiceAsset?.kind === "audio" ? voiceAsset.data.storageKey : undefined),
                assetId: asset.data.voiceAssetId || voiceAsset?.id || "",
            });
        } else {
            setCharacterPrimaryIndex(0);
            setCharacterVoice({ url: "", name: "", description: "", assetId: "" });
        }
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : asset.kind === "character" ? asset.data.description : "",
            dramaId: asset.dramaId && dramas.some((drama) => drama.id === asset.dramaId) ? asset.dramaId : UNASSIGNED_DRAMA,
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        const base = {
            title: values.title.trim(),
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            dramaId: values.dramaId && values.dramaId !== UNASSIGNED_DRAMA ? values.dramaId : null,
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else if (values.kind === "audio") {
            if (!audioDraft) { message.error(t("assets.selectAudio")); return; }
            const asset = { ...base, kind: "audio" as const, data: audioDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else if (values.kind === "video") {
            if (!videoDraft) { message.error(t("assets.selectVideo")); return; }
            const asset = { ...base, kind: "video" as const, data: videoDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else if (values.kind === "character") {
            if (!characterImages.length) { message.error(t("assets.characterRequireOneImage")); return; }
            const primaryIndex = Math.min(Math.max(characterPrimaryIndex, 0), characterImages.length - 1);
            const characterData: CharacterAsset["data"] = {
                name: values.title.trim(),
                englishName: "",
                description: "",
                voice: characterVoice.url,
                voiceName: resolveCharacterVoiceName(characterVoice.name),
                voiceDescription: characterVoice.description,
                voiceStorageKey: characterVoice.storageKey,
                voiceAssetId: characterVoice.assetId,
                images: characterImages,
                primaryIndex,
            };
            // 角色表单的"描述"从 form.content 读取（在表单里复用 content 字段避免再加一项）
            if (values.content) characterData.description = values.content;
            const asset = { ...base, kind: "character" as const, data: characterData, coverUrl: characterImages[primaryIndex]?.url || "" };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageDraft) { message.error(t("assets.selectImage")); return; }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        message.success(editingAsset ? t("assets.updated") : t("assets.saved"));
        setIsAssetOpen(false);
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const dataUrl = await readFileAsDataUrl(file);
        form.setFieldValue("coverUrl", dataUrl);
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        const image = await uploadImage(file, { category: "library" });
        const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
        setImageDraft(draft);
        if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const readAudioFile = async (file?: File) => {
        if (!file || !file.type.startsWith("audio/")) return;
        const result = await uploadMediaFile(file, "audio", "library");
        setAudioDraft({ url: result.url, storageKey: result.storageKey, bytes: result.bytes, mimeType: result.mimeType, durationMs: result.durationMs });
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const readCharacterVoiceFile = async (file?: File) => {
        if (!file || !file.type.startsWith("audio/")) return;
        const result = await uploadMediaFile(file, "audio", "library");
        setCharacterVoice((current) => ({ url: result.url, name: file.name, description: current.description, storageKey: result.storageKey, assetId: "" }));
    };

    const readVideoFile = async (file?: File) => {
        if (!file || !file.type.startsWith("video/")) return;
        const result = await uploadMediaFile(file, "video", "library");
        setVideoDraft({ url: result.url, storageKey: result.storageKey, width: result.width || 0, height: result.height || 0, bytes: result.bytes, mimeType: result.mimeType });
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, t("assets.textCopied"));
    };

    const downloadImage = async (asset: Asset) => {
        if (asset.kind === "text" || asset.kind === "character") return;
        try {
            const blob = await readAssetMediaBlob(asset);
            if (!blob) throw new Error("媒体不可读取");
            const extension = asset.data.mimeType.split("/")[1]?.split("+")[0] || (asset.kind === "image" ? "png" : asset.kind === "video" ? "mp4" : "mp3");
            saveAs(blob, `${asset.title || asset.kind}.${extension}`);
        } catch { message.error(t("common.downloadFailed")); }
    };

    const downloadCharacterImages = async (asset: Asset) => {
        if (asset.kind !== "character") return;
        try {
            const filename = `${asset.title.trim() || t("assets.kinds.character")}-images.zip`;
            await exportCharacterImages(asset, filename);
        } catch {
            message.error(t("common.downloadFailed"));
        }
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning(t("assets.noneToExport"));
            return;
        }
        await exportAssets(validAssets, t("assets.packageName"));
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        try {
            const importedAssets = await readAssetPackage(file);
            // 重新分配 id 并维护 旧→新 映射，保证跨资产引用仍然有效
            const idMap = new Map<string, string>();
            importedAssets.forEach((asset) => idMap.set(asset.id, nanoid()));
            importedAssets.forEach((asset) => {
                const importedDramaId = dropDramaId || (asset.dramaId && dramas.some((drama) => drama.id === asset.dramaId) ? asset.dramaId : null);
                const remapped = asset.kind === "character" ? {
                    ...asset,
                    data: {
                        ...asset.data,
                        voiceAssetId: idMap.get(asset.data.voiceAssetId) || asset.data.voiceAssetId,
                        images: asset.data.images.map((image) => ({ ...image, assetId: image.assetId ? idMap.get(image.assetId) || image.assetId : undefined })),
                    },
                } : asset;
                const payload = { ...remapped, id: idMap.get(asset.id), dramaId: importedDramaId } as Record<string, unknown>;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
            });
            message.success(t("assets.imported", { count: importedAssets.length }));
        } catch {
            message.error(t("assets.importFailed"));
        } finally {
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const confirmDelete = () => {
        if (!deletingAsset) return;
        removeAsset(deletingAsset.id);
        message.success(t("assets.deleted"));
        setDeletingAsset(null);
    };

    const renderFolderItem = (folderId: string, depth: number) => {
        const folder = folders.find((item) => item.id === folderId);
        if (!folder) return null;
        const active = folderFilter === folderId;
        return (
            <div key={folderId}>
                <button
                    type="button"
                    style={{ paddingLeft: 12 + depth * 14 }}
                    className={cn("flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", active && "bg-stone-100 font-medium text-stone-950 dark:bg-stone-900 dark:text-stone-100")}
                    onClick={() => { setFolderFilter(folderId); setPage(1); }}
                >
                    <span className="min-w-0 truncate">{folder.name}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-stone-400">
                        <span>{folderCounts(folderId)}</span>
                        <Dropdown trigger={["click"]} menu={{
                            items: [
                                { key: "new", label: t("assets.folder.newFolder"), onClick: () => addFolder("新文件夹", folderId) },
                                { key: "rename", label: t("common.edit"), onClick: () => { const name = window.prompt(t("assets.folder.rename"), folder.name); if (name?.trim()) renameFolder(folder.id, name); } },
                                { key: "delete", label: t("common.delete"), danger: true, onClick: () => { removeFolder(folder.id); if (folderFilter === folderId) setFolderFilter(null); } },
                            ],
                        }}>
                            <span className="px-1 text-stone-400 hover:text-stone-600">⋯</span>
                        </Dropdown>
                    </span>
                </button>
                {childFoldersOf(folderId).map((child) => renderFolderItem(child.id, depth + 1))}
            </div>
        );
    };

    return (
        <div className="relative flex h-full overflow-hidden bg-background text-stone-900 dark:text-stone-100" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            {isDragging ? (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-8 dark:bg-stone-950/60">
                    <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/70 bg-white/10 px-12 py-10 text-white backdrop-blur-sm">
                        <Upload className="size-8" />
                        <div className="text-lg font-medium">{t("assets.dropHere")}</div>
                        <div className="text-sm opacity-80">{t("assets.dropHint")}</div>
                    </div>
                </div>
            ) : null}
            <aside className="hidden w-56 shrink-0 flex-col border-r border-stone-200 p-3 md:flex dark:border-stone-800">
                <div className="mb-2 text-xs font-medium text-stone-400">{t("assets.drama.title")}</div>
                <button
                    type="button"
                    className={cn("mb-0.5 flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", dramaFilter === ALL_DRAMAS && "bg-stone-100 font-medium text-stone-950 dark:bg-stone-900 dark:text-stone-100")}
                    onClick={() => { setDramaFilter(ALL_DRAMAS); setPage(1); }}
                >
                    <span>{t("assets.drama.all")}</span>
                    <span className="text-xs text-stone-400">{validAssets.length}</span>
                </button>
                <div className="space-y-0.5">
                    {dramas.map((drama) => (
                        <button
                            key={drama.id}
                            type="button"
                            className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", dramaFilter === drama.id && "bg-stone-100 font-medium text-stone-950 dark:bg-stone-900 dark:text-stone-100")}
                            onClick={() => { setDramaFilter(drama.id); setPage(1); }}
                        >
                            <span className="flex min-w-0 items-center gap-2"><Clapperboard className="size-3.5 shrink-0 text-stone-400" /><span className="truncate">{drama.name}</span></span>
                            <span className="text-xs text-stone-400">{validAssets.filter((asset) => asset.dramaId === drama.id).length}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", dramaFilter === UNASSIGNED_DRAMA && "bg-stone-100 font-medium text-stone-950 dark:bg-stone-900 dark:text-stone-100")}
                        onClick={() => { setDramaFilter(UNASSIGNED_DRAMA); setPage(1); }}
                    >
                        <span>{t("assets.drama.unassigned")}</span>
                        <span className="text-xs text-stone-400">{validAssets.filter((asset) => !asset.dramaId || !dramas.some((drama) => drama.id === asset.dramaId)).length}</span>
                    </button>
                </div>
                <div className="mb-2 mt-5 text-xs font-medium text-stone-400">{t("assets.foldersTitle")}</div>
                <button
                    type="button"
                    className={cn("mb-1 flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", !folderFilter && "bg-stone-100 font-medium text-stone-950 dark:bg-stone-900 dark:text-stone-100")}
                    onClick={() => { setFolderFilter(null); setPage(1); }}
                >
                    <span>{t("assets.folder.all")}</span>
                    <span className="text-xs text-stone-400">{validAssets.filter(matchesDrama).length}</span>
                </button>
                <div className="flex-1 space-y-0.5 overflow-y-auto">
                    <div>
                        {rootFolders.map((folder) => renderFolderItem(folder.id, 0))}
                        <button
                            type="button"
                            className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-stone-200"
                            onClick={() => { const id = addFolder("新文件夹", null); setFolderFilter(id); setPage(1); }}
                        >
                            <FolderPlus className="size-3.5" />
                            {t("assets.folder.newFolder")}
                        </button>
                    </div>
                </div>
            </aside>
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("assets.title")}</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder={t("assets.search")}
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setPage(1);
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                        {selection.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-300 bg-white p-3 dark:border-stone-700 dark:bg-stone-950">
                                <span className="text-sm text-stone-700 dark:text-stone-200">{t("assets.selectedCount", { count: selection.length })}</span>
                                <Button size="small" type={selection.length === filteredAssets.length ? "primary" : "default"} onClick={selection.length === filteredAssets.length ? selectNone : selectAllFiltered}>
                                    {selection.length === filteredAssets.length ? t("common.deselectAll") : t("common.selectAll")}
                                </Button>
                                <Dropdown
                                    trigger={["click"]}
                                    menu={{
                                        items: [
                                            ...(folders.length
                                                ? [
                                                    { key: "root", label: t("assets.folder.moveRoot"), onClick: () => bulkMoveToFolder(null) },
                                                    ...rootFolders.map((f) => ({ key: f.id, label: f.name, onClick: () => bulkMoveToFolder(f.id) })),
                                                ]
                                                : []),
                                            { type: "divider" as const },
                                            { key: "new", label: t("assets.folder.newFolder"), onClick: () => bulkMoveToFolder(addFolder("新文件夹", null)) },
                                        ],
                                    }}
                                >
                                <Button size="small" icon={<FolderPlus className="size-3.5" />}>{t("assets.move")}</Button>
                            </Dropdown>
                                <Dropdown
                                    trigger={["click"]}
                                    menu={{
                                        items: [
                                            { key: UNASSIGNED_DRAMA, label: t("assets.drama.unassigned"), onClick: () => bulkMoveToDrama(null) },
                                            ...dramas.map((drama) => ({ key: drama.id, label: drama.name, onClick: () => bulkMoveToDrama(drama.id) })),
                                        ],
                                    }}
                                >
                                    <Button size="small" icon={<Clapperboard className="size-3.5" />}>{t("assets.drama.assign")}</Button>
                                </Dropdown>
                                {selectionHasTaggableAsset ? (
                                    <Dropdown
                                        trigger={["click"]}
                                        menu={{
                                            items: [
                                                { type: "divider" as const },
                                                ...legacyTagFolders.slice(0, 20).map(([tag]) => ({ key: tag, label: tag, onClick: () => bulkAddTag(tag) })),
                                            ],
                                        }}
                                    >
                                        <Button size="small">{t("assets.addTag")}</Button>
                                    </Dropdown>
                                ) : null}
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={confirmBulkDelete}>
                                    {t("assets.deleteBulk")}
                                </Button>
                            </div>
                        ) : null}
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-2">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">{currentDramaName} / {currentFolderName}</div>
                                <div className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500 dark:bg-stone-900 dark:text-stone-400">{filteredAssets.length}</div>
                                {folderFilter ? (
                                    <button type="button" className="cursor-pointer text-xs text-stone-500 underline-offset-2 hover:underline dark:text-stone-400" onClick={() => { setFolderFilter(null); setPage(1); }}>
                                        {t("assets.allAssets")}
                                    </button>
                                ) : null}
                            </div>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="grid gap-3">
                                <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center md:hidden">
                                    <div className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("assets.drama.label")}</div>
                                    <Select value={dramaFilter} options={dramaOptions} onChange={(value) => { setDramaFilter(value); setPage(1); }} />
                                </div>
                                <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                    <div className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("assets.type")}</div>
                                    <div className="flex flex-wrap gap-2">
                                        {kindOptions.map((option) => (
                                            <Tag.CheckableTag
                                                key={option}
                                                checked={kindFilter === option}
                                                className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                                                onChange={() => {
                                                    setPage(1);
                                                    setKindFilter(option);
                                                }}
                                            >
                                                {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                                            </Tag.CheckableTag>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <button
                                    type="button"
                                    className="flex items-center gap-1 cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => { const id = addFolder("新文件夹", folderFilter && !folderFilter.startsWith("tag:") ? folderFilter : null); setFolderFilter(id); setPage(1); }}
                                >
                                    <FolderPlus className="size-4" />
                                    {t("assets.folder.newFolder")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                >
                                    {t("assets.export")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => assetInputRef.current?.click()}
                                >
                                    {t("assets.import")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={openCreate}
                                >
                                    {t("assets.add")}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                selected={selection.includes(asset.id)}
                                onSelect={() => toggleSelect(asset.id)}
                                onOpen={() => setPreviewAsset(asset)}
                                onEdit={() => openEdit(asset)}
                                onCopy={copyAssetText}
                                onDownload={downloadImage}
                                onDownloadCharacter={downloadCharacterImages}
                                onDelete={() => setDeletingAsset(asset)}
                            />
                        ))}
                    </div>

                    {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("assets.empty")} className="py-20" /> : null}

                    <div className="flex justify-center">
                        <Pagination
                            current={page}
                            pageSize={pageSize}
                            total={filteredAssets.length}
                            showSizeChanger
                            pageSizeOptions={[10, 20, 50, 100]}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </div>
            </main>

            <Modal title={editingAsset ? t("assets.edit") : t("assets.add")} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset()} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label={t("assets.type")}>
                            <Select
                                disabled={Boolean(editingAsset)}
                                options={[
                                    { label: t("assets.kinds.text"), value: "text" },
                                    { label: t("assets.kinds.image"), value: "image" },
                                    { label: t("assets.kinds.video"), value: "video" },
                                    { label: t("assets.kinds.audio"), value: "audio" },
                                    { label: t("assets.kinds.character"), value: "character" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="dramaId" label={t("assets.drama.field")}>
                            <Select options={dramaOptions.filter((option) => option.value !== ALL_DRAMAS)} />
                        </Form.Item>
                        <Form.Item name="title" label={formKind === "character" ? t("assets.fields.characterName") : t("assets.fields.title")} rules={[{ required: true, message: formKind === "character" ? t("assets.fields.characterNameRequired") : t("assets.fields.titleRequired") }]}>
                            <Input size="large" placeholder={formKind === "character" ? t("assets.fields.characterNamePlaceholder") : t("assets.fields.titlePlaceholder")} />
                        </Form.Item>
                        {formKind !== "character" ? (
                            <Form.Item name="coverUrl" label={t("assets.fields.coverUrl")}>
                                <Space.Compact className="w-full">
                                    <Input placeholder={t("assets.fields.coverPlaceholder")} />
                                    <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                        {t("common.upload")}
                                    </Button>
                                </Space.Compact>
                            </Form.Item>
                        ) : null}
                        {formKind !== "character" ? (
                            <Form.Item name="tags" label={t("assets.fields.tags")}>
                                <Select mode="tags" tokenSeparators={[",", "，"]} placeholder={t("assets.fields.tagsPlaceholder")} />
                            </Form.Item>
                        ) : null}
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label={t("assets.fields.source")}>
                                <Input placeholder={t("assets.fields.sourcePlaceholder")} />
                            </Form.Item>
                            <Form.Item name="note" label={t("assets.fields.note")}>
                                <Input placeholder={t("assets.fields.optional")} />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label={t("assets.fields.textContent")} rules={[{ required: true, message: t("assets.fields.textRequired") }]}>
                                <Input.TextArea rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                            </Form.Item>
                        ) : formKind === "audio" ? (
                            <Form.Item label={t("assets.fields.audioContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => audioInputRef.current?.click()}>
                                        {t("assets.selectAudioFile")}
                                    </Button>
                                    {audioDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {formatBytes(audioDraft.bytes)} {audioDraft.durationMs ? ` · ${Math.round(audioDraft.durationMs / 1000)}s` : ""}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noAudioSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        ) : formKind === "video" ? (
                            <Form.Item label={t("assets.fields.videoContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => videoInputRef.current?.click()}>
                                        {t("assets.selectVideoFile")}
                                    </Button>
                                    {videoDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {videoDraft.width}x{videoDraft.height} · {formatBytes(videoDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noVideoSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        ) : formKind === "character" ? (
                            <>
                                <Form.Item name="content" label={t("assets.fields.characterDescription")}>
                                    <Input.TextArea rows={4} placeholder={t("assets.fields.characterDescriptionPlaceholder")} />
                                </Form.Item>
                                <Form.Item label={t("canvas.character.voice")}>
                                    <div className="space-y-2">
                                        <Space.Compact className="w-full">
                                            <Input
                                                value={characterVoice.name || characterVoice.url}
                                                onChange={(event) => setCharacterVoice((current) => ({ ...current, name: event.target.value, assetId: "" }))}
                                                placeholder={t("canvas.character.editVoicePlaceholder")}
                                            />
                                            <Button icon={<Upload className="size-3.5" />} onClick={() => characterVoiceInputRef.current?.click()}>
                                                {t("common.upload")}
                                            </Button>
                                            {hasCharacterVoiceSource(characterVoice) ? <Button aria-label={t("common.delete")} icon={<X className="size-3.5" />} onClick={() => setCharacterVoice({ url: "", name: "", description: "", assetId: "" })} /> : null}
                                        </Space.Compact>
                                        {audioAssets.length || hasCharacterVoiceSource(characterVoice) ? (
                                            <VoiceAssetSelect
                                                assets={audioAssets}
                                                allowClear
                                                placeholder={t("canvas.character.editPickVoiceAsset")}
                                                value={characterVoice.assetId || undefined}
                                                preview={hasCharacterVoiceSource(characterVoice) ? { id: characterVoice.assetId, url: characterVoice.url, storageKey: characterVoice.storageKey, name: characterVoice.name } : undefined}
                                                onChange={(asset) => setCharacterVoice((current) => asset
                                                    ? { url: asset.data.url, name: asset.title, description: current.description, storageKey: asset.data.storageKey, assetId: asset.id }
                                                    : { url: "", name: "", description: "", assetId: "" })}
                                            />
                                        ) : null}
                                        <Input.TextArea
                                            rows={2}
                                            value={characterVoice.description}
                                            onChange={(event) => setCharacterVoice((current) => ({ ...current, description: event.target.value }))}
                                            placeholder={t("assets.character.voiceDescriptionPlaceholder")}
                                        />
                                    </div>
                                </Form.Item>
                                <Form.Item label={t("assets.fields.characterImages")} required>
                                    <CharacterEditor images={characterImages} primaryIndex={characterPrimaryIndex} onPrimaryIndexChange={setCharacterPrimaryIndex} onChange={setCharacterImages} />
                                </Form.Item>
                            </>
                        ) : (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {t("assets.selectImageFile")}
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noImageSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {(formKind === "character" ? characterCoverUrl : coverUrl || imageDraft?.dataUrl) ? (
                                <img src={formKind === "character" ? characterCoverUrl : coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {formKind !== "character" && tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : formKind !== "character" ? (
                                        <Tag className="m-0">{t("assets.untagged")}</Tag>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(event) => { void readVideoFile(event.target.files?.[0]); event.target.value = ""; }}
                />
                <input
                    ref={audioInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(event) => { void readAudioFile(event.target.files?.[0]); event.target.value = ""; }}
                />
                <input
                    ref={characterVoiceInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(event) => { void readCharacterVoiceFile(event.target.files?.[0]); event.target.value = ""; }}
                />
            </Modal>

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} onDownloadCharacter={downloadCharacterImages} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />

            <Modal title={t("assets.deleteTitle")} open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={confirmDelete} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("assets.deleteConfirm", { name: deletingAsset?.title })}
            </Modal>
        </div>
    );
}

function useResolvedCoverUrl(asset: Asset | null) {
    const [url, setUrl] = useState("");
    const assets = useAssetStore((state) => state.assets);
    useEffect(() => {
        setUrl(asset?.coverUrl || "");
        if (!asset || asset.coverUrl) return;
        const lookups: Promise<string | undefined>[] = [];
        if (asset.kind === "image") {
            if (asset.data.dataUrl) lookups.push(Promise.resolve(asset.data.dataUrl));
            if (asset.data.storageKey) lookups.push(resolveImageUrl(asset.data.storageKey));
        } else if (asset.kind === "character") {
            for (const image of asset.data.images) {
                if (lookups.length >= 4) break;
                if (image.storageKey) lookups.push(resolveImageUrl(image.storageKey));
                else if (image.url) lookups.push(Promise.resolve(image.url));
            }
        }
        if (!lookups.length) return;
        let cancelled = false;
        Promise.all(lookups).then((found) => {
            const first = found.find(Boolean);
            if (!cancelled && first) setUrl(first);
        });
        return () => { cancelled = true; };
    }, [asset?.id, asset?.kind, asset?.coverUrl, assets]);
    return url;
}

function AudioPlayer({ asset }: { asset: AudioAsset }) {
    const [src, setSrc] = useState("");
    useEffect(() => {
        let cancelled = false;
        if (asset.data.url && !asset.data.storageKey) { setSrc(asset.data.url); return; }
        if (asset.data.storageKey) {
            resolveMediaUrl(asset.data.storageKey).then((u) => { if (!cancelled && u) setSrc(u); });
        }
        return () => { cancelled = true; };
    }, [asset.id]);
    if (!src) return null;
    return <audio src={src} controls className="!mt-2 h-9 w-full" />;
}

function AssetDramaTag({ asset }: { asset: Asset }) {
    const { t } = useTranslation();
    const dramas = useCanvasStore((state) => state.folders);
    const drama = dramas.find((item) => item.id === asset.dramaId);
    return <Tag icon={<Clapperboard className="size-3" />} className="m-0 max-w-full text-[11px]"><span className="inline-block max-w-28 truncate align-bottom">{drama?.name || t("assets.drama.unassigned")}</span></Tag>;
}

function AssetCard({ asset, selected, onSelect, onOpen, onEdit, onCopy, onDownload, onDownloadCharacter, onDelete }: { asset: Asset; selected: boolean; onSelect: () => void; onOpen: () => void; onEdit: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDownloadCharacter: (asset: Asset) => void; onDelete: () => void }) {
    const { t } = useTranslation();
    const cover = useResolvedCoverUrl(asset);
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className={cn("group overflow-hidden transition-shadow", selected && "ring-2 ring-stone-500 dark:ring-stone-400")}
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="relative block w-full text-left" onClick={onOpen}>
                    {selected ? (
                        <span className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-stone-900/80 text-white shadow backdrop-blur" onClick={(e) => { e.stopPropagation(); onSelect(); }}>
                            <Check className="size-4" />
                        </span>
                    ) : (
                        <span
                            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-stone-300 bg-white/70 text-stone-400 opacity-0 shadow backdrop-blur transition-opacity hover:opacity-100 group-hover:opacity-100 dark:border-stone-600 dark:bg-stone-900/70"
                            onClick={(e) => { e.stopPropagation(); onSelect(); }}
                        >
                            <Check className="size-4" />
                        </span>
                    )}
                    {cover ? (
                        <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                        <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                </button>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || t("assets.unknownSource")}
                            </Typography.Text>
                        </div>
                        <Tag className="m-0 shrink-0 text-[11px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        <AssetDramaTag asset={asset} />
                        {(asset.kind === "character" ? [] : asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {asset.kind !== "character" && !asset.tags?.length ? <Tag className="m-0 text-[11px]">{t("assets.noTags")}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="flex items-center gap-2 px-4 pb-4">
                <Button size="small" onClick={onOpen}>
                    {t("common.view")}
                </Button>
                <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                    {t("common.edit")}
                </Button>
                {asset.kind === "text" ? (
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                        {t("common.copy")}
                    </Button>
                ) : null}
                {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? (
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                        {t("common.download")}
                    </Button>
                ) : null}
                {asset.kind === "character" ? (
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownloadCharacter(asset)}>
                        {t("assets.character.downloadImages")}
                    </Button>
                ) : null}
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    {t("common.delete")}
                </Button>
            </div>
        </Card>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload, onDownloadCharacter }: { asset: Asset | null; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDownloadCharacter: (asset: Asset) => void }) {
    const { t } = useTranslation();
    const cover = useResolvedCoverUrl(asset);
    return (
        <Drawer title={t("assets.details")} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={cover} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            <AssetDramaTag asset={asset} />
                            {(asset.kind === "character" ? [] : asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            {t("assets.fields.textContent")}
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : asset.kind === "audio" ? (
                            <div>
                                <AudioPlayer asset={asset as AudioAsset} />
                                <Typography.Text type="secondary" className="mt-1 block">
                                    {formatBytes(asset.data.bytes)}{asset.data.durationMs ? ` · ${Math.round(asset.data.durationMs / 1000)}s` : ""}
                                </Typography.Text>
                            </div>
                        ) : asset.kind === "character" ? (
                            <div className="mt-2 space-y-3">
                                 {asset.data.description ? (
                                     <Typography.Paragraph className="!mb-0 whitespace-pre-wrap">{asset.data.description}</Typography.Paragraph>
                                 ) : null}
                                 {asset.data.voiceName || asset.data.voiceDescription ? (
                                     <div className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
                                         <Typography.Text strong>{asset.data.voiceName || t("canvas.character.voice")}</Typography.Text>
                                         {asset.data.voiceDescription ? <Typography.Paragraph type="secondary" className="!mb-0 !mt-1 whitespace-pre-wrap">{asset.data.voiceDescription}</Typography.Paragraph> : null}
                                     </div>
                                 ) : null}
                                 {asset.data.images.length ? (
                                    <div className="grid grid-cols-3 gap-2">
                                        {asset.data.images.map((image, idx) => (
                                            <Image key={idx} src={image.url} alt={image.outfit || image.name} className="!rounded-md" />
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">{t("assets.fields.note")}</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space>
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                {t("assets.copyText")}
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? t("assets.downloadVideo") : asset.kind === "audio" ? t("assets.downloadAudio") : t("assets.downloadImage")}
                            </Button>
                        ) : null}
                        {asset.kind === "character" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownloadCharacter(asset)}>
                                {t("assets.character.downloadImages")}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

async function readAssetMediaBlob(asset: Extract<Asset, { kind: "image" | "video" | "audio" }>) {
    if (asset.data.storageKey) {
        const stored = asset.kind === "image" ? await getImageBlob(asset.data.storageKey) : await getMediaBlob(asset.data.storageKey);
        if (stored) return stored;
    }
    const url = asset.kind === "image" ? asset.data.dataUrl || asset.coverUrl : asset.data.url;
    if (!url) return null;
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    if (asset.kind === "audio") return `${formatBytes(asset.data.bytes)}${asset.data.durationMs ? ` · ${Math.round(asset.data.durationMs / 1000)}s` : ""}`;
    if (asset.kind === "character") return asset.data.description || `${asset.data.images.length} images`;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset) {
    const extra = asset.kind === "text" ? asset.data.content
        : asset.kind === "character" ? `${asset.data.name} ${asset.data.description} ${asset.data.voiceName} ${asset.data.voiceDescription || ""} ${asset.data.images.length} images`
        : asset.data.mimeType;
    return [asset.title, asset.source || "", asset.note || "", asset.kind === "character" ? "" : (asset.tags || []).join(" "), extra].join(" ").toLowerCase();
}

function CharacterEditor({ images, primaryIndex, onPrimaryIndexChange, onChange }: { images: CharacterImage[]; primaryIndex: number; onPrimaryIndexChange: (index: number) => void; onChange: (images: CharacterImage[]) => void }) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pendingIdxRef = useRef<number | "new" | null>(null);
    const [previews, setPreviews] = useState<Record<number, string>>({});
    const urlCache = useRef<Record<string, string>>({});

    const resolveUrl = useCallback(async (image: CharacterImage) => {
        if (image.storageKey) {
            if (!urlCache.current[image.storageKey]) urlCache.current[image.storageKey] = await resolveImageUrl(image.storageKey, image.url);
            return urlCache.current[image.storageKey];
        }
        return image.url || "";
    }, []);

    useEffect(() => {
        let cancelled = false;
        images.forEach(async (image, idx) => {
            const url = await resolveUrl(image);
            if (!cancelled && url) setPreviews((prev) => ({ ...prev, [idx]: url }));
        });
        return () => { cancelled = true; };
    }, [images, resolveUrl]);

    useEffect(() => () => { Object.values(urlCache.current).forEach((url) => URL.revokeObjectURL(url)); }, []);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || pendingIdxRef.current === null) return;
        const result = await uploadImage(file, { category: "library" });
        const nextImage: CharacterImage = {
            url: result.url,
            storageKey: result.storageKey,
            name: file.name,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            mimeType: result.mimeType,
            outfit: "",
            outfitDescription: "",
        };
        const idx = pendingIdxRef.current;
        pendingIdxRef.current = null;
        if (idx === "new") {
            onChange([...images, nextImage]);
        } else if (typeof idx === "number") {
            const next = [...images];
            next[idx] = nextImage;
            onChange(next);
        }
    };

    const updateImage = (idx: number, patch: Partial<CharacterImage>) => {
        const next = [...images];
        next[idx] = { ...next[idx], ...patch };
        onChange(next);
    };
    const removeImage = (idx: number) => {
        onChange(images.filter((_, i) => i !== idx));
        if (idx === primaryIndex) onPrimaryIndexChange(0);
        else if (idx < primaryIndex) onPrimaryIndexChange(primaryIndex - 1);
    };
    const moveImage = (idx: number, dir: -1 | 1) => {
        const target = idx + dir;
        if (target < 0 || target >= images.length) return;
        const next = [...images];
        [next[idx], next[target]] = [next[target], next[idx]];
        onChange(next);
        if (primaryIndex === idx) onPrimaryIndexChange(target);
        else if (primaryIndex === target) onPrimaryIndexChange(idx);
    };

    return (
        <div className="space-y-3">
            {images.map((image, idx) => (
                <div key={idx} className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                    <div className="flex gap-3">
                        <div className="size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
                            {previews[idx] ? (
                                <Image src={previews[idx]} alt={image.outfit || image.name} preview={{ src: previews[idx] }} className="!size-full !object-cover" />
                            ) : (
                                <div className="flex size-full items-center justify-center text-xs text-stone-400">无图</div>
                            )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-2">
                            <div className="grid gap-2 sm:grid-cols-2">
                                <Input
                                    size="small"
                                    value={image.outfit}
                                    onChange={(e) => updateImage(idx, { outfit: e.target.value })}
                                    placeholder={t("assets.character.outfitPlaceholder")}
                                />
                                <Input
                                    size="small"
                                    value={image.name}
                                    onChange={(e) => updateImage(idx, { name: e.target.value })}
                                    placeholder={t("assets.character.namePlaceholder")}
                                />
                            </div>
                            <Input.TextArea
                                size="small"
                                rows={2}
                                value={image.outfitDescription}
                                onChange={(e) => updateImage(idx, { outfitDescription: e.target.value })}
                                placeholder={t("assets.character.outfitDescriptionPlaceholder")}
                            />
                            <div className="flex flex-wrap gap-1.5">
                                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => { pendingIdxRef.current = idx; fileInputRef.current?.click(); }}>{t("common.upload")}</Button>
                                <Button size="small" type={idx === primaryIndex ? "primary" : "default"} onClick={() => onPrimaryIndexChange(idx)}>
                                    {idx === primaryIndex ? t("assets.character.defaultImage") : t("assets.character.setDefaultImage")}
                                </Button>
                                <Button size="small" disabled={idx === 0} onClick={() => moveImage(idx, -1)}>↑</Button>
                                <Button size="small" disabled={idx === images.length - 1} onClick={() => moveImage(idx, 1)}>↓</Button>
                                <Button size="small" danger onClick={() => removeImage(idx)}>{t("common.delete")}</Button>
                            </div>
                        </div>
                    </div>
                </div>
            ))}
            <Button
                type="dashed"
                block
                icon={<Upload className="size-3.5" />}
                onClick={() => { pendingIdxRef.current = "new"; fileInputRef.current?.click(); }}
            >
                {t("assets.character.addImage")}
            </Button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
        </div>
    );
}
