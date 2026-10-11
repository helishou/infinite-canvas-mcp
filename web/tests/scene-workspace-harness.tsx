import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { App, ConfigProvider, Button } from "antd";
import type { EpisodeProduction } from "../src/services/backend-api";
import "../src/styles/globals.css";

const id = `scene-workspace-receipt-fixture-${new URLSearchParams(location.search).get("case") || "default"}`, hash = "a".repeat(64);
const policy = { mode: "manual", shared: "manual", scene: "manual" } as const;
const owner = { kind: "canvas", id } as const;
const work = (sceneId: string, status: "running" | "awaiting_review") => ({ workId: `work-${sceneId}`, sceneId, status, stage: "create" as const, inputRevision: 1, sourceHash: hash, inputHash: hash, policy, runIds: [], artifactIds: [], generationAuthorized: false, updatedAt: new Date().toISOString() });
let production = {
    episodeId: id, revision: 1, publishedVersion: 0, published: null, updatedAt: "",
    draft: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], legacyImports: [],
        settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, imageModelsByKind: {}, h3Models: {}, parallelScenes: true, reviewPolicy: policy },
        director: { schemaVersion: 1, engine: { commit: hash.slice(0, 40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" }, sourceHash: hash, source: { brief: "模拟回执恢复，不启动模型", script_scenes: ["A", "B"].map(sceneId => ({ id: sceneId, scene_id: sceneId, heading: `场次 ${sceneId}`, text: "确认的模拟内容" })), shots: [], segments: [], asset_plan: [] }, modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: { sceneWorks: { "work-B": work("B", "running") }, sharedReview: { sourceHash: hash, inputHash: hash, verdict: "approved", mode: "manual", evidence: "fixture", media: [], checkedAt: new Date().toISOString() } } },
    },
} as unknown as EpisodeProduction;
const receipts = new Map<string, EpisodeProduction>(), requests: unknown[] = [];
let loseNextResponse = true, productionReads = 0;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
// Every request remains inside the fixture, including module initialization.
window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.pathname.endsWith("/scene-work/start") && init?.method === "POST") {
        const command = JSON.parse(String(init.body)); requests.push(command);
        const existing = receipts.get(command.operationId);
        if (existing) return response({ ok: true, production: existing, replayed: true });
        production = structuredClone(production); production.revision++;
        production.draft.director!.workflow.sceneWorks!["work-A"] = work("A", "awaiting_review");
        receipts.set(command.operationId, structuredClone(production));
        if (loseNextResponse) { loseNextResponse = false; throw new TypeError("模拟：Backend 已保存，响应丢失"); }
        return response({ ok: true, production });
    }
    if (url.pathname.endsWith("/production/scene-work")) return response({ ok: true, state: { revision: production.revision, works: Object.values(production.draft.director!.workflow.sceneWorks!), shared: { inputHash: hash, review: production.draft.director!.workflow.sharedReview } } });
    if (url.pathname.endsWith("/production/readiness")) return response({ ok: true, readiness: { revision: production.revision, publishedVersion: 0, source: "draft", targets: [], modules: {}, unresolved: [], nextAction: "模拟代理创作中" } });
    if (url.pathname.endsWith("/production/legacy")) return response({ ok: true, sources: [] });
    if (url.pathname.endsWith("/production/versions")) return response({ ok: true, versions: [] });
    if (url.pathname.endsWith("/production/batches")) return response({ ok: true, runs: [] });
    if (url.pathname.endsWith("/production/continuity")) return response({ ok: true, continuity: { status: "missing", items: [], total: 0, nextCursor: null, diagnostics: { total: 0, blocked: 0, unresolved: 0 } } });
    if (url.pathname.endsWith("/production")) { productionReads++; return response({ ok: true, production }); }
    if (url.pathname.endsWith("/production-context")) return response({ ok: true, context: { role: "ordinary", canvasId: id, owner } });
    if (url.pathname.endsWith("/drama")) return response({ ok: true, episode: null, drama: null });
    if (url.pathname.endsWith(`/canvas/projects/${id}`)) return response({ ok: true, project: { id, title: "场次工作台回执模拟", nodes: [], connections: [], revision: 0 } });
    return response({ ok: true, settings: {}, tasks: [], models: [], workflows: [], pending: [], updates: [] });
};
window.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource;

async function mount() {
    const { ProductionEditor } = await import("../src/pages/drama/production");
    const { default: i18n } = await import("../src/i18n"); await i18n.changeLanguage("zh-CN");
    function Harness() {
        const [, redraw] = useState(0);
        return <ConfigProvider><App><MemoryRouter initialEntries={["/test?workspace=overview"]}>
            <aside className="space-y-2 border-b p-3"><p>正式 ProductionEditor · 请求全部模拟，不连接真实生产</p>
                <Button onClick={() => { const beta = production.draft.director!.workflow.sceneWorks!["work-B"]; beta.stage = "compile"; beta.status = "awaiting_media"; production = { ...production, revision: production.revision + 1 }; redraw(value => value + 1); }}>模拟后台推进 B（不发事件）</Button>
                <Button onClick={() => redraw(value => value + 1)}>查看请求记录</Button>
                <output data-testid="receipt-requests">{JSON.stringify({ requests, savedWorks: Object.keys(production.draft.director!.workflow.sceneWorks!), productionReads })}</output>
            </aside>
            <ProductionEditor owner={owner} />
        </MemoryRouter></App></ConfigProvider>;
    }
    createRoot(document.getElementById("root")!).render(<Harness />);
}
void mount();
