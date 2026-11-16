import type { Router } from "express";
import { z } from "zod";
import { dramaOutlineDetailSchema, dramaProductionPlanSchema, dramaTopicSchema, episodeHasScript } from "@basketikun/canvas-agent/drama/production-contract";
import { dramaNextAction, dramaStageStates, renderDramaStageContext, type DramaStageEpisode } from "@basketikun/canvas-agent/drama/stage-contract";
import { freshestStageActivity } from "../drama/stage-activity.js";

import type { BackendDatabase } from "../db.js";
import type { Stores } from "../stores/types.js";
import { dramaOutlineSteps, proposeDramaOutlineStep, proposeEpisodeScript } from "../drama/outline-proposal.js";
import { proposeTopicFromSource } from "../drama/topic-proposal.js";

const proposalBodySchema = z.object({
    step: z.enum(dramaOutlineSteps),
    model: z.string().trim().max(200).optional(),
    instruction: z.string().trim().max(2000).optional(),
}).strict();

/**
 * 剧目级大纲生成：一步一次请求，只返回候选文本。
 * 写入仍然走既有的剧目规划保存（upsertCanvasFolder + productionPlan），这里不落库、不改真值。
 */
/** 「粘贴剧本 → 自动填好选题」：创建前就能用，所以挂在 /drama/topic-proposal（不带 dramaId）。 */
const topicProposalSchema = z.object({
    source: z.string().min(1).max(400000),
    model: z.string().max(200).optional(),
    instruction: z.string().max(2000).optional(),
}).strict();

export function registerDramaTopicProposalRoute(router: Router, stores: Pick<Stores, "settings">) {
    router.post("/drama/topic-proposal", async (req, res) => {
        const parsed = topicProposalSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        if (parsed.data.source.replace(/\s/g, "").length < 100) return void res.status(400).json({ ok: false, error: "原剧本太短（至少 100 字），或者直接手填选题" });
        try {
            const result = await proposeTopicFromSource(stores, parsed.data);
            res.json({ ok: true, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}

export function registerDramaPlanningRoutes(router: Router, db: BackendDatabase, stores: Pick<Stores, "settings">, base = "/drama/:dramaId/planning") {
    router.post<Record<string, string>>(`${base}/outline-proposal`, async (req, res) => {
        const parsed = proposalBodySchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
        try {
            const result = await proposeDramaOutlineStep(stores, {
                step: parsed.data.step,
                source: plan.sourceScript,
                plan,
                outline: String(folder.outline || ""),
                name: String(folder.name || ""),
                model: parsed.data.model,
                instruction: parsed.data.instruction,
            });
            res.json({ ok: true, step: parsed.data.step, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}

const scriptBodySchema = z.object({
    model: z.string().trim().max(200).optional(),
    instruction: z.string().trim().max(2000).optional(),
}).strict();

/**
 * 单集剧本大纲（分场）：一场一行。只回候选文本，写入走既有的分集更新接口。
 * 集间承接：取上一集剧本大纲的最后一场塞进提示词，避免每集各写各的。
 */
export function registerDramaScriptRoutes(router: Router, db: BackendDatabase, stores: Pick<Stores, "settings">, base = "/drama/episodes/:episodeId") {
    router.post<Record<string, string>>(`${base}/script-proposal`, async (req, res) => {
        const parsed = scriptBodySchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        const episode = db.getDramaEpisode(String(req.params.episodeId));
        if (!episode) return void res.status(404).json({ ok: false, error: "分集不存在" });
        const folder = db.listCanvasFolders(episode.dramaId)[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
        const previous = db.listDramaEpisodes(episode.dramaId)
            .filter((item) => item.episodeNumber < episode.episodeNumber && String(item.fullPlot || "").trim())
            .sort((left, right) => right.episodeNumber - left.episodeNumber)[0];
        const previousTail = previous ? String(previous.fullPlot).trim().split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0] : "";
        try {
            const result = await proposeEpisodeScript(stores, {
                episodeNumber: episode.episodeNumber,
                title: String(episode.title || ""),
                synopsis: String(episode.synopsis || ""),
                outline: String(folder.outline || ""),
                worldContext: plan.outlineDetail.worldContext,
                threeActs: plan.outlineDetail.threeActs,
                ending: plan.outlineDetail.ending,
                source: plan.sourceScript,
                previousTail,
                model: parsed.data.model,
                instruction: parsed.data.instruction,
            });
            res.json({ ok: true, episodeId: episode.id, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}


const planningPatchSchema = z.object({
    sourceScript: z.string().max(400000).optional(),
    outline: z.string().max(400000).optional(),
    topic: dramaTopicSchema.partial().optional(),
    outlineDetail: dramaOutlineDetailSchema.partial().optional(),
    outlineModel: z.string().trim().max(200).optional(),
    expectedUpdatedAt: z.string().trim().min(1).optional(),
}).strict();

function planningSteps(folder: { outline?: string | null }, plan: z.infer<typeof dramaProductionPlanSchema>, episodes: Array<{ fullPlot?: string | null; synopsis?: string | null; episodeNumber: number }>) {
    const pending = episodes.filter((episode) => !episodeHasScript(episode)).map((episode) => episode.episodeNumber).sort((left, right) => left - right);
    return {
        topic: Boolean(plan.topic.theme || plan.topic.themes.length || plan.topic.logline.trim()),
        outline: Boolean(String(folder.outline || "").trim()) && Boolean(plan.outlineDetail.worldContext.trim()),
        script: { total: episodes.length, written: episodes.length - pending.length, pending },
    };
}

/**
 * 剧目级策划的读写口：网页的「原剧本 / 选题 / 大纲 / 剧本」与 agent 走同一条真值
 * （folder.outline = 故事线，folder.productionPlan = 原剧本+选题+大纲补充段）。
 * 只做读写，不生成；生成仍走 outline-proposal / script-proposal。
 */
export function registerDramaPlanningStateRoutes(router: Router, db: BackendDatabase, base = "/drama/:dramaId/planning") {
    router.get<Record<string, string>>(base, (req, res) => {
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
        const episodes = db.listDramaEpisodes(String(req.params.dramaId));
        const includeSource = String(req.query.include || "").includes("sourceScript");
        res.json({
            ok: true,
            dramaId: folder.id,
            name: String(folder.name || ""),
            updatedAt: String(folder.updatedAt || ""),
            steps: planningSteps(folder, plan, episodes),
            outline: String(folder.outline || ""),
            topic: plan.topic,
            outlineDetail: plan.outlineDetail,
            outlineModel: plan.outlineModel,
            sourceScriptBytes: Buffer.byteLength(plan.sourceScript, "utf8"),
            ...(includeSource ? { sourceScript: plan.sourceScript } : { sourceScriptHint: "原剧本正文较大，需要时加 ?include=sourceScript 读取" }),
        });
    });

    router.patch<Record<string, string>>(base, (req, res) => {
        const parsed = planningPatchSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const current = dramaProductionPlanSchema.parse(folder.productionPlan || {});
        const patch = parsed.data;
        const plan = dramaProductionPlanSchema.parse({
            ...current,
            ...(patch.outlineModel === undefined ? {} : { outlineModel: patch.outlineModel }),
            ...(patch.sourceScript === undefined ? {} : { sourceScript: patch.sourceScript }),
            topic: { ...current.topic, ...(patch.topic || {}) },
            outlineDetail: { ...current.outlineDetail, ...(patch.outlineDetail || {}) },
        });
        try {
            const saved = db.upsertCanvasFolder({
                ...folder,
                ...(patch.outline === undefined ? {} : { outline: patch.outline }),
                productionPlan: plan,
                updatedAt: new Date().toISOString(),
                expectedPlanningUpdatedAt: patch.expectedUpdatedAt || folder.updatedAt,
            });
            const episodes = db.listDramaEpisodes(String(req.params.dramaId));
            res.json({
                ok: true,
                dramaId: saved.id,
                updatedAt: String(saved.updatedAt || ""),
                applied: Object.keys(patch).filter((key) => key !== "expectedUpdatedAt"),
                steps: planningSteps(saved, plan, episodes),
            });
        } catch (error) {
            res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}


/**
 * 剧目阶段：选题 → 大纲 → 剧本 → 资产 → 分镜 → 视频。
 * 只派生，不存第二份状态：预约前四段看剧目字段，后三段看每集既有的 productionStage 游标。
 * 网页步骤条、agent 的 drama_stage_status、每轮注入的阶段块都用这一份。
 */
function stagePayload(db: BackendDatabase, folder: { id: string; name?: string | null; outline?: string | null; productionPlan?: unknown }) {
    const plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
    const episodes = db.listDramaEpisodes(folder.id);
    const stages = db.listEpisodeProductionStages(episodes.map((episode) => episode.id));
    const input = {
        topic: plan.topic,
        outline: String(folder.outline || ""),
        outlineDetail: plan.outlineDetail,
        episodes: episodes.map((episode) => ({
            episodeNumber: episode.episodeNumber,
            fullPlot: episode.fullPlot,
            synopsis: episode.synopsis,
            stage: stages[episode.id] || null,
        })) as DramaStageEpisode[],
    };
    const states = dramaStageStates(input);
    const next = dramaNextAction(states);
    return {
        ok: true,
        dramaId: folder.id,
        name: String(folder.name || ""),
        states,
        next,
        context: renderDramaStageContext({ dramaName: String(folder.name || ""), dramaId: folder.id, states }),
        activity: freshestStageActivity([folder.id, ...episodes.flatMap((episode) => [episode.id, String(episode.canvasId || "")])]),
        episodes: input.episodes.map((episode) => ({
            episodeNumber: episode.episodeNumber,
            stage: episode.stage?.current || null,
            done: episode.stage?.done || [],
        })),
    };
}

export function registerDramaStageRoutes(router: Router, db: BackendDatabase) {
    router.get<Record<string, string>>("/drama/:dramaId/stage", (req, res) => {
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        res.json(stagePayload(db, folder));
    });
    router.get<Record<string, string>>("/drama/by-canvas/:canvasId/stage", (req, res) => {
        const episode = db.getDramaEpisodeByCanvasId(String(req.params.canvasId));
        if (!episode) return void res.status(404).json({ ok: false, error: "这个画布没有绑定分集" });
        const folder = db.listCanvasFolders(episode.dramaId)[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        res.json(stagePayload(db, folder));
    });
}
