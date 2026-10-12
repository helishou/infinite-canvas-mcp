import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const overview = source.slice(source.indexOf("  const renderOverview ="), source.indexOf("  const renderStoryWorkspace"));

test("overview places progress, stage entry points and current issues ahead of media and notes", () => {
  const markers = ["data-overview-progress", "data-overview-workspaces", "data-overview-attention", "data-overview-media-summary", 'id="director-current-brief"'];
  const positions = markers.map(marker => overview.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(overview, /lg:grid-cols-2/);
  assert.match(overview, /h-24 w-40/);
});

test("compact issue summaries preserve every target, live warnings and recovery actions", () => {
  assert.match(overview, /item\.status !== "complete" \|\| Boolean\(item\.warnings\?\.length\)/);
  assert.match(overview, /attentionTargets\.slice\(0, 3\)\.map\(renderAttentionTarget\)/);
  assert.match(overview, /attentionTargets\.slice\(3\)\.map\(renderAttentionTarget\)/);
  assert.doesNotMatch(overview, /slice\(0, 8\)/);
  for (const action of ["openManualTarget(item)", 'onLocateTarget("segment", item.targetId)', "onAnswerDecision(decision.id", "onBrief(briefDraft)", "renderOverviewPreview()", "<SceneProductionPanel"]) assert.ok(overview.includes(action), action);
  assert.match(overview, /item\.blockers\[0\] \|\| item\.warnings\?\.\[0\]/);
  assert.match(overview, /controls playsInline preload="metadata"/);
  assert.match(overview, /overviewInputOutdated/);
});

test("starting without a draft opens creative notes before scrolling to them", () => {
  assert.match(overview, /brief\.open = true; brief\.scrollIntoView/);
  assert.match(overview, /brief\.querySelector<HTMLTextAreaElement>\("textarea"\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(overview, /open=\{!d \? true : undefined\}/);
});
