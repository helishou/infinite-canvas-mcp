type Row = Record<string, any>;

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
const textId = (value: unknown) => String(value ?? "");
const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(item => textId(item && typeof item === "object" ? (item as Row).id : item)).filter(Boolean) : [];

export type ContinuityDiagnosticLocation = {
  segmentId: string;
  shotId: string;
  shotTitle: string;
  startFrame: number;
  endFrameExclusive: number;
};

/** Resolve shot-scoped continuity diagnostics to their exact Clip-relative frame windows. */
export function continuityDiagnosticLocations(sourceValue: unknown, diagnosticValues: unknown[]): ContinuityDiagnosticLocation[] {
  const source = sourceValue && typeof sourceValue === "object" ? sourceValue as Row : {};
  const shots = rows(source.shots);
  const segments = rows(source.segments);
  const shotsById = new Map(shots.map(shot => [textId(shot.id), shot]));
  const locations = new Map<string, ContinuityDiagnosticLocation>();

  for (const value of diagnosticValues) {
    if (!value || typeof value !== "object") continue;
    const diagnostic = value as Row;
    if (!textId(diagnostic.code).startsWith("CONTINUITY_")) continue;
    const shotId = textId(diagnostic.shotId || diagnostic.targetId);
    const shot = shotsById.get(shotId);
    if (!shot) continue;
    const affected = new Set(ids(diagnostic.affectedTargets));
    const matchingSegments = segments.filter(segment => {
      const segmentId = textId(segment.id);
      return (affected.size === 0 || affected.has(segmentId))
        && ids(segment.shot_ids).includes(shotId);
    });

    for (const segment of matchingSegments) {
      let cursor = 0;
      const segmentShotIds = ids(segment.shot_ids);
      for (const id of segmentShotIds) {
        const current = shotsById.get(id);
        if (!current) continue;
        const durationFrames = Number(current.duration_frames);
        const startFrame = id === shotId ? cursor : undefined;
        const span = Number.isInteger(durationFrames) && durationFrames > 0
          ? durationFrames
          : Number.isInteger(Number(current.start_frame)) && Number.isInteger(Number(current.end_frame))
            ? Math.max(0, Number(current.end_frame) - Number(current.start_frame)) : 0;
        if (startFrame !== undefined && span > 0) {
          const location = {
            segmentId: textId(segment.id), shotId,
            shotTitle: textId(shot.title || shot.display_name || shot.id),
            startFrame, endFrameExclusive: startFrame + span,
          };
          locations.set(`${location.segmentId}\0${location.shotId}\0${location.startFrame}\0${location.endFrameExclusive}`, location);
          break;
        }
        cursor += span;
      }
    }
  }

  return [...locations.values()].sort((a, b) => a.segmentId.localeCompare(b.segmentId) || a.startFrame - b.startFrame || a.shotId.localeCompare(b.shotId));
}

export function frameTimecode(frame: number, fps: number) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 24;
  const milliseconds = Math.round(frame / safeFps * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
