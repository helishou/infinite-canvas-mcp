import assert from "node:assert/strict";
import test from "node:test";
import { continuityDiagnosticLocations, frameTimecode } from "./continuity-diagnostic-context";

test("shot-scoped continuity diagnostics resolve to Clip-relative frame and time ranges", () => {
  const source = {
    fps_num: 24, fps_den: 1,
    shots: [
      { id: "SH-01", title: "开场", duration_frames: 48 },
      { id: "SH-02", title: "交手", duration_frames: 96 },
    ],
    segments: [{ id: "SEG-01", shot_ids: ["SH-01", "SH-02"] }],
  };
  const locations = continuityDiagnosticLocations(source, [
    { code: "CONTINUITY_UNRESOLVED", targetId: "SH-02", affectedTargets: ["SEG-01"], message: "转换帧未核定" },
  ]);

  assert.deepEqual(locations, [{ segmentId: "SEG-01", shotId: "SH-02", shotTitle: "交手", startFrame: 48, endFrameExclusive: 144 }]);
  assert.equal(frameTimecode(locations[0].startFrame, 24), "00:00:02.000");
  assert.equal(frameTimecode(locations[0].endFrameExclusive, 24), "00:00:06.000");
});

test("continuity diagnostics without a shot or resolvable Clip window do not invent a frame location", () => {
  const source = { shots: [{ id: "SH-01", duration_frames: 0 }], segments: [{ id: "SEG-01", shot_ids: ["SH-01"] }] };
  assert.deepEqual(continuityDiagnosticLocations(source, [
    { code: "CONTINUITY_COVERAGE_MISSING", targetId: "BLOCK-01" },
    { code: "CONTINUITY_UNRESOLVED", targetId: "SH-01", affectedTargets: ["SEG-01"] },
  ]), []);
});
