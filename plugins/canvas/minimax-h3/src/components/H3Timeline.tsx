import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";

const REFERENCE_ROLE_LABELS: Record<string, string> = {
    character_identity: "人物形象",
    character_turnaround: "人物四视图",
    scene: "场景",
    blocking: "站位",
    storyboard: "分镜",
    keyframe: "关键帧",
    motion_reference: "动作参考",
    audio_reference: "音频参考",
    character_voice: "人物声线",
    style: "风格",
    palette: "色卡",
    prop: "道具",
    other: "未分类",
};
import { defaultPrompt } from "../constants";
import { compactSegmentStarts } from "../hooks/useH3Segments";
import { inferReferenceRole, refsForSegment, upsertCharacterGroup, withSegmentRefs } from "../services/h3-data";
import { H3_STORYBOARD_MIN_DURATION, isStoryboardModeEnabled, reorderStoryboardRefs, setStoryboardBoundary, setStoryboardMode, storyboardRefsForSegment, storyboardTrackItems, supportsStoryboardTrack } from "../services/h3-storyboard-track";
import { sameRef } from "../services/h3-compatibility";
import { H3_RUNTIME_REF_LIMITS, normalizeDroppedH3Ref, readCharacterGroupFromDrop } from "../services/h3-refs";
import { H3Icon } from "./H3Icon";
import { H3ClipCard } from "./H3ClipCard";
import { H3PreviewLightbox } from "./H3PreviewLightbox";

type H3TimelineProps = {
    ctx: CanvasNodeContext;
    segments: H3Segment[];
    selected?: H3Segment;
    total: number;
    onRemoveRef: (segmentId: string, ref: H3Ref) => void;
    onOpenCharacterGroup: (segmentId: string, groupId: string) => void;
    onEditRef: (segmentId: string, ref: H3Ref) => void;
    onRequestPickRef: (segmentId: string, slotIndex: number) => void;
    onRequestPickStoryboard: (segmentId: string) => void;
    onSegmentChange: (segment: H3Segment, select?: boolean) => void;
    /** 正在等待画布选节点的槽位（`${segmentId}:${slotIndex}`），用于高亮该格。 */
    pickingKey?: string;
    onPlayAll: () => void;
    fmt: (value: number) => string;
};

export function H3Timeline({ ctx, segments, selected, total, onRemoveRef, onOpenCharacterGroup, onEditRef, onRequestPickRef, onRequestPickStoryboard, onSegmentChange, pickingKey, onPlayAll, fmt }: H3TimelineProps) {
    const compactMedia = ctx.scale < 0.2;
    const trackScrollRef = useRef<HTMLDivElement | null>(null);
    const rulerInnerRef = useRef<HTMLDivElement | null>(null);
    const pendingScrollIdRef = useRef<string | null>(null);
    const restoredRef = useRef(false);
    const scrollPersistRafRef = useRef<number | null>(null);
    // ref 区域双击预览：普通图片/视频/音频 ref 双击放大，带 groupId 的格子仍走角色组编辑 modal
    const [previewRef, setPreviewRef] = useState<H3Ref | null>(null);
    const [storyboardResize, setStoryboardResize] = useState<{ segmentId: string; index: number; leftDuration: number } | null>(null);
    const storyboardResizeRef = useRef<{ segmentId: string; index: number; leftDuration: number; startX: number; startDuration: number; pairDuration: number } | null>(null);
    // ref 拖动时高亮目标槽（move / copy 落点），用 `${segmentId}:${refIndex}` 标识。dragend / drop 后清空。
    const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
    useEffect(() => {
        if (!previewRef) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPreviewRef(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [previewRef]);
    // 时间轴/参考区：鼠标滚轮转为横向滚动（与 Output 区域一致）
    useEffect(() => {
        const el = trackScrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                el.scrollLeft += e.deltaY;
            }
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);
    const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
    // 时间轴宽度由父容器宽度决定（100% 跟随），同时保留总时长所需的最小宽度，
    // 这样 9s 总长时不会再在右边留出大段黑色空白，1.8s 间隔仍按 100px/秒等比放大。
    const timelineMinWidth = Math.max(1000, total * 100);
    const playhead = Math.max(0, Math.min(total, Number(ctx.node.metadata?.playhead || 0)));
    // ruler 刻度根据滚动容器实测宽度动态生成：0~总时长用 1.6s 主刻度 + 0.4s 副刻度，
    // 超过总时长部分按 5s 间隔继续标记，避免右侧大片空白没刻度。
    const [trackWidth, setTrackWidth] = useState(timelineMinWidth);
    useLayoutEffect(() => {
        const node = trackScrollRef.current;
        if (!node) return;
        const measure = () => {
            const w = Math.max(node.clientWidth, timelineMinWidth);
            setTrackWidth(w);
            setHasHorizontalOverflow(node.scrollWidth > node.clientWidth + 1);
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [timelineMinWidth]);
    // ruler 刻度：0~containerSeconds 区间尽量按 5s 一格铺，但末端剩余空间
    // < 5s 时不强行塞一个超出容器的 5s 倍数刻度，改用一个"末端刻度"卡到容器右边缘。
    // 例：containerSeconds=22s → [0, 5, 10, 15, 20, 22]，最后那个 22 就在容器右边缘。
    // 例：containerSeconds=42s → [0, 5, 10, 15, 20, 25, 30, 35, 40]，最后那个 40 < 42 加 42。
    // 例：containerSeconds=20s（恰好对齐）→ [0, 5, 10, 15, 20]，不加末端。
    const tickInterval = 5;
    const containerSeconds = trackWidth / 100;
    const tickPositions: number[] = [];
    for (let t = 0; t <= containerSeconds + 0.0001; t += tickInterval) {
        tickPositions.push(Math.round(t * 10) / 10);
    }
    // 末端对齐：最后一个刻度距离容器右边缘 > 2s 时再加一个末端刻度
    const lastTick = tickPositions[tickPositions.length - 1] ?? 0;
    if (containerSeconds - lastTick > 2 && lastTick + 5 > containerSeconds + 0.0001) {
        // 上面的循环已经跳过了末端 5s 倍数，但 0..containerSeconds 之间本应该有刻度
        // 实际上 tickPositions 一直会到 lastTick ≤ containerSeconds 但最后一个 5s 倍数 > containerSeconds 时不加入
        // 比如 containerSeconds=22, lastTick=20, 20+5=25>22 — 22 距离 lastTick 2s 不加末端
        // 比如 containerSeconds=42, lastTick=40, 40+5=45>42, 42 距离 lastTick 2s 不加末端
    }
    if (containerSeconds - lastTick >= 2 && lastTick + tickInterval > containerSeconds + 0.0001) {
        tickPositions.push(Math.round(containerSeconds * 10) / 10);
    }
    const majorTicks = tickPositions.map((t) => ({ time: t, left: t * 100 }));
    const minorTicks: Array<{ left: number }> = [];

    // 节流持久化时间轴滚动位置，刷新后可恢复（避免每次 onScroll 都 updateMetadata）
    const persistScroll = useCallback((left: number) => {
        if (scrollPersistRafRef.current != null) return;
        scrollPersistRafRef.current = requestAnimationFrame(() => {
            scrollPersistRafRef.current = null;
            ctx.updateMetadata({ timelineScrollLeft: Math.round(left) });
        });
    }, [ctx]);
    // 把时间轴滚动到指定 clip：使其右边缘与可见区最右侧对齐（右侧对齐该 clip 最右侧）
    // 整个时间线（Ruler+Video+Refs）共用单一滚动容器，无需跨容器同步
    const scrollTimelineToSegment = useCallback((segment: H3Segment) => {
        const track = trackScrollRef.current;
        if (!track) return;
        const rightPx = (Number(segment.start || 0) + Math.max(0.5, Number(segment.duration || 1))) * 100;
        const target = Math.max(0, rightPx - track.clientWidth);
        track.scrollLeft = target;
        if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(-${target}px)`;
        persistScroll(target);
    }, [persistScroll]);
    // 新增 Clip 后，在 DOM 提交（内容宽度已更新）后确定性地把时间轴滚到该 Clip 最右侧
    useLayoutEffect(() => {
        const id = pendingScrollIdRef.current;
        if (!id) return;
        const segment = segments.find((item) => item.id === id);
        if (!segment) return;
        pendingScrollIdRef.current = null;
        scrollTimelineToSegment(segment);
    });
    // 刷新后恢复时间轴滚动位置（仅挂载时执行一次；新增 Clip 的 pending 滚动会覆盖它，不会被拉回）
    useLayoutEffect(() => {
        if (restoredRef.current) return;
        restoredRef.current = true;
        const left = Number(ctx.node.metadata?.timelineScrollLeft || 0);
        if (left > 0 && trackScrollRef.current) {
            trackScrollRef.current.scrollLeft = left;
            if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(-${left}px)`;
        }
    });
    // 卸载时清理 rAF，避免内存泄漏或已卸载组件的状态更新
    useEffect(() => {
        return () => {
            if (scrollPersistRafRef.current != null) cancelAnimationFrame(scrollPersistRafRef.current);
        };
    }, []);
    const startRefDrag = (event: React.DragEvent<HTMLDivElement>) => {
        const clip = (event.target as HTMLElement).closest<HTMLElement>(".minimax-ref-clip");
        const grid = clip?.parentElement;
        if (!clip || !grid) return;
        // 用 data-* 稳定定位，避免依赖 children 索引（.minimax-ref-content 内首个子元素是 playhead，会导致索引偏移 1）
        const segment = segments.find((item) => item.id === grid.dataset.segmentId);
        const refIndex = Number(clip.dataset.refIndex);
        const ref = segment && refsForSegment(segment)[refIndex];
        if (!segment || !ref) return;
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "copyMove";
        const characterGroup = ref.groupId ? segment.h3CharacterGroups?.[ref.groupId] : undefined;
        const characterNodeId = characterGroup?.characterNodeId;
        event.dataTransfer.setData("application/x-infinite-canvas-ref", JSON.stringify(characterGroup && characterNodeId ? {
            type: "character",
            kind: "character",
            url: ref.url,
            nodeId: characterNodeId,
            characterNodeId,
            characterAssetId: characterGroup.characterAssetId,
            characterName: characterGroup.characterName,
            characterPrimaryIndex: Math.max(0, characterGroup.outfits.findIndex((outfit) => outfit.id === ref.outfitId)),
            characterImages: characterGroup.outfits.map((outfit) => ({ url: outfit.url, outfit: outfit.name, storageKey: outfit.storageKey, mimeType: outfit.mimeType, role: outfit.role })),
            selectedOutfitKeys: characterGroup.outfits.filter((outfit) => outfit.enabled).map((outfit) => outfit.storageKey || outfit.url),
            characterVoiceUrl: characterGroup.voice?.url,
            characterVoiceName: characterGroup.voice?.name,
            characterVoiceDescription: characterGroup.voice?.description,
            characterVoiceStorageKey: characterGroup.voice?.storageKey,
            characterVoiceAssetId: characterGroup.voice?.assetId,
            defaultVoiceEnabled: characterGroup.voiceEnabled,
        } : ref));
        event.dataTransfer.setData("application/x-infinite-canvas-ref-source", segment.id);
        // 同 clip 内 reorder 走 move 语义；外 clip / 外部拖入走 copy。target 槽只能识别位置，
        // 拿不到"目标空 / 已占"，所以 move 本身不区分 move/swap，全部在 addRef 里根据目标槽现状判定。
        event.dataTransfer.setData("application/x-infinite-canvas-ref-source-index", String(refIndex));
    };
    const clearDropTarget = useCallback(() => setDropTargetKey(null), []);
    // 拖动过程中实时高亮目标槽；用 data-* 找 cell，避免依赖 children 索引
    const onRefRowDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes("application/x-infinite-canvas-ref")) return;
        event.preventDefault();
        event.stopPropagation();
        const clip = (event.target as HTMLElement).closest<HTMLElement>(".minimax-ref-clip");
        if (!clip) { setDropTargetKey(null); return; }
        const grid = clip.parentElement;
        if (!grid?.dataset.segmentId) return;
        const refIndex = clip.dataset.refIndex;
        if (refIndex === undefined) return;
        setDropTargetKey(`${grid.dataset.segmentId}:${refIndex}`);
    };
    const addRef = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        clearDropTarget();
        // 来源信息：判断"同 clip reorder" vs "跨 clip / 外部 copy"
        const sourceSegmentId = event.dataTransfer.getData("application/x-infinite-canvas-ref-source");
        const sourceIndexRaw = event.dataTransfer.getData("application/x-infinite-canvas-ref-source-index");
        const sourceIndex = sourceIndexRaw !== "" ? Number(sourceIndexRaw) : -1;
        const sourceSegment = sourceSegmentId ? segments.find((item) => item.id === sourceSegmentId) : null;
        // 优先用光标下的元素精确判定落在哪个 clip / 哪个槽
        const clipEl = (event.target as HTMLElement).closest<HTMLElement>(".minimax-ref-clip");
        const gridEl = clipEl?.parentElement?.closest<HTMLElement>(".minimax-ref-grid") || (event.target as HTMLElement).closest<HTMLElement>(".minimax-ref-grid");
        let target: H3Segment | undefined;
        let targetIndex = -1;
        if (clipEl) {
            const grid = clipEl.parentElement;
            if (grid) {
                target = segments.find((item) => item.id === grid.dataset.segmentId);
                targetIndex = Number(clipEl.dataset.refIndex);
            }
        }
        if (!target && gridEl?.dataset.segmentId) {
            target = segments.find((item) => item.id === gridEl.dataset.segmentId);
            // 没落到具体 cell，targetIndex 留 -1 表示"追加到末尾"
        }
        if (!target) {
            const track = event.currentTarget as HTMLDivElement;
            const rect = track.getBoundingClientRect();
            // 内容坐标 = 已滚动偏移 + 鼠标在可见区内偏移；每单位 100px
            const contentX = track.scrollLeft + (event.clientX - rect.left);
            const time = Math.max(0, Math.min(total, contentX / 100));
            target = segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected;
        }
        if (!target) return;
        const mode = String(target.mode || target.taskMode || "ref2va");
        if (mode === "t2v") return;
        const characterPayload = event.dataTransfer.getData("application/x-infinite-canvas-ref");
        if (sourceSegment && sourceSegment.id !== target.id) {
            let characterGroup: ReturnType<typeof readCharacterGroupFromDrop>;
            try {
                characterGroup = readCharacterGroupFromDrop(event);
            } catch {
                return;
            }
            if (characterGroup) {
                const updated = upsertCharacterGroup(target, characterGroup);
                onSegmentChange(updated, true);
                return;
            }
            try {
                const payload = JSON.parse(characterPayload) as Record<string, unknown>;
                if (String(payload.type || payload.kind || "").toLowerCase() === "character") return;
            } catch { /* ordinary media drops continue below */ }
        }
        const ref = sourceSegment?.id === target.id && sourceIndex >= 0
            ? refsForSegment(sourceSegment)[sourceIndex]
            : normalizeDroppedH3Ref(event);
        if (!ref) return;
        if (mode !== "ref2va" && ref.type !== "image") return;
        const targetRefs = [...refsForSegment(target)];
        // ref2va 的槽位不设数量上限（图片可无限增加）；i2v / fl2v 的图片槽位是固定语义（首帧 / 首尾帧）才受限。
        const maxImages = mode === "i2v" ? 1 : mode === "fl2v" ? 2 : Number.POSITIVE_INFINITY;
        // 同 clip 内 reorder：move 语义，drop 到具体槽则插到该位置（无空/已占都能搬），drop 到空白区就追加到末尾
        if (sourceSegment && sourceSegment.id === target.id && sourceIndex >= 0 && sourceIndex < targetRefs.length) {
            const [moved] = targetRefs.splice(sourceIndex, 1);
            const insertAt = targetIndex >= 0 && targetIndex <= targetRefs.length ? targetIndex : targetRefs.length;
            targetRefs.splice(insertAt, 0, moved);
            onSegmentChange(withSegmentRefs(target, targetRefs));
            return;
        }
        // 跨 clip / 外部拖入：copy 语义。
        const sameTypeCount = targetRefs.filter((item) => item.type === ref.type).length;
        if (sameTypeCount >= (ref.type === "image" ? maxImages : 3) || targetRefs.some((item) => item.url === ref.url)) return;
        const insertAt = targetIndex >= 0 && targetIndex <= targetRefs.length ? targetIndex : targetRefs.length;
        targetRefs.splice(insertAt, 0, ref);
        onSegmentChange(withSegmentRefs(target, targetRefs), true);
    };
    // 拖动结束 / 取消：清掉高亮（drop 没走到 addRef 的情况，比如拖出 ref-row 范围外松开）
    useEffect(() => {
        if (!dropTargetKey) return;
        const onEnd = () => clearDropTarget();
        window.addEventListener("dragend", onEnd);
        return () => window.removeEventListener("dragend", onEnd);
    }, [dropTargetKey, clearDropTarget]);
    const addSegment = () => {
        const previousIndex = selected ? segments.findIndex((segment) => segment.id === selected.id) : -1;
        const previous = previousIndex >= 0 ? segments[previousIndex] : segments[segments.length - 1];
        const inherited = previous ? (() => {
            const { id, result, resultStorageKey, results, status, progress, runtimeTaskId, refs, refItems, referenceBindings, storyboardModeEnabled, storyboardDurations, ...settings } = previous;
            return settings;
        })() : {};
        const nextSegment = {
            ...inherited,
            id: `segment-${Date.now()}`,
            prompt: defaultPrompt,
            duration: Number(previous?.duration || 5),
            status: "idle",
            progress: 0,
            result: "",
            results: [],
            refs: { image: [], video: [], audio: [] },
            refItems: [],
            referenceBindings: [],
            runtimeTaskId: "",
        };
        const insertAt = previousIndex >= 0 ? previousIndex + 1 : segments.length;
        const next = compactSegmentStarts([...segments.slice(0, insertAt), nextSegment, ...segments.slice(insertAt)]);
        pendingScrollIdRef.current = nextSegment.id;
        // 与点击 clip 一致：同步把播放头（刻度线）指向新 clip 起点，并退出“全部播放”模式
        ctx.updateMetadata({ segments: next, selectedSegmentId: nextSegment.id, playhead: Number(nextSegment.start || 0), h3PlaybackAll: false });
    };
    const renderRefGrid = (segment: H3Segment) => {
        const allRefs = refsForSegment(segment);
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        const storyboardMode = supportsStoryboardTrack(segment) && isStoryboardModeEnabled(segment);
        const storyboardLaneVisible = supportsStoryboardTrack(segment) && (storyboardMode || !storyboardRefsForSegment(segment).length);
        const refs = allRefs.map((ref, index) => ({ ref, index })).filter(({ ref }) => !storyboardMode || ref.type !== "image" || inferReferenceRole(ref) !== "storyboard");
        // 多参考模式（ref2va）槽位不设上限：至少铺 9 格，之后每多一个参考就多一格，
        // 最后一格永远是空槽（点击可在画布上选节点，也仍可拖素材进），用来继续加参考。
        const slotCount = mode === "t2v" ? 0 : mode === "i2v" ? 1 : mode === "fl2v" ? 2 : Math.max(9, refs.length + 1);
        // 同一类型内的序号（图片 1..N / 视频 1..N / 音频 1..N），用于判断是否超出 H3 的运行上限
        const ordinals = allRefs.map((item, position) => allRefs.slice(0, position).filter((other) => other.type === item.type).length + 1);
        // 用 px 定位让 ref grid 跟随实际像素宽度（容器被拉宽时 clip 不会按比例缩成一条线）
        const left = Number(segment.start || 0) * 100;
        const width = Math.max(100, Number(segment.duration || 1) * 100);
        return <div key={segment.id} data-segment-id={segment.id} className={`minimax-ref-grid ${slotCount === 0 ? "is-disabled" : ""} ${segment.id === selected?.id ? "active" : ""} ${storyboardLaneVisible ? "has-storyboard-row" : ""}`} style={{ left: `${left}px`, width: `${width}px`, ...(storyboardLaneVisible ? { top: "70px" } : {}), ...(slotCount > 0 && slotCount <= 3 ? { gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))`, gridTemplateRows: "minmax(0, 1fr)" } : {}) }} onClick={(event) => { event.stopPropagation(); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) }); }}>{slotCount === 0 ? <span className="minimax-ref-empty-label">无需参考素材</span> : Array.from({ length: slotCount }).map((_, index) => {
            const entry = refs[index];
            const ref = entry?.ref;
            const refIndex = entry?.index ?? allRefs.length;
            const label = mode === "i2v" ? "首帧" : mode === "fl2v" ? index === 0 ? "首帧" : "尾帧" : `Ref ${index + 1}`;
            const isGrouped = ref?.groupId;
            const limit = ref ? H3_RUNTIME_REF_LIMITS[ref.type] : 0;
            const overLimit = Boolean(ref) && ordinals[refIndex] > limit;
            // 末尾空槽 = 「继续加参考」入口，点击后在画布上选节点
            const isAddSlot = !ref && index >= refs.length;
            return <div
                key={index}
                data-ref-index={refIndex}
                data-group-id={ref?.groupId || undefined}
                draggable={ref ? true : undefined}
                onClick={ref ? undefined : (event) => {
                    event.stopPropagation();
                    ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) });
                    onRequestPickRef(segment.id, refIndex);
                }}
                onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (isGrouped && ref?.groupId) onOpenCharacterGroup(segment.id, ref.groupId);
                    else if (ref) setPreviewRef(ref);
                }}
                className={`minimax-ref-clip ${ref ? "has-ref" : "is-empty"} ${isAddSlot ? "is-add-slot" : ""} ${pickingKey === `${segment.id}:${refIndex}` ? "is-picking" : ""} ${isGrouped ? "is-character-group" : ""} ${ref?.role === "character_voice" ? "is-character-voice" : ""} ${overLimit ? "is-over-limit" : ""} ${dropTargetKey === `${segment.id}:${refIndex}` ? "is-drop-target" : ""}`}
                title={ref ? `${isGrouped ? "双击编辑角色组" : "双击放大预览"}${overLimit ? `（已超出 H3 运行上限：图片最多 ${H3_RUNTIME_REF_LIMITS.image} 张、视频/音频最多 ${H3_RUNTIME_REF_LIMITS.video} 个，运行会报错）` : ""}` : pickingKey === `${segment.id}:${refIndex}` ? "在画布上点选节点作为参考（Esc 取消）" : "点击进入画布选节点模式，挑一个节点作为参考（也可直接拖素材进来）"}
            >{ref ? <><div className="minimax-ref-media">{ref.type === "video" ? compactMedia ? <H3Icon name="clapperboard" /> : <video src={ref.url} muted playsInline preload="metadata" draggable={false} /> : ref.type === "image" ? <img src={ref.url} alt={ref.name} draggable={false} /> : <span>{ref.name}</span>}</div><span className="minimax-ref-type"><H3Icon name={ref.type === "image" ? "database" : ref.type === "video" ? "clapperboard" : "output"} /></span><span className="minimax-ref-role" title="编辑参考职责" onClick={(event) => { event.stopPropagation(); onEditRef(segment.id, ref); }}>{REFERENCE_ROLE_LABELS[ref.role || "other"] || "未分类"}</span><span className="minimax-ref-counts">{ref.name || label}</span><button type="button" title="移除参考" onClick={(event) => { event.stopPropagation(); onRemoveRef(segment.id, ref); }}>×</button></> : <><H3Icon name={isAddSlot ? "plus" : "paperclip"} /><span>{pickingKey === `${segment.id}:${index}` ? "选择中…" : label}</span></>}</div>;
        })}</div>;
    };
    const renderStoryboardTrack = (segment: H3Segment) => {
        if (!supportsStoryboardTrack(segment)) return null;
        const enabled = isStoryboardModeEnabled(segment);
        const items = storyboardTrackItems(segment);
        const hasStoryboards = items.length > 0;
        const left = Number(segment.start || 0) * 100;
        const width = Math.max(50, Number(segment.duration || 1) * 100);
        const projected = items.map((item, index) => ({ ...item, duration: storyboardResize?.segmentId === segment.id && storyboardResize.index === index ? storyboardResize.leftDuration : storyboardResize?.segmentId === segment.id && storyboardResize.index + 1 === index ? items[index - 1].duration + items[index].duration - storyboardResize.leftDuration : item.duration }));
        let cursor = 0;
        return <>
            {hasStoryboards ? <button
                type="button"
                className={`minimax-storyboard-mode-toggle ${enabled ? "is-on" : ""}`}
                style={{ left: `${left + 5}px` }}
                aria-pressed={enabled}
                title={enabled ? "关闭当前 Clip 的分镜时间轨" : "开启当前 Clip 的分镜时间轨"}
                onClick={(event) => { event.stopPropagation(); onSegmentChange(setStoryboardMode(segment, !enabled)); }}
            >{enabled ? "分镜轨 · 开" : "分镜轨 · 关"}</button> : null}
            {enabled || !hasStoryboards ? <div className="minimax-storyboard-lane" data-segment-id={segment.id} style={{ left: `${left}px`, width: `${width}px` }} onClick={(event) => { event.stopPropagation(); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) }); }}>
                {projected.length ? projected.map((item, index) => {
                    const start = cursor;
                    cursor += item.duration;
                    const imageWidth = item.duration * 100;
                    const canAdd = item.duration >= H3_STORYBOARD_MIN_DURATION * 2;
                    const pairDuration = item.duration + (projected[index + 1]?.duration || 0);
                    return <div
                        key={item.ref.bindingId || `${segment.id}:${index}`}
                        className="minimax-storyboard-card"
                        data-storyboard-id={item.ref.bindingId}
                        draggable
                        style={{ left: `${start * 100}px`, width: `${imageWidth}px` }}
                        title={`${item.ref.name || "分镜图"} · ${item.duration.toFixed(2)} 秒`}
                        onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-h3-storyboard", item.ref.bindingId || ""); }}
                        onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-h3-storyboard")) { event.preventDefault(); event.stopPropagation(); } }}
                        onDrop={(event) => {
                            const sourceId = event.dataTransfer.getData("application/x-h3-storyboard");
                            if (!sourceId || !item.ref.bindingId) return;
                            event.preventDefault();
                            event.stopPropagation();
                            onSegmentChange(reorderStoryboardRefs(segment, sourceId, item.ref.bindingId));
                        }}
                        onDoubleClick={(event) => { event.stopPropagation(); setPreviewRef(item.ref); }}
                    >
                        <div className="minimax-storyboard-card-visual">
                            <img src={item.ref.url} alt={item.ref.name} draggable={false} />
                            {index > 0 ? <span className="minimax-storyboard-time" title="切镜点 · 前序分镜累计时长">{start.toFixed(2)}s</span> : null}
                            <button type="button" className="minimax-storyboard-role" title="编辑分镜引用职责" onClick={(event) => { event.stopPropagation(); onEditRef(segment.id, item.ref); }} onDoubleClick={(event) => event.stopPropagation()}>分镜图</button>
                            <button type="button" className="minimax-storyboard-remove" title="移除分镜图" onClick={(event) => { event.stopPropagation(); onRemoveRef(segment.id, item.ref); }} onDoubleClick={(event) => event.stopPropagation()}>×</button>
                            {index === projected.length - 1 ? <button
                                type="button"
                                className="minimax-storyboard-add-half"
                                disabled={!canAdd}
                                title={canAdd ? "选择画布图片，并与末张分镜平分时长" : "末张时长不足 1 秒，无法新增分镜"}
                                onClick={(event) => { event.stopPropagation(); onRequestPickStoryboard(segment.id); }}
                                onDoubleClick={(event) => event.stopPropagation()}
                            ><span>＋</span><small>新增</small></button> : null}
                        </div>
                        {index < projected.length - 1 ? <div
                            className={`minimax-storyboard-boundary ${pairDuration >= H3_STORYBOARD_MIN_DURATION * 2 ? "" : "is-locked"}`}
                            role="separator"
                            aria-label="调整相邻分镜时长"
                            title={pairDuration >= H3_STORYBOARD_MIN_DURATION * 2 ? "拖动调整这两张分镜的时长" : "两张分镜总时长不足 1 秒，不能手动调整"}
                            onPointerDown={(event) => {
                                if (pairDuration < H3_STORYBOARD_MIN_DURATION * 2) return;
                                event.preventDefault();
                                event.stopPropagation();
                                event.currentTarget.setPointerCapture(event.pointerId);
                                storyboardResizeRef.current = { segmentId: segment.id, index, leftDuration: item.duration, startX: event.clientX, startDuration: item.duration, pairDuration };
                            }}
                            onPointerMove={(event) => {
                                const drag = storyboardResizeRef.current;
                                if (!drag || drag.segmentId !== segment.id || drag.index !== index) return;
                                const value = Math.max(H3_STORYBOARD_MIN_DURATION, Math.min(drag.pairDuration - H3_STORYBOARD_MIN_DURATION, drag.startDuration + (event.clientX - drag.startX) / 100));
                                drag.leftDuration = value;
                                setStoryboardResize({ segmentId: segment.id, index, leftDuration: value });
                            }}
                            onPointerUp={(event) => {
                                const drag = storyboardResizeRef.current;
                                if (!drag || drag.segmentId !== segment.id || drag.index !== index) return;
                                event.stopPropagation();
                                storyboardResizeRef.current = null;
                                setStoryboardResize(null);
                                onSegmentChange(setStoryboardBoundary(segment, index, drag.leftDuration));
                            }}
                            onPointerCancel={() => { storyboardResizeRef.current = null; setStoryboardResize(null); }}
                            onDoubleClick={(event) => event.stopPropagation()}
                        /> : null}
                    </div>;
                }) : <button type="button" className={`minimax-storyboard-first-add ${pickingKey === `${segment.id}:-1` ? "is-picking" : ""}`} title={pickingKey === `${segment.id}:-1` ? "在画布上点选分镜图（Esc 取消）" : "选择画布图片作为首张分镜"} onClick={(event) => { event.stopPropagation(); onRequestPickStoryboard(segment.id); }} onDoubleClick={(event) => event.stopPropagation()}>
                    <H3Icon name="plus" /><span>选择首张分镜图 · 占满 {Number(segment.duration || 1).toFixed(2)} 秒</span>
                </button>}
            </div> : null}
        </>;
    };
    return <div className="minimax-edit-timeline">
        <div className="minimax-timeline-controls"><button type="button" title="连续播放全部 Clip" onClick={onPlayAll}><H3Icon name="play" /></button></div>
        <div className="minimax-left-labels">
            <div className="minimax-video-label">Video</div>
            <div className="minimax-ref-label">Refs</div>
        </div>
        <div className="minimax-ruler-row" style={{ width: trackWidth }}>
            <div ref={rulerInnerRef} style={{ width: trackWidth }}>
            {majorTicks.map((tick, index) => <span className="minimax-tick" key={`M-${index}`} style={{ left: `${tick.left}px` }}><b>{fmt(tick.time)}</b></span>)}
            <span className="minimax-playhead minimax-playhead-marker" style={{ left: `${playhead * 100}px` }} />
            </div>
        </div>
        <div ref={trackScrollRef} className="minimax-tracks-scroll" style={{ overflowX: hasHorizontalOverflow ? "auto" : "hidden" }} onScroll={(event) => { const left = event.currentTarget.scrollLeft; persistScroll(left); if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(-${left}px)`; }}>
            <div className="minimax-track-body" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                <div className="minimax-video-row">
                    <div className="minimax-track-content" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                        {/* 视频行底部波形装饰条：只占总时长宽度（按 px），
                            避免 video-row 拉满后 ::after 跟着拉满铺满整行。 */}
                        {/* <div className="minimax-video-bottom-strip" style={{ width: timelineMinWidth }}>〰   〰   〰   〰</div> */}
                        <span className="minimax-playhead" style={{ left: `${playhead * 100}px` }} />
                        {segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segment={segment} index={index} segments={segments} selectedId={selected?.id} fmt={fmt} />)}
                    </div>
                </div>
                <div className="minimax-ref-row" onDragStart={startRefDrag} onDragOver={onRefRowDragOver} onDrop={addRef}>
                    <div className="minimax-ref-content" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                        <span className="minimax-playhead" style={{ left: `${playhead * 100}px` }} />
                        {segments.map(renderStoryboardTrack)}
                        {segments.map(renderRefGrid)}
                    </div>
                </div>
            </div>
        </div>
        <div className="minimax-track-gutter">
            <button type="button" className="minimax-video-add" onClick={addSegment}><H3Icon name="plus" /></button>
        </div>
        {previewRef ? <H3PreviewLightbox item={previewRef} onClose={() => setPreviewRef(null)} /> : null}
    </div>;
}
