/**
 * 全自动流水线「资产参考图」真实写回。
 *
 * 把 POST /canvas/generation 生成的 storageKey 落到两处真值：
 *  1) 分集制作稿 draft/published.director.assets[assetId] —— 资产页缩略图/状态真值
 *     （web/src/pages/drama-studio/studio-cast-panel.tsx deriveGenStatus 读 draft.director.assets）；
 *  2) 画布实体节点 metadata —— characterImages / sceneImage / propImage（供后续 H3 参考图解析）。
 *
 * 与 production.ts 的 selectDirectorResult 最终落点一致，但不要求发布版本、generation log
 * 或 production_task_binding：流水线自建任务只有可核验的 storageKey + media_files 归档文件 + sha256。
 * 不造假数据：媒体必须真实存在，sha256 由文件字节计算。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { BackendDatabase } from "../db.js";
import { decodeStoredJson } from "../json-storage.js";
import { withoutDirectorProjection } from "./director.js";
import { productionCanvasContext } from "./production-canvas.js";

type Row = Record<string, any>;

export type PipelineAssetImageInput = {
    episodeId: string;
    assetId: string;
    nodeId: string;
    storageKey: string;
    taskId?: string;
    imageId?: string;
    /** 来源真值：前端「上传形象图」走此路由默认 upload；画布收尾对账恢复显式传 canvas。 */
    source?: "upload" | "canvas";
};

export type PipelineAssetImageResult = {
    ok: true;
    episodeId: string;
    assetId: string;
    nodeId: string;
    storageKey: string;
    sha256: string;
    revision: number;
    canvasRevision: number;
};

const text = (value: unknown) => String(value || "").trim();
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value)
    ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];

/**
 * 幂等写回：相同 storageKey 重复调用只会更新同一个 selectedResult，不会堆图片。
 * 画布 update_node 用固定 operationId（含 storageKey），后端 receipt 天然去重。
 */
export function bindPipelineAssetImage(db: BackendDatabase, input: PipelineAssetImageInput): PipelineAssetImageResult {
    const episodeId = text(input.episodeId);
    const assetId = text(input.assetId);
    const nodeId = text(input.nodeId);
    const storageKey = text(input.storageKey);
    if (!episodeId || !assetId || !nodeId || !storageKey) throw new Error("PIPELINE_ASSET_IMAGE_INVALID: episodeId/assetId/nodeId/storageKey 必填");

    // 1) 核验真实媒体并算摘要（绝不写假 storageKey）。
    const media = db.getMediaFile(storageKey);
    if (!media || !fs.existsSync(media.filePath)) throw new Error(`PIPELINE_ASSET_IMAGE_MEDIA_MISSING: 归档媒体不存在 ${storageKey}`);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex");

    const episode = db.getDramaEpisode(episodeId);
    const canvasId = text(episode?.canvasId);
    if (!canvasId) throw new Error("PIPELINE_ASSET_IMAGE_NO_CANVAS: 分集还没有画布");

    const canvas = db.getCanvasProject(canvasId);
    const node = ((canvas?.nodes as Row[] | undefined) || []).find(item => String(item.id) === nodeId);
    if (!node) throw new Error(`PIPELINE_ASSET_IMAGE_NODE_MISSING: 实体节点不存在 ${nodeId}`);

    const kind = String(node.type || "");
    if (!["character", "scene", "prop"].includes(kind)) throw new Error(`PIPELINE_ASSET_IMAGE_NODE_TYPE: 不支持的实体节点类型 ${kind}`);

    const imageId = text(input.imageId) || `pipeline:${text(input.taskId) || "task"}:${storageKey}`;
    const source = input.source || "upload";
    const url = `/media/${encodeURIComponent(storageKey)}`;
    const width = Number(media.width || 0);
    const height = Number(media.height || 0);
    const bytes = Number(media.bytes || 0);
    const mimeType = String(media.mimeType || "image/png");
    const image: Row = {
        id: imageId, status: "success", storageKey, url, content: url, source,
        name: String(node.title || assetId), sha256,
        naturalWidth: width, naturalHeight: height, width, height, bytes, mimeType,
        ...(text(input.taskId) ? { generationTaskId: text(input.taskId) } : {}),
    };

    // 2) 实体节点 metadata：按类型落到 characterImages / sceneImage / propImage。
    const metadata: Row = {
        status: "success", storageKey, content: url, source,
        naturalWidth: width, naturalHeight: height, bytes, mimeType,
        ...(text(input.taskId) ? { generationTaskId: text(input.taskId) } : {}),
    };
    if (kind === "character") {
        const prior = Array.isArray(node.metadata?.characterImages) ? node.metadata.characterImages as Row[] : [];
        const at = prior.findIndex(item => String(item?.storageKey || "") === storageKey);
        metadata.characterImages = at < 0
            ? [...prior, image]
            : prior.map((item, index) => index === at ? { ...item, ...image } : item);
        metadata.characterPrimaryIndex = at < 0 ? prior.length : at;
    } else if (kind === "scene") {
        metadata.sceneImage = { ...image };
    } else {
        metadata.propImage = { ...image };
    }
    const applied = db.applyCanvasProjectOperations(canvasId, undefined, [{ type: "update_node", id: nodeId, metadata }], {
        // operationId 必须带 episodeId：assetId（如 asset-character-526xuk）跨剧目复用，
        // 只按 assetId+storageKey 会和别的剧目的历史 receipt 撞幂等，导致换图写回被误拒。
        operationId: `pipeline-asset-image:${episodeId}:${assetId}:${storageKey}`,
        runtimeWrite: true,
        source: { kind: "system", clientId: "pipeline:asset-image", label: "全自动流水线写入资产参考图" },
    });

    // 3) 制作稿：draft（资产页真值）必写；published 与 draft 同源时同步写。
    const row = db.db.prepare("SELECT revision, draft_json, published_json FROM episode_productions WHERE episode_id=?").get(episodeId) as
        { revision: number; draft_json: unknown; published_json: unknown } | undefined;
    if (!row) throw new Error("PIPELINE_ASSET_IMAGE_PRODUCTION_MISSING: 分集制作稿不存在");
    const draft = decodeStoredJson<Row>(row.draft_json);
    const published = row.published_json == null ? null : decodeStoredJson<Row>(row.published_json);
    if (!draft.director) throw new Error("PIPELINE_ASSET_IMAGE_NO_DIRECTOR: 制作稿还没有导演数据");
    const selectedResult = {
        imageId, ...(text(input.taskId) ? { taskId: text(input.taskId) } : {}),
        storageKey, sha256, projectId: canvasId, nodeId, source,
    };
    const writeAsset = (director: Row) => {
        const assets = (director.assets && typeof director.assets === "object" ? director.assets : (director.assets = {})) as Record<string, Row>;
        const prior = assets[assetId] || {};
        const plan = ((Array.isArray(director.source?.asset_plan) ? director.source.asset_plan : []) as Row[])
            .find(item => String(item.asset_id || item.id || "") === assetId);
        assets[assetId] = {
            ...prior, nodeId,
            version: String(prior.version || plan?.version || "v1"),
            storageKey, sha256, status: "generated", inputOutdated: false, selectedResult,
        };
    };
    writeAsset(draft.director);
    if (published?.director && String(published.director.sourceHash || "") === String(draft.director.sourceHash || "")) writeAsset(published.director);

    const revision = Number(row.revision || 0) + 1;
    db.db.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?")
        .run(revision,
            JSON.stringify(withoutDirectorProjection(draft as any)),
            published ? JSON.stringify(withoutDirectorProjection(published as any)) : null,
            new Date().toISOString(), episodeId);

    return { ok: true, episodeId, assetId, nodeId, storageKey, sha256, revision, canvasRevision: Number(applied.revision || 0) };
}

export type SharedAssetImageInput = {
    /** 共享资产画布 projectId（不是分集 canvasId）。 */
    projectId: string;
    /** 共享画布上的 canonical 实体节点（character/scene/prop）。 */
    nodeId: string;
    storageKey: string;
    assetId?: string;
    taskId?: string;
    imageId?: string;
};

export type SharedAssetImageResult = {
    ok: true;
    projectId: string;
    nodeId: string;
    storageKey: string;
    sha256: string;
    kind: string;
    canvasRevision: number;
};

/**
 * 共享资产条目 adopt（影策角色详情「从素材库选择（采用并锁定）」的本地真链路）。
 *
 * 复用既有共享资产真值，不另造 promotion：
 *  1) storageKey 必须是真实归档媒体，sha256 由文件字节算（与 bind-image 同一口径）；
 *  2) 把图片写到共享画布的 canonical 节点（characterImages / sceneImage / propImage）；
 *  3) applyCanvasProjectOperations 的派生同步（syncSharedCanvasAssetRecords +
 *     propagateAssetChanges → syncSharedProductionOwners → sharedSubjectPictureMedia /
 *     sharedAssetClipInputOperations）会把新图与 sha256 写进所有消费分集的 director.assets，
 *     并重绑 H3 段的参考图——因此剧情段视频真正按这张图生成。
 *
 * 消费分集的实体节点是 writeThrough 的 sharedAssetReference 引用：canonical 变化经
 * getCanvasProject 的 live projection 即时可见，不在本集复制一份图片（避免双真值）。
 * operationId 固定（canonical 节点 + storageKey），重复采用由 receipt 去重 = 幂等；
 * 回滚只需重新采用原图，不做删除类破坏操作。
 */
export function adoptSharedAssetImage(db: BackendDatabase, input: SharedAssetImageInput): SharedAssetImageResult {
    const projectId = text(input.projectId);
    const nodeId = text(input.nodeId);
    const storageKey = text(input.storageKey);
    if (!projectId || !nodeId || !storageKey) throw new Error("SHARED_ASSET_ADOPT_INVALID: projectId/nodeId/storageKey 必填");

    const context = productionCanvasContext(db, projectId);
    if (context.role !== "shared-assets") throw new Error("SHARED_ASSET_ADOPT_NOT_SHARED_CANVAS: 目标画布不是共享资产画布");

    const media = db.getMediaFile(storageKey);
    if (!media || !fs.existsSync(media.filePath)) throw new Error(`SHARED_ASSET_ADOPT_MEDIA_MISSING: 归档媒体不存在 ${storageKey}`);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex");

    const node = ((db.getCanvasProject(projectId)?.nodes as Row[] | undefined) || []).find(item => String(item.id) === nodeId);
    if (!node) throw new Error(`SHARED_ASSET_ADOPT_NODE_MISSING: 共享资产节点不存在 ${nodeId}`);
    const kind = String(node.type || "");
    if (!["character", "scene", "prop"].includes(kind)) throw new Error(`SHARED_ASSET_ADOPT_NODE_TYPE: 不支持的共享资产节点类型 ${kind}`);

    const imageId = text(input.imageId) || `shared-adopt:${text(input.taskId) || "library"}:${storageKey}`;
    const url = `/media/${encodeURIComponent(storageKey)}`;
    const width = Number(media.width || 0), height = Number(media.height || 0);
    const bytes = Number(media.bytes || 0), mimeType = String(media.mimeType || "image/png");
    const image: Row = {
        id: imageId, status: "success", storageKey, url, content: url, source: "canvas",
        name: String(node.title || text(input.assetId) || "共享资产"), sha256,
        naturalWidth: width, naturalHeight: height, width, height, bytes, mimeType,
        ...(text(input.taskId) ? { generationTaskId: text(input.taskId) } : {}),
    };
    const metadata: Row = {
        status: "success", storageKey, content: url, source: "canvas",
        naturalWidth: width, naturalHeight: height, bytes, mimeType,
        ...(text(input.taskId) ? { generationTaskId: text(input.taskId) } : {}),
    };
    if (kind === "character") {
        const prior = Array.isArray(node.metadata?.characterImages) ? node.metadata.characterImages as Row[] : [];
        const at = prior.findIndex(item => String(item?.storageKey || "") === storageKey);
        metadata.characterImages = at < 0
            ? [...prior, image]
            : prior.map((item, index) => index === at ? { ...item, ...image } : item);
        metadata.characterPrimaryIndex = at < 0 ? prior.length : at;
    } else if (kind === "scene") {
        metadata.sceneImage = { ...image };
    } else {
        metadata.propImage = { ...image };
    }
    const applied = db.applyCanvasProjectOperations(projectId, undefined, [{ type: "update_node", id: nodeId, metadata }], {
        operationId: `pipeline-shared-asset-adopt:${nodeId}:${storageKey}`,
        runtimeWrite: true,
        source: { kind: "system", clientId: "pipeline:shared-asset-adopt", label: "采用共享资产参考图并锁定" },
    });
    return { ok: true, projectId, nodeId, storageKey, sha256, kind, canvasRevision: Number(applied.revision || 0) };
}

/** 从画布节点列表里为资产定位生产实体节点（production-entity-*）。 */
export function findPipelineAssetEntityNode(nodes: unknown, asset: { kind: string; name: string; entityId?: string }): { id: string; type: string } | null {
    const list = Array.isArray(nodes) ? nodes.filter(Boolean) as Row[] : [];
    if (!list.length) return null;
    const kind = String(asset.kind || "");
    const name = String(asset.name || "").trim();
    const entityId = String(asset.entityId || "").trim();
    const candidates = list.filter(node => String(node.type || "") === kind && String(node.id || "").startsWith("production-entity-"));
    const pool = candidates.length ? candidates : list.filter(node => String(node.type || "") === kind);
    const match = (() => {
        if (entityId) {
            const byBinding = pool.find(node => String(node.metadata?.productionEntity?.entityId || "") === entityId);
            if (byBinding) return byBinding;
            const byId = pool.find(node => String(node.id || "") === entityId || String(node.id || "").endsWith(`:${entityId}`));
            if (byId) return byId;
        }
        if (name) {
            const byName = pool.find(node => String(node.metadata?.[`${kind}Name`] || "") === name || String(node.title || "") === name);
            if (byName) return byName;
        }
        // 同名/绑定都缺失时不猜：只在唯一候选时选用，避免把图写到别的实体上。
        return pool.length === 1 ? pool[0] : undefined;
    })();
    return match ? { id: String(match.id), type: String(match.type) } : null;
}

/** 从生成任务的 task 中取第一张成功媒体 storageKey。 */
export function generatedMediaStorageKey(task: Record<string, any> | null | undefined): string {
    const media = Array.isArray(task?.result?.media) ? task!.result.media as Row[] : [];
    for (const item of media) {
        const key = String(item?.storageKey || "").trim();
        if (key) return key;
    }
    return String(task?.result?.storageKey || "").trim();
}

/**
 * 流水线收尾对账：compile/apply 会从 subject_registry.pictureBindings 重建 director.assets，
 * 而 bind-image 只写了节点 metadata + draft.assets、没写 pictureBindings，导致 assets 在后续
 * 编译阶段被清空。此函数在整集所有阶段跑完后，从画布实体节点上仍存在的图片重新贴回
 * director.assets（此时不再有 compile，写入稳定）。节点图缺失则跳过，不造假。
 */
export function restoreAssetsFromCanvas(db: BackendDatabase, episodeId: string): { restored: number; skipped: number } {
    const episode = db.getDramaEpisode(episodeId);
    const canvasId = text(episode?.canvasId);
    if (!canvasId) return { restored: 0, skipped: 0 };
    const canvas = db.getCanvasProject(canvasId);
    const nodes = (canvas?.nodes as Row[] | undefined) || [];
    const row = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(episodeId) as { draft_json: unknown } | undefined;
    if (!row?.draft_json) return { restored: 0, skipped: 0 };
    const draft = decodeStoredJson<Row>(row.draft_json);
    const assets = (draft.director?.assets && typeof draft.director.assets === "object" ? draft.director.assets : {}) as Record<string, Row>;
    const plans = (Array.isArray(draft.director?.source?.asset_plan) ? draft.director.source.asset_plan : []) as Row[];
    let restored = 0, skipped = 0;
    for (const plan of plans) {
        const assetId = String(plan.asset_id || plan.id || "").trim();
        if (!assetId) continue;
        const currentKey = String(assets[assetId]?.storageKey || "").trim();
        if (currentKey && db.getMediaFile(currentKey)) { skipped += 1; continue; } // 已存在且媒体有效
        const kind = String(plan.kind || "").trim();
        if (!["character", "scene", "prop"].includes(kind)) continue;
        const node = findPipelineAssetEntityNode(nodes, {
            kind, name: String(plan.asset_name || plan.name || "").trim(), entityId: String(plan.entity_id || "").trim(),
        });
        if (!node) { skipped += 1; continue; }
        const full = nodes.find(n => String(n.id) === node.id);
        const meta = full?.metadata || {};
        let image: Row | undefined;
        if (kind === "character") {
            const imgs = Array.isArray(meta.characterImages) ? meta.characterImages as Row[] : [];
            image = imgs[Number(meta.characterPrimaryIndex || 0)] || imgs[0];
        } else if (kind === "scene") image = meta.sceneImage as Row | undefined;
        else image = meta.propImage as Row | undefined;
        const storageKey = String(image?.storageKey || "").trim();
        if (!storageKey || !db.getMediaFile(storageKey)) { skipped += 1; continue; }
        try {
            bindPipelineAssetImage(db, { episodeId, assetId, nodeId: node.id, storageKey, taskId: String(image?.generationTaskId || "") || undefined, source: "canvas" });
            restored += 1;
        } catch { skipped += 1; }
    }
    return { restored, skipped };
}

export type GeneratedAssetWriteBackInput = {
    /** 生成结果实际写入的画布（分集画布或剧目共享资产画布）。 */
    projectId: string;
    nodeId: string;
    storageKey: string;
    taskId?: string;
};

export type GeneratedAssetWriteBackResult =
    | { ok: true; scope: "episode" | "shared"; assetId: string; storageKey: string }
    | { ok: false; reason: string };

/**
 * 画布生成完成的制作资产回写。普通图片任务只把结果写进节点顶层 storageKey，
 * 而制作台资产卡和 H3 参考图解析读的是 draft.assets[assetId] 与实体节点的
 * sceneImage / characterImages / propImage。此函数把两者接到同一份已归档媒体上：
 *  - 分集实体节点 → bindPipelineAssetImage（写制作稿 + 实体节点权威图，标 generated）；
 *  - 共享画布 canonical 节点 → adoptSharedAssetImage（写共享源并经 writeThrough 传播到消费分集）。
 * 没有正式生产实体绑定、类别不符或媒体未归档时明确跳过，不猜资产、不造假图。
 */
function assetIdForEntityNode(db: BackendDatabase, episodeId: string, nodeId: string, entityId: string): string {
    const row = db.db.prepare("SELECT draft_json, published_json FROM episode_productions WHERE episode_id=?")
        .get(episodeId) as { draft_json: unknown; published_json: unknown } | undefined;
    // draft 是当前权威编辑源：published 可能属于旧版本，不能用它把本轮结果写到历史资产卡上。
    for (const raw of [row?.draft_json, row?.published_json]) {
        if (raw == null) continue;
        const director = record(decodeStoredJson<Row>(raw).director);
        // 先按节点身份定位：同一个实体可能有多张资产卡，节点绑定才是唯一落点。
        for (const [id, asset] of Object.entries(record(director.assets))) {
            if (text(record(asset).nodeId) === nodeId) return id;
        }
        const plan = rows(record(director.source).asset_plan)
            .find(item => text(item.entity_id || item.entityId) === entityId || text(item.id || item.asset_id) === entityId);
        if (plan) return text(plan.id || plan.asset_id);
    }
    return "";
}

function productionAssetImageMatches(db: BackendDatabase, episodeId: string, assetId: string, storageKey: string): boolean {
    const row = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?")
        .get(episodeId) as { draft_json: unknown } | undefined;
    if (row?.draft_json == null) return false;
    const asset = record(record(decodeStoredJson<Row>(row.draft_json).director).assets)[assetId];
    return text(record(asset).storageKey) === storageKey && text(record(asset).status) === "generated";
}

export function syncGeneratedProductionAssetImage(db: BackendDatabase, input: GeneratedAssetWriteBackInput): GeneratedAssetWriteBackResult {
    const projectId = text(input.projectId), nodeId = text(input.nodeId), storageKey = text(input.storageKey);
    if (!projectId || !nodeId || !storageKey) return { ok: false, reason: "NO_TARGET" };
    const media = db.getMediaFile(storageKey);
    if (!media || !fs.existsSync(media.filePath)) return { ok: false, reason: "MEDIA_MISSING" };

    const node = ((db.getCanvasProject(projectId)?.nodes as Row[] | undefined) || []).find(item => text(item.id) === nodeId);
    if (!node) return { ok: false, reason: "NODE_MISSING" };
    const kind = text(node.type);
    if (!["character", "scene", "prop"].includes(kind)) return { ok: false, reason: "NOT_ENTITY_NODE" };
    const metadata = record(node.metadata);
    const binding = record(metadata.productionEntity);
    // 共享画布 canonical 节点可能只带 productionAssetId，分集正式实体节点必须带 productionEntity 归属。
    const entityId = text(binding.entityId) || text(metadata.productionAssetId);

    const context = productionCanvasContext(db, projectId);
    if (context.role === "shared-assets") {
        adoptSharedAssetImage(db, { projectId, nodeId, storageKey, taskId: text(input.taskId) });
        return { ok: true, scope: "shared", assetId: entityId || nodeId, storageKey };
    }
    if (text(binding.ownerKind) === "episode" && text(binding.ownerId) && entityId) {
        const episodeId = text(binding.ownerId);
        const assetId = assetIdForEntityNode(db, episodeId, nodeId, entityId);
        if (!assetId) return { ok: false, reason: "ASSET_NOT_FOUND" };
        // 同一张图重复回写只更新一次 revision，避免任务重放/重复钩子污染制作稿版本。
        if (!productionAssetImageMatches(db, episodeId, assetId, storageKey))
            bindPipelineAssetImage(db, { episodeId, assetId, nodeId, storageKey, taskId: text(input.taskId), source: "canvas" });
        return { ok: true, scope: "episode", assetId, storageKey };
    }
    return { ok: false, reason: "NO_PRODUCTION_OWNER" };
}
