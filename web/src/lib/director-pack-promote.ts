import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";

import { buildPlan, toWriteOps, type DraftShot } from "@/lib/drama/adapt-storyboard";
import { packSegmentsToShotRows, regroupPlanByPackSegments } from "@/lib/director-pack";
import type { DirectorPack } from "@/lib/director-pack";
import {
    applyProductionCompilation,
    compileProduction,
    editEpisodeProduction,
    fetchEpisodeProduction,
    fetchProductionCompilation,
    prepareProductionTargets,
    publishEpisodeProduction,
    syncEpisodeProductionClips,
    type DramaEpisode,
} from "@/services/backend-api";

/**
 * 导入导演包 → 一路推到「可以点生成」的状态。
 *
 * 顺序不能换，实测顺序错了会死在 `bind_director_segment: 分集画布中找不到节点`：
 *   1. 空稿先 `initialize_director_from_demand`（只出场次，还没有镜头）
 *   2. **先准备场次** —— 只有「该场次还没有 Clip」时 `productionSceneCreationOperations` 才会建 H3 场景节点；
 *      先写分镜再准备，节点永远不会被创建，bind 必然失败（这是 prepare 的实现条件，不是可以绕的错误）
 *   3. 写分镜（shots + segments，按包里的段边界重切 Clip）
 *   4. publish → compile(全段) → poll → apply
 *   5. 再准备 segment 目标，把 Clip 绑到刚建好的 H3 节点
 *   6. sync-clips
 *
 * 编译只吃本地编译器，不调模型；整条链路不产生生成费用。
 */

export type PromoteStage = "init" | "scene" | "write" | "publish" | "compile" | "apply" | "prepare" | "sync";

const asArray = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
const str = (value: unknown) => String(value ?? "");
const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

function sourceOf(draft: unknown): Record<string, unknown> {
    return ((draft as { director?: { source?: Record<string, unknown> } } | undefined)?.director?.source || {}) as Record<string, unknown>;
}

export type WriteResult = { production: Awaited<ReturnType<typeof fetchEpisodeProduction>>["production"]; clips: number; shots: number; sceneId: string; fps: number };

/** 只写制作稿：初始化场次 →（必要时）先建 H3 场景节点 → 写镜头与 Clip。 */
export async function writePackStoryboard(input: {
    episode: DramaEpisode;
    pack: DirectorPack;
    prepareScene?: boolean;
    onStage?: (stage: PromoteStage) => void;
}): Promise<WriteResult> {
    const episodeId = input.episode.id;
    const say = (stage: PromoteStage) => input.onStage?.(stage);
    let production = (await fetchEpisodeProduction(episodeId)).production;
    if (!asArray(sourceOf(production.draft).shots).length) {
        say("init");
        production = (await editEpisodeProduction(episodeId, production.revision, [{ type: "initialize_director_from_demand" } as never])).production;
    }
    const scenes = productionSceneEntries(sourceOf(production.draft) as never) as Array<Record<string, unknown>>;
    if (!scenes.length) throw new Error("制作稿里还没有场次：先在这一集的「需求」里写上【场景：…】再导入");
    const scene = scenes[0];
    const sceneId = str(scene.id);
    const environmentId = str(scene.environmentId || scene.id);
    const ownedShots = new Set((Array.isArray(scene.shotIds) ? scene.shotIds : []).map(String));
    const existing = asArray(sourceOf(production.draft).segments);
    // 已经有分镜的集不覆盖：包里段边界与现有 Clip 不同，硬写会撞 SCENE_STORYBOARD_SEGMENTS 且丢内容。
    if (existing.length) throw new Error(`这一集已经有 ${existing.length} 段分镜了：导演包导入只用于空的分集（避免覆盖现有分镜）。要重来请先清空这一集的分镜。`);
    const reuseClipIds = existing
        .filter((segment) => (Array.isArray(segment.shot_ids) ? segment.shot_ids : []).some((id: unknown) => ownedShots.has(String(id))))
        .map((segment) => str(segment.id));

    // 场景节点必须在「该场次还没有 Clip」时创建，顺序相反就会死在 bind_director_segment。
    if (input.prepareScene && !reuseClipIds.length) {
        say("scene");
        production = (await prepareProductionTargets(episodeId, production.revision, [`scene:${sceneId}`], `pack-scene-${Date.now()}`)).production;
    }

    say("write");
    const fps = Math.max(1, Number(sourceOf(production.draft).fps_num || input.pack.timeline.output.fps || 24));
    const rows = packSegmentsToShotRows(input.pack.timeline.segments, fps);
    if (!rows.length) throw new Error("这个导演包里没有可用段落（prompt 全空）");
    const planned = buildPlan({
        chapterId: episodeId,
        environmentId,
        rows: rows.map((row, index): DraftShot => ({ key: `pack-${index}`, title: row.title, visual: row.visual, camera: row.camera, seconds: row.seconds, dialogue: "", speaker: "" })),
        fps,
    });
    const plan = regroupPlanByPackSegments(planned, rows.map((row) => row.group), input.pack.timeline.segments.map((segment) => segment.id));
    const ops = toWriteOps({ plan, sceneId, environmentId, fps, reuseClipIds });
    production = (await editEpisodeProduction(episodeId, production.revision, ops as never)).production;
    return { production, clips: plan.segments.length, shots: plan.shots.length, sceneId, fps };
}

/** 导入后一路推到「可以点生成」：建节点 → 写稿 → 发布 → 编译 → 应用 → 绑 Clip → 同步。不调模型、不产生生成费用。 */
export async function promoteImportedPack(input: {
    episode: DramaEpisode;
    pack: DirectorPack;
    onStage?: (stage: PromoteStage, detail?: string) => void;
    pollMs?: number;
    timeoutMs?: number;
}): Promise<{ clips: number; shots: number; sceneId: string }> {
    const episodeId = input.episode.id;
    const say = input.onStage;
    const pollMs = input.pollMs ?? 2500;
    const timeoutMs = input.timeoutMs ?? 300_000;

    const written = await writePackStoryboard({ episode: input.episode, pack: input.pack, prepareScene: true, onStage: (stage) => say?.(stage) });
    let production = written.production;

    say?.("publish");
    production = (await publishEpisodeProduction(episodeId, production.revision, "director", `pack-publish-${Date.now()}`)).production;
    say?.("compile");
    const operationId = `pack-compile-${Date.now()}`;
    await compileProduction(episodeId, production.revision, operationId);
    const started = Date.now();
    let preparedId = "";
    while (Date.now() - started < timeoutMs) {
        const { compilation } = await fetchProductionCompilation(episodeId, operationId);
        if (compilation.status === "failed" || compilation.status === "blocked") {
            throw new Error(`编译没通过：${compilation.blockingDiagnostic?.message || compilation.verdict || compilation.status}`);
        }
        if (compilation.status === "succeeded" && compilation.preparedId) { preparedId = String(compilation.preparedId); break; }
        await sleep(pollMs);
    }
    if (!preparedId) throw new Error("编译超时（5 分钟没出结果）；稍后可在制作台点「验证并编译」继续");

    say?.("apply");
    await applyProductionCompilation(episodeId, preparedId);
    production = (await fetchEpisodeProduction(episodeId)).production;

    say?.("prepare");
    const groups = asArray(sourceOf(production.draft).segments);
    production = (await prepareProductionTargets(episodeId, production.revision, groups.map((group) => `segment:${str(group.id)}`), `pack-segments-${Date.now()}`)).production;

    say?.("sync");
    production = (await syncEpisodeProductionClips(episodeId)).production;
    return { clips: groups.length, shots: asArray(sourceOf(production.draft).shots).length, sceneId: written.sceneId };
}
