/**
 * 视频生成前只读体检的 HTTP 路由（忠实移植影策 cloudAgentHandleCanvasPreflight 的入口语义）。
 *
 * 只读：仅读 episode → canvas → minimax-h3 段 → referenceBindings → media_files + 文件 stat；
 * 不创建任务、不预留积分、不改 draft_json / canvas / media_files，带模型也不做计价试算。
 */
import fs from "node:fs";
import { type Request, type Response, type Router } from "express";

import type { EpisodeProductionService } from "../drama/production.js";
import {
    planVideoPrerun,
    type PrerunMediaState,
    type PrerunReference,
    type PrerunReport,
    type PrerunSegment,
} from "../drama/video-prerun.js";

type CanvasNode = Record<string, any>;

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Record<string, any>[] : [];
const text = (value: unknown): string => (typeof value === "string" || typeof value === "number") ? String(value) : "";

/** 已归档成功结果的段跳过；失败/过期/无结果/显式重跑的段才需要体检（与 skipCompleted 同一真值）。 */
function needsPrerun(segment: Record<string, any>): boolean {
    const status = text(segment.status).toLowerCase();
    if (["failed", "error", "interrupted", "cancelled"].includes(status)) return true;
    if (segment.inputOutdated === true || segment.forceRerun === true) return true;
    return !text(segment.resultStorageKey).trim();
}

/** media_files 入库 + 物理文件存在且非空；不打开写句柄，不做任何修复。 */
function mediaState(storageKey: string, assetStatus: string, mediaOf: (storageKey: string) => unknown): PrerunMediaState {
    if (!storageKey) return { found: false, fileExists: false, bytes: 0, detail: assetStatus ? `资产状态 ${assetStatus}` : "绑定未解析出 storageKey" };
    const media = record(mediaOf(storageKey));
    if (!media.storageKey) return { found: false, fileExists: false, bytes: 0, detail: `media_files 未登记 ${storageKey}` };
    let fileExists = false;
    try {
        const stat = fs.statSync(String(media.filePath || ""));
        fileExists = stat.isFile() && stat.size > 0;
    } catch { fileExists = false; }
    return {
        found: true,
        fileExists,
        bytes: Number(media.bytes || 0),
        mimeType: text(media.mimeType),
        detail: fileExists ? "" : text(media.filePath || storageKey),
    };
}

/** 读取制作稿 director.assets（仅 SELECT，绝不写库），用于 assetId 兜底解析 storageKey。 */
function directorAssetsOf(db: { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }, episodeId: string): Record<string, any> {
    try {
        const row = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(episodeId) as { draft_json?: string } | undefined;
        const draft = row?.draft_json ? JSON.parse(row.draft_json) as Record<string, any> : {};
        return record(record(draft.director).assets);
    } catch {
        return {};
    }
}

/**
 * 真值装配：从 episode 绑定的画布遍历 H3 视频段，注入参考图媒体状态后交给纯函数体检。
 * options.includeAll=true 时连已有结果的段一起检查（调试用，默认只体检待生成段）。
 */
export function collectVideoPrerunReport(
    service: EpisodeProductionService,
    episodeId: string,
    options: { model?: string; includeAll?: boolean; mediaOf?: (storageKey: string) => unknown } = {},
): PrerunReport {
    const resolveMedia = options.mediaOf || ((storageKey: string) => service.storageDatabase().getMediaFile(storageKey));
    return buildVideoPrerunReport(service, episodeId, options, resolveMedia);
}

function buildVideoPrerunReport(
    service: EpisodeProductionService,
    episodeId: string,
    options: { model?: string; includeAll?: boolean },
    resolveMedia: (storageKey: string) => unknown,
): PrerunReport {
    const info = service.episodeInfo(episodeId);
    const canvasId = text(info.canvasId);
    if (!canvasId) throw new Error("PRERUN_CANVAS_MISSING: 本集尚未绑定画布，无法体检");
    const db = service.storageDatabase();
    const project = db.getCanvasProject(canvasId);
    if (!project) throw new Error(`PRERUN_CANVAS_MISSING: 画布不存在 ${canvasId}`);

    const catalog = list((project as any).referenceCatalog);
    const assets = directorAssetsOf(db as any, episodeId);
    const segments: PrerunSegment[] = [];
    let skipped = 0;

    for (const node of list(project.nodes) as CanvasNode[]) {
        const type = text(node.type);
        const metadata = record(node.metadata);
        if (!(type === "minimax-h3:video" || (type.startsWith("minimax-h3:") && text(metadata.generationMode) === "video"))) continue;
        for (const [index, raw] of list(metadata.segments).entries()) {
            if (!options.includeAll && !needsPrerun(raw)) { skipped++; continue; }
            const references: PrerunReference[] = [];
            for (const binding of list(raw.referenceBindings)) {
                const assetId = text(binding.assetId);
                let storageKey = text(binding.storageKey).trim();
                if (!storageKey && assetId) storageKey = text(catalog.find(asset => text(asset.id) === assetId)?.storageKey).trim();
                const asset = record(assets[assetId]);
                const assetStatus = text(asset.status);
                if (!storageKey) storageKey = text(asset.storageKey).trim();
                references.push({
                    id: text(binding.id || binding.bindingId),
                    label: text(binding.label || binding.id || binding.assetId || `参考 ${index + 1}`),
                    storageKey,
                    mediaType: text(binding.mediaType || binding.type || "image"),
                    enabled: binding.enabled !== false,
                    role: text(binding.role),
                    media: mediaState(storageKey, assetStatus, resolveMedia),
                });
            }
            segments.push({
                nodeId: text(node.id),
                segmentId: text(raw.id || `${text(node.id)}:${index}`),
                title: text(raw.title || node.title) || `第 ${segments.length + 1} 段`,
                prompt: text(raw.prompt || raw.promptText),
                duration: Number(raw.duration || 0),
                model: text(raw.modelName || raw.model) || undefined,
                references,
            });
        }
    }

    const report = planVideoPrerun({
        episodeId,
        segments,
        mode: "video",
        model: options.model || undefined,
        // 本地没有计价/准入试算实现；显式标注跳过，绝不伪造报价或创建任务。
        pricingSkipped: true,
    });
    if (skipped > 0) report.notes.push(`${skipped} 段已有成功结果，按 skipCompleted 口径跳过体检`);
    return report;
}

function handlePrerunError(res: Response, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PRERUN_CANVAS_MISSING")) {
        res.status(400).json({ ok: false, code: "PRERUN_CANVAS_MISSING", error: message.replace(/^PRERUN_CANVAS_MISSING:\s*/, "") });
        return;
    }
    if (message.includes("CANVAS_MISSING") || message.includes("EPISODE_NOT_FOUND")) {
        res.status(404).json({ ok: false, code: "PRERUN_NOT_FOUND", error: message });
        return;
    }
    res.status(500).json({ ok: false, code: "PRERUN_FAILED", error: message });
}

export function registerDramaPrerunRoutes(router: Router, service: EpisodeProductionService) {
    const run = (req: Request, res: Response) => {
        try {
            const source = req.method === "GET" ? record(req.query) : record(req.body);
            const model = text(source.model).slice(0, 200);
            const includeAll = source.includeAll === true || source.includeAll === "1" || source.includeAll === "true";
            res.json(collectVideoPrerunReport(service, String(req.params.episodeId || ""), { model: model || undefined, includeAll }));
        } catch (error) {
            handlePrerunError(res, error);
        }
    };
    // 生成前只读体检：GET 便于人工查看，POST 便于制作台带参数调用；两者完全同一实现。
    router.get("/drama/episodes/:episodeId/prerun", run);
    router.post("/drama/episodes/:episodeId/prerun", run);
}
