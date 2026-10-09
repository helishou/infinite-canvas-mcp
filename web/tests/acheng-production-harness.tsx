import React, { useState } from "react";
import { App, ConfigProvider } from "antd";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { directorModules, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { EpisodeProduction, ProductionBatch, ProductionContinuity, ProductionReadiness } from "../src/services/backend-api";
import { DirectorPanel, type DirectorWorkspace } from "../src/pages/drama/director-panel";
import { exportAchengDeliveryBundle } from "../src/lib/acheng-delivery-export";
import i18n from "../src/i18n";
import { getAntThemeConfig } from "../src/lib/app-theme";
import "../src/styles/globals.css";

const hash = "a".repeat(64);
const imagePrompt = "A restrained blue-gray dock at dawn, persistent mist, polished graphic-novel texture.";
const h3Prompt = "integrated_multimodal_description:\n[Picture 1] Dockside at dawn, a lone courier checks the sealed letter and listens for approaching footsteps.\n\noverall_soundscape:\nWind over water; a bell rings in the distance.\n\nnon_diegetic_music:\nNone.\n";
const source = {
  brief: "一封未拆开的信改变了码头上的交易。",
  fps_num: 24, fps_den: 1,
  script_scenes: [{ id: "line1", scene_id: "scene1", scene_name: "旧码头", text: "信使：你确定要把它交给我？\n守门人：我只答应把信带到。", blocks: [{ id: "B01", kind: "action", text: "信使仍穿蓝色外套。" }] }],
  character_registry: [{ id: "C_MESSENGER", name: "信使" }],
  scene_registry: [{ id: "scene1", name: "旧码头" }],
  ledger: { contract_version: 2, facts: [{ id: "F_COAT", object_kind: "character", object_id: "C_MESSENGER", allowed_values: ["blue", "red"] }], timelines: [{ id: "main" }], initial: [{ timeline_id: "main", fact_id: "F_COAT", value: "blue" }], events: [], requirements: [{ id: "R1", timeline_id: "main", shot_id: "s1", fact_id: "F_COAT", kind: "hold", value: "blue" }, { id: "R2", timeline_id: "main", shot_id: "s2", fact_id: "F_COAT", kind: "hold", value: "blue" }], coverage: [] },
  asset_plan: [{ id: "STYLE_MOTHER", kind: "style", name: "STYLE_MOTHER · 码头晨雾", description: "低饱和蓝灰和薄雾，纸面质感克制。", depends_on: [] }, { id: "KF1", kind: "keyframe", name: "镜头 s1 关键帧", description: "信使确认封口，守门人保持警觉。", depends_on: ["STYLE_MOTHER"] }],
  style_lock: { anchor_asset_id: "STYLE_MOTHER" },
  shots: [
    { id: "s1", scene_id: "scene1", timeline_id: "main", story_order: 0, continuity_facts: ["F_COAT"], title: "信使确认封口", start_frame: 0, end_frame: 120, visual: "信使拇指压住封蜡，目光先看信，再抬向守门人。", camera: { description: "胸像近景，缓慢推近" }, state_in: "信件仍未拆封", state_out: "信使确认封口无破损", characters: [{ id: "C_MESSENGER" }], dialogues: [{ speaker: "信使", text: "你确定要把它交给我？" }], audio: {} },
    { id: "s2", scene_id: "scene1", timeline_id: "main", story_order: 1, continuity_facts: ["F_COAT"], title: "守门人不松手", start_frame: 120, end_frame: 240, visual: "守门人没有放开信封，观察信使的眼神。", camera: { description: "过肩中近景" }, state_in: "守门人握着信封", state_out: "守门人仍扣住信封一角", characters: [{ id: "C_MESSENGER" }], dialogues: [{ speaker: "守门人", text: "我只答应把信带到。" }], audio: {} },
  ],
  segments: [
    { id: "SEG1", shot_ids: ["s1"], start_frame: 0, end_frame: 120, generation_clip_duration: 5, mode: "Ref2VA", execution_gate: "Reconfirm references and sound after regrouping" },
    { id: "SEG2", shot_ids: ["s2"], start_frame: 120, end_frame: 240, generation_clip_duration: 5, mode: "Ref2VA" },
  ],
};
const clipScenario = new URLSearchParams(window.location.search).get("scenario");
if (clipScenario === "single") source.segments = source.segments.slice(0, 1);
if (clipScenario === "middle") {
  source.shots.push({ ...source.shots[1], id: "s3", title: "信使接过信封", start_frame: 240, end_frame: 360 });
  source.segments.push({ ...source.segments[1], id: "SEG3", shot_ids: ["s3"], start_frame: 240, end_frame: 360 });
}
const initial: DirectorProduction = {
  schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "canvas-1", runtimeId: "test-runtime", version: "4.3.9" },
  source, sourceHash: hash,
  modules: Object.fromEntries(directorModules.map(module => [module, { status: module === "story" ? "committed" : "partial", evidence: [], unresolved: [] }])),
  assets: {
    STYLE_MOTHER: { nodeId: "image-style", storageKey: "style-mock", sha256: hash, version: "v1", status: "approved", evidence: "Existing approval retained for shared-promotion preview." },
    KF1: { nodeId: "image-frame", storageKey: "frame-mock", sha256: hash, version: "v1", status: "generated", evidence: "" },
  },
  shotInputs: { s1: { keyframePolicy: "new", assetIds: ["STYLE_MOTHER"], keyframeAssetId: "KF1" }, s2: { keyframePolicy: "none", assetIds: ["STYLE_MOTHER"] } },
  boundaries: [{ from: "SEG1", to: "SEG2", tailFrame: false, motionContext: false, reason: "同一动作跨机位，尾帧状态保持，潜空间从新段开始。" }],
  artifacts: [
    { id: "image-STYLE_MOTHER", kind: "image", targetId: "STYLE_MOTHER", prompt: imagePrompt, sha256: hash, sourceHash: hash, status: "ready", references: [], receipt: { sourceHash: hash, promptHash: hash, engineRuntimeId: "test-runtime", validator: "test" } },
    { id: "image-KF1", kind: "image", targetId: "KF1", prompt: "封蜡、拇指与信使紧张目光的三角关系。", sha256: hash, sourceHash: hash, status: "ready", references: [], receipt: { sourceHash: hash, promptHash: hash, engineRuntimeId: "test-runtime", validator: "test" } },
    ...["SEG1", "SEG2"].map(id => ({ id: `h3-${id}`, kind: "h3" as const, targetId: id, prompt: h3Prompt, sha256: hash, sourceHash: hash, status: "ready" as const, references: [
      { label: "<Picture 1>", nodeId: "image-style", storageKey: "style-mock", sha256: hash, role: "STYLE_MOTHER" },
      { label: "<Video 1>", nodeId: "video-ref", storageKey: "video-reference", sha256: hash, role: "motion-reference" },
      { label: "<Audio 1>", nodeId: "audio-ref", storageKey: "audio-reference", sha256: hash, role: "voice-reference" },
    ], receipt: { sourceHash: hash, promptHash: hash, engineRuntimeId: "test-runtime", validator: "test" } })),
  ],
  executionAuthorized: false, unresolved: [], workflow: { contentDeliveryMode: "auto_file_batch", mediaProductionMode: "per_item" },
};
const data: EpisodeProduction["draft"] = {
  director: initial, scenes: [], shots: [], keyframes: { s1: { nodeId: "image-frame", storageKey: "frame-mock", sourceVersion: 1 } },
  keyframeReviews: {}, clipGroups: [
    { id: "SEG1", shotIds: ["s1"], nodeId: "h3-node", segmentId: "segment-1", sourceVersion: 1 },
    { id: "SEG2", shotIds: ["s2"], nodeId: "h3-node", segmentId: "segment-2", sourceVersion: 1 },
  ], settings: { mode: "manual", imageModel: "test-image", h3Model: "test-h3", imageModels: {}, h3Models: {} }, legacyImports: [],
};
const initialProduction: EpisodeProduction = { episodeId: "fixture", revision: 4, draft: data, published: structuredClone(data), publishedVersion: 1, updatedAt: new Date().toISOString() };
const initialReadiness: ProductionReadiness = {
  revision: 4, publishedVersion: 1, source: "draft", modules: {}, unresolved: [], nextAction: "待审核：信使确认封口 · 关键帧",
  targets: [
    { id: "asset:STYLE_MOTHER", targetId: "STYLE_MOTHER", kind: "asset", title: "STYLE_MOTHER · 码头晨雾", status: "complete", blockers: [] },
    { id: "frame:s1", targetId: "s1", kind: "keyframe", title: "信使确认封口", status: "needs_review", blockers: ["关键帧等待审核"] },
    { id: "segment:SEG1", targetId: "SEG1", kind: "segment", title: "SEG1", status: "blocked", blockers: ["CONTINUITY_COVERAGE_MISSING：剧本块 B01 尚无覆盖证据。"], executionTargets: ["segment:SEG1", "segment:SEG2"] },
    { id: "segment:SEG2", targetId: "SEG2", kind: "segment", title: "SEG2", status: "blocked", blockers: ["CONTINUITY_COVERAGE_MISSING：剧本块 B01 尚无覆盖证据。"] },
  ],
};

if (clipScenario === "ready") initialReadiness.targets = initialReadiness.targets.map(target => target.id === "segment:SEG1" ? { ...target, status: "ready", blockers: [] } : target);

function Harness() {
  const [director, setDirector] = useState(initial), [production, setProduction] = useState(initialProduction), [readiness, setReadiness] = useState(initialReadiness);
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({});
  const initialTarget = new URLSearchParams(window.location.search).get("clip");
  const [focusTarget, setFocusTarget] = useState<string | undefined>(initialTarget ? `segment:${initialTarget}` : undefined);
  const [dark, setDark] = useState(false), [locale, setLocale] = useState("zh-CN"), [workspace, setWorkspace] = useState<DirectorWorkspace>(initialTarget ? "production" : "overview");
  const [saves, setSaves] = useState(0), [published, setPublished] = useState(0), [asks, setAsks] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [continuityReport, setContinuityReport] = useState<ProductionContinuity>({ owner: { kind: "episode", id: "fixture" }, snapshot: "draft", revision: 4, publishedVersion: 1, sourceHash: hash, status: "blocked", coverageStatus: "incomplete", semanticDiscovery: "not_performed", checkedAt: new Date().toISOString(), diagnostics: { total: 1, blocked: 1, unresolved: 1 }, items: [], total: 1, nextCursor: null, report: { status: "blocked", coverageStatus: "incomplete", semanticDiscovery: "not_performed", selectedTargets: ["SEG1", "SEG2"], diagnostics: [{ code: "CONTINUITY_COVERAGE_MISSING", path: "source.script_scenes.line1.blocks.B01", targetId: "s1", affectedTargets: ["SEG1", "SEG2"], severity: "error", message: "剧本块 B01 尚无连续性覆盖证据" }], trajectories: { s1: { timelineId: "main", storyOrder: 0, start: { F_COAT: "blue" }, end: { F_COAT: "blue" } }, s2: { timelineId: "main", storyOrder: 1, start: { F_COAT: "blue" }, end: { F_COAT: "blue" } } } } });
  const updateDirector = (next: DirectorProduction) => { setDirector(next); setProduction(current => ({ ...current, revision: current.revision + 1, draft: { ...current.draft, director: next } })); setSaves(n => n + 1); };
  const patch = (entity: "style" | "scene" | "asset" | "shot" | "segment", id: string | undefined, fields: Record<string, unknown>) => {
    if (entity === "style") {
      const nextSource = { ...director.source };
      if (fields.anchor_asset_id !== undefined) nextSource.style_lock = { ...director.source.style_lock, anchor_asset_id: fields.anchor_asset_id };
      if (fields.style_policy !== undefined) nextSource.style_policy = fields.style_policy;
      if (fields.style_policy_reason !== undefined) nextSource.style_policy_reason = fields.style_policy_reason;
      updateDirector({ ...director, source: nextSource });
      return true;
    }
    if (!id) return false;
    const key = entity === "scene" ? "script_scenes" : entity === "asset" ? "asset_plan" : entity === "shot" ? "shots" : "segments";
    const field = (item: Record<string, any>) => String(item.id || item.scene_id || item.asset_id || "");
    updateDirector({ ...director, source: { ...director.source, [key]: (director.source[key] as Array<Record<string, unknown>>).map(item => field(item as Record<string, any>) === id ? { ...item, ...fields } : item) } });
  };
  const regroup = (segmentId: string, shotIds: string[], removeSegmentIds: string[]) => {
    const next = structuredClone(director);
    const authoredShots = next.source.shots as Array<Record<string, any>>;
    const authoredSegments = next.source.segments as Array<Record<string, any>>;
    const selected = authoredShots.filter(shot => shotIds.includes(String(shot.id)));
    const target = authoredSegments.find(segment => String(segment.id) === segmentId)!;
    const start = Number(selected[0].start_frame), end = Number(selected[selected.length - 1].end_frame);
    const fps = Number(next.source.fps_num || 24) / Number(next.source.fps_den || 1);
    next.source.segments = authoredSegments.filter(segment => !removeSegmentIds.includes(String(segment.id))).map(segment => String(segment.id) === segmentId
      ? { ...target, shot_ids: selected.map(shot => String(shot.id)), start_frame: start, end_frame: end, generation_clip_duration: (end - start) / fps }
      : segment);
    next.boundaries = next.boundaries.filter(edge => edge.from !== segmentId && edge.to !== segmentId && !removeSegmentIds.includes(edge.from) && !removeSegmentIds.includes(edge.to));
    next.artifacts = next.artifacts.map(artifact => ({ ...artifact, status: "stale" }));
    next.sourceHash = "b".repeat(64); next.executionAuthorized = false;
    updateDirector(next);
    setReadiness(current => ({ ...current, targets: current.targets.map(item => item.kind === "segment" ? { ...item, status: "blocked", blockers: ["重新编组后需要重新编译"] } : item) }));
  };
  const boundaries = director.boundaries;
  const activeRun = batches[0] || null;
  const downloadBundle = async (includeGeneratedMedia: boolean) => {
    setExporting(true);
    try {
      const blob = await exportAchengDeliveryBundle({ owner: { kind: "canvas", id: "fixture" }, title: "码头晨雾", production, readiness, canvasNodes: [{ id: "image-style", title: "STYLE_MOTHER output", type: "image" }, { id: "image-frame", title: "Keyframe output", type: "image" }], includeGeneratedMedia });
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = "fixture-acheng.zip"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } finally { setExporting(false); }
  };
  return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main className={`${dark ? "dark " : ""}min-h-screen bg-background p-6 text-foreground`}>
    <div className="mb-4 flex gap-2"><button onClick={() => setDark(!dark)}>theme</button><button onClick={() => { const next = locale === "zh-CN" ? "en-US" : "zh-CN"; setLocale(next); void i18n.changeLanguage(next); }}>language</button></div>
    <button onClick={() => { setWorkspace("production"); setFocusTarget("segment:SEG1"); }}>Edit Clip style</button>
    <nav className="mb-4 flex flex-wrap gap-2">{(["overview", "story", "assets", "shots", "continuity", "production", "advanced"] as DirectorWorkspace[]).map(key => <button key={key} onClick={() => setWorkspace(key)}>{i18n.t(`director.workspace.tab.${key}`)}</button>)}</nav>
    <DirectorPanel
      workspace={workspace} focusTarget={focusTarget} compact={Boolean(focusTarget)} director={director} production={production} readiness={readiness} continuityReport={continuityReport} run={activeRun} batches={batches}
      canvasNodes={[{ id: "h3-node", type: "minimax-h3:video", metadata: { segments: [{ id: "segment-1", styleTemplateId: "soft-light" }] } }, { id: "image-style", title: "STYLE_MOTHER output", type: "image" }, { id: "image-frame", title: "Keyframe output", type: "image" }]}
      legacy={[{ source: "script.md", sha256: hash, text: "旧剧本文本：完整台词和历史事实。" }]} versions={[{ version: 1, stage: "director", createdAt: new Date(0).toISOString() }]}
      busy={false} canvasId="fixture" canvasRole="episode" onOpenSharedAsset={() => undefined} onPromoteExistingSharedAsset={() => setAsks(n => n + 1)} sourceDrafts={sourceDrafts} runStartPending={false} activeTargetIds={[...new Set(batches.filter(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status)).flatMap(item => item.targets))]}
      briefDraft={String(director.source.brief || "")} onBriefDraftChange={brief => { updateDirector({ ...director, source: { ...director.source, brief } }); }}
      onSourceDraftChange={(key, value) => setSourceDrafts(current => { if (value === undefined) { const next = { ...current }; delete next[key]; return next; } return { ...current, [key]: value }; })}
      onBrief={brief => updateDirector({ ...director, source: { ...director.source, brief } })}
      onPatch={patch} onAdoptClipStyle={async (id, styleTemplateId) => { patch("segment", id, { styleTemplateId }); return true; }} onRegroup={regroup} onWorkflow={workflow => updateDirector({ ...director, workflow: { ...director.workflow, ...workflow } })}
      onBindAsset={(assetId, nodeId) => updateDirector({ ...director, assets: { ...director.assets, [assetId]: { ...(director.assets[assetId] || { version: "v1", status: "planned" as const }), nodeId } } })}
      onBoundary={boundary => updateDirector({ ...director, boundaries: [...boundaries.filter(item => item.from !== boundary.from), boundary] })}
      onSaveContinuity={async (ledger, preview) => { if (preview) return false; updateDirector({ ...director, source: { ...director.source, ledger } }); return true; }}
      onPreviewContinuityUpgrade={async ledger => ({ revision: 4, fromSourceHash: hash, previewHash: hash, targetRuntime: { runtimeId: "test-runtime-v2", version: "4.4.0" }, report: { status: "blocked", diagnostics: [{ code: "CONTINUITY_COVERAGE_MISSING" }] }, affectedTargets: ["SEG1", "SEG2"] })}
      onCheckContinuity={async () => { const ledger = director.source.ledger as Record<string, any>; const scoped = (ledger.coverage || []).some((item: any) => item.source_anchor?.block_id === "B01" && ["s1", "s2"].every(id => item.shot_ids?.includes(id)) && item.evidence_kind === "explicit_hold"); setContinuityReport(current => ({ ...current, status: scoped ? "passed" : "blocked", coverageStatus: scoped ? "registered" : "incomplete", checkedAt: new Date().toISOString(), diagnostics: { total: scoped ? 0 : 1, blocked: scoped ? 0 : 1, unresolved: scoped ? 0 : 1 }, report: { ...current.report, status: scoped ? "passed" : "blocked", coverageStatus: scoped ? "registered" : "incomplete", diagnostics: scoped ? [] : current.report?.diagnostics || [] } })); setReadiness(current => ({ ...current, targets: current.targets.map(item => item.id.startsWith("segment:") ? { ...item, status: scoped ? "ready" : "blocked", blockers: scoped ? [] : item.blockers } : item) })); }}
      onContinuitySnapshot={snapshot => setContinuityReport(current => ({ ...current, snapshot }))}
      onReview={review => { updateDirector({ ...director, assets: { ...director.assets, [review.assetId]: { ...director.assets[review.assetId], status: review.verdict, evidence: review.evidence } } }); setReadiness(current => ({ ...current, targets: current.targets.map(item => item.id === `asset:${review.assetId}` ? { ...item, status: review.verdict === "approved" ? "complete" : "ready", blockers: [] } : item) })); }}
      onPublish={() => setPublished(n => n + 1)} onReplace={updateDirector} onAskDirector={() => setAsks(n => n + 1)} onNavigate={(workspace, target) => { setWorkspace(workspace); setFocusTarget(target ? `${target.kind}:${target.id}` : undefined); }}
      onAnswerDecision={() => true} onExport={downloadBundle} exporting={exporting}
      onStart={targets => setBatches([{ runId: "fixture-run", episodeId: "fixture", version: 1, sourceRevision: 4, idempotencyKey: "fixture-run", status: "pending", targets, plan: { changedSceneIds: [], affectedShotIds: [], imageShotIds: [], clipGroupIds: targets.map(id => id.replace("segment:", "")), missingAssetNodeIds: [] }, engine: director.engine, settings: {}, submitted: [], error: null, pauseRequested: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }])}
      onPause={runId => setBatches(current => current.map(item => item.runId === runId ? { ...item, status: "paused" } : item))}
      onResume={runId => setBatches(current => current.map(item => item.runId === runId ? { ...item, status: "pending" } : item))}
      onSceneCommand={async () => { setSaves(n => n + 1); }} onRestore={() => setSaves(n => n + 1)} onRefresh={() => setSaves(n => n + 1)}
    />
    <output aria-label="evidence">{JSON.stringify({ saves, published, asks, director, production, readiness, batches, continuityReport })}</output>
  </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><Harness /></MemoryRouter>);
