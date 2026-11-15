import { App, Button, Empty, Input, Modal, Pagination, Tooltip } from "antd";
import { Check, Image as ImageIcon, Search, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
    DEFAULT_REFERENCE_FILTERS,
    REFERENCE_CATEGORIES,
    REFERENCE_MEDIA_TYPES,
    buildReferenceAssets,
    countReferenceFacets,
    filterReferenceAssets,
    isSelectionFull,
    paginateReferences,
    toggleReferenceSelection,
    type ReferenceAsset,
    type ReferenceCategory,
    type ReferenceMediaType,
} from "@/lib/creative-pad";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 8;

export type ReferenceAssetPickerProps = {
    open: boolean;
    /** 打开时带入的已选素材；确认后由调用方持有。 */
    value?: readonly ReferenceAsset[];
    /** 0 表示不限；默认 5，避免一次塞进过多参考图。 */
    maxSelected?: number;
    onConfirm: (items: ReferenceAsset[]) => void;
    onClose: () => void;
};

/** 从创作输入框点「+ 参考内容」弹出的素材库：左栏分面、搜索、网格多选、上传、确认。 */
export function ReferenceAssetPicker({ open, value, maxSelected = 5, onConfirm, onClose }: ReferenceAssetPickerProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const assets = useAssetStore(state => state.assets);
    const addAsset = useAssetStore(state => state.addAsset);
    const fileRef = useRef<HTMLInputElement>(null);
    const [keyword, setKeyword] = useState("");
    const [mediaType, setMediaType] = useState<ReferenceMediaType>("all");
    const [category, setCategory] = useState<ReferenceCategory>("all");
    const [page, setPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);

    const items = useMemo(() => buildReferenceAssets(assets), [assets]);
    const filters = useMemo(() => ({ ...DEFAULT_REFERENCE_FILTERS, keyword, mediaType, category }), [keyword, mediaType, category]);
    const filtered = useMemo(() => filterReferenceAssets(items, filters), [items, filters]);
    const facets = useMemo(() => countReferenceFacets(items, filters), [items, filters]);
    const result = useMemo(() => paginateReferences(filtered, page, PAGE_SIZE), [filtered, page]);
    const selectedItems = useMemo(
        () => selectedIds.map(id => items.find(item => item.id === id)).filter((item): item is ReferenceAsset => Boolean(item)),
        [selectedIds, items],
    );

    // 只在「打开」这一刻同步调用方已选，避免父组件每次渲染都重置用户正在做的多选。
    useEffect(() => {
        if (!open) return;
        setSelectedIds((value || []).map(item => item.id));
        setKeyword("");
        setMediaType("all");
        setCategory("all");
        setPage(1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => { if (result.page !== page) setPage(result.page); }, [result.page, page]);

    const labelForMediaType = (key: ReferenceMediaType) => t(`creativePad.picker.mediaType.${key}`);
    const labelForCategory = (key: ReferenceCategory) => t(`creativePad.picker.category.${key}`);

    const toggle = (id: string) => {
        if (isSelectionFull(selectedIds, id, maxSelected)) {
            message.info(t("creativePad.picker.selectionFull", { max: maxSelected }));
            return;
        }
        setSelectedIds(current => toggleReferenceSelection(current, id, maxSelected));
    };

    const handleUpload = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            message.warning(t("creativePad.picker.imageOnly"));
            return;
        }
        setUploading(true);
        try {
            const image = await uploadImage(file, { category: "library" });
            const title = file.name.replace(/\.[^.]+$/, "") || file.name;
            await addAsset({
                kind: "image",
                title,
                coverUrl: image.url,
                tags: [],
                source: t("creativePad.picker.uploadSource"),
                note: "",
                data: {
                    dataUrl: image.url,
                    storageKey: image.storageKey,
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                },
            });
            message.success(t("creativePad.picker.uploadOk"));
            setPage(1);
            setMediaType("all");
            setCategory("all");
            setKeyword("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setUploading(false);
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    const registeredOnly = selectedItems.filter(item => item.mediaType !== "image").length;

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width={1000}
            destroyOnHidden
            title={null}
            closable={false}
            styles={{ container: { padding: 0 }, body: { padding: 0 } }}
            className="reference-asset-picker"
        >
            {/* 显式不透明底色：本主题 antd 的 colorBgElevated 带透明度，不铺底会透出下层首页文字。 */}
            <div className="flex h-[620px] min-h-0 flex-col overflow-hidden rounded-lg bg-background text-foreground" data-testid="reference-asset-picker">
                <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3">
                    <div className="min-w-0">
                        <div className="ui-caption text-muted-foreground">{t("creativePad.picker.eyebrow")}</div>
                        <h2 className="ui-panel-title">{t("creativePad.picker.title")}</h2>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Input
                            className="w-64"
                            size="small"
                            allowClear
                            prefix={<Search className="size-3.5 text-muted-foreground" />}
                            placeholder={t("creativePad.picker.search")}
                            value={keyword}
                            aria-label={t("creativePad.picker.search")}
                            onChange={event => { setPage(1); setKeyword(event.target.value); }}
                        />
                        <Button type="text" size="small" aria-label={t("creativePad.picker.cancel")} icon={<X className="size-4" />} onClick={onClose} />
                    </div>
                </header>

                <div className="flex min-h-0 flex-1">
                    <aside className="flex w-52 shrink-0 flex-col border-r border-border" data-testid="reference-asset-facets">
                        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                            <FacetGroup title={t("creativePad.picker.mediaTypes")}>
                                {REFERENCE_MEDIA_TYPES.map(key => (
                                    <FacetRow key={key} label={labelForMediaType(key)} count={facets.mediaType[key]} active={mediaType === key}
                                        onClick={() => { setPage(1); setMediaType(key); }} />
                                ))}
                            </FacetGroup>
                            <FacetGroup title={t("creativePad.picker.categories")} className="mt-4">
                                {REFERENCE_CATEGORIES.map(key => (
                                    <FacetRow key={key} label={labelForCategory(key)} count={facets.category[key]} active={category === key}
                                        onClick={() => { setPage(1); setCategory(key); }} />
                                ))}
                            </FacetGroup>
                        </div>
                        <div className="shrink-0 border-t border-border p-3">
                            <input ref={fileRef} type="file" accept="image/*" hidden onChange={event => void handleUpload(event.target.files?.[0])} />
                            <Button size="small" block loading={uploading} icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                                {t("creativePad.picker.upload")}
                            </Button>
                            <p className="ui-caption mt-1.5 text-muted-foreground">{t("creativePad.picker.uploadHint")}</p>
                        </div>
                    </aside>

                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1 overflow-y-auto p-4">
                            {result.items.length ? (
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                                    {result.items.map(item => {
                                        const selected = selectedIds.includes(item.id);
                                        const full = isSelectionFull(selectedIds, item.id, maxSelected);
                                        return (
                                            <Tooltip key={item.id} title={full ? t("creativePad.picker.selectionFull", { max: maxSelected }) : undefined}>
                                                <button
                                                    type="button"
                                                    data-reference-card={item.id}
                                                    aria-pressed={selected}
                                                    aria-label={item.title}
                                                    onClick={() => toggle(item.id)}
                                                    className={cn(
                                                        "group overflow-hidden rounded-lg border bg-card text-left transition",
                                                        selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/40",
                                                        full && "opacity-55",
                                                    )}
                                                >
                                                    <div className="relative aspect-[4/3] w-full bg-muted">
                                                        {item.coverUrl ? (
                                                            <img src={item.coverUrl} alt="" className="h-full w-full object-cover" />
                                                        ) : (
                                                            <div className="flex h-full w-full items-center justify-center"><ImageIcon className="size-7 text-muted-foreground" /></div>
                                                        )}
                                                        <span className="absolute left-1.5 top-1.5 rounded bg-background/85 px-1.5 py-0.5 text-[10px] text-foreground">
                                                            {labelForMediaType(item.mediaType)}
                                                        </span>
                                                        {selected && (
                                                            <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                                                <Check className="size-3" />
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="p-2">
                                                        <div className="truncate text-xs font-medium text-foreground" title={item.title}>{item.title}</div>
                                                        <div className="ui-caption mt-1 truncate text-muted-foreground">{labelForCategory(item.category)}</div>
                                                    </div>
                                                </button>
                                            </Tooltip>
                                        );
                                    })}
                                </div>
                            ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("creativePad.picker.empty")} className="py-16" />
                            )}
                        </div>

                        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                            <div className="flex items-center gap-3">
                                <span className="ui-caption text-muted-foreground">
                                    {t("creativePad.picker.range", { from: result.from, to: result.to, total: result.total })}
                                </span>
                                {result.totalPages > 1 && <Pagination size="small" current={result.page} pageSize={PAGE_SIZE} total={result.total} onChange={setPage} showSizeChanger={false} />}
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="ui-caption text-muted-foreground" data-testid="reference-selected-count">
                                    {maxSelected > 0
                                        ? t("creativePad.picker.selected", { count: selectedItems.length, max: maxSelected })
                                        : t("creativePad.picker.selectedUnlimited", { count: selectedItems.length })}
                                </span>
                                <Button size="small" onClick={onClose}>{t("creativePad.picker.cancel")}</Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    disabled={!selectedItems.length}
                                    data-testid="reference-confirm"
                                    onClick={() => { onConfirm(selectedItems); onClose(); }}
                                >
                                    {t("creativePad.picker.confirm")}
                                </Button>
                            </div>
                        </footer>
                    </div>
                </div>
                {registeredOnly > 0 && (
                    <div className="shrink-0 border-t border-border px-5 py-2 text-xs text-muted-foreground">
                        {t("creativePad.picker.registeredOnly", { count: registeredOnly })}
                    </div>
                )}
            </div>
        </Modal>
    );
}

function FacetGroup({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
    return (
        <div className={className}>
            <div className="ui-caption mb-2 px-2 text-muted-foreground">{title}</div>
            <div className="space-y-0.5">{children}</div>
        </div>
    );
}

function FacetRow({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition",
                active ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
        >
            <span className="truncate">{label}</span>
            <span className="ui-caption tabular-nums">{count}</span>
        </button>
    );
}
