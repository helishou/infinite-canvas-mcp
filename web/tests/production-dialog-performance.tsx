import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { App, Button, ConfigProvider, Drawer } from "antd";
import "../src/styles/globals.css";

// 制作台抽屉性能测量页：全部请求由 window.fetch 模拟，不连接真实 Backend，也不写任何用户数据。
// 用法见 production-dialog-performance.mjs；?memo=0 复现修改前会随父组件重渲染整棵制作台的写法。
const params = new URLSearchParams(location.search);
const scale = Math.max(1, Number(params.get("scale") || 1));
const workspace = params.get("workspace") || "overview";
const episodeId = "perf-episode", dramaId = "perf-drama", canvasId = "perf-canvas";
const owner = { kind: "episode" as const, id: episodeId };
const sceneCount = Math.round(8 * scale), shotCount = Math.round(48 * scale), segmentCount = Math.round(16 * scale), assetCount = Math.round(24 * scale);
const scenes = Array.from({ length: sceneCount }, (_, index) => ({ id: `SCENE_${index}`, scene_id: `SCENE_${index}`, title: `场次 ${index + 1}`, heading: `内景 · 场次 ${index + 1}`, text: `场次 ${index + 1} 的剧本正文，用于测量制作台概览渲染成本。` }));
const shots = Array.from({ length: shotCount }, (_, index) => ({ id: `SHOT_${index}`, source_scene_id: scenes[index % scenes.length].id, story_order: index, timeline_id: "T1", duration_frames: 96, title: `镜头 ${index + 1}`, visual: `镜头 ${index + 1} 的画面描述，包含人物动作与镜头运动。`, camera: { framing: "CU", path: "推", attention_subject_ids: [], editorial_reason: "展示反应" }, subject_usages: [{ subjectId: "SUBJECT_CHAR_A", provides: ["identity"], retain: ["身份"] }], keyframes: [], utterance_refs: [] }));
const segments = Array.from({ length: segmentCount }, (_, index) => ({ id: `CLIP_${index}`, shot_ids: shots.filter((_, shotIndex) => shotIndex % segmentCount === index).map(shot => shot.id), mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "参考生成", summary: `Clip ${index + 1} 的衔接摘要` }));
const assets = Array.from({ length: assetCount }, (_, index) => ({ asset_id: `ASSET_${index}`, asset_name: `资产 ${index + 1}`, description: `资产 ${index + 1} 的视觉说明`, role: index % 4 === 0 ? "STYLE_MOTHER" : "CHARACTER", entity_id: `ENTITY_${index}`, canvas_scope: "episode" }));
const source = {
    brief: "性能测量用分集：全部数据为本地模拟。", fps_num: 24, fps_den: 1,
    prompt_assembly: { version: 2 }, script_scenes: scenes, shots, segments, asset_plan: assets,
    subject_registry: [{ id: "SUBJECT_CHAR_A", kind: "character", display_name: "主角", name: "主角" }],
    character_registry: [{ id: "CHAR_A", name: "主角" }], scene_registry: [{ id: "ENV_A", name: "主场景" }],
    ledger: { contract_version: 2, facts: [], timelines: [{ id: "T1" }], initial: [], events: [], requirements: [], coverage: [] },
    shot_inputs: {}, style_lock: {},
};
const keyframes: Record<string, any> = Object.fromEntries(shots.map(shot => [shot.id, { storageKey: `perf/keyframe-${shot.id}.png`, prompt: `关键帧 ${shot.id}` }]));
const production = {
    episodeId, revision: 12, publishedVersion: 0, published: null, updatedAt: new Date().toISOString(), clipRefreshes: [],
    draft: {
        scenes: [], shots: [], keyframes, keyframeReviews: {}, clipGroups: [], legacyImports: [],
        settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, imageModelsByKind: {}, h3Models: {}, parallelScenes: true, reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" } },
        director: { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, sourceHash: "b".repeat(64), source, modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {} },
    },
} as unknown as Record<string, any>;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
window.fetch = async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const path = url.pathname;
    if (path.endsWith(`/drama/episodes/${episodeId}`)) return response({ ok: true, episode: { id: episodeId, dramaId, canvasId, title: "性能测量分集", episodeNumber: 1 } });
    if (path.endsWith("/production-context")) return response({ ok: true, context: { role: "episode", canvasId, episodeId, dramaId, owner, sharedAssetCanvasId: null } });
    if (path.endsWith("/production/readiness")) return response({ ok: true, readiness: { revision: 12, publishedVersion: 0, source: "draft", canvasRevision: 3, targets: [], modules: {}, unresolved: [], nextAction: "准备完成" } });
    if (path.endsWith("/production/batches")) return response({ ok: true, runs: [] });
    if (path.endsWith("/production/versions")) return response({ ok: true, versions: [] });
    if (path.endsWith("/production/continuity")) return response({ ok: true, continuity: { status: "missing", items: [], total: 0, nextCursor: null, diagnostics: { total: 0, blocked: 0, unresolved: 0 } } });
    if (path.endsWith("/production/scene-work")) return response({ ok: true, state: { revision: 12, works: [], shared: null } });
    if (path.endsWith("/scene-archives")) return response({ ok: true, archives: [] });
    if (path.endsWith("/shared-assets")) return response({ ok: true, assets: [], versions: [] });
    if (path.includes("/operations/")) return response({ ok: true, found: false });
    if (path.endsWith("/prepare-targets")) return response({ ok: true, production, mediaSubmitted: false });
    if (path.endsWith(`/drama/episodes/${episodeId}/production`)) return response({ ok: true, production });
    if (path.endsWith("/tasks") || path.endsWith("/canvas/tasks")) return response({ ok: true, tasks: [] });
    if (path.includes("/canvas/projects/")) return response({ ok: true, project: { id: canvasId, title: "性能测量画布", nodes: [], connections: [], revision: 3 } });
    if (path.endsWith("/episodes")) return response({ ok: true, dramaId, episodes: [{ id: episodeId, dramaId, canvasId, title: "性能测量分集", episodeNumber: 1 }] });
    return response({ ok: true, settings: {}, tasks: [], models: [], workflows: [], pending: [], updates: [] });
};
window.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource;

async function mount() {
    const { ProductionEditor } = await import("../src/pages/drama/production");
    function Harness() {
        const [open, setOpen] = useState(false);
        // ?tick=1：每 60ms 触发一次父组件重渲染，模拟 Agent 流式输出期间的高频更新。
        const [, tick] = useState(0);
        React.useEffect(() => {
            if (params.get("tick") !== "1") return;
            const timer = setInterval(() => tick(value => value + 1), 60);
            return () => clearInterval(timer);
        }, []);
        // ?memo=0 复现修改前写法：父组件每次渲染都会重建制作台元素。
        const memo = params.get("memo") === "1";
        const content = <div id="production-perf-content" data-canvas-shortcuts-ignore data-canvas-no-zoom>
            {params.get("control") === "1" ? <div data-production-dialog="true">对照：仅挂载抽屉外壳，不渲染制作台</div>
                : <React.Suspense fallback={null}><ProductionEditor key={`episode:${episodeId}`} owner={owner} embedded dialog /></React.Suspense>}
        </div>;
        const stableContent = React.useMemo(() => content, []);
        return <ConfigProvider><App><MemoryRouter initialEntries={[`/test?workspace=${workspace}`]}>
            <div style={{ padding: 12 }}>
                <Button data-perf-action="open" onClick={() => setOpen(true)}>打开制作台</Button>
                <Button data-perf-action="close" onClick={() => setOpen(false)}>关闭</Button>
            </div>
            <Drawer rootClassName="canvas-blocking-overlay" open={open} forceRender title={<span>制作台</span>} onClose={() => setOpen(false)} placement="right" size="min(1120px, calc(100vw - 24px))" styles={{ body: { overflow: "auto", padding: 16 } }}>
                {memo ? stableContent : content}
            </Drawer>
        </MemoryRouter></App></ConfigProvider>;
    }
    createRoot(document.getElementById("root")!).render(<Harness />);
}
void mount();
