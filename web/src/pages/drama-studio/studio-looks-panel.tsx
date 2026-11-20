import { useEffect, useMemo, useRef, useState } from "react";
import { App, Modal } from "antd";
import { Shirt, RefreshCw, Plus, Pencil, Trash2, Play, Upload, Library, Sparkles } from "lucide-react";

import {
    fetchBackendProject,
    fetchBackendDramaEpisode,
    applyBackendCanvasOperations,
    backendMediaUrl,
    fetchDramaCastImpact,
    restyleDramaCast,
    startCanvasGeneration,
    fetchBackendTask,
} from "@/services/backend-api";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
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
    /** 面板内生成或上传自定义图后置位：重新生成需先解锁（对齐影策 look.locked）。 */
    locked?: boolean;
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

export function StudioLooksPanel({ dramaId, sharedAssetCanvasId, episodeIds, onOpenCanvas, onCountChange }: {
    /** 剧目 ID：单设定 restyle 影响集查询/提交必须带它，null 时只保留诚实提示。 */
    dramaId: string | null;
    sharedAssetCanvasId: string | null;
    episodeIds?: string[];
    onOpenCanvas: () => void;
    /** 汇报剧目级额外妆造总数（每个角色本体之外），供分类 tab 显示真实计数。 */
    onCountChange?: (count: number) => void;
}) {
    const { message, modal } = App.useApp();
    const config = useConfigStore((s) => s.config);
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
    const [impact, setImpact] = useState<Awaited<ReturnType<typeof fetchDramaCastImpact>> | null>(null);
    const [impactLoading, setImpactLoading] = useState(false);
    const [impactTick, setImpactTick] = useState(0);
    const [restyleSubmitting, setRestyleSubmitting] = useState(false);
    const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
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

    // 单设定 restyle：真实查询「引用该角色的剧情段」影响集，不用假数字。
    useEffect(() => {
        let disposed = false;
        if (!dramaId || !selectedCast) { setImpact(null); return; }
        setImpactLoading(true);
        fetchDramaCastImpact(dramaId, selectedCast, undefined)
            .then((result) => { if (!disposed) setImpact(result.ok ? result : null); })
            .catch(() => { if (!disposed) setImpact(null); })
            .finally(() => { if (!disposed) setImpactLoading(false); });
        return () => { disposed = true; };
    }, [dramaId, selectedCast, impactTick, refreshTick]);

    const selected = characters.find((c) => c.castId === selectedCast);
    const baseIndex = selected ? Math.min(Math.max(selected.primaryIndex, 0), Math.max(0, selected.images.length - 1)) : 0;
    const baseImage = selected?.images[baseIndex];
    const extra = selected ? selected.images.map((im, i) => ({ im, i })).filter(x => x.i !== baseIndex) : [];

    /** 真提交单设定 restyle：先查真实影响集→用户确认→后端标脏引用段，正在生成的段由后端跳过。 */
    const doRestyle = async (ch: CharacterLook) => {
        if (!dramaId) {
            message.warning("当前未定位到剧目，无法查询影响段；请从剧目页进入造型面板");
            return;
        }
        setRestyleSubmitting(true);
        try {
            const result = await fetchDramaCastImpact(dramaId, ch.castId);
            const generated = result.targets.filter((target) => target.hasVideo && !target.inputOutdated);
            if (!generated.length) {
                message.info(result.segments
                    ? `查到 ${result.segments} 个引用段，但没有已出片、需要重做的视频`
                    : "没有找到引用该角色的剧情段，无需重生成");
                return;
            }
            let confirmed = false;
            await new Promise<void>((resolve) => {
                modal.confirm({
                    title: `让引用「${ch.castName}」的剧情段视频重新生成？`,
                    content: `真实影响 ${result.episodes} 集 · ${result.segments} 段；其中 ${generated.length} 段已出片将被标记为需重新生成，正在生成的段自动跳过。此操作写入画布段状态，不会删除原视频。`,
                    okText: "确认提交重生成",
                    cancelText: "取消",
                    onOk: () => { confirmed = true; resolve(); },
                    onCancel: () => resolve(),
                });
            });
            if (!confirmed) return;
            const submitted = await restyleDramaCast(dramaId, ch.castId, { restyleSegments: true });
            if (submitted.affectedSegments) {
                message.success(`已提交 ${submitted.affectedSegments} 个剧情段重新生成（引用该角色的视频已标脏）`);
            } else {
                message.info("没有可标脏的引用段（可能已全部过期或正在生成）");
            }
            setImpactTick((t) => t + 1);
        } catch (error) {
            message.error(`单设定 restyle 失败：${(error as Error).message}`);
        } finally {
            setRestyleSubmitting(false);
        }
    };

    /** 真实写回画布角色节点：metadata.characterImages[] 与 characterPrimaryIndex 整体替换。 */
    const commit = async (ch: CharacterLook, images: LookImage[], primaryIndex: number, withRestyle: boolean) => {
        setSaving(true);
        try {
            await applyBackendCanvasOperations(ch.canvasId, [
                { type: "update_node", id: ch.nodeId, metadata: { characterImages: images, characterPrimaryIndex: primaryIndex } },
            ], ch.canvasRevision);
            message.success("造型已保存到画布角色节点");
            setEditing(null);
            setRefreshTick((t) => t + 1);
            if (withRestyle) await doRestyle(ch);
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
            ...(form.storageKey ? { locked: true } : {}),
        };
        const next = [...selected.images];
        if (editing.index === null) next.push(im); else next[editing.index] = im;
        void commit(selected, next, selected.primaryIndex, restyle);
    };
    const removeLook = (index: number) => {
        if (!selected) return;
        const name = String(selected.images[index]?.name || `第 ${index + 1} 套造型`);
        modal.confirm({
            title: `删除造型「${name}」？`,
            content: "会从画布角色节点移除这套妆造；引用该造型的参考图需重新生成。此操作写回画布角色节点。",
            okText: "删除造型",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => {
                const next = selected.images.filter((_, j) => j !== index);
                const primaryIndex = Math.min(selected.primaryIndex, Math.max(0, next.length - 1));
                void commit(selected, next, primaryIndex, restyle);
            },
        });
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
    /**
     * 面板内出图：复用画布既有出图链路，不新建造型表、不造后端接口。
     * mode=image 提交到角色节点 → Backend 用造型 prompt + 本体图作参考新建图片结果节点并执行；
     * 任务成功后把真实 storageKey 写回 metadata.characterImages[] 并锁定该造型。
     * 本体图必须 ready（有 storageKey），否则 disable 并说明原因——造型图以它为底图保持同一张脸。
     */
    const generateLook = async (ch: CharacterLook, index: number, im: LookImage) => {
        if (!baseImage?.storageKey) {
            message.warning("请先生成或上传角色本体参考图，造型图需要以它为底图");
            return;
        }
        const model = resolveModelForCapability(config, config.imageModel, "image");
        if (!model) return void message.warning("没有可用的图片生成模型，请到制作设置里配置参考图模型");

        const lookName = String(im.outfit || im.name || "造型").trim();
        const outfit = String(im.outfitDescription || "").trim();
        const identity = String(ch.description || "").trim();
        const prompt = [
            identity ? `角色本体设定：${identity}` : "",
            `本次造型：${lookName}${outfit ? ` —— ${outfit}` : ""}`,
            "五官与脸型严格沿用参考的角色本体图，保持同一张脸；只改变服装、发型与妆容。",
        ].filter(Boolean).join("\n");

        setGeneratingIndex(index);
        try {
            const started = await startCanvasGeneration({
                mode: "image",
                projectId: ch.canvasId,
                nodeId: ch.nodeId,
                prompt,
                references: [{
                    id: `look-base-${ch.castId}`,
                    name: `${ch.castName}-本体`,
                    storageKey: baseImage.storageKey,
                    mimeType: "image/png",
                }],
                count: 1,
                // 每次点击都是一次新的生成（含重新生成）；用随机 key 避免复用上次任务结果。
                idempotencyKey: `look-gen:${ch.nodeId}:${im.id || `slot-${index}`}:${nanoid(8)}`,
                model,
            });

            // 轮询权威任务：Backend 把结果写进结果节点，task.result.media 带真实 storageKey。
            const deadline = Date.now() + 180_000;
            let storageKey = "";
            for (;;) {
                const { task } = await fetchBackendTask(started.taskId);
                if (!task) throw new Error("造型生成任务不存在");
                if (task.status === "succeeded") {
                    const media = task.result?.media?.[0] || task.result?.images?.[0];
                    storageKey = String(media?.storageKey || "");
                    break;
                }
                if (task.status === "failed" || task.status === "cancelled") throw new Error(String(task.error || "造型生成失败"));
                if (Date.now() > deadline) throw new Error("造型生成超时");
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            if (!storageKey) throw new Error("生成成功但没有可用的图片存储键");

            // 写回真值：重新读取角色节点，避免生成期间 revision 变化导致基线过期。
            const fresh = await fetchBackendProject(ch.canvasId);
            const node = ((fresh.project?.nodes || []) as Array<Record<string, unknown>>)
                .find((n) => String(n.id) === ch.nodeId);
            if (!node) throw new Error("画布角色节点已不存在");
            const md = (node.metadata || {}) as Record<string, unknown>;
            const currentImages = (Array.isArray(md.characterImages) ? md.characterImages : []) as LookImage[];
            const matches = (entry: LookImage, i: number) => im.id
                ? String(entry.id) === String(im.id)
                : i === index;
            if (!currentImages.some(matches)) throw new Error("该造型已从画布移除，未写回生成结果");
            const nextImages = currentImages.map((entry, i) => matches(entry, i)
                ? {
                    ...entry,
                    storageKey,
                    url: backendMediaUrl(storageKey),
                    outfit: im.outfit || entry.outfit,
                    outfitDescription: im.outfitDescription || entry.outfitDescription,
                    name: im.name || im.outfit || entry.name,
                    locked: true,
                }
                : entry);
            await applyBackendCanvasOperations(ch.canvasId, [
                { type: "update_node", id: ch.nodeId, metadata: { characterImages: nextImages } },
            ], Number(fresh.project?.revision || 0));

            message.success(`已生成「${lookName}」造型图并写回画布角色节点（已锁定）`);
            setRefreshTick((t) => t + 1);
        } catch (error) {
            message.error(`造型图生成失败：${(error as Error).message}`);
        } finally {
            setGeneratingIndex(null);
        }
    };

    const triggerGenerate = (index: number, im: LookImage) => {
        if (!selected || !baseImage?.storageKey) return;
        if (generatingIndex !== null) return;
        // 已锁定的造型重新生成需先确认解锁（对齐影策 cast-looks.tsx:166）。
        if (im.locked) {
            modal.confirm({
                title: `重新生成「${im.outfit || im.name || "造型"}」？`,
                content: "将按已保存的外观描述生成新图，并覆盖当前已锁定的造型图。",
                okText: "解锁并生成",
                cancelText: "取消",
                onOk: () => { void generateLook(selected, index, im); },
            });
            return;
        }
        void generateLook(selected, index, im);
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
                    <label className="flex items-center gap-1 text-[11px] text-muted-foreground" data-studio-look-restyle
                        title="勾选后保存造型会真实查询引用该角色的剧情段，并把已出片视频标记为需重新生成（对齐影策单设定 restyle）">
                        <input type="checkbox" checked={restyle} onChange={(e) => setRestyle(e.target.checked)} />
                        让引用它的剧情段重新生成
                        {dramaId && impact ? (
                            <span className="ml-1 font-medium text-primary" data-studio-look-restyle-impact>
                                {impact.episodes} 集 · {impact.segments} 段
                            </span>
                        ) : (
                            <span className="ml-1 text-[10px] opacity-70" data-studio-look-restyle-hint>
                                {dramaId ? (impactLoading ? "影响段查询中…" : "影响段暂不可查") : "需从剧目页进入才可查影响段"}
                            </span>
                        )}
                        {restyleSubmitting ? <span className="ml-1 text-[10px] text-primary">提交中…</span> : null}
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
                                    <div className="mt-1 text-[10px] text-muted-foreground">
                                        {baseImage?.storageKey
                                            ? "主图已设为本体参考"
                                            : "本体参考图尚未就绪：请先在画布生成或上传本体图，造型图需要以它为底图（当前已禁用生成）"}
                                    </div>
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
                                        <span title="本段视频按本集章节序号自动选默认造型：范围包含本集第一章；多套命中取起点最晚、范围最窄；0 或留空不限，无命中回退角色本体">默认按章节自动选</span>
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
                                                    {im.locked ? <div className="mt-1 text-[10px] text-amber-500">已锁定（面板内生成或自定义图）</div> : null}
                                                    <div className="mt-2 flex flex-wrap items-center gap-1">
                                                        <button type="button" onClick={() => triggerGenerate(i, im)} data-studio-look-generate
                                                            disabled={!baseImage?.storageKey || generatingIndex !== null}
                                                            title={!baseImage?.storageKey
                                                                ? "请先生成或上传角色本体参考图，造型图需要以它为底图"
                                                                : im.locked
                                                                    ? "已锁定：重新生成会覆盖当前造型图"
                                                                    : im.storageKey ? "按外观描述重新生成造型图" : "生成这套造型图"}
                                                            className={cn("flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50", generatingIndex === i && "text-primary")}>
                                                            <Play className="size-3" /> {generatingIndex === i ? "生成中…" : im.locked ? "重新生成" : im.storageKey ? "重新生成" : "生成造型图"}
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
