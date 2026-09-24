import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
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
import { addStoryboardShot, assignStoryboardShotRef, H3_STORYBOARD_MIN_DURATION, insertStoryboardShotAfter, isStoryboardModeEnabled, reorderStoryboardShots, removeStoryboardShot, setStoryboardBoundary, setStoryboardMode, storyboardRefsForSegment, storyboardTrackItems, supportsStoryboardTrack, swapStoryboardReferences } from "../services/h3-storyboard-track";
import { sameRef } from "../services/h3-compatibility";
import { H3_RUNTIME_REF_LIMITS, normalizeDroppedH3Ref, readCharacterGroupFromDrop } from "../services/h3-refs";
import { H3Icon } from "./H3Icon";
import { H3ClipCard } from "./H3ClipCard";
import { h3ThemeVars } from "../h3-theme";

function newClipId() {
    const randomUUID = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID.bind(globalThis.crypto) : undefined;
    return `segment-${randomUUID ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

type H3TimelineProps = {
    ctx: CanvasNodeContext;
    segments: H3Segment[];
    selected?: H3Segment;
    total: number;
    onRemoveRef: (segmentId: string, ref: H3Ref) => void;
    onEditRef: (segmentId: string, ref: H3Ref) => void;
    onRequestReplaceRef: (segmentId: string, ref: H3Ref) => void;
    onRequestPickRef: (segmentId: string, slotIndex: number) => void;
    /** 空分镜请求绑定参考图：进入画布选节点模式，选中后把图片绑到该分镜。 */
    onRequestPickStoryboardShot: (segmentId: string, shotId: string) => void;
    /** 正在等待画布选节点来绑图的分镜（`${segmentId}:${shotId}`），用于高亮该卡。 */
    pickingShotKey?: string;
    onSegmentChange: (segment: H3Segment, select?: boolean) => void;
    /** 正在等待画布选节点的槽位（`${segmentId}:${slotIndex}`），用于高亮该格。 */
    pickingKey?: string;
    onPlayAll: () => void;
    fmt: (value: number) => string;
};

export function H3Timeline({ ctx, segments, selected, total, onRemoveRef, onEditRef, onRequestReplaceRef, onRequestPickRef, onRequestPickStoryboardShot, pickingShotKey, onSegmentChange, pickingKey, onPlayAll, fmt }: H3TimelineProps) {
    const compactMedia = ctx.scale < 0.2;
    const trackScrollRef = useRef<HTMLDivElement | null>(null);
    const rulerInnerRef = useRef<HTMLDivElement | null>(null);
    const pendingScrollIdRef = useRef<string | null>(null);
    const restoredRef = useRef(false);
    const scrollPersistRafRef = useRef<number | null>(null);
    const [storyboardResize, setStoryboardResize] = useState<{ segmentId: string; index: number; leftDuration: number } | null>(null);
    const storyboardResizeRef = useRef<{ segmentId: string; index: number; leftDuration: number; startX: number; startDuration: number; pairDuration: number } | null>(null);
    // 时间轴右键菜单（两种 kind）：
    // - storyboard：右键参考行的分镜轨/分镜卡片，afterId 有值表示点在某张分镜上（可"其后插入/移除"）。
    // - clip：右键视频行的 Clip 卡片，提供「在左边/右边添加 Clip」「删除 Clip」。
    type TimelineMenu = { kind: "storyboard"; segmentId: string; x: number; y: number; afterId?: string; index?: number } | { kind: "clip"; segmentId: string; x: number; y: number } | { kind: "reference"; segmentId: string; ref: H3Ref; x: number; y: number };
    const [timelineMenu, setTimelineMenu] = useState<TimelineMenu | null>(null);
    const refContentRef = useRef<HTMLDivElement | null>(null);
    const storyboardMenuRef = useRef<HTMLDivElement | null>(null);
    // 参考行右键 = 分镜菜单：直接从光标下的元素解析 Clip，再按光标的横向位置解析
    // 落在哪张分镜上，菜单因此永远贴着鼠标弹出，"新增分镜"也落在鼠标那一格。
    // 视频行右键 = Clip 菜单（onVideoRowContextMenu，见下）。
    // 分镜右键菜单只挂在「分镜轨 lane / 分镜卡片」上：参考九宫格（minimax-ref-grid）右键不触发，
    // 否则整条参考行都弹分镜菜单，触发区域过大。九宫格右键仅阻止冒泡到画布节点默认菜单
    // （避免误弹「复制 / 删除」），不再弹分镜菜单。若该位置没有可编辑分镜的 Clip
    // （i2v / t2v / fl2v 等不渲染分镜轨），则完全不拦截，交回画布默认右键菜单。
    // ⚠️ 不要再用「(clientX - 内容左边) / 100」把屏幕坐标换算成秒：画布视口带 scale(k)，1 秒对应的
    // 屏幕像素是 100k，缩放后换算结果整体偏小 → 解析到错误的 Clip（实测画布缩放到 0.184 时，右键靠后
    // 的 Clip 会解析成靠前的 Clip），表现就是"新增的分镜跑到别的位置去了"。改成 DOM 命中：分镜卡片
    // 带 data-segment-id / data-storyboard-id，与画布缩放无关。
    const storyboardShotAt = (segment: H3Segment, clientX: number) => {
        const lane = refContentRef.current
            ? Array.from(refContentRef.current.querySelectorAll<HTMLElement>(".minimax-storyboard-lane")).find((el) => el.dataset.segmentId === segment.id)
            : undefined;
        const card = lane
            ? Array.from(lane.querySelectorAll<HTMLElement>(".minimax-storyboard-card")).find((el) => { const rect = el.getBoundingClientRect(); return clientX >= rect.left && clientX <= rect.right; })
            : undefined;
        const id = card?.dataset.storyboardId;
        if (!id) return undefined;
        const index = storyboardTrackItems(segment).findIndex((item) => item.id === id);
        return index >= 0 ? { id, index } : undefined;
    };
    const onTimelineContextMenu = (event: ReactMouseEvent) => {
        const target = event.target as Element | null;
        // 只在「分镜轨 lane / 分镜卡片」上弹分镜菜单；参考九宫格右键只拦冒泡、不弹菜单。
        const lane = target?.closest?.(".minimax-storyboard-lane") as HTMLElement | null | undefined;
        if (lane) {
            const segment = segments.find((item) => item.id === lane.dataset.segmentId);
            if (!segment || !supportsStoryboardTrack(segment)) { event.preventDefault(); event.stopPropagation(); return; }
            event.preventDefault();
            event.stopPropagation();
            const shot = storyboardShotAt(segment, event.clientX);
            setTimelineMenu({ kind: "storyboard", segmentId: segment.id, x: event.clientX, y: event.clientY, afterId: shot?.id, index: shot?.index });
            return;
        }
        // 落在参考九宫格（minimax-ref-grid）上：阻止冒泡到画布节点默认菜单，但不开分镜菜单。
        const inRefGrid = target?.closest?.(".minimax-ref-grid") as HTMLElement | null | undefined;
        if (inRefGrid) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        // 其余空白 / 其它区域不拦截，交回画布默认右键菜单。
    };
    // 视频行右键 = Clip 菜单（左加/右加/删除）。只拦截真正落在 Clip 卡片上的右键；
    // 空白处不拦截，交回画布默认菜单。
    const onVideoRowContextMenu = (event: ReactMouseEvent) => {
        const holder = (event.target as Element | null)?.closest?.("[data-segment-id]") as HTMLElement | null | undefined;
        const segment = holder?.dataset.segmentId ? segments.find((item) => item.id === holder.dataset.segmentId) : undefined;
        if (!segment) return;
        event.preventDefault();
        event.stopPropagation();
        setTimelineMenu({ kind: "clip", segmentId: segment.id, x: event.clientX, y: event.clientY });
    };
    useEffect(() => {
        if (!timelineMenu) return;
        const close = () => setTimelineMenu(null);
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setTimelineMenu(null); };
        // 用 pointerdown 捕获阶段关闭（画布拖拽/平移路径会吞掉后续 click，click 监听不可靠，与项目其他浮层一致）；
        // 菜单内部的 pointerdown 不关闭，让菜单项自己的 onClick 正常执行。滚轮 / 再次右键也会关闭；菜单自身右键不冒泡关闭。
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && storyboardMenuRef.current?.contains(target)) return;
            setTimelineMenu(null);
        };
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("scroll", close, true);
        window.addEventListener("keydown", onKey);
        window.addEventListener("contextmenu", close);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("contextmenu", close);
        };
    }, [timelineMenu]);
    // 菜单贴在鼠标点弹出；只有当它会超出视口右/下边时才向内收，保证整块菜单始终可见。
    // 定位用 inline style（position:fixed + left/top）下发，不依赖事件源元素所在的坐标空间，
    // 所以画布怎么平移缩放都不影响菜单落点。
    useLayoutEffect(() => {
        const el = storyboardMenuRef.current;
        if (!el || !timelineMenu) return;
        const rect = el.getBoundingClientRect();
        el.style.left = `${Math.max(6, Math.min(timelineMenu.x, window.innerWidth - rect.width - 6))}px`;
        el.style.top = `${Math.max(6, Math.min(timelineMenu.y, window.innerHeight - rect.height - 6))}px`;
    }, [timelineMenu]);
    // ref 拖动时高亮目标槽（move / copy 落点），用 `${segmentId}:${refIndex}` 标识。dragend / drop 后清空。
    const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
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
    // 自定义横向滚动条（替代原生：更高便于点按，轨道与滑块统一在同一容器里处理）
    const scrollbarRef = useRef<HTMLDivElement | null>(null);
    const thumbRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        pointerId: number;
        mode: "thumb" | "jump";
        startX: number;
        startScrollLeft: number;
        maxScroll: number;
        thumbTravel: number;
        thumbWidth: number;
        scaleX: number;
    } | null>(null);
    const geomRef = useRef<{ trackWidth: number; contentWidth: number }>({ trackWidth: 0, contentWidth: 1 });
    const maxScrollValue = useCallback(() => {
        const { trackWidth, contentWidth } = geomRef.current;
        return Math.max(0, contentWidth - trackWidth);
    }, []);
    // 根据当前滚动位置刷新滑块位置（不触发 React 重渲染）
    const updateThumb = useCallback(() => {
        const track = scrollbarRef.current;
        const scroll = trackScrollRef.current;
        if (!track || !scroll) return;
        const { trackWidth, contentWidth } = geomRef.current;
        if (!trackWidth) return;
        const maxScroll = Math.max(0, contentWidth - trackWidth);
        const visibleRatio = contentWidth > 0 ? trackWidth / contentWidth : 1;
        const thumbWidth = Math.min(trackWidth, Math.max(24, trackWidth * visibleRatio));
        const thumbLeft = maxScroll ? (scroll.scrollLeft / maxScroll) * (trackWidth - thumbWidth) : 0;
        const t = thumbRef.current;
        if (t) { t.style.width = `${thumbWidth}px`; t.style.left = `${thumbLeft}px`; }
    }, []);
    // 测算轨道几何（可见宽度 + 内容总宽）并刷新滑块
    const measureAndUpdate = useCallback(() => {
        const track = scrollbarRef.current;
        const scroll = trackScrollRef.current;
        if (!track || !scroll) return;
        geomRef.current = { trackWidth: track.clientWidth, contentWidth: scroll.scrollWidth };
        updateThumb();
    }, [updateThumb]);
    /** 滚动条按下：按在滑块上按比例拖动，按在轨道空白处则让滑块中心对齐指针并可接着拖动。 */
    const alignThumbToPointer = useCallback((clientX: number) => {
        const drag = dragRef.current;
        const track = scrollbarRef.current;
        const scroll = trackScrollRef.current;
        if (!drag || !track || !scroll || !drag.thumbTravel) return;
        const x = (clientX - track.getBoundingClientRect().left) / drag.scaleX;
        scroll.scrollLeft = Math.max(0, Math.min(drag.thumbTravel, x - drag.thumbWidth / 2)) / drag.thumbTravel * drag.maxScroll;
    }, []);
    const onScrollbarPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        const track = scrollbarRef.current;
        const scroll = trackScrollRef.current;
        if (!track || !scroll) return;
        const maxScroll = maxScrollValue();
        if (!maxScroll) return;
        event.preventDefault();
        event.stopPropagation();
        const trackWidth = geomRef.current.trackWidth;
        const rect = track.getBoundingClientRect();
        const thumbWidth = thumbRef.current?.offsetWidth ?? 0;
        dragRef.current = {
            pointerId: event.pointerId,
            mode: event.target === thumbRef.current ? "thumb" : "jump",
            startX: event.clientX,
            startScrollLeft: scroll.scrollLeft,
            maxScroll,
            thumbTravel: Math.max(1, trackWidth - thumbWidth),
            thumbWidth,
            scaleX: rect.width && trackWidth ? rect.width / trackWidth : 1,
        };
        if (dragRef.current.mode === "jump") alignThumbToPointer(event.clientX);
        track.setPointerCapture(event.pointerId);
    }, [alignThumbToPointer, maxScrollValue]);
    const onScrollbarPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const scroll = trackScrollRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !scroll) return;
        event.preventDefault();
        if (drag.mode === "thumb") {
            const delta = (event.clientX - drag.startX) / drag.scaleX;
            scroll.scrollLeft = Math.max(0, Math.min(drag.maxScroll, drag.startScrollLeft + (delta / drag.thumbTravel) * drag.maxScroll));
            return;
        }
        alignThumbToPointer(event.clientX);
    }, [alignThumbToPointer]);
    const onScrollbarPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (scrollbarRef.current?.hasPointerCapture(event.pointerId)) scrollbarRef.current.releasePointerCapture(event.pointerId);
        dragRef.current = null;
    }, []);
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
            measureAndUpdate();
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [timelineMinWidth, hasHorizontalOverflow, measureAndUpdate]);
    // 新增/删除 Clip 后内容宽度变化（ResizeObserver 不一定触发），重新测算滚动条几何
    useLayoutEffect(() => {
        measureAndUpdate();
    }, [segments, total, measureAndUpdate]);
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
        // 同 Clip 的普通素材仍按 move 处理；两张分镜图落到彼此槽位时交换图片、分镜记录和时长。
        if (sourceSegment && sourceSegment.id === target.id && sourceIndex >= 0 && sourceIndex < targetRefs.length) {
            const sourceRef = targetRefs[sourceIndex];
            const targetRef = targetIndex >= 0 ? targetRefs[targetIndex] : undefined;
            if (sourceIndex !== targetIndex && sourceRef?.type === "image" && targetRef?.type === "image"
                && inferReferenceRole(sourceRef) === "storyboard" && inferReferenceRole(targetRef) === "storyboard"
                && sourceRef.bindingId && targetRef.bindingId) {
                const swapped = [...targetRefs];
                [swapped[sourceIndex], swapped[targetIndex]] = [swapped[targetIndex], swapped[sourceIndex]];
                const updated = swapStoryboardReferences(target, sourceRef.bindingId, targetRef.bindingId);
                onSegmentChange(withSegmentRefs(updated, swapped));
                return;
            }
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
    // 新建 Clip：继承基准 Clip 的设置（模式/提示词外的一切运行配置），内容清空。
    const buildClipAfter = (basis?: H3Segment) => {
        const { id, result, resultStorageKey, results, status, progress, runtimeTaskId, refs, refItems, referenceBindings, storyboardModeEnabled, storyboardDurations, storyboardShots, ...settings } = basis || ({} as H3Segment);
        return {
            ...settings,
            id: newClipId(),
            prompt: defaultPrompt,
            duration: Number(basis?.duration || 5),
            status: "idle",
            progress: 0,
            result: "",
            results: [],
            refs: { image: [], video: [], audio: [] },
            refItems: [],
            referenceBindings: [],
            runtimeTaskId: "",
        } as H3Segment;
    };
    // 在 index 处插入新 Clip 并选中：compactSegmentStarts 会重排各 Clip 的 start；
    // pendingScrollIdRef 让 DOM 提交后把时间轴滚到新 Clip 最右侧。
    const insertClipAt = (index: number, clip: H3Segment) => {
        const next = compactSegmentStarts([...segments.slice(0, index), clip, ...segments.slice(index)]);
        pendingScrollIdRef.current = clip.id;
        // 与点击 clip 一致：同步把播放头（刻度线）指向新 clip 起点，并退出“全部播放”模式
        ctx.updateMetadata({ segments: next, selectedSegmentId: clip.id, playhead: Number(next.find((item) => item.id === clip.id)?.start || 0), h3PlaybackAll: false });
    };
    const addSegment = () => {
        const previousIndex = selected ? segments.findIndex((segment) => segment.id === selected.id) : -1;
        const basis = previousIndex >= 0 ? segments[previousIndex] : segments[segments.length - 1];
        insertClipAt(previousIndex >= 0 ? previousIndex + 1 : segments.length, buildClipAfter(basis));
    };
    // Clip 右键菜单用：在 index 的左边/右边插入新 Clip（继承该 Clip 设置）。
    const addClipNear = (index: number, side: -1 | 1) => {
        const basis = segments[index];
        if (!basis) return;
        insertClipAt(side === 1 ? index + 1 : index, buildClipAfter(basis));
    };
    // 删除 Clip（至少保留一个）；删除后选中相邻的前一个 Clip。
    const removeClip = (index: number) => {
        if (segments.length <= 1) return;
        const next = segments.filter((_, i) => i !== index);
        ctx.updateMetadata({ segments: compactSegmentStarts(next), selectedSegmentId: next[Math.max(0, index - 1)]?.id || "" });
    };
    const renderRefGrid = (segment: H3Segment) => {
        const allRefs = refsForSegment(segment);
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        const storyboardMode = supportsStoryboardTrack(segment) && isStoryboardModeEnabled(segment);
        const storyboardLaneVisible = supportsStoryboardTrack(segment) && (storyboardMode || !storyboardTrackItems(segment).length);
        const refs = allRefs.map((ref, index) => ({ ref, index })).filter(({ ref }) => !storyboardMode || ref.type !== "image" || inferReferenceRole(ref) !== "storyboard");
        // 多参考模式（ref2va）槽位不设上限：至少铺 9 格，之后每多一个参考就多一格，
        // 最后一格永远是空槽（点击可在画布上选节点，也仍可拖素材进），用来继续加参考。
        const slotCount = mode === "t2v" ? 0 : mode === "i2v" ? 1 : mode === "fl2v" ? 2 : Math.max(9, refs.length + 1);
        // 同一类型内的序号（图片 1..N / 视频 1..N / 音频 1..N），用于判断是否超出 H3 的运行上限
        const ordinals = allRefs.map((item, position) => allRefs.slice(0, position).filter((other) => other.type === item.type).length + 1);
        // 用 px 定位让 ref grid 跟随实际像素宽度（容器被拉宽时 clip 不会按比例缩成一条线）
        const left = Number(segment.start || 0) * 100;
        const width = Math.max(100, Number(segment.duration || 1) * 100);
        // i2v / fl2v 只有 1~2 个固定语义槽位（首帧 / 首尾帧）。这里特判成"整条 Refs 轨一格撑满"
        // （repeat(slotCount) 列 + 单行 1fr），让首帧/尾帧这类单图占满整条参考轨、保持大图预览。
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
                    if (ref) onEditRef(segment.id, ref);
                }}
                onContextMenu={(event) => {
                    if (!ref) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setTimelineMenu({ kind: "reference", segmentId: segment.id, ref, x: event.clientX, y: event.clientY });
                }}
                className={`minimax-ref-clip ${ref ? "has-ref" : "is-empty"} ${isAddSlot ? "is-add-slot" : ""} ${pickingKey === `${segment.id}:${refIndex}` ? "is-picking" : ""} ${isGrouped ? "is-character-group" : ""} ${ref?.role === "character_voice" ? "is-character-voice" : ""} ${overLimit ? "is-over-limit" : ""} ${dropTargetKey === `${segment.id}:${refIndex}` ? "is-drop-target" : ""}`}
                title={ref ? `双击编辑参考素材职责${overLimit ? `（已超出 H3 运行上限：图片最多 ${H3_RUNTIME_REF_LIMITS.image} 张、视频/音频最多 ${H3_RUNTIME_REF_LIMITS.video} 个，运行会报错）` : ""}` : pickingKey === `${segment.id}:${refIndex}` ? "在画布上点选节点作为参考（Esc 取消）" : "点击进入画布选节点模式，挑一个节点作为参考（也可直接拖素材进来）"}
            >{ref ? <><div className="minimax-ref-media">{ref.type === "video" ? compactMedia ? <H3Icon name="clapperboard" /> : <video src={ref.url} muted playsInline preload="metadata" draggable={false} /> : ref.type === "image" ? <img src={ref.url} alt={ref.name} draggable={false} /> : <span>{ref.name}</span>}</div><span className="minimax-ref-role" title="参考职责">{REFERENCE_ROLE_LABELS[ref.role || "other"] || "未分类"}</span><span className="minimax-ref-counts">{ref.name || label}</span><button type="button" title="移除参考" onClick={(event) => { event.stopPropagation(); onRemoveRef(segment.id, ref); }} onDoubleClick={(event) => event.stopPropagation()}>×</button></> : <><H3Icon name={isAddSlot ? "plus" : "paperclip"} /><span>{pickingKey === `${segment.id}:${index}` ? "选择中…" : label}</span></>}</div>;
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
            {enabled || !hasStoryboards ? <div className="minimax-storyboard-lane" data-segment-id={segment.id} style={{ left: `${left}px`, width: `${width}px` }} onClick={(event) => { event.stopPropagation(); ctx.updateMetadata({ selectedSegmentId: segment.id, playhead: Number(segment.start || 0) }); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setTimelineMenu({ kind: "storyboard", segmentId: segment.id, x: event.clientX, y: event.clientY }); }}>
                {projected.length ? projected.map((item, index) => {
                    const start = cursor;
                    cursor += item.duration;
                    const imageWidth = item.duration * 100;
                    const pairDuration = item.duration + (projected[index + 1]?.duration || 0);
                return <div
                    key={item.id}
                    className={`minimax-storyboard-card ${item.ref ? "" : "is-empty"} ${pickingShotKey === `${segment.id}:${item.id}` ? "is-picking" : ""}`}
                    data-storyboard-id={item.id}
                    draggable
                    style={{ left: `${start * 100}px`, width: `${imageWidth}px` }}
                    title={`${item.ref?.name || `分镜 ${index + 1}`} · ${item.duration.toFixed(2)} 秒 · ${item.ref ? "双击编辑参考素材职责" : "单击进入画布选节点，为该分镜绑定参考图"} · 右键插入/移除`}
                    onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-h3-storyboard", item.id); }}
                    onDragOver={(event) => {
                        if (event.dataTransfer.types.includes("application/x-h3-storyboard")) { event.preventDefault(); event.stopPropagation(); return; }
                        // 空分镜接受外部图片素材拖入直接绑定
                        if (!item.ref && event.dataTransfer.types.includes("application/x-infinite-canvas-ref")) { event.preventDefault(); event.stopPropagation(); }
                    }}
                    onDrop={(event) => {
                        const sourceId = event.dataTransfer.getData("application/x-h3-storyboard");
                        if (sourceId) {
                            if (sourceId === item.id) return;
                            event.preventDefault();
                            event.stopPropagation();
                            onSegmentChange(reorderStoryboardShots(segment, sourceId, item.id));
                            return;
                        }
                        if (item.ref) return;
                        const dropped = normalizeDroppedH3Ref(event);
                        if (!dropped || dropped.type !== "image") return;
                        event.preventDefault();
                        event.stopPropagation();
                        onSegmentChange(assignStoryboardShotRef(segment, item.id, dropped));
                    }}
                    onClick={(event) => {
                        // 空分镜单击即进入画布选节点绑图（与参考九宫格空槽一致）；
                        // 已绑定图不在此处理，事件冒泡到分镜轨 lane 作选中段 + 定位播放头。
                        if (item.ref) return;
                        event.stopPropagation();
                        onRequestPickStoryboardShot(segment.id, item.id);
                    }}
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        if (item.ref) onEditRef(segment.id, item.ref);
                    }}
                        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setTimelineMenu({ kind: "storyboard", segmentId: segment.id, x: event.clientX, y: event.clientY, afterId: item.id, index }); }}
                    >
                        <div className="minimax-storyboard-card-visual">
                            {item.ref ? <img src={item.ref.url} alt={item.ref.name} draggable={false} /> : <div className="minimax-storyboard-placeholder">分镜 {index + 1} · 单击绑图</div>}
                            {index > 0 ? <span className="minimax-storyboard-time" title="切镜点 · 前序分镜累计时长">{start.toFixed(2)}s</span> : null}
                            {item.ref ? <span className="minimax-storyboard-role" style={{ cursor: "default" }}>分镜 {index + 1}</span> : null}
                            <button type="button" className="minimax-storyboard-remove" title="移除分镜" onClick={(event) => { event.stopPropagation(); onSegmentChange(removeStoryboardShot(segment, item.id)); }} onDoubleClick={(event) => event.stopPropagation()}>×</button>
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
                }) : <div className="minimax-storyboard-empty-hint" title="右键新建分镜">右键新建分镜</div>}
            </div> : null}
        </>;
    };
    const storyboardMenuSegment = timelineMenu ? segments.find((item) => item.id === timelineMenu.segmentId) : undefined;
    const storyboardMenuItems = storyboardMenuSegment ? storyboardTrackItems(storyboardMenuSegment) : [];
    const storyboardMenuItem = timelineMenu?.kind === "storyboard" && timelineMenu.afterId
        ? storyboardMenuItems.find((item) => item.id === timelineMenu.afterId)
        : undefined;
    const storyboardMenuLastTooShort = storyboardMenuItems.length > 0 && (storyboardMenuItems[storyboardMenuItems.length - 1]?.duration ?? 0) < H3_STORYBOARD_MIN_DURATION * 2;
    const storyboardMenuDonorTooShort = timelineMenu?.kind === "storyboard" && timelineMenu.afterId ? (storyboardMenuItems.find((item) => item.id === timelineMenu.afterId)?.duration ?? 0) < H3_STORYBOARD_MIN_DURATION * 2 : false;
    // ⚠️ 画布视口容器带 transform: translate(...) scale(k)，节点内的 position:fixed 会被当成
    // 「相对该变换祖先」定位、并跟着视口缩放 → 菜单会跑位、缩放后还会变得很小。
    // 所以菜单 portal 到 body，并且 position / left / top 全部走 inline style（不再依赖
    // .minimax-storyboard-menu 那条 CSS 规则是否生效）；body 下拿不到 .minimax-canvas-workbench 上的
    // --h3-* 变量，必须显式补一份 h3ThemeVars，否则边框/底色整条失效（同 H3 弹框的既有坑）。
    const timelineMenuClipIndex = timelineMenu ? segments.findIndex((item) => item.id === timelineMenu.segmentId) : -1;
    const timelineMenuNode = timelineMenu && storyboardMenuSegment ? createPortal(
        <div ref={storyboardMenuRef} className="minimax-storyboard-menu" style={{ ...h3ThemeVars(ctx.theme), position: "fixed", zIndex: 9999, left: `${timelineMenu.x}px`, top: `${timelineMenu.y}px` }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
            {timelineMenu.kind === "clip" ? <>
                <div className="minimax-storyboard-menu-title">{`Clip ${timelineMenuClipIndex + 1}`}</div>
                <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    title="在这个 Clip 左边插入一个新 Clip（继承本 Clip 的模式等设置）"
                    onClick={(event) => { event.stopPropagation(); addClipNear(timelineMenuClipIndex, -1); setTimelineMenu(null); }}
                >在左边添加 Clip</button>
                <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    title="在这个 Clip 右边插入一个新 Clip（继承本 Clip 的模式等设置）"
                    onClick={(event) => { event.stopPropagation(); addClipNear(timelineMenuClipIndex, 1); setTimelineMenu(null); }}
                >在右边添加 Clip</button>
                <button
                    type="button"
                    className="minimax-storyboard-menu-item is-danger"
                    disabled={segments.length <= 1}
                    title={segments.length <= 1 ? "至少保留一个 Clip" : "删除这个 Clip"}
                    onClick={(event) => { event.stopPropagation(); removeClip(timelineMenuClipIndex); setTimelineMenu(null); }}
                >删除 Clip</button>
            </> : timelineMenu.kind === "reference" ? <>
                <div className="minimax-storyboard-menu-title">参考素材 · {timelineMenu.ref.name || "当前引用"}</div>
                <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    title="关闭职责编辑并在画布上选择新的参考节点"
                    onClick={(event) => { event.stopPropagation(); onRequestReplaceRef(timelineMenu.segmentId, timelineMenu.ref); setTimelineMenu(null); }}
                >从画布中替换</button>
                <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    title="编辑当前参考素材职责"
                    onClick={(event) => { event.stopPropagation(); onEditRef(timelineMenu.segmentId, timelineMenu.ref); setTimelineMenu(null); }}
                >编辑参考素材职责</button>
            </> : <>
                <div className="minimax-storyboard-menu-title">{`Clip ${timelineMenuClipIndex + 1} · ${timelineMenu.kind === "storyboard" && timelineMenu.afterId ? `分镜 ${timelineMenu.index! + 1}` : "分镜轨"}`}</div>
                {timelineMenu.kind === "storyboard" && storyboardMenuItem?.ref ? <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    title="关闭职责编辑并在画布上选择新的分镜参考图"
                    onClick={(event) => { event.stopPropagation(); onRequestReplaceRef(timelineMenu.segmentId, storyboardMenuItem.ref!); setTimelineMenu(null); }}
                >从画布中替换</button> : null}
                {timelineMenu.kind === "storyboard" && timelineMenu.afterId ? <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    disabled={storyboardMenuDonorTooShort}
                    title={storyboardMenuDonorTooShort ? "该分镜时长不足 1 秒，无法在其后插入" : "在该分镜之后插入一张新分镜，并与其平分时长"}
                    onClick={(event) => { event.stopPropagation(); onSegmentChange(insertStoryboardShotAfter(storyboardMenuSegment, timelineMenu.afterId!)); setTimelineMenu(null); }}
                >在分镜 {timelineMenu.index! + 1} 之后插入</button> : null}
                <button
                    type="button"
                    className="minimax-storyboard-menu-item"
                    disabled={storyboardMenuLastTooShort}
                    title={storyboardMenuLastTooShort ? "末张分镜时长不足 1 秒，无法新增" : "新增分镜，并与末张分镜平分时长"}
                    onClick={(event) => { event.stopPropagation(); onSegmentChange(addStoryboardShot(storyboardMenuSegment)); setTimelineMenu(null); }}
                >{timelineMenu.kind === "storyboard" && timelineMenu.afterId ? "在末尾追加分镜" : "新建分镜"}</button>
                {timelineMenu.kind === "storyboard" && timelineMenu.afterId ? <button
                    type="button"
                    className="minimax-storyboard-menu-item is-danger"
                    title="移除该分镜，其时长合并到相邻分镜"
                    onClick={(event) => { event.stopPropagation(); onSegmentChange(removeStoryboardShot(storyboardMenuSegment, timelineMenu.afterId!)); setTimelineMenu(null); }}
                >移除分镜 {timelineMenu.index! + 1}</button> : null}
            </>}
        </div>,
        document.body,
    ) : null;
    return <>
        <div className="minimax-edit-timeline">
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
        <div ref={trackScrollRef} className="minimax-tracks-scroll" style={{ overflowX: hasHorizontalOverflow ? "auto" : "hidden" }} onScroll={(event) => { const left = event.currentTarget.scrollLeft; persistScroll(left); if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(-${left}px)`; updateThumb(); }}>
            <div className="minimax-track-body" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                <div className="minimax-video-row" onContextMenu={onVideoRowContextMenu}>
                    <div className="minimax-track-content" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                        {/* 视频行底部波形装饰条：只占总时长宽度（按 px），
                            避免 video-row 拉满后 ::after 跟着拉满铺满整行。 */}
                        {/* <div className="minimax-video-bottom-strip" style={{ width: timelineMinWidth }}>〰   〰   〰   〰</div> */}
                        <span className="minimax-playhead" style={{ left: `${playhead * 100}px` }} />
                        {segments.map((segment, index) => <H3ClipCard key={segment.id} ctx={ctx} segment={segment} index={index} segments={segments} selectedId={selected?.id} fmt={fmt} />)}
                    </div>
                </div>
                <div className="minimax-ref-row" onContextMenu={onTimelineContextMenu} onDragStart={startRefDrag} onDragOver={onRefRowDragOver} onDrop={addRef}>
                    <div ref={refContentRef} className="minimax-ref-content" style={{ minWidth: timelineMinWidth, width: "100%" }}>
                        <span className="minimax-playhead" style={{ left: `${playhead * 100}px` }} />
                        {segments.map((segment) => <Fragment key={segment.id}>{renderStoryboardTrack(segment)}</Fragment>)}
                        {segments.map((segment) => <Fragment key={segment.id}>{renderRefGrid(segment)}</Fragment>)}
                    </div>
                </div>
            </div>
        </div>
        <div
            ref={scrollbarRef}
            className={`minimax-timeline-scrollbar ${hasHorizontalOverflow ? "" : "is-disabled"}`}
            aria-hidden="true"
            onPointerDown={onScrollbarPointerDown}
            onPointerMove={onScrollbarPointerMove}
            onPointerUp={onScrollbarPointerEnd}
            onPointerCancel={onScrollbarPointerEnd}
        >
            <div
                ref={thumbRef}
                className="minimax-timeline-scroll-thumb"
                aria-hidden="true"
            />
        </div>
        <div className="minimax-track-gutter">
            <button type="button" className="minimax-video-add" onClick={addSegment}><H3Icon name="plus" /></button>
        </div>
        {timelineMenuNode}
    </div>
    </>;
}
