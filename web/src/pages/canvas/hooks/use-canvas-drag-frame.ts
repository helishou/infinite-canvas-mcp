import { useEffect, useRef } from "react";

type FrameCallback = () => void;
type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (id: number) => void;

export function createCanvasDragFrameScheduler(
    requestFrame: RequestFrame = (callback) => window.requestAnimationFrame(callback),
    cancelFrame: CancelFrame = (id) => window.cancelAnimationFrame(id),
) {
    let frameId: number | null = null;

    return {
        schedule(callback: FrameCallback) {
            if (frameId !== null) cancelFrame(frameId);
            frameId = requestFrame(() => {
                frameId = null;
                callback();
            });
        },
        cancel() {
            if (frameId === null) return;
            cancelFrame(frameId);
            frameId = null;
        },
    };
}

export function useCanvasDragFrame() {
    const schedulerRef = useRef<ReturnType<typeof createCanvasDragFrameScheduler> | null>(null);
    if (!schedulerRef.current) schedulerRef.current = createCanvasDragFrameScheduler();
    const scheduler = schedulerRef.current;
    useEffect(() => () => scheduler.cancel(), [scheduler]);
    return scheduler;
}
