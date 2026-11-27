/**
 * 影策审计缺口 #6：按当前方案「一键重做参考图」的本地后端能力。
 *
 * 复用已验证的四步真链路（backend/scratch_regen_all_refs.ts）：
 *   1) POST /canvas/generation {mode:"image", model:"engine-local::2.1", size:"1536x864", count:1}
 *   2) 轮询任务到 succeeded，取 task.result.media[0].storageKey
 *   3) POST /drama/pipeline/assets/bind-image 真写回制作稿 + 实体节点
 *   4) POST /drama/:dramaId/cast/:assetId/restyle 标脏引用段（默认开启）
 *
 * 反查策略：遍历剧目各集 episode_productions，从 draft/published.director.assets[assetId]
 * 找资产卡（prompt/description/assetKind/viewLayout），同时兼容 source.asset_cards /
 * source.asset_plan（有的剧目 assets 被编译清空但计划还在）。画布实体节点优先用卡上的
 * nodeId，否则复用 findPipelineAssetEntityNode（按 entityId / 名称 / 唯一候选），
 * 找不到就明确报错，绝不把图写到别的实体上。
 *
 * 出图失败 / 超时 / 无媒体时不写回、不标脏，返回明确错误。
 */
import crypto from "node:crypto";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import {
  ASSET_SCHEMES,
  defaultSchemeFor,
  renderAssetPromptWithTemplate,
  schemeAppliesTo,
  type AssetPromptTemplates,
  type AssetSchemeId,
} from "@basketikun/canvas-agent/drama/asset-spec";
import { withArtStyle } from "@basketikun/canvas-agent/drama/art-style";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { BackendDatabase } from "../db.js";
import type { Stores } from "../stores/types.js";
import type { CanvasGenerationService } from "../canvas/generation-service.js";
import { decodeStoredJson } from "../json-storage.js";
import { resolveDramaArtStyleByDb } from "../drama/art-style.js";
import {
  bindPipelineAssetImage,
  findPipelineAssetEntityNode,
  generatedMediaStorageKey,
} from "../drama/pipeline-asset-image.js";
import {
  applyRestylePlan,
  makeActiveTaskChecker,
  planRestyle,
} from "./drama-restyle-routes.js";

type Row = Record<string, any>;

const str = (value: unknown): string => value === undefined || value === null ? "" : String(value).trim();
const obj = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value)
    ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
const pick = (...values: unknown[]): string => {
    for (const value of values) {
        const text = str(value);
        if (text) return text;
    }
    return "";
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 影策本地已验证的图片模型与资产参考图画幅（横版 16:9）。 */
export const DEFAULT_REFERENCE_IMAGE_MODEL = "engine-local::2.1";
export const DEFAULT_REFERENCE_IMAGE_SIZE = "1536x864";

export const regenerateReferenceSchema = z.object({
    /** 显式提示词：整体覆盖资产卡提示词（画风仍会按需拼接）。 */
    prompt: z.string().max(8000).optional(),
    /** 画风：缺省取剧目 topic.artStyle（生成服务也会按项目再拼一次，内部去重）。 */
    artStyle: z.string().max(500).optional(),
    size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
    model: z.string().min(1).optional(),
    /** 默认 true：成功后把引用该资产的剧情段标脏。 */
    restyleSegments: z.boolean().default(true),
    /** 指定归属分集；不传时按资产卡所在集自动反查。 */
    episodeId: z.string().min(1).optional(),
    /** 剧目参考图提示词模板（角色/场景/道具/默认）；不传则用内置方案模板。 */
    assetPromptTemplates: z.object({
        default: z.string().max(8000).optional(),
        character: z.string().max(8000).optional(),
        scene: z.string().max(8000).optional(),
        prop: z.string().max(8000).optional(),
    }).strict().optional(),
}).strict();

export type RegenerateReferenceInput = z.infer<typeof regenerateReferenceSchema> & {
    dramaId: string;
    assetId: string;
};

export type RegenerateReferenceDeps = {
    db: BackendDatabase;
    stores: Stores;
    generation: CanvasGenerationService;
};

export type RegenerateReferenceOptions = {
    /** 等待出图上限，默认 10 分钟。 */
    timeoutMs?: number;
    /** 轮询间隔，默认 2 秒。 */
    pollIntervalMs?: number;
    /** 提交任务的瞬时错误重试次数（开发重载等）。 */
    startRetries?: number;
};

export type RegenerateReferenceResult = {
    ok: true;
    storageKey: string;
    episodeId: string;
    nodeId: string;
    assetId: string;
    taskId: string;
    affectedSegments: number;
};

export class RegenerateReferenceError extends Error {
    readonly status: number;
    readonly details: Row;
    constructor(message: string, status = 500, details: Row = {}) {
        super(message);
        this.name = "RegenerateReferenceError";
        this.status = status;
        this.details = details;
    }
}

type LocatedAsset = {
    episodeId: string;
    canvasId: string;
    nodeId: string;
    kind: "character" | "scene" | "prop";
    name: string;
    /** 资产卡设定文本（方案模板的 appearance）。 */
    appearance: string;
    scheme: AssetSchemeId;
    groupId: string;
};

const KINDS = ["character", "scene", "prop"] as const;
const kindOf = (value: string): "character" | "scene" | "prop" | "" =>
    (KINDS as readonly string[]).includes(value) ? value as "character" | "scene" | "prop" : "";

function readProduction(db: BackendDatabase, episodeId: string): { draft: Row; published: Row | null } | null {
    const row = db.db.prepare("SELECT revision, draft_json, published_json FROM episode_productions WHERE episode_id=?")
        .get(episodeId) as { draft_json: unknown; published_json: unknown } | undefined;
    if (!row) return null;
    try {
        const draft = decodeStoredJson<Row>(row.draft_json);
        const published = row.published_json == null ? null : decodeStoredJson<Row>(row.published_json);
        return { draft, published };
    } catch {
        return null;
    }
}

/**
 * 从剧目各集反查资产卡 + 归属画布实体节点。显式 episodeId 优先，找不到不静默跳到别的集。
 */
export function locateDramaAssetForRegeneration(db: BackendDatabase, dramaId: string, assetId: string,
    preferredEpisodeId?: string): LocatedAsset {
    const episodes = db.listDramaEpisodes(dramaId) || [];
    // 指定 episodeId 时只在指定集内反查，找不到就明确报错，不静默跳到别的集。
    const ordered = preferredEpisodeId
        ? episodes.filter(episode => episode.id === preferredEpisodeId)
        : episodes;
    for (const episode of ordered) {
        const stored = readProduction(db, episode.id);
        if (!stored) continue;
        for (const production of [stored.draft, stored.published]) {
            if (!production) continue;
            const director = obj(production.director);
            const card = obj(obj(director.assets)[assetId]);
            const source = obj(director.source);
            const planRows = [...rows(source.asset_cards), ...rows(source.asset_plan)];
            const plan = planRows.find(item => str(item.id || item.asset_id) === assetId) || {};
            if (!Object.keys(card).length && !Object.keys(plan).length) continue;

            const merged: Row = { ...plan, ...card };
            const kind = kindOf(pick(merged.assetKind, merged.asset_kind, merged.kind)) as LocatedAsset["kind"]
                || kindOf(pick(assetId.match(/^asset-([a-z]+)-/)?.[1]));
            if (!kind) continue;

            const canvasId = str(episode.canvasId) || str(db.getDramaEpisode(episode.id)?.canvasId);
            if (!canvasId) throw new RegenerateReferenceError(
                `REGEN_ASSET_NO_CANVAS: 资产 ${assetId} 所在分集 ${episode.id} 还没有画布`, 404);

            const nodeId = pick(merged.nodeId, merged.node_id, obj(merged.selectedResult).nodeId);
            let resolvedNodeId = nodeId;
            if (!resolvedNodeId) {
                const canvas = db.getCanvasProject(canvasId);
                const entity = findPipelineAssetEntityNode(canvas?.nodes, {
                    kind,
                    name: pick(merged.asset_name, merged.name, merged.assetName, merged.characterName),
                    entityId: pick(merged.entity_id, merged.entityId, obj(merged.productionEntity).entityId),
                });
                if (!entity) throw new RegenerateReferenceError(
                    `REGEN_NODE_NOT_FOUND: 找不到资产 ${assetId}（${kind}）的 production-entity 节点，请在画布先定位该设定`, 404);
                resolvedNodeId = entity.id;
            }

            const rawScheme = pick(merged.viewLayout, merged.view_layout, plan.view_layout);
            const scheme = (rawScheme && schemeAppliesTo(rawScheme as AssetSchemeId, kind)
                ? rawScheme : defaultSchemeFor(kind)) as AssetSchemeId;
            const appearance = pick(merged.prompt, merged.description, merged.purpose, plan.description, plan.prompt);
            return {
                episodeId: episode.id, canvasId, nodeId: resolvedNodeId, kind,
                name: pick(merged.asset_name, merged.name, merged.assetName, merged.title, assetId),
                appearance, scheme,
                groupId: pick(merged.groupId, merged.group_id, merged.characterAssetId),
            };
        }
    }
    throw new RegenerateReferenceError(
        `REGEN_ASSET_NOT_FOUND: 剧目 ${dramaId} 下找不到资产卡 ${assetId}${preferredEpisodeId ? `（分集 ${preferredEpisodeId}）` : ""}`, 404);
}

/** 组装真实出图提示词：显式 prompt 直接覆盖；否则按剧目模板（缺省回退内置方案模板）拼装资产卡设定。 */
export function buildRegeneratePrompt(located: LocatedAsset, input: RegenerateReferenceInput,
    artStyle: string, language: string, templates?: AssetPromptTemplates): string {
    const explicit = str(input.prompt);
    if (explicit) return withArtStyle(explicit, artStyle, language);
    const schemeInfo = ASSET_SCHEMES.find((s) => s.id === located.scheme);
    const rendered = renderAssetPromptWithTemplate(located.kind, located.name, located.appearance, located.scheme,
        templates ?? input.assetPromptTemplates, {
            项目画风: artStyle,
            资产名称: located.name,
            资产设定: located.appearance,
            方案名称: schemeInfo?.name || located.scheme,
            方案要求: schemeInfo?.frameHint || "",
            language,
        });
    return rendered.prompt;
}

const TRANSIENT = /正在开发重载|开发重载|BACKEND_OUTCOME_UNKNOWN|socket hang up|ECONNRESET|ETIMEDOUT/i;

async function startImage(generation: CanvasGenerationService, command: CanvasGenerationCommand,
    retries: number): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const started = await generation.start(command);
            const taskId = str(started?.taskId);
            if (!taskId) throw new RegenerateReferenceError("REGEN_NO_TASK: 出图任务没有返回 taskId", 502);
            return taskId;
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            // command.idempotencyKey 固定，重载重试只会复用同一任务，不会重复提交。
            if (attempt >= retries || !TRANSIENT.test(message)) break;
            await sleep(Math.min(15000, 2000 * (attempt + 1)));
        }
    }
    throw new RegenerateReferenceError(
        `REGEN_IMAGE_START_FAILED: ${lastError instanceof Error ? lastError.message : String(lastError)}`, 502);
}

async function waitImage(stores: Stores, taskId: string, timeoutMs: number, pollIntervalMs: number): Promise<Row> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        const task = obj(stores.tasks.get(taskId));
        const status = str(task.status).toLowerCase();
        if (["succeeded", "success", "completed"].includes(status)) return task;
        if (["failed", "error", "canceled", "cancelled"].includes(status)) {
            throw new RegenerateReferenceError(
                `REGEN_IMAGE_FAILED: 任务 ${taskId} 出图失败：${str(task.error).slice(0, 200)}`, 502, { taskId });
        }
        await sleep(pollIntervalMs);
    }
    throw new RegenerateReferenceError(`REGEN_IMAGE_TIMEOUT: 任务 ${taskId} 等待 ${timeoutMs}ms 仍未完成`, 504, { taskId });
}

/** 单资产「按当前方案一键重做参考图」完整链路。失败不写回、不标脏。 */
export async function regenerateDramaAssetReference(deps: RegenerateReferenceDeps, input: RegenerateReferenceInput,
    options: RegenerateReferenceOptions = {}): Promise<RegenerateReferenceResult> {
    const { db, stores, generation } = deps;
    const located = locateDramaAssetForRegeneration(db, input.dramaId, input.assetId, input.episodeId);
    const profile = resolveDramaArtStyleByDb(db, input.dramaId);
    const artStyle = str(input.artStyle) || profile.artStyle;
    const prompt = buildRegeneratePrompt(located, input, artStyle, profile.language);
    if (!prompt) throw new RegenerateReferenceError("REGEN_PROMPT_EMPTY: 资产卡没有可用提示词", 400);
    if (!located.appearance && !str(input.prompt)) {
        throw new RegenerateReferenceError(
            `REGEN_PROMPT_EMPTY: 资产 ${input.assetId} 的设定描述为空，请先补充资产卡提示词`, 400);
    }

    // 每次点击都是一次真实重做；idempotencyKey 用本次请求的随机值，只保护提交阶段的重试。
    const command: CanvasGenerationCommand = {
        mode: "image",
        projectId: located.canvasId,
        nodeId: located.nodeId,
        model: str(input.model) || DEFAULT_REFERENCE_IMAGE_MODEL,
        prompt,
        count: 1,
        size: str(input.size) || DEFAULT_REFERENCE_IMAGE_SIZE,
        idempotencyKey: `drama-asset-regen:${crypto.randomUUID()}`,
    };
    const taskId = await startImage(generation, command, options.startRetries ?? 2);
    const task = await waitImage(stores, taskId, options.timeoutMs ?? 10 * 60 * 1000, options.pollIntervalMs ?? 2000);
    const storageKey = generatedMediaStorageKey(task);
    if (!storageKey) throw new RegenerateReferenceError(
        `REGEN_NO_MEDIA: 任务 ${taskId} 没有产出 storageKey`, 502, { taskId });

    // 只有拿到真实归档媒体才写回；bind 内部会再次校验 media_files 与 sha256。
    try {
        bindPipelineAssetImage(db, {
            episodeId: located.episodeId, assetId: input.assetId, nodeId: located.nodeId, storageKey, taskId,
        });
    } catch (error) {
        throw new RegenerateReferenceError(
            `REGEN_BIND_FAILED: ${error instanceof Error ? error.message : String(error)}`, 500, { taskId, storageKey });
    }

    let affectedSegments = 0;
    if (input.restyleSegments !== false) {
        const plan = planRestyle(db, {
            assetId: input.assetId,
            groupId: located.groupId,
            dramaId: input.dramaId,
            restyleSegments: true,
            isActive: makeActiveTaskChecker(stores, db),
        });
        affectedSegments = applyRestylePlan(db, plan, `${input.dramaId}\0${input.assetId}\0${taskId}`).marked;
    }
    return {
        ok: true, storageKey, episodeId: located.episodeId, nodeId: located.nodeId,
        assetId: input.assetId, taskId, affectedSegments,
    };
}

/** HTTP 入口：注册到后端 Express app（与其余 drama 路由同在 src/index.ts 完成注册）。 */
export function registerDramaAssetRegenerateRoutes(router: Router, db: BackendDatabase, stores: Stores,
    generation: CanvasGenerationService, options: RegenerateReferenceOptions = {}) {
    router.post("/drama/:dramaId/assets/:assetId/regenerate-reference", async (req: Request, res: Response) => {
        const parsed = regenerateReferenceSchema.safeParse(req.body || {});
        if (!parsed.success) {
            return void res.status(400).json({
                ok: false, error: parsed.error.issues.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
            });
        }
        try {
            const result = await regenerateDramaAssetReference({ db, stores, generation }, {
                dramaId: String(req.params.dramaId), assetId: String(req.params.assetId), ...parsed.data,
            }, options);
            res.json(result);
        } catch (error) {
            const failure = error instanceof RegenerateReferenceError ? error
                : new RegenerateReferenceError(error instanceof Error ? error.message : String(error), 500);
            res.status(failure.status).json({ ok: false, error: failure.message, ...failure.details });
        }
    });
}
