import React from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import "../src/styles/globals.css";

const id = "clip-generation-preparation", owner = { kind: "canvas", id } as const;
const scenario = new URLSearchParams(location.search).get("case") || "normal";
const prompt = `summary:\n孩子在窗边观察。${scenario}\nnon_diegetic_music:\nN/A`;
const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt))), b => b.toString(16).padStart(2, "0")).join("");
const engine = { runtimeId: "fixture", compilerHash: "fixture", commit: "a".repeat(40), patchVersion: "fixture", version: "fixture" };
const source: any = { version: 2, prompt_assembly: { version: 2 }, brief: "只核对中文制作内容", fps_num: 24, fps_den: 1,
    script_scenes: [{ id: "SCENE", title: "室内", text: "孩子看向窗外。" }], subject_registry: [], asset_plan: [], character_registry: [], scene_registry: [], utterances: [],
    ledger: { contract_version: 2, facts: [], timelines: [], events: [], initial: [] },
    shots: [{ id: "S1", story_order: 0, source_scene_id: "SCENE", timeline_id: "T", duration_frames: 96, title: "窗边观察", visual: "孩子扶着窗沿，听见外面动静后抬头。", camera: { framing: "CU", editorial_reason: "看清反应" }, subject_usages: [], keyframes: [], utterance_refs: [] }],
    segments: [{ id: "C1", shot_ids: ["S1"], mode: "Ref2VA" }] };
const director: any = { schemaVersion: 1, source, sourceHash: hash, engine, assets: {}, shotInputs: {}, boundaries: [], modules: {}, unresolved: [], workflow: {},
    artifacts: [{ id: "A1", kind: "h3", targetId: "C1", prompt, sha256: hash, sourceHash: hash, status: "ready", receipt: { sourceHash: hash, promptHash: hash, engine } }] };
const production: any = { episodeId: id, revision: 1, publishedVersion: 0, published: null, updatedAt: "", draft: { director, scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], legacyImports: [], settings: { mode: "manual", reviewPolicy: { mode: "manual", shared: "manual", scene: "manual" }, imageModels: {}, imageModelsByKind: {}, h3Models: {} } } };
const segment: any = { id: "RUNTIME", prompt: scenario === "manual" ? "My hand-edited prompt" : prompt, status: "idle", duration: 4, productionClipProjection: { targetId: "C1", promptHash: hash } };
const project: any = { id, title: "中文制作与自动英文准备", revision: 1, nodes: [{ id: "H3", title: "室内", type: "minimax-h3", position: { x: 0, y: 0 }, width: 500, height: 500, metadata: { productionOwnerKind: "canvas", productionOwnerId: id, segments: [segment] } }], connections: [], viewport: { x: 0, y: 0, k: 1 }, createdAt: "", updatedAt: "", chatSessions: [] };
const events: unknown[] = [];
const record = (event: unknown) => { events.push(event); (window as any).__preparationEvents = events; };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// No request leaves this fixture. In particular no model or media generation is submitted.
window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const path = url.pathname;
    if (path.endsWith("/camera-library/moves")) return response({ ok: true, available: false, moves: [], categories: [] });
    if (path.endsWith("/translation/text")) {
        const request = JSON.parse(String(init?.body)); record({ translation: request });
        if (scenario === "failed") return response({ error: "模拟翻译失败" }, 422);
        if (scenario === "changed") director.sourceHash = "changed";
        if (scenario === "prompt-changed") segment.prompt = "A newer manual prompt";
        return response({ ok: true, translations: request.items.map((item: any) => ({ id: item.id, sourceHash: item.id, translatedText: "summary:\nA child watches from the window.\nnon_diegetic_music:\nN/A", cached: false })) });
    }
    if (path.endsWith("/ops")) {
        const request = JSON.parse(String(init?.body)); record({ ops: request });
        for (const op of request.ops || request.operations || []) if (op.type === "update_h3_segment") Object.assign(segment, op.patch);
        project.revision++;
        return response({ ok: true, revision: project.revision, project });
    }
    if (path.endsWith("/production/runs") && init?.method === "POST") {
        const request = JSON.parse(String(init.body)); record({ run: request, prompt: segment.prompt });
        return response({ ok: true, run: { ...request, status: "completed", submitted: [], items: [], tasks: [], targets: request.targets, updatedAt: "" } });
    }
    if (path.endsWith("/production/readiness")) return response({ ok: true, readiness: { revision: 1, publishedVersion: 0, source: "draft", targets: [], modules: {}, unresolved: [], nextAction: "人工制作" } });
    if (path.endsWith("/production/batches")) return response({ ok: true, runs: [] });
    if (path.endsWith("/production/continuity")) return response({ ok: true, continuity: { status: "missing", items: [], total: 0, nextCursor: null, diagnostics: { total: 0, blocked: 0, unresolved: 0 } } });
    if (path.endsWith("/production")) return response({ ok: true, production: url.searchParams.has("view") ? { workbench: {} } : production });
    if (path.endsWith("/production-context")) return response({ ok: true, context: { role: "ordinary", canvasId: id, owner } });
    if (path.endsWith("/drama")) return response({ ok: true, episode: null, drama: null });
    if (path.endsWith(`/canvas/projects/${id}`)) return response({ ok: true, project });
    if (path.endsWith("/canvas/projects")) return response({ ok: true, projects: [project] });
    return response({ ok: true, settings: {}, tasks: [], models: [], workflows: [], pending: [], updates: [], runs: [], versions: [], sources: [] });
};
window.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource;
const { ProductionEditor } = await import("../src/pages/drama/production");
const { useBackendStore } = await import("../src/stores/use-backend-store"); useBackendStore.setState({ connected: true, checking: false });
const { default: i18n } = await import("../src/i18n"); await i18n.changeLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter initialEntries={["/test?workspace=shots"]}><ProductionEditor owner={owner} /></MemoryRouter></App></ConfigProvider>);
