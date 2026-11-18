import { useEffect, useMemo, useRef, useState } from "react";
import { App, Modal } from "antd";
import { Shirt, RefreshCw, Plus, Pencil, Trash2, Play, Upload, Library, Sparkles } from "lucide-react";

import {
    fetchBackendProject,
    fetchBackendDramaEpisode,
    applyBackendCanvasOperations,
    backendMediaUrl,
} from "@/services/backend-api";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { nanoid } from "nanoid";
import { cn } from "@/lib/utils";

/**
 * 剧目级造型——真值在画布角色节点 metadata.characterImages[]，不在别处另建副本。
 * 读取范围：共享资产画布 + 各集制作画布（本剧角色节点在分集画布上，共享画布只有 image 节点）。
 * 新增/改名/换图/删除走后端现成的画布 update_node op（metadata.characterImages 整体替换），
 * 不造假 CRUD；造型图模型生成仍引导到画布精修，素材库/自定义图可就地写回。
 */
type LookImage = {
    storageKey: string;
    url?: string;
    outfit?: string;
    outfitDescription?: string;
    name?: string;
    role?: string;
    width?: number;
    height?: number;
    fromChapter?: number;
    toChapter?: number;
    id?: string;
};
type CharacterLook = {
    castId: string;
    castName: string;
    description: string;
    images: LookImage[];
    primaryIndex: number;
    canvasId: string;
    nodeId: string;
    canvasRevision: number;
    source: string;
};
type LookForm = {
    name: string;
    appearance: string;
    from: string;
    to: string;
    storageKey: string;
    url: string;
    role: string;
};
const emptyForm: LookForm = { name: "", appearance: "", from: "", to: "", storageKey: "", url: "", role: "" };
const MAX_EXTRA_LOOKS = 6;

function chapterLabel(from?: number, to?: number) {
    if (from && to) return `第 ${from}–${to} 章`;
    if (from) return `第 ${from} 章起`;
    if (to) return `第 ${to} 章前`;
    return "不限章节";
}

export function StudioLooksPanel({ sharedAssetCanvasId, episodeIds, onOpenCanvas, onCountChange }: {
    sharedAssetCanvasId: string | null;
    episodeIds?: string[];
    onOpenCanvas: () => void;
    /** 汇报剧目级额外妆造总数（每个角色本体之外），供分类 tab 显示真实计数。 */
    onCountChange?: (count: number) => void;
}) {
    const { message } = App.useApp();
    const allAssets = useAssetStore((s) => s.assets);
    const imageAssets = useMemo(() => allAssets.filter((a): a is ImageAsset => a.kind === "image"), [allAssets]);
    const [characters, setCharacters] = useState<CharacterLook[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [selectedCast, setSelectedCast] = useState<string>("");
    const [refreshTick, setRefreshTick] = useState(0);
    const [editing, setEditing] = useState<{ castId: string; index: number | null } | null>(null);
    // 造型图放大预览（对齐影策 cast-looks.tsx:134/220「放大查看」）
    const [preview, setPreview] = useState<{ key: string; title: string } | null>(null);
    const [form, setForm] = useState<LookForm>(emptyForm);
    const [restyle, setRestyle] = useState(true);
    const customRef = useRef<HTMLInputElement | null>(null);

    const episodeKey = (episodeIds || []).join("|");
    useEffect(() => {
        let disposed = false;
        if (!sharedAssetCanvasId && !episodeKey) return;
        setLoading(true);
        const collect = (project: Record<string, unknown> | null | undefined, fallbackSource: string) => {
            const list: CharacterLook[] = [];
            const nodes = (project?.nodes || []) as Array<Record<string, unknown>>;
            for (const n of nodes) {
                if (n.type !== "character") continue;
                const md = (n.metadata || {}) as Record<string, unknown>;
                const images = (Array.isArray(md.characterImages) ? md.characterImages : []) as LookImage[];
                const entity = (md.productionEntity || {}) as Record<string, unknown>;
                list.push({
                    castId: String(md.characterAssetId || entity.entityId || n.id),
                    castName: String(md.characterName || n.title || "未命名"),
                    description: String(md.characterDescription || ""),
                    images: images.filter((im) => im && typeof im === "object" && typeof im.storageKey === "string"),
                    primaryIndex: Number(md.characterPrimaryIndex || 0),
                    canvasId: String(project?.id || ""),
                    nodeId: String(n.id),
                    canvasRevision: Number(project?.revision || 0),
                    source: fallbackSource,
                });
            }
            return list;
        };
        const jobs: Promise<CharacterLook[]>[] = [];
        if (sharedAssetCanvasId) jobs.push(fetchBackendProject(sharedAssetCanvasId).then(r => collect(r.project, "共享画布")).catch(() => []));
        for (const epId of episodeIds || []) {
            jobs.push(fetchBackendDramaEpisode(epId).then(r => collect(r.canvas, "分集画布")).catch(() => []));
        }
        Promise.all(jobs)
            .then((groups) => {
                if (disposed) return;
                const all = groups.flat();
                // 同名角色（跨集）只保留一处：优先保留造型更多、且在分集画布上的权威节点。
                const byName = new Map<string, CharacterLook>();
                for (const c of all) {
                    const prev = byName.get(c.castName);
                    if (!prev || (c.images.length > prev.images.length) || (c.source === "分集画布" && prev.source !== "分集画布" && c.images.length === prev.images.length)) byName.set(c.castName, c);
                }
                const list = [...byName.values()].sort((a, b) => a.castName.localeCompare(b.castName));
                setCharacters(list);
                // 影策造型计数 = 有父级的额外妆造数；本地 = 每个角色本体之外的造型图总数。
                const total = list.reduce((sum, c) => sum + Math.max(0, c.images.length - 1), 0);
                onCountChange?.(total);
            })
            .catch((error) => { if (!disposed) message.error(`读取画布造型失败：${(error as Error).message}`); })
            .finally(() => { if (!disposed) setLoading(false); });
        return () => { disposed = true; };
    }, [sharedAssetCanvasId, episodeKey, refreshTick, message, onCountChange]);

    useEffect(() => {
        if (!characters.length) return;
        setSelectedCast((cur) => characters.some((c) => c.castId === cur) ? cur : characters[0].castId);
    }, [characters]);

    const selected = characters.find((c) => c.castId === selectedCast);
    const baseIndex = selected ? Math.min(Math.max(selected.primaryIndex, 0), Math.max(0, selected.images.length - 1)) : 0;
    const baseImage = selected?.images[baseIndex];
    const extra = selected ? selected.images.map((im, i) => ({ im, i })).filter(x => x.i !== baseIndex) : [];

    /** 真实写回画布角色节点：metadata.characterImages[] 与 characterPrimaryIndex 整体替换。 */
    const commit = async (ch: CharacterLook, images: LookImage[], primaryIndex: number, withRestyle: boolean) => {
        setSaving(true);
        try {
            await applyBackendCanvasOperations(ch.canvasId, [
                { type: "update_node", id: ch.nodeId, metadata: { characterImages: images, characterPrimaryIndex: primaryIndex } },
            ], ch.canvasRevision);
            message.success(withRestyle
                ? "造型已保存到画布节点；引用该角色的剧情段视频请到分镜里重新生成"
                : "造型已保存到画布角色节点");
            setEditing(null);
            setRefreshTick((t) => t + 1);
        } catch (error) {
            message.error(`保存造型失败：${(error as Error).message}`);
        } finally {
            setSaving(false);
        }
    };

    const openAdd = () => {
        if (!selected || extra.length >= MAX_EXTRA_LOOKS) return;
        setForm(emptyForm);
        setEditing({ castId: selected.castId, index: null });
    };
    const openEdit = (index: number) => {
        if (!selected) return;
        const im = selected.images[index];
        setForm({
            name: im.outfit || im.name || "", appearance: im.outfitDescription || "",
            from: im.fromChapter ? String(im.fromChapter) : "", to: im.toChapter ? String(im.toChapter) : "",
            storageKey: im.storageKey || "", url: im.url || "", role: im.role || "",
        });
        setEditing({ castId: selected.castId, index });
    };
    const submitForm = () => {
        if (!selected || !editing || editing.castId !== selected.castId) return;
        const name = form.name.trim();
        if (!name) return void message.warning("请填写造型名");
        const prior: LookImage = editing.index === null ? { storageKey: "" } : selected.images[editing.index];
        const im: LookImage = {
            ...prior,
            storageKey: form.storageKey,
            ...(form.url ? { url: form.url } : {}),
            outfit: name,
            outfitDescription: form.appearance.trim(),
            name,
            ...(form.role ? { role: form.role } : {}),
            ...(Number(form.from) ? { fromChapter: Number(form.from) } : { fromChapter: undefined }),
            ...(Number(form.to) ? { toChapter: Number(form.to) } : { toChapter: undefined }),
            id: prior.id || `look-${nanoid()}`,
        };
        const next = [...selected.images];
        if (editing.index === null) next.push(im); else next[editing.index] = im;
        void commit(selected, next, selected.primaryIndex, restyle);
    };
    const removeLook = (index: number) => {
        if (!selected) return;
        const next = selected.images.filter((_, j) => j !== index);
        const primaryIndex = Math.min(selected.primaryIndex, Math.max(0, next.length - 1));
        void commit(selected, next, primaryIndex, restyle);
    };
    const pickLibraryImage = (id: string) => {
        const asset = imageAssets.find((a) => a.id === id);
        if (!asset) return;
        setForm((f) => ({ ...f, storageKey: asset.data.storageKey || "", url: asset.data.dataUrl || "" }));
    };
    const uploadCustom = async (file: File) => {
        if (!file.type.startsWith("image/")) return void message.warning("请选择图片文件");
        if (file.size > 20 * 1024 * 1024) return void message.warning("图片不超过 20MB");
        try {
            const r = await uploadImage(file, { category: "library" });
            setForm((f) => ({ ...f, storageKey: r.storageKey || "", url: r.url || "" }));
            message.success("自定义图已上传；点确认保存后写入画布节点并锁定该造型");
        } catch (error) {
            message.error(`上传失败：${(error as Error).message}`);
        }
    };
    const generateLook = (im: LookImage) => {
        // 本地造型图的模型生成只能在画布角色节点上做（无独立后端接口）。
        // 把该造型的外观描述放进剪贴板，打开画布后可直接粘到角色节点生成，避免按钮点了空转。
        const outfit = String(im.outfitDescription || im.outfit || "").trim();
        if (outfit) void navigator.clipboard?.writeText(outfit).catch(() => undefined);
        message.info(outfit
            ? "已复制该造型的外观描述，打开画布后粘贴到角色节点生成；完成后回到这里刷新"
            : "造型图请在画布角色节点上生成，完成后回到这里刷新");
        onOpenCanvas();
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-studio-looks>
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-2.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold"><Shirt className="size-3.5" /> 剧目造型</span>
                {characters.length > 1 ? (
                    <select value={selectedCast} onChange={(e) => { setSelectedCast(e.target.value); setEditing(null); }}
                        className="h-8 max-w-52 rounded-md border border-border bg-background px-2 text-xs outline-none" data-studio-look-cast>
                        {characters.map((c) => <option key={c.castId} value={c.castId}>{c.castName}</option>)}
                    </select>
                ) : selected ? <span className="text-xs text-muted-foreground">{selected.castName}</span> : null}
                <span className="text-[11px] text-muted-foreground">
                    共 {characters.length} 个角色 · 当前「{selected?.castName || "—"}」额外妆造 {extra.length}/{MAX_EXTRA_LOOKS} · 画布角色节点真实数据
                </span>
                <div className="ml-auto flex items-center gap-3">
                    <label className="flex items-center gap-1 text-[11px] text-muted-foreground" data-studio-look-restyle>
                        <input type="checkbox" checked={restyle} onChange={(e) => setRestyle(e.target.checked)} />
                        让引用它的剧情段重新生成
                    </label>
                    <button type="button" onClick={() => setRefreshTick((t) => t + 1)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><RefreshCw className="size-3" /> 刷新</button>
                    <button type="button" onClick={onOpenCanvas} className="text-[11px] text-muted-foreground hover:text-foreground">在画布中精修造型 →</button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {loading ? (
                    <div className="py-10 text-center text-xs text-muted-foreground">读取画布角色节点造型…</div>
                ) : !selected ? (
                    <div className="py-10 text-center text-xs text-muted-foreground">
                        没有找到画布角色节点。请先在精修画布/分集制作里建立角色设定，其造型图会出现在这里。
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="mb-1 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                            角色本体即基础造型（唯一，取自画布节点的主图索引）；额外妆造最多 {MAX_EXTRA_LOOKS} 套。改名、换图、删除都会写回画布角色节点。
                        </div>

                        {/* 角色本体 = 基础造型 */}
                        <div data-studio-look-base>
                            <div className="mb-2 text-[11px] font-semibold">角色本体 · 基础造型</div>
                            <div className="flex items-center gap-3 rounded-lg border border-foreground/30 bg-card/40 p-2.5">
                                <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                                    {baseImage?.storageKey ? <img src={backendMediaUrl(baseImage.storageKey)} alt={selected.castName} className="size-full object-cover cursor-zoom-in" data-studio-look-preview onClick={() => setPreview({ key: baseImage.storageKey!, title: `${selected.castName} · 本体` })} /> : <Shirt className="size-6 opacity-40" />}
                                </div>
                                <div className="min-w-0 text-[11px]">
                                    <div className="font-medium">{selected.castName}</div>
                                    <div className="mt-0.5 line-clamp-2 text-muted-foreground">{selected.description || "（无角色描述）"}</div>
                                    <div className="mt-1 text-[10px] text-muted-foreground">{baseImage ? "主图已设为本体参考" : "本体参考图尚未生成"}</div>
                                </div>
                            </div>
                        </div>

                        {/* 额外妆造（最多 6 套） */}
                        <div data-studio-look-extra>
                            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold">
                                <span>额外妆造（{extra.length}/{MAX_EXTRA_LOOKS}）</span>
                                {extra.length < MAX_EXTRA_LOOKS ? (
                                    <button type="button" onClick={openAdd} disabled={saving} data-studio-look-add
                                        className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-normal text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                        <Plus className="size-3" /> 添加造型
                                    </button>
                                ) : null}
                            </div>

                            {editing && editing.castId === selected.castId ? (
                                <div className="mb-3 space-y-2 rounded-lg border border-primary/40 bg-card/60 p-3" data-studio-look-form>
                                    <div className="text-[11px] font-medium">{editing.index === null ? "新增造型" : "编辑造型"}</div>
                                    <input aria-label="造型名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="造型名，如 外门弟子、霸道总裁"
                                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none" />
                                    <textarea aria-label="造型外观" value={form.appearance} onChange={(e) => setForm({ ...form, appearance: e.target.value })} rows={2}
                                        placeholder="这套造型的服装、发型与妆容；五官脸型沿用角色本体"
                                        className="w-full resize-none rounded-md border border-border bg-background p-2 text-[11px] outline-none" />
                                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                        <span>默认适用</span>
                                        <input aria-label="起始章" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value.replace(/\D/g, "") })} placeholder="起始章"
                                            className="h-8 w-20 rounded-md border border-border bg-background px-2 text-xs outline-none" />
                                        <span>至</span>
                                        <input aria-label="结束章" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value.replace(/\D/g, "") })} placeholder="结束章"
                                            className="h-8 w-20 rounded-md border border-border bg-background px-2 text-xs outline-none" />
                                        <small className="text-[10px]">0 或留空不限章节</small>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" data-studio-look-image-source>
                                        <Library className="size-3.5" />
                                        <select aria-label="造型图片素材库" value={form.storageKey} onChange={(e) => pickLibraryImage(e.target.value)}
                                            className="h-8 max-w-52 rounded-md border border-border bg-background px-2 text-xs outline-none">
                                            <option value="">素材库（选择图片）</option>
                                            {imageAssets.map((a) => <option key={a.id} value={a.data.storageKey || a.id}>{a.title}</option>)}
                                        </select>
                                        <button type="button" onClick={() => customRef.current?.click()} className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-[11px] transition hover:bg-muted">
                                            <Upload className="size-3" /> 自定义图
                                        </button>
                                        <input ref={(el) => { customRef.current = el; }} type="file" accept="image/*" hidden data-studio-look-upload
                                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadCustom(f); }} />
                                        {form.storageKey ? <span className="text-[10px] text-emerald-500">已设置造型图，保存后写回并锁定</span> : null}
                                    </div>
                                    <div className="flex items-center gap-2 pt-1">
                                        <button type="button" onClick={() => setEditing(null)} className="h-8 rounded-md border border-border px-3 text-[11px] text-muted-foreground hover:bg-muted">取消</button>
                                        <button type="button" onClick={submitForm} disabled={saving || !form.name.trim()}
                                            className="h-8 rounded-md bg-foreground px-3 text-[11px] font-medium text-background disabled:opacity-50">
                                            {saving ? "保存中…" : "确认保存"}
                                        </button>
                                    </div>
                                </div>
                            ) : null}

                            {extra.length === 0 && !editing ? (
                                <div className="rounded-lg border border-dashed border-border py-8 text-center text-[11px] text-muted-foreground">
                                    还没有额外妆造。点「添加造型」新建，或在画布角色节点里添加造型/服装图后刷新。
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                                    {extra.map(({ im, i }) => {
                                        const lookName = im.outfit || im.name || "未命名造型";
                                        return (
                                            <div key={`${im.storageKey}:${i}`} className="overflow-hidden rounded-lg border border-border bg-card/40" data-studio-look>
                                                <div className="flex aspect-[4/3] items-center justify-center bg-muted/40">
                                                    {im.storageKey ? <img src={backendMediaUrl(im.storageKey)} alt={lookName} className="size-full object-cover cursor-zoom-in" data-studio-look-preview onClick={() => setPreview({ key: im.storageKey!, title: `${selected.castName} · ${lookName}` })} /> : <Shirt className="size-6 opacity-40" />}
                                                </div>
                                                <div className="p-2.5">
                                                    <div className="truncate text-xs font-medium" title={lookName}>{lookName}</div>
                                                    <div className="mt-1 text-[11px] text-muted-foreground">{chapterLabel(im.fromChapter, im.toChapter)}</div>
                                                    <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{im.outfitDescription || "（无外观描述）"}</div>
                                                    <div className="mt-2 flex flex-wrap items-center gap-1">
                                                        <button type="button" onClick={() => generateLook(im)} data-studio-look-generate
                                                            className={cn("flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted")}>
                                                            <Play className="size-3" /> {im.storageKey ? "到画布重新生成" : "到画布生成"}
                                                        </button>
                                                        <button type="button" onClick={() => openEdit(i)} aria-label={`编辑造型 ${lookName}`}
                                                            className="rounded-md border border-border p-1 text-muted-foreground hover:bg-muted"><Pencil className="size-3" /></button>
                                                        <button type="button" onClick={() => removeLook(i)} aria-label={`删除造型 ${lookName}`}
                                                            className="rounded-md border border-border p-1 text-rose-500 hover:bg-rose-500/10"><Trash2 className="size-3" /></button>
                                                    </div>
                                                    <div className="mt-1 flex gap-1">
                                                        <button type="button" onClick={() => openEdit(i)} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted"><Library className="size-3" /> 素材库</button>
                                                        <button type="button" onClick={() => openEdit(i)} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted"><Upload className="size-3" /> 自定义图</button>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* 造型图放大预览（对齐影策 cast-looks 放大查看） */}
            <Modal title={preview?.title || "造型图"} open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width={560} centered>
                {preview ? <img src={backendMediaUrl(preview.key)} alt={preview.title} className="mx-auto max-h-[70vh] max-w-full object-contain" /> : null}
            </Modal>
        </div>
    );
}
