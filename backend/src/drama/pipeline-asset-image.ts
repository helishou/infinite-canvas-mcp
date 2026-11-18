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

type Row = Record<string, any>;

export type PipelineAssetImageInput = {
    episodeId: string;
    assetId: string;
    nodeId: string;
    storageKey: string;
    taskId?: string;
    imageId?: string;
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
    const url = `/media/${encodeURIComponent(storageKey)}`;
    const width = Number(media.width || 0);
    const height = Number(media.height || 0);
    const bytes = Number(media.bytes || 0);
    const mimeType = String(media.mimeType || "image/png");
    const image: Row = {
        id: imageId, status: "success", storageKey, url, content: url,
        name: String(node.title || assetId), sha256,
        naturalWidth: width, naturalHeight: height, width, height, bytes, mimeType,
        ...(text(input.taskId) ? { generationTaskId: text(input.taskId) } : {}),
    };

    // 2) 实体节点 metadata：按类型落到 characterImages / sceneImage / propImage。
    const metadata: Row = {
        status: "success", storageKey, content: url,
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
        operationId: `pipeline-asset-image:${assetId}:${storageKey}`,
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
        storageKey, sha256, projectId: canvasId, nodeId,
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
