import type { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { dramaOutlineDetailSchema, dramaProductionPlanSchema, dramaTopicSchema, episodeHasScript, modelEpisodeGroupSchema, type ModelEpisodeGroup } from "@basketikun/canvas-agent/drama/production-contract";
import { EPISODE_SOURCE_CHARS } from "@basketikun/canvas-agent/drama/chapter-episodes";
import { dramaNextAction, dramaStageStates, renderDramaStageContext, type DramaStageEpisode } from "@basketikun/canvas-agent/drama/stage-contract";
import { freshestStageActivity } from "../drama/stage-activity.js";
import { learnedRulesCompact } from "../drama/learned-rules.js";
import { EpisodeProductionService } from "../drama/production.js";
import { missingChapters, proposeEpisodeGrouping, type GroupingChapter } from "../drama/episode-grouping.js";
import type { BackendEventBus } from "../events.js";

import type { BackendDatabase, SourceChapter, EpisodePlanningState, PlannedEpisode, DramaEpisode } from "../db.js";
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

/** 拆章口径必须与前端 studio-chapter-picker / planning-source-tab 完全一致，否则章序号对不上。 */
const NOVEL_MAX_CHARS = 3000;
/** 影策 submitPlan 的批次上限：每批 ≤12 章 / ≤30000 字。 */
const PLAN_BATCH_MAX_CHAPTERS = 12;
const PLAN_BATCH_MAX_CHARS = 30000;

type PlanFolder = { id: string; name?: string | null; productionPlan?: unknown; updatedAt?: string };

/** 首次调用落稳定章节 ID，之后复用同一批 ID 与正文（不再每次从 sourceScript 重算）。 */
function sourcedChapters(db: BackendDatabase, folder: PlanFolder, plan: { sourceScript: string; sourceSplit: { excluded: number[]; maxChars: number }; episodeMode?: string }): SourceChapter[] {
    return db.syncSourceChapters(folder.id, plan.sourceScript, {
        excluded: plan.sourceSplit?.excluded || [],
        maxChars: Number(plan.sourceSplit?.maxChars) || NOVEL_MAX_CHARS,
    }, plan.episodeMode || "chapter").chapters;
}

/** 游标之后的一批章节：≤12 章 / ≤30000 字，与影策分批 enqueue 同口径。 */
function batchWindow(state: EpisodePlanningState, chapters: readonly SourceChapter[]) {
    const pending = chapters.filter((chapter) => chapter.chapterIndex >= state.planCursor);
    const picked: SourceChapter[] = [];
    let chars = 0;
    for (const chapter of pending) {
        if (picked.length >= state.batchChapters || picked.length >= PLAN_BATCH_MAX_CHAPTERS) break;
        if (picked.length > 0 && chars + chapter.body.length > Math.min(state.batchChars, PLAN_BATCH_MAX_CHARS)) break;
        picked.push(chapter);
        chars += chapter.body.length;
    }
    const nextCursor = picked.length ? Math.max(...picked.map((chapter) => chapter.chapterIndex)) + 1 : state.planCursor;
    return { chapters: picked, chars, nextCursor, done: picked.length === 0 };
}

function groupingChapter(chapter: SourceChapter): GroupingChapter {
    return { index: chapter.chapterIndex, title: chapter.title, text: chapter.body };
}

const episodeGroupingPreviewSchema = z.object({
    model: z.string().trim().max(200).optional(),
    instruction: z.string().trim().max(2000).optional(),
}).strict();

const confirmedGroupSchema = z.object({
    title: z.string().trim().min(1).max(200),
    chapters: z.array(z.number().int().min(1)).min(1),
    synopsis: z.string().trim().min(1).max(20000),
    hook: z.string().max(500).optional().default(""),
    cliffhanger: z.string().max(500).optional().default(""),
}).strict();

const episodeGroupingApplySchema = z.object({
    groups: z.array(confirmedGroupSchema).min(1),
    expectedUpdatedAt: z.string().trim().min(1).optional(),
}).strict();

function groupKey(chapters: readonly number[], title: string) {
    return `${[...chapters].sort((left, right) => left - right).join(",")}|${String(title).trim()}`;
}

type ConfirmedGroup = z.infer<typeof confirmedGroupSchema>;
type AppliedGroup = ConfirmedGroup & { episodeNumber: number };

type GroupingCommit =
    | { ok: true; replayed: boolean; episodes: DramaEpisode[]; groups: AppliedGroup[]; updatedAt: string; planCursor: number; planDone: boolean; lastChapterIndex: number }
    | { ok: false; status: number; error: string };

/**
 * 单批分集的「校验 + 单事务建集」：apply 路由与服务端自动连跑共用这一份，
 * 保证手动确认和自动规划走完全相同的游标/CAS/幂等/完成锁语义。
 */
function commitGroupingBatch(
    db: BackendDatabase,
    events: BackendEventBus,
    folder: PlanFolder,
    groups: readonly ConfirmedGroup[],
    expectedUpdatedAt?: string,
): GroupingCommit {
    const plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
    const state = db.getEpisodePlanningState(folder.id);
    if (!state) return { ok: false, status: 400, error: "分集规划状态未初始化" };
    // 完成后只读已锁定章节 IR（供幂等重放比对），绝不重算原文。
    const chapters = state.planDone ? db.listSourceChapters(folder.id) : sourcedChapters(db, folder, plan);
    const byIndex = new Map(chapters.map((chapter) => [chapter.chapterIndex, chapter]));
    const invalid = groups.flatMap((group) => group.chapters.filter((number) => !byIndex.has(number)));
    if (invalid.length) return { ok: false, status: 400, error: `分组包含不在本次选章里的章序号：${[...new Set(invalid)].join("、")}` };

    const existing = db.listDramaEpisodes(folder.id);
    const existingByNumber = new Map(existing.map((item) => [item.episodeNumber, item]));
    const priorNumbers = new Map<string, number>();
    for (const entry of plan.modelEpisodeGroups) if (entry.episodeNumber) priorNumbers.set(groupKey(entry.chapters, entry.title), entry.episodeNumber);

    const covered = groups.flatMap((group) => group.chapters);
    const maxCovered = covered.reduce((max, number) => Math.max(max, number), 0);
    const minCovered = covered.length ? covered.reduce((min, number) => Math.min(min, number), Infinity) : 0;
    const set = new Set(covered);
    let contiguous = covered.length > 0;
    for (let index = minCovered; index <= maxCovered; index += 1) if (!set.has(index)) contiguous = false;
    const mapped = groups.map((group) => {
        const number = priorNumbers.get(groupKey(group.chapters, group.title));
        return { number, episode: number ? existingByNumber.get(number) : undefined, group };
    });
    // 重放：分组映回已写入的集号且覆盖到已推进的游标位置 → 原样返回，不推进游标、不改库。
    const isReplay = state.planCursor > 0 && maxCovered >= state.planCursor - 1 && contiguous && mapped.every(({ number, episode, group }) => {
        if (!number || !episode) return false;
        const wantIds = [...group.chapters].sort((left, right) => left - right).map((index) => byIndex.get(index)!.id);
        return episode.title === group.title.trim().slice(0, 60)
            && JSON.stringify([...episode.chapterIds].sort()) === JSON.stringify([...wantIds].sort());
    });
    if (isReplay) {
        return {
            ok: true, replayed: true, episodes: mapped.map((item) => item.episode!),
            groups: groups.map((group, index) => ({ ...group, episodeNumber: mapped[index].number! })),
            updatedAt: String(folder.updatedAt || ""), planCursor: state.planCursor, planDone: state.planDone, lastChapterIndex: state.lastChapterIndex,
        };
    }
    if (state.planDone) return { ok: false, status: 409, error: "分集已完成，不能修改分集结果" };

    const window = batchWindow(state, chapters);
    const windowIndices = new Set(window.chapters.map((chapter) => chapter.chapterIndex));
    const missing = missingChapters(groups, [...windowIndices]);
    if (missing.length) return { ok: false, status: 400, error: `确认的分组没有覆盖当前批次章节：第 ${missing.join("、")} 章` };
    const extra = [...new Set(covered.filter((number) => !windowIndices.has(number)))];
    if (extra.length) return { ok: false, status: 400, error: `分组包含不属于当前批次的章序号：第 ${extra.join("、")} 章，请重新预览` };

    const used = new Set(existing.map((item) => item.episodeNumber));
    let nextNumber = 1;
    while (used.has(nextNumber)) nextNumber += 1;
    const snapshot = groups.map((group) => {
        const episodeNumber = nextNumber;
        nextNumber += 1;
        used.add(episodeNumber);
        return { ...group, title: group.title.slice(0, 200), episodeNumber };
    });
    const planned: PlannedEpisode[] = snapshot.map((group) => {
        const sorted = [...group.chapters].sort((left, right) => left - right);
        const text = sorted.map((index) => byIndex.get(index))
            .filter((chapter): chapter is SourceChapter => Boolean(chapter))
            .map((chapter) => `【章】${chapter.title}\n${chapter.body}`).join("\n\n");
        return {
            episodeNumber: group.episodeNumber!, title: group.title.slice(0, 60),
            synopsis: text.length > EPISODE_SOURCE_CHARS ? text.slice(0, EPISODE_SOURCE_CHARS) : text,
            hook: group.hook, cliffhanger: group.cliffhanger,
            chapterIds: sorted.map((index) => byIndex.get(index)!.id), chapterIndices: sorted,
        };
    });
    const mergedGroups = [
        ...plan.modelEpisodeGroups.filter((entry) => !snapshot.some((group) => groupKey(group.chapters, group.title) === groupKey(entry.chapters, entry.title))),
        ...snapshot,
    ];
    const savedPlan = dramaProductionPlanSchema.parse({ ...plan, episodeMode: "auto", modelEpisodeGroups: mergedGroups });
    try {
        const result = db.applyPlanBatch({
            dramaId: folder.id, expectedCursor: state.planCursor, lastChapterIndex: state.lastChapterIndex,
            groups: planned, planJson: savedPlan, expectedUpdatedAt: expectedUpdatedAt || folder.updatedAt,
        });
        result.episodes.forEach((episode) => events.publish({ type: "drama-episode.updated", entityId: episode.id, payload: episode }));
        return {
            ok: true, replayed: false, episodes: result.episodes, groups: snapshot,
            updatedAt: String(db.listCanvasFolders(folder.id)[0]?.updatedAt || ""),
            planCursor: result.nextCursor, planDone: result.planDone, lastChapterIndex: state.lastChapterIndex,
        };
    } catch (error) {
        return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
    }
}

/** proposer 可注入，便于单测模拟「中间批次中断」而不依赖真实文本模型。 */
export type EpisodeGroupingProposer = (input: Parameters<typeof proposeEpisodeGrouping>[1]) => Promise<{ groups: ModelEpisodeGroup[]; model: string }>;

export type AutoPlanOutcome = {
    ok: boolean;
    status?: number;
    error?: string;
    message?: string;
    dramaId: string;
    planCursor: number;
    planDone: boolean;
    lastChapterIndex: number;
    batches: Array<{ index: number; model: string; cursor: number; nextCursor: number; episodeNumbers: number[] }>;
    episodes: DramaEpisode[];
};

/** 自动连跑的默认每批上限：防止异常游标把服务端锁死在死循环里。 */
const AUTO_PLAN_MAX_BATCHES = 500;

/**
 * 服务端一次触发把所有批次规划完：每批先走 proposeEpisodeGrouping（LLM），
 * 再走与手动 apply 完全相同的 commitGroupingBatch（单事务 CAS）。
 * 中断/报错时已完成的批次各自完整落库且游标已推进，未完成的批次不落库，
 * 因此不会出现「半套集」；再次调用从游标继续，完成后重复调用直接返回完成态。
 */
export async function autoPlanAllBatches(
    db: BackendDatabase,
    events: BackendEventBus,
    stores: Pick<Stores, "settings">,
    dramaId: string,
    input: { model?: string; instruction?: string; signal?: AbortSignal; maxBatches?: number } = {},
    propose: EpisodeGroupingProposer = (args) => proposeEpisodeGrouping(stores, args),
): Promise<AutoPlanOutcome> {
    const maxBatches = Math.max(1, Math.min(Number(input.maxBatches) || AUTO_PLAN_MAX_BATCHES, AUTO_PLAN_MAX_BATCHES));
    const batches: AutoPlanOutcome["batches"] = [];
    const outcome = (ok: boolean, extra: { status?: number; error?: string; message?: string } = {}): AutoPlanOutcome => {
        const current = db.getEpisodePlanningState(dramaId);
        return {
            ok, ...extra, dramaId,
            planCursor: current?.planCursor ?? 0, planDone: Boolean(current?.planDone),
            lastChapterIndex: current?.lastChapterIndex ?? 0,
            batches, episodes: db.listDramaEpisodes(dramaId),
        };
    };
    let folder = db.listCanvasFolders(dramaId)[0];
    if (!folder) return outcome(false, { status: 404, error: "剧目不存在" });
    let plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
    if (!plan.sourceScript.trim()) return outcome(false, { status: 400, error: "先把「原剧本」填上，再来自动规划分集" });
    if (db.getEpisodePlanningState(dramaId)?.planDone) {
        return outcome(true, { message: "全部分集已完成，分集结果已锁定" });
    }
    try {
        for (let index = 0; index < maxBatches; index += 1) {
            if (input.signal?.aborted) return outcome(false, { status: 400, error: "自动规划已中断，请重新触发（会从当前游标继续）" });
            folder = db.listCanvasFolders(dramaId)[0] || folder;
            plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
            // 首次自动规划也会落稳定章节 ID 与游标；指纹不变时直接复用 IR，绝不重算原文。
            const chapters = sourcedChapters(db, folder, plan);
            const state = db.getEpisodePlanningState(dramaId)!;
            if (state.planDone) break;
            const window = batchWindow(state, chapters);
            if (window.done) break;
            const existing = db.listDramaEpisodes(dramaId);
            const startNumber = existing.reduce((max, item) => Math.max(max, item.episodeNumber), 0) + 1;
            const previousCliffhanger = plan.modelEpisodeGroups.at(-1)?.cliffhanger || "";
            let proposed: { groups: ModelEpisodeGroup[]; model: string };
            try {
                proposed = await propose({
                    name: String(folder.name || ""),
                    chapters: window.chapters.map(groupingChapter),
                    startNumber, previousCliffhanger,
                    model: input.model, instruction: input.instruction, signal: input.signal,
                });
            } catch (error) {
                return outcome(false, { status: 400, error: `第 ${index + 1} 批分集规划失败：${error instanceof Error ? error.message : String(error)}` });
            }
            const groups: ConfirmedGroup[] = proposed.groups.map(({ title, chapters: indices, synopsis, hook, cliffhanger }) => ({ title, chapters: indices, synopsis, hook, cliffhanger }));
            const commit = commitGroupingBatch(db, events, folder, groups, folder.updatedAt);
            if (!commit.ok) return outcome(false, { status: commit.status, error: commit.error });
            batches.push({
                index: index + 1, model: proposed.model, cursor: state.planCursor, nextCursor: commit.planCursor,
                episodeNumbers: commit.episodes.map((episode) => episode.episodeNumber),
            });
            if (commit.planDone) break;
        }
    } catch (error) {
        // 意外异常（切章/事务冲突等）：已提交批次仍完整，游标以库内真值返回。
        return outcome(false, { status: 409, error: `自动规划中断：${error instanceof Error ? error.message : String(error)}` });
    }
    const final = db.getEpisodePlanningState(dramaId);
    if (!final?.planDone) {
        return outcome(false, {
            status: 409,
            error: `自动规划在 ${maxBatches} 批内未完成（游标 ${final?.planCursor ?? 0}/${final?.lastChapterIndex ?? 0}），可重新触发从当前游标继续`,
        });
    }
    return outcome(true, { message: `全部分集已自动规划完成（共 ${batches.length} 批，游标 ${final.planCursor}/${final.lastChapterIndex}），分集结果已锁定` });
}

/**
 * 模型自动分集（强一致）：预览按游标取一批 ≤12 章/30000 字；确认后单事务 CAS 建集。
 * 章节 ID 首次切章落 source_chapters 长期复用；plan_done 后拒绝任何分集结果改动。
 */
export function registerDramaEpisodeGroupingRoutes(router: Router, db: BackendDatabase, stores: Pick<Stores, "settings">, events: BackendEventBus, base = "/drama/:dramaId/planning") {
    router.post<Record<string, string>>(`${base}/episode-grouping-preview`, async (req, res) => {
        const parsed = episodeGroupingPreviewSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const plan = dramaProductionPlanSchema.parse(folder.productionPlan || {});
        if (!plan.sourceScript.trim()) return void res.status(400).json({ ok: false, error: "先把「原剧本」填上，再来预览模型自动分集" });
        const existingState = db.getEpisodePlanningState(folder.id);
        // 完成后只读已锁定的章节 IR，不再重算原文，避免悄悄改写已锁定的分集依据。
        if (existingState?.planDone) {
            return void res.json({
                ok: true, dramaId: folder.id, done: true, groups: [], chapters: [], model: "",
                planCursor: existingState.planCursor, planDone: true, lastChapterIndex: existingState.lastChapterIndex,
                message: "全部分集已完成，不能再修改分集方式或分集结果",
            });
        }
        // 首次预览会落稳定章节 ID 与游标状态（基础设施写入，不写分集结果、不建集）。
        const chapters = sourcedChapters(db, folder, plan);
        const state = db.getEpisodePlanningState(folder.id)!;
        const window = batchWindow(state, chapters);
        if (window.done) {
            return void res.json({
                ok: true, dramaId: folder.id, done: true, groups: [], chapters: [], model: "",
                planCursor: state.planCursor, planDone: true, lastChapterIndex: state.lastChapterIndex,
                message: "全部分集已完成，不能再修改分集方式或分集结果",
            });
        }
        const episodes = db.listDramaEpisodes(folder.id);
        const startNumber = episodes.reduce((max, item) => Math.max(max, item.episodeNumber), 0) + 1;
        const previousCliffhanger = plan.modelEpisodeGroups.at(-1)?.cliffhanger || "";
        try {
            const result = await proposeEpisodeGrouping(stores, {
                name: String(folder.name || ""),
                chapters: window.chapters.map(groupingChapter),
                startNumber,
                previousCliffhanger,
                model: parsed.data.model,
                instruction: parsed.data.instruction,
            });
            // 候选只返回：不写分集快照、不建集；只有游标/章节 IR 落库，供稳定 ID 复用。
            res.json({
                ok: true, dramaId: folder.id, model: result.model, done: false,
                batch: {
                    cursor: state.planCursor, nextCursor: window.nextCursor,
                    lastChapterIndex: state.lastChapterIndex, chars: window.chars,
                    maxChapters: Math.min(state.batchChapters, PLAN_BATCH_MAX_CHAPTERS),
                    maxChars: Math.min(state.batchChars, PLAN_BATCH_MAX_CHARS),
                    remainingChapters: chapters.filter((chapter) => chapter.chapterIndex >= window.nextCursor).length,
                },
                chapters: window.chapters.map((chapter) => ({ index: chapter.chapterIndex, id: chapter.id, title: chapter.title, chars: chapter.body.length })),
                groups: result.groups,
            });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post<Record<string, string>>(`${base}/episode-grouping-auto`, async (req, res) => {
        const parsed = episodeGroupingPreviewSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        // 客户端提前断开时只中断「当前批次」的 LLM 调用；已提交批次完整保留，可再次触发续跑。
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableEnded) controller.abort(); });
        const outcome = await autoPlanAllBatches(db, events, stores, String(req.params.dramaId), {
            model: parsed.data.model, instruction: parsed.data.instruction, signal: controller.signal,
        });
        res.status(outcome.ok ? 200 : outcome.status || 400).json(outcome);
    });

    router.post<Record<string, string>>(`${base}/episode-grouping-apply`, (req, res) => {
        const parsed = episodeGroupingApplySchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") });
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const commit = commitGroupingBatch(db, events, folder, parsed.data.groups, parsed.data.expectedUpdatedAt);
        if (!commit.ok) return void res.status(commit.status).json({ ok: false, error: commit.error });
        res.json({
            ok: true, dramaId: folder.id, replayed: commit.replayed, episodes: commit.episodes,
            groups: commit.groups, updatedAt: commit.updatedAt, planCursor: commit.planCursor,
            planDone: commit.planDone, lastChapterIndex: commit.lastChapterIndex,
        });
    });
}

export const scriptBodySchema = z.object({
    model: z.string().trim().max(200).optional(),
    instruction: z.string().trim().max(2000).optional(),
    // 影策制作设置：钩子/悬念作为用户倾向引导分场生成，思考等级透传文本模型。
    hook: z.string().trim().max(500).optional(),
    cliffhanger: z.string().trim().max(500).optional(),
    reasoningEffort: z.string().trim().max(50).optional(),
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
        // 改编真值优先取本集覆盖章节的正文（按章编辑后手动「重新改编」立即生效），
        // 无章映射的老剧目回退整份 sourceScript。
        let episodeSource = "";
        try {
            const chapterTexts = db.listEpisodeChapters(episode.id)
                .map((chapter) => String(chapter?.body || "").trim())
                .filter(Boolean);
            if (chapterTexts.length) episodeSource = chapterTexts.join("\n\n");
        } catch { /* 无章映射时回退整份原文 */ }
        if (!episodeSource) episodeSource = plan.sourceScript;
        try {
            // 影策制作设置真生效：把用户指定的钩子/悬念倾向合进 instruction（作为补充要求引导分场），
            // 思考等级随请求透传给 proposeEpisodeScript（不再写死 auto）。
            const instructionBits = [parsed.data.instruction];
            if (parsed.data.hook?.trim()) instructionBits.push(`开场钩子倾向：${parsed.data.hook.trim()}`);
            if (parsed.data.cliffhanger?.trim()) instructionBits.push(`结尾悬念倾向：${parsed.data.cliffhanger.trim()}`);
            // 剧本类长期规则进手动「重新改编本集」；自动流水线也读同一份规则（pipeline.ts）。
            const scriptRules = await learnedRulesCompact(["script"], 1200);
            if (scriptRules) instructionBits.unshift(scriptRules);
            const instruction = instructionBits.filter(Boolean).join("\n").slice(0, 2000);
            const result = await proposeEpisodeScript(stores, {
                episodeNumber: episode.episodeNumber,
                title: String(episode.title || ""),
                synopsis: String(episode.synopsis || ""),
                outline: String(folder.outline || ""),
                worldContext: plan.outlineDetail.worldContext,
                threeActs: plan.outlineDetail.threeActs,
                ending: plan.outlineDetail.ending,
                source: episodeSource,
                previousTail,
                model: parsed.data.model,
                instruction,
                reasoningEffort: parsed.data.reasoningEffort,
            });
            // 生成出的钩子/悬念顺手写进导演源稿；这是尽力而为的增强，失败不能挡住分场文本返回。
            if (result.hook || result.cliffhanger) {
                try {
                    const service = new EpisodeProductionService(db);
                    const current = service.get(episode.id);
                    await service.edit(episode.id, {
                        operationId: randomUUID(),
                        expectedRevision: current.revision,
                        ops: [{ type: "set_director_story_beats", hook: result.hook, cliffhanger: result.cliffhanger }],
                    });
                } catch (beatsError) {
                    console.warn(`[script-proposal] 写入 hook/cliffhanger 失败（episode=${episode.id}）：`, beatsError instanceof Error ? beatsError.message : beatsError);
                }
            }
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
    episodeMode: z.enum(["auto", "chapter"]).optional(),
    modelEpisodeGroups: z.array(modelEpisodeGroupSchema).optional(),
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
        const planning = db.getEpisodePlanningState(folder.id);
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
            episodeMode: plan.episodeMode || "chapter",
            modelEpisodeGroups: plan.modelEpisodeGroups,
            planCursor: planning?.planCursor ?? 0,
            planDone: planning?.planDone ?? false,
            lastChapterIndex: planning?.lastChapterIndex ?? 0,
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
        const planning = db.getEpisodePlanningState(folder.id);
        if (planning?.planDone && (patch.episodeMode !== undefined || patch.modelEpisodeGroups !== undefined || patch.sourceScript !== undefined)) {
            return void res.status(409).json({ ok: false, error: "分集已完成，不能修改分集方式或分集结果" });
        }
        if ((planning?.planCursor ?? 0) > 0 && patch.sourceScript !== undefined) {
            return void res.status(409).json({ ok: false, error: "分集已开始规划，不能修改原剧本（否则稳定章节 ID 会漂移）" });
        }
        const plan = dramaProductionPlanSchema.parse({
            ...current,
            ...(patch.outlineModel === undefined ? {} : { outlineModel: patch.outlineModel }),
            ...(patch.sourceScript === undefined ? {} : { sourceScript: patch.sourceScript }),
            ...(patch.episodeMode === undefined ? {} : { episodeMode: patch.episodeMode }),
            ...(patch.modelEpisodeGroups === undefined ? {} : { modelEpisodeGroups: patch.modelEpisodeGroups }),
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
            if (patch.episodeMode !== undefined) db.setEpisodePlanningMode(folder.id, patch.episodeMode);
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
