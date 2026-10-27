import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./production.tsx", import.meta.url), "utf8");
const production = panel.slice(panel.indexOf("  const renderProduction ="), panel.indexOf("  const renderAdvanced ="));

test("archiving is offered only for episode-owned productions", () => {
  assert.match(production, /\{canvasRole === "episode" && onArchive && <section[^>]*data-production-archive>/);
  assert.match(page, /onArchive=\{productionOwner\.kind === "episode" \? archiveProduction : undefined\}/);
});

test("an archived production renders read-only and keeps the unarchive control usable", () => {
  assert.match(page, /const readOnly = Boolean\(production\.archivedAt\);/);
  assert.match(page, /busy=\{busy \|\| readOnly\} readOnly=\{readOnly\}/);
  assert.match(production, /data-production-archive-toggle checked=\{readOnly\} loading=\{archivePending\} disabled=\{busy && !readOnly\}/);
  assert.match(production, /\{readOnly && <Alert[^>]*message=\{t\("director\.workspace\.archive\.notice"\)\}/);
  assert.match(panel, /disabled=\{!d \|\| readOnly\}/);
});

test("toggling archive submits only set_archived so it neither recompiles nor reprojects", () => {
  assert.match(page, /const archiveProduction = \(archived: boolean\) => edit\(\[\{ type: "set_archived", archived \}\]\);/);
});
