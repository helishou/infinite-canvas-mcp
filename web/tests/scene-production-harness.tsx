import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import type { EpisodeProduction, SceneWorkInspection } from "../src/services/backend-api";
import i18n from "../src/i18n";
import "../src/styles/globals.css";

const hash = "a".repeat(64), policy = { mode: "manual", shared: "manual", scene: "manual" } as const;
const source = { script_scenes: ["A", "B", "C", "D"].map(id => ({ id, scene_id: id, heading: `场次 ${id}`, text: `场次 ${id} 已确认的真实叙事内容` })), shots: [], segments: [], asset_plan: [] };
const commands: unknown[] = [];
let state: SceneWorkInspection = { revision: 1, shared: { inputHash: hash, review: { sourceHash: hash, inputHash: hash, verdict: "approved", evidence: "fixture", mode: "manual", media: [], checkedAt: new Date().toISOString() } }, works: ["A", "B", "C"].map((id, index) => ({ workId: `work-${id}`, sceneId: id, sourceHash: hash, inputHash: hash, reviewInputHash: hash, inputRevision: 1, status: index === 0 ? "awaiting_review" : index === 1 ? "awaiting_media" : "succeeded", stage: index === 0 ? "review" : index === 1 ? "produce" : "complete", runIds: [], artifactIds: [], generationAuthorized: false, assetReviews: index === 0 ? [{ sourceHash: hash, inputHash: hash, mediaInputHash: hash, verdict: "approved", mode: "manual", evidence: "模拟记录：前置资产 K1 身份与风格通过，其余素材仍待审。", media: [{ targetId: "K1", storageKey: "image:fixture-k1", sha256: hash }], checkedAt: new Date().toISOString() }] : [], policy, updatedAt: new Date().toISOString(), source: { shots: [{ id: `shot-${id}`, title: `场次 ${id} 镜头`, visual: "人物放下信件，看向门外，镜头缓慢推近。" }] }, media: [] })) };
// All requests, including imported module initialization, stay inside this fixture.
window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!url.pathname.includes("/production/scene-work")) return new Response(JSON.stringify({ ok: true, settings: {}, tasks: [], models: [] }), { headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
        const request = JSON.parse(String(init.body || "{}")); commands.push({ action: url.pathname.split("/").at(-1), ...request });
        const work = state.works.find(item => item.workId === request.workId);
        if (url.pathname.endsWith("/shared-review") && !state.shared?.inputHash) state.shared = { ...state.shared!, continuation: { authorizationId: request.operationId, contextHash: hash, status: "active", policy: { mode: "mixed", shared: "automatic", scene: "manual" }, updatedAt: new Date().toISOString() } };
        else if (url.pathname.endsWith("/shared-review")) state.shared = { ...state.shared!, reviewWorks: [{ workId: "shared-fixture", sourceHash: hash, inputHash: hash, inputRevision: state.revision, status: "awaiting_review", policy: { mode: "mixed", shared: "automatic", scene: "manual" }, updatedAt: new Date().toISOString(), error: "模拟：需要导演选择画风，转人工审核" }] };
        if (work && url.pathname.endsWith("/pause")) work.status = "paused";
        if (work && url.pathname.endsWith("/resume")) work.status = "pending";
        if (work && url.pathname.endsWith("/review")) { work.stage = "compile"; work.status = request.verdict === "approved" ? "pending" : "blocked"; }
        state = { ...state, revision: state.revision + 1 };
    }
    return new Response(JSON.stringify({ ok: true, state }), { headers: { "content-type": "application/json" } });
};

async function mount() {
    const { submitProductionSceneAction } = await import("../src/services/backend-api");
    const { nanoid } = await import("nanoid");
    const { SceneProductionPanel } = await import("../src/pages/drama/scene-production-panel");
    const { SceneProductionSettings } = await import("../src/pages/drama/scene-production-settings");
    await i18n.changeLanguage("zh-CN");
    function Harness() {
        const [plan, setPlan] = useState<DramaProductionPlan>({ requirements: "", imageModel: "", imageModelsByKind: {}, h3Model: "", confirmedOutline: "" });
        const [revision, setRevision] = useState(1), [dark, setDark] = useState(false), [sharedDemo, setSharedDemo] = useState(false);
        const production = { episodeId: "scene-fixture", revision, publishedVersion: 1, updatedAt: "", published: null, draft: { director: { source }, scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, imageModelsByKind: {}, h3Models: {}, parallelScenes: true, reviewPolicy: sharedDemo ? { mode: "mixed", shared: "automatic", scene: "manual" } : policy }, legacyImports: [] } } as unknown as EpisodeProduction;
        return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App><main className={`${dark ? "dark bg-slate-950 text-white" : "bg-white text-slate-900"} min-h-screen space-y-5 p-6`}>
            <h1>独立测试页 · 所有请求被模拟，不连接生产任务</h1><button onClick={() => setDark(!dark)}>Theme</button><button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN").then(() => setRevision(value => value + 1))}>Language</button>
            <button onClick={() => { state.shared = { inputHash: hash, reviewCurrent: false, source: { asset_cards: [{ id: "STYLE", name: "风格母图", prompt: "低饱和蓝灰与晨雾，角色与环境保持同一电影质感。" }] }, media: [] }; state.revision++; setSharedDemo(true); setRevision(state.revision); }}>模拟共同素材待审核</button>
            <button onClick={() => { state.shared = { reviewCurrent: false, error: "共同素材尚未生成" }; state.revision++; setSharedDemo(true); setRevision(state.revision); }}>模拟共同素材未就绪</button>
            <SceneProductionSettings value={plan} onChange={patch => setPlan({ ...plan, ...patch })} />
            <output data-testid="review-settings">{JSON.stringify(plan.reviewPolicy || null)}</output>
            <SceneProductionPanel onCommand={(action, revision) => submitProductionSceneAction("scene-fixture", action, revision, nanoid())} production={production} owner="scene-fixture" onRefresh={() => setRevision(state.revision)} />
            <output data-testid="commands">{JSON.stringify(commands)}</output>
        </main></App></ConfigProvider>;
    }
    createRoot(document.getElementById("root")!).render(<Harness />);
}
void mount();
