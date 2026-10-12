import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const director = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
const manage = readFileSync(new URL("./manage-panel.tsx", import.meta.url), "utf8");

test("all asset lists share normalized search and its clear affordance", () => {
  assert.match(director, /<Input allowClear[^>]*prefix=\{<Search/);
  assert.match(director, /matchesAssetSearch\(subjectDisplayName/);
  assert.match(director, /matchesAssetSearch\(item\.name, assetSearch\)/);
  assert.match(director, /matchesAssetSearch\(assetName\(id\), assetSearch\)/);
  assert.doesNotMatch(director, /includes\(assetSearch\./);
});

test("episodes without a legacy canvas remain visibly actionable", () => {
  const card = manage.slice(manage.indexOf("function EpisodeCard"), manage.indexOf("function formatBytes"));
  assert.doesNotMatch(card, /opacity-70|canOpen|onOpen/);
  assert.match(card, /min-h-48 min-w-0/);
  assert.match(card, /flex flex-wrap items-start/);
  assert.match(card, /title=\{episode\.title\}/);
  assert.equal((card.match(/onClick=\{onProduce\}/g) || []).length, 3);
  assert.match(card, /line-clamp-3 whitespace-pre-line break-words/);
});

test("long scene titles and shot prose wrap within their content columns", () => {
  assert.match(director, /block break-words text-sm font-medium">\{sceneTitle\(group, index\)/);
  assert.match(director, /break-words text-xl font-semibold">\{sceneTitle\(activeScene/);
  assert.match(director, /whitespace-pre-wrap break-words text-sm leading-7">\{values\[field\]/);
});


test("zero-match searches have one actionable empty state per asset renderer", () => {
  const assets = director.slice(director.indexOf("  const renderAssets ="), director.indexOf("  const renderShotKeyframe ="));
  assert.equal((assets.match(/director\.studio\.emptySearch/g) || []).length, 2);
  assert.equal((assets.match(/director\.atomic\.clearFilters/g) || []).length, 2);
  assert.doesNotMatch(assets, /allAssetIds\.some|!orderedAssetIds\.length && <p/);
  assert.match(assets, /if \(!orderedAssetIds\.length\) return <div className="production-empty-state"/);
  assert.match(assets, /director\.atomic\.noRegisteredSubjects/);
  assert.match(assets, /onClick=\{\(\) => setNewSubjectOpen\(true\)\}/);
  assert.match(assets, /director\.crud\.addManualAsset/);
});

test("legacy keyframe cards expose binding for registered assets even before media exists", () => {
  const frame = director.slice(director.indexOf("  const renderShotKeyframe ="), director.indexOf("  const renderShotDetails ="));
  assert.match(frame, /keyframeBindingState\(assetId, media\?\.nodeId, storageKey/);
  assert.match(frame, /if \(!storageKey && !binding\.registered\) return null/);
  assert.match(frame, /data-keyframe-binding/);
  assert.match(frame, /value=\{binding\.selectedNodeId\}/);
  assert.match(frame, /binding\.unavailableNode/);
  assert.match(director, /options\.binding !== false/);
});


test("populated story fields retain visible and accessible labels", () => {
  const story = director.slice(director.indexOf("  const renderStoryWorkspace ="), director.indexOf("  const visibleSubjects ="));
  for (const key of ["sceneName", "scriptText"]) {
    assert.ok(story.includes(`<span className="text-xs text-muted-foreground">{t("director.workspace.${key}")}</span><SourceField ariaLabel={t("director.workspace.${key}")}`));
  }
  assert.match(director, /<Input.TextArea aria-label=\{ariaLabel\}/);
  assert.match(director, /<Input aria-label=\{ariaLabel\}/);
});

test("discuss-scene action leads the footer away from the floating Director corner", () => {
  const footer = director.split("\n").find(line => line.includes("data-story-scene-footer")) || "";
  assert.match(footer, /data-story-scene-footer><Button/);
  assert.doesNotMatch(footer, /justify-between|justify-end/);
  assert.match(footer, /flex flex-wrap items-center gap-x-3 gap-y-2/);
  assert.ok(footer.indexOf("director.studio.reviseScene") < footer.indexOf("director.studio.autosaveHint"));
});


test("director panel JSX remains syntactically complete after label wrappers", () => {
  const result = ts.transpileModule(director, { fileName: "director-panel.tsx", compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  assert.deepEqual((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).map(item => ts.flattenDiagnosticMessageText(item.messageText, " ")), []);
});
