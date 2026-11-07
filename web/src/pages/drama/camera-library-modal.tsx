import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Spin } from "antd";
import { Check, Film, RefreshCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cameraLibraryMediaUrl, type CameraLibraryMove } from "@/services/backend-api";
import { cameraMovementValue, findCameraLibraryMove, findCameraLibraryMoveById, type CameraLibraryState } from "./camera-library-options";

/** 镜头库选择结果：movement 是「运镜方式」单选的标准值，previsId 是 acheng-director 的 001–132 检索号。 */
export type CameraLibrarySelection = { move: CameraLibraryMove; movement: string; previsId: string };

/** 视口内的卡片才取视频元数据（首帧）；悬停时才真正循环播放，132 段不会同时下载。 */
function MovePreview({ move, active }: { move: CameraLibraryMove; active: boolean }) {
    const host = useRef<HTMLDivElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const [inView, setInView] = useState(false);
    useEffect(() => {
        const node = host.current;
        if (!node) return;
        if (typeof IntersectionObserver === "undefined") return void setInView(true);
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                setInView(true);
                observer.disconnect();
            }
        }, { rootMargin: "160px" });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        const element = video.current;
        if (!element) return;
        if (active) void element.play().catch(() => undefined);
        else {
            element.pause();
            try { element.currentTime = 0; } catch { /* 元数据未就绪时忽略 */ }
        }
    }, [active, inView]);
    return <div ref={host} className="relative aspect-video overflow-hidden rounded bg-black/40">
        {inView && move.available
            ? <video ref={video} className="size-full object-cover" src={cameraLibraryMediaUrl(move.file)} muted loop playsInline preload="metadata" />
            : <div className="flex size-full items-center justify-center gap-1 text-muted-foreground"><Film className="size-4" /><span className="text-xs">#{move.id}</span></div>}
    </div>;
}

type Props = {
    open: boolean;
    disabled?: boolean;
    /** 与「运镜方式」下拉共用的一份只读清单，弹窗不再自己取一遍。 */
    library: CameraLibraryState;
    movement?: string;
    previsId?: string;
    onApply: (selection: CameraLibrarySelection) => void;
    onClose: () => void;
};

export function CameraLibraryModal({ open, disabled, library, movement, previsId, onApply, onClose }: Props) {
    const { t } = useTranslation();
    const { index, loading, error, reload } = library;
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("all");
    const [hovered, setHovered] = useState<string>();
    const [selected, setSelected] = useState<CameraLibraryMove>();
    const [videoFailed, setVideoFailed] = useState(false);

    // 每次打开都回到当前镜头的选择，避免把弹窗里的临时预览带进下一镜；
    // 清单异步就绪时也重新预选一次（此时还没有卡片可点，不会覆盖用户选择）。
    // 下拉单选与弹窗共用同一对字段：优先按已绑定的 Previs ID 预选，旧稿只有文本时按镜头名回查。
    useEffect(() => {
        if (!open) return;
        setQuery("");
        setCategory("all");
        setHovered(undefined);
        setVideoFailed(false);
        setSelected(findCameraLibraryMoveById(index, previsId || "") || findCameraLibraryMove(index, movement || ""));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, index]);

    const filtered = useMemo(() => {
        if (!index) return [] as CameraLibraryMove[];
        const needle = query.trim().toLowerCase();
        return index.moves.filter(move => {
            if (category !== "all" && move.category !== category) return false;
            if (!needle) return true;
            return [move.id, move.nameZh, move.nameEn, move.key, move.file]
                .some(value => value.toLowerCase().includes(needle));
        });
    }, [index, query, category]);

    const pick = (move: CameraLibraryMove) => {
        setSelected(move);
        setVideoFailed(false);
    };

    const apply = () => {
        if (!selected || disabled) return;
        // 运镜方式不再由弹窗手填：写入值与下拉单选完全同源。
        onApply({ move: selected, movement: cameraMovementValue(selected), previsId: selected.id });
        onClose();
    };

    return <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        width={1100}
        centered
        destroyOnHidden
        title={<span className="flex items-center gap-2"><Film className="size-4" />{t("director.atomic.cameraLibraryTitle")}</span>}
        styles={{ body: { padding: "12px 20px 20px" } }}
    >
        <div className="flex flex-col gap-3" data-camera-library-modal>
            <p className="mb-0 text-xs text-muted-foreground">{t("director.atomic.cameraLibraryHint")}</p>
            {error && <Alert type="error" showIcon message={error} action={<Button size="small" icon={<RefreshCw className="size-3" />} onClick={reload}>{t("director.atomic.cameraLibraryRetry")}</Button>} />}
            {!loading && index && !index.available && <Alert type="warning" showIcon message={index.reason || t("director.atomic.cameraLibraryUnavailable")} />}
            <div className="flex flex-wrap items-center gap-2">
                <Input className="max-w-xs" allowClear prefix={<Search className="size-3.5" />} placeholder={t("director.atomic.cameraLibrarySearch")} value={query} onChange={event => setQuery(event.target.value)} />
                <div className="flex flex-wrap gap-1">
                    <Button size="small" type={category === "all" ? "primary" : "default"} onClick={() => setCategory("all")}>{t("director.atomic.cameraLibraryAll")} · {index?.count ?? 0}</Button>
                    {(index?.categories || []).map(item => <Button key={item.key} size="small" type={category === item.key ? "primary" : "default"} onClick={() => setCategory(item.key)}>{t(`director.atomic.cameraLibraryCategory.${item.key}`)} · {item.count}</Button>)}
                </div>
                <span className="ml-auto text-xs text-muted-foreground">{t("director.atomic.cameraLibraryCount", { shown: filtered.length, total: index?.count ?? 0 })}</span>
            </div>
            <div className="grid min-h-[320px] gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="max-h-[52vh] overflow-y-auto pr-1">
                    {loading ? <div className="flex h-64 flex-col items-center justify-center gap-3 text-xs text-muted-foreground"><Spin />{t("director.atomic.cameraLibraryLoading")}</div>
                        : filtered.length === 0 ? <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">{t("director.atomic.cameraLibraryEmpty")}</div>
                            : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" data-camera-library-grid>
                                {filtered.map(move => <button
                                    type="button"
                                    key={move.key}
                                    data-camera-library-move={move.id}
                                    aria-pressed={selected?.key === move.key}
                                    onClick={() => pick(move)}
                                    onMouseEnter={() => setHovered(move.key)}
                                    onMouseLeave={() => setHovered(current => current === move.key ? undefined : current)}
                                    className={`grid gap-1.5 rounded-lg border p-2 text-left transition-colors ${selected?.key === move.key ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"}`}
                                >
                                    <div className="relative">
                                        <MovePreview move={move} active={hovered === move.key} />
                                        {selected?.key === move.key && <span className="absolute right-1 top-1 rounded bg-primary p-0.5 text-white"><Check className="size-3" /></span>}
                                        {!move.available && <span className="absolute inset-x-0 bottom-0 bg-destructive/80 text-center text-[10px] text-white">!</span>}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="truncate text-xs font-medium text-foreground">{move.nameZh}</div>
                                        <div className="truncate text-[11px] text-muted-foreground">{move.nameEn}</div>
                                    </div>
                                </button>)}
                            </div>}
                </div>
                <aside className="rounded-lg border border-border p-3" data-camera-library-detail>
                    {selected ? <>
                        <div className="aspect-video overflow-hidden rounded bg-black">
                            {videoFailed
                                ? <div className="flex size-full items-center justify-center text-xs text-muted-foreground">{t("director.atomic.cameraLibraryVideoError")}</div>
                                : <video key={selected.file} className="size-full object-contain" src={cameraLibraryMediaUrl(selected.file)} controls autoPlay loop muted playsInline onError={() => setVideoFailed(true)} />}
                        </div>
                        <div className="mt-3 space-y-1">
                            <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-muted px-1.5 py-0.5 text-xs">#{selected.id}</span><strong className="text-sm">{selected.nameZh}</strong><span className="text-xs text-muted-foreground">{selected.nameEn}</span></div>
                            <p className="mb-0 text-[11px] text-muted-foreground">{t(`director.atomic.cameraLibraryCategory.${selected.category}`)} · {selected.width}×{selected.height} · {selected.fps} fps · {selected.duration}s</p>
                        </div>
                        <div className="mt-3 grid gap-1.5 text-xs text-muted-foreground">
                            <span>{t("director.atomic.cameraLibraryMovement")}</span>
                            <div className="rounded border border-border bg-muted/30 px-2 py-1.5 text-foreground" data-camera-library-movement>{cameraMovementValue(selected)}</div>
                        </div>
                        <p className="mb-0 mt-2 text-[11px] text-muted-foreground">Previs ID：{selected.id}</p>
                    </> : <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">{t("director.atomic.cameraLibraryPickHint")}</div>}
                </aside>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">{selected ? t("director.atomic.cameraLibrarySelected", { name: selected.nameZh, id: selected.id }) : ""}</span>
                <div className="flex gap-2">
                    <Button onClick={onClose}>{t("director.atomic.cameraLibraryCancel")}</Button>
                    <Button type="primary" disabled={disabled || !selected} onClick={apply}>{t("director.atomic.cameraLibraryApply")}</Button>
                </div>
            </div>
        </div>
    </Modal>;
}
