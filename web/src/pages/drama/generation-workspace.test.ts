import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const production = source.slice(source.indexOf("  const renderProduction ="), source.indexOf("  const renderAdvanced ="));

test("generation starts with target selection and keeps preparation secondary", () => {
  assert.ok(production.indexOf('data-generation-target-workbench') < production.indexOf('data-production-section="checks"'));
  assert.match(production, /<details[^>]+data-production-section="checks"/);
  assert.match(production, /<details[^>]+data-production-section="compiler"/);
  assert.doesNotMatch(production, /type="primary"[^>]+onClick=\{onPublish\}/);
  assert.match(production, /data-generation-blockers><h4/);
});

test("single target submission keeps precise scope and excludes prompt-only mode", () => {
  assert.match(production, /selected\.status === "ready" && !active && mode === "per_item"/);
  assert.match(production, /onStart\(\[selected\.id\]\)/);
  assert.match(production, /mode === "automatic"[\s\S]+"all_ready"/);
  assert.match(production, /onResume\(activeRun\.runId\)/);
});

test("an existing result never promotes a blocked target to complete", () => {
  assert.doesNotMatch(production, /result \? "results"/);
  assert.match(production, /targetStatus\.\$\{selected\.status\}/);
  assert.match(production, /selected\.status === "complete" \? "director.generation.currentResult" : "director.generation.previousResult"/);
  assert.ok(production.indexOf('data-generation-blockers') < production.indexOf('data-generation-existing-result'));
});

test("unknown clip blockers navigate to its actual source shot, not the same production page", () => {
  assert.match(production, /const firstShotId = segment\?\.shot_ids\?\.\[0\]/);
  assert.match(production, /id: firstShotId \? String\(firstShotId\) : selected\.targetId/);
  assert.match(production, /downloadAllDeliveredClips/);
  assert.match(production, /onExport\(includeGeneratedMedia\)/);
  assert.match(production, /inputDiff\(selected\)/);
});


test("target chooser does not repeat a visible heading or show an invalid clip duration", () => {
  assert.match(production, /<h3 className="sr-only">\{t\("director.generation.chooseTarget"\)\}/);
  assert.match(production, /segmentShots.every/);
  assert.match(production, /Number.isFinite\(value\) && value > 0/);
  assert.match(production, /duration !== undefined &&/);
  assert.doesNotMatch(production, /formatSeconds\(segment.generation_clip_duration/);
});
