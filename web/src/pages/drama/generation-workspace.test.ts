import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const production = source.slice(source.indexOf("  const renderProduction ="), source.indexOf("  const renderAdvanced ="));

test("page leads with input preparation, one shared target workbench, then delivery", () => {
  const checks = production.indexOf('data-production-section="checks"');
  const workbench = production.indexOf("data-generation-target-workbench");
  const delivery = production.indexOf('data-production-section="delivery"');
  assert.ok(checks > -1 && checks < workbench && workbench < delivery);
  assert.doesNotMatch(production, /data-production-target-groups/);
  assert.match(source, /const productionTargetStage = /);
  assert.match(source, /data-production-status-summary/);
  assert.match(source, /attentionTargets\.length > 0 && <Tag color="orange">/);
  assert.match(production, /\{productionSummary\}/);
  assert.match(production, /<details[^>]+data-production-section="compiler"/);
  assert.doesNotMatch(production, /type="primary"[^>]+onClick=\{onPublish\}/);
  assert.match(production, /data-generation-blockers><h4/);
});

test("P1: one player per archived clip, failed compiles surface above the list, compact shares the attention model", () => {
  assert.match(production, /archive && <Button size="small" type="link"[\s\S]*?focusProductionSection\(event\.currentTarget, "delivery"\)/);
  assert.match(production, /t\("director\.generation\.viewInDelivery"\)/);
  const warning = production.indexOf('blockedArtifacts.length > 0 && <Alert type="warning"');
  const tasksOpen = production.indexOf('data-production-section="tasks"');
  assert.ok(warning > -1 && warning > tasksOpen && warning < production.indexOf("data-generation-target-workbench"));
  assert.match(source, /data-production-attention-list[\s\S]{0,200}attentionTargets\.map\(target =>/);
  assert.doesNotMatch(source, /readiness\.targets\.filter\(target => \["blocked", "needs_review"\]\.includes\(target\.status\) \|\| Boolean\(target\.warnings\?\.length\)\)\.map/);
});

test("P2: saved input diff lives in diagnostics, not in every target card", () => {
  const compiler = production.indexOf('data-production-section="compiler"');
  const debug = production.indexOf("data-production-input-debug");
  assert.ok(compiler > -1 && debug > compiler && debug < production.indexOf("</details>}\n  </div>;"));
  assert.doesNotMatch(production, /summary>\{t\("director\.workspace\.savedInput"\)<\/summary>\{inputDiff/);
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
  assert.match(source, /const productionSelection = /);
});


test("target chooser does not repeat a visible heading or show an invalid clip duration", () => {
  assert.match(production, /<h3 className="sr-only">\{t\("director.generation.chooseTarget"\)\}/);
  assert.match(production, /segmentShots.every/);
  assert.match(production, /Number.isFinite\(value\) && value > 0/);
  assert.match(production, /duration !== undefined &&/);
  assert.doesNotMatch(production, /formatSeconds\(segment.generation_clip_duration/);
});
