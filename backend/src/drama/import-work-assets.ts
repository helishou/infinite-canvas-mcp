/**
 * 跨作品素材导入：把「其他剧目共享画布」上真实存在的 character/scene/prop 节点
 * 复制成本剧目共享画布上的实体节点（影策 cast-project-import 的后端真链路）。
 *
 * 硬约束：
 *  - 只复制真实存在的源节点与真实归档媒体（db.getMediaFile + 文件字节），绝不编造 storageKey/图片；
 *  - 源节点必须在源共享画布上存在且 type 与请求一致，防止伪造 sourceNodeId；
 *  - operationId = 源剧目 + 源节点 + 目标剧目，固定；节点 id 也由同一组输入派生，
 *    因此重复导入不会在目标画布产生重复节点（幂等）；
 *  - 只写共享资产画布，不触碰分集制作稿 / H3 段 / 成片绑定。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { libraryAssetNode } from "@basketikun/canvas-agent/shared-asset-reference";
import type { BackendDatabase } from "../db.js";
import { ensureProductionCanvas, productionCanvasContext } from "./production-canvas.js";

type Row = Record<string, any>;

export type ImportWorkAsset = {
    sourceNodeId: string;
    kind: "character" | "scene" | "prop";
    name: string;
    description?: string;
    aliases?: string[];
    storageKeys: string[];
};

export type ImportWorkAssetsInput = {
    sourceDramaId: string;
    assets: ImportWorkAsset[];
};

export type ImportWorkAssetsResult = {
    ok: true;
    /** 成功新增的节点数（不含幂等跳过）。 */
    imported: number;
    /** 跳过明细：伪造/不存在的源节点、类型不符、媒体缺失、已导入。 */
    skipped: Array<{ item: string; reason: string }>;
    /** 与 skipped 同长度的计数，便于只关心数量的调用方。 */
    skippedCount: number;
    nodes: Array<{ nodeId: string; kind: string; name: string }>;
};

const ENTITY_KINDS = ["character", "scene", "prop"] as const;
const text = (value: unknown) => String(value ?? "").trim();

function stableId(...parts: string[]) {
    return crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

/** 图片一律来自真实归档媒体；缺失的 storageKey 只跳过，绝不写入占位图。 */
function realImages(db: BackendDatabase, storageKeys: unknown, name: string, item: string, skipped: ImportWorkAssetsResult["skipped"]) {
    const images: Row[] = [];
    for (const raw of Array.isArray(storageKeys) ? storageKeys : []) {
        const storageKey = text(raw);
        if (!storageKey) continue;
        const media = db.getMediaFile(storageKey);
        if (!media || !fs.existsSync(media.filePath)) {
            skipped.push({ item: `${item}:${storageKey}`, reason: "归档媒体不存在，已跳过该图" });
            continue;
        }
        let sha256: string;
        try {
            sha256 = crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex");
        } catch {
            skipped.push({ item: `${item}:${storageKey}`, reason: "归档媒体读取失败，已跳过该图" });
            continue;
        }
        const url = `/media/${encodeURIComponent(storageKey)}`;
        const width = Number(media.width || 0), height = Number(media.height || 0);
        images.push({
            id: `import-image:${storageKey}`, status: "success", storageKey, url, content: url, source: "canvas",
            name, sha256, naturalWidth: width, naturalHeight: height, width, height,
            bytes: Number(media.bytes || 0), mimeType: String(media.mimeType || "image/png"),
        });
    }
    return images;
}

/**
 * 复制其他作品共享画布上的资产节点到目标剧目的共享画布。
 * 目标剧目没有共享画布时用 ensureProductionCanvas("shared-assets") 语义补建（只建空画布）。
 */
export function importWorkAssets(db: BackendDatabase, dramaId: string, input: ImportWorkAssetsInput): ImportWorkAssetsResult {
    const targetDramaId = text(dramaId);
    const sourceDramaId = text(input?.sourceDramaId);
    if (!targetDramaId || !sourceDramaId) throw new Error("IMPORT_WORK_ASSETS_INVALID: dramaId/sourceDramaId 必填");
    if (targetDramaId === sourceDramaId) throw new Error("IMPORT_WORK_ASSETS_SAME_DRAMA: 不能从当前剧目自身导入");

    // 1) 目标共享画布：ensure 语义（有则复用，无则只建空画布）。
    const targetDrama = db.db.prepare("SELECT folder_id, shared_asset_canvas_id FROM drama_projects WHERE folder_id=?")
        .get(targetDramaId) as { folder_id: string; shared_asset_canvas_id: string | null } | undefined;
    if (!targetDrama) throw new Error(`IMPORT_WORK_ASSETS_TARGET_NOT_FOUND: 目标剧目不存在 ${targetDramaId}`);
    let targetProjectId = text(targetDrama.shared_asset_canvas_id);
    if (!targetProjectId || !db.getCanvasProject(targetProjectId)) {
        targetProjectId = ensureProductionCanvas(db, "shared-assets", targetDramaId).project.id;
    }
    if (productionCanvasContext(db, targetProjectId).role !== "shared-assets") {
        throw new Error("IMPORT_WORK_ASSETS_TARGET_NOT_SHARED_CANVAS: 目标画布不是共享资产画布");
    }

    // 2) 源共享画布：只读，绝不补建/改写。
    const sourceDrama = db.db.prepare("SELECT folder_id, shared_asset_canvas_id FROM drama_projects WHERE folder_id=?")
        .get(sourceDramaId) as { folder_id: string; shared_asset_canvas_id: string | null } | undefined;
    if (!sourceDrama) throw new Error(`IMPORT_WORK_ASSETS_SOURCE_NOT_FOUND: 源剧目不存在 ${sourceDramaId}`);
    const sourceProjectId = text(sourceDrama.shared_asset_canvas_id);
    if (!sourceProjectId || !db.getCanvasProject(sourceProjectId)) {
        throw new Error(`IMPORT_WORK_ASSETS_SOURCE_CANVAS_MISSING: 源剧目共享画布不存在 ${sourceDramaId}`);
    }
    if (productionCanvasContext(db, sourceProjectId).role !== "shared-assets") {
        throw new Error("IMPORT_WORK_ASSETS_SOURCE_NOT_SHARED_CANVAS: 源画布不是共享资产画布");
    }
    const sourceNodes = ((db.getCanvasProject(sourceProjectId)?.nodes as Row[] | undefined) || []).filter(Boolean);
    const targetNodes = ((db.getCanvasProject(targetProjectId)?.nodes as Row[] | undefined) || []).filter(Boolean);

    const assets = Array.isArray(input?.assets) ? input.assets : [];
    if (!assets.length) throw new Error("IMPORT_WORK_ASSETS_INVALID: assets 必填且非空");

    const skipped: ImportWorkAssetsResult["skipped"] = [];
    const nodes: ImportWorkAssetsResult["nodes"] = [];
    let imported = 0;

    for (const asset of assets) {
        const sourceNodeId = text(asset?.sourceNodeId);
        const kind = text(asset?.kind);
        const name = text(asset?.name);
        const item = `${sourceDramaId}:${sourceNodeId || "<missing>"}`;
        if (!sourceNodeId || !(ENTITY_KINDS as readonly string[]).includes(kind) || !name) {
            skipped.push({ item, reason: "sourceNodeId/kind/name 无效" });
            continue;
        }
        // 防伪造：源节点必须真实存在，且类型与请求一致。
        const sourceNode = sourceNodes.find(node => String(node.id) === sourceNodeId);
        if (!sourceNode) {
            skipped.push({ item, reason: "源共享画布上不存在该节点" });
            continue;
        }
        const sourceKind = String(sourceNode.type || "");
        if (sourceKind !== kind) {
            skipped.push({ item, reason: `源节点类型 ${sourceKind || "空"} 与请求 ${kind} 不符` });
            continue;
        }

        const digest = stableId(sourceDramaId, sourceNodeId, targetDramaId);
        const targetNodeId = `shared-import-${digest}`;
        const operationId = `import-work-assets:${sourceDramaId}:${sourceNodeId}:${targetDramaId}`;
        // 幂等：节点 id 由同一组输入派生，已存在就只回报，不再写画布（避免重复节点）。
        if (targetNodes.some(node => String(node.id) === targetNodeId)) {
            skipped.push({ item, reason: "已导入（幂等跳过）" });
            nodes.push({ nodeId: targetNodeId, kind, name });
            continue;
        }

        const images = realImages(db, asset.storageKeys, name, item, skipped);
        const sourceMeta: Row = sourceNode.metadata || {};
        const description = text(asset.description) || text(sourceMeta.characterDescription || sourceMeta.sceneDescription || sourceMeta.propDescription);
        const aliases = Array.isArray(asset.aliases) && asset.aliases.length
            ? asset.aliases.map(text).filter(Boolean)
            : (Array.isArray(sourceMeta.characterAliases) ? sourceMeta.characterAliases.map(text).filter(Boolean) : []);
        const canonicalName = text(sourceMeta.characterCanonicalName || sourceMeta.sceneName || sourceMeta.propName) || name;
        const productionAssetId = text(sourceMeta.productionAssetId) || `AC-${digest}`;
        const primary = images[0];

        // libraryAssetNode 产出规范实体节点 metadata；再补本项目真值字段。
        const data: Row = kind === "character"
            ? { name, description, aliases, images, primaryIndex: 0 }
            : { name, description, image: primary };
        const generated = libraryAssetNode({ id: productionAssetId, kind, title: name, data });
        const metadata: Row = {
            ...(generated.metadata || {}),
            productionAssetId,
            status: "success",
            importedFrom: { dramaId: sourceDramaId, canvasId: sourceProjectId, nodeId: sourceNodeId },
            ...(kind === "character" ? {
                characterName: name, characterDescription: description, characterAliases: aliases,
                characterCanonicalName: canonicalName, characterImages: images,
                characterPrimaryIndex: 0, characterAssetId: productionAssetId,
            } : {}),
            ...(kind === "scene" ? {
                sceneName: name, sceneDescription: description, sceneCanonicalName: canonicalName,
                ...(primary ? { sceneImage: primary } : {}),
            } : {}),
            ...(kind === "prop" ? {
                propName: name, propDescription: description, propCanonicalName: canonicalName,
                ...(primary ? { propImage: primary } : {}),
            } : {}),
        };
        // 位置由 nodeId 派生，与画布现状无关，保证重复导入的单一写请求指纹一致。
        const seed = parseInt(digest.slice(0, 8), 16);
        const position = { x: 80 + (seed % 8) * 380, y: 80 + (Math.floor(seed / 8) % 6) * 420 };
        db.applyCanvasProjectOperations(targetProjectId, undefined, [{
            type: "add_node", id: targetNodeId, nodeType: kind, title: name,
            position, width: 340, height: 360, metadata,
        }], {
            operationId,
            runtimeWrite: true,
            source: { kind: "system", clientId: "drama:import-work-assets", label: "跨作品素材导入" },
        });
        targetNodes.push({ id: targetNodeId });
        imported += 1;
        nodes.push({ nodeId: targetNodeId, kind, name });
    }

    return { ok: true, imported, skipped, skippedCount: skipped.length, nodes };
}
