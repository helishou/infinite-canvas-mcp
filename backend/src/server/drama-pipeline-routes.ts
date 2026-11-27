/**
 * 全自动流水线 HTTP 路由（对齐影策 /api/dramas/:id/start、/pause、approve、release、retry-failed）。
 * 由 index.ts 注入已 startLoop 的 DramaPipeline 实例。
 */
import type { Router } from "express";
import { z } from "zod";
import type { DramaPipeline } from "../drama/pipeline.js";
import type { BackendDatabase } from "../db.js";
import { adoptSharedAssetImage, bindPipelineAssetImage, restoreAssetsFromCanvas } from "../drama/pipeline-asset-image.js";

/** 写作技能引用：name/title/path 对齐前端 SkillRef；content/instruction 允许前端预解析后直传。 */
const pipelineTextSkillSchema = z.object({
    name: z.string(),
    title: z.string().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    instruction: z.string().optional(),
});

/** 制作设置运行期选项契约（budgetMicrocredits 为影策同名预算上限，0/不设=不限）。 */
export const pipelineOptionsSchema = z.object({
    storyboardModel: z.string().optional(),
    assetExtractModel: z.string().optional(),
    videoPromptModel: z.string().optional(),
    planModel: z.string().optional(),
    imageResolution: z.enum(["1k", "2k", "4k"]).optional(),
    // 剧目级段视频分辨率档位（影策 videoResolution）：短边像素档 + 画幅，联动写进 H3 段真实出片参数。
    videoResolution: z.enum(["480p", "720p", "1080p", ""]).optional(),
    videoAspectRatio: z.enum(["16:9", "9:16"]).optional(),
    sampleMode: z.boolean().optional(),
    textThinking: z.object({ plan: z.string().optional(), storyboard: z.string().optional(), extract: z.string().optional(), prompt: z.string().optional() }).optional(),
    // 影策 PromptRules：表演强度/运镜动感 1-10 档，全自动 runPrompts 映射为 5 档文字注入 style/cameraMotion。
    // performanceIntensity 是前端设置项原名，作为兼容别名一并接受。
    performance: z.number().int().min(1).max(10).optional(),
    performanceIntensity: z.number().int().min(1).max(10).optional(),
    cameraDynamics: z.number().int().min(1).max(10).optional(),
    // 开篇钩子/结尾悬念：全自动 script-proposal 透传的创作方向。
    hook: z.string().optional(),
    cliffhanger: z.string().optional(),
    // 写作技能（拆镜/提示词步骤）：不落库，仅本次运行期透传。
    textSkills: z.object({
        extract: pipelineTextSkillSchema.optional().nullable(),
        storyboard: pipelineTextSkillSchema.optional().nullable(),
        prompt: pipelineTextSkillSchema.optional().nullable(),
    }).optional(),
    videoModel: z.string().optional(),
    imageModelsByKind: z.object({ character: z.string().optional(), scene: z.string().optional(), prop: z.string().optional() }).optional(),
    referenceLimit: z.number().int().min(0).max(20).optional(),
    independent: z.boolean().optional(),
    storyboardRules: z.object({
        episodeSeconds: z.number().optional(),
        segmentMode: z.enum(["auto", "fixed", "range"]).optional(),
        segmentRange: z.object({ min: z.number(), max: z.number() }).optional(),
        dialogueDensity: z.string().optional(),
        transitionMode: z.string().optional(),
        transitionMs: z.number().optional(),
        pacing: z.string().optional(),
    }).optional(),
    // 影策 DramaSettings.Concurrency：单值，text/image/video/render 四池各自独立计数。
    concurrency: z.number().int().min(1).max(16).optional(),
    // 参考图提示词模板（制作设置「角色/场景/默认提示词」）：空则用内置方案模板拼装。
    assetPromptTemplates: z.object({
        default: z.string().max(8000).optional(),
        character: z.string().max(8000).optional(),
        scene: z.string().max(8000).optional(),
        prop: z.string().max(8000).optional(),
    }).optional(),
    // 预算上限（影策 budgetMicrocredits，单位微积分）：0/不设=不限；累计生成花费达限自动暂停流水线。
    budgetMicrocredits: z.number().min(0).optional(),
}).partial();

const startSchema = z.object({
    reviewMode: z.enum(["auto", "sample", "every"]).default("auto"),
    mediaMode: z.enum(["auto", "manual"]).default("auto"),
    options: pipelineOptionsSchema.optional(),
}).strict();

const rewritePromptsSchema = z.object({ episodeId: z.string().min(1), segments: z.array(z.number().int().nonnegative()).optional() }).strict();
const rewriteScriptSchema = z.object({
    episodeId: z.string().min(1),
    instruction: z.string().optional(),
    model: z.string().optional(),
    options: z.record(z.unknown()).optional(),
}).strict();

const approveSchema = z.object({ episodeId: z.string().min(1) }).strict();
const manualRetrySchema = z.object({ jobId: z.string().min(1) }).strict();
const releaseSchema = z.object({ target: z.enum(["assets", "episodes", "all"]).default("all") }).strict();
const bindAssetImageSchema = z.object({
    episodeId: z.string().min(1),
    assetId: z.string().min(1),
    nodeId: z.string().min(1),
    storageKey: z.string().min(1),
    taskId: z.string().optional(),
    imageId: z.string().optional(),
}).strict();

const adoptSharedAssetImageSchema = z.object({
    projectId: z.string().min(1),
    nodeId: z.string().min(1),
    storageKey: z.string().min(1),
    assetId: z.string().optional(),
    taskId: z.string().optional(),
    imageId: z.string().optional(),
}).strict();

export function registerDramaPipelineRoutes(router: Router, pipeline: DramaPipeline, db?: BackendDatabase) {
    // 一键全自动启动（幂等；影策 create(start:true) 的等价物）
    router.post("/drama/:dramaId/pipeline/start", async (req, res) => {
        const parsed = startSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map(i => i.message).join("; ") });
        try {
            const result = await pipeline.start(String(req.params.dramaId), parsed.data);
            res.json({ ok: true, ...result });
        } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 暂停（影策 /pause 等价物）：停派发 + 在跑作业退回可恢复排队 + 请求取消本剧在跑画布任务。
    // 返回暂停摘要（pausedJobs/canceledTasks/failedTasks…），连续暂停幂等。
    router.post("/drama/:dramaId/pipeline/pause", async (req, res) => {
        try { res.json({ ok: true, ...await pipeline.pause(String(req.params.dramaId)) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
    router.post("/drama/:dramaId/pipeline/resume", async (req, res) => {
        try { await pipeline.resume(String(req.params.dramaId)); res.json({ ok: true }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 状态（前端轮询）
    router.get("/drama/:dramaId/pipeline/status", (req, res) => {
        try { res.json({ ok: true, ...pipeline.status(String(req.params.dramaId)) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
    // 状态别名：GET /drama/:id/pipeline 与 /pipeline/status 返回同一份数据（含 pause.reason / pause.lastResult）。
    router.get("/drama/:dramaId/pipeline", (req, res) => {
        try { res.json({ ok: true, ...pipeline.status(String(req.params.dramaId)) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 强制重写段提示词：忽略画布已有的旧 prompt，逐段用真 LLM 重写并 update_h3_segment 写回。
    router.post("/drama/pipeline/prompts/rewrite", async (req, res) => {
        const parsed = rewritePromptsSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: "episodeId 必填" });
        try { res.json({ ok: true, ...await pipeline.rewritePrompts(parsed.data.episodeId, parsed.data.segments) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 按章编辑原文 →「确定(保存并重新改编)」：重置本集 script/assets/prompts/video/render 作业并
    // 重入队 script（对齐影策 rescript），script 作业内清旧分镜→按新稿重拆→promoteToCanvas 同步画布。
    router.post("/drama/pipeline/script/rewrite", async (req, res) => {
        const parsed = rewriteScriptSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: "episodeId 必填" });
        try {
            res.json({ ok: true, ...await pipeline.rescript(parsed.data.episodeId, {
                instruction: parsed.data.instruction, model: parsed.data.model, options: parsed.data.options,
            }) });
        } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 闸门放行（影策 /episodes/:eid/approve）
    router.post("/drama/:dramaId/pipeline/approve", (req, res) => {
        const parsed = approveSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: "episodeId 必填" });
        try { pipeline.approve(String(req.params.dramaId), parsed.data.episodeId); res.json({ ok: true }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 媒体放行（影策 /media/release）
    router.post("/drama/:dramaId/pipeline/release", (req, res) => {
        const parsed = releaseSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: "target 无效" });
        try { pipeline.releaseMedia(String(req.params.dramaId), parsed.data.target); res.json({ ok: true }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 失败重试（影策 /retry-failed）
    router.post("/drama/:dramaId/pipeline/retry-failed", (req, res) => {
        try { res.json({ ok: true, ...pipeline.retryFailed(String(req.params.dramaId)) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
    // 人工单作业重试：只有用户点击才绕过熔断上限，重置 attempt 后重新入队。
    router.post("/drama/:dramaId/pipeline/retry-job", (req, res) => {
        const parsed = manualRetrySchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: "jobId 必填" });
        try { res.json(pipeline.retryJobManually(String(req.params.dramaId), parsed.data.jobId)); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 全自动流水线资产参考图写回：draft/published.director.assets[assetId] + 实体节点 metadata。
    // 只接受真实归档媒体：storageKey 必须能在 media_files 找到对应文件，sha256 由文件字节计算。
    router.post("/drama/pipeline/assets/bind-image", (req, res) => {
        if (!db) return void res.status(503).json({ ok: false, error: "资产参考图写回需要数据库访问，服务尚未就绪" });
        const parsed = bindAssetImageSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
        try { res.json(bindPipelineAssetImage(db, parsed.data)); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 共享资产条目 adopt：把真实归档图片写到共享画布 canonical 节点并锁定；
    // 派生同步会把 storageKey/sha256 传播到所有消费分集 director.assets 与 H3 段参考图。
    router.post("/drama/pipeline/assets/adopt-shared-image", (req, res) => {
        if (!db) return void res.status(503).json({ ok: false, error: "共享资产采用需要数据库访问，服务尚未就绪" });
        const parsed = adoptSharedAssetImageSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
        try { res.json(adoptSharedAssetImage(db, parsed.data)); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    // 流水线收尾对账：整集跑完后从画布实体节点把参考图重新贴回 draft.assets，
    // 抵消 compile/apply 从空的 pictureBindings 重建 assets 造成的清空。
    router.post("/drama/pipeline/assets/restore", (req, res) => {
        if (!db) return void res.status(503).json({ ok: false, error: "资产参考图对账需要数据库访问，服务尚未就绪" });
        const episodeId = String((req.body as Record<string, any> | undefined)?.episodeId || "").trim();
        if (!episodeId) return void res.status(400).json({ ok: false, error: "episodeId 必填" });
        try { res.json({ ok: true, episodeId, ...restoreAssetsFromCanvas(db, episodeId) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
}
