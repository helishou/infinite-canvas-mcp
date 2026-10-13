import { BackendApiError } from "@/services/backend-api";
import { ArrowDownUp, Clapperboard, Copy, Download, FileUp, Folder, FolderPlus, MoreHorizontal, PencilLine, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { App, Alert, Button, Card, Drawer, Dropdown, Empty, Form, Input, Modal, Pagination, Select, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { nanoid } from "nanoid";
import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { cn } from "@/lib/utils";
import { VoiceAssetSelect } from "@/components/assets/voice-asset-select";
import { MediaImage } from "@/components/media/media-image";
import { SceneColorPaletteEditor } from "@/components/canvas/scene-color-palette-editor";
import { findCharacterVoiceAsset, hasCharacterVoiceSource, resolveCharacterVoiceName } from "@/lib/character-voice";
import { extractSceneColorPalette, normalizeSceneColorPalette } from "@/lib/canvas/scene-color-palette";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, libraryErrorText, type Asset, type AssetKind, type CharacterAsset, type CharacterImage, type ImageAsset, type VideoAsset, type AudioAsset, type SceneAsset, type SceneImage } from "@/stores/use-asset-store";
import { readAssetRemoteBlob } from "./asset-transfer-validation";
import { exportAssets, exportCharacterImages, readAssetPackage } from "./asset-transfer";
import { ALL_DRAMAS, ROOT_FOLDER, UNASSIGNED_DRAMA, countByDrama, countByFolder, filterAssets, isTagFolder, type AssetLibraryFilters } from "./asset-facet-counts";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
    sceneColorCardPrompt?: string;
    dramaId?: string;
};

type ImageDraft = ImageAsset["data"] | null;
type VideoDraft = VideoAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video", "audio", "character", "scene"] as const;

export default function AssetsPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [transferBusy, setTransferBusy] = useState(false);
    const transferBusyRef = useRef(false);
    const transferViewRef = useRef(0);
    useEffect(() => () => { transferViewRef.current += 1; }, []);
    const beginTransfer = () => { if (transferBusyRef.current) return false; transferBusyRef.current = true; setTransferBusy(true); return true; };
    const finishTransfer = () => { transferBusyRef.current = false; setTransferBusy(false); };
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const characterVoiceInputRef = useRef<HTMLInputElement>(null);
    const sceneImageInputRef = useRef<HTMLInputElement>(null);
    const sceneColorCardInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const dramas = useCanvasStore((state) => state.folders);
    const assets = useAssetStore((state) => state.assets);
    const missingSourceAssets = useMemo(() => assets.filter((asset) => asset.metadata?.sharedAssetMissing === true), [assets]);
    const hydrateError = useAssetStore((state) => state.hydrateError);
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
    const selectionHasTaggableAsset = useMemo(() => selection.some((id) => assets.some((asset) => asset.id === id && asset.kind !== "character" && asset.kind !== "scene")), [assets, selection]);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [newAssetId, setNewAssetId] = useState(() => nanoid());
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
    const [uploadingCharacterVoice, setUploadingCharacterVoice] = useState(false);
    const [sceneImageDraft, setSceneImageDraft] = useState<SceneImage | null>(null);
    const [sceneColorCardDraft, setSceneColorCardDraft] = useState<SceneImage | null>(null);
    const [sceneColorPaletteDraft, setSceneColorPaletteDraft] = useState<string[]>([]);
    const [extractingScenePalette, setExtractingScenePalette] = useState(false);
    const scenePaletteExtractionIdRef = useRef(0);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const characterCoverUrl = characterImages[Math.min(Math.max(characterPrimaryIndex, 0), Math.max(0, characterImages.length - 1))]?.url || "";
    const sceneCoverUrl = sceneImageDraft?.url || "";
    const extractColorCardPalette = useCallback(async (card: SceneImage) => {
        const extractionId = ++scenePaletteExtractionIdRef.current;
        setExtractingScenePalette(true);
        try {
            const palette = await extractSceneColorPalette(card);
            if (extractionId !== scenePaletteExtractionIdRef.current) return;
            setSceneColorPaletteDraft(palette);
            if (!palette.length) message.info(t("canvas.scene.colorPaletteEmptyResult"));
        } catch {
            if (extractionId === scenePaletteExtractionIdRef.current) message.warning(t("canvas.scene.colorPaletteExtractFailed"));
        } finally {
            if (extractionId === scenePaletteExtractionIdRef.current) setExtractingScenePalette(false);
        }
    }, [message, t]);
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "character" || asset.kind === "scene"), [assets]);
    const audioAssets = useMemo(() => assets.filter((asset): asset is AudioAsset => asset.kind === "audio"), [assets]);
    const dramaOptions = useMemo(() => [
        { label: t("assets.drama.all"), value: ALL_DRAMAS },
        { label: t("assets.drama.unassigned"), value: UNASSIGNED_DRAMA },
        ...dramas.map((drama) => ({ label: drama.name, value: drama.id })),
    ], [dramas, t]);
    const filters = useMemo<AssetLibraryFilters>(() => ({
        keyword,
        kind: kindFilter,
        dramaId: dramaFilter,
        folderId: folderFilter,
        dramaIds: dramas.map((drama) => drama.id),
    }), [dramas, dramaFilter, folderFilter, keyword, kindFilter]);

    const filteredAssets = useMemo(() => filterAssets(validAssets, filters), [validAssets, filters]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    const rootFolders = useMemo(() => folders.filter((folder) => !folder.parentId), [folders]);
    const childFoldersOf = (id: string) => folders.filter((folder) => folder.parentId === id);
    const legacyTagFolders = useMemo(() => {
        const counts = new Map<string, number>();
        for (const asset of assets) if (asset.kind !== "character" && asset.kind !== "scene") for (const tag of asset.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
        return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
    }, [assets]);
    const currentFolderName = useMemo(() => {
        if (!folderFilter) return t("assets.allAssets");
        if (folderFilter === ROOT_FOLDER) return t("assets.folder.unfiled");
        if (isTagFolder(folderFilter)) return folderFilter.slice("tag:".length);
        const folder = folders.find((item) => item.id === folderFilter);
        return folder ? folder.name : t("assets.allAssets");
    }, [folderFilter, folders, t]);
    const currentDramaName = dramaFilter === ALL_DRAMAS
        ? t("assets.drama.all")
        : dramaFilter === UNASSIGNED_DRAMA
            ? t("assets.drama.unassigned")
            : dramas.find((drama) => drama.id === dramaFilter)?.name || t("assets.drama.all");
    // 侧栏计数与列表同源：每个入口只忽略自身维度，保证「点进去看到的条数」就是这里显示的数字。
    const facetCounts = useMemo(() => ({
        allDramas: countByDrama(validAssets, filters, ALL_DRAMAS),
        unassigned: countByDrama(validAssets, filters, UNASSIGNED_DRAMA),
        dramas: new Map(dramas.map((drama) => [drama.id, countByDrama(validAssets, filters, drama.id)])),
        allFolders: countByFolder(validAssets, filters, null),
        unfiled: countByFolder(validAssets, filters, ROOT_FOLDER),
        folders: new Map(folders.map((folder) => [folder.id, countByFolder(validAssets, filters, folder.id)])),
    }), [dramas, filters, folders, validAssets]);

    useEffect(() => {
        if (dramaFilter !== ALL_DRAMAS && dramaFilter !== UNASSIGNED_DRAMA && !dramas.some((drama) => drama.id === dramaFilter)) setDramaFilter(UNASSIGNED_DRAMA);
    }, [dramaFilter, dramas]);

    useEffect(() => {
        setSelection((prev) => prev.filter((id) => filteredAssets.some((asset) => asset.id === id)));
    }, [filteredAssets]);
    const toggleSelect = (id: string) => setSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    const selectAllFiltered = () => setSelection(filteredAssets.map((asset) => asset.id));
    const selectNone = () => setSelection([]);
    const confirmBulkDelete = async () => {
        if (!selection.length) return;
        try { await removeAssets(selection); } catch (error) { message.error(libraryErrorText(error)); return; }
        setSelection([]);
        message.success(t("assets.deletedBulk", { count: selection.length }));
    };
    const bulkMoveToFolder = (folderId: string | null) => {
        const now = new Date().toISOString();
        selection.forEach((id) => {
            const asset = useAssetStore.getState().assets.find((a) => a.id === id);
            if (asset) void updateAsset(id, { folderId, updatedAt: now }).catch(error => message.error(libraryErrorText(error)));
        });
        setSelection([]);
        message.success(t("assets.movedToFolder", { count: selection.length }));
    };
    const bulkAddTag = (tag: string) => {
        let count = 0;
        selection.forEach((id) => {
            const asset = useAssetStore.getState().assets.find((a) => a.id === id);
            if (asset && asset.kind !== "character" && asset.kind !== "scene" && !(asset.tags || []).includes(tag)) {
                void updateAsset(id, { tags: [...(asset.tags || []), tag] }).catch(error => message.error(libraryErrorText(error)));
                count += 1;
            }
        });
        if (count) message.success(t("assets.tagged", { count, tag }));
    };
    const bulkMoveToDrama = async (dramaId: string | null) => {
        const count = selection.length;
        try { await Promise.all(selection.map((id) => updateAsset(id, { dramaId }))); } catch (error) { message.error(libraryErrorText(error)); return; }
        setSelection([]);
        message.success(t("assets.drama.moved", { count }));
    };

    const [isDragging, setIsDragging] = useState(false);
    const dragDepth = useRef(0);
    // 当前真实文件夹：未归档与标签分组不是可写入的文件夹，拖放和新建子文件夹都回到根目录。
    const currentFolderId = folderFilter && folderFilter !== ROOT_FOLDER && !isTagFolder(folderFilter) ? folderFilter : null;
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
            const base = { title, coverUrl: "", tags: [], source: t("assets.droppedSource"), note: "", folderId: currentFolderId, dramaId: dropDramaId };
            try {
                if (file.type.startsWith("image/")) {
                    const image = await uploadImage(file, { category: "library" });
                    await addAsset({ ...base, kind: "image", data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                } else if (file.type.startsWith("audio/")) {
                    const result = await uploadMediaFile(file, "audio", "library");
                    await addAsset({ ...base, kind: "audio", data: { url: result.url, storageKey: result.storageKey, bytes: result.bytes, mimeType: result.mimeType, durationMs: result.durationMs } });
                } else {
                    const result = await uploadMediaFile(file, "video", "library");
                    await addAsset({ ...base, kind: "video", data: { url: result.url, storageKey: result.storageKey, width: result.width, height: result.height, bytes: result.bytes, mimeType: result.mimeType } });
                }
                added += 1;
            } catch {
                failed += 1;
            }
        }
        if (added) message.success(t("assets.filesImported", { count: added }));
        const skipped = files.length - importable.length + failed;
        if (skipped > 0) message.warning(t("assets.filesSkipped", { count: skipped }));
    }, [addAsset, dropDramaId, currentFolderId, message, t]);

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
            setNewAssetId(nanoid());
            setImageDraft(null);
            setVideoDraft(null);
            setAudioDraft(null);
            setCharacterImages([]);
            setCharacterPrimaryIndex(0);
            setCharacterVoice({ url: "", name: "", description: "", assetId: "" });
            setSceneImageDraft(null);
            setSceneColorCardDraft(null);
            setSceneColorPaletteDraft([]);
            scenePaletteExtractionIdRef.current++;
            setExtractingScenePalette(false);
            setFormKind("text");
            form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "", sceneColorCardPrompt: "", dramaId: dropDramaId || UNASSIGNED_DRAMA });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data as ImageAsset["data"] : null);
        setVideoDraft(asset.kind === "video" ? asset.data as VideoAsset["data"] : null);
        setAudioDraft(asset.kind === "audio" ? asset.data as AudioAsset["data"] : null);
        setSceneImageDraft(asset.kind === "scene" ? asset.data.image : null);
        setSceneColorCardDraft(asset.kind === "scene" ? asset.data.colorCard || null : null);
        setSceneColorPaletteDraft(asset.kind === "scene" ? asset.data.colorPalette || [] : []);
        scenePaletteExtractionIdRef.current++;
        setExtractingScenePalette(false);
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
            content: asset.kind === "text" ? asset.data.content : asset.kind === "character" ? asset.data.description : asset.kind === "scene" ? asset.data.description : "",
            sceneColorCardPrompt: asset.kind === "scene" ? asset.data.colorCardPrompt : "",
            dramaId: asset.dramaId && dramas.some((drama) => drama.id === asset.dramaId) ? asset.dramaId : UNASSIGNED_DRAMA,
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async (resolveConflicts?: "local") => {
        if (uploadingCharacterVoice) return;
        const values = await form.validateFields();
        const base = {
            title: values.title.trim(),
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            tags: values.kind === "character" || values.kind === "scene" ? [] : values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            dramaId: values.dramaId && values.dramaId !== UNASSIGNED_DRAMA ? values.dramaId : null,
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            await (editingAsset ? updateAsset(editingAsset.id, asset, editingAsset, resolveConflicts) : addAsset({ ...asset, id: newAssetId }));
        } else if (values.kind === "audio") {
            if (!audioDraft) { message.error(t("assets.selectAudio")); return; }
            const asset = { ...base, kind: "audio" as const, data: audioDraft };
            await (editingAsset ? updateAsset(editingAsset.id, asset, editingAsset, resolveConflicts) : addAsset({ ...asset, id: newAssetId }));
        } else if (values.kind === "video") {
            if (!videoDraft) { message.error(t("assets.selectVideo")); return; }
            const asset = { ...base, kind: "video" as const, data: videoDraft };
            await (editingAsset ? updateAsset(editingAsset.id, asset, editingAsset, resolveConflicts) : addAsset({ ...asset, id: newAssetId }));
        } else if (values.kind === "character") {
            const primaryIndex = characterImages.length
                ? Math.min(Math.max(characterPrimaryIndex, 0), characterImages.length - 1)
                : 0;
            if (!characterImages.length && !characterVoice.url && !characterVoice.storageKey && !characterVoice.assetId) {
                message.error(t("assets.characterRequireReference"));
                return;
            }
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
            await (editingAsset ? updateAsset(editingAsset.id, asset, editingAsset, resolveConflicts) : addAsset({ ...asset, id: newAssetId }));
        } else if (values.kind === "scene") {
            if (!sceneImageDraft) { message.error(t("assets.sceneRequireImage")); return; }
            const colorPalette = normalizeSceneColorPalette(sceneColorPaletteDraft);
            const sceneData: SceneAsset["data"] = {
                name: values.title.trim(),
                description: (values.content || "").trim(),
                image: sceneImageDraft,
                colorCard: sceneColorCardDraft || undefined,
                colorPalette: colorPalette.length ? colorPalette : undefined,
                colorCardPrompt: (values.sceneColorCardPrompt || "").trim(),
            };
            const asset = { ...base, kind: "scene" as const, data: sceneData, coverUrl: sceneImageDraft.url };
            await (editingAsset ? updateAsset(editingAsset.id, asset, editingAsset, resolveConflicts) : addAsset({ ...asset, id: newAssetId }));
        } else {
            if (!imageDraft) { message.error(t("assets.selectImage")); return; }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            await (editingAsset ? updateAsset(editingAsset.id, asset, editingAsset, resolveConflicts) : addAsset({ ...asset, id: newAssetId }));
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

    const readSceneImageFile = async (file: File | undefined, slot: "image" | "colorCard") => {
        if (!file || !file.type.startsWith("image/")) return;
        const uploaded = await uploadImage(file, { category: "library" });
        const draft: SceneImage = { url: uploaded.url, storageKey: uploaded.storageKey, name: file.name, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
        if (slot === "image") setSceneImageDraft(draft);
        else {
            setSceneColorCardDraft(draft);
            setSceneColorPaletteDraft([]);
            void extractColorCardPalette(draft);
        }
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const readAudioFile = async (file?: File) => {
        if (!file || !file.type.startsWith("audio/")) return;
        const result = await uploadMediaFile(file, "audio", "library");
        setAudioDraft({ url: result.url, storageKey: result.storageKey, bytes: result.bytes, mimeType: result.mimeType, durationMs: result.durationMs });
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const readCharacterVoiceFile = async (file?: File) => {
        if (!file || (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|flac|ogg|opus)$/i.test(file.name))) return;
        setUploadingCharacterVoice(true);
        try {
            const result = await uploadMediaFile(file, "audio", "library", { characterVoiceCompression: true });
            const name = result.compression ? `${file.name.replace(/\.[^.]+$/, "")}-24k-64kbps.mp3` : file.name;
            setCharacterVoice((current) => ({ url: result.url, name, description: current.description, storageKey: result.storageKey, assetId: "" }));
            if (result.compression) message.success(t("canvas.character.voiceCompressed", { before: Math.round(file.size / 1024), after: Math.round(result.bytes / 1024) }));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            message.error(reason === "CHARACTER_VOICE_COMPRESSION_UNAVAILABLE"
                ? t("canvas.character.voiceBackendRestartRequired")
                : t("canvas.character.voiceUploadFailed", { reason }));
        } finally {
            setUploadingCharacterVoice(false);
        }
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
            const blob = asset.kind === "scene"
                ? (asset.data.image.storageKey ? await getImageBlob(asset.data.image.storageKey) : asset.data.image.url ? await readAssetRemoteBlob(asset.data.image.url) : null)
                : await readAssetMediaBlob(asset);
            if (!blob) throw new Error("媒体不可读取");
            const extension = (asset.kind === "scene" ? asset.data.image.mimeType : asset.data.mimeType).split("/")[1]?.split("+")[0] || (asset.kind === "image" ? "png" : asset.kind === "video" ? "mp4" : "png");
            saveAs(blob, `${asset.title || asset.kind}.${extension}`);
        } catch { message.error(t("common.downloadFailed")); }
    };

    const downloadCharacterImages = async (asset: Asset) => {
        if (asset.kind !== "character" || !beginTransfer()) return;
        const view = transferViewRef.current;
        try {
            const filename = `${asset.title.trim() || t("assets.kinds.character")}-images.zip`;
            await exportCharacterImages(asset, filename);
        } catch {
            if (view === transferViewRef.current) message.error(t("assetTransfer.incomplete"));
        } finally { finishTransfer(); }
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning(t("assets.noneToExport"));
            return;
        }
        if (!beginTransfer()) return;
        const view = transferViewRef.current;
        try {
            await exportAssets(validAssets, t("assets.packageName"));
            if (view === transferViewRef.current) message.success(t("assetTransfer.exported"));
        } catch {
            if (view === transferViewRef.current) message.error(t("assetTransfer.incomplete"));
        } finally { finishTransfer(); }
    };

    const importAssetZip = async (file?: File) => {
        if (!file || !beginTransfer()) return;
        const view = transferViewRef.current;
        let importedCount = 0;
        try {
            const importedAssets = await readAssetPackage(file);
            // 重新分配 id 并维护 旧→新 映射，保证跨资产引用仍然有效
            const idMap = new Map<string, string>();
            importedAssets.forEach((asset) => idMap.set(asset.id, nanoid()));
            for (const asset of importedAssets) {
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
                const metadata = { ...(payload.metadata as Record<string, unknown> || {}) };
                delete metadata.sharedAssetSource;
                delete metadata.sharedAssetReference;
                delete metadata.sharedLibraryAssetId;
                payload.metadata = metadata;
                await addAsset(payload as Parameters<typeof addAsset>[0]);
                importedCount += 1;
            }
            if (view === transferViewRef.current) message.success(t("assets.imported", { count: importedAssets.length }));
        } catch {
            if (view === transferViewRef.current) message.error(t("assetTransfer.importIncomplete", { count: importedCount }));
        } finally {
            finishTransfer();
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset) return;
        try { await removeAsset(deletingAsset.id); } catch (error) { message.error(libraryErrorText(error)); return; }
        message.success(t("assets.deleted"));
        setDeletingAsset(null);
    };

    const renderFolderItem = (folderId: string, depth: number) => {
        const folder = folders.find((item) => item.id === folderId);
        if (!folder) return null;
        const active = folderFilter === folderId;
        return (
            <div key={folderId}>
                <div
                    style={{ paddingLeft: 12 + depth * 14 }}
                    className={cn("flex w-full items-center gap-2 rounded-md pr-1.5 text-left text-sm transition-colors hover:bg-muted", active && "bg-muted font-medium text-foreground")}
                >
                    <button type="button" className="ui-body flex min-h-9 min-w-0 flex-1 items-center gap-2 py-2 text-left max-sm:min-h-11" aria-pressed={active} onClick={() => { setFolderFilter(folderId); setPage(1); }}>
                        <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 truncate">{folder.name}</span>
                    </button>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <span>{facetCounts.folders.get(folderId) ?? 0}</span>
                        <Dropdown trigger={["click"]} menu={{
                            items: [
                                { key: "new", label: t("assets.folder.newFolder"), onClick: () => addFolder("新文件夹", folderId) },
                                { key: "rename", label: t("common.edit"), onClick: () => { const name = window.prompt(t("assets.folder.rename"), folder.name); if (name?.trim()) renameFolder(folder.id, name); } },
                                { key: "delete", label: t("common.delete"), danger: true, onClick: () => { removeFolder(folder.id); if (folderFilter === folderId) setFolderFilter(null); } },
                            ],
                        }}>
                            <button type="button" aria-label={t("common.edit")} className="ui-icon-button rounded text-muted-foreground hover:text-foreground"><MoreHorizontal className="size-4" /></button>
                        </Dropdown>
                    </span>
                </div>
                {childFoldersOf(folderId).map((child) => renderFolderItem(child.id, depth + 1))}
            </div>
        );
    };

    return (
        <div className="ui-controls relative flex h-full overflow-hidden bg-background text-foreground" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            {isDragging ? (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
                    <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/50 bg-card px-8 py-10 text-foreground">
                        <Upload className="size-8" />
                        <div className="text-lg font-medium">{t("assets.dropHere")}</div>
                        <div className="text-sm opacity-80">{t("assets.dropHint")}</div>
                    </div>
                </div>
            ) : null}
            <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-card/50 px-3 py-5 md:flex xl:w-56">
                <div className="ui-group-title mb-3 px-2 text-muted-foreground">{t("assets.drama.title")}</div>
                <button
                    type="button"
                    className={cn("mb-0.5 flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted", dramaFilter === ALL_DRAMAS && "bg-muted font-medium text-foreground")}
                    onClick={() => { setDramaFilter(ALL_DRAMAS); setPage(1); }}
                >
                    <span>{t("assets.drama.all")}</span>
                    <span className="text-xs text-muted-foreground">{facetCounts.allDramas}</span>
                </button>
                <div className="space-y-0.5">
                    {dramas.map((drama) => (
                        <button
                            key={drama.id}
                            type="button"
                            className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted", dramaFilter === drama.id && "bg-muted font-medium text-foreground")}
                            onClick={() => { setDramaFilter(drama.id); setPage(1); }}
                        >
                            <span className="flex min-w-0 items-center gap-2"><Clapperboard className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{drama.name}</span></span>
                            <span className="text-xs text-muted-foreground">{facetCounts.dramas.get(drama.id) ?? 0}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted", dramaFilter === UNASSIGNED_DRAMA && "bg-muted font-medium text-foreground")}
                        onClick={() => { setDramaFilter(UNASSIGNED_DRAMA); setPage(1); }}
                    >
                        <span>{t("assets.drama.unassigned")}</span>
                        <span className="text-xs text-muted-foreground">{facetCounts.unassigned}</span>
                    </button>
                </div>
                <div className="ui-group-title mb-3 mt-5 border-t border-border px-2 pt-5 text-muted-foreground">{t("assets.foldersTitle")}</div>
                <button
                    type="button"
                    className={cn("mb-1 flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted", !folderFilter && "bg-muted font-medium text-foreground")}
                    onClick={() => { setFolderFilter(null); setPage(1); }}
                >
                    <span>{t("assets.folder.all")}</span>
                    <span className="text-xs text-muted-foreground">{facetCounts.allFolders}</span>
                </button>
                <button
                    type="button"
                    className={cn("mb-1 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted", folderFilter === ROOT_FOLDER && "bg-muted font-medium text-foreground")}
                    onClick={() => { setFolderFilter(ROOT_FOLDER); setPage(1); }}
                >
                    <span className="flex min-w-0 items-center gap-2"><Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{t("assets.folder.unfiled")}</span></span>
                    <span className="text-xs text-muted-foreground">{facetCounts.unfiled}</span>
                </button>
                <div className="flex-1 space-y-0.5 overflow-y-auto">
                    <div>
                        {rootFolders.map((folder) => renderFolderItem(folder.id, 0))}
                        <button
                            type="button"
                            className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            onClick={() => { const id = addFolder("新文件夹", null); setFolderFilter(id); setPage(1); }}
                        >
                            <FolderPlus className="size-4" />
                            {t("assets.folder.newFolder")}
                        </button>
                    </div>
                </div>
            </aside>
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
                <div className="mx-auto max-w-[1440px]">
                    <div className="pb-5">
                        <header className="flex flex-wrap items-center justify-between gap-3">
                            <h1 className="ui-page-title min-w-0">{t("assets.title")}</h1>
                            <div className="flex flex-wrap items-center gap-2">
                                <Dropdown
                                    rootClassName="ui-controls"
                                    trigger={["click"]}
                                    menu={{
                                        items: [
                                            { key: "export-library", disabled: transferBusy, label: t("assets.workspace.exportLibrary"), icon: <Download className="size-4" />, onClick: () => void exportAllAssets() },
                                            { key: "import", disabled: transferBusy, label: t("assets.import"), icon: <FileUp className="size-4" />, onClick: () => assetInputRef.current?.click() },
                                        ],
                                    }}
                                >
                                    <Button loading={transferBusy} icon={<ArrowDownUp className="size-4" />}>{t("assets.workspace.transferMenu")}</Button>
                                </Dropdown>
                                <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>{t("assets.add")}</Button>
                            </div>
                        </header>

                        <section aria-label={t("assets.workspace.findAssets")} data-resource-group="filters" className="mt-4 space-y-3">
                            <Input.Search
                                className="w-full max-w-2xl"
                                allowClear
                                prefix={<Search className="mr-1 size-4 text-muted-foreground" />}
                                aria-label={t("assets.search")}
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
                            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 md:hidden">
                                <div className="ui-caption text-muted-foreground">{t("assets.drama.label")}</div>
                                <Select aria-label={t("assets.drama.label")} value={dramaFilter} options={dramaOptions} onChange={(value) => { setDramaFilter(value); setPage(1); }} />
                            </div>
                            <details className="border-b border-border pb-2 md:hidden">
                                <summary className="ui-body min-h-11 cursor-pointer content-center py-2 text-foreground">{t("assets.foldersTitle")} · {currentFolderName}</summary>
                                <div className="mt-2 max-h-64 overflow-y-auto">
                                    <button type="button" className="ui-body mb-1 min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-muted" onClick={() => { setFolderFilter(null); setPage(1); }}>{t("assets.folder.all")}</button>
                                    {rootFolders.map((folder) => renderFolderItem(folder.id, 0))}
                                    <Button type="text" icon={<FolderPlus className="size-4" />} onClick={() => { const id = addFolder("新文件夹", currentFolderId); setFolderFilter(id); setPage(1); }}>{t("assets.folder.newFolder")}</Button>
                                </div>
                            </details>
                            <div className="flex items-start gap-2">
                                <div className="ui-caption shrink-0 py-2 text-muted-foreground">{t("assets.type")}</div>
                                <div className="flex min-w-0 flex-wrap gap-2">
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
                        </section>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <div className="ui-caption flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
                                <span className="min-w-0 break-words">{currentDramaName} / {currentFolderName} · {filteredAssets.length}</span>
                                {folderFilter ? <button type="button" className="min-h-8 cursor-pointer underline-offset-2 hover:underline max-sm:min-h-11" onClick={() => { setFolderFilter(null); setPage(1); }}>{t("assets.allAssets")}</button> : null}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {keyword || kindFilter !== "all" || dramaFilter !== ALL_DRAMAS || folderFilter ? <Button size="small" type="text" onClick={() => { setKeyword(""); setKindFilter("all"); setDramaFilter(ALL_DRAMAS); setFolderFilter(null); setPage(1); }}>{t("assets.workspace.clearFilters")}</Button> : null}
                                <Button size="small" type="text" className="!hidden md:!inline-flex" icon={<FolderPlus className="size-4" />} onClick={() => { const id = addFolder("新文件夹", currentFolderId); setFolderFilter(id); setPage(1); }}>{t("assets.folder.newFolder")}</Button>
                            </div>
                        </div>
                    </div>
                    {selection.length > 0 ? (
                        <section aria-label={t("assets.workspace.batchActions")} data-resource-group="batch-actions" className="mb-5 rounded-lg bg-muted/60 p-3 sm:p-4">
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div><h2 className="ui-group-title">{t("assets.workspace.batchActions")}</h2>
                                <span className="ui-caption mt-1 block text-muted-foreground">{t("assets.workspace.selectionScope")}</span></div>
                                <Button size="small" type="text" onClick={selectNone}>{t("common.deselectAll")}</Button>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                            <span className="ui-body text-foreground">{t("assets.selectedCount", { count: selection.length })}</span>
                            <Button size="small" disabled={selection.length === filteredAssets.length} onClick={selectAllFiltered}>
                                {t("common.selectAll")}
                            </Button>
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
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
                            <Button size="small" icon={<FolderPlus className="size-4" />}>{t("assets.move")}</Button>
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
                                <Button size="small" icon={<Clapperboard className="size-4" />}>{t("assets.drama.assign")}</Button>
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
                            <Button size="small" danger className="sm:ml-auto" icon={<Trash2 className="size-4" />} onClick={confirmBulkDelete}>
                                {t("assets.deleteBulk")}
                            </Button>
                            </div>
                        </section>
                    ) : null}

                    <div className="flex flex-col gap-4 sm:gap-6">
                        {missingSourceAssets.length > 0 && <Alert type="warning" showIcon message={t("assets.sharedAssetMissingSummary", { count: missingSourceAssets.length, names: missingSourceAssets.map(asset => asset.title || asset.id).join("、") })} />}
                        <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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

                        {!visibleAssets.length ? (
                            hydrateError ? (
                                <Alert
                                    type="warning"
                                    showIcon
                                    className="my-3"
                                    message={t("assets.readFailed")}
                                    description={<span className="break-all">{hydrateError}</span>}
                                />
                            ) : (
                                <div className="rounded-xl bg-card/50"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("assets.empty")} className="py-8 sm:py-12"><Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>{t("assets.add")}</Button></Empty></div>
                            )
                        ) : null}

                        <div className="flex flex-wrap justify-center border-t border-border pt-6">
                            <Pagination
                                current={page}
                                pageSize={pageSize}
                                total={filteredAssets.length}
                                showSizeChanger
                                showTotal={(total) => t("assets.totalCount", { count: total })}
                                pageSizeOptions={[10, 20, 50, 100]}
                                onChange={(nextPage, nextPageSize) => {
                                    setPage(nextPage);
                                    setPageSize(nextPageSize);
                                }}
                            />
                        </div>
                    </div>
                </div>
            </main>

            <Modal rootClassName="ui-controls" title={editingAsset ? t("assets.edit") : t("assets.add")} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset().catch(error => {
                if (error instanceof BackendApiError && error.details.code === "FIELD_CONFLICT") modal.confirm({ title: t("canvas.sharedLibrary.conflictTitle"), content: t("canvas.sharedLibrary.conflictDescription"), okText: t("canvas.sharedLibrary.useLocal"), cancelText: t("canvas.sharedLibrary.keepDraft"), onOk: () => saveAsset("local").catch(failure => { message.error(libraryErrorText(failure)); throw failure; }) });
                else message.error(libraryErrorText(error));
            })} okText={t("common.save")} okButtonProps={{ loading: uploadingCharacterVoice }} cancelText={t("common.cancel")} destroyOnHidden centered styles={{ body: { maxHeight: "min(72dvh, calc(100dvh - 160px))", overflowY: "auto" } }}>
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [] }}>
                        <section className="mb-6" data-resource-group="identity">
                            <h3 className="ui-group-title mb-4">{t("assets.workspace.identity")}</h3>
                            <Form.Item name="kind" label={t("assets.type")}>
                                <Select
                                    disabled={Boolean(editingAsset)}
                                    options={[
                                        { label: t("assets.kinds.text"), value: "text" },
                                        { label: t("assets.kinds.image"), value: "image" },
                                        { label: t("assets.kinds.video"), value: "video" },
                                        { label: t("assets.kinds.audio"), value: "audio" },
                                        { label: t("assets.kinds.character"), value: "character" },
                                        { label: t("assets.kinds.scene"), value: "scene" },
                                    ]}
                                    onChange={(value) => setFormKind(value)}
                                />
                            </Form.Item>
                            <Form.Item name="title" label={formKind === "character" ? t("assets.fields.characterName") : t("assets.fields.title")} rules={[{ required: true, message: formKind === "character" ? t("assets.fields.characterNameRequired") : t("assets.fields.titleRequired") }]}>
                                <Input size="large" placeholder={formKind === "character" ? t("assets.fields.characterNamePlaceholder") : t("assets.fields.titlePlaceholder")} />
                            </Form.Item>
                        </section>
                        <section className="mb-6" data-resource-group="content">
                            <h3 className="ui-group-title mb-4">{t("assets.workspace.content")}</h3>
                            {formKind === "text" ? (
                                <Form.Item name="content" label={t("assets.fields.textContent")} rules={[{ required: true, message: t("assets.fields.textRequired") }]}>
                                    <Input.TextArea rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                                </Form.Item>
                            ) : formKind === "audio" ? (
                                <Form.Item label={t("assets.fields.audioContent")} required>
                                    <div className="rounded-lg border border-dashed border-border p-4">
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
                                    <div className="rounded-lg border border-dashed border-border p-4">
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
                                                <Button icon={<Upload className="size-4" />} onClick={() => characterVoiceInputRef.current?.click()}>
                                                    {t("common.upload")}
                                                </Button>
                                                {hasCharacterVoiceSource(characterVoice) ? <Button aria-label={t("common.delete")} icon={<X className="size-4" />} onClick={() => setCharacterVoice({ url: "", name: "", description: "", assetId: "" })} /> : null}
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
                            ) : formKind === "scene" ? (
                                <>
                                    <Form.Item name="content" label={t("assets.fields.sceneDescription")}>
                                        <Input.TextArea rows={4} placeholder={t("assets.fields.sceneDescriptionPlaceholder")} />
                                    </Form.Item>
                                    <Form.Item label={t("assets.fields.sceneImage")} required>
                                        <div className="rounded-lg border border-dashed border-border p-4">
                                            <Button icon={<Upload className="size-4" />} onClick={() => sceneImageInputRef.current?.click()}>{t("assets.selectSceneImage")}</Button>
                                            {sceneImageDraft ? <Typography.Text type="secondary" className="ml-3 text-xs">{sceneImageDraft.width}x{sceneImageDraft.height} · {formatBytes(sceneImageDraft.bytes)}</Typography.Text> : <Typography.Text type="secondary" className="ml-3 text-xs">{t("assets.noSceneImageSelected")}</Typography.Text>}
                                        </div>
                                    </Form.Item>
                                    <Form.Item label={t("assets.fields.sceneColorCard")}>
                                        <div className="rounded-lg border border-dashed border-border p-4">
                                            <Button icon={<Upload className="size-4" />} onClick={() => sceneColorCardInputRef.current?.click()}>{t("assets.selectSceneColorCard")}</Button>
                                            {sceneColorCardDraft ? <Typography.Text type="secondary" className="ml-3 text-xs">{sceneColorCardDraft.width}x{sceneColorCardDraft.height} · {formatBytes(sceneColorCardDraft.bytes)}</Typography.Text> : <Typography.Text type="secondary" className="ml-3 text-xs">{t("assets.noSceneColorCardSelected")}</Typography.Text>}
                                        </div>
                                    </Form.Item>
                                    <div className="px-1 pb-2">
                                        <SceneColorPaletteEditor
                                            colors={sceneColorPaletteDraft}
                                            onChange={setSceneColorPaletteDraft}
                                            onReextract={() => { if (sceneColorCardDraft) void extractColorCardPalette(sceneColorCardDraft); }}
                                            reextracting={extractingScenePalette}
                                            hasColorCard={Boolean(sceneColorCardDraft)}
                                        />
                                    </div>
                                    <Form.Item name="sceneColorCardPrompt" label={t("assets.fields.sceneColorCardPrompt")}>
                                        <Input.TextArea rows={3} placeholder={t("assets.fields.sceneColorCardPromptPlaceholder")} />
                                    </Form.Item>
                                </>
                            ) : (
                                <Form.Item label={t("assets.fields.imageContent")} required>
                                    <div className="rounded-lg border border-dashed border-border p-4">
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
                        </section>
                        <section className="mb-6" data-resource-group="organization">
                            <h3 className="ui-group-title mb-4">{t("assets.workspace.organization")}</h3>
                            <Form.Item name="dramaId" label={t("assets.drama.field")}>
                                <Select options={dramaOptions.filter((option) => option.value !== ALL_DRAMAS)} />
                            </Form.Item>
                            {formKind !== "character" && formKind !== "scene" ? (
                                <Form.Item name="coverUrl" label={t("assets.fields.coverUrl")}>
                                    <Space.Compact className="w-full">
                                        <Input placeholder={t("assets.fields.coverPlaceholder")} />
                                        <Button icon={<Upload className="size-4" />} onClick={() => coverInputRef.current?.click()}>
                                            {t("common.upload")}
                                        </Button>
                                    </Space.Compact>
                                </Form.Item>
                            ) : null}
                            {formKind !== "character" && formKind !== "scene" ? (
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
                        </section>
                    </Form>
                    <div className="rounded-xl border border-border bg-muted/40 p-4">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
                            {(formKind === "character" ? characterCoverUrl : formKind === "scene" ? sceneCoverUrl : coverUrl || imageDraft?.dataUrl) ? (
                                <img src={formKind === "character" ? characterCoverUrl : formKind === "scene" ? sceneCoverUrl : coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-muted p-5 text-center text-sm text-muted-foreground">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {formKind !== "character" && formKind !== "scene" && tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : formKind !== "character" && formKind !== "scene" ? (
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
                <input
                    ref={sceneImageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => { void readSceneImageFile(event.target.files?.[0], "image"); event.target.value = ""; }}
                />
                <input
                    ref={sceneColorCardInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => { void readSceneImageFile(event.target.files?.[0], "colorCard"); event.target.value = ""; }}
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
        } else if (asset.kind === "scene") {
            if (asset.data.image.storageKey) lookups.push(resolveImageUrl(asset.data.image.storageKey, asset.data.image.url));
            else if (asset.data.image.url) lookups.push(Promise.resolve(asset.data.image.url));
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
    return <Tag icon={<Clapperboard className="size-3" />} className="m-0 max-w-full ui-caption"><span className="inline-block max-w-28 truncate align-bottom">{drama?.name || t("assets.drama.unassigned")}</span></Tag>;
}

function AssetCard({ asset, selected, onSelect, onOpen, onEdit, onCopy, onDownload, onDownloadCharacter, onDelete }: { asset: Asset; selected: boolean; onSelect: () => void; onOpen: () => void; onEdit: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDownloadCharacter: (asset: Asset) => void; onDelete: () => void }) {
    const { t } = useTranslation();
    const missingSource = asset.metadata?.sharedAssetMissing === true;
    const cover = useResolvedCoverUrl(asset);
    const summary = missingSource ? t("assets.sharedAssetMissing") : assetSummary(asset);
    return (
        <Card
            hoverable
            className={cn("group flex h-full flex-col overflow-hidden !border-border !bg-card transition-colors hover:!border-primary/40 hover:!shadow-none", selected && "!border-primary ring-1 ring-primary")}
            styles={{ body: { display: "flex", flexDirection: "column", flex: 1, padding: 0 } }}
            cover={
                <div className="relative">
                    <button type="button" className="block w-full overflow-hidden text-left focus-visible:outline-primary" onClick={onOpen}>
                        {cover ? (
                            <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                        ) : (
                            <div className="ui-body flex aspect-[4/3] items-center justify-center bg-muted/60 p-5 text-center text-muted-foreground"><span className="line-clamp-5">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</span></div>
                        )}
                    </button>
                    <label className="absolute right-1 top-1 flex size-9 cursor-pointer items-center justify-center max-sm:size-11">
                        <input type="checkbox" checked={selected} disabled={missingSource} onChange={onSelect} aria-label={t("canvas.project.select", { name: asset.title })} className="size-4 cursor-pointer accent-primary" />
                    </label>
                </div>
            }
        >
            <button type="button" className="block w-full flex-1 text-left focus-visible:outline-primary" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="ui-group-title line-clamp-1 text-foreground">{asset.title}</h2>
                            <Typography.Text type="secondary" className="ui-caption mt-1 block">
                                {asset.source || t("assets.unknownSource")}
                            </Typography.Text>
                        </div>
                        {missingSource && <Tag color="orange" className="m-0 shrink-0 ui-caption">{t("assets.sharedAssetMissing")}</Tag>}
                        <Tag className="m-0 shrink-0 ui-caption">{t(`assets.kinds.${asset.kind}`)}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="ui-body !mb-0 !mt-2">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        <AssetDramaTag asset={asset} />
                        {(asset.kind === "character" || asset.kind === "scene" ? [] : asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 ui-caption">
                                {tag}
                            </Tag>
                        ))}
                        {asset.kind !== "character" && asset.kind !== "scene" && !asset.tags?.length ? <Tag className="m-0 ui-caption">{t("assets.noTags")}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="mx-4 mt-auto border-t border-border py-3" data-resource-group="item-actions">
                <div className="flex flex-wrap items-center gap-1.5">
                <Button size="small" onClick={onOpen}>
                    {t("common.view")}
                </Button>
                {asset.kind === "text" ? (
                    <Button size="small" icon={<Copy className="size-4" />} onClick={() => void onCopy(asset)}>
                        {t("common.copy")}
                    </Button>
                ) : null}
                {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "scene" ? (
                    <Button size="small" disabled={missingSource} icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                        {t("common.download")}
                    </Button>
                ) : null}
                {asset.kind === "character" ? (
                    <Button size="small" disabled={missingSource} icon={<Download className="size-4" />} onClick={() => onDownloadCharacter(asset)}>
                        {t("assets.character.downloadImages")}
                    </Button>
                ) : null}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                    <span className="mr-auto ui-caption text-muted-foreground">{t("assets.workspace.manageItem")}</span>
                    <Button type="text" size="small" disabled={missingSource} icon={<PencilLine className="size-4" />} onClick={onEdit}>{t("common.edit")}</Button>
                    <Button type="text" size="small" danger disabled={missingSource} icon={<Trash2 className="size-4" />} onClick={onDelete}>{t("common.delete")}</Button>
                </div>
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
                    {asset.metadata?.sharedAssetMissing === true && <Alert type="warning" showIcon message={t("assets.sharedAssetMissing")} />}
                    {cover ? (
                        <MediaImage src={cover} alt={asset.title} name={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-border bg-muted p-5 text-sm leading-6 text-muted-foreground">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            <AssetDramaTag asset={asset} />
                            {(asset.kind === "character" || asset.kind === "scene" ? [] : asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-border p-4">
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
                                     <div className="rounded-md border border-border p-3">
                                         <Typography.Text strong>{asset.data.voiceName || t("canvas.character.voice")}</Typography.Text>
                                         {asset.data.voiceDescription ? <Typography.Paragraph type="secondary" className="!mb-0 !mt-1 whitespace-pre-wrap">{asset.data.voiceDescription}</Typography.Paragraph> : null}
                                     </div>
                                 ) : null}
                                 {asset.data.images.length ? (
                                    <div className="grid grid-cols-3 gap-2">
                                        {asset.data.images.map((image, idx) => (
                                            <MediaImage key={idx} src={image.url} alt={image.outfit || image.name} name={image.outfit || image.name} className="!rounded-md" />
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ) : asset.kind === "scene" ? (
                            <div className="mt-2 space-y-3">
                                {asset.data.description ? <Typography.Paragraph className="!mb-0 whitespace-pre-wrap">{asset.data.description}</Typography.Paragraph> : null}
                                {asset.data.colorCard ? <MediaImage src={asset.data.colorCard.url} alt={t("assets.fields.sceneColorCard")} className="!max-h-40 !rounded-md !object-cover" /> : null}
                                {asset.data.colorCardPrompt ? <Typography.Paragraph type="secondary" className="!mb-0 whitespace-pre-wrap">{asset.data.colorCardPrompt}</Typography.Paragraph> : null}
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
                        {asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "scene" ? (
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
    if (asset.kind === "scene") return asset.data.description || asset.data.colorCardPrompt || `${asset.data.image.width}x${asset.data.image.height}`;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
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
                <div key={idx} className="rounded-lg border border-border p-3">
                    <div className="flex gap-3">
                        <div className="size-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                            {previews[idx] ? (
                                <MediaImage src={previews[idx]} alt={image.outfit || image.name} name={image.outfit || image.name} className="!size-full !object-cover" />
                            ) : (
                                <div className="flex size-full items-center justify-center text-xs text-muted-foreground">无图</div>
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
                                <Button size="small" icon={<Upload className="size-4" />} onClick={() => { pendingIdxRef.current = idx; fileInputRef.current?.click(); }}>{t("common.upload")}</Button>
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
                icon={<Upload className="size-4" />}
                onClick={() => { pendingIdxRef.current = "new"; fileInputRef.current?.click(); }}
            >
                {t("assets.character.addImage")}
            </Button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
        </div>
    );
}
