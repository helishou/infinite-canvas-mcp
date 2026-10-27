import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const production = panel.slice(panel.indexOf("  const renderProduction ="), panel.indexOf("  const renderAdvanced ="));
const exporter = readFileSync(new URL("../../lib/acheng-delivery-export.ts", import.meta.url), "utf8");

test("production page omits the generation-target chooser and keeps batch status with input preparation", () => {
  assert.doesNotMatch(production, /data-production-section="tasks"|data-generation-target-workbench|director\.generation\.chooseTarget/);
  assert.match(production, /\{ id: "checks", label: t\("director\.generation\.prepareInputs"\) \},\s*\{ id: "delivery", label: t\("director\.micro\.resultsDelivery"\) \}/);
  assert.match(production, /data-production-active-run/);
  assert.match(production, /data-production-section="checks"/);
});

test("delivery lists only locked Clips and uses each Clip's current video", () => {
  assert.match(panel, /records\(d\?\.source\?\.segments\)\.filter\(group => group\.locked === true\)/);
  assert.match(panel, /const storageKey = String\(segment\?\.resultStorageKey \|\| ""\)/);
  assert.match(production, /data-locked-clip-results/);
  assert.match(exporter, /segment\.locked === true/);
  assert.match(exporter, /const storageKey = String\(runtime\?\.resultStorageKey \|\| ""\)/);
});

test("focused Clip generation remains available outside the removed chooser", () => {
  assert.match(panel, /const canGenerate = target\?\.status === "ready" && mode !== "prompt_only"/);
  assert.match(panel, /onStart\(\[target!\.id\]\)/);
});
