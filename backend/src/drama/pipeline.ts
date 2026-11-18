/**
 * 全自动流水线编排器（对齐影策 django drama_orchestrator.go 的七段机 + release worker）。
 *
 * 设计约束（全部读现有源码确认过真实调用形状，不猜）：
 * - 持久化完全走 PipelineStore（独立 SQLite 连接 runtime.sqlite 的 drama_pipelines /
 *   drama_pipeline_jobs / drama_pipeline_events 三表，DDL 在 database-schema.ts）。
 * - 所有业务能力通过 HTTP 自调用后端现成路由（Bearer token），不新增 provider：
 *     GET  /drama/projects/:dramaId/episodes            (server.ts:1104)
 *     GET  /drama/:dramaId/stage                        (drama-planning-routes.ts:248)
 *     POST /drama/episodes/:eid/script-proposal         (drama-planning-routes.ts:79)
 *     PATCH /drama/episodes/:eid  {synopsis}            (server.ts:1277)
 *     GET/POST /drama/episodes/:eid/production[/ops]    (drama-production-routes.ts:240/359)
 *     POST .../production/{publish,compile,apply-compilation,prepare-targets,sync-clips}
 *     GET  .../production/compilations/:op              (drama-production-routes.ts:129)
 *     GET  .../production/readiness                     (drama-production-routes.ts:280)
 *     POST /canvas/generation  (canvasGenerationCommandSchema, generation-contract.ts:67)
 *     GET  /tasks/:id          (server.ts:2074, CANVAS_TASK_ROUTE)
 *     GET/POST /canvas/projects/:id[/ops]               (server.ts:618/895)
 *     POST /agent/video-concat/tasks                    (agent-runtime-routes.ts:16)
 *     GET  /agent/runtime/tasks/:id                     (agent-runtime-routes.ts:29)
 * - prompt 构造 / 解析复用 canvas-agent 的纯函数（chapter-demand / chapter-storyboard /
 *   asset-extract / segment-writer），它们已被 package.json exports 到 dist，后端可直接 import。
 * - 画布段 id ≠ 制作段 id：靠 H3 节点 metadata.segments[].productionClipProjection.targetId
 *   反查 nodeId + canvas segment id（见 cross-app-ui-parity.md「P1 段提示词」）。
 *
 * 这里不写任何 route、不改 index.ts、不改 store。
 */
import { randomUUID } from "node:crypto";
import {
    buildChapterDemandPrompt,
    fallbackChapterDemand,
    parseChapterDemand,
    type ChapterDemandEnvironment,
} from "@basketikun/canvas-agent/drama/chapter-demand";
import {
    planChapterStoryboard,
    toSceneStoryboardOps,
    type ChapterScenePlan,
} from "@basketikun/canvas-agent/drama/chapter-storyboard";
import {
    buildAssetExtractPrompt,
    fallbackAssetExtract,
    parseAssetExtract,
} from "@basketikun/canvas-agent/drama/asset-extract";
import {
    buildSegmentWriterPrompt,
    cleanWrittenPrompt,
    type SegmentWriterInput,
    type SegmentWriterShot,
} from "@basketikun/canvas-agent/drama/segment-writer";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";

import { PipelineStore, type JobRow, type PipelineRow } from "./pipeline-store.js";
import { findPipelineAssetEntityNode, generatedMediaStorageKey } from "./pipeline-asset-image.js";

// ── 常量 ─────────────────────────────────────────────────────────────────
const DEFAULT_BASE_URL = "http://127.0.0.1:17370";
const TICK_MS = 3000;
const LEASE_TTL_MS = 2 * 60 * 1000;
const HTTP_TIMEOUT_MS = 180_000; // LLM 生成类请求常需 30-90s；20s 会误 abort（This operation was aborted）。
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const TASK_POLL_MS = 1200;
const DEFAULT_POOL_LIMIT = 4;
const DEFAULT_GLOBAL_LIMIT = 16;
/** 资产参考图并发上限：本地 engine-image 单张约 60-90s，2 路并发兼顾速度与显存。 */
const ASSET_IMAGE_CONCURRENCY = 2;
const MAX_JOBS_PER_TICK = 32;
const MAX_ATTEMPTS = 3;
const SAMPLE_EVERY = 3;

/** 影策七段机；queued/done 是边界，真正入队的作业阶段是 script/assets/prompts/video/render。 */
export const PIPELINE_STAGES = ["queued", "script", "assets", "prompts", "review", "video", "render", "done"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

type StageJob = { stage: string; kind: JobKind };
type JobKind = "script" | "assets" | "prompts" | "video" | "render";
type PoolName = "text" | "image" | "video" | "render";

/** 入队顺序即阶段顺序（review 是闸门、不建作业）。 */
const STAGE_JOBS: StageJob[] = [
    { stage: "script", kind: "script" },
    { stage: "assets", kind: "assets" },
    { stage: "prompts", kind: "prompts" },
    { stage: "video", kind: "video" },
    { stage: "render", kind: "render" },
];

/** 每个作业阶段的前置阶段（严格保序；auto 只跳过审批闸门，不跳过真实前置作业）。 */
const STAGE_REQUIRES: Record<string, string[]> = {
    script: [],
    assets: ["script"],
    prompts: ["assets"],
    video: ["prompts"],
    render: ["video"],
};

const POOL_OF_KIND: Record<JobKind, PoolName> = {
    script: "text",
    assets: "text",
    prompts: "text",
    video: "video",
    render: "render",
};

const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

// ── 闸门（纯函数，对齐影策 sample/media/approve 三闸门） ───────────────────

/** sample 模式只抽检：每 SAMPLE_EVERY 集落一次闸门；auto/every 不在这里判定。 */
export function sampleBlocked(reviewMode: string, episodeNumber: number): boolean {
    if (reviewMode === "auto" || reviewMode === "every") return false;
    return reviewMode === "sample" && episodeNumber > 0 && episodeNumber % SAMPLE_EVERY === 0;
}

/** media 模式非 auto 且未放行目标（assets/all/某集）时挡住对应作业。 */
export function mediaHeld(mediaMode: string, released: Set<string>, target: string): boolean {
    if (mediaMode === "auto") return false;
    return !released.has("all") && !released.has(target);
}

/** 是否需要人工 approve：auto 全放行；every 全部要；sample 只抽检集要。 */
export function needsReview(
    reviewMode: string,
    episodeNumber: number,
    approved: Set<string>,
    episodeId: string,
): boolean {
    if (reviewMode === "auto" || approved.has("all") || approved.has(episodeId)) return false;
    if (reviewMode === "every") return true;
    return sampleBlocked(reviewMode, episodeNumber);
}

// ── 编排器 ───────────────────────────────────────────────────────────────

export type DramaPipelineOptions = {
    store: PipelineStore;
    token: string;
    baseUrl?: string;
    /** 文本模型解析（从后端 ai.config 读），generateText 每次调用时取最新值。 */
    resolveTextModel?: () => string;
    /** 资产参考图默认模型解析（ai.config.imageModel）；制作设置 imageModelsByKind 可逐类型覆盖。 */
    resolveImageModel?: () => string;
    /** 全局并发上限（默认 16）。 */
    poolLimit?: number;
    /** 全局并发上限（默认 16）。 */
    globalLimit?: number;
};

/** 制作设置按剧目下发的运行期选项（与影策制作台设置页一一对应；不落 pipeline SQLite，重启后需重新下发）。 */
export type DramaPipelineRuntimeOptions = {
    /** 文字步骤模型（拆镜/提取/提示词），覆盖后端全局文本模型。 */
    storyboardModel?: string;
    assetExtractModel?: string;
    videoPromptModel?: string;
    /** 每步思考等级，写进 /canvas/generation 的 params.reasoningEffort。 */
    textThinking?: { storyboard?: string; extract?: string; prompt?: string };
    /** 段视频自选模型（写进 H3 节点 params.selectedVideoModel）。 */
    videoModel?: string;
    /** 参考图模型按资产类型写入各集 production.settings.imageModelsByKind。 */
    imageModelsByKind?: { character?: string; scene?: string; prop?: string };
    /** 每段最多参考图上限（H3 契约硬上限内收窄，0=不限制）。 */
    referenceLimit?: number;
    /** 并行出片：各段独立、不带尾帧首帧。 */
    independent?: boolean;
    /** 分镜规则（软约束并入拆镜/提示词 prompt）。 */
    storyboardRules?: {
        episodeSeconds?: number;
        segmentRange?: { min: number; max: number };
        dialogueDensity?: string;
        transitionMode?: string;
        transitionMs?: number;
        pacing?: string;
    };
    /** 各池并发上限（覆盖构造期默认；池名 text/video/render）。 */
    concurrency?: { text?: number; video?: number; render?: number };
};

export type DramaPipelineStartOpts = {
    reviewMode: "auto" | "sample" | "every";
    mediaMode: "auto" | "manual";
    /** 制作设置：可选的逐剧目运行期覆盖。 */
    options?: DramaPipelineRuntimeOptions;
};

export class DramaPipeline {
    private readonly store: PipelineStore;
    private readonly token: string;
    private readonly baseUrl: string;
    private readonly poolLimit: number;
    private readonly globalLimit: number;
    private readonly resolveTextModel?: () => string;
    private readonly resolveImageModel?: () => string;

    private timer: ReturnType<typeof setInterval> | null = null;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly leases = new Map<string, number>();
    /** 每 tick 的即时唤醒去重。 */
    private ticking = false;

    private readonly poolRunning: Record<PoolName, number> = { text: 0, image: 0, video: 0, render: 0 };
    private active = 0;

    /** `${dramaId}::${episodeId}` / `all` 的人工放行集合。 */
    private readonly approvals = new Map<string, Set<string>>();
    /** dramaId → 已放行的 media target 集合（assets / all / episodeId）。 */
    private readonly releasedMedia = new Map<string, Set<string>>();
    /** dramaId → 制作设置下发的运行期选项（模型/思考等级/视频模型/并发等）。 */
    private readonly runOptions = new Map<string, DramaPipelineRuntimeOptions>();
    /** 失败退避：jobId → 最早可再次领取的时间戳。 */
    private readonly retryAt = new Map<string, number>();

    constructor(options: DramaPipelineOptions) {
        this.store = options.store;
        this.token = options.token;
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
        this.poolLimit = Math.max(1, options.poolLimit ?? DEFAULT_POOL_LIMIT);
        this.globalLimit = Math.max(this.poolLimit, options.globalLimit ?? DEFAULT_GLOBAL_LIMIT);
        this.resolveTextModel = options.resolveTextModel;
        this.resolveImageModel = options.resolveImageModel;
    }

    // ── 生命周期 ────────────────────────────────────────────────────────

    /**
     * 确保剧目 topic（theme/logline）已填——create_manual_director_asset 建档要求，
     * topic 空会让 assets 段全部卡 queued。基于剧目真实 outline/name 补一个兜底主题，
     * 不造假数据：theme 取剧名，logline 取大纲首句。
     */
    private async ensureTopic(dramaId: string): Promise<void> {
        try {
            const info = await this.request("GET", `/drama/${encodeURIComponent(dramaId)}/planning`);
            const topic = (info?.topic || {}) as Record<string, any>;
            const name = String(info?.name || dramaId || "短剧");
            const outline = String(info?.outline || "").trim();
            const firstLine = outline.split(/[\n。！？；]/).map(s => s.trim()).find(Boolean) || name;
            const patch: Record<string, unknown> = {};
            if (!String(topic.theme || "").trim()) patch.theme = name;
            if (!Array.isArray(topic.themes) || !topic.themes.length) patch.themes = [name];
            if (!String(topic.logline || "").trim()) patch.logline = firstLine.slice(0, 200);
            if (Object.keys(patch).length) {
                await this.request("PATCH", `/drama/${encodeURIComponent(dramaId)}/planning`, { topic: patch });
                this.store.log(dramaId, "自动补齐剧目 topic（theme/logline），资产建档前置条件已就绪");
            }
        } catch (error) {
            this.store.log(dramaId, `补齐 topic 失败（不阻断）：${errText(error)}`, "warn");
        }
    }

    /** 读取某剧目制作设置；不存在时返回空对象（各消费点自行回退默认）。 */
    optionsOf(dramaId: string): DramaPipelineRuntimeOptions {
        return this.runOptions.get(dramaId) || {};
    }

    /** 某剧目某池的并发上限：制作设置覆盖 > 构造期默认。 */
    private poolLimitOf(dramaId: string, pool: PoolName): number {
        const configured = Number(this.optionsOf(dramaId).concurrency?.[pool as "text" | "video" | "render"] || 0);
        if (configured >= 1 && configured <= 16) return configured;
        return this.poolLimit;
    }

    async start(dramaId: string, opts: DramaPipelineStartOpts): Promise<Record<string, unknown>> {
        await this.ensureTopic(dramaId);
        if (opts?.options) this.runOptions.set(dramaId, opts.options);
        const row = this.store.upsert({
            dramaId,
            status: "running",
            reviewMode: opts?.reviewMode || "auto",
            mediaMode: opts?.mediaMode || "auto",
        });
        this.store.log(dramaId, `流水线启动 review=${opts?.reviewMode || "auto"} media=${opts?.mediaMode || "auto"}${opts?.options ? ` · 制作设置已下发(${Object.keys(opts.options).length}项)` : ""}`);
        // 参考图模型按资产类型批量写入各集制作稿（真实落点：canvas-inputs.ts 按 imageModelsByKind 取模型）。
        // 不阻塞 start 返回：后台逐集 CAS 写入，失败只记日志。
        if (opts?.options?.imageModelsByKind && Object.keys(opts.options.imageModelsByKind).length) {
            void this.applyImageModels(dramaId, opts.options.imageModelsByKind);
        }
        try {
            await this.plan(dramaId);
        } catch (error) {
            this.store.log(dramaId, `首次编排失败：${errText(error)}`, "warn");
        }
        this.wake(dramaId);
        return { dramaId, status: row.status, reviewMode: row.review_mode, mediaMode: row.media_mode, queued: this.store.listJobs(dramaId, ["queued"]).length };
    }

    startLoop(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
        this.wake();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
        this.leases.clear();
    }

    /** 立即唤醒（清掉该剧目的 lease，让下一个 tick 真的跑）；不传 dramaId 则唤醒全部。 */
    wake(dramaId?: string): void {
        if (dramaId) this.leases.delete(dramaId);
        else this.leases.clear();
        if (this.wakeTimer) clearTimeout(this.wakeTimer);
        this.wakeTimer = setTimeout(() => { void this.tick(); }, 0);
    }

    // ── 调度循环 ────────────────────────────────────────────────────────

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = Date.now();
            for (const pipeline of this.store.running()) {
                const last = this.leases.get(pipeline.drama_id) || 0;
                if (now - last < LEASE_TTL_MS) continue;
                this.leases.set(pipeline.drama_id, now);
                try {
                    await this.plan(pipeline.drama_id, pipeline);
                    this.dispatch(pipeline);
                    this.store.touch(pipeline.drama_id);
                } catch (error) {
                    this.store.log(pipeline.drama_id, `tick 失败：${errText(error)}`, "error");
                }
            }
        } finally {
            this.ticking = false;
        }
    }

    /** 幂等编排：读全部分集，按七段机把各阶段作业 dedupe 入队。 */
    async plan(dramaId: string, pipeline?: PipelineRow): Promise<void> {
        const row = pipeline || this.store.get(dramaId);
        if (!row || row.status !== "running") return;

        // 阶段信号：HTTP 派生 stage API 仅用于日志/可观测，入队真值以 PipelineStore job 成功记录为准
        // （store.enqueue 用 dedupe_key 去重，天然幂等，重跑不会堆重复作业）。
        try {
            const stage = await this.request("GET", `/drama/${encodeURIComponent(dramaId)}/stage`);
            const states = stage?.states;
            if (states) this.store.log(dramaId, `阶段信号：${JSON.stringify(states).slice(0, 400)}`);
        } catch {
            // stage API 失败不阻断编排。
        }

        const listing = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
        const episodes: Array<Record<string, any>> = Array.isArray(listing?.episodes) ? listing.episodes : [];
        for (const ep of episodes) {
            const episodeId = String(ep?.id || "");
            if (!episodeId) continue;
            for (const { stage: stageName, kind } of STAGE_JOBS) {
                const dedupeKey = `${dramaId}:${episodeId}:${stageName}`;
                this.store.enqueue({
                    id: dedupeKey,
                    dramaId,
                    episodeId,
                    kind,
                    stage: stageName,
                    // 低 priority 值 = 早阶段优先（script 先于 render）。
                    priority: STAGE_JOBS.length - 1 - STAGE_JOBS.findIndex(item => item.stage === stageName),
                    dedupeKey,
                    label: `第${Number(ep.episodeNumber || 0) || "?"}集 · ${stageName}`,
                    payload: { episodeId, episodeNumber: Number(ep.episodeNumber || 0) },
                });
            }
        }
    }

    /** 按 4 池并发上限领取并执行 job；严格保序 + 闸门 + 退避。 */
    private dispatch(pipeline: PipelineRow): void {
        const dramaId = pipeline.drama_id;
        const approvals = this.approvals.get(dramaId) || new Set<string>();
        const released = this.releasedMedia.get(dramaId) || new Set<string>();

        for (let loops = 0; loops < MAX_JOBS_PER_TICK; loops += 1) {
            if (this.active >= this.globalLimit) break;
            const queued = this.store.listJobs(dramaId, ["queued"]);
            const next = queued.find(item => this.jobAllowed(pipeline, item, approvals, released)
                && Boolean(POOL_OF_KIND[item.kind as JobKind])
                && this.poolRunning[POOL_OF_KIND[item.kind as JobKind]] < this.poolLimitOf(dramaId, POOL_OF_KIND[item.kind as JobKind]));
            if (!next) break;

            const pool = POOL_OF_KIND[next.kind as JobKind] || "text";

            const job = this.store.claimById(next.id);
            if (!job) break;
            this.launchJob(pipeline, job);
        }
    }

    private jobAllowed(pipeline: PipelineRow, job: JobRow, approvals: Set<string>, released: Set<string>): boolean {
        const retryAt = this.retryAt.get(job.id) || 0;
        if (Date.now() < retryAt) return false;

        const payload = this.store.jobPayload(job);
        const episodeId = String(payload.episodeId || job.episode_id || "");
        const episodeNumber = Number(payload.episodeNumber || 0);

        // 前置阶段必须全部 succeeded（auto 只跳过审批闸门，不跳过真实作业）。
        for (const required of STAGE_REQUIRES[job.stage] || []) {
            const upstream = this.store.listJobs(pipeline.drama_id, ["succeeded"])
                .find(item => item.episode_id === episodeId && item.stage === required);
            if (!upstream) return false;
        }

        // 审批闸门：video 需要 approve；assets 受 media 闸门；render 受 media 闸门。
        if (job.stage === "video" && needsReview(pipeline.review_mode, episodeNumber, approvals, episodeId)) return false;
        if (job.stage === "assets" && mediaHeld(pipeline.media_mode, released, "assets")) return false;
        if (job.stage === "render" && mediaHeld(pipeline.media_mode, released, "all")) return false;
        return true;
    }

    /** 执行一条 job（异步），统一计数 / succeed / log / fail + 退避重试。 */
    private launchJob(pipeline: PipelineRow, job: JobRow): void {
        const pool = POOL_OF_KIND[job.kind as JobKind] || "text";
        this.poolRunning[pool] += 1;
        this.active += 1;
        this.store.log(pipeline.drama_id, `开始 ${job.stage}/${job.kind} (${job.id}) attempt=${job.attempt}`, "info", job.episode_id, job.id);

        void this.execute(job).then(
            (result) => {
                this.store.succeed(job.id, result || {});
                this.store.log(pipeline.drama_id, `完成 ${job.stage}/${job.kind} (${job.id})`, "info", job.episode_id, job.id);
                this.retryAt.delete(job.id);
                this.wake(pipeline.drama_id);
            },
            (error) => {
                const message = errText(error);
                this.store.fail(job.id, message);
                this.store.log(pipeline.drama_id, `失败 ${job.stage}/${job.kind} (${job.id})：${message}`, "error", job.episode_id, job.id);
                if (job.attempt < MAX_ATTEMPTS) {
                    this.store.requeue(job.id);
                    this.retryAt.set(job.id, Date.now() + this.backoffMs(job.attempt));
                }
                this.wake(pipeline.drama_id);
            },
        ).finally(() => {
            this.poolRunning[pool] = Math.max(0, this.poolRunning[pool] - 1);
            this.active = Math.max(0, this.active - 1);
        });
    }

    private backoffMs(attempt: number): number {
        if (attempt <= 1) return 5_000;
        if (attempt === 2) return 30_000;
        return 2 * 60 * 1000;
    }

    // ── job 分派 ────────────────────────────────────────────────────────

    private async execute(job: JobRow): Promise<Record<string, unknown>> {
        const payload = this.store.jobPayload(job);
        const episodeId = String(payload.episodeId || job.episode_id || "");
        if (!episodeId) throw new Error("JOB_EPISODE_MISSING: 作业缺少分集 ID");

        const dramaId = String(job.drama_id || "");
        switch (job.kind as JobKind) {
            case "script": return this.runScript(episodeId, dramaId);
            case "assets": return this.runAssets(episodeId, dramaId);
            case "prompts": return this.runPrompts(episodeId, dramaId);
            case "video": return this.runVideo(episodeId, job);
            case "render": return this.runRender(episodeId, job);
            default: throw new Error(`UNKNOWN_JOB_KIND: ${job.kind}`);
        }
    }

    /** script 段：script-proposal → 写 synopsis → 文本 LLM 拆镜 → production/ops → 编译链。 */
    private async runScript(episodeId: string, dramaId: string): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const episode = episodeRes?.episode as Record<string, any> | undefined;
        if (!episode) throw new Error("EPISODE_NOT_FOUND");

        // 1) 单集分场剧本（后端路由已自动把 hook/cliffhanger 写回导演源稿）。
        //    梗概(自然语言) 与 分场脚本 分离：synopsis 存梗概(对齐影策)，fullPlot 存分场正文(供集间承接/原文对照兜底)。
        const proposal = await this.request("POST", `/drama/episodes/${encodeURIComponent(episodeId)}/script-proposal`, {});
        const text = String(proposal?.text || "").trim();
        if (!text) throw new Error("SCRIPT_PROPOSAL_EMPTY: 改编没有返回分场文本");
        const synopsis = String(proposal?.synopsis || "").trim();

        // 2) 写回：synopsis=自然语言梗概（缺省回退分场文本）；fullPlot=分场正文。
        await this.request("PATCH", `/drama/episodes/${encodeURIComponent(episodeId)}`, {
            synopsis: synopsis || text,
            fullPlot: text,
        });

        // 3) 结构化拆镜草案（prompt 参考 buildChapterDemandPrompt + parseChapterDemand）。
        let production = (await this.getProduction(episodeId)).production as any;
        let source = production?.draft?.director?.source || {};
        let scenes = productionSceneEntries(source) as Array<{ id: string; environmentId: string; title: string; shotIds: string[] }>;
        if (!scenes.length) {
            // 空稿先初始化出场次（initialize_director_from_demand 只吃空壳稿；已有场景必须跳过）。
            production = (await this.productionOps(episodeId, production.revision, [{ type: "initialize_director_from_demand" }])).production;
            source = production?.draft?.director?.source || {};
            scenes = productionSceneEntries(source) as typeof scenes;
        }
        if (!scenes.length) throw new Error("DIRECTOR_NO_SCENE: 初始化后仍没有场次，无法拆镜");
        // 已有镜头（拆过镜）的集重跑 script 时跳过拆镜——replace_director_scene_storyboard
        // 对已有场景要求保留原 Clip ID 集合，重复提交会报 SCENE_STORYBOARD_SEGMENTS。
        const existingShots = (Array.isArray(source.shots) ? source.shots : []).length;
        if (existingShots > 0) {
            await this.promoteToCanvas(episodeId);
            return { shots: existingShots, segments: (Array.isArray(source.segments) ? source.segments : []).length, skipped: true };
        }
        const environments: ChapterDemandEnvironment[] = scenes.map(scene => ({ id: scene.environmentId, name: scene.title }));
        const environmentOfScene = new Map<string, string>(scenes.map(scene => [scene.environmentId, scene.id]));

        const opts = this.optionsOf(dramaId);
        const rules = opts.storyboardRules || {};
        // 分镜规则软约束：把单集时长/段时长/对白密度/转场/节奏并入拆镜 prompt 的 chapterBody
        // （canvas-agent 的 ChapterDemandPromptInput 无这些字段，用文本注入避免改契约/dist）。
        const ruleLines: string[] = [];
        if (rules.episodeSeconds) ruleLines.push(`本集时长约 ${rules.episodeSeconds} 秒。`);
        if (rules.segmentRange) ruleLines.push(`每个剧情段控制在 ${rules.segmentRange.min}-${rules.segmentRange.max} 秒。`);
        if (rules.dialogueDensity && rules.dialogueDensity !== "standard") {
            ruleLines.push(`对白密度：${{ dense: "密集，多场对话", restrained: "克制，少对白多动作", custom: "按剧情需要" }[rules.dialogueDensity] || rules.dialogueDensity}。`);
        }
        if (rules.transitionMode && rules.transitionMode !== "smart") {
            ruleLines.push(`场景衔接：${{ hard: "硬切", fade: "黑场过渡", flash: "闪白" }[rules.transitionMode] || rules.transitionMode}${rules.transitionMs ? `（约 ${rules.transitionMs}ms）` : ""}。`);
        }
        if (rules.pacing && rules.pacing !== "标准") ruleLines.push(`整体节奏：${rules.pacing}。`);
        const demandPrompt = buildChapterDemandPrompt({
            chapterTitle: String(episode.title || ""),
            chapterBody: ruleLines.length ? `${text}\n\n【制作设置·分镜要求】${ruleLines.join("")}` : text,
            environments,
        });
        const storyboardText = await this.generateText([demandPrompt.system, "", demandPrompt.user].join("\n"), {
            model: opts.storyboardModel,
            reasoningEffort: opts.textThinking?.storyboard,
        });
        let draft: { demand: string; scenes: ChapterScenePlan[] };
        try {
            draft = parseChapterDemand(storyboardText, { environments });
        } catch {
            draft = fallbackChapterDemand({
                chapterTitle: String(episode.title || ""),
                chapterBody: text,
                environmentId: environments[0]?.id || "",
                sceneName: environments[0]?.name,
            });
        }

        const plan = planChapterStoryboard({
            chapterId: episodeId,
            scenes: draft.scenes,
            fps: this.fpsOf(source),
            // 对齐影策：剧情段目标 8–15 秒（影策真实段多为 10–11 秒），不再用旧的 5 秒。
            clipSeconds: 10,
        });
        const ops = toSceneStoryboardOps(plan, environmentOfScene);
        production = (await this.productionOps(episodeId, production.revision, ops as Record<string, unknown>[])).production;

        // 4) 发布 → 编译 → 应用 → 再发布 → 准备节点 → 同步 Clip（缺一步画布都不出 H3 节点）。
        await this.promoteToCanvas(episodeId);
        return { shots: plan.shots.length, segments: plan.segments.length, diagnostics: plan.diagnostics.slice(0, 20) };
    }

    /**
     * assets 段：文本 LLM 提取设定 → create_manual_director_asset 建档 → 逐资产真实出图并写回。
     *
     * 建档只让 director.assets[id] 停在 planned；这里为没有 storageKey 的资产走
     * POST /canvas/generation(mode:image) 生成真实参考图，再 POST bind-image 写回制作稿与实体节点。
     * 幂等（已有 storageKey 跳过），并发受限，单资产失败只记日志不阻断整集。
     */
    private async runAssets(episodeId: string, dramaId: string): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const episode = episodeRes?.episode as Record<string, any> | undefined;
        if (!episode) throw new Error("EPISODE_NOT_FOUND");
        const synopsis = String(episode.synopsis || "").trim();
        if (!synopsis) throw new Error("ASSETS_NO_SYNOPSIS: 分集还没有剧本，资产提取跳过");

        const assetPrompt = buildAssetExtractPrompt({
            chapterTitle: String(episode.title || ""),
            synopsis,
        });
        const assetOpts = this.optionsOf(dramaId);
        const raw = await this.generateText([assetPrompt.system, "", assetPrompt.user].join("\n"), {
            model: assetOpts.assetExtractModel,
            reasoningEffort: assetOpts.textThinking?.extract,
        });
        let assets;
        try { assets = parseAssetExtract(raw); }
        catch { assets = fallbackAssetExtract({ chapterTitle: String(episode.title || ""), synopsis }); }
        if (!assets.length) throw new Error("ASSETS_EMPTY: 没有可建档的设定");

        const canvasId = String((episodeRes?.canvas as Record<string, any> | null | undefined)?.id || "");
        type PendingImage = { assetId: string; kind: string; name: string; entityId: string; prompt: string };
        const pending: PendingImage[] = [];
        let created = 0;

        for (const asset of assets) {
            // 每条重取 revision（乐观锁）；同名同类型跳过（只填空不覆盖）。
            const production = (await this.getProduction(episodeId)).production as any;
            const source = production?.draft?.director?.source || {};
            const director = production?.draft?.director || {};
            const id = `asset-${asset.kind}-${this.shortHash(`${asset.kind}:${asset.name}`)}`;
            const planRows = [...(Array.isArray(source.asset_plan) ? source.asset_plan : []), ...(Array.isArray(source.asset_cards) ? source.asset_cards : [])];
            const existingRow = planRows.find((row: any) => String(row?.id || row?.asset_id || "") === id) as Record<string, any> | undefined;
            const entityId = asset.kind === "prop" ? "" : `entity-${asset.kind}-${this.shortHash(asset.name)}`;

            if (!existingRow) {
                const op: Record<string, unknown> = {
                    type: "create_manual_director_asset",
                    assetPlan: {
                        id,
                        kind: asset.kind,
                        asset_name: asset.name,
                        ...(entityId ? { entity_id: entityId } : {}),
                        version: "v1",
                        description: asset.appearance,
                        purpose: asset.appearance,
                        depends_on: [],
                        status: "planned",
                    },
                    assetCard: {
                        id,
                        asset_id: id,
                        asset_kind: asset.kind,
                        target_skill: "im2-clean-image",
                        source_repository: "im2-image-skills",
                        asset_version: "v1",
                        prompt: asset.appearance,
                        references: [],
                        reference_policy: "none",
                    },
                };
                if (asset.kind !== "prop" && entityId) {
                    op.registryKind = asset.kind;
                    op.registryEntity = { id: entityId, name: asset.name, description: asset.appearance, appearance: asset.appearance,
                        ...(asset.voice ? { voice_description: asset.voice } : {}) };
                }
                await this.productionOps(episodeId, production.revision, [op]);
                created += 1;
            }

            // 幂等：制作稿已绑定 storageKey 的资产跳过生图（重跑不会重复烧图）。
            if (String((director.assets as Record<string, any> | undefined)?.[id]?.storageKey || "").trim()) continue;
            const prompt = String(existingRow?.prompt || asset.appearance || "").trim();
            if (!prompt) { this.store.log(dramaId, `资产 ${id} 没有可用提示词，跳过参考图生成`, "warn"); continue; }
            pending.push({ assetId: id, kind: String(asset.kind || ""), name: String(asset.name || ""), entityId, prompt });
        }

        let generated = 0;
        let imageFailed = 0;
        if (pending.length && canvasId) {
            // 建档会经 production edit 同步创建/更新 production-entity-* 节点，必须重新读画布节点。
            const project = await this.getCanvasProject(canvasId);
            const canvasNodes: Array<Record<string, any>> = Array.isArray(project?.nodes) ? project.nodes as Array<Record<string, any>> : [];
            const kindModel = assetOpts.imageModelsByKind || {};
            const defaultModel = String(this.resolveImageModel?.() || "").trim();
            this.store.log(dramaId, `资产参考图开始生成：${pending.length} 张（默认模型 ${defaultModel || "未配置"}，并发 ${ASSET_IMAGE_CONCURRENCY}）`);
            let cursor = 0;
            const worker = async () => {
                while (cursor < pending.length) {
                    const item = pending[cursor++];
                    try {
                        const key = await this.generateAssetReference(episodeId, canvasId, canvasNodes, item,
                            String(kindModel[item.kind as "character" | "scene" | "prop"] || "").trim() || defaultModel);
                        generated += 1;
                        this.store.log(dramaId, `资产 ${item.assetId} 参考图已写回：${key}`);
                    } catch (error) {
                        imageFailed += 1;
                        this.store.log(dramaId, `资产 ${item.assetId} 参考图生成失败（不阻断）：${errText(error)}`, "warn");
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(ASSET_IMAGE_CONCURRENCY, pending.length) }, worker));
        } else if (pending.length && !canvasId) {
            this.store.log(dramaId, "分集还没有画布，跳过资产参考图生成", "warn");
        }
        this.store.log(dramaId, `assets 段完成：建档 ${created} 项，参考图 ${generated} 张成功 / ${imageFailed} 张失败`);
        return { total: assets.length, created, images: generated, imageFailed };
    }

    /** 单资产真实出图 + 写回：定位实体节点 → 生图 → 轮询 → bind-image（真实 storageKey）。 */
    private async generateAssetReference(episodeId: string, canvasId: string, canvasNodes: Array<Record<string, any>>,
        item: { assetId: string; kind: string; name: string; entityId: string; prompt: string }, model: string): Promise<string> {
        if (!model) throw new Error("ASSET_IMAGE_MODEL_MISSING: 请在设置里选择图片模型（ai.config.imageModel）");
        const entity = findPipelineAssetEntityNode(canvasNodes, { kind: item.kind, name: item.name, entityId: item.entityId });
        if (!entity) throw new Error(`ASSET_IMAGE_ENTITY_MISSING: 找不到 ${item.kind}「${item.name}」的 production-entity 节点`);
        const started = await this.request("POST", "/canvas/generation", {
            mode: "image",
            projectId: canvasId,
            nodeId: entity.id,
            model,
            prompt: item.prompt,
            count: 1,
        });
        const taskId = String(started?.taskId || "");
        if (!taskId) throw new Error("ASSET_IMAGE_NO_TASK: 生图任务没有返回 taskId");
        const task = await this.waitTask(taskId, false);
        const storageKey = generatedMediaStorageKey(task);
        if (!storageKey) throw new Error(`ASSET_IMAGE_NO_MEDIA: 任务 ${taskId} 没有产出 storageKey`);
        await this.request("POST", "/drama/pipeline/assets/bind-image", {
            episodeId, assetId: item.assetId, nodeId: entity.id, storageKey, taskId,
        });
        return storageKey;
    }

    /** prompts 段：逐段文本 LLM 写提示词 → update_h3_segment 写画布 clip.prompt。 */
    private async runPrompts(episodeId: string, dramaId: string): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        if (!canvas?.id) throw new Error("EPISODE_CANVAS_MISSING: 分集还没有画布");
        const production = (await this.getProduction(episodeId)).production as any;
        const source = production?.draft?.director?.source || {};
        const fps = this.fpsOf(source);
        const shots: Array<Record<string, any>> = Array.isArray(source.shots) ? source.shots : [];
        const segments: Array<Record<string, any>> = Array.isArray(source.segments) ? source.segments : [];
        const utterances: Array<Record<string, any>> = Array.isArray(source.utterances) ? source.utterances : [];
        if (!segments.length) throw new Error("PROMPTS_NO_SEGMENTS: 制作稿还没有可写提示词的段");

        const promptOpts = this.optionsOf(dramaId);
        const promptRules = promptOpts.storyboardRules || {};
        // 分镜规则 → 段提示词的 style 软约束（与前端手动撰写同源，全自动流水线现在也读设置）。
        const ruleStyle: string[] = [];
        if (promptRules.dialogueDensity && promptRules.dialogueDensity !== "standard") {
            ruleStyle.push(`对白${{ dense: "密集", restrained: "克制", custom: "按需" }[promptRules.dialogueDensity] || promptRules.dialogueDensity}`);
        }
        if (promptRules.transitionMode && promptRules.transitionMode !== "smart") {
            ruleStyle.push(`转场${{ hard: "硬切", fade: "黑场过渡", flash: "闪白" }[promptRules.transitionMode] || promptRules.transitionMode}${promptRules.transitionMs ? `约${promptRules.transitionMs}ms` : ""}`);
        }
        if (promptRules.pacing && promptRules.pacing !== "标准") ruleStyle.push(`节奏${promptRules.pacing}`);

        const shotById = new Map(shots.map(shot => [String(shot.id), shot]));
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas.nodes) ? canvas.nodes : [];
        let written = 0;
        let skipped = 0;

        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            const segmentId = String(segment.id || "");
            // 画布段已有非空 prompt（之前写过）就跳过，避免每段重复跑 LLM（26 段串行要十几分钟）。
            const target = this.findCanvasSegment(canvasNodes, segmentId);
            if (!target) continue;
            if (target.prompt.trim()) { skipped += 1; continue; }
            const shotIds: string[] = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
            let cursor = 0;
            const writerShots: SegmentWriterShot[] = [];
            for (const shotId of shotIds) {
                const shot = shotById.get(shotId);
                if (!shot) continue;
                const durationFrames = Math.max(1, Number(shot.duration_frames || 0));
                const startSec = cursor / fps;
                cursor += durationFrames;
                const utterance = utterances.find(item => String(item?.start?.shotId || item?.shot_id || "") === shotId);
                writerShots.push({
                    startSec,
                    endSec: cursor / fps,
                    visual: String(shot.visual || ""),
                    ...(shot.camera?.description ? { camera: String(shot.camera.description) } : {}),
                    ...(utterance ? {
                        dialogue: String(utterance.text || utterance.dialogue || ""),
                        speaker: String(utterance.speaker || utterance.speakerName || ""),
                    } : {}),
                });
            }
            if (!writerShots.length) continue;

            const independent = Boolean(promptOpts.independent);
            const input: SegmentWriterInput = {
                index,
                count: segments.length,
                title: String(segment.title || `第${index + 1}段`),
                totalSec: cursor / fps,
                shots: writerShots,
                ...(index > 0 && !independent ? { previousEnding: String(segments[index - 1]?.ending || "") } : {}),
                ...(ruleStyle.length ? { style: ruleStyle.join("，") } : {}),
                firstFrame: index > 0 && !independent,
                independent,
            };
            const prompt = buildSegmentWriterPrompt(input);
            const raw = await this.generateText([prompt.system, "", prompt.user].join("\n"), {
                model: promptOpts.videoPromptModel,
                reasoningEffort: promptOpts.textThinking?.prompt,
            });
            const cleaned = cleanWrittenPrompt(raw);
            if (!cleaned) continue;

            const project = await this.getCanvasProject(canvas.id);
            await this.request("POST", `/canvas/projects/${encodeURIComponent(canvas.id)}/ops`, {
                operationId: randomUUID(),
                expectedRevision: Number(project?.revision || 0),
                operations: [{
                    type: "update_h3_segment",
                    nodeId: target.nodeId,
                    segmentId: target.segmentId,
                    patch: { prompt: cleaned },
                }],
            });
            written += 1;
        }
        if (!written && !skipped) throw new Error("PROMPTS_NOTHING_WRITTEN: 没有段提示词写回画布");
        return { segments: segments.length, written, skipped };
    }

    /** video 段：H3 runFromCurrent → 轮询 task 至终态。 */
    private async runVideo(episodeId: string, job: JobRow): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        if (!canvas?.id) throw new Error("EPISODE_CANVAS_MISSING");
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas.nodes) ? canvas.nodes : [];
        // 拆镜编译后 segments 会分散到多个 H3 节点（按场景）。必须对每个有 segment 的节点
        // 各自跑 h3-run，只处理第一个会漏掉其余节点的 Clip（之前 video 段的核心 bug）。
        const h3Nodes = canvasNodes.filter(node =>
            String(node?.type || "").includes("h3") && Array.isArray(node?.metadata?.segments) && (node.metadata.segments as any[]).length > 0);
        if (!h3Nodes.length) throw new Error("H3_NODE_MISSING: 画布没有 H3 节点，先跑 script 段完成拆镜编译");

        const videoOpts = this.optionsOf(String(job.drama_id || ""));
        const selectedVideoModel = String(videoOpts.videoModel || "").trim();
        const videoParams: Record<string, unknown> = {};
        if (selectedVideoModel) {
            videoParams.selectedVideoModelEnabled = true;
            videoParams.selectedVideoModel = selectedVideoModel;
        }
        if (videoOpts.referenceLimit && videoOpts.referenceLimit > 0) {
            videoParams.referenceLimit = videoOpts.referenceLimit;
        }
        const results: Array<Record<string, unknown>> = [];
        for (const node of h3Nodes) {
            const started = await this.request("POST", "/canvas/generation", {
                mode: "video",
                operation: "h3-run",
                projectId: canvas.id,
                nodeId: node.id,
                runFromCurrent: true,
                skipCompleted: true,
                ...(Object.keys(videoParams).length ? { params: videoParams } : {}),
            });
            const taskId = String(started?.taskId || "");
            if (!taskId) throw new Error(`H3_RUN_NO_TASK: 节点 ${node.id}`);
            this.store.markRunning(job.id, taskId);
            const task = await this.waitTask(taskId, false);
            results.push({ nodeId: node.id, taskId, status: task?.status, result: task?.result || null });
        }
        return { nodes: h3Nodes.length, results };
    }

    /** render 段：收集各段视频 storageKey → video-concat → finalResource 写回制作稿。 */
    private async runRender(episodeId: string, job: JobRow): Promise<Record<string, unknown>> {
        const episodeRes = await this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}`);
        const canvas = (episodeRes?.canvas || null) as Record<string, any> | null;
        const canvasNodes: Array<Record<string, any>> = Array.isArray(canvas?.nodes) ? canvas!.nodes : [];
        const videos: string[] = [];
        for (const node of canvasNodes) {
            const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [];
            for (const segment of segments) {
                const key = String(segment?.resultStorageKey || "");
                if (key) videos.push(key);
                for (const result of (Array.isArray(segment?.results) ? segment.results : [])) {
                    const rk = String(result?.storageKey || "");
                    if (rk) videos.push(rk);
                }
            }
        }
        const unique = [...new Set(videos)].filter(Boolean);
        if (!unique.length) throw new Error("RENDER_NO_VIDEO: 画布还没有可用的分镜视频 storageKey");

        const started = await this.request("POST", "/agent/video-concat/tasks", {
            videos: unique,
            layout: "sequence",
            longEdge: "auto",
        });
        const taskId = String(started?.task?.id || started?.taskId || "");
        if (!taskId) throw new Error("VIDEO_CONCAT_NO_TASK");
        this.store.markRunning(job.id, taskId);
        const task = await this.waitTask(taskId, true);
        const storageKey = String(task?.result?.media?.storageKey || task?.result?.storageKey || task?.result?.media?.url || "");
        if (!storageKey) throw new Error("VIDEO_CONCAT_NO_RESULT: 合成任务没有产出 storageKey");

        const production = (await this.getProduction(episodeId)).production as any;
        await this.productionOps(episodeId, production.revision, [{
            type: "set_director_workflow",
            patch: { finalResource: { storageKey, at: new Date().toISOString(), stale: false } },
        }]);
        return { taskId, storageKey, videos: unique.length };
    }

    // ── 编译链 / 通用能力 ───────────────────────────────────────────────

    /** 发布 → 编译 → 应用 → 再发布 → 准备节点 → 同步 Clip。 */
    private async promoteToCanvas(episodeId: string): Promise<void> {
        const base = `/drama/episodes/${encodeURIComponent(episodeId)}/production`;
        let production = (await this.getProduction(episodeId)).production as any;
        await this.request("POST", `${base}/publish`, {
            operationId: randomUUID(), expectedRevision: Number(production.revision || 0), stage: "director",
        });

        production = (await this.getProduction(episodeId)).production as any;
        const operationId = `pipeline-compile-${randomUUID()}`;
        const compile = await this.request("POST", `${base}/compile`, {
            expectedRevision: Number(production.revision || 0), operationId,
        });
        const compilation = await this.waitCompilation(episodeId, String(compile?.compilation?.operationId || operationId));
        const preparedId = String(compilation?.nextAction?.input?.preparedId || compilation?.preparedId || "");
        if (!preparedId) throw new Error(`COMPILE_NO_PREPARED_ID: ${compilation?.blockingDiagnostic?.message || ""}`);
        await this.request("POST", `${base}/apply-compilation`, { preparedId });

        production = (await this.getProduction(episodeId)).production as any;
        await this.request("POST", `${base}/publish`, {
            operationId: randomUUID(), expectedRevision: Number(production.revision || 0), stage: "director",
        });

        const readiness = await this.request("GET", `${base}/readiness`);
        const targets: string[] = (Array.isArray(readiness?.readiness?.targets) ? readiness.readiness.targets : [])
            .filter((target: any) => target?.kind === "segment")
            .map((target: any) => String(target.id));
        production = (await this.getProduction(episodeId)).production as any;
        if (targets.length) {
            await this.request("POST", `${base}/prepare-targets`, {
                expectedRevision: Number(production.revision || 0), targets, operationId: `pipeline-prepare-${randomUUID()}`,
            });
        }
        await this.request("POST", `${base}/sync-clips`, {});
    }

    private async waitCompilation(episodeId: string, operationId: string): Promise<Record<string, any>> {
        const base = `/drama/episodes/${encodeURIComponent(episodeId)}/production/compilations/${encodeURIComponent(operationId)}`;
        const deadline = Date.now() + TASK_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const res = await this.request("GET", `${base}?view=status`);
            const compilation = res?.compilation as Record<string, any> | undefined;
            const status = String(compilation?.status || "");
            if (status === "succeeded") return compilation || {};
            if (status === "failed" || status === "blocked" || status === "interrupted") {
                throw new Error(`COMPILE_${status.toUpperCase()}: ${compilation?.blockingDiagnostic?.message || status}`);
            }
            await this.sleep(TASK_POLL_MS);
        }
        throw new Error("COMPILE_TIMEOUT");
    }

    private async generateText(prompt: string, overrides?: { model?: string; reasoningEffort?: string }): Promise<string> {
        const fallback = this.resolveTextModel?.() || "";
        const chosen = String(overrides?.model || "").trim();
        const model = chosen || fallback;
        if (!model) throw new Error("PIPELINE_TEXT_MODEL_MISSING: 请在设置里选择文本模型");
        const effort = String(overrides?.reasoningEffort || "").trim();
        const started = await this.request("POST", "/canvas/generation", {
            mode: "text",
            model,
            prompt,
            count: 1,
            ...(effort && effort !== "auto" ? { params: { reasoningEffort: effort } } : {}),
        });
        const taskId = String(started?.taskId || "");
        if (!taskId) throw new Error("TEXT_GENERATION_NO_TASK");
        const task = await this.waitTask(taskId, false);
        const text = (Array.isArray(task?.result?.texts) ? task.result.texts : [])
            .map((item: any) => String(item?.content || "")).join("\n").trim();
        if (!text) throw new Error("TEXT_GENERATION_EMPTY");
        return text;
    }

    /** 轮询画布/agent 任务；agent=true 走 /agent/runtime/tasks/:id，否则走 /tasks/:id。 */
    private async waitTask(taskId: string, agent: boolean): Promise<Record<string, any>> {
        const path = agent ? `/agent/runtime/tasks/${encodeURIComponent(taskId)}` : `/tasks/${encodeURIComponent(taskId)}`;
        const deadline = Date.now() + TASK_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const res = await this.request("GET", path);
            const task = (res?.task || {}) as Record<string, any>;
            const status = String(task?.status || "");
            if (["succeeded", "success", "completed", "done"].includes(status)) return task;
            if (["failed", "error", "canceled", "cancelled", "interrupted"].includes(status)) {
                throw new Error(`TASK_${status.toUpperCase()}: ${task?.error || status}`);
            }
            await this.sleep(TASK_POLL_MS);
        }
        throw new Error("TASK_TIMEOUT");
    }

    // ── 闸门操作 / 状态 ─────────────────────────────────────────────────

    approve(dramaId: string, episodeId: string): void {
        if (!this.approvals.has(dramaId)) this.approvals.set(dramaId, new Set());
        this.approvals.get(dramaId)!.add(episodeId);
        this.store.log(dramaId, `审批放行 episode=${episodeId}`);
        this.wake(dramaId);
    }

    releaseMedia(dramaId: string, target: string): void {
        if (!this.releasedMedia.has(dramaId)) this.releasedMedia.set(dramaId, new Set());
        this.releasedMedia.get(dramaId)!.add(target);
        this.store.log(dramaId, `媒体放行 target=${target}`);
        this.wake(dramaId);
    }

    pause(dramaId: string, reason = "manual"): void {
        this.store.setStatus(dramaId, "paused", reason);
        this.store.log(dramaId, `流水线暂停：${reason}`);
        this.wake(dramaId);
    }

    resume(dramaId: string): void {
        this.store.setStatus(dramaId, "running", null);
        this.store.log(dramaId, "流水线恢复");
        this.wake(dramaId);
    }

    retryFailed(dramaId: string): number {
        const failed = this.store.listJobs(dramaId, ["failed"]);
        for (const job of failed) {
            this.store.requeue(job.id);
            this.retryAt.delete(job.id);
        }
        this.store.log(dramaId, `失败作业重新入队：${failed.length} 条`);
        this.wake(dramaId);
        return failed.length;
    }

    status(dramaId: string): Record<string, unknown> {
        const pipeline = this.store.get(dramaId) || null;
        const jobs = this.store.listJobs(dramaId);
        const byStage: Record<string, Record<string, number>> = {};
        for (const job of jobs) {
            byStage[job.stage] ||= {};
            byStage[job.stage][job.status] = (byStage[job.stage][job.status] || 0) + 1;
        }
        const byStatus: Record<string, number> = {};
        for (const job of jobs) byStatus[job.status] = (byStatus[job.status] || 0) + 1;
        return {
            pipeline,
            totals: byStatus,
            stages: byStage,
            jobs: jobs.map(job => ({
                id: job.id, stage: job.stage, kind: job.kind, status: job.status,
                attempt: job.attempt, episodeId: job.episode_id, error: job.error,
            })),
            logs: this.store.logs(dramaId, 20),
        };
    }

    // ── 私有工具 ────────────────────────────────────────────────────────

    /** 制作设置「参考图模型」按资产类型批量写入各集制作稿的 settings.imageModelsByKind。 */
    private async applyImageModels(dramaId: string, imageModelsByKind: { character?: string; scene?: string; prop?: string }): Promise<void> {
        try {
            const listing = await this.request("GET", `/drama/projects/${encodeURIComponent(dramaId)}/episodes`);
            const episodes: Array<Record<string, any>> = Array.isArray(listing?.episodes) ? listing.episodes : [];
            let applied = 0;
            for (const ep of episodes) {
                const episodeId = String(ep?.id || "");
                if (!episodeId) continue;
                try {
                    const fresh = await this.getProduction(episodeId);
                    await this.productionOps(episodeId, Number(fresh.production.revision || 0), [
                        { type: "set_settings", patch: { imageModelsByKind } },
                    ]);
                    applied += 1;
                } catch { /* 单集写失败不阻断其余集 */ }
            }
            this.store.log(dramaId, `参考图模型按资产类型已应用到 ${applied}/${episodes.length} 集`);
        } catch (error) { this.store.log(dramaId, `应用参考图模型失败（不阻断）：${errText(error)}`, "warn"); }
    }

    private async getProduction(episodeId: string): Promise<{ production: Record<string, any> }> {
        return this.request("GET", `/drama/episodes/${encodeURIComponent(episodeId)}/production`);
    }

    private async productionOps(episodeId: string, expectedRevision: number, ops: Record<string, unknown>[]): Promise<{ production: Record<string, any> }> {
        return this.request("POST", `/drama/episodes/${encodeURIComponent(episodeId)}/production/ops`, {
            operationId: randomUUID(),
            expectedRevision: Number(expectedRevision || 0),
            ops,
        });
    }

    private async getCanvasProject(canvasId: string): Promise<Record<string, any>> {
        const res = await this.request("GET", `/canvas/projects/${encodeURIComponent(canvasId)}`);
        return res?.project || {};
    }

    private fpsOf(source: Record<string, any>): number {
        const num = Number(source?.fps_num || 24);
        const den = Number(source?.fps_den || 1);
        return den > 0 && num > 0 ? num / den : 24;
    }

    private findCanvasSegment(nodes: Array<Record<string, any>>, productionSegmentId: string): { nodeId: string; segmentId: string; prompt: string } | null {
        for (const node of nodes) {
            const segments = Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [];
            for (const cs of segments) {
                const targetId = String(cs?.productionClipProjection?.targetId || "");
                if (targetId && targetId === productionSegmentId) {
                    return { nodeId: String(node.id), segmentId: String(cs.id), prompt: String(cs?.prompt || "") };
                }
            }
        }
        return null;
    }

    private shortHash(text: string): string {
        let h = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) h = Math.imul(h ^ text.charCodeAt(index), 0x01000193) >>> 0;
        return h.toString(36);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** 统一 HTTP 自调用：Bearer token + JSON + 超时 + 错误归一化。 */
    private async request(method: string, path: string, body?: unknown): Promise<any> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.token}`,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: controller.signal,
            });
            const raw = await res.text();
            let data: any;
            try { data = raw ? JSON.parse(raw) : {}; }
            catch { data = { raw: raw.slice(0, 500) }; }
            if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${data?.error || data?.message || raw.slice(0, 200)}`);
            if (data && data.ok === false) throw new Error(`${method} ${path}: ${data.error || data.message || "请求失败"}`);
            return data;
        } finally {
            clearTimeout(timer);
        }
    }
}

export default DramaPipeline;
