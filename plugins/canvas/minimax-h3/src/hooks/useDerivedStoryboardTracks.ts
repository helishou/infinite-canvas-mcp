import { useCallback, useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";

export type DerivedStoryboardTrack = {
    storyboardShots: Array<Record<string, unknown>>;
    referenceBindings: Array<Record<string, unknown>>;
    duration: number;
};
export type DerivedStoryboardTracks = { revision: number; tracks: Record<string, DerivedStoryboardTrack> };

/**
 * 分镜格是制作稿 `shot.keyframes` 的派生视图。
 *
 * 画布 segment 上那份 `storyboardShots` / `referenceBindings` 只是历史投影：制作台改完关键帧后，
 * 它要等一次成功编译才会被刷新，而那次编译经常被占用的 H3 任务或锁定的 Clip 挡住。
 * 所以面板不再信任画布副本，改用制作台（唯一 owner）按需现算的轨来渲染。
 */
export function useDerivedStoryboardTracks(ctx: CanvasNodeContext, refreshKey?: unknown) {
    const read = (ctx.production as { getStoryboardTrack?: (input: { nodeId?: string }) => Promise<DerivedStoryboardTracks> } | undefined)?.getStoryboardTrack;
    const [state, setState] = useState<DerivedStoryboardTracks | undefined>(undefined);
    const seq = useRef(0);
    const reload = useCallback(() => {
        if (!read) return;
        const current = ++seq.current;
        void read({ nodeId: ctx.node.id }).then(result => {
            if (current !== seq.current) return;
            setState({ revision: Number(result?.revision || 0), tracks: result?.tracks || {} });
        }).catch(() => { /* 派生读失败时保留画布现值，不阻塞面板 */ });
    }, [read, ctx.node.id]);
    useEffect(() => { reload(); }, [reload, refreshKey]);
    useEffect(() => {
        if (!read || typeof window === "undefined") return;
        const onFocus = () => reload();
        window.addEventListener("focus", onFocus);
        const onProduction = (event: Event) => {
            const detail = (event as CustomEvent<{ canvasId?: string }>).detail;
            if (!detail?.canvasId || detail.canvasId === ctx.projectId) reload();
        };
        window.addEventListener("drama-production:refresh-storyboard-track", onProduction);
        return () => { window.removeEventListener("focus", onFocus); window.removeEventListener("drama-production:refresh-storyboard-track", onProduction); };
    }, [read, reload, ctx.projectId]);
    return { tracks: state?.tracks || {}, revision: state?.revision, reload };
}

/** 把派生轨套到显示用的 Segment 上；没有派生的段原样返回。 */
export function withDerivedStoryboardTrack(segment: H3Segment, tracks: Record<string, DerivedStoryboardTrack>): H3Segment {
    const track = tracks[String(segment.id || "")];
    if (!track) return segment;
    return {
        ...segment,
        storyboardModeEnabled: true,
        storyboardShots: track.storyboardShots as H3Segment["storyboardShots"],
        referenceBindings: track.referenceBindings as H3Segment["referenceBindings"],
        duration: Number(track.duration || segment.duration || 0),
    };
}

export function useDisplaySegments(ctx: CanvasNodeContext, segments: H3Segment[], refreshKey?: unknown) {
    const { tracks, revision, reload } = useDerivedStoryboardTracks(ctx, refreshKey);
    const display = useMemo(() => segments.map(segment => withDerivedStoryboardTrack(segment, tracks)), [segments, tracks]);
    return { display, revision, reload };
}
