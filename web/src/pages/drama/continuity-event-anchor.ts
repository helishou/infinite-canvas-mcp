type Row = Record<string, any>;

export function continuityEventFrame(event: Row, shots: Row[]) {
    const shot = shots.find(item => item.id === event.shot_id);
    return Number.isInteger(event.local_frame) && shot ? Number(shot.start_frame) + Number(event.local_frame) : Number(event.frame);
}

/** Reads the registered timeline at an event's position; later events are never its before-state. */
export function continuityEventAnchor(ledger: Row, shots: Row[], shotId: string, factId: string, frame: number, local: boolean) {
    const shot = shots.find(item => item.id === shotId);
    if (!shot || !Number.isInteger(frame)) throw new Error("INVALID_EVENT_FRAME");
    const duration = Number(shot.duration_frames ?? Number(shot.end_frame) - Number(shot.start_frame));
    const offset = local ? frame : frame - Number(shot.start_frame);
    if (!Number.isInteger(offset) || offset < 0 || offset >= duration) throw new Error("INVALID_EVENT_FRAME");
    const globalFrame = Number(shot.start_frame) + offset;
    const events: Row[] = (ledger.events || []).filter((item: Row) => item.timeline_id === shot.timeline_id && item.fact_id === factId);
    if (events.some(event => continuityEventFrame(event, shots) === globalFrame)) throw new Error("EVENT_ANCHOR_OCCUPIED");
    const previous = events.filter(event => continuityEventFrame(event, shots) < globalFrame)
        .sort((a, b) => continuityEventFrame(a, shots) - continuityEventFrame(b, shots)).at(-1);
    const before = previous?.after ?? (ledger.initial || []).find((item: Row) => item.timeline_id === shot.timeline_id && item.fact_id === factId)?.value;
    if (typeof before !== "string" || before === "unknown") throw new Error("EVENT_INITIAL_STATE_MISSING");
    return { before, globalFrame, anchor: local ? { local_frame: offset } : { frame: globalFrame } };
}
