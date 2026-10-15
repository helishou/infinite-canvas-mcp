import type { ContinuityChangeInput } from './continuity-event-draft';
import type { ContinuityRow, visibleContinuityTrack } from './continuity-timeline-model';

type VisibleTrack = Pick<ReturnType<typeof visibleContinuityTrack>, "duration" | "segments"> & { markers: Array<{ frame: number; event: ContinuityRow }> };

/** Pointer positions address real half-open visible spans; gaps never create a state. */
export function continuityTrackPoint(view: VisibleTrack, position?: number) {
    if (!Number.isInteger(view.duration) || view.duration < 1 || position !== undefined && !Number.isFinite(position)) return;
    const frame = position === undefined ? view.segments[0]?.start : Math.min(view.duration - 1, Math.max(0, Math.floor(position * view.duration)));
    const segment = view.segments.find(segment => frame >= segment.start && frame < segment.end);
    if (!segment) return;
    return { frame, value: segment.value, eventId: view.markers.find(marker => marker.frame === frame)?.event.id as string | undefined };
}

/** The explicit + action finds a free visible frame without crossing presence gaps. */
export function continuityTrackInsertFrame(view: VisibleTrack) {
    const occupied = new Set(view.markers.map(marker => marker.frame));
    for (const segment of view.segments) {
        let frame = segment.start;
        while (frame < segment.end && occupied.has(frame)) frame++;
        if (frame < segment.end) return frame;
    }
}

/** The row-level add action targets the first visible Shot that still has a free change frame. */
export function continuityRowInsertTarget(candidates: Array<{ shotId: string; view: VisibleTrack }>): { shotId: string; frame: number } | undefined {
    for (const candidate of candidates) {
        const frame = continuityTrackInsertFrame(candidate.view);
        if (frame !== undefined) return { shotId: candidate.shotId, frame };
    }
}

/** Shot-local time reads as seconds for people; exact frames stay next to it. */
export function continuitySecondLabel(frame: number, fps: number) {
    const safe = Number.isFinite(fps) && fps > 0 ? fps : 24;
    return (frame / safe).toFixed(1);
}

/** A retained draft disables its original track, so return to its visible resume action first. */
export function continuityInlineReturnFocus(trigger: HTMLElement | null, root: HTMLElement | null) {
    if (trigger?.isConnected && !trigger.matches(':disabled') && trigger.getClientRects().length) return trigger;
    return root?.querySelector<HTMLElement>('[data-continuity-resume]:not(:disabled)')
        || root?.querySelector<HTMLElement>('[data-continuity-track]:not(:disabled)');
}

/** Explain existing form requirements without introducing another validation gate. */
export function continuityChangeInputHint(input: ContinuityChangeInput | undefined, frameError: string): { key: string; count?: number; text?: string } | undefined {
    if (!input) return;
    if (frameError) return { key: 'frameRange', text: frameError };
    if (!input.after) return { key: 'hintChooseAfter' };
}

/** Focus follows explicit form transitions, never ordinary field rerenders. */
export function continuityDraftFocusTarget(wasDraft: boolean, isDraft: boolean, confirmed: boolean) {
    if (!wasDraft && isDraft) return '[data-continuity-frame-slider]';
    if (wasDraft && !isDraft) return confirmed ? '[data-continuity-save-action]' : '[data-continuity-add-here]';
    return undefined;
}
