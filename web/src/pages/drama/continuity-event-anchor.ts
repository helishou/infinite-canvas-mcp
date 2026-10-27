import { continuityPriorState } from "./continuity-timeline-model";
type Row = Record<string, any>;

export function continuityEventFrame(event: Row, shots: Row[]) {
    const shot = shots.find(item => item.id === event.shot_id);
    if (event.local_frame !== undefined) return Number.isInteger(event.local_frame) && shot ? Number(shot.start_frame) + Number(event.local_frame) : NaN;
    return Number.isInteger(event.frame) ? Number(event.frame) : NaN;
}

/** The workbench edits local frame numbers; legacy contracts store absolute frames. */
export function continuityEventPositionPatch(event: Row, shot: Row, localFrame: number | "", subjectAssembly: boolean) {
    if (subjectAssembly) return { local_frame: localFrame };
    return { frame: localFrame === "" ? "" : Number(shot.start_frame) + localFrame, local_frame: undefined };
}

/** Reads the registered timeline at an event's position; later events are never its before-state. */
export function continuityEventAnchor(ledger: Row, shots: Row[], shotId: string, factId: string, frame: number, local: boolean, persistLocal = local) {
    const shot = shots.find(item => item.id === shotId);
    if (!shot || !Number.isInteger(frame)) throw new Error("INVALID_EVENT_FRAME");
    const duration = Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
    const offset = local ? frame : frame - Number(shot.start_frame);
    if (!Number.isInteger(offset) || offset < 0 || offset >= duration) throw new Error("INVALID_EVENT_FRAME");
    const globalFrame = Number(shot.start_frame) + offset;
    const events: Row[] = (ledger.events || []).filter((item: Row) => item.timeline_id === shot.timeline_id && item.fact_id === factId);
    if (events.some(event => continuityEventFrame(event, shots) === globalFrame)) throw new Error("EVENT_ANCHOR_OCCUPIED");
    const before = continuityPriorState(ledger, shots, shotId, factId, offset);
    return { before, globalFrame, anchor: persistLocal ? { local_frame: offset } : { frame: globalFrame } };
}
