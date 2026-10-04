import crypto from "node:crypto";
import fs from "node:fs";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { EpisodeProductionService } from "./production.js";
import type { compileAchengDirector } from "@basketikun/canvas-agent/skills/acheng";
import { ProductionCompilationService } from "./compilation.js";

export type ApprovedSharedAsset = { id: string; dramaId: string; assetId: string; sourceProjectId: string; sourceNodeId: string; sourceVersion: number;
    storageKey: string; sha256: string; evidence: string; snapshot: Record<string, any>; createdAt: string };
const stable = (...parts: string[]) => crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
function fromRow(row: Record<string, any>): ApprovedSharedAsset {
    return { id: row.id, dramaId: row.drama_id, assetId: row.asset_id, sourceProjectId: row.source_project_id, sourceNodeId: row.source_node_id,
        sourceVersion: row.source_version, storageKey: row.storage_key, sha256: row.sha256, evidence: row.evidence, snapshot: JSON.parse(row.snapshot_json), createdAt: row.created_at };
}
export function approvedSharedAsset(db: BackendDatabase, id: string): ApprovedSharedAsset {
    const row = db.db.prepare("SELECT * FROM drama_asset_versions WHERE id=?").get(id) as Record<string, any> | undefined;
    if (!row) throw new Error("共享资产批准版本不存在");
    const asset = fromRow(row);
    const media = db.getMediaFile(asset.storageKey);
    if (!media || !fs.existsSync(media.filePath) || crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") !== asset.sha256) throw new Error("共享资产媒体摘要不一致或归档文件不可访问");
    return asset;
}
export function listApprovedSharedAssets(db: BackendDatabase, dramaId: string) {
    return (db.db.prepare(`SELECT a.* FROM drama_asset_versions a WHERE drama_id=? AND rowid=(
        SELECT MAX(b.rowid) FROM drama_asset_versions b WHERE b.drama_id=a.drama_id AND b.asset_id=a.asset_id) ORDER BY a.asset_id`).all(dramaId) as Record<string, any>[]).map(fromRow);
}
export function sharedAssetHistory(db: BackendDatabase, dramaId: string) {
    return (db.db.prepare("SELECT * FROM drama_asset_versions WHERE drama_id=? ORDER BY rowid DESC").all(dramaId) as Record<string, any>[]).map(fromRow);
}

/** Called inside the production review transaction, after bytes and ownership were verified. */
export function registerApprovedSharedAsset(db: BackendDatabase, projectId: string, version: number, assetId: string, director: DirectorProduction) {
    const drama = db.db.prepare("SELECT folder_id FROM drama_projects WHERE shared_asset_canvas_id=?").get(projectId) as { folder_id: string } | undefined;
    const asset = director.assets[assetId];
    if (!drama || asset?.status !== "approved" || !asset.nodeId || !asset.storageKey || !asset.sha256 || !asset.evidence) return;
    const node = (db.getCanvasProject(projectId)?.nodes as Record<string, any>[] || []).find(item => item.id === asset.nodeId);
    if (!node) throw new Error("共享资产源节点不存在");
    const now = new Date().toISOString();
    const id = `approved-${stable(projectId, String(version), assetId, asset.storageKey, asset.sha256)}`;
    const media = db.getMediaFile(asset.storageKey)!;
    const character = node.type === "character";
    const snapshot = { title: node.title || assetId, type: character ? "character" : "image", width: node.width || 340, height: node.height || 260,
        version: asset.version, content: asset.storageKey, metadata: { storageKey: asset.storageKey, naturalWidth: media.width, naturalHeight: media.height, mimeType: media.mimeType,
            ...(character ? { characterName: node.metadata?.characterName || node.title, characterDescription: node.metadata?.characterDescription || "", characterEnglishName: node.metadata?.characterEnglishName || "",
                characterImages: (Array.isArray(node.metadata?.characterImages) ? node.metadata.characterImages : []).filter((image: any) => image.storageKey === asset.storageKey), characterPrimaryIndex: 0 } : {}) } };
    db.db.prepare(`INSERT OR IGNORE INTO drama_asset_versions
        (id, drama_id, asset_id, source_project_id, source_node_id, source_version, storage_key, sha256, snapshot_json, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, drama.folder_id, assetId, projectId, asset.nodeId, version, asset.storageKey, asset.sha256, JSON.stringify(snapshot), asset.evidence, now);
    db.upsertAsset({ id: `shared-${stable(drama.folder_id, assetId)}`, kind: "image", title: String(snapshot.title), coverUrl: "", tags: ["shared"],
        folderId: null, dramaId: drama.folder_id, source: "production-shared", note: null,
        data: { storageKey: asset.storageKey, width: media.width, height: media.height, bytes: media.bytes, mimeType: media.mimeType },
        metadata: { approvedId: id, assetId, sourceProjectId: projectId, sourceNodeId: asset.nodeId }, createdAt: now, updatedAt: now });
    for (const row of db.db.prepare(`SELECT p.episode_id, p.revision, p.draft_json FROM episode_productions p
        JOIN drama_episodes e ON e.id=p.episode_id WHERE e.drama_id=?`).all(drama.folder_id) as Array<{ episode_id: string; revision: number; draft_json: string }>) {
        const draft = JSON.parse(row.draft_json);
        for (const [targetId, consumer] of Object.entries(draft.director?.assets || {})) {
            const source = record(consumer).sharedSource;
            if (!source || source.assetId !== assetId || source.dramaId !== drama.folder_id || source.approvedId === id) continue;
            db.db.prepare(`INSERT OR IGNORE INTO drama_asset_adoptions (id, approved_id, episode_id, target_asset_id, expected_revision, status, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(`adoption-${stable(id, row.episode_id, targetId)}`, id, row.episode_id, targetId, row.revision, now);
        }
    }
}

export function validateSharedAssetSource(db: BackendDatabase, projectId: string, asset: DirectorProduction["assets"][string], latest = false) {
    if (!asset.sharedSource) return;
    const source = asset.sharedSource;
    const approved = approvedSharedAsset(db, source.approvedId);
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    if (!episode || episode.dramaId !== approved.dramaId || source.dramaId !== approved.dramaId || source.assetId !== approved.assetId ||
        source.sourceProjectId !== approved.sourceProjectId || source.sourceNodeId !== approved.sourceNodeId || asset.storageKey !== approved.storageKey || asset.sha256 !== approved.sha256 || asset.status !== "approved") throw new Error("共享资产来源、剧目或批准版本不一致");
    const node = (db.getCanvasProject(projectId)?.nodes as Record<string, any>[] || []).find(item => item.id === asset.nodeId);
    if (node?.metadata?.sharedAssetOrigin?.approvedId !== approved.id) throw new Error("共享资产未登记为当前画布引用");
    if (latest && listApprovedSharedAssets(db, approved.dramaId).find(item => item.assetId === approved.assetId)?.id !== approved.id) {
        throw Object.assign(new Error("共享资产已批准新版本，等待引用更新及提示词重新校验"), { code: "SHARED_ASSET_UPDATE" });
    }
}

/** Only this path creates the local projection; callers cannot register arbitrary media. */
export function prepareSharedAssetProjection(db: BackendDatabase, episodeId: string, targetId: string, approvedId: string) {
    const approved = approvedSharedAsset(db, approvedId);
    const episode = db.getDramaEpisode(episodeId);
    if (!episode?.canvasId || episode.dramaId !== approved.dramaId) throw new Error("只能采用同剧目的共享资产");
    const nodeId = sharedProjectionNodeId(episodeId, targetId);
    const project = db.getCanvasProject(episode.canvasId)!;
    const node = (project.nodes as Record<string, any>[] || []).find(item => item.id === nodeId);
    if (node && node.metadata?.sharedAssetOrigin?.assetId !== approved.assetId) throw new Error("共享引用身份冲突，不能替换已有资产");
    const origin = { dramaId: approved.dramaId, assetId: approved.assetId, approvedId, sourceProjectId: approved.sourceProjectId, sourceNodeId: approved.sourceNodeId };
    const metadata = { ...approved.snapshot.metadata, productionAssetId: targetId, sharedAssetOrigin: origin };
    const operations = node ? [{ type: "update_node", id: nodeId, patch: { content: approved.storageKey }, metadata }]
        : [{ type: "add_node", id: nodeId, nodeType: approved.snapshot.type, title: approved.snapshot.title, position: { x: 0, y: (project.nodes as unknown[] || []).length * 300 }, width: approved.snapshot.width, height: approved.snapshot.height, content: approved.storageKey, metadata }];
    const same = node?.metadata?.sharedAssetOrigin?.approvedId === approvedId && node?.metadata?.storageKey === approved.storageKey;
    if (!same) db.applyCanvasProjectOperations(episode.canvasId, Number(project.revision || 0), operations, { runtimeWrite: true, source: { kind: "system", clientId: "production:shared-assets", label: "采用共享批准资产" } });
    return { nodeId, approved, origin };
}
export const sharedProjectionNodeId = (episodeId: string, targetId: string) => `shared-ref-${stable(episodeId, targetId).slice(0, 24)}`;

export class SharedAssetCoordinator {
    private processing = false;
    private scheduled = false;
    constructor(private db: BackendDatabase, private service: EpisodeProductionService, private events: BackendEventBus,
        private resume?: (episodeId: string, runId: string) => void, private compiler?: typeof compileAchengDirector, private syncInputs?: (episodeId: string) => void) {}
    start() {
        const unsubscribe = this.events.subscribe(event => {
            if (event.type === "drama-production.updated") this.schedule();
        });
        this.schedule();
        return unsubscribe;
    }
    private schedule() {
        if (this.scheduled || this.processing) return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; this.drain(); });
    }
    drain() {
        if (this.processing) return;
        this.processing = true;
        try {
            const jobs = this.db.db.prepare("SELECT * FROM drama_asset_adoptions WHERE status IN ('pending','compiling') ORDER BY rowid").all() as Record<string, any>[];
            const revised = new Map<string, { initial: number; current: number }>();
            for (const job of jobs) {
                try {
                    const approved = approvedSharedAsset(this.db, job.approved_id);
                    if (listApprovedSharedAssets(this.db, approved.dramaId).find(asset => asset.assetId === approved.assetId)?.id !== approved.id) {
                        this.db.db.prepare("UPDATE drama_asset_adoptions SET status='superseded', error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
                        continue;
                    }
                    if (job.status === "compiling" && this.service.get(job.episode_id).revision !== job.expected_revision) throw new Error("制作源稿发生并发编辑，需核对后重新编译共享引用");
                    if (job.status === "pending") {
                        const current = this.service.get(job.episode_id);
                        const prior = revised.get(job.episode_id);
                        if (current.revision !== job.expected_revision && !(prior && prior.initial === job.expected_revision && prior.current === current.revision)) throw new Error("制作源稿发生并发编辑，共享资产更新需核对当前草稿");
                        const projection = prepareSharedAssetProjection(this.db, job.episode_id, job.target_asset_id, job.approved_id);
                        this.service.edit(job.episode_id, { operationId: job.id, expectedRevision: current.revision,
                            ops: [{ type: "adopt_shared_asset", assetId: job.target_asset_id, approvedId: job.approved_id, nodeId: projection.nodeId }] });
                        this.db.db.prepare("UPDATE drama_asset_adoptions SET status='compiling', expected_revision=?, updated_at=? WHERE id=?")
                            .run(this.service.get(job.episode_id).revision, new Date().toISOString(), job.id);
                    }
                    this.compile(job.episode_id);
                    revised.set(job.episode_id, { initial: revised.get(job.episode_id)?.initial ?? job.expected_revision, current: this.service.get(job.episode_id).revision });
                    this.db.db.prepare("UPDATE drama_asset_adoptions SET status='applied', error=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
                } catch (error) {
                    this.db.db.prepare("UPDATE drama_asset_adoptions SET status='blocked', error=?, updated_at=? WHERE id=?").run(error instanceof Error ? error.message : String(error), new Date().toISOString(), job.id);
                    this.events.publish({ type: "drama-production.updated", entityId: job.episode_id, payload: { sharedAssetUpdate: "blocked", adoptionId: job.id } });
                }
            }
        } finally { this.processing = false; }
    }
    private compile(episodeId: string) {
        const current = this.service.get(episodeId);
        const compilations = new ProductionCompilationService(this.service, this.service.compilationRoot(), this.compiler);
        const owner = "/drama/episodes/:episodeId/production";
        const packet = compilations.prepare(episodeId, owner, current.revision);
        compilations.apply(episodeId, owner, packet.preparedId);
        const next = this.service.get(episodeId);
        // Publication freezes valid inputs, never authorizes or submits media.
        const preflight = this.service.preflight(episodeId, { action: "publish", request: { operationId: `shared-publish:${packet.preparedId}`, expectedRevision: next.revision, stage: "director" } });
        if (!preflight.valid) throw new Error(preflight.diagnostics.map(item => item.message).join("；"));
        this.service.publish(episodeId, { operationId: `shared-publish:${packet.preparedId}`, expectedRevision: next.revision, stage: "director" });
        this.syncInputs?.(episodeId);
        for (const batch of this.service.listBatches(episodeId)) {
            const workflow = record(batch.settings.workflow);
            if (batch.status !== "awaiting_review" || workflow.mediaProductionMode !== "automatic") continue;
            try { this.service.resumeBatch(episodeId, batch.runId); this.resume?.(episodeId, batch.runId); }
            catch { /* The valid adoption remains applied; unrelated dependencies stay visible in readiness. */ }
        }
    }
}
