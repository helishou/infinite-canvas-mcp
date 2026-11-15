import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const production = panel.slice(panel.indexOf("  const renderProduction ="), panel.indexOf("  const renderAdvanced ="));
const exporter = readFileSync(new URL("../../lib/acheng-delivery-export.ts", import.meta.url), "utf8");
const productionPage = readFileSync(new URL("./production.tsx", import.meta.url), "utf8");

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

test("run settings live in the settings workspace; input preparation keeps only actions and an entry link", () => {
  const advanced = panel.slice(panel.indexOf("  const renderAdvanced ="));
  assert.match(advanced, /\{ id: "settings", label: t\("director\.workspace\.productionSettingsTitle"\) \}/);
  assert.match(advanced, /data-production-section="settings"/);
  assert.match(advanced, /renderRunSettings\(\)/);
  // 设置只有一份权威编辑源，不能同时留在「准备与更新输入」里。
  assert.doesNotMatch(production, /data-production-spec-settings/);
  assert.doesNotMatch(production, /director\.micro\.runParameters/);
  assert.match(production, /openProductionSettings/);
  assert.match(production, /director\.workspace\.validateCompile/);
  assert.match(production, /drama\.production\.directorPublish/);
});

test("subtitle calibration is wired from the delivery section into the exported bundle", () => {
  assert.match(production, /<SubtitleCalibrationPanel/);
  assert.match(production, /onCalibrateSubtitles/);
  assert.match(panel, /data-subtitle-calibration/);
  assert.match(panel, /calibrateSubtitlesHint/);
  assert.match(productionPage, /runSubtitleTranscribe/);
  assert.match(productionPage, /calibrateSubtitleTracks\(/);
  assert.match(productionPage, /writeSubtitleCalibration\(/);
  assert.match(productionPage, /onCalibrateSubtitles=/);
  assert.match(productionPage, /calibration \}/);
  assert.match(exporter, /subtitles\/calibrated\//);
  assert.match(exporter, /options\.calibration\?\.version === 1 && options\.calibration\.sourceHash === director\.sourceHash/);
});

test("focused Clip generation remains available outside the removed chooser", () => {
  assert.match(panel, /const canGenerate = target\?\.status === "ready" && mode !== "prompt_only"/);
  assert.match(panel, /onStart\(\[target!\.id\]\)/);
});
