import { readRawProject, readStoredProjectRows, rawProjectFromStoredRows, createStoredProject, writeStoredProjectDelta } from "./stores/canvas-project-storage.js";
import { CURRENT_DATABASE_SCHEMA, DRAMA_PIPELINE_DDL, DRAMA_EPISODE_PLANNING_DDL, CLIP_VIDEO_VERSIONS_DDL } from "./database-schema.js";
import { migrateStorageFormat } from "./storage-format-migration.js";
import { productionNumbering } from "@basketikun/canvas-agent/drama/production-contract";
import { syncEntityNodeEdits, syncH3SceneImageReferences, normalizeEntityNodeOperation } from "./drama/entity-nodes.js";
import { resolveSharedAssetNode, type AssetNode } from "@basketikun/canvas-agent/shared-asset-reference";
import { effectiveTargetInput, inputHash } from "./drama/canvas-inputs.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mcpEfficiencyReport } from "./mcp-efficiency-report.js";
import { decodeStoredJson, encodeStoredJson, storedJsonText, type StoredJson } from "./json-storage.js";
import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { productionImageModel, dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

import { DB_FILE, MEDIA_DIR, ensureDataDirs } from "./config.js";
import { prepareDatabaseUpgrade, DATABASE_SCHEMA_VERSION, MINIMUM_DATABASE_SCHEMA_VERSION } from "./database-upgrade.js";
import { createDatabaseSnapshot } from "./database-snapshots.js";
import { syncScriptNodeEdits } from "./drama/script-nodes.js";
import { syncH3ModeEdits } from "./drama/h3-mode-sync.js";
import { syncH3SegmentStructureEdits } from "./drama/canvas-production-sync.js";
import { syncImageReferenceEdits } from "./drama/image-inputs.js";
import { productionLayoutPlanSchema, type ProductionLayoutPlan, type ProductionLayoutReceipt } from "@basketikun/canvas-agent/drama/production-contract";
import { completedImageSlots, dropImageSlots, imageSourceStatus, linkedCharacterImageUpdates } from "./canvas/image-result-slots.js";
import { applyCanvasProjectOperations, canonicalizeH3References, isH3CanvasNode, registerH3ReferenceAssets, type CanvasOperation, type CanvasOperationResult } from "./canvas/project-ops.js";
import { prepareClientCanvasOperation, stripCanvasLocalViewState } from "./canvas/operation-authority.js";
import { collaborationError, commandFingerprint, type CanvasCommandContext, type CanvasCommit } from "./canvas/collaboration.js";
import { redactInlineMedia } from "./engine-contract/redact-inline-media.js";
import * as Y from "yjs";
import { textSuggestionInputSchema, type CanvasTextSuggestion } from "@basketikun/canvas-agent/schemas";
import { H3_RUNTIME_SEGMENT_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { editedTextTargets, loadTextDocument, readText, replaceText, textKey, textOperation, textTargetSchema, type CanvasTextTarget } from "./canvas/collaborative-text.js";
import type { McpObservabilityReportOptions } from "./stores/types.js";
import { reconstructCanvasHistory } from "./canvas/history-maintenance.js";
import { canonicalSharedAssetIds, captureAssetEdits, deleteDramaAsset, normalizeAssetInsertion, projectAsset, propagateAssetChanges, purgeOrphanedSharedAssets, resolveProjectAssets, stripProjectAssets, syncSharedCanvasAssetRecords, validateAssetOperation, writeDramaAsset, type AssetWriteCommand } from "./canvas/drama-asset-library.js";
import type { RuntimeTask, RuntimeTaskStatus, RuntimeTaskEvent, GenerationLog, GenerationLogStatus, MediaFile, WorkflowFieldType, WorkflowField, WorkflowConfig, WorkflowRunTarget, WorkflowConfigRow } from "./engine-contract/contracts.js";

// ── Types ──────────────────────────────────────────────────────────────────────
// 任务 / 媒体 / 工作流契约由画布自带的 engine-contract/ 与本地类型定义；此处 re-export 保持既有入口。

export type { RuntimeTask, RuntimeTaskStatus, RuntimeTaskEvent, GenerationLog, GenerationLogStatus, MediaFile, WorkflowFieldType, WorkflowField, WorkflowConfig, WorkflowRunTarget, WorkflowConfigRow };

function taskSearchFields(kind: string, input: Record<string, unknown>, params: Record<string, unknown>) {
    const inputParams = recordOf(input.params);
    const binding = recordOf(params.canvasBinding);
    const projectId = String(input.projectId || params.projectId || binding.projectId || "") || null;
    const nodeId = String(input.nodeId || inputParams.nodeId || params.nodeId || binding.nodeId || "") || null;
    const segmentId = String(input.segmentId || inputParams.segmentId || params.segmentId || binding.segmentId || "") || null;
    const model = String(params.model || params.modelName || input.model || "") || null;
    const executor = String(params.executor || (kind.startsWith("comfyui:") ? "comfy" : kind));
    const search = `${kind} ${executor} ${model || ""}`;
    return { projectId, nodeId, segmentId, model, isImage: /image/i.test(search) ? 1 : 0, isVideo: /video|h3/i.test(search) ? 1 : 0 };
}
export type McpObservabilityEventInput = {
    sessionId: string; traceId: string; event: "tool.started" | "tool.succeeded" | "tool.failed"; tool: string;
    projectId?: string; nodeId?: string; operationId?: string; taskId?: string;
    durationMs?: number; errorCode?: string; recoverable?: boolean; suggestedTool?: string;
    inputSummary?: Record<string, unknown>; outputSummary?: Record<string, unknown>;
};
export type McpObservabilityEvent = McpObservabilityEventInput & { id: string; createdAt: string };
export type AssetFolder = { id: string; name: string; parentId: string | null; createdAt: string };
export type CanvasFolder = {
    id: string; name: string; createdAt: string; updatedAt?: string;
    outline?: string; description?: string; coverStorageKey?: string | null; tags?: string[];
    /** 画布侧创建的普通文件夹为 false；旧客户端未传时按短剧兼容。 */
    isDrama?: boolean;
    sharedAssetCanvasId?: string | null;
    productionPlan?: DramaProductionPlan;
    expectedPlanningUpdatedAt?: string;
};
export type Asset = {
    id: string; kind: string; title: string; coverUrl: string; tags: string[];
    folderId: string | null; dramaId?: string | null; data: Record<string, unknown>; note: string | null;
    source: string | null; metadata: Record<string, unknown>;
    createdAt: string; updatedAt: string;
};
export type McpCommandReceipt = {
    operationId: string;
    tool: string;
    targetId: string | null;
    projectId?: string | null;
    status: "prepared" | "committed" | "rejected";
    requestHash: string;
    committedRevision?: number;
    snapshotAvailable?: boolean;
    receipt?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    error?: { code: string; message: string };
};
export type DramaEpisode = {
    id: string;
    dramaId: string;
    episodeNumber: number;
    title: string;
    synopsis: string;
    fullPlot: string;
    /** 本集素材类型：novel / script / storyboard，空串表示老数据（按 novel 看待）。 */
    sourceFormat: string;
    /** 建集时导入的原文真值；与 fullPlot（生成/编辑后的剧情正文）分开存。 */
    sourceText: string;
    canvasId: string | null;
    createdAt: string;
    updatedAt: string;
    /** 强一致分集：本集覆盖的稳定章节 ID（来自 source_chapters.id），按章序排列。 */
    chapterIds: string[];
};

/** 拆章结果里的一章：带后端持久化的稳定 ID 与章节级原文编辑版本。 */
export type SourceChapter = {
    id: string;
    dramaId: string;
    chapterIndex: number;
    title: string;
    body: string;
    bodyHash: string;
    chars: number;
    /** 素材类型（novel/script/storyboard）；影策真值按集存，这里冗余在章上供按章编辑回读，写时同步到覆盖的集。 */
    sourceFormat: string;
    /** 章节原文编辑版本号：每次真正改动正文/标题/素材类型自增，供 PATCH 乐观锁。 */
    revision: number;
    /** 章节原文最后改动时间（ISO），与 revision 一起构成乐观锁。 */
    updatedAt: string;
};

/** 素材类型合法值（影策 production.SourceNovel/SourceScript/SourceStoryboard）。 */
export const SOURCE_CHAPTER_FORMATS = new Set(["novel", "script", "storyboard"]);

/** 章节原文写入冲突（版本不符或目标不存在），由路由映射成 404/409。 */
export class SourceChapterWriteError extends Error {
    constructor(message: string, public readonly code: "NOT_FOUND" | "CONFLICT" | "VALIDATION") {
        super(message);
        this.name = "SourceChapterWriteError";
    }
}

/** 剧目级分集规划游标：plan_cursor 指向下一待规划章序号，plan_done 后整份规划锁写。 */
export type EpisodePlanningState = {
    dramaId: string;
    episodeMode: string;
    planCursor: number;
    planDone: boolean;
    sourceFingerprint: string;
    lastChapterIndex: number;
    batchChapters: number;
    batchChars: number;
    updatedAt: string;
};

/** 批量建集的一集：chapterIds 是稳定章节 ID，chapterIndices 只用于快照/校验。 */
export type PlannedEpisode = {
    episodeNumber: number;
    title: string;
    synopsis: string;
    hook: string;
    cliffhanger: string;
    chapterIds: string[];
    chapterIndices: number[];
};

export type CanvasProject = Record<string, unknown> & { id: string };

export type PluginDeclaration = {
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    tools: Array<Record<string, unknown>>;
    updatedAt: string;
};

// ── Database ──────────────────────────────────────────────────────────────────

export class BackendDatabase {
    readonly db: DatabaseSync;
    private readonly filePath: string;
    private canvasCommitListener?: (commit: CanvasCommit) => void;

    onCanvasCommit(listener: (commit: CanvasCommit) => void) { this.canvasCommitListener = listener; }

    snapshotForMaintenance(family: string) {
        if (this.filePath === ":memory:" || this.filePath.includes("mode=memory")) return undefined;
        const snapshot = createDatabaseSnapshot(this.db, this.filePath, family);
        const verify = new DatabaseSync(snapshot, { readOnly: true });
        try {
            if (verify.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("数据库快照完整性检查失败");
            if (verify.prepare("PRAGMA foreign_key_check").get()) throw new Error("数据库快照外键检查失败");
        } finally { verify.close(); }
        return snapshot;
    }

    constructor(file: string = DB_FILE) {
        this.filePath = file;
        const backup = prepareDatabaseUpgrade(file);
        if (backup) console.info(`[database] Pre-migration backup: ${backup}`);
        ensureDataDirs();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(file);
        // SQL routing queries still see ordinary JSON, including for compressed inputs.
        this.db.function("stored_json_text", { deterministic: true }, storedJsonText);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        try { this.migrate(); }
        catch (error) { this.db.close(); throw error; }
        // 全自动流水线队列表 + 强一致分集表：独立 DDL 补建，不升 schema version（见 database-schema.ts 注释）。
        this.db.exec(DRAMA_PIPELINE_DDL);
        this.db.exec(DRAMA_EPISODE_PLANNING_DDL);
        this.db.exec(CLIP_VIDEO_VERSIONS_DDL);
        this.ensureEpisodePlanningColumns();
        this.ensureSourceChapterColumns();
        this.ensureGenerationLogSourceColumn();
    }

    /** generation_logs 来源列补列（老库重开不丢历史日志）：幂等 ALTER，不升 schema version。 */
    private ensureGenerationLogSourceColumn() {
        const columns = this.db.prepare("PRAGMA table_info(generation_logs)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "source")) {
            // 历史日志都是真实生成回写产生的，缺省 pipeline 是事实而非臆造。
            this.db.exec("ALTER TABLE generation_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'pipeline'");
        }
    }

    /** drama_episodes 补列用幂等 ALTER：SQLite 没有 ADD COLUMN IF NOT EXISTS。 */
    private ensureEpisodePlanningColumns() {
        const columns = this.db.prepare("PRAGMA table_info(drama_episodes)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "chapter_ids_json")) {
            this.db.exec("ALTER TABLE drama_episodes ADD COLUMN chapter_ids_json TEXT NOT NULL DEFAULT '[]'");
        }
        // 原文素材两列对齐 full_plot 的默认值；老库重开不会丢原文，也不另建副本。
        if (!columns.some((column) => column.name === "source_format")) {
            this.db.exec("ALTER TABLE drama_episodes ADD COLUMN source_format TEXT NOT NULL DEFAULT ''");
        }
        if (!columns.some((column) => column.name === "source_text")) {
            this.db.exec("ALTER TABLE drama_episodes ADD COLUMN source_text TEXT NOT NULL DEFAULT ''");
        }
    }

    /** 章节级原文编辑链补列（老库 source_chapters 只有正文/哈希/字数）：幂等 ALTER，不升 schema version。 */
    private ensureSourceChapterColumns() {
        const columns = this.db.prepare("PRAGMA table_info(source_chapters)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "source_format")) {
            this.db.exec("ALTER TABLE source_chapters ADD COLUMN source_format TEXT NOT NULL DEFAULT ''");
        }
        if (!columns.some((column) => column.name === "revision")) {
            this.db.exec("ALTER TABLE source_chapters ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
        }
        if (!columns.some((column) => column.name === "updated_at")) {
            this.db.exec("ALTER TABLE source_chapters ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
        }
    }

    close() { this.db.close(); }

    private migrate() {
        const versions = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        const version = versions ? Number(this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0) : 0;
        if (version === DATABASE_SCHEMA_VERSION) return;
        if (version !== 0 && version !== MINIMUM_DATABASE_SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}; upgrade to schema 52 with the previous Backend first.`);
        if (!versions && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error("Unversioned existing database; refusing to initialize over user data.");
        if (versions && version === 0) throw new Error("Empty schema version history; refusing to modify existing data.");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (!versions) this.db.exec(CURRENT_DATABASE_SCHEMA);
            else migrateStorageFormat(this.db);
            this.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(DATABASE_SCHEMA_VERSION, new Date().toISOString());
            this.db.exec("COMMIT");
        } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    }

    /** The production row that owns this canvas, when it is an archived episode's canvas. */
    archivedEpisodeForCanvas(projectId: string): { episodeId: string; archivedAt: string } | undefined {
        const row = this.db.prepare(`SELECT e.id AS episodeId, p.archived_at AS archivedAt
            FROM drama_episodes e JOIN episode_productions p ON p.episode_id = e.id
            WHERE e.canvas_id = ? AND p.archived_at IS NOT NULL`).get(projectId) as { episodeId: string; archivedAt: string } | undefined;
        return row;
    }

    // ── canvas_projects ───────────────────────────────────────────────────

    listCanvasProjects(): CanvasProject[] {
        const rows = this.db.prepare("SELECT id FROM canvas_projects ORDER BY updated_at DESC").all() as Array<{ id: string }>;
        return rows.flatMap(({ id }) => { const project = this.getCanvasProject(id); return project ? [project] : []; });
    }

    /**
     * 反查引用段用的轻量节点投影：一次查询只取项目/节点 id 与原始 metadata，
     * 不重建项目头、连线，也不做共享资产解析（反查只读 ID 与段字段）。
     */
    listCanvasNodesForRestyle(): Array<{ projectId: string; nodeId: string; type: string; metadata: Record<string, unknown> }> {
        const rows = this.db.prepare("SELECT project_id AS projectId, node_id AS nodeId, node_json AS nodeJson FROM canvas_nodes ORDER BY project_id, ordinal").all() as Array<{ projectId: string; nodeId: string; nodeJson: string }>;
        return rows.flatMap(({ projectId, nodeId, nodeJson }) => {
            try {
                const node = JSON.parse(nodeJson) as Record<string, unknown>;
                if (!node || typeof node !== "object" || Array.isArray(node)) return [];
                const metadata = node.metadata;
                const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
                return [{ projectId, nodeId, type: String(node.type || ""), metadata: safeMetadata }];
            } catch { return []; }
        });
    }

    listCanvasProjectsByEpisode(episodeId: string): CanvasProject[] {
        const ep = this.getDramaEpisode(episodeId);
        if (!ep || !ep.canvasId) return [];
        const proj = this.getCanvasProject(ep.canvasId);
        return proj ? [proj] : [];
    }

    listCanvasProjectsByDrama(dramaId: string): Array<{ episode: DramaEpisode; canvas: CanvasProject | null }> {
        const episodes = this.listDramaEpisodes(dramaId);
        return episodes.map((episode) => ({
            episode,
            canvas: episode.canvasId ? this.getCanvasProject(episode.canvasId) : null,
        }));
    }

    listCanvasProjectSummaries(filter?: { episodeId?: string; id?: string }): CanvasProject[] {
        const episode = filter?.episodeId ? this.getDramaEpisode(filter.episodeId) : undefined;
        if (filter?.episodeId && !episode?.canvasId) return [];
        const id = episode?.canvasId || filter?.id;
        const rows = this.db.prepare(`SELECT id, updated_at AS updatedAt,
            json_extract(data_json, '$.title') AS title,
            json_extract(data_json, '$.createdAt') AS createdAt,
            COALESCE(json_extract(data_json, '$.revision'), 0) AS revision,
            node_count AS nodeCount, connection_count AS connectionCount
            FROM canvas_projects ${id ? "WHERE id = ?" : ""} ORDER BY updated_at DESC`).all(...(id ? [id] : [])) as CanvasProject[];
        return episode ? rows.map(row => ({ ...row, episodeId: episode.id, dramaId: episode.dramaId })) : rows;
    }

    /** 同一条 SQLite 查询取得 revision 与节点目录，避免把完整 metadata 载入 MCP。 */
    getCanvasProjectIndex(id: string, ifRevision?: number): Record<string, unknown> | null {
        const rows = this.db.prepare(`SELECT p.id, p.updated_at AS updatedAt,
            json_extract(p.data_json, '$.title') AS title,
            COALESCE(json_extract(p.data_json, '$.revision'), 0) AS revision,
            p.node_count AS nodeCount,
            p.connection_count AS connectionCount,
            json_extract(n.node_json, '$.id') AS nodeId,
            json_extract(n.node_json, '$.type') AS nodeType,
            COALESCE(json_extract(n.node_json, '$.metadata.sharedAssetReference.edits.title.value'), json_extract(n.node_json, '$.title'), (SELECT json_extract(s.node_json, '$.title') FROM canvas_nodes s WHERE s.project_id=json_extract(n.node_json, '$.metadata.sharedAssetReference.sourceProjectId') AND s.node_id=json_extract(n.node_json, '$.metadata.sharedAssetReference.sourceNodeId'))) AS nodeTitle,
            json_extract(n.node_json, '$.metadata.generationMode') AS generationMode
            FROM canvas_projects p
            LEFT JOIN canvas_nodes n
                ON n.project_id = p.id AND COALESCE(json_extract(p.data_json, '$.revision'), 0) <> ?
            WHERE p.id = ? ORDER BY n.ordinal`)
            .all(ifRevision ?? -1, id) as Array<Record<string, unknown>>;
        if (!rows.length) return null;
        const first = rows[0];
        return {
            id: first.id, title: first.title, updatedAt: first.updatedAt,
            revision: Number(first.revision), nodeCount: Number(first.nodeCount),
            connectionCount: Number(first.connectionCount),
            ...(ifRevision === Number(first.revision) ? { unchanged: true } : {
                nodes: rows.filter((row) => row.nodeId != null).map((row) => ({
                    id: row.nodeId, type: row.nodeType, title: row.nodeTitle,
                    ...(row.generationMode ? { generationMode: row.generationMode } : {}),
                })),
            }),
        };
    }

    getCanvasProjectNodeSnapshot(id: string, nodeIds?: string[], selection = false, options: { includeConnections?: boolean } = {}): Record<string, unknown> | null {
        this.db.exec("BEGIN DEFERRED");
        try {
            const header = this.db.prepare("SELECT id, updated_at AS updatedAt, json_extract(data_json, '$.title') AS title, COALESCE(json_extract(data_json, '$.revision'),0) AS revision, json_extract(data_json, '$.selectedNodeIds') AS selectedNodeIds, node_count AS nodeCount, connection_count AS connectionCount FROM canvas_projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
            if (!header) { this.db.exec("COMMIT"); return null; }
            const ids = selection
                ? (Array.isArray(JSON.parse(String(header.selectedNodeIds || "[]"))) ? JSON.parse(String(header.selectedNodeIds || "[]")) as unknown[] : []).map(String)
                : [...new Set((nodeIds || []).map(String).filter(Boolean))];
            const idJson = JSON.stringify(ids);
            const nodes = ids.length ? this.db.prepare("SELECT n.node_json AS value FROM canvas_nodes n WHERE n.project_id = ? AND n.node_id IN (SELECT value FROM json_each(?)) ORDER BY n.ordinal").all(id, idJson) as Array<{ value: string }> : [];
            const connections = ids.length && options.includeConnections !== false ? this.db.prepare("SELECT c.connection_json AS value FROM canvas_connections c WHERE c.project_id = ? AND (json_extract(c.connection_json, '$.fromNodeId') IN (SELECT value FROM json_each(?)) OR json_extract(c.connection_json, '$.toNodeId') IN (SELECT value FROM json_each(?))) ORDER BY c.ordinal").all(id, idJson, idJson) as Array<{ value: string }> : [];
            const nodeValues = nodes.map(row => JSON.parse(row.value));
            const connectionValues = connections.map(row => JSON.parse(row.value));
            this.db.exec("COMMIT");
            return { id, title: String(header.title || ""), updatedAt: String(header.updatedAt || ""), revision: Number(header.revision || 0), nodeCount: Number(header.nodeCount || 0), connectionCount: Number(header.connectionCount || 0), nodes: resolveProjectAssets(this, { id, nodes: nodeValues }).nodes, connections: connectionValues };
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    getCanvasH3NodeSummary(id: string, nodeId: string): Record<string, unknown> | null {
        const rows = this.db.prepare(`SELECT p.id, p.updated_at AS updatedAt, json_extract(p.data_json,'$.title') AS projectTitle, COALESCE(json_extract(p.data_json,'$.revision'),0) AS revision, json_extract(n.node_json,'$.id') AS nodeId, json_extract(n.node_json,'$.type') AS nodeType, json_extract(n.node_json,'$.title') AS nodeTitle, json_extract(s.value,'$.id') AS segmentId, json_extract(s.value,'$.sourceShotId') AS sourceShotId, json_extract(s.value,'$.productionClipProjection.targetId') AS targetId, json_extract(s.value,'$.title') AS segmentTitle, json_extract(s.value,'$.status') AS segmentStatus, (json_type(s.value,'$.result') IS NOT NULL OR json_extract(s.value,'$.resultStorageKey') IS NOT NULL) AS hasResult FROM canvas_projects p LEFT JOIN canvas_nodes n ON n.project_id=p.id AND n.node_id = ? LEFT JOIN json_each(n.node_json,'$.metadata.segments') s WHERE p.id = ? ORDER BY CAST(s.key AS INTEGER)`).all(nodeId, id) as Array<Record<string, unknown>>;
        if (!rows.length) return null;
        const first = rows[0];
        const production = this.db.prepare(`SELECT p.episode_id AS ownerId, 'episode' AS ownerKind, p.revision, p.draft_json AS snapshot
            FROM episode_productions p JOIN drama_episodes e ON e.id=p.episode_id WHERE e.canvas_id=?
            UNION ALL SELECT project_id AS ownerId, 'canvas' AS ownerKind, revision, draft_json AS snapshot
            FROM canvas_productions WHERE project_id=?`).get(id, id) as { ownerId: string; ownerKind: string; revision: number; snapshot: string } | undefined;
        const numbering = production ? productionNumbering(JSON.parse(production.snapshot).director?.source || {}) : undefined;
        const segments = rows.filter(row => row.segmentId != null).map(row => ({ id: row.segmentId, sourceShotId: row.sourceShotId || "", title: row.segmentTitle || "", status: row.segmentStatus || "idle",
            ...(row.targetId ? { productionClipProjection: { targetId: row.targetId }, productionNumbering: numbering?.clips.find(clip => clip.segmentId === row.targetId) || null } : {}),
            ...(Number(row.hasResult) === 1 ? { result: true } : {}) }));
        const nodes = first.nodeId == null ? [] : [{ id: first.nodeId, type: first.nodeType, title: first.nodeTitle || "", metadata: { segments, ...(production ? { productionOwnerKind: production.ownerKind, productionOwnerId: production.ownerId, productionRevision: production.revision } : {}) } }];
        return { id: first.id, title: first.projectTitle || "", updatedAt: first.updatedAt, revision: Number(first.revision || 0), nodes };
    }

    getCanvasProjectH3Context(id: string, nodeId: string, segmentId?: string, requestedDependencies: { sourceNodeIds?: string[]; assetIds?: string[]; segmentIds?: string[]; savedOnly?: boolean } = {}): Record<string, unknown> | null {
        this.db.exec("BEGIN DEFERRED");
        try {
            const header = this.db.prepare("SELECT id, updated_at AS updatedAt, json_extract(data_json, '$.title') AS title, COALESCE(json_extract(data_json, '$.revision'),0) AS revision FROM canvas_projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
            if (!header) { this.db.exec("COMMIT"); return null; }
            const targetRow = this.db.prepare("SELECT n.node_json AS value FROM canvas_nodes n WHERE n.project_id = ? AND n.node_id = ?").get(id, nodeId) as { value: string } | undefined;
            if (!targetRow) { this.db.exec("COMMIT"); return { id, title: String(header.title || ""), revision: Number(header.revision || 0), updatedAt: String(header.updatedAt || ""), nodes: [], referenceCatalog: [] }; }
            const target = JSON.parse(targetRow.value) as Record<string, unknown>;
            const metadata = target.metadata && typeof target.metadata === "object" ? target.metadata as Record<string, unknown> : {};
            const allSegments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
            const requested = requestedDependencies.segmentIds ? new Set(requestedDependencies.segmentIds) : undefined;
            const segments = segmentId ? allSegments.filter(segment => String(segment.id || "") === segmentId) : requested ? allSegments.filter(segment => requested.has(String(segment.id))) : allSegments;
            if (requestedDependencies.savedOnly) {
                this.db.exec("COMMIT");
                return { id, title: String(header.title || ""), revision: Number(header.revision || 0), updatedAt: String(header.updatedAt || ""), nodes: [{ id: target.id, type: target.type, title: target.title, metadata: { segments } }] };
            }
            const assetIds = new Set((requestedDependencies.assetIds || []).map(String).map(value => value.trim()).filter(Boolean));
            const sourceNodeIds = new Set((requestedDependencies.sourceNodeIds || []).map(String).map(value => value.trim()).filter(Boolean));
            for (const segment of segments) {
                for (const binding of Array.isArray(segment.referenceBindings) ? segment.referenceBindings as Array<Record<string, unknown>> : []) {
                    if (binding.assetId) assetIds.add(String(binding.assetId));
                    if (binding.sourceNodeId) sourceNodeIds.add(String(binding.sourceNodeId));
                    if (binding.nodeId) sourceNodeIds.add(String(binding.nodeId));
                }
                for (const group of Object.values(segment.h3CharacterGroups && typeof segment.h3CharacterGroups === "object" ? segment.h3CharacterGroups as Record<string, unknown> : {})) {
                    if (group && typeof group === "object" && (group as Record<string, unknown>).characterNodeId) sourceNodeIds.add(String((group as Record<string, unknown>).characterNodeId));
                }
                for (const field of ["refItems", "refs"]) {
                    const legacy = segment[field];
                    const values = Array.isArray(legacy) ? legacy : legacy && typeof legacy === "object" ? Object.values(legacy as Record<string, unknown>).flatMap(value => Array.isArray(value) ? value : [value]) : [];
                    for (const value of values) if (value && typeof value === "object") {
                        const ref = value as Record<string, unknown>;
                        if (ref.assetId) assetIds.add(String(ref.assetId));
                        if (ref.nodeId || ref.sourceNodeId) sourceNodeIds.add(String(ref.nodeId || ref.sourceNodeId));
                    }
                }
            }
            const assetList = [...assetIds];
            const assets = assetList.length ? this.db.prepare("SELECT r.value AS value FROM canvas_projects p, json_each(p.data_json, '$.referenceCatalog') r WHERE p.id = ? AND json_extract(r.value, '$.id') IN (SELECT value FROM json_each(?))").all(id, JSON.stringify(assetList)) as Array<{ value: string }> : [];
            for (const row of assets) { const source = (JSON.parse(row.value) as Record<string, unknown>).sourceNodeId; if (source) sourceNodeIds.add(String(source)); }
            const sourceIds = [...sourceNodeIds].filter(value => value !== nodeId);
            const sources = sourceIds.length ? this.db.prepare("SELECT n.node_json AS value FROM canvas_nodes n WHERE n.project_id = ? AND n.node_id IN (SELECT value FROM json_each(?)) ORDER BY n.ordinal").all(id, JSON.stringify(sourceIds)) as Array<{ value: string }> : [];
            const referenceAssets = assets.map(row => JSON.parse(row.value));
            const referenceNodes = sources.map(row => JSON.parse(row.value));
            if (segmentId) metadata.segments = segments;
            this.db.exec("COMMIT");
            return { id, title: String(header.title || ""), revision: Number(header.revision || 0), updatedAt: String(header.updatedAt || ""), nodes: resolveProjectAssets(this, { id, nodes: [target, ...referenceNodes] }).nodes, referenceCatalog: referenceAssets };
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    createCanvasProject(input: CanvasProject, withinTransaction = false) {
        if (typeof input?.id !== "string" || !input.id.trim()) throw new Error("project.id 必填");
        const project = stripCanvasLocalViewState(input as unknown as Record<string, unknown>) as unknown as CanvasProject;
        const referenceArchives: Array<{ nodeId: string; segmentId: string; legacy: string }> = [];
        for (const node of Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []) {
            if (!isH3CanvasNode(node)) continue;
            canonicalizeH3References(node, (segment, index) => referenceArchives.push({
                nodeId: String(node.id || ""),
                segmentId: String(segment.id || `index:${index}`),
                legacy: JSON.stringify({ refItems: segment.refItems, refs: segment.refs }),
            }));
            registerH3ReferenceAssets(project as unknown as Record<string, unknown>, node);
        }
        delete project.folderId;
        // revision 是后台权威顺序；导入/新建均从零开始，不能把外部版本带进本地日志。
        project.revision = 0;
        const seedHash = (value: CanvasProject) => {
            const { revision: _revision, updatedAt: _updatedAt, createdAt: _createdAt, folderId: _folderId, ...seed } = value;
            return commandFingerprint(seed);
        };
        this.db.exec(withinTransaction ? "SAVEPOINT create_shared_canvas" : "BEGIN IMMEDIATE");
        try {
            const current = this.getCanvasProject(project.id);
            if (current) {
                const checkpoint = this.db.prepare("SELECT revision, data_json FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(project.id) as { revision: number; data_json: string } | undefined;
                if (!checkpoint || checkpoint.revision !== 0 || seedHash(JSON.parse(checkpoint.data_json)) !== seedHash(project)) {
                    throw Object.assign(collaborationError("PROJECT_EXISTS", "画布已存在，不能用整图覆盖；请提交增量操作或使用新 ID 导入"), { project: current, revision: current.revision });
                }
                this.db.exec(withinTransaction ? "RELEASE create_shared_canvas" : "COMMIT");
                return { project: current, created: false };
            }
            const now = new Date().toISOString();
            project.createdAt ||= now;
            project.updatedAt = now;
            const json = JSON.stringify(project);
            createStoredProject(this.db, project);
            const archive = this.db.prepare("INSERT INTO h3_reference_legacy_archive (project_id, node_id, segment_id, legacy_json, archived_at) VALUES (?, ?, ?, ?, ?)");
            for (const item of referenceArchives) archive.run(project.id, item.nodeId, item.segmentId, item.legacy, now);
            this.db.prepare("INSERT INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, 0, ?)").run(project.id, json);
            this.db.exec(withinTransaction ? "RELEASE create_shared_canvas" : "COMMIT");
            return { project, created: true };
        } catch (error) {
            this.db.exec(withinTransaction ? "ROLLBACK TO create_shared_canvas; RELEASE create_shared_canvas" : "ROLLBACK");
            throw error;
        }
    }

    getCanvasText(id: string, input: unknown) {
        const target = textTargetSchema.parse(input);
        const project = this.getCanvasProject(id);
        if (!project) throw new Error(`画布不存在: ${id}`);
        const text = readText(project, target);
        const row = this.db.prepare("SELECT state FROM canvas_text_documents WHERE project_id = ? AND target_key = ?").get(id, textKey(target)) as { state: Uint8Array } | undefined;
        const doc = loadTextDocument(row?.state, text);
        try {
            if (doc.getText("text").toString() !== text) replaceText(doc, text);
            const state = Y.encodeStateAsUpdate(doc);
            const documentId = this.saveCanvasText(id, target, state);
            return { projectId: id, target, documentId, text, revision: Number(project.revision || 0), state: Buffer.from(state).toString("base64"), stateVector: Buffer.from(Y.encodeStateVector(doc)).toString("base64") };
        } finally { doc.destroy(); }
    }

    private saveCanvasText(id: string, target: CanvasTextTarget, state: Uint8Array) {
        const row = this.db.prepare("INSERT INTO canvas_text_documents (project_id, target_key, state, document_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, target_key) DO UPDATE SET state = excluded.state RETURNING document_id").get(id, textKey(target), state, crypto.randomUUID()) as { document_id: string };
        return row.document_id;
    }

    private applyCanvasTextOperation(id: string, project: Record<string, unknown>, operation: CanvasOperation): CanvasOperation {
        const target = textTargetSchema.parse(operation.target);
        const current = readText(project, target);
        const row = this.db.prepare("SELECT state, document_id FROM canvas_text_documents WHERE project_id = ? AND target_key = ?").get(id, textKey(target)) as { state: Uint8Array; document_id: string } | undefined;
        if (!row || row.document_id !== operation.documentId) throw collaborationError("TEXT_DOCUMENT_REPLACED", "文本对象已被替换，请保留旧草稿并重新读取目标");
        const doc = loadTextDocument(row.state, current);
        try {
            if (doc.getText("text").toString() !== current) replaceText(doc, current);
            const before = Y.encodeStateVector(doc);
            if (operation.type === "text_replace") {
                if (typeof operation.expectedText !== "string" || typeof operation.text !== "string") throw new Error("条件替换必须提供原文和新文本");
                if (current !== operation.expectedText) throw collaborationError("TEXT_CONFLICT", "原文已变化，改写结果需作为建议保留，不能覆盖当前文本");
                replaceText(doc, operation.text);
            } else {
                if (typeof operation.update !== "string" || !operation.update) throw new Error("缺少 Yjs 文本增量");
                Y.applyUpdate(doc, Buffer.from(operation.update, "base64"));
            }
            if ([...doc.share.keys()].some((key) => key !== "text") || doc.getText("text").toDelta().some((item: { insert?: unknown }) => typeof item.insert !== "string")) throw new Error("协作文本只允许纯文字增量");
            this.saveCanvasText(id, target, Y.encodeStateAsUpdate(doc));
            return { ...textOperation(target, doc.getText("text").toString(), project), textUpdate: { target, documentId: row.document_id, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") } };
        } finally { doc.destroy(); }
    }

    listCanvasTextSuggestions(id: string, input?: unknown): CanvasTextSuggestion[] {
        if (!this.getCanvasProject(id)) throw new Error(`画布不存在: ${id}`);
        const target = input === undefined ? undefined : textTargetSchema.parse(input);
        const rows = (target
            ? this.db.prepare("SELECT data_json FROM canvas_text_suggestions WHERE project_id = ? AND target_key = ?").all(id, textKey(target))
            : this.db.prepare("SELECT data_json FROM canvas_text_suggestions WHERE project_id = ?").all(id)) as Array<{ data_json: string }>;
        return rows.map((row) => JSON.parse(row.data_json) as CanvasTextSuggestion).sort((a, b) => b.revision - a.revision);
    }

    private applyTextSuggestion(id: string, project: Record<string, unknown>, operation: CanvasOperation): CanvasOperation {
        let suggestion: CanvasTextSuggestion;
        let canonical: CanvasOperation = { type: "text_suggestion" };
        if (operation.type === "save_text_suggestion") {
            const input = textSuggestionInputSchema.parse(operation.suggestion);
            const existing = this.db.prepare("SELECT data_json FROM canvas_text_suggestions WHERE project_id = ? AND id = ?").get(id, input.id) as { data_json: string } | undefined;
            if (existing) {
                const saved = JSON.parse(existing.data_json) as CanvasTextSuggestion;
                if (commandFingerprint(textSuggestionInputSchema.parse(saved)) !== commandFingerprint(input)) throw collaborationError("OPERATION_ID_REUSED", "候选 ID 已用于不同内容");
                return { ...canonical, textSuggestion: saved };
            }
            // 生成途中目标可能被删除；仍保存返回结果，但绝不自动写入新建的同 ID 目标。
            suggestion = { ...input, status: "pending", revision: Number(project.revision || 0) + 1 };
        } else {
            const row = this.db.prepare("SELECT data_json FROM canvas_text_suggestions WHERE project_id = ? AND id = ?").get(id, String(operation.id || "")) as { data_json: string } | undefined;
            if (!row) throw new Error("找不到改写候选");
            suggestion = JSON.parse(row.data_json) as CanvasTextSuggestion;
            if (operation.action !== "apply" && operation.action !== "dismiss") throw new Error("候选操作必须为 apply 或 dismiss");
            if (suggestion.status !== "pending") throw collaborationError("TEXT_SUGGESTION_RESOLVED", "候选已被处理，请同步最新状态");
            if (operation.action === "apply") {
                if (operation.documentId !== suggestion.documentId) throw collaborationError("TEXT_DOCUMENT_REPLACED", "候选属于旧文本对象，不能应用到重建的目标");
                canonical = this.applyCanvasTextOperation(id, project, { type: "text_replace", target: suggestion.target, documentId: suggestion.documentId, expectedText: operation.expectedText, text: suggestion.text });
            }
            suggestion = { ...suggestion, status: operation.action === "apply" ? "applied" : "dismissed", revision: Number(project.revision || 0) + 1 };
        }
        this.db.prepare("INSERT INTO canvas_text_suggestions (project_id, id, target_key, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET data_json = excluded.data_json")
            .run(id, suggestion.id, textKey(suggestion.target), JSON.stringify(suggestion));
        return { ...canonical, textSuggestion: suggestion };
    }

    private restoreH3OutputOperation(projectId: string, project: Record<string, unknown>, operation: CanvasOperation): CanvasOperation {
        const nodeId = String(operation.nodeId || "");
        const segmentId = String(operation.segmentId || "");
        const requestedKey = String(operation.storageKey || "");
        const log = operation.generationLogId ? this.getGenerationLog(String(operation.generationLogId)) : null;
        const logUsable = Boolean(log && log.projectId === projectId && log.nodeId === nodeId);
        // 没有可用日志时仍可切换：H3 节点自己留存的结果（clip.results[]）是画布内生成/恢复的成品清单，
        // 生成日志被裁剪、或画布直接生成时只有这里还留着；下面按 storageKey 从本 Clip 的留存里定位。
        if (!logUsable && !requestedKey) throw new Error("历史输出不属于当前 H3 节点");
        const node = (Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []).find((item) => String(item.id) === nodeId);
        if (!isH3CanvasNode(node)) throw new Error("找不到目标 H3 节点");
        const activeTaskId = String(recordOf(node!.metadata).runtimeTaskId || "");
        if (activeTaskId && ["queued", "running", "awaiting_confirmation"].includes(this.getTask(activeTaskId)?.status || "")) throw new Error("H3 节点正在运行，不能还原历史输出");
        const segment = (Array.isArray(recordOf(node!.metadata).segments) ? recordOf(node!.metadata).segments as Array<Record<string, unknown>> : []).find((item) => String(item.id) === segmentId);
        if (!segment) throw new Error("找不到目标 Clip");
        if (["queued", "loading", "awaiting_confirmation"].includes(String(segment.status || ""))) throw new Error("Clip 正在运行，不能还原历史输出");
        const settings = recordOf(operation.settings);
        if (Object.keys(settings).some((key) => key === "id" || H3_RUNTIME_SEGMENT_FIELDS.includes(key as typeof H3_RUNTIME_SEGMENT_FIELDS[number]))) throw new Error("历史参数包含后台运行字段");
        let storageKey = "";
        let mimeType = "video/mp4";
        let generationLogId = logUsable ? log!.id : "";
        if (logUsable) {
            const output = log!.outputs.find((item) => (!requestedKey || item.storageKey === requestedKey) && String(item.mimeType || "video/mp4").startsWith("video/"));
            storageKey = String(output?.storageKey || "");
            mimeType = String(output?.mimeType || "video/mp4");
        } else {
            const kept = (Array.isArray(segment.results) ? segment.results as Array<Record<string, unknown>> : [])
                .find((item) => String(item.storageKey || "") === requestedKey
                    && (String(item.mimeType || "video/").startsWith("video/") || requestedKey.startsWith("video:")));
            if (!kept) throw new Error("历史输出不属于当前 H3 节点");
            storageKey = String(kept.storageKey);
            mimeType = String(kept.mimeType || "video/mp4");
            generationLogId = String(kept.generationLogId || "");
        }
        const media = storageKey ? this.getMediaFile(storageKey) : null;
        if (!media || !fs.existsSync(media.filePath)) throw new Error("历史输出媒体已丢失，不能还原");
        const url = `/media/${encodeURIComponent(storageKey)}`;
        // 保留 Clip 自己留存的其它历史结果，只把被选中的这一项标为 restore 并放到首位。
        // 之前整体替换成单条会让只在 results[] 留存、日志已裁剪的版本永久消失，再次按 storageKey 还原会报「不属于当前节点」。
        const priorResults = (Array.isArray(segment.results) ? segment.results as Array<Record<string, unknown>> : [])
            .filter((item) => String(item.storageKey || "") !== storageKey)
            .map((item) => ({ ...item }));
        return { type: "update_h3_segment", nodeId, segmentId, patch: {
            ...withH3ParameterEdits(segment, settings),
            // restore 是真实写回：在当前结果条目上落来源标记 + 生成日志凭证，
            // 段版本派生据此把「当前项」显示为 restore（切版本），其余历史版本仍读各自生成日志来源。
            result: url, resultStorageKey: storageKey, results: [{
                url, storageKey, mimeType,
                ...(generationLogId ? { generationLogId } : {}), source: "restore",
            }, ...priorResults],
            status: "success", progress: 1, runtimeTaskId: "", cacheFingerprint: "",
            firstPassReady: false, firstPassResult: "", firstPassStorageKey: "", firstPassFingerprint: "",
        } };
    }

    readCanvasChanges(id: string, afterRevision: number) {
        const project = this.getCanvasProject(id);
        if (!project) throw new Error(`画布不存在: ${id}`);
        if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new Error("afterRevision 必须为非负整数");
        const revision = Number(project.revision || 0);
        const rows = this.db.prepare("SELECT * FROM canvas_operation_batches WHERE project_id = ? AND revision > ? ORDER BY revision").all(id, afterRevision) as Array<Record<string, unknown>>;
        const commits: CanvasCommit[] = rows.map((row) => ({ projectId: id, operationId: String(row.operation_id), baseRevision: Number(row.base_revision), revision: Number(row.revision), source: JSON.parse(String(row.source_json)), operations: decodeStoredJson(row.operations_json), operationResults: decodeStoredJson(row.results_json), updatedAt: String(row.created_at) }));
        const complete = afterRevision <= revision && commits.length === revision - afterRevision && commits.every((commit, index) => commit.baseRevision === afterRevision + index && commit.revision === afterRevision + index + 1);
        return { projectId: id, revision, reset: !complete, commits: complete ? commits : [], ...(!complete ? { project } : {}) };
    }

    private canvasProjectAt(id: string, revision: number): CanvasProject {
        return reconstructCanvasHistory(this.db, id, revision) as CanvasProject;
    }

    getCanvasOperationReceipt(id: string, operationId: string): { committed: boolean; revision?: number; snapshotAvailable?: boolean } {
        const row = this.db.prepare("SELECT r.committed_revision AS revision, b.operation_id AS batchId FROM canvas_command_receipts r LEFT JOIN canvas_operation_batches b ON b.operation_id = r.operation_id WHERE r.project_id = ? AND r.operation_id = ?")
            .get(id, operationId) as { revision: number; batchId: string | null } | undefined;
        return row ? { committed: true, revision: Number(row.revision), snapshotAvailable: Boolean(row.batchId) } : { committed: false };
    }

    prepareMcpCommand(input: { operationId: string; tool: string; targetId: string; projectId?: string; request: unknown; payload: Record<string, unknown>; receipt: Record<string, unknown> }): McpCommandReceipt {
        const requestHash = commandFingerprint({ tool: input.tool, targetId: input.targetId, request: input.request });
        const current = this.db.prepare("SELECT * FROM mcp_command_receipts WHERE operation_id = ?").get(input.operationId) as Record<string, unknown> | undefined;
        if (current) {
            if (current.tool !== input.tool || current.target_id !== input.targetId || current.request_hash !== requestHash || (current.project_id || null) !== (input.projectId || null)) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于不同工具、目标或请求");
            return this.mapMcpCommandReceipt(current);
        }
        const now = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const raced = this.db.prepare("SELECT * FROM mcp_command_receipts WHERE operation_id = ?").get(input.operationId) as Record<string, unknown> | undefined;
            if (raced) {
                if (raced.tool !== input.tool || raced.target_id !== input.targetId || raced.request_hash !== requestHash || (raced.project_id || null) !== (input.projectId || null)) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于不同工具、目标或请求");
                this.db.exec("COMMIT");
                return this.mapMcpCommandReceipt(raced);
            }
            if (this.db.prepare("SELECT 1 FROM canvas_command_receipts WHERE operation_id = ? UNION SELECT 1 FROM canvas_operation_batches WHERE operation_id = ?").get(input.operationId, input.operationId))
                throw collaborationError("OPERATION_ID_REUSED", "operationId 已被画布操作使用；请生成新的稳定 ID");
            this.db.prepare("INSERT INTO mcp_command_receipts (operation_id, tool, target_id, project_id, request_hash, status, payload_json, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)")
                .run(input.operationId, input.tool, input.targetId, input.projectId || null, requestHash, JSON.stringify(input.payload), JSON.stringify(input.receipt), now, now);
            this.db.exec("COMMIT");
            return { operationId: input.operationId, tool: input.tool, targetId: input.targetId, status: "prepared", requestHash, receipt: input.receipt, payload: input.payload };
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    updatePreparedMcpCommand(input: { operationId: string; tool: string; targetId: string; projectId?: string; request: unknown; payload: Record<string, unknown>; receipt: Record<string, unknown> }): McpCommandReceipt {
        const requestHash = commandFingerprint({ tool: input.tool, targetId: input.targetId, request: input.request });
        const result = this.db.prepare("UPDATE mcp_command_receipts SET payload_json = ?, receipt_json = ?, updated_at = ? WHERE operation_id = ? AND tool = ? AND target_id = ? AND project_id IS ? AND request_hash = ? AND status = 'prepared'")
            .run(JSON.stringify(input.payload), JSON.stringify(input.receipt), new Date().toISOString(), input.operationId, input.tool, input.targetId, input.projectId || null, requestHash);
        if (Number(result.changes || 0) !== 1) throw collaborationError("MCP_COMMAND_NOT_PREPARED", "MCP 命令不再处于可更新的准备状态");
        const updated = this.getMcpCommandReceipt(input.operationId, { tool: input.tool, targetId: input.targetId, projectId: input.projectId, request: input.request });
        if (!updated) throw collaborationError("MCP_COMMAND_NOT_PREPARED", "MCP 命令准备回执已丢失");
        return updated;
    }

    getMcpCommandReceipt(operationId: string, identity?: { tool: string; targetId: string; request: unknown; projectId?: string }): McpCommandReceipt | null {
        const row = this.db.prepare("SELECT * FROM mcp_command_receipts WHERE operation_id = ?").get(operationId) as Record<string, unknown> | undefined;
        if (!row) {
            const legacy = this.db.prepare("SELECT project_id, committed_revision, request_hash FROM canvas_command_receipts WHERE operation_id = ?").get(operationId) as { project_id: string; committed_revision: number; request_hash: string } | undefined;
            if (!legacy) return null;
            if (identity) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于非 v2 命令；请使用新的稳定 ID");
            return { operationId, tool: "canvas_ops", targetId: legacy.project_id, status: "committed", requestHash: legacy.request_hash, committedRevision: Number(legacy.committed_revision), snapshotAvailable: this.getCanvasOperationReceipt(legacy.project_id, operationId).snapshotAvailable, receipt: { ok: true, committed: true, operationId, projectId: legacy.project_id, revision: Number(legacy.committed_revision), snapshotAvailable: this.getCanvasOperationReceipt(legacy.project_id, operationId).snapshotAvailable, replayed: true } };
        }
        if (identity) {
            const requestHash = commandFingerprint({ tool: identity.tool, targetId: identity.targetId, request: identity.request });
            if (row.tool !== identity.tool || row.target_id !== identity.targetId || row.request_hash !== requestHash || (row.project_id || null) !== (identity.projectId || null)) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于不同工具、目标或请求");
        }
        return this.mapMcpCommandReceipt(row);
    }

    listPreparedMcpCommands(tool?: string): McpCommandReceipt[] {
        const rows = tool
            ? this.db.prepare("SELECT * FROM mcp_command_receipts WHERE status='prepared' AND payload_json IS NOT NULL AND tool=? ORDER BY created_at, operation_id").all(tool)
            : this.db.prepare("SELECT * FROM mcp_command_receipts WHERE status='prepared' AND payload_json IS NOT NULL ORDER BY created_at, operation_id").all();
        return rows.map(row => this.mapMcpCommandReceipt(row as Record<string, unknown>));
    }

    updatePreparedMcpCommandReceipt(operationId: string, receipt: Record<string, unknown>) {
        this.db.prepare("UPDATE mcp_command_receipts SET receipt_json=?, updated_at=? WHERE operation_id=? AND status='prepared'")
            .run(JSON.stringify(receipt), new Date().toISOString(), operationId);
        return this.getMcpCommandReceipt(operationId);
    }

    rejectMcpCommand(operationId: string, code: string, message: string) {
        this.db.prepare("UPDATE mcp_command_receipts SET status = 'rejected', payload_json = NULL, error_json = ?, updated_at = ? WHERE operation_id = ? AND status = 'prepared'")
            .run(JSON.stringify({ code, message }), new Date().toISOString(), operationId);
        return this.getMcpCommandReceipt(operationId);
    }

    private mapMcpCommandReceipt(row: Record<string, unknown>): McpCommandReceipt {
        return {
            operationId: String(row.operation_id), tool: String(row.tool), targetId: row.target_id == null ? null : String(row.target_id),
            projectId: row.project_id == null ? null : String(row.project_id),
            status: String(row.status) as McpCommandReceipt["status"], requestHash: String(row.request_hash),
            ...(row.committed_revision == null ? {} : { committedRevision: Number(row.committed_revision), snapshotAvailable: this.getCanvasOperationReceipt(String(row.project_id || ""), String(row.operation_id)).snapshotAvailable }),
            ...(typeof row.receipt_json === "string" ? { receipt: JSON.parse(row.receipt_json) as Record<string, unknown> } : {}),
            ...(row.status === "prepared" && typeof row.payload_json === "string" ? { payload: JSON.parse(row.payload_json) as Record<string, unknown> } : {}),
            ...(typeof row.error_json === "string" ? { error: JSON.parse(row.error_json) as { code: string; message: string } } : {}),
        };
    }

    private completeMcpCommand(operationId: string, revision: number, operations: CanvasOperation[]) {
        const row = this.db.prepare("SELECT tool, target_id, receipt_json FROM mcp_command_receipts WHERE operation_id = ? AND status = 'prepared'").get(operationId) as { tool: string; target_id: string | null; receipt_json: string | null } | undefined;
        if (!row) return;
        const preview = row.receipt_json ? JSON.parse(row.receipt_json) as Record<string, unknown> : {};
        const taskIds = operations.filter(operation => operation.type === "run_generation" && operation.idempotencyKey).map(operation => String(operation.idempotencyKey));
        const receipt = { ...preview, ...(row.tool === "production_translate_compiled_prompts" ? { translationStatus: "committed" } : {}), ok: true, committed: true, operationId, replayed: false, ...(row.target_id ? { targetId: row.target_id } : {}), revision, ...(taskIds.length ? { taskIds } : {}), changesHash: commandFingerprint(operations) };
        this.db.prepare("UPDATE mcp_command_receipts SET status = 'committed', payload_json = NULL, receipt_json = ?, committed_revision = ?, updated_at = ? WHERE operation_id = ? AND status = 'prepared'")
            .run(JSON.stringify(receipt), revision, new Date().toISOString(), operationId);
    }

    listAssetsPage(options: { kind?: string; keyword?: string; page?: number; pageSize?: number } = {}) {
        purgeOrphanedSharedAssets(this);
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (options.kind && options.kind !== "all") { clauses.push("kind = ?"); values.push(options.kind); }
        if (options.keyword?.trim()) {
            clauses.push("(instr(lower(title || ' ' || COALESCE(json_extract(data_json, '$.description'), '') || ' ' || COALESCE(json_extract(data_json, '$.content'), '') || ' ' || COALESCE(json_extract(data_json, '$.data.description'), '') || ' ' || COALESCE(json_extract(data_json, '$.data.content'), '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM canvas_nodes n WHERE n.project_id=json_extract(assets.metadata_json, '$.sharedAssetSource.sourceProjectId') AND n.node_id=json_extract(assets.metadata_json, '$.sharedAssetSource.sourceNodeId') AND instr(lower(COALESCE(json_extract(n.node_json, '$.metadata.characterDescription'), json_extract(n.node_json, '$.metadata.sceneDescription'), json_extract(n.node_json, '$.metadata.content'), '')), lower(?)) > 0))");
            values.push(options.keyword.trim(), options.keyword.trim());
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const page = Math.max(1, Math.floor(options.page || 1));
        const pageSize = Math.max(1, Math.floor(options.pageSize || 20));
        const offset = (page - 1) * pageSize;
        const allRows = this.db.prepare(`SELECT id, kind, title, metadata_json, tags_json, folder_id, drama_id, updated_at, created_at, length(COALESCE(json_extract(data_json, '$.content'), json_extract(data_json, '$.data.content'), '')) AS content_chars, (cover_url <> '') AS has_cover, COALESCE(json_extract(data_json, '$.storageKey'), json_extract(data_json, '$.assetRef.storageKey'), json_extract(data_json, '$.data.storageKey')) AS storage_key, COALESCE(json_extract(data_json, '$.mimeType'), json_extract(data_json, '$.assetRef.mimeType'), json_extract(data_json, '$.data.mimeType')) AS mime_type FROM assets ${where} ORDER BY updated_at DESC, id ASC`).all(...values) as Array<Record<string, unknown>>;
        const canonicalIds = canonicalSharedAssetIds(this, allRows.map(row => ({ id: String(row.id), createdAt: String(row.created_at || ""), metadata: JSON.parse(String(row.metadata_json || "{}")) })));
        const visibleRows = allRows.filter(row => canonicalIds.has(String(row.id)));
        const total = visibleRows.length;
        const rows = visibleRows.slice(offset, offset + pageSize);
        return { total, page, pageSize, items: rows.map(row => {
            const bound = JSON.parse(String(row.metadata_json || "{}"))?.sharedAssetSource;
            const asset = bound ? this.getAsset(String(row.id)) : null;
            if (asset) { row.content_chars = String(asset.data.content || "").length; row.has_cover = Boolean(asset.coverUrl); row.storage_key = asset.data.storageKey; row.mime_type = asset.data.mimeType; }
            return ({ id: String(row.id), kind: String(row.kind), title: String(row.title), tags: JSON.parse(String(row.tags_json || "[]")), folderId: row.folder_id == null ? null : String(row.folder_id), dramaId: row.drama_id == null ? null : String(row.drama_id), updatedAt: String(row.updated_at), hasContent: Number(row.content_chars) > 0, contentChars: Number(row.content_chars), hasCover: Number(row.has_cover) === 1, ...(row.storage_key ? { storageKey: String(row.storage_key) } : {}), ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}) }); }) };
    }

    commitMcpAssetCommand(input: { operationId: string; tool: string; request: unknown; assets: Asset[] }): Record<string, unknown> {
        const targetId = "asset-library";
        const requestHash = commandFingerprint({ tool: input.tool, targetId, request: input.request });
        const commits: CanvasCommit[] = [];
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.db.prepare("SELECT * FROM mcp_command_receipts WHERE operation_id = ?").get(input.operationId) as Record<string, unknown> | undefined;
            if (!row || row.tool !== input.tool || row.target_id !== targetId || row.request_hash !== requestHash) throw collaborationError("OPERATION_ID_REUSED", "素材命令未预留或 operationId 属于其他请求");
            if (row.status === "committed") {
                const receipt = JSON.parse(String(row.receipt_json || "{}")) as Record<string, unknown>;
                this.db.exec("COMMIT");
                return { ...receipt, replayed: true };
            }
            if (row.status === "rejected") throw collaborationError(String((JSON.parse(String(row.error_json || "{}")) as Record<string, unknown>).code || "MCP_COMMAND_REJECTED"), String((JSON.parse(String(row.error_json || "{}")) as Record<string, unknown>).message || "素材命令已拒绝"));
            const frozenAssets = JSON.parse(String(row.payload_json || "{}")).assets;
            if (commandFingerprint(frozenAssets) !== commandFingerprint(input.assets)) throw collaborationError("OPERATION_ID_REUSED", "素材命令负载与 Backend 冻结内容不一致");
            const duplicateIds = input.assets.map(asset => asset.id).filter((id, index, all) => all.indexOf(id) !== index);
            if (duplicateIds.length) throw collaborationError("INVALID_INPUT", `批次内资产 ID 重复: ${[...new Set(duplicateIds)].join(", ")}`);
            const saved = input.assets.map(asset => this.upsertAsset(asset, { withinTransaction: true, deferredCommits: commits, canvasSource: (asset as Asset & { canvasSource?: AssetWriteCommand["canvasSource"] }).canvasSource }));
            const sharedAssets = saved.flatMap(asset => { const source = asset.metadata.sharedAssetSource as { sourceProjectId: string; sourceNodeId: string } | undefined; return source ? [{ assetId: asset.id, ...source, revision: this.getCanvasProjectRevision(source.sourceProjectId) }] : []; });
            const receipt = { ok: true, committed: true, operationId: input.operationId, replayed: false, count: saved.length, assetIds: saved.map(asset => asset.id), ...(sharedAssets.length ? { sharedAssets } : {}), changesHash: commandFingerprint(saved.map(asset => ({ id: asset.id, kind: asset.kind, title: asset.title, tags: asset.tags, updatedAt: asset.updatedAt }))) };
            this.db.prepare("UPDATE mcp_command_receipts SET status = 'committed', payload_json = NULL, receipt_json = ?, updated_at = ? WHERE operation_id = ?")
                .run(JSON.stringify(receipt), new Date().toISOString(), input.operationId);
            this.db.exec("COMMIT");
            for (const commit of commits) this.notifyCanvasCommit(commit);
            return receipt;
        } catch (error) {
            this.db.exec("ROLLBACK");
            const current = this.getMcpCommandReceipt(input.operationId);
            if (current?.status === "prepared" && current.tool === input.tool && current.targetId === targetId && current.requestHash === requestHash) this.rejectMcpCommand(input.operationId, "MCP_COMMAND_REJECTED", error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    private assertEmptySceneH3NodeCanBeDeleted(projectId: string, project: Record<string, unknown>, nodeId: string) {
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
        const node = nodes.find(item => String(item.id) === nodeId);
        if (!node || !isH3CanvasNode(node) || !node.metadata?.productionSceneId) return;
        const metadata = node.metadata as Record<string, any>;
        const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
        if (segments.length || metadata.content || metadata.storageKey || metadata.runtimeTaskId
            || ["queued", "loading", "generating", "awaiting_confirmation"].includes(String(metadata.status || ""))) {
            throw collaborationError("PRODUCTION_SCENE_NODE_OWNED", "该场次 H3 节点仍有 Clip、媒体或运行状态，不能作为空节点清理");
        }
        if ((Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [])
            .some(connection => connection.fromNodeId === nodeId || connection.toNodeId === nodeId)) {
            throw collaborationError("PRODUCTION_SCENE_NODE_OWNED", "该场次 H3 节点仍有画布连接，不能清理");
        }
        if (this.listTasks({ projectId, nodeIds: [nodeId], limit: 1 }).length
            || this.listGenerationLogs({ projectId, nodeId, limit: 1 }).length) {
            throw collaborationError("PRODUCTION_SCENE_NODE_OWNED", "该场次 H3 节点仍有任务或生成历史，不能清理");
        }
        const productionRows = [
            ...this.db.prepare("SELECT p.draft_json, p.published_json FROM episode_productions p JOIN drama_episodes e ON e.id = p.episode_id WHERE e.canvas_id = ?").all(projectId),
            ...this.db.prepare("SELECT draft_json, published_json FROM canvas_productions WHERE project_id = ?").all(projectId),
            ...this.db.prepare("SELECT p.draft_json, p.published_json FROM scene_productions p JOIN drama_scene_canvases c ON c.scene_id = p.scene_id WHERE c.canvas_id = ?").all(projectId),
        ] as Array<{ draft_json: string; published_json?: string | null }>;
        for (const row of productionRows) for (const json of [row.draft_json, row.published_json].filter((value): value is string => Boolean(value))) {
            let production: Record<string, unknown>;
            try { production = JSON.parse(json) as Record<string, unknown>; } catch { continue; }
            const groups = Array.isArray(production.clipGroups) ? production.clipGroups as Array<Record<string, unknown>> : [];
            if (groups.some(group => String(group.nodeId || "") === nodeId)) {
                throw collaborationError("PRODUCTION_SCENE_NODE_OWNED", "仍有草稿或已发布 Clip 绑定此节点，不能清理");
            }
        }
    }

    applyCanvasProjectOperations(id: string, expectedRevision: number | undefined, inputOperations: CanvasOperation[], context?: CanvasCommandContext) {
        const beginSql = context?.withinTransaction ? "SAVEPOINT production_canvas_ops" : "BEGIN IMMEDIATE";
        const commitSql = context?.withinTransaction ? "RELEASE SAVEPOINT production_canvas_ops" : "COMMIT";
        const rollbackSql = context?.withinTransaction ? "ROLLBACK TO SAVEPOINT production_canvas_ops; RELEASE SAVEPOINT production_canvas_ops" : "ROLLBACK";
        const operationId = context?.operationId || crypto.randomUUID();
        const fingerprint = commandFingerprint({ id, expectedRevision, baseRevision: context?.baseRevision, operations: inputOperations });
        const operations = structuredClone(inputOperations);
        let commit: CanvasCommit;
        const dependentCommits: CanvasCommit[] = [];
        this.db.exec(beginSql);
        try {
            if (context?.mcpCommand) {
                const identityHash = commandFingerprint({ tool: context.mcpCommand.tool, targetId: context.mcpCommand.targetId, request: context.mcpCommand.request });
                const frozen = this.db.prepare("SELECT tool, target_id, project_id, request_hash, status, payload_json FROM mcp_command_receipts WHERE operation_id = ?").get(operationId) as { tool: string; target_id: string; project_id: string | null; request_hash: string; status: string; payload_json: string | null } | undefined;
                if (!frozen || frozen.tool !== context.mcpCommand.tool || frozen.target_id !== context.mcpCommand.targetId || frozen.project_id !== id || frozen.request_hash !== identityHash || !["prepared", "committed"].includes(frozen.status)) throw collaborationError("MCP_COMMAND_MISMATCH", "MCP 冻结命令与画布提交不匹配");
                if (frozen.status === "prepared") {
                    const payload = JSON.parse(String(frozen.payload_json || "{}")) as Record<string, unknown>;
                    const frozenOperations = Array.isArray(payload.operations) ? payload.operations : [];
                    if (commandFingerprint(frozenOperations) !== commandFingerprint(inputOperations)) throw collaborationError("MCP_COMMAND_MISMATCH", "提交操作与 Backend 冻结操作不一致");
                    const frozenRevision = payload.baseRevision ?? payload.revision;
                    const submittedRevision = context.baseRevision ?? expectedRevision;
                    if (typeof frozenRevision === "number" && typeof submittedRevision === "number" && frozenRevision !== submittedRevision) throw collaborationError("MCP_COMMAND_MISMATCH", "提交版本与 Backend 冻结版本不一致");
                }
            }
            const previousRows = readStoredProjectRows(this.db, id);
            let current = this.canvasProjectView(previousRows ? rawProjectFromStoredRows(previousRows) : null);
            if (!current) throw new Error(`画布不存在: ${id}`);
            if (context?.referenceSourceBefore) {
                const before = context.referenceSourceBefore;
                current = { ...current, nodes: (current.nodes as AssetNode[]).map(node => node.metadata?.sharedAssetReference?.sourceProjectId === before.sourceProjectId && node.metadata.sharedAssetReference.sourceNodeId === before.sourceNodeId ? resolveSharedAssetNode(node, before.node) : node) };
            }
            const currentRevision = Number(current.revision || 0);
            {
                const existing = this.db.prepare("SELECT r.project_id AS projectId, r.committed_revision AS revision, b.operations_json AS operationsJson, b.results_json AS resultsJson, r.request_hash AS requestHash FROM canvas_command_receipts r LEFT JOIN canvas_operation_batches b ON b.operation_id = r.operation_id WHERE r.operation_id = ?").get(operationId) as { projectId: string; revision: number; operationsJson: StoredJson | null; resultsJson: StoredJson | null; requestHash?: string } | undefined;
                if (existing) {
                    if (context?.mcpCommand) {
                        const commandHash = commandFingerprint({ tool: context.mcpCommand.tool, targetId: context.mcpCommand.targetId, request: context.mcpCommand.request });
                        const v2 = this.db.prepare("SELECT request_hash, status FROM mcp_command_receipts WHERE operation_id = ?").get(operationId) as { request_hash: string; status: string } | undefined;
                        if (!v2 || v2.status !== "committed" || v2.request_hash !== commandHash) throw collaborationError("OPERATION_ID_REUSED", "operationId 已由另一项画布事务提交，请不要复用");
                    }
                    if (existing.projectId !== id || existing.requestHash !== fingerprint) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于不同请求，请勿修改重试请求内容");
                    if (existing.operationsJson === null || existing.resultsJson === null) throw Object.assign(collaborationError("RECEIPT_UNAVAILABLE", "操作已提交，历史快照已清理；请读取最新画布确认同步"), { committed: true, revision: Number(existing.revision), snapshotAvailable: false });
                    const project = this.canvasProjectAt(id, Number(existing.revision));
                    this.db.exec(commitSql);
                    return { project, revision: Number(existing.revision), operationId, operationResults: decodeStoredJson<CanvasOperationResult[]>(existing.resultsJson), operations: decodeStoredJson<CanvasOperation[]>(existing.operationsJson), duplicated: true };
                }
                // Legacy batches without a request hash must never be executed again.
                if (this.db.prepare("SELECT 1 FROM canvas_operation_batches WHERE operation_id = ?").get(operationId)) throw collaborationError("OPERATION_ID_REUSED", "历史 operationId 缺少可核验的请求指纹，拒绝重新执行");
            }
            // Archiving freezes the episode's canvas for user-facing编辑; runtime write-backs
            // (task results, production projections) still land so in-flight work can finish.
            if (!context?.runtimeWrite) {
                const archived = this.archivedEpisodeForCanvas(id);
                if (archived) throw collaborationError("PRODUCTION_ARCHIVED", "该分集已归档，画布为只读；请先取消归档再编辑");
            }
            if (!operations.length || operations.some((operation) => !operation || typeof operation.type !== "string")) throw new Error("operations 必须为非空有效操作数组");
            // baseRevision is a cursor for recovering the caller's intended base, not a
            // global lock. Patch operations are applied to the transaction's latest snapshot
            // so independent paths merge and same-path writes resolve by commit order.
            let intervening: CanvasCommit[] = [];
            let baseProject: CanvasProject | undefined;
            let baseHistoryUnavailable = false;
            if (context?.baseRevision !== undefined) {
                if (context.baseRevision > currentRevision) throw collaborationError("BASE_REVISION_AHEAD", "请求基线版本晚于当前画布版本");
                const history = this.readCanvasChanges(id, context.baseRevision);
                if (!history.reset) {
                    intervening = history.commits;
                    try { baseProject = this.canvasProjectAt(id, context.baseRevision); }
                    catch { /* Only operations that need a historical object image require this snapshot. */ }
                } else baseHistoryUnavailable = context.baseRevision < currentRevision;
            }
            // 乐观锁放行（last-write-wins）：客户端传的 expectedRevision 不再与 currentRevision 比对拦截，
            // 画布版本号仍照常自增；事务内读到的快照即本次写入基线（SQLite 单写者保证一致性）。
            // expectedRevision 仍参与命令指纹，同载荷重试的回放匹配不受影响。
            // getCanvasProject parses a fresh snapshot for this transaction; it has no shared owner.
            const project = current as CanvasProject;
            const assetBefore = structuredClone(current);
            const sourceAssetsBefore = this.listSharedAssetRecordsForProject(id);
            const editorialCheck = operations.some(operation => ["connect_nodes", "disconnect_nodes", "delete_connections", "delete_node", "update_h3_segment", "replace_h3_segments"].includes(operation.type) || operation.type === "update_node" && (operation.metadata || operation.metadataDelete));
            const editorialBefore = (!context?.runtimeWrite || context.referenceSourceBefore) && editorialCheck ? structuredClone(current) : null;
            const formalImageNodes = !context?.runtimeWrite ? (project.nodes as Record<string, any>[] || []).filter(node => node.metadata?.productionImageInput) : [];
            const formalSourceIds = new Set(formalImageNodes.map(node => node.metadata.productionImageInput.sourceNodeId));
            const imageInputBaseline = formalImageNodes.length ? structuredClone({
                nodes: formalImageNodes.map(node => ({ id: node.id, metadata: { productionImageInput: node.metadata.productionImageInput } })),
                connections: (project.connections as Record<string, any>[] || []).filter(edge => formalSourceIds.has(edge.toNodeId)),
            }) : undefined;
            const scriptBaseline = !context?.runtimeWrite && context?.source?.clientId !== "production:scripts" ? { nodes: structuredClone((Array.isArray(project.nodes) ? project.nodes as Record<string, any>[] : []).filter(node => node.metadata?.productionScriptId)) } : undefined;
            const entityBaseline = !["production:scripts", "production:layout"].includes(String(context?.source?.clientId || "")) ? { nodes: structuredClone((Array.isArray(project.nodes) ? project.nodes as Record<string, any>[] : []).filter(node => node.metadata?.productionEntity)) } : undefined;
            // 方案二：画布与制作台对等维护 Clip。操作前保存 H3 节点段列表快照，供回写制作稿时对比增删重排。
            const segmentBaseline = !context?.runtimeWrite && !String(context?.source?.clientId || "").startsWith("production:")
                ? { nodes: structuredClone((Array.isArray(project.nodes) ? project.nodes as Record<string, any>[] : []).filter(node => String((node as Record<string, any>).type || "").startsWith("minimax-h3:"))) } : undefined;
            if (!this.db.prepare("SELECT 1 FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(id)) {
                this.db.prepare("INSERT INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, ?, ?)").run(id, currentRevision, JSON.stringify(current));
            }
            const committedOperations: CanvasOperation[] = [];
            const lifecycleResults: CanvasOperationResult[] = [];
            const historicalNodes = Array.isArray(baseProject?.nodes) ? baseProject!.nodes as AssetNode[] : [];
            const operationResults = operations.flatMap((operation, index) => {
                if (!context?.runtimeWrite) operations[index] = operation = normalizeEntityNodeOperation(project, operation);
                if (operation.type === "update_node" && !(project.nodes as AssetNode[]).some(node => node.id === operation.id)) {
                    const historical = historicalNodes.find(node => node.id === operation.id);
                    if (!historical) throw Object.assign(collaborationError("BASE_HISTORY_UNAVAILABLE", `节点 ${operation.id} 已删除，且无法从请求基线恢复；本地草稿已保留`), { project: current, revision: currentRevision, conflictTargets: [String(operation.id)] });
                    // A stale edit after a delete is an explicit later write. Restore only
                    // the deleted object image; its former connections remain separately deleted.
                    const restore: CanvasOperation = { type: "add_node", id: historical.id, nodeType: historical.type, title: historical.title,
                        position: structuredClone(historical.position), width: historical.width, height: historical.height,
                        metadata: structuredClone(historical.metadata || {}) };
                    const restored = applyCanvasProjectOperations(project, [restore]);
                    committedOperations.push(restore);
                    lifecycleResults.push(...restored);
                }
                if (operation.type === "update_h3_segment") {
                    const nodeId = String(operation.nodeId || ""), segmentId = String(operation.segmentId || "");
                    let liveNode = (project.nodes as AssetNode[]).find(node => node.id === nodeId);
                    if (!liveNode) {
                        const historicalNode = historicalNodes.find(node => node.id === nodeId);
                        if (!historicalNode) throw Object.assign(collaborationError("BASE_HISTORY_UNAVAILABLE", `H3 节点 ${nodeId} 已删除，且无法从请求基线恢复；本地草稿已保留`), { project: current, revision: currentRevision, conflictTargets: [nodeId] });
                        const restore: CanvasOperation = { type: "add_node", id: historicalNode.id, nodeType: historicalNode.type, title: historicalNode.title,
                            position: structuredClone(historicalNode.position), width: historicalNode.width, height: historicalNode.height,
                            metadata: structuredClone(historicalNode.metadata || {}) };
                        lifecycleResults.push(...applyCanvasProjectOperations(project, [restore]));
                        committedOperations.push(restore);
                        liveNode = (project.nodes as AssetNode[]).find(node => node.id === nodeId);
                    }
                    const liveSegments = Array.isArray(liveNode?.metadata?.segments) ? liveNode!.metadata!.segments as Array<Record<string, unknown>> : [];
                    if (!liveSegments.some(segment => String(segment.id || "") === segmentId)) {
                        const oldNode = historicalNodes.find(node => node.id === nodeId);
                        const oldSegments = Array.isArray(oldNode?.metadata?.segments) ? oldNode!.metadata!.segments as Array<Record<string, unknown>> : [];
                        const historicalIndex = oldSegments.findIndex(segment => String(segment.id || "") === segmentId);
                        const historical = oldSegments[historicalIndex];
                        if (!historical) throw Object.assign(collaborationError("BASE_HISTORY_UNAVAILABLE", `Clip ${segmentId} 已删除，且无法从请求基线恢复；本地草稿已保留`), { project: current, revision: currentRevision, conflictTargets: [`${nodeId}:${segmentId}`] });
                        let insertAt = -1;
                        for (let index = historicalIndex - 1; index >= 0 && insertAt < 0; index--) {
                            const preceding = liveSegments.findIndex(segment => String(segment.id || "") === String(oldSegments[index].id || ""));
                            if (preceding >= 0) insertAt = preceding + 1;
                        }
                        if (insertAt < 0) for (let index = historicalIndex + 1; index < oldSegments.length; index++) {
                            const following = liveSegments.findIndex(segment => String(segment.id || "") === String(oldSegments[index].id || ""));
                            if (following >= 0) { insertAt = following; break; }
                        }
                        const restoredSegments = [...liveSegments];
                        restoredSegments.splice(insertAt < 0 ? restoredSegments.length : insertAt, 0, structuredClone(historical));
                        const restore: CanvasOperation = { type: "replace_h3_segments", nodeId, segments: restoredSegments };
                        lifecycleResults.push(...applyCanvasProjectOperations(project, [restore]));
                        committedOperations.push(restore);
                    }
                }
                if (operation.type === "delete_node" && context?.baseRevision !== undefined) {
                    if (baseHistoryUnavailable) throw Object.assign(collaborationError("BASE_HISTORY_UNAVAILABLE", "删除目标的生命周期历史已压缩；请保留草稿并读取当前目标后重试"), { project: current, revision: currentRevision });
                    const ids = Array.isArray(operation.ids) ? operation.ids.map(String) : [String(operation.id || "")];
                    const staleDelete = ids.some(nodeId => {
                        if (!historicalNodes.some(node => node.id === nodeId)) return false;
                        let deleted = false;
                        for (const commit of intervening) for (const prior of commit.operations) {
                            if (prior.type === "delete_node" && ((prior.ids as unknown[] | undefined) || [prior.id]).map(String).includes(nodeId)) deleted = true;
                            if (prior.type === "add_node" && String(prior.id || "") === nodeId && deleted) return true;
                        }
                        return false;
                    });
                    if (staleDelete) {
                        // This delete belongs to an older lifecycle generation. It must not
                        // remove an object recreated after the caller's base revision.
                        return [];
                    }
                }
                if (operation.type === "delete_h3_segment" && context?.baseRevision !== undefined) {
                    if (baseHistoryUnavailable) throw Object.assign(collaborationError("BASE_HISTORY_UNAVAILABLE", "Clip 生命周期历史已压缩；请保留草稿并读取当前目标后重试"), { project: current, revision: currentRevision });
                    const nodeId = String(operation.nodeId || ""), segmentId = String(operation.segmentId || "");
                    let deleted = false, recreated = false;
                    for (const entry of intervening) for (const prior of entry.operations) {
                        if (prior.type === "delete_h3_segment" && prior.nodeId === nodeId && prior.segmentId === segmentId) deleted = true;
                        if (prior.type === "add_h3_segment" && prior.nodeId === nodeId && String((prior.segment as Record<string, unknown> | undefined)?.id || "") === segmentId && deleted) recreated = true;
                        if (prior.type === "replace_h3_segments" && prior.nodeId === nodeId) {
                            const includes = Array.isArray(prior.segments) && prior.segments.some(item => String((item as Record<string, unknown>).id || "") === segmentId);
                            if (deleted && includes) recreated = true;
                        }
                    }
                    if (recreated) return [];
                }
                const previousNode = (project.nodes as AssetNode[]).find(node => node.id === String(operation.id || operation.nodeId || ""));
                const previousNodeSnapshot = previousNode ? structuredClone(previousNode) : undefined;
                validateAssetOperation(this, id, project, operation, context);
                normalizeAssetInsertion(this, operation);
                if (!context?.runtimeWrite) {
                    const node = (Array.isArray(project.nodes) ? project.nodes as Record<string, any>[] : []).find(item => item.id === (operation.id || operation.nodeId));
                    const metadata = operation.metadata as Record<string, unknown> | undefined;
                    const patched = (operation.patch as Record<string, any> | undefined)?.metadata;
                    const layoutKeys = ["productionLayoutUnitId", "productionLayoutBounds", "productionEntity"];
                    for (const change of [metadata, patched].filter(Boolean)) for (const key of layoutKeys) {
                        if (Object.hasOwn(change, key) && commandFingerprint(change[key]) !== commandFingerprint(node?.metadata?.[key] ?? null)) throw new Error("制作布局标识由 Backend 管理");
                    }
                    if ((operation.metadataDelete as string[] || []).some(key => layoutKeys.includes(key))) throw new Error("制作布局标识不能直接删除");
                    for (const change of [metadata, patched].filter(Boolean)) for (const field of ["productionImageInput", "productionImageProjection", "canvasReferenceNodeIds"]) if (Object.hasOwn(change, field) && commandFingerprint(change[field]) !== commandFingerprint(node?.metadata?.[field] || null)) throw new Error("正式图片输入清单与导演基线由 Backend 登记，不能直接修改");
                    if ((operation.metadataDelete as string[] || []).includes("productionImageInput")) throw new Error("正式图片输入清单不能直接删除");
                    if (metadata?.sharedAssetOrigin && commandFingerprint(metadata.sharedAssetOrigin) !== commandFingerprint(node?.metadata?.sharedAssetOrigin || null)) throw new Error("共享资产来源由 Backend 登记，不能直接修改");
                    if (node?.metadata?.sharedAssetOrigin && operation.type === "update_node") {
                        const protectedKeys = ["content", "storageKey", "sharedAssetOrigin", "characterImages", "characterPrimaryIndex", "sceneImages", "resultStorageKey", "imageResults"];
                        if (protectedKeys.some(key => metadata && Object.hasOwn(metadata, key) && commandFingerprint(metadata[key]) !== commandFingerprint(node.metadata[key] ?? null)) ||
                            (operation.metadataDelete as string[] || []).some(key => protectedKeys.includes(key)) || Object.keys(operation.patch as object || {}).some(key => ["content", "type", "metadata", "storageKey"].includes(key))) throw new Error("共享引用内容只在资产画布编辑，请查看源资产");
                    }
                }
                if (operation.type === "text_suggestion") throw new Error("text_suggestion 是服务端回执，不能直接提交");
                // 文本增量与候选通知必须由本次事务计算，不能信任客户端夹带的回执字段。
                delete operation.textUpdate;
                delete operation.textUpdates;
                delete operation.textSuggestion;
                const isSuggestion = operation.type === "save_text_suggestion" || operation.type === "resolve_text_suggestion";
                const isText = isSuggestion || operation.type === "text_update" || operation.type === "text_replace";
                if (!context?.runtimeWrite && operation.type === "delete_node") {
                    const nodeIds = Array.isArray(operation.ids) ? operation.ids.map(String) : [String(operation.id || "")];
                    for (const nodeId of nodeIds) this.assertEmptySceneH3NodeCanBeDeleted(id, project, nodeId);
                }
                if (operation.type === "restore_h3_output") operations[index] = this.restoreH3OutputOperation(id, project, operation);
                if (isSuggestion) operations[index] = this.applyTextSuggestion(id, project, operation);
                else if (isText) operations[index] = this.applyCanvasTextOperation(id, project, operation);
                if (!context?.runtimeWrite && operation.type !== "restore_h3_output") prepareClientCanvasOperation(project, operations[index]);
                const derivedOperations: CanvasOperation[] = [];
                const result = applyCanvasProjectOperations(project, [operations[index]], { derivedOperations });
                committedOperations.push(operations[index], ...derivedOperations);
                committedOperations.push(...captureAssetEdits(this, project, operations[index], { ...context, operationId, deferredCommits: dependentCommits }, previousNodeSnapshot));
                if (!isText) {
                    // 每一步删除后立即清理；同批 delete + add 同 ID 也必须得到新文本身份。
                    if (["delete_node", "delete_h3_segment", "replace_h3_segments"].includes(operation.type) || (operation.type === "update_node" && (["segments", "texts"].some((key) => Object.hasOwn(operation.metadata as object || {}, key) || (operation.metadataDelete as string[] || []).includes(key)) || Object.hasOwn(operation.patch as object || {}, "type")))) {
                        const documents = this.db.prepare("SELECT target_key FROM canvas_text_documents WHERE project_id = ?").all(id) as Array<{ target_key: string }>;
                        for (const { target_key } of documents) {
                            const [nodeId, segmentId, field, textItemId] = JSON.parse(target_key);
                            try { readText(project, { nodeId: nodeId || undefined, segmentId: segmentId || undefined, field, textItemId }); }
                            catch { this.db.prepare("DELETE FROM canvas_text_documents WHERE project_id = ? AND target_key = ?").run(id, target_key); }
                        }
                    }
                    const textUpdates = editedTextTargets(operations[index], project).flatMap((target) => {
                        const row = this.db.prepare("SELECT state FROM canvas_text_documents WHERE project_id = ? AND target_key = ?").get(id, textKey(target)) as { state: Uint8Array } | undefined;
                        if (!row) return [];
                        const doc = loadTextDocument(row.state, "");
                        try {
                            const before = Y.encodeStateVector(doc);
                            replaceText(doc, readText(project, target));
                            const documentId = this.saveCanvasText(id, target, Y.encodeStateAsUpdate(doc));
                            return [{ target, documentId, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") }];
                        } finally { doc.destroy(); }
                    });
                    if (textUpdates.length) operations[index].textUpdates = textUpdates;
                }
                return result;
            });
            operationResults.unshift(...lifecycleResults);
            if (editorialBefore) {
                const defaults = this.canvasEditorDefaults(id);
                const oldNodes = editorialBefore.nodes as any[];
                const stale: CanvasOperation[] = [];
                for (const node of project.nodes as any[]) {
                    const old = oldNodes.find(old => old.id === node.id);
                    if (!old) continue;
                    for (const segment of node.metadata?.segments || []) {
                        const previous = old.metadata?.segments?.find((previous: any) => previous.id === segment.id);
                        if (!previous?.resultStorageKey) continue;
                        try { if (inputHash(effectiveTargetInput(editorialBefore, node.id, segment.id, defaults)) !== inputHash(effectiveTargetInput(project as CanvasProject, node.id, segment.id, defaults))) stale.push({ type: "update_h3_segment", nodeId: node.id, segmentId: segment.id, patch: { inputOutdated: true } }); }
                        catch { stale.push({ type: "update_h3_segment", nodeId: node.id, segmentId: segment.id, patch: { inputOutdated: true } }); }
                    }
                    if (old.metadata?.productionImageInput && old.metadata?.storageKey) {
                        try { if (inputHash(effectiveTargetInput(editorialBefore, node.id, undefined, defaults)) !== inputHash(effectiveTargetInput(project as CanvasProject, node.id, undefined, defaults))) stale.push({ type: "update_node", id: node.id, metadata: { inputOutdated: true } }); }
                        catch { stale.push({ type: "update_node", id: node.id, metadata: { inputOutdated: true } }); }
                    }
                }
                for (const operation of stale) { const result = applyCanvasProjectOperations(project, [operation]); committedOperations.push(operation); operationResults.push(...result); }
            }
            const entitySync = entityBaseline ? syncEntityNodeEdits(this, id, entityBaseline, project, { syncImageProjections: context?.source?.clientId !== "system:shared-library" }) : { updates: [], operations: [] };
            for (const operation of entitySync.operations) {
                const result = applyCanvasProjectOperations(project, [operation]);
                committedOperations.push(operation);
                operationResults.push(...result);
            }
            const productionUpdates = [...(scriptBaseline ? syncScriptNodeEdits(this, id, scriptBaseline, project) : []), ...entitySync.updates,
                ...syncH3ModeEdits(this, id, current, project, context), ...(segmentBaseline ? syncH3SegmentStructureEdits(this, id, segmentBaseline, project, context) : [])];
            if (imageInputBaseline) {
                const synced = syncImageReferenceEdits(this, id, imageInputBaseline, project);
                productionUpdates.push(...synced.updates);
                for (const operation of synced.operations) {
                    const result = applyCanvasProjectOperations(project, [operation]);
                    committedOperations.push(operation); operationResults.push(...result);
                }
            }
            for (const operation of syncH3SceneImageReferences(assetBefore, project)) {
                const result = applyCanvasProjectOperations(project, [operation]);
                committedOperations.push(operation);
                operationResults.push(...result);
            }
            const revision = currentRevision + 1;
            project.revision = revision;
            project.updatedAt = new Date().toISOString();
            if (!previousRows) throw new Error(`画布不存在: ${id}`);
            writeStoredProjectDelta(this.db, previousRows, stripProjectAssets(project));
            // 嵌套调用（已有外层活动事务）时，派生同步需随外层一起提交，保留原路径；
            // 非嵌套（普通提交）时改在 COMMIT 后的独立短事务执行，见下方派生同步块。
            if (context?.withinTransaction) {
                syncSharedCanvasAssetRecords(this, id, project as CanvasProject);
                productionUpdates.push(...propagateAssetChanges(this, id, assetBefore, project, dependentCommits, context?.originatingProjectId));
            }
            const source = context?.source || { clientId: "system:backend", kind: "system", label: "后台" };
            // expectedFields 是提交时的一次性 CAS 校验条件，被 Backend 自身规范化/共享同步补字段后
            // 常变成永久冲突基线；重放时 CAS 已不执行（committedReplay），存进历史只会拖慢整图历史重建
            // 并留下脏状态。落库前从 committedOperations 剥离，前端对账也不依赖它。
            const storedOperations = committedOperations.map((operation) => {
                if (operation && typeof operation === "object" && "expectedFields" in operation) {
                    const { expectedFields, ...rest } = operation as Record<string, unknown>;
                    return rest;
                }
                return operation;
            });
            // 批次历史先以明文落库（跳过 gzip，缩短写锁持有时长）；压缩在 COMMIT 后的派生事务里做。
            this.db.prepare("INSERT INTO canvas_operation_batches (operation_id, project_id, base_revision, revision, source_json, operations_json, results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .run(operationId, id, currentRevision, revision, JSON.stringify(source), JSON.stringify(storedOperations), JSON.stringify(operationResults), String(project.updatedAt));
            this.db.prepare("INSERT INTO canvas_command_receipts (operation_id, project_id, request_hash, committed_revision) VALUES (?, ?, ?, ?)").run(operationId, id, fingerprint, revision);
            if (context?.mcpCommand) {
                const requestHash = commandFingerprint({ tool: context.mcpCommand.tool, targetId: context.mcpCommand.targetId, request: context.mcpCommand.request });
                const command = this.db.prepare("SELECT tool, target_id, project_id FROM mcp_command_receipts WHERE operation_id = ? AND request_hash = ? AND status = 'prepared'").get(operationId, requestHash) as { tool: string; target_id: string; project_id: string | null } | undefined;
                if (!command || command.tool !== context.mcpCommand.tool || command.target_id !== context.mcpCommand.targetId || command.project_id !== id) throw collaborationError("MCP_COMMAND_MISMATCH", "MCP 冻结命令与画布提交不匹配");
                this.completeMcpCommand(operationId, revision, committedOperations);
            }
            this.db.exec(commitSql);
            // 主画布写已提交。资产目录登记与共享资产消费者投影是最终一致的派生索引，
            // 放到 COMMIT 后的独立短事务里执行，不再占用主画布的写锁（SQLite 单写者串行），
            // 从而缩短同一项目内不同节点并发提交的相互等待。失败仅影响派生索引，下次改动会重触发。
            // JSON 压缩也在写锁外完成（decodeStoredJson 兼容明文、gzip 与 Brotli）。
            if (!context?.withinTransaction) {
                try {
                    const encodedOperations = encodeStoredJson(storedOperations);
                    const encodedResults = encodeStoredJson(operationResults);
                    this.db.exec("BEGIN IMMEDIATE");
                    syncSharedCanvasAssetRecords(this, id, project as CanvasProject);
                    productionUpdates.push(...propagateAssetChanges(this, id, assetBefore, project, dependentCommits, context?.originatingProjectId));
                    this.db.prepare("UPDATE canvas_operation_batches SET operations_json = ?, results_json = ? WHERE operation_id = ?")
                        .run(encodedOperations, encodedResults, operationId);
                    this.db.exec("COMMIT");
                } catch (error) {
                    if (this.db.isTransaction) this.db.exec("ROLLBACK");
                    console.error("画布主写已提交，但派生同步/历史压缩失败", error);
                }
            }
            commit = { projectId: id, operationId, baseRevision: currentRevision, revision, operations: committedOperations, operationResults, source, updatedAt: String(project.updatedAt), ...(productionUpdates.length ? { productionUpdates } : {}), deletedAssetIds: sourceAssetsBefore.filter(asset => !this.getAssetRecord(asset.id)).map(asset => asset.id) };
        } catch (error) {
            this.db.exec(rollbackSql);
            throw error;
        }
        // 已提交的数据不能因为通知失败而被报告成事务失败，更不能尝试 ROLLBACK。
        if (context?.withinTransaction) context.deferredCommits?.push(commit, ...dependentCommits); else { this.notifyCanvasCommit(commit); for (const dependent of dependentCommits) this.notifyCanvasCommit(dependent); }
        return { project: this.getCanvasProject(id)!, revision: commit.revision, operationId, operationResults: commit.operationResults, operations: commit.operations, duplicated: false };
    }

    notifyCanvasCommit(commit: CanvasCommit) {
        try { this.canvasCommitListener?.(commit); } catch (error) { console.error("画布提交成功，但实时通知失败", error); }
    }

    canvasEditorDefaults(projectId: string): Record<string, unknown> {
        const defaults = recordOf(this.getSetting("plugin:minimax-h3:defaults:v1"));
        const episode = this.getDramaEpisodeByCanvasId(projectId);
        const row = episode
            ? this.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get(episode.id)
            : this.db.prepare("SELECT draft_json FROM canvas_productions WHERE project_id=?").get(projectId);
        if (!row?.draft_json) return defaults;
        const data = JSON.parse(String(row.draft_json));
        const settings = data.settings || {};
        return { ...defaults, canvasImageModels: Object.fromEntries(Object.entries(data.director?.assets || {}).flatMap(([id, value]) => {
            const asset = value as any;
            return asset.nodeId ? [[asset.nodeId, productionImageModel(settings, data.director?.source || {}, id)]] : [];
        })) };
    }

    writeBackH3Task(
        task: RuntimeTask,
        binding: { projectId: string; nodeId: string; segmentId: string; generationLogId?: string },
        output: Record<string, unknown> | null,
        completion?: { cacheFingerprint?: string; firstPassReady?: boolean },
    ): { project: CanvasProject; log: GenerationLog | null; operations: CanvasOperation[] } | null {
        // 日志描述的是任务本身的终态，不受画布 Clip 是否已被另一任务接管影响。
        // 先收口日志，再用 runtimeTaskId CAS 尝试更新画布投影；否则 CAS 失败会留下永久 running 日志。
        const currentLog = binding.generationLogId ? this.getGenerationLog(binding.generationLogId) : null;
        const actualSubmission = task.result?.actualSubmission && typeof task.result.actualSubmission === "object" ? task.result.actualSubmission as Record<string, unknown> : null;
        // 生成日志可能已按保留策略清理；任务与画布绑定仍可独立完成回写。
        const log = binding.generationLogId && currentLog
            ? this.updateGenerationLog(binding.generationLogId, {
                status: task.status === "succeeded" ? "success" : task.status === "cancelled" ? "cancelled" : "failed",
                finishedAt: new Date().toISOString(),
                durationMs: Math.max(0, Date.now() - new Date(String(currentLog?.startedAt || Date.now())).getTime()),
                outputs: output ? [output] : [],
                ...(actualSubmission ? { params: { ...(currentLog?.params || {}), actualSubmission }, promptId: String(actualSubmission.promptId || "") || undefined } : {}),
                ...(task.error ? { error: task.error } : {}),
            })
            : null;
        // 不在外部再开 BEGIN IMMEDIATE：applyCanvasProjectOperations 内部自管事务，SQLite 不支持嵌套。
        // 先做「被另一条更新的任务接管」检查（runtimeTaskId CAS），命中则放弃回写。
        const project = this.getCanvasProject(binding.projectId);
        if (!project) return null;
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
        const node = nodes.find((item) => String(item.id || "") === binding.nodeId);
        if (!node) return null;
        const metadata = recordOf(node.metadata);
        const segments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
        const index = segments.findIndex((segment) => String(segment.id || "") === binding.segmentId);
        const currentTaskId = index >= 0 ? String(segments[index].runtimeTaskId || "") : "";
        if (index < 0 || (currentTaskId && currentTaskId !== task.id)) return null;
        const frozenHash = recordOf(recordOf(task.input).params).canvasControlHash || recordOf(recordOf(task.input).params).canvasInputHash;
        const defaults = this.canvasEditorDefaults(binding.projectId);
        let inputOutdated = false;
        if (frozenHash) {
            try { inputOutdated = frozenHash !== inputHash(effectiveTargetInput(project, binding.nodeId, binding.segmentId, defaults)); }
            catch { inputOutdated = true; }
        }
        const terminalStatus = task.status === "succeeded" ? "success" : task.status === "cancelled" ? "cancelled" : "error";
        const active = segments.find((segment) => ["queued", "loading", "awaiting_confirmation"].includes(String(segment.status || "")) && String(segment.id || "") !== binding.segmentId);
        const segmentPatch: Record<string, unknown> = {
            ...(completion?.cacheFingerprint !== undefined ? { cacheFingerprint: completion.cacheFingerprint } : {}),
            ...(completion?.firstPassReady !== undefined ? { firstPassReady: completion.firstPassReady } : {}),
            inputOutdated,
            status: terminalStatus,
            progress: task.progress,
            runtimeTaskId: "",
            parentTaskId: "",
            ...(task.error ? { errorDetails: task.error } : {}),
        };
        if (output) {
            if (!inputOutdated && (task.result?.specification as Record<string, unknown> | undefined)?.status !== 'mismatch') {
                segmentPatch.result = output.url;
                segmentPatch.resultStorageKey = output.storageKey;
            }
            const previousResults = Array.isArray(segments[index].results) ? segments[index].results as Array<Record<string, unknown>> : [];
            segmentPatch.results = [
                ...previousResults.filter((item) => String(item.url || "") !== String(output.url || "")),
                { ...output, name: `Clip ${index + 1}`, taskId: task.id, ...(binding.generationLogId ? { generationLogId: binding.generationLogId } : {}), inputHash: frozenHash },
            ];
        }
        const operations: CanvasOperation[] = [{
            type: "update_h3_segment",
            nodeId: binding.nodeId,
            segmentId: binding.segmentId,
            patch: segmentPatch,
            // CAS：只有当 segment 的 runtimeTaskId 仍指向本任务时才回写，防止新任务接管本段后被旧结果覆盖。
            expectedFields: { runtimeTaskId: task.id },
        }];
        // 节点级元数据（status / runProgress / content / storageKey）走 update_node，不动 segments 字段。
        // 注意：不再写 metadata.materials（迁移 v4 起停摆）。materials 历史由 generation_logs.outputs_json 承担，
        // 前端通过 MCP tool h3_get_node_materials / REST /canvas/nodes/:id/materials 按需取，metadata 体积随之下降。
        const nodeMetadataPatch: Record<string, unknown> = {
            status: active ? String(active.status || "loading") : terminalStatus,
            runProgress: Math.max(Number(active?.progress || 0), task.progress),
            runtimeTaskId: String(active?.parentTaskId || (active?.status === "awaiting_confirmation" ? active?.runtimeTaskId : "") || ""),
        };
        if (output && !inputOutdated) {
            nodeMetadataPatch.content = output.url;
            nodeMetadataPatch.storageKey = output.storageKey;
        }
        operations.push({ type: "update_node", id: binding.nodeId, metadata: nodeMetadataPatch });
        try {
            this.applyCanvasProjectOperations(binding.projectId, Number(project.revision || 0), operations, { runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "H3 任务" } });
        } catch (error) {
            // 409（revision 过期）或 update_h3_segment CAS 失败（runtimeTaskId 已被清空 / 改了）都视为放弃回写。
            const message = error instanceof Error ? error.message : String(error);
            if (/CAS 失败|expectedRevision|revision/i.test(message)) return null;
            throw error;
        }
        return { project: this.getCanvasProject(binding.projectId)!, log, operations };
    }

    writeBackCanvasImageTask(
        task: RuntimeTask,
        input: { projectId: string; nodeId: string; prompt: string; model: string; references?: Array<Record<string, unknown>>; resultPolicy?: "replace-active" | "append"; imageIds?: string[] },
        media: Array<Record<string, unknown>>,
    ): { project: CanvasProject; operations: CanvasOperation[] } | null {
            const project = this.getCanvasProject(input.projectId);
            if (!project) return null;
            const nodes = Array.isArray(project.nodes) ? structuredClone(project.nodes) as Array<Record<string, any>> : [];
            const connections = Array.isArray(project.connections) ? structuredClone(project.connections) as Array<Record<string, any>> : [];
            const source = nodes.find((item) => String(item.id || "") === input.nodeId);
            if (!source || String(recordOf(source.metadata).runtimeTaskId || "") !== task.id) return null;
            const sourceMetadata = recordOf(source.metadata);
            const frozenHash = recordOf(recordOf(task.input).params).canvasControlHash || recordOf(recordOf(task.input).params).canvasInputHash;
            let changed = false;
            if (frozenHash) {
                try { changed = frozenHash !== inputHash(effectiveTargetInput(project, input.nodeId, undefined, this.canvasEditorDefaults(input.projectId))); } catch { changed = true; }
            }
            if (changed) {
                const history = Array.isArray(sourceMetadata.generatedImageHistory) ? sourceMetadata.generatedImageHistory as unknown[] : [];
                const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata: {
                    inputOutdated: true, generatedImageHistory: [...history, ...media.map(output => ({ ...output, taskId: task.id, inputHash: frozenHash }))],
                    status: "success", runProgress: 1,
                } }];
                const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations, { runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "保留旧输入生成历史" } });
                return { project: result.project, operations: result.operations };
            }
            if (recordOf(recordOf(task.input).params).writeBackToTarget === true) {
                const output = media[0];
                if (!output) throw new Error("生成完成但没有返回图片");
                const taskParams = recordOf(recordOf(task.input).params);
                const productionInput = recordOf(sourceMetadata.productionImageInput);
                const projection = recordOf(sourceMetadata.productionImageProjection);
                const projectedPrompt = String(recordOf(projection.nextValues).prompt || "");
                const restoreFrozenProductionPrompt = taskParams.canvasFrozenInput === true
                    && !String(sourceMetadata.prompt || "").trim()
                    && Boolean(input.prompt)
                    && projectedPrompt === input.prompt
                    && productionInput.promptHash === crypto.createHash("sha256").update(input.prompt).digest("hex")
                    && productionInput.stale !== true
                    && !(Array.isArray(projection.conflicts) && projection.conflicts.includes("prompt"));
                const metadata = {
                    content: output.url, url: output.url, storageKey: output.storageKey || "", mimeType: output.mimeType || "image/png",
                    bytes: output.bytes, naturalWidth: output.width, naturalHeight: output.height,
                    // 提示词与 composerContent 成对写入：画布输入框和用户回看都以 composerContent 为准，
                    // 只写 prompt 会让生成节点打开后显示为空（共享资产画布的生图节点曾踩此坑）。
                    ...(!taskParams.canvasFrozenInput || restoreFrozenProductionPrompt
                        ? { prompt: input.prompt, composerContent: input.prompt, model: input.model }
                        : {}),
                    generationType: input.references?.length ? "edit" : "generation",
                    status: "success", runProgress: 1, generationTaskId: task.id, inputOutdated: false, generatedImageHistory: [...(Array.isArray(sourceMetadata.generatedImageHistory) ? sourceMetadata.generatedImageHistory : []), ...media.map(output => ({ ...output, taskId: task.id, inputHash: frozenHash }))],
                };
                const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata,
                    metadataDelete: ["runtimeTaskId", "errorDetails"] }, ...linkedCharacterImageUpdates(project, input.nodeId, media)];
                const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations,
                    { runtimeWrite: true, operationId: `image-task-result:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
                return { project: result.project, operations: result.operations };
            }
            if (input.imageIds) {
                if (!media.length) throw new Error("生成完成但没有返回图片");
                const slots = completedImageSlots(sourceMetadata, input.imageIds, media, task.id, this.getTaskSequence(task.id));
                const initialSize = recordOf(task.params.imageTargetSize);
                const keepSmartLayout = source.type === "config" && sourceMetadata.smart === true;
                const resultSize = slots.content && !keepSmartLayout && !sourceMetadata.freeResize && !sourceMetadata.userSized && source.width === initialSize.width && source.height === initialSize.height
                    ? fitImageNodeSize(Number(slots.naturalWidth || 0), Number(slots.naturalHeight || 0)) : {};
                const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId,
                    patch: resultSize,
                    metadata: { ...slots, status: "success", runProgress: 1, generationTaskId: task.id },
                    metadataDelete: ["runtimeTaskId", "errorDetails"] },
                    ...linkedCharacterImageUpdates(project, input.nodeId, media),
                    ...imageSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, "success")];
                const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations,
                    { runtimeWrite: true, operationId: `image-task-result:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
                return { project: result.project, operations: result.operations };
            }
            const operations: CanvasOperation[] = [];
            const activeIds = new Set(Array.isArray(sourceMetadata.generatedResultIds)
                ? sourceMetadata.generatedResultIds.map(String)
                : [String(sourceMetadata.primaryImageId || "")].filter(Boolean));
            if ((input.resultPolicy || "replace-active") === "replace-active" && activeIds.size) {
                for (let index = nodes.length - 1; index >= 0; index--) if (activeIds.has(String(nodes[index].id || ""))) {
                    operations.push({ type: "delete_node", id: String(nodes[index].id) });
                    nodes.splice(index, 1);
                }
                for (let index = connections.length - 1; index >= 0; index--) {
                    if (activeIds.has(String(connections[index].fromNodeId || "")) || activeIds.has(String(connections[index].toNodeId || ""))) {
                        operations.push({ type: "delete_connections", id: String(connections[index].id) });
                        connections.splice(index, 1);
                    }
                }
            }
            const sourcePosition = recordOf(source.position);
            const sourceWidth = Number(source.width || 320);
            const createdIds: string[] = [];
            // 结果节点尺寸收口到图片节点默认尺寸（340×240 包围盒）并保持原始宽高比，
            // 与前端画布生成同一口径；不再直接用图片原始像素（gpt-image 输出 1024/1536 会让节点异常巨大）。
            const outputSizes = media.map((output) => fitImageNodeSize(Number(output.width || 0), Number(output.height || 0)));
            let resultX = Number(sourcePosition.x || 0) + sourceWidth + 96;
            media.forEach((output, index) => {
                const id = `image-${crypto.randomUUID()}`;
                createdIds.push(id);
                const { width, height } = outputSizes[index];
                const resultNode = {
                    id,
                    type: "image",
                    title: `${String(source.title || "图片生成")}｜结果${media.length > 1 ? ` ${index + 1}` : ""}`,
                    position: { x: resultX, y: Number(sourcePosition.y || 0) },
                    width,
                    height,
                    metadata: {
                        content: output.url,
                        url: output.url,
                        storageKey: output.storageKey || "",
                        mimeType: output.mimeType || "image/png",
                        bytes: output.bytes,
                        naturalWidth: output.width,
                        naturalHeight: output.height,
                        prompt: input.prompt,
                        model: input.model,
                        generationType: input.references?.length ? "edit" : "generation",
                        source: "Backend canvas image dispatcher",
                        status: "success",
                    },
                };
                const connection = { id: `connection-${crypto.randomUUID()}`, fromNodeId: input.nodeId, toNodeId: id };
                nodes.push(resultNode);
                connections.push(connection);
                operations.push({ ...resultNode, nodeType: "image", type: "add_node" });
                operations.push({ type: "connect_nodes", ...connection });
                // 多张结果按实际节点宽度依次排开（原先按固定 720 步长，是 680 宽节点的假设）
                resultX += width + 40;
            });
            if (!createdIds.length) throw new Error("生成完成但没有返回图片");
            const sourceMetadataPatch = { status: "success", primaryImageId: createdIds[0], generatedResultIds: createdIds, generationTaskId: task.id };
            source.metadata = { ...sourceMetadata, ...sourceMetadataPatch };
            operations.push({ type: "update_node", id: input.nodeId, metadata: sourceMetadataPatch, metadataDelete: ["runtimeTaskId", "errorDetails"] });
            operations.push(...imageSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, "success"));
            const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations, { runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
            return { project: result.project, operations: result.operations };
    }

    markCanvasImageTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null {
            const project = this.getCanvasProject(input.projectId);
            if (!project) return null;
            const nodes = Array.isArray(project.nodes) ? structuredClone(project.nodes) as Array<Record<string, any>> : [];
            const source = nodes.find((item) => String(item.id || "") === input.nodeId);
            if (!source || String(recordOf(source.metadata).runtimeTaskId || "") !== task.id) return null;
            const status = task.status === "cancelled" ? "cancelled" : "error";
            const errorDetails = task.status === "cancelled" ? undefined : error;
            const failedIds = Array.isArray(task.input.imageIds) ? task.input.imageIds.map(String).filter(Boolean) : [];
            const dropPatch = dropImageSlots(project, input.nodeId, failedIds);
            const metadataPatch = { status, runtimeTaskId: undefined, errorDetails, ...dropPatch };
            source.metadata = { ...recordOf(source.metadata), ...metadataPatch };
            const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata: metadataPatch, metadataDelete: task.status === "cancelled" ? ["runtimeTaskId", "errorDetails"] : ["runtimeTaskId"] }];
            operations.push(...imageSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, status));
            const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations, { runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
            return { project: result.project, operations: result.operations };
    }

    writeBackCanvasVideoTask(task: RuntimeTask, input: { projectId: string; nodeId: string; prompt: string; model: string }, media: Record<string, unknown>): { project: CanvasProject; operations: CanvasOperation[] } | null {
            const project = this.getCanvasProject(input.projectId);
            if (!project) return null;
            const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
            const node = nodes.find((item) => String(item.id || "") === input.nodeId);
            if (!node || String(recordOf(node.metadata).runtimeTaskId || "") !== task.id) return null;
            const metadata = recordOf(node.metadata);
            const initialSize = recordOf(task.params.videoTargetSize);
            const naturalWidth = Number(media.width || 0);
            const naturalHeight = Number(media.height || 0);
            const keepSmartLayout = node.type === "config" && metadata.smart === true;
            const size = !keepSmartLayout && !metadata.freeResize && !metadata.userSized && node.width === initialSize.width && node.height === initialSize.height && naturalWidth > 0 && naturalHeight > 0
                ? fitImageNodeSize(naturalWidth, naturalHeight) : {};
            const patch = {
                status: "success", runProgress: 1, generationTaskId: task.id,
                content: media.url, storageKey: media.storageKey || "", mimeType: media.mimeType || "video/mp4",
                bytes: media.bytes, naturalWidth: media.width, naturalHeight: media.height, durationMs: media.durationMs,
                prompt: input.prompt, model: input.model,
            };
            const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, patch: size, metadata: patch, metadataDelete: ["runtimeTaskId", "errorDetails"] }];
            operations.push(...canvasMediaSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, "success"));
            const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations,
                { runtimeWrite: true, operationId: `video-task-result:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "视频生成任务" } });
            return { project: result.project, operations: result.operations };
    }

    markCanvasVideoTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null {
            const project = this.getCanvasProject(input.projectId);
            if (!project) return null;
            const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === input.nodeId) as Record<string, any> | undefined;
            if (!node || String(recordOf(node.metadata).runtimeTaskId || "") !== task.id) return null;
            const status = task.status === "cancelled" ? "cancelled" : "error";
            const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata: { status, errorDetails: status === "error" ? error : undefined },
                metadataDelete: status === "cancelled" ? ["runtimeTaskId", "errorDetails"] : ["runtimeTaskId"] }];
            operations.push(...canvasMediaSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, status));
            const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations,
                { runtimeWrite: true, operationId: `video-task-failed:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "视频生成任务" } });
            return { project: result.project, operations: result.operations };
    }

    writeBackCanvasAudioTask(task: RuntimeTask, input: { projectId: string; nodeId: string; prompt: string; model: string }, media: Record<string, unknown>): { project: CanvasProject; operations: CanvasOperation[] } | null {
        const project = this.getCanvasProject(input.projectId);
        if (!project) return null;
        const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === input.nodeId) as Record<string, any> | undefined;
        if (!node || String(recordOf(node.metadata).runtimeTaskId || "") !== task.id || this.getTask(task.id)?.status === "cancelled") return null;
        const metadata = { status: "success", runProgress: 1, generationTaskId: task.id, content: media.url, storageKey: media.storageKey || "", mimeType: media.mimeType || "audio/mpeg", bytes: media.bytes, durationMs: media.durationMs, prompt: input.prompt, model: input.model };
        const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata, metadataDelete: ["runtimeTaskId", "errorDetails"] }];
        operations.push(...canvasMediaSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, "success"));
        const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations, { runtimeWrite: true, operationId: `audio-task-result:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "音频生成任务" } });
        return { project: result.project, operations: result.operations };
    }

    markCanvasAudioTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null {
        const project = this.getCanvasProject(input.projectId);
        if (!project) return null;
        const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === input.nodeId) as Record<string, any> | undefined;
        if (!node || String(recordOf(node.metadata).runtimeTaskId || "") !== task.id) return null;
        const status = task.status === "cancelled" ? "cancelled" : "error";
        const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata: { status, errorDetails: status === "error" ? error : undefined }, metadataDelete: status === "cancelled" ? ["runtimeTaskId", "errorDetails"] : ["runtimeTaskId"] }];
        operations.push(...canvasMediaSourceStatus(project, input.nodeId, task.input.sourceNodeId as string | undefined, task.id, status));
        const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations, { runtimeWrite: true, operationId: `audio-task-failed:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "音频生成任务" } });
        return { project: result.project, operations: result.operations };
    }

    /**
     * 画布 → 剧目：分集画布（drama_episodes.canvas_id）或剧目的共享资产画布。
     * 画风这类剧目级设置只认这一条链，别去猜 canvas_projects 上的字段（它没有 folder_id）。
     */
    getDramaIdByCanvasId(canvasId: string): string {
        const id = String(canvasId || "");
        if (!id) return "";
        const episode = this.getDramaEpisodeByCanvasId(id);
        if (episode?.dramaId) return String(episode.dramaId);
        const shared = this.db.prepare("SELECT folder_id FROM drama_projects WHERE shared_asset_canvas_id=?").get(id) as { folder_id?: string } | undefined;
        return shared?.folder_id ? String(shared.folder_id) : "";
    }

    deleteCanvasProject(id: string): number {
        if (this.getDramaEpisodeByCanvasId(id) || this.db.prepare("SELECT 1 FROM drama_projects WHERE shared_asset_canvas_id=?").get(id)) {
            throw new Error("画布仍绑定制作对象，不能从画布库删除");
        }
        return Number(this.db.prepare("DELETE FROM canvas_projects WHERE id = ?").run(id).changes);
    }

    listCanvasFolders(id?: string): CanvasFolder[] {
        const rows = this.db.prepare(
            "SELECT f.*, d.outline, d.description, d.cover_storage_key, d.tags_json, d.shared_asset_canvas_id, d.production_plan_json, d.updated_at AS drama_updated_at, CASE WHEN d.folder_id IS NULL THEN 0 ELSE 1 END AS is_drama FROM canvas_folders f LEFT JOIN drama_projects d ON d.folder_id = f.id" + (id ? " WHERE f.id = ?" : "") + " ORDER BY f.created_at ASC"
        ).all(...(id ? [id] : [])) as Array<Record<string, unknown>>;
        return rows.map((row) => {
            const value = JSON.parse(String(row.tags_json || "[]"));
            const tags = Array.isArray(value) ? value.map(String) : [];
            return {
                id: String(row.id), name: String(row.name), createdAt: String(row.created_at),
                updatedAt: String(row.drama_updated_at || row.created_at),
                outline: String(row.outline || ""), description: String(row.description || ""),
                coverStorageKey: row.cover_storage_key ? String(row.cover_storage_key) : null, tags,
                isDrama: Number(row.is_drama) === 1,
                sharedAssetCanvasId: row.shared_asset_canvas_id ? String(row.shared_asset_canvas_id) : null,
                ...(row.production_plan_json ? { productionPlan: dramaProductionPlanSchema.parse(JSON.parse(String(row.production_plan_json))) } : {}),
            };
        });
    }

    upsertCanvasFolder(folder: CanvasFolder) {
        const plan = folder.productionPlan === undefined ? undefined : dramaProductionPlanSchema.parse(folder.productionPlan);
        if (folder.sharedAssetCanvasId !== undefined) {
            const current = this.db.prepare("SELECT shared_asset_canvas_id FROM drama_projects WHERE folder_id=?").get(folder.id);
            if ((current?.shared_asset_canvas_id || null) !== folder.sharedAssetCanvasId) throw new Error("共享资产画布绑定由正式准备接口维护，不能改绑");
        }
        const updatedAt = String(folder.updatedAt || new Date().toISOString());
        const tags = Array.isArray(folder.tags) ? folder.tags.map(String) : [];
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (plan !== undefined && folder.expectedPlanningUpdatedAt !== undefined) {
                const prior = this.db.prepare("SELECT updated_at FROM drama_projects WHERE folder_id=?").get(folder.id);
                if (String(prior?.updated_at || "") !== folder.expectedPlanningUpdatedAt) throw new Error("剧目规划已被其他窗口修改，请保留草稿并重新读取后再保存");
            }
            if (plan !== undefined && folder.expectedPlanningUpdatedAt === undefined) {
                const prior = this.db.prepare("SELECT production_plan_json FROM drama_projects WHERE folder_id=?").get(folder.id);
                if (prior && String(prior.production_plan_json || "") !== JSON.stringify(plan)) throw new Error("修改剧目规划需要读取当前版本并显式确认");
            }
            this.db.prepare(
                "INSERT INTO canvas_folders (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name"
            ).run(folder.id, folder.name, folder.createdAt);
            // 旧客户端没有 isDrama 字段，按原行为创建剧目；新画布普通文件夹显式传 false。
            if (folder.isDrama !== false) {
                this.db.prepare(
                    "INSERT INTO drama_projects (folder_id, outline, description, cover_storage_key, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(folder_id) DO UPDATE SET outline = excluded.outline, description = excluded.description, cover_storage_key = excluded.cover_storage_key, tags_json = excluded.tags_json, updated_at = excluded.updated_at"
                ).run(folder.id, String(folder.outline || ""), String(folder.description || ""), folder.coverStorageKey || null, JSON.stringify(tags), updatedAt);
            }
            if (plan !== undefined && folder.isDrama !== false) this.db.prepare("UPDATE drama_projects SET production_plan_json=? WHERE folder_id=?").run(JSON.stringify(plan), folder.id);
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        const { expectedPlanningUpdatedAt: _expected, ...savedFolder } = folder;
        return { ...savedFolder, updatedAt, outline: String(folder.outline || ""), description: String(folder.description || ""), coverStorageKey: folder.coverStorageKey || null, tags, isDrama: this.isDramaProject(folder.id) };
    }

    // ── 强一致分集：稳定章节 ID + plan_cursor 游标 + 单事务批量建集 ─────────────

    /** 读剧目级规划游标；不存在返回 null。 */
    getEpisodePlanningState(dramaId: string): EpisodePlanningState | null {
        const row = this.db.prepare("SELECT * FROM drama_episode_planning_state WHERE drama_id=?").get(dramaId) as Record<string, unknown> | undefined;
        return row ? this.mapPlanningStateRow(row) : null;
    }

    private mapPlanningStateRow(row: Record<string, unknown>): EpisodePlanningState {
        return {
            dramaId: String(row.drama_id),
            episodeMode: String(row.episode_mode || "chapter"),
            planCursor: Number(row.plan_cursor || 0),
            planDone: Number(row.plan_done || 0) === 1,
            sourceFingerprint: String(row.source_fingerprint || ""),
            lastChapterIndex: Number(row.last_chapter_index || 0),
            batchChapters: Number(row.batch_chapters || 12),
            batchChars: Number(row.batch_chars || 30000),
            updatedAt: String(row.updated_at || ""),
        };
    }

    private mapSourceChapterRow(row: Record<string, unknown>): SourceChapter {
        return {
            id: String(row.id), dramaId: String(row.drama_id), chapterIndex: Number(row.chapter_index),
            title: String(row.title || ""), body: String(row.body || ""), bodyHash: String(row.body_hash || ""), chars: Number(row.chars || 0),
            sourceFormat: String(row.source_format || ""), revision: Number(row.revision || 0), updatedAt: String(row.updated_at || ""),
        };
    }

    /**
     * 首次切章写入 source_chapters 并给出持久 ID；指纹未变时直接复用，不再重跑切章。
     * 稳定 ID 按 (drama_id, chapter_index) 落库，正文变了也保留同一 ID（只更新 hash/title）。
     */
    syncSourceChapters(dramaId: string, sourceScript: string, split: { excluded: readonly number[]; maxChars: number }, episodeMode = "chapter"): { chapters: SourceChapter[]; fingerprint: string; reused: boolean } {
        const excluded = new Set((split.excluded || []).map(Number));
        const maxChars = Number(split.maxChars) || 3000;
        const fingerprint = crypto.createHash("sha256")
            .update("source-chapters-v1").update("\0").update(String(sourceScript || "")).update("\0")
            .update(JSON.stringify({ maxChars, excluded: [...excluded].sort((left, right) => left - right) })).digest("hex");
        const now = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const state = this.getEpisodePlanningState(dramaId);
            if (state && state.sourceFingerprint === fingerprint && state.lastChapterIndex > 0) {
                const rows = this.db.prepare("SELECT * FROM source_chapters WHERE drama_id=? ORDER BY chapter_index ASC").all(dramaId) as Array<Record<string, unknown>>;
                if (rows.length) {
                    this.db.exec("COMMIT");
                    return { chapters: rows.map((row) => this.mapSourceChapterRow(row)), fingerprint, reused: true };
                }
            }
            // 后端复用 canvas-agent 的同一套切章规则（drama-planning-routes 的口径），保证章序号一致。
            const splitResult = analyzeNovelChapters(String(sourceScript || ""), { maxChars, minChars: 200 });
            const eligible = splitResult.chapters.filter((chapter) => !excluded.has(chapter.index));
            const lastChapterIndex = eligible.reduce((max, chapter) => Math.max(max, chapter.index), 0);
            for (const chapter of eligible) {
                const bodyHash = crypto.createHash("sha256").update(chapter.body).digest("hex");
                const prior = this.db.prepare("SELECT id FROM source_chapters WHERE drama_id=? AND chapter_index=?").get(dramaId, chapter.index) as { id: string } | undefined;
                if (prior) {
                    this.db.prepare("UPDATE source_chapters SET title=?, body=?, body_hash=?, chars=?, revision=revision+1, updated_at=? WHERE id=?").run(chapter.title, chapter.body, bodyHash, chapter.body.length, now, prior.id);
                } else {
                    this.db.prepare("INSERT INTO source_chapters (id, drama_id, chapter_index, title, body, body_hash, chars, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
                        .run(crypto.randomUUID(), dramaId, chapter.index, chapter.title, chapter.body, bodyHash, chapter.body.length, now, now);
                }
            }
            if (state) {
                this.db.prepare("UPDATE drama_episode_planning_state SET source_fingerprint=?, last_chapter_index=?, updated_at=? WHERE drama_id=?").run(fingerprint, lastChapterIndex, now, dramaId);
            } else {
                this.db.prepare("INSERT INTO drama_episode_planning_state (drama_id, episode_mode, plan_cursor, plan_done, source_fingerprint, last_chapter_index, batch_chapters, batch_chars, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
                    .run(dramaId, episodeMode, 0, 0, fingerprint, lastChapterIndex, 12, 30000, now);
            }
            this.db.exec("COMMIT");
        } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
        const rows = this.db.prepare("SELECT * FROM source_chapters WHERE drama_id=? ORDER BY chapter_index ASC").all(dramaId) as Array<Record<string, unknown>>;
        return { chapters: rows.map((row) => this.mapSourceChapterRow(row)), fingerprint, reused: false };
    }

    /** 只读取已持久化的章节 IR（完成后复用，绝不重算）。 */
    listSourceChapters(dramaId: string): SourceChapter[] {
        const rows = this.db.prepare("SELECT * FROM source_chapters WHERE drama_id=? ORDER BY chapter_index ASC").all(dramaId) as Array<Record<string, unknown>>;
        return rows.map((row) => this.mapSourceChapterRow(row));
    }

    /** 按稳定章 ID 读单章原文（含正文）；传 dramaId 时顺带做剧目归属校验。 */
    getSourceChapter(chapterId: string, dramaId?: string): SourceChapter | null {
        const row = dramaId
            ? this.db.prepare("SELECT * FROM source_chapters WHERE id=? AND drama_id=?").get(chapterId, dramaId)
            : this.db.prepare("SELECT * FROM source_chapters WHERE id=?").get(chapterId);
        return row ? this.mapSourceChapterRow(row as Record<string, unknown>) : null;
    }

    /** 按集反查它覆盖的章节（含正文）：chapter_ids_json 的稳定 ID → source_chapters 行，按章序号升序。 */
    listEpisodeChapters(episodeId: string): SourceChapter[] {
        const episode = this.getDramaEpisode(episodeId);
        if (!episode?.chapterIds?.length) return [];
        const ids = [...new Set(episode.chapterIds)];
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db.prepare(`SELECT * FROM source_chapters WHERE id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
        const byId = new Map(rows.map((row) => [String(row.id), this.mapSourceChapterRow(row)] as const));
        return ids.map((id) => byId.get(id)).filter((chapter): chapter is SourceChapter => Boolean(chapter))
            .sort((left, right) => left.chapterIndex - right.chapterIndex);
    }

    /**
     * 单章原文写入（影策 UpdateDramaChapter 同款语义）：只改正文/标题/素材类型，
     * 不改章节数、稳定 ID 与分集结果；plan_done 后依然允许改，改完由前端提示「重新改编」。
     * 写 source_chapters.body 并重算 body_hash/chars；revision/updatedAt 乐观锁 + 同值幂等重放。
     */
    updateSourceChapter(input: {
        chapterId: string;
        dramaId?: string;
        body?: string;
        title?: string;
        sourceFormat?: string;
        expectedRevision?: number;
        expectedUpdatedAt?: string;
    }): { chapter: SourceChapter; changed: boolean; affectedEpisodeIds: string[] } {
        const now = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const row = (input.dramaId
                ? this.db.prepare("SELECT * FROM source_chapters WHERE id=? AND drama_id=?").get(input.chapterId, input.dramaId)
                : this.db.prepare("SELECT * FROM source_chapters WHERE id=?").get(input.chapterId)) as Record<string, unknown> | undefined;
            if (!row) throw new SourceChapterWriteError("章节不存在", "NOT_FOUND");
            const current = this.mapSourceChapterRow(row);

            if (input.body !== undefined && (!input.body.trim() || input.body.length > 400000)) {
                throw new SourceChapterWriteError("原文不能为空，且不能超过 40 万字", "VALIDATION");
            }
            if (input.title !== undefined && (!input.title.trim() || [...input.title.trim()].length > 200)) {
                throw new SourceChapterWriteError("章节标题需为 1 到 200 字", "VALIDATION");
            }
            if (input.sourceFormat !== undefined && !SOURCE_CHAPTER_FORMATS.has(input.sourceFormat)) {
                throw new SourceChapterWriteError("素材类型无效（novel/script/storyboard）", "VALIDATION");
            }

            const nextBody = input.body === undefined ? current.body : input.body;
            const nextTitle = input.title === undefined ? current.title : input.title.trim();
            const nextFormat = input.sourceFormat === undefined ? current.sourceFormat : input.sourceFormat;
            // 幂等：没有任何有效字段变化 → 原样返回，不校验版本、不自增 revision。
            if (nextBody === current.body && nextTitle === current.title && nextFormat === current.sourceFormat) {
                this.db.exec("COMMIT");
                return { chapter: current, changed: false, affectedEpisodeIds: [] };
            }
            if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== current.revision) {
                throw new SourceChapterWriteError(`章节原文已被其他窗口修改（期望版本 ${input.expectedRevision}，当前 ${current.revision}）`, "CONFLICT");
            }
            if (input.expectedUpdatedAt !== undefined && String(input.expectedUpdatedAt) !== current.updatedAt) {
                throw new SourceChapterWriteError("章节原文已被其他窗口修改，请重新读取后再保存", "CONFLICT");
            }
            const bodyHash = crypto.createHash("sha256").update(nextBody).digest("hex");
            const updated = this.db.prepare(
                "UPDATE source_chapters SET body=?, body_hash=?, chars=?, title=?, source_format=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND updated_at=?"
            ).run(nextBody, bodyHash, nextBody.length, nextTitle, nextFormat, now, current.id, current.revision, current.updatedAt);
            if (updated.changes !== 1) throw new SourceChapterWriteError("章节原文并发冲突，请重试", "CONFLICT");

            const affectedEpisodeIds: string[] = [];
            if (nextFormat !== current.sourceFormat) {
                // 素材类型是集级字段（影策 UpdateDramaEpisode）：按章编辑时同步到所有覆盖该章的集。
                const episodes = this.listDramaEpisodes(current.dramaId);
                for (const episode of episodes) {
                    if (!episode.chapterIds.includes(current.id)) continue;
                    this.db.prepare("UPDATE drama_episodes SET source_format=?, updated_at=? WHERE id=?").run(nextFormat, now, episode.id);
                    affectedEpisodeIds.push(episode.id);
                }
            }
            this.db.exec("COMMIT");
            return { chapter: this.getSourceChapter(current.id)!, changed: true, affectedEpisodeIds };
        } catch (error) {
            if (this.db.isTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }

    /**
     * 本集覆盖的原著章节序号（1 起，升序去重）：drama_episodes.chapter_ids_json 的稳定 ID
     * → source_chapters.chapter_index。这是造型章节范围选图的唯一章序号真值源；
     * 老剧目没走新分集规划、chapter_ids_json 为空时返回 []，此时造型选图回退角色主图。
     */
    resolveEpisodeChapterNumbers(episodeId: string): number[] {
        const episode = this.getDramaEpisode(episodeId);
        if (!episode?.chapterIds?.length) return [];
        const byId = new Map(this.listSourceChapters(episode.dramaId).map((chapter) => [chapter.id, chapter.chapterIndex] as const));
        const numbers = episode.chapterIds.map((id) => byId.get(id)).filter((index): index is number => typeof index === "number");
        return [...new Set(numbers)].sort((left, right) => left - right);
    }

    /** 分集方式写游标状态；plan_done 后拒绝改（影策 UpdateDramaSettings 同款锁）。 */
    setEpisodePlanningMode(dramaId: string, episodeMode: string): void {
        const state = this.getEpisodePlanningState(dramaId);
        if (state?.planDone) throw new Error("分集已完成，不能修改分集方式");
        const now = new Date().toISOString();
        if (state) {
            this.db.prepare("UPDATE drama_episode_planning_state SET episode_mode=?, updated_at=? WHERE drama_id=?").run(episodeMode, now, dramaId);
        } else {
            this.db.prepare("INSERT INTO drama_episode_planning_state (drama_id, episode_mode, plan_cursor, plan_done, source_fingerprint, last_chapter_index, batch_chapters, batch_chars, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
                .run(dramaId, episodeMode, 0, 0, "", 0, 12, 30000, now);
        }
    }

    /**
     * 单事务批量建集：WHERE plan_cursor=? 做 CAS；ON CONFLICT DO NOTHING 保证幂等；
     * plan_done=1 拒绝写入；同一批重放返回 replayed=true 且不追加集、不推进游标。
     */
    applyPlanBatch(input: {
        dramaId: string;
        expectedCursor: number;
        lastChapterIndex: number;
        groups: readonly PlannedEpisode[];
        planJson: DramaProductionPlan;
        expectedUpdatedAt?: string;
    }): { episodes: DramaEpisode[]; nextCursor: number; planDone: boolean; replayed: boolean } {
        const now = new Date().toISOString();
        let nextCursor = 0;
        let planDone = 0;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const state = this.getEpisodePlanningState(input.dramaId);
            if (!state) throw new Error("分集规划状态未初始化，请先预览分集");
            const existingByNumber = new Map(input.groups.map((group) => [group.episodeNumber, this.getDramaEpisodeByNumber(input.dramaId, group.episodeNumber)] as const));
            const isReplay = input.groups.length > 0 && input.groups.every((group) => {
                const episode = existingByNumber.get(group.episodeNumber);
                if (!episode) return false;
                return episode.title === group.title
                    && JSON.stringify([...episode.chapterIds].sort()) === JSON.stringify([...group.chapterIds].sort());
            });
            if (state.planCursor !== input.expectedCursor) {
                if (isReplay) {
                    this.db.exec("COMMIT");
                    return { episodes: input.groups.map((group) => existingByNumber.get(group.episodeNumber)!), nextCursor: state.planCursor, planDone: state.planDone, replayed: true };
                }
                throw new Error(`规划游标已变化（期望 ${input.expectedCursor}，当前 ${state.planCursor}），请重新预览后再建集`);
            }
            if (state.planDone) throw new Error("分集已完成，不能修改分集结果");
            if (state.lastChapterIndex !== input.lastChapterIndex) throw new Error("章节数已变化，请重新预览后再建集");
            if (input.expectedUpdatedAt) {
                const prior = this.db.prepare("SELECT updated_at FROM drama_projects WHERE folder_id=?").get(input.dramaId) as { updated_at?: string } | undefined;
                if (String(prior?.updated_at || "") !== input.expectedUpdatedAt) throw new Error("剧目规划已被其他窗口修改，请重新读取后再建集");
            }
            const maxCovered = input.groups.reduce((max, group) => group.chapterIndices.reduce((inner, index) => Math.max(inner, index), max), 0);
            nextCursor = Math.max(state.planCursor, maxCovered + 1);
            planDone = nextCursor > input.lastChapterIndex ? 1 : 0;
            for (const group of input.groups) {
                this.db.prepare(
                    "INSERT INTO drama_episodes (id, drama_id, episode_number, title, synopsis, full_plot, canvas_id, chapter_ids_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(drama_id, episode_number) DO NOTHING"
                ).run(`episode-${input.dramaId}-${group.episodeNumber}-${crypto.randomUUID().slice(0, 8)}`, input.dramaId, group.episodeNumber, group.title, group.synopsis, "", null, JSON.stringify(group.chapterIds), now, now);
            }
            this.db.prepare("UPDATE drama_projects SET production_plan_json=?, updated_at=? WHERE folder_id=?").run(JSON.stringify(input.planJson), now, input.dramaId);
            const changed = this.db.prepare("UPDATE drama_episode_planning_state SET plan_cursor=?, plan_done=?, updated_at=? WHERE drama_id=? AND plan_cursor=?")
                .run(nextCursor, planDone, now, input.dramaId, state.planCursor).changes;
            if (changed !== 1) throw new Error("规划游标并发冲突，请重试");
            this.db.exec("COMMIT");
        } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
        return {
            episodes: input.groups.map((group) => this.getDramaEpisodeByNumber(input.dramaId, group.episodeNumber)!).filter(Boolean),
            nextCursor, planDone: planDone === 1, replayed: false,
        };
    }

    // ── drama_episodes ───────────────────────────────────────────
    // episode 主键是 id（nanoid），drama_id + episode_number 唯一。
    // upsertDramaEpisode 接受传入的 episode 对象，若 id 未填则随机生成；
    // 同 (drama_id, episode_number) 已存在时按 id 替换（保留原 id）。

    /**
     * 手工加集口（POST /drama/projects/:dramaId/episodes）的 PlanDone 门禁：
     * 对齐影策 —— 规划未完成（planDone=false）时不能手工加集，完成后才允许
     * 「逐集追加新的一集」（影策 repository_drama.go:140 `if !PlanDone return ErrDramaPlanPending`，
     * detail.tsx:821 blockedReason=planDone?undefined:...；drama_actions.go:51 注释
     * 「已完成分集…之后可在制作台逐集追加新的一集」）。
     * 只拦「新增集号」，既有集编辑（改标题/梗概/绑画布等）不受影响。
     * 无 planning 记录的新剧目（如首集）放行，保持原行为。
     */
    assertDramaEpisodeCreationAllowed(dramaId: string, episodeNumber: number): void {
        const state = this.getEpisodePlanningState(dramaId);
        if (state && !state.planDone && !this.getDramaEpisodeByNumber(dramaId, episodeNumber)) {
            throw new Error("分集规划尚未完成，完成后才能手工追加新的一集");
        }
    }

    upsertDramaEpisode(input: { id?: string; dramaId: string; episodeNumber: number; title: string; synopsis: string; fullPlot?: string; sourceFormat?: string; sourceText?: string; canvasId?: string | null }): DramaEpisode {
        const now = new Date().toISOString();
        const id = input.id || `episode-${input.dramaId}-${input.episodeNumber}-${Math.random().toString(36).slice(2, 8)}`;
        const existing = this.getDramaEpisodeByNumber(input.dramaId, input.episodeNumber);
        const createdAt = existing?.createdAt || now;
        const canvasId = input.canvasId === undefined ? existing?.canvasId ?? null : input.canvasId;
        const fullPlot = input.fullPlot ?? "";
        // 原文两列未传时保留既有值：后续只改标题/画布不能把原文抹掉。
        const sourceFormat = input.sourceFormat === undefined ? existing?.sourceFormat ?? "" : input.sourceFormat;
        const sourceText = input.sourceText === undefined ? existing?.sourceText ?? "" : input.sourceText;
        if (existing) {
            this.db.prepare(
                "UPDATE drama_episodes SET title=?, synopsis=?, full_plot=?, source_format=?, source_text=?, canvas_id=?, updated_at=? WHERE id=?"
            ).run(input.title, input.synopsis, fullPlot, sourceFormat, sourceText, canvasId, now, existing.id);
            return this.getDramaEpisode(existing.id)!;
        }
        this.db.prepare(
            "INSERT INTO drama_episodes (id, drama_id, episode_number, title, synopsis, full_plot, source_format, source_text, canvas_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, input.dramaId, input.episodeNumber, input.title, input.synopsis, fullPlot, sourceFormat, sourceText, canvasId, createdAt, now);
        return this.getDramaEpisode(id)!;
    }

    /** 读一批分集既有的制作阶段游标（episode_productions.draft_json.settings.productionStage）。 */
    listEpisodeProductionStages(episodeIds: readonly string[]): Record<string, { current?: string; done: string[] }> {
        const ids = episodeIds.filter(Boolean);
        if (!ids.length) return {};
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db.prepare(`SELECT episode_id, draft_json FROM episode_productions WHERE episode_id IN (${placeholders})`).all(...ids) as Array<{ episode_id: string; draft_json?: string | null }>;
        const out: Record<string, { current?: string; done: string[] }> = {};
        for (const row of rows) {
            try {
                const draft = row.draft_json ? JSON.parse(String(row.draft_json)) : {};
                const stage = draft?.settings?.productionStage;
                if (stage && typeof stage === "object") {
                    out[row.episode_id] = {
                        ...(typeof stage.current === "string" ? { current: stage.current } : {}),
                        done: Array.isArray(stage.done) ? stage.done.map(String) : [],
                    };
                }
            } catch { /* 坏数据当没游标 */ }
        }
        return out;
    }

    updateDramaEpisode(id: string, patch: { episodeNumber?: number; title?: string; synopsis?: string; fullPlot?: string; sourceFormat?: string; sourceText?: string; canvasId?: string | null }): DramaEpisode | null {
        const existing = this.getDramaEpisode(id);
        if (!existing) return null;
        const nextNumber = patch.episodeNumber ?? existing.episodeNumber;
        const nextTitle = patch.title ?? existing.title;
        const nextSynopsis = patch.synopsis ?? existing.synopsis;
        const nextFullPlot = patch.fullPlot ?? existing.fullPlot;
        const nextSourceFormat = patch.sourceFormat ?? existing.sourceFormat;
        const nextSourceText = patch.sourceText ?? existing.sourceText;
        const nextCanvasId = patch.canvasId === undefined ? existing.canvasId : patch.canvasId;
        const conflict = this.getDramaEpisodeByNumber(existing.dramaId, nextNumber);
        if (conflict && conflict.id !== id) throw new Error(`分集编号已存在: ${existing.dramaId}/${nextNumber}`);
        if (nextCanvasId) {
            const canvasConflict = this.getDramaEpisodeByCanvasId(nextCanvasId);
            if (canvasConflict && canvasConflict.id !== id) throw new Error(`画布已绑定到分集: ${canvasConflict.id}`);
        }
        this.db.prepare(
            "UPDATE drama_episodes SET episode_number=?, title=?, synopsis=?, full_plot=?, source_format=?, source_text=?, canvas_id=?, updated_at=? WHERE id=?"
        ).run(nextNumber, nextTitle, nextSynopsis, nextFullPlot, nextSourceFormat, nextSourceText, nextCanvasId, new Date().toISOString(), id);
        return this.getDramaEpisode(id);
    }

    getDramaEpisode(id: string): DramaEpisode | null {
        const row = this.db.prepare("SELECT * FROM drama_episodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? this.mapDramaEpisodeRow(row) : null;
    }

    getDramaEpisodeByNumber(dramaId: string, episodeNumber: number): DramaEpisode | null {
        const row = this.db.prepare("SELECT * FROM drama_episodes WHERE drama_id = ? AND episode_number = ?").get(dramaId, episodeNumber) as Record<string, unknown> | undefined;
        return row ? this.mapDramaEpisodeRow(row) : null;
    }

    getDramaEpisodeByCanvasId(canvasId: string): DramaEpisode | null {
        const row = this.db.prepare("SELECT * FROM drama_episodes WHERE canvas_id = ?").get(canvasId) as Record<string, unknown> | undefined;
        return row ? this.mapDramaEpisodeRow(row) : null;
    }

    listDramaEpisodes(dramaId: string): DramaEpisode[] {
        const rows = this.db.prepare("SELECT * FROM drama_episodes WHERE drama_id = ? ORDER BY episode_number ASC").all(dramaId) as Array<Record<string, unknown>>;
        return rows.map((row) => this.mapDramaEpisodeRow(row));
    }

    listDramaEpisodeSummaries(dramaId: string, page = 1, pageSize = 20) {
        const total = Number((this.db.prepare("SELECT COUNT(*) AS count FROM drama_episodes WHERE drama_id = ?").get(dramaId) as { count: number }).count);
        const normalizedPage = Math.max(1, Math.floor(page));
        const normalizedPageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
        const rows = this.db.prepare(`SELECT id, drama_id, episode_number, title, synopsis, canvas_id, created_at, updated_at
            FROM drama_episodes WHERE drama_id = ? ORDER BY episode_number ASC LIMIT ? OFFSET ?`)
            .all(dramaId, normalizedPageSize, (normalizedPage - 1) * normalizedPageSize) as Array<Record<string, unknown>>;
        return {
            total, page: normalizedPage, pageSize: normalizedPageSize,
            episodes: rows.map((row) => ({
                id: String(row.id), dramaId: String(row.drama_id), episodeNumber: Number(row.episode_number),
                title: String(row.title || ""), synopsis: String(row.synopsis || ""),
                canvasId: row.canvas_id ? String(row.canvas_id) : null,
                createdAt: String(row.created_at), updatedAt: String(row.updated_at),
            })),
        };
    }

    /**
     * 删集的服务端权威判定（影策 repository_drama.go:288 dramaEpisodeHasVideo 同口径）。
     * 只读本集既有的真值：succeeded 的 video/render 流水线作业 = 分镜视频/成片，
     * episode_productions 制作稿里的 director.workflow.finalResource = 成片，
     * episode_production_versions / published_version / archived_at = 历史版本。
     * 不写第二份副本，也不拿剧目级 stage 代替本集事实；客户端初判仅供参考。
     */
    dramaEpisodeDeleteGuard(episode: DramaEpisode): {
        episodeNumber: number;
        confirmText: string;
        required: boolean;
        reasons: string[];
        stats: { videoJobs: number; finalResource: boolean; versions: number; publishedVersion: number; archived: boolean };
    } {
        const episodeId = episode.id;
        const videoJobs = Number((this.db.prepare("SELECT COUNT(*) AS count FROM drama_pipeline_jobs WHERE episode_id=? AND status='succeeded' AND kind IN ('video','render')").get(episodeId) as { count?: number } | undefined)?.count || 0);
        const versions = Number((this.db.prepare("SELECT COUNT(*) AS count FROM episode_production_versions WHERE episode_id=?").get(episodeId) as { count?: number } | undefined)?.count || 0);
        const production = this.db.prepare("SELECT draft_json, published_json, published_version, archived_at FROM episode_productions WHERE episode_id=?").get(episodeId) as { draft_json?: string | null; published_json?: string | null; published_version?: number | null; archived_at?: string | null } | undefined;
        const finalResourceKey = (json: unknown): string => {
            try {
                const doc = JSON.parse(String(json || "{}")) as { director?: { workflow?: { finalResource?: { storageKey?: unknown; key?: unknown } } } };
                const resource = doc?.director?.workflow?.finalResource;
                return String(resource?.storageKey || resource?.key || "");
            } catch { return ""; }
        };
        const finalResource = Boolean(finalResourceKey(production?.draft_json) || finalResourceKey(production?.published_json));
        const publishedVersion = Number(production?.published_version || 0);
        const archived = Boolean(production?.archived_at);
        const reasons: string[] = [];
        if (videoJobs > 0) reasons.push(`已生成 ${videoJobs} 段分镜视频`);
        if (finalResource) reasons.push("已有成片");
        if (archived) reasons.push("成片已归档");
        if (publishedVersion > 0) reasons.push(`已发布 v${publishedVersion}`);
        if (versions > 0) reasons.push(`有 ${versions} 个历史版本`);
        const confirmText = `第 ${episode.episodeNumber} 集`;
        return {
            episodeNumber: episode.episodeNumber, confirmText,
            required: reasons.length > 0, reasons,
            stats: { videoJobs, finalResource, versions, publishedVersion, archived },
        };
    }

    deleteDramaEpisode(id: string): number {
        return Number(this.db.prepare("DELETE FROM drama_episodes WHERE id = ?").run(id).changes);
    }

    private mapDramaEpisodeRow(row: Record<string, unknown>): DramaEpisode {
        let chapterIds: string[] = [];
        try {
            const parsed = JSON.parse(String(row.chapter_ids_json || "[]"));
            if (Array.isArray(parsed)) chapterIds = parsed.map(String);
        } catch { /* 坏数据当空，不挡住分集读取 */ }
        return {
            id: String(row.id),
            dramaId: String(row.drama_id),
            episodeNumber: Number(row.episode_number),
            title: String(row.title || ""),
            synopsis: String(row.synopsis || ""),
            fullPlot: String(row.full_plot || ""),
            sourceFormat: String(row.source_format || ""),
            sourceText: String(row.source_text || ""),
            canvasId: row.canvas_id ? String(row.canvas_id) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            chapterIds,
        };
    }

    deleteCanvasFolder(id: string): number {
        // 画布普通文件夹才允许从这里删除；短剧项目由 deleteDramaProject 显式删除。
        if (this.isDramaProject(id)) return 0;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const deleted = Number(this.db.prepare("DELETE FROM canvas_folders WHERE id = ?").run(id).changes);
            this.db.exec("COMMIT");
            return deleted;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    isDramaProject(id: string): boolean {
        return Boolean(this.db.prepare("SELECT 1 FROM drama_projects WHERE folder_id = ?").get(id));
    }

    listDramaCanvasIds(id: string): string[] {
        const rows = this.db.prepare(`
            SELECT canvas_id AS id FROM drama_episodes WHERE drama_id=? AND canvas_id IS NOT NULL
            UNION SELECT shared_asset_canvas_id AS id FROM drama_projects WHERE folder_id=? AND shared_asset_canvas_id IS NOT NULL
            UNION SELECT c.canvas_id AS id FROM drama_scene_canvases c JOIN drama_scene_instances s ON s.id=c.scene_id WHERE s.drama_id=?
        `).all(id, id, id) as Array<{ id: string }>;
        return rows.map((row) => String(row.id));
    }

    deleteDramaProject(id: string, freeCanvasIds: string[] = []): number {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            if (!this.isDramaProject(id)) {
                this.db.exec("COMMIT");
                return 0;
            }
            const requestedCanvasIds = [...new Set(freeCanvasIds.filter((canvasId) => typeof canvasId === "string" && canvasId.length > 0))];
            for (const canvasId of requestedCanvasIds) {
                const belongsToOtherDrama = this.db.prepare(`
                    SELECT 1 FROM drama_episodes WHERE canvas_id=? AND drama_id<>?
                    UNION SELECT 1 FROM drama_projects WHERE shared_asset_canvas_id=? AND folder_id<>?
                    UNION SELECT 1 FROM drama_scene_canvases c JOIN drama_scene_instances s ON s.id=c.scene_id WHERE c.canvas_id=? AND s.drama_id<>?
                `).get(canvasId, id, canvasId, id, canvasId, id);
                if (belongsToOtherDrama) throw new Error(`画布属于其他剧目，不能随当前剧目删除: ${canvasId}`);
            }
            const uniqueCanvasIds = [...new Set([...this.listDramaCanvasIds(id), ...requestedCanvasIds])];
            const deleted = Number(this.db.prepare("DELETE FROM canvas_folders WHERE id = ?").run(id).changes);
            const deleteCanvas = this.db.prepare("DELETE FROM canvas_projects WHERE id=?");
            for (const canvasId of uniqueCanvasIds) deleteCanvas.run(canvasId);
            // 级联清理全自动流水线记录：剧目删了却留着 running 流水线会后台空转（pause 时报 404）。
            this.db.prepare("DELETE FROM drama_pipeline_jobs WHERE drama_id=?").run(id);
            this.db.prepare("DELETE FROM drama_pipeline_events WHERE drama_id=?").run(id);
            this.db.prepare("DELETE FROM drama_pipelines WHERE drama_id=?").run(id);
            this.db.exec("COMMIT");
            return deleted;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    private canvasProjectView(project: Record<string, unknown> | null): CanvasProject | null {
        if (!project) return null;
        try { return resolveProjectAssets(this, stripCanvasLocalViewState(project, { clone: false }) as CanvasProject); } catch { return null; }
    }

    getCanvasProject(id: string): CanvasProject | null {
        return this.canvasProjectView(readRawProject(this.db, id));
    }

    getProductionLayoutPlan(projectId: string): ProductionLayoutPlan | null {
        const row = this.db.prepare("SELECT plan_json FROM production_layout_plans WHERE project_id=?").get(projectId) as { plan_json: string } | undefined;
        return row ? productionLayoutPlanSchema.parse(JSON.parse(row.plan_json)) : null;
    }

    saveProductionLayoutPlan(projectId: string, plan: ProductionLayoutPlan): void {
        const parsed = productionLayoutPlanSchema.parse(plan);
        if (parsed.canvasId !== projectId) throw new Error("布局计划画布归属不一致");
        const existing = this.getProductionLayoutPlan(projectId);
        if (existing?.planHash === parsed.planHash) return;
        this.db.prepare(`INSERT INTO production_layout_plans (project_id, plan_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=excluded.updated_at`)
            .run(projectId, JSON.stringify(parsed), new Date().toISOString());
    }

    getProductionPreparationLayout(operationId: string): { plan: ProductionLayoutPlan; receipt: ProductionLayoutReceipt; expectedCanvasRevision: number } | null {
        const row = this.db.prepare("SELECT layout_plan_json, layout_receipt_json FROM production_preparations WHERE operation_id=?").get(operationId) as { layout_plan_json: string | null; layout_receipt_json: string | null } | undefined;
        if (!row?.layout_plan_json || !row.layout_receipt_json) return null;
        const frozen = JSON.parse(row.layout_receipt_json) as { receipt: ProductionLayoutReceipt; expectedCanvasRevision: number };
        return { plan: productionLayoutPlanSchema.parse(JSON.parse(row.layout_plan_json)), receipt: frozen.receipt, expectedCanvasRevision: frozen.expectedCanvasRevision };
    }

    freezeProductionPreparationLayout(operationId: string, expectedCanvasRevision: number, plan: ProductionLayoutPlan, receipt: ProductionLayoutReceipt) {
        const parsed = productionLayoutPlanSchema.parse(plan);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const preparation = this.db.prepare("SELECT layout_plan_json, layout_receipt_json FROM production_preparations WHERE operation_id=?").get(operationId) as { layout_plan_json: string | null; layout_receipt_json: string | null } | undefined;
            if (!preparation) throw new Error("找不到待提交的布局准备操作");
            if (preparation.layout_plan_json) {
                const prior = this.getProductionPreparationLayout(operationId)!;
                this.db.exec("COMMIT");
                return { ...prior, replayed: true };
            }
            if (this.getCanvasProjectRevision(parsed.canvasId) !== expectedCanvasRevision) throw new Error("画布版本已变化，须按原 operationId 重新读取并恢复准备");
            this.saveProductionLayoutPlan(parsed.canvasId, parsed);
            this.db.prepare("UPDATE production_preparations SET layout_plan_json=?, layout_receipt_json=? WHERE operation_id=?")
                .run(JSON.stringify(parsed), JSON.stringify({ receipt, expectedCanvasRevision }), operationId);
            this.db.exec("COMMIT");
            return { plan: parsed, receipt, expectedCanvasRevision, replayed: false };
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    getCanvasProjectRevision(id: string): number | null {
        const row = this.db.prepare("SELECT CASE WHEN json_valid(data_json) THEN COALESCE(json_extract(data_json, '$.revision'), 0) END AS revision FROM canvas_projects WHERE id = ?").get(id) as { revision?: number | null } | undefined;
        return row?.revision === undefined || row.revision === null ? null : Number(row.revision);
    }

    listPluginDeclarations(): PluginDeclaration[] {
        const rows = this.db.prepare("SELECT * FROM plugin_declarations ORDER BY id").all() as Array<Record<string, unknown>>;
        return rows.flatMap((row) => {
            try {
                const tools = JSON.parse(String(row.tools_json || "[]"));
                return [{ id: String(row.id), name: String(row.name), version: String(row.version), enabled: Boolean(row.enabled), tools: Array.isArray(tools) ? tools : [], updatedAt: String(row.updated_at) }];
            } catch { return []; }
        });
    }

    replacePluginDeclarations(declarations: PluginDeclaration[]): PluginDeclaration[] {
        const now = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const upsert = this.db.prepare("INSERT INTO plugin_declarations (id, name, version, enabled, tools_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, enabled=excluded.enabled, tools_json=excluded.tools_json, updated_at=excluded.updated_at");
            for (const declaration of declarations) {
                if (!declaration?.id) continue;
                upsert.run(declaration.id, declaration.name || declaration.id, declaration.version || "0.0.0", declaration.enabled ? 1 : 0, JSON.stringify(declaration.tools || []), declaration.updatedAt || now);
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return this.listPluginDeclarations();
    }

    // ── workflow_configs ─────────────────────────────────────────────────

    getWorkflowConfig(name: string): WorkflowConfigRow | null {
        const row = this.db.prepare("SELECT * FROM workflow_configs WHERE name = ?").get(name) as Record<string, unknown> | undefined;
        if (!row) return null;
        try {
            return {
                name: String(row.name),
                title: String(row.title || ''),
                backend: String(row.backend || ''),
                description: String(row.description || ''),
                operation: String(row.operation || ''),
                fieldsJson: String(row.fields_json || '[]'),
                mediaInputsJson: String(row.media_inputs_json || '{}'),
                miniCardsJson: String(row.mini_cards_json || '{}'),
                runningHubProfileId: String(row.runninghub_profile_id || ''),
                runTarget: String(row.run_target || 'local'),
                outputNodesJson: String(row.output_nodes_json ?? ''),
                previewNodeId: String(row.preview_node_id ?? ''),
                durationTargetJson: String(row.duration_target_json ?? ''),
                updatedAt: String(row.updated_at),
            };
        } catch { return null; }
    }

    /** Resolve persisted field IDs against stored workflow definitions so log labels survive workflow routing/version changes. */
    getWorkflowFieldDefinitionsByIds(ids: string[]): Array<{ workflowName: string; field: WorkflowField }> {
        const requested = new Set(ids.filter((id) => typeof id === "string" && id));
        if (!requested.size) return [];
        const rows = this.db.prepare("SELECT name, fields_json FROM workflow_configs").all() as Array<{ name: string; fields_json: string }>;
        const matches = new Map<string, Map<string, { workflowName: string; field: WorkflowField }>>();
        for (const row of rows) {
            let fields: unknown;
            try { fields = JSON.parse(row.fields_json || "[]"); } catch { continue; }
            if (!Array.isArray(fields)) continue;
            for (const candidate of fields) {
                if (!candidate || typeof candidate !== "object") continue;
                const field = candidate as WorkflowField;
                if (!requested.has(field.id)) continue;
                const signature = JSON.stringify([field.name || "", field.input || "", field.node || "", field.type || ""]);
                let definitions = matches.get(field.id);
                if (!definitions) {
                    definitions = new Map();
                    matches.set(field.id, definitions);
                }
                if (!definitions.has(signature)) definitions.set(signature, { workflowName: row.name, field });
            }
        }
        return [...requested].flatMap((id) => {
            const definitions = matches.get(id);
            // A field ID reused for conflicting definitions has no trustworthy display name.
            return definitions?.size === 1 ? [...definitions.values()] : [];
        });
    }

    upsertWorkflowConfig(name: string, config: {
        title?: string; backend?: string; description?: string; operation?: string;
        fieldsJson?: string; mediaInputsJson?: string; miniCardsJson?: string;
        runningHubProfileId?: string; runTarget?: string; outputNodesJson?: string; previewNodeId?: string;
        durationTargetJson?: string;
    }): void {
        const now = new Date().toISOString();
        const existing = this.getWorkflowConfig(name);
        this.db.prepare(`
            INSERT INTO workflow_configs (name, title, backend, description, operation, fields_json, media_inputs_json, mini_cards_json, runninghub_profile_id, run_target, output_nodes_json, preview_node_id, duration_target_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                title = excluded.title, backend = excluded.backend, description = excluded.description,
                operation = excluded.operation, fields_json = excluded.fields_json,
                media_inputs_json = excluded.media_inputs_json, mini_cards_json = excluded.mini_cards_json,
                runninghub_profile_id = excluded.runninghub_profile_id,
                run_target = excluded.run_target,
                output_nodes_json = excluded.output_nodes_json,
                preview_node_id = excluded.preview_node_id,
                duration_target_json = excluded.duration_target_json,
                updated_at = excluded.updated_at
        `).run(
            name,
            config.title ?? existing?.title ?? '',
            config.backend ?? existing?.backend ?? '',
            config.description ?? existing?.description ?? '',
            config.operation ?? existing?.operation ?? '',
            config.fieldsJson ?? existing?.fieldsJson ?? '[]',
            config.mediaInputsJson ?? existing?.mediaInputsJson ?? '{}',
            config.miniCardsJson ?? existing?.miniCardsJson ?? '{}',
            config.runningHubProfileId ?? existing?.runningHubProfileId ?? '',
            config.runTarget ?? existing?.runTarget ?? 'local',
            config.outputNodesJson ?? existing?.outputNodesJson ?? '',
            config.previewNodeId ?? existing?.previewNodeId ?? '',
            config.durationTargetJson ?? existing?.durationTargetJson ?? '',
            now,
        );
    }

    deleteWorkflowConfig(name: string): number {
        return Number(this.db.prepare("DELETE FROM workflow_configs WHERE name = ?").run(name).changes);
    }

    /**
     * 同一个云端档案对应的本地工作流（用户可能上传后又在本地断续编辑），按最近修改排序。
     * 「从 RunningHub 导入本地副本」用它把本地自定义的字段配置继承回来。
     */
    listWorkflowNamesByRunningHubProfile(profileId: string): string[] {
        if (!profileId) return [];
        const rows = this.db.prepare(
            "SELECT name FROM workflow_configs WHERE runninghub_profile_id = ? ORDER BY updated_at DESC",
        ).all(profileId) as Array<{ name: string }>;
        return rows.map((row) => String(row.name));
    }

    listAssets(options: { kind?: string; folderId?: string; dramaId?: string } = {}): Asset[] {
        purgeOrphanedSharedAssets(this);
        const clauses: string[] = [];
        const values: Array<string | null> = [];
        if (options.kind) { clauses.push("kind = ?"); values.push(options.kind); }
        if (options.folderId) { clauses.push("folder_id = ?"); values.push(options.folderId); }
        if (options.dramaId) { clauses.push("drama_id = ?"); values.push(options.dramaId); }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db.prepare(`SELECT * FROM assets ${where} ORDER BY updated_at DESC`).all(...values) as Array<Record<string, unknown>>;
        const assets = rows.map(row => projectAsset(this, assetFromRow(row)));
        const canonicalIds = canonicalSharedAssetIds(this, assets);
        return assets.filter(asset => canonicalIds.has(asset.id));
    }

    getAsset(id: string): Asset | null {
        const asset = this.getAssetRecord(id);
        return asset ? projectAsset(this, asset) : null;
    }

    getAssetRecord(id: string): Asset | null {
        const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? assetFromRow(row) : null;
    }

    listSharedAssetRecordsForProject(projectId: string): Asset[] {
        return (this.db.prepare("SELECT * FROM assets WHERE json_extract(metadata_json, '$.sharedAssetSource.sourceProjectId')=?").all(projectId) as Record<string, unknown>[]).map(assetFromRow);
    }

    listAssetRecords(): Asset[] { return (this.db.prepare("SELECT * FROM assets ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(assetFromRow); }

    upsertAsset(asset: Asset, command?: AssetWriteCommand): Asset { return writeDramaAsset(this, asset, command); }

    upsertAssetRecord(asset: Asset) {
        const now = new Date().toISOString();
        const updatedAt = asset.updatedAt || now;
        const dramaId = asset.dramaId && this.db.prepare("SELECT 1 FROM drama_projects WHERE folder_id = ?").get(asset.dramaId) ? asset.dramaId : null;
        this.db.prepare(`
            INSERT INTO assets (id, kind, title, cover_url, tags_json, folder_id, drama_id, data_json, note, source, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind, title = excluded.title, cover_url = excluded.cover_url,
                tags_json = excluded.tags_json, folder_id = excluded.folder_id, drama_id = excluded.drama_id,
                data_json = excluded.data_json, note = excluded.note, source = excluded.source,
                metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
        `        ).run(
            asset.id, asset.kind, asset.title ?? "",
            asset.coverUrl ?? "", JSON.stringify(asset.tags ?? []),
            asset.folderId ?? null, dramaId, JSON.stringify(asset.data ?? {}),
            asset.note ?? null, asset.source ?? null,
            JSON.stringify(asset.metadata ?? {}),
            asset.createdAt ?? now, updatedAt,
        );
        return this.getAssetRecord(asset.id)!;
    }

    replaceAssets(assets: Asset[], folders: AssetFolder[]) {
        const commits: CanvasCommit[] = [];
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const incoming = new Set(assets.map(a => a.id));
            // No deletion bypass for referenced shared assets through a full-list import.
            for (const current of this.listAssetRecords()) if (!incoming.has(current.id)) {
                if (current.metadata.sharedAssetSource) throw new Error("共享资产不能通过整库替换删除，请使用单项删除入口");
                this.deleteAssetRecord(current.id);
            }
            this.db.prepare("DELETE FROM asset_folders").run();
            for (const folder of folders) this.upsertAssetFolder(folder);
            for (const asset of assets) this.upsertAsset(asset, { withinTransaction: true, deferredCommits: commits });
            this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        for (const commit of commits) this.notifyCanvasCommit(commit);
    }

    deleteAsset(id: string): number { return deleteDramaAsset(this, id); }

    deleteAssetRecord(id: string): number {
        return Number(this.db.prepare("DELETE FROM assets WHERE id = ?").run(id).changes);
    }

    // ── asset_folders ─────────────────────────────────────────────────────

    listAssetFolders(): AssetFolder[] {
        const rows = this.db.prepare("SELECT * FROM asset_folders ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
        return rows.map((row) => ({
            id: String(row.id), name: String(row.name),
            parentId: row.parent_id ? String(row.parent_id) : null,
            createdAt: String(row.created_at),
        }));
    }

    upsertAssetFolder(folder: AssetFolder) {
        this.db.prepare(
            "INSERT INTO asset_folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id"
        ).run(folder.id, folder.name, folder.parentId, folder.createdAt);
    }

    deleteAssetFolder(id: string): number {
        return Number(this.db.prepare("DELETE FROM asset_folders WHERE id = ?").run(id).changes);
    }

    // ── media_files ───────────────────────────────────────────────────────

    upsertMediaFile(media: MediaFile) {
        this.db.prepare(`
            INSERT INTO media_files (storage_key, file_path, mime_type, file_size, width, height, duration_ms, created_at, sha256)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(storage_key) DO UPDATE SET
                file_path = excluded.file_path, mime_type = excluded.mime_type,
                file_size = excluded.file_size, width = excluded.width,
                height = excluded.height, duration_ms = excluded.duration_ms, sha256 = COALESCE(excluded.sha256, media_files.sha256)
        `).run(
            media.storageKey, media.filePath, media.mimeType, media.bytes,
            media.width, media.height, media.durationMs, media.createdAt, media.sha256 ?? null,
        );
    }

    getMediaFile(storageKey: string): MediaFile | null {
        const row = this.db.prepare("SELECT * FROM media_files WHERE storage_key = ?").get(storageKey) as Record<string, unknown> | undefined;
        return row ? mediaFromRow(row) : null;
    }

    /** 内容寻址：按 sha256 找最早归档的那一份，用于复用同一物理文件。 */
    getMediaFileByDigest(sha256: string): MediaFile | null {
        const row = this.db.prepare("SELECT * FROM media_files WHERE sha256 = ? ORDER BY created_at ASC, storage_key ASC LIMIT 1").get(sha256) as Record<string, unknown> | undefined;
        return row ? mediaFromRow(row) : null;
    }

    /** 同一份文件被多少条其它 storage_key 共享（删除时不能把共享文件删掉）。 */
    countMediaFileSharers(filePath: string, storageKey: string): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE file_path = ? AND storage_key <> ?").get(filePath, storageKey) as { n: number };
        return Number(row.n);
    }

    listMediaFiles(): MediaFile[] {
        const rows = this.db.prepare("SELECT * FROM media_files ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
        return rows.map(mediaFromRow);
    }

    rebaseMediaFiles(fromDir: string, toDir: string): number {
        let changed = 0;
        const update = this.db.prepare("UPDATE media_files SET file_path = ? WHERE storage_key = ?");
        for (const media of this.listMediaFiles()) {
            const relative = path.relative(fromDir, media.filePath);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
            changed += Number(update.run(path.join(toDir, relative), media.storageKey).changes);
        }
        return changed;
    }

    deleteMediaFile(storageKey: string): number {
        return Number(this.db.prepare("DELETE FROM media_files WHERE storage_key = ?").run(storageKey).changes);
    }

    // ── generation_logs ───────────────────────────────────────────────────

    createGenerationLog(input: Omit<GenerationLog, "id" | "createdAt" | "updatedAt">): GenerationLog {
        const legacyId = typeof input.params?.legacyLogId === "string" ? input.params.legacyLogId : "";
        if (legacyId) {
            const existing = this.db.prepare(
                "SELECT id FROM generation_logs WHERE project_id = ? AND json_extract(stored_json_text(params_json), '$.legacyLogId') = ? LIMIT 1"
            ).get(input.projectId, legacyId) as { id?: string } | undefined;
            if (existing?.id) return this.getGenerationLog(existing.id)!;
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT INTO generation_logs
                (id, project_id, node_id, segment_id, status, platform, source, workflow, model, task_mode, prompt,
                 references_json, input_counts_json, runtime_task_id, prompt_id, started_at, finished_at,
                 duration_ms, outputs_json, error, params_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, input.projectId, input.nodeId || null, input.segmentId || null, input.status, input.platform,
            input.source || "pipeline", input.workflow || null, input.model || null, input.taskMode || null, input.prompt || null,
            JSON.stringify(input.references || []), JSON.stringify(input.inputCounts || {}),
            input.runtimeTaskId || null, input.promptId || null,
            input.startedAt || now, input.finishedAt || null, input.durationMs || 0,
            JSON.stringify(input.outputs || []), input.error || null,
            encodeStoredJson(input.params || {}), now, now,
        );
        // 原「每项目保留最近 500 条」写入时自动 DELETE 已移除（capacity-optimization-plan v3 §1.5）：
        // 该删除无保护条件，会删掉被正式绑定/活动节点/恢复依赖引用的日志。
        // 数量整理改由手动 CLI `prune-runtime-history --log-count-policy=existing-500` 执行，
        // 受保护、非终态、关联任务未到期的记录允许超过目标。
        return this.getGenerationLog(id)!;
    }

    updateGenerationLog(id: string, patch: Partial<Omit<GenerationLog, "id" | "projectId" | "createdAt">>): GenerationLog {
        const current = this.getGenerationLog(id);
        if (!current) throw new Error(`Generation log not found: ${id}`);
        const terminal = new Set<GenerationLogStatus>(["success", "failed", "cancelled"]);
        if (terminal.has(current.status) && patch.status && !terminal.has(patch.status)) return current;
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        this.db.prepare(`
            UPDATE generation_logs SET
                node_id=?, segment_id=?, status=?, platform=?, source=?, workflow=?, model=?, task_mode=?, prompt=?,
                references_json=?, input_counts_json=?, runtime_task_id=?, prompt_id=?,
                started_at=?, finished_at=?, duration_ms=?, outputs_json=?, error=?, params_json=?, updated_at=?
            WHERE id=?
        `).run(
            next.nodeId || null, next.segmentId || null, next.status, next.platform,
            next.source || "pipeline", next.workflow || null, next.model || null, next.taskMode || null, next.prompt || null,
            JSON.stringify(next.references || []), JSON.stringify(next.inputCounts || {}),
            next.runtimeTaskId || null, next.promptId || null,
            next.startedAt, next.finishedAt || null, next.durationMs || 0,
            JSON.stringify(next.outputs || []), next.error || null,
            encodeStoredJson(next.params || {}), next.updatedAt, id,
        );
        return this.getGenerationLog(id)!;
    }

    getGenerationLog(id: string): GenerationLog | null {
        const row = this.db.prepare("SELECT * FROM generation_logs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? generationLogFromRow(row) : null;
    }

    listGenerationLogs(options: { projectId?: string; projectIds?: string[]; nodeId?: string; segmentId?: string; runtimeTaskId?: string; platform?: string; model?: string; status?: GenerationLogStatus; from?: string; to?: string; limit?: number; offset?: number } = {}): GenerationLog[] {
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
        if (options.projectIds?.length) { clauses.push(`project_id IN (${options.projectIds.map(() => "?").join(",")})`); values.push(...options.projectIds); }
        if (options.nodeId) { clauses.push("node_id = ?"); values.push(options.nodeId); }
        if (options.segmentId) { clauses.push("segment_id = ?"); values.push(options.segmentId); }
        if (options.runtimeTaskId) { clauses.push("runtime_task_id = ?"); values.push(options.runtimeTaskId); }
        if (options.platform) { clauses.push("platform = ?"); values.push(options.platform); }
        if (options.model) { clauses.push("model = ?"); values.push(options.model); }
        if (options.status) { clauses.push("status = ?"); values.push(options.status); }
        if (options.from) { clauses.push("created_at >= ?"); values.push(options.from); }
        if (options.to) { clauses.push("created_at <= ?"); values.push(options.to); }
        const limit = Math.max(1, Math.min(500, Number(options.limit || 500)));
        const offset = Math.max(0, Number(options.offset || 0));
        const rows = this.db.prepare(
            `SELECT * FROM generation_logs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        ).all(...values, limit, offset) as Array<Record<string, unknown>>;
        return rows.map((row) => this.withLegacyTailFrameMedia(generationLogFromRow(row)));
    }

    /** Older H3 logs saved a captured tail's file path without its media key. Resolve it for display without rewriting the historical log. */
    private withLegacyTailFrameMedia(log: GenerationLog): GenerationLog {
        if (!log.references.some((reference) => reference.runtime === true && String(reference.id || "").startsWith("runtime-tail-") && !reference.storageKey && !reference.url && typeof reference.resolved === "string")) return log;
        const findMedia = this.db.prepare("SELECT storage_key, mime_type FROM media_files WHERE file_path = ? LIMIT 1");
        let changed = false;
        const references = log.references.map((reference) => {
            if (reference.runtime !== true || !String(reference.id || "").startsWith("runtime-tail-") || reference.storageKey || reference.url || typeof reference.resolved !== "string") return reference;
            const media = findMedia.get(reference.resolved) as { storage_key?: string; mime_type?: string } | undefined;
            if (!media?.storage_key || !String(media.mime_type || "").startsWith("image/")) return reference;
            changed = true;
            return { ...reference, storageKey: media.storage_key, mimeType: media.mime_type };
        });
        return changed ? { ...log, references } : log;
    }

    deleteGenerationLogs(options: { id?: string; projectId?: string; nodeId?: string }): number {
        const clauses: string[] = [];
        const values: Array<string> = [];
        if (options.id) { clauses.push("id = ?"); values.push(options.id); }
        if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
        if (options.nodeId) { clauses.push("node_id = ?"); values.push(options.nodeId); }
        if (!clauses.length) throw new Error("Generation log delete requires a scope");
        return Number(this.db.prepare(`DELETE FROM generation_logs WHERE ${clauses.join(" AND ")}`).run(...values).changes);
    }

    /**
     * 取一个 H3 节点的运行历史产物（按时间倒序、按 url 去重）。
     * 不返回 sourcePrompt——体积大、用途窄；要看 prompt 用 listGenerationLogs({ nodeId })。
     * 替代老的 metadata.materials 数组（迁移 v4 起停摆）。
     *
     * @param segmentId 可选；仅返回该片段的历史。
     */
    getH3NodeMaterials(projectId: string, nodeId: string, limit = 200, segmentId?: string): Array<{ url: string; storageKey?: string; mimeType?: string; width?: number | null; height?: number | null; name?: string; segmentId?: string; createdAt: string }> {
        const clauses = ["project_id = ?", "node_id = ?"];
        const values: Array<string | number> = [projectId, nodeId];
        if (segmentId) { clauses.push("segment_id = ?"); values.push(segmentId); }
        const safeLimit = Math.max(1, Math.min(500, limit));
        const rows = this.db.prepare(
            `SELECT segment_id, outputs_json, created_at
             FROM generation_logs
             WHERE ${clauses.join(" AND ")}
             ORDER BY created_at DESC
             LIMIT ?`
        ).all(...values, safeLimit) as Array<{ segment_id: string | null; outputs_json: string; created_at: string }>;
        const seen = new Set<string>();
        const out: Array<{ url: string; storageKey?: string; mimeType?: string; width?: number | null; height?: number | null; name?: string; segmentId?: string; createdAt: string }> = [];
        for (const row of rows) {
            let outputs: unknown;
            try { outputs = JSON.parse(row.outputs_json); } catch { continue; }
            if (!Array.isArray(outputs)) continue;
            for (const item of outputs) {
                if (!item || typeof item !== "object") continue;
                const o = item as Record<string, unknown>;
                const url = String(o.url || o.video_url || "");
                if (!url || seen.has(url)) continue;
                seen.add(url);
                out.push({
                    url,
                    storageKey: o.storageKey ? String(o.storageKey) : undefined,
                    mimeType: o.mimeType ? String(o.mimeType) : undefined,
                    width: o.width != null ? Number(o.width) : null,
                    height: o.height != null ? Number(o.height) : null,
                    name: o.name ? String(o.name) : undefined,
                    segmentId: row.segment_id || undefined,
                    createdAt: row.created_at,
                });
            }
        }
        const project = this.getCanvasProject(projectId);
        const node = (project?.nodes as Array<Record<string, any>> | undefined)?.find(item => String(item.id) === nodeId);
        const segments = Array.isArray(node?.metadata?.segments) ? node!.metadata.segments as Array<Record<string, any>> : [];
        for (const segment of segments) {
            const targetSegmentId = String(segment.id || "");
            if (segmentId && targetSegmentId !== segmentId) continue;
            const origin = segment.archivedResultOrigin && typeof segment.archivedResultOrigin === "object" && !Array.isArray(segment.archivedResultOrigin)
                ? segment.archivedResultOrigin as Record<string, unknown> : undefined;
            if (!origin) continue;
            const sourceNodeId = String(origin.sourceNodeId || ""), sourceSegmentId = String(origin.sourceSegmentId || "");
            const storageKey = String(origin.storageKey || ""), logId = String(origin.generationLogId || "");
            if (!sourceNodeId || !sourceSegmentId || !storageKey || !logId) continue;
            const log = this.getGenerationLog(logId);
            if (!log || log.projectId !== projectId || log.nodeId !== sourceNodeId || log.segmentId !== sourceSegmentId || log.status !== "success") continue;
            const output = log.outputs.find(item => item.storageKey === storageKey && String(item.mimeType || "video/mp4").startsWith("video/"));
            const media = this.getMediaFile(storageKey);
            if (!output || !media || !fs.existsSync(media.filePath)) continue;
            const url = String(output.url || output.video_url || `/media/${encodeURIComponent(storageKey)}`);
            if (seen.has(url)) continue;
            seen.add(url);
            out.push({ url, storageKey, mimeType: String(output.mimeType || media.mimeType), width: media.width || 0, height: media.height || 0,
                name: String(output.name || output.filename || ""), segmentId: targetSegmentId, createdAt: log.finishedAt || log.startedAt });
        }
        out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return out.slice(0, safeLimit);
    }

    // ── MCP observability ─────────────────────────────────────────────────

    createMcpObservabilityEvent(input: McpObservabilityEventInput): McpObservabilityEvent {
        const event: McpObservabilityEvent = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
        this.db.prepare(`
            INSERT INTO mcp_observability_events (
                id, session_id, trace_id, event, tool, project_id, node_id, operation_id, task_id,
                duration_ms, error_code, recoverable, suggested_tool, input_summary_json, output_summary_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            event.id, event.sessionId, event.traceId, event.event, event.tool,
            event.projectId || null, event.nodeId || null, event.operationId || null, event.taskId || null,
            event.durationMs == null ? null : Math.max(0, Math.round(event.durationMs)), event.errorCode || null,
            event.recoverable == null ? null : event.recoverable ? 1 : 0, event.suggestedTool || null,
            JSON.stringify(event.inputSummary || {}), JSON.stringify(event.outputSummary || {}), event.createdAt,
        );
        return event;
    }

    listMcpObservabilityEvents(traceId: string): McpObservabilityEvent[] {
        const rows = this.db.prepare("SELECT * FROM mcp_observability_events WHERE trace_id = ? ORDER BY created_at, id").all(traceId) as Array<Record<string, unknown>>;
        return rows.map(mcpObservabilityEventFromRow);
    }

    listMcpOptimizationMarkers() {
        const value = this.getSetting("mcp.optimizationMarkers");
        return Array.isArray(value) ? value : [];
    }

    saveMcpOptimizationMarker(input: { at?: string; label?: string }) {
        const at = new Date(input.at || Date.now());
        if (!Number.isFinite(at.getTime())) throw new Error("优化标记时间无效");
        const label = String(input.label || "").trim() || "MCP 优化";
        const current = this.listMcpOptimizationMarkers().filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
        const marker = { id: crypto.randomUUID(), at: at.toISOString(), label: label.slice(0, 120), createdAt: new Date().toISOString() };
        this.setSetting("mcp.optimizationMarkers", [...current, marker].sort((left, right) => String(left.at).localeCompare(String(right.at))));
        return marker;
    }

    deleteMcpOptimizationMarker(id: string) {
        const existing = this.listMcpOptimizationMarkers();
        const current = existing.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).id !== id) as unknown[];
        if (current.length === existing.length) return false;
        this.setSetting("mcp.optimizationMarkers", current);
        return true;
    }

    getMcpObservabilityReport(options: McpObservabilityReportOptions = {}) {
        const dateFilter = mcpObservabilityDateFilter(options);
        const totals = this.db.prepare(`
            SELECT
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') THEN json_extract(input_summary_json,'$.inputBytes') END) AS total_input_bytes,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') THEN json_extract(output_summary_json,'$.outputBytes') END) AS total_output_bytes,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') AND json_extract(input_summary_json,'$.inputBytes') IS NOT NULL THEN 1 ELSE 0 END) AS input_byte_sized_calls,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') AND json_extract(output_summary_json,'$.outputBytes') IS NOT NULL THEN 1 ELSE 0 END) AS output_byte_sized_calls,
                SUM(CASE WHEN event = 'tool.started' THEN 1 ELSE 0 END) AS started,
                SUM(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN event = 'tool.succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN event = 'tool.failed' THEN 1 ELSE 0 END) AS failed,
                AVG(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN duration_ms END) AS average_duration_ms,
                MAX(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN duration_ms END) AS max_duration_ms,
                SUM(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN json_extract(output_summary_json, '$.outputChars') ELSE 0 END) AS total_output_chars,
                MAX(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN json_extract(output_summary_json, '$.outputChars') END) AS max_output_chars,
                SUM(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN json_extract(input_summary_json, '$.inputChars') ELSE 0 END) AS total_input_chars,
                MAX(CASE WHEN event IN ('tool.succeeded', 'tool.failed') THEN json_extract(input_summary_json, '$.inputChars') END) AS max_input_chars,
                SUM(CASE WHEN event IN ('tool.succeeded', 'tool.failed') AND json_extract(output_summary_json, '$.outputChars') IS NOT NULL THEN 1 ELSE 0 END) AS output_sized_calls,
                SUM(CASE WHEN event IN ('tool.succeeded', 'tool.failed') AND json_extract(input_summary_json, '$.inputChars') IS NOT NULL THEN 1 ELSE 0 END) AS input_sized_calls,
                SUM(CASE WHEN event IN ('tool.succeeded', 'tool.failed') AND json_extract(output_summary_json, '$.outputChars') >= 100000 THEN 1 ELSE 0 END) AS oversized_calls
            FROM mcp_observability_events
            ${dateFilter.whereWhere}
        `).get(...dateFilter.params) as Record<string, unknown>;
        const byTool = this.db.prepare(`
            WITH terminal AS (
                SELECT *,
                    ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms) AS duration_rank,
                    COUNT(*) OVER (PARTITION BY tool) AS tool_count
                FROM mcp_observability_events
                WHERE event IN ('tool.succeeded', 'tool.failed')
                  ${dateFilter.where}
            )
            SELECT tool,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') THEN json_extract(input_summary_json,'$.inputBytes') END) AS total_input_bytes,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') THEN json_extract(output_summary_json,'$.outputBytes') END) AS total_output_bytes,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') AND json_extract(input_summary_json,'$.inputBytes') IS NOT NULL THEN 1 ELSE 0 END) AS input_byte_sized_calls,
                SUM(CASE WHEN event IN ('tool.succeeded','tool.failed') AND json_extract(output_summary_json,'$.outputBytes') IS NOT NULL THEN 1 ELSE 0 END) AS output_byte_sized_calls,
                COUNT(*) AS calls,
                SUM(CASE WHEN event = 'tool.succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN event = 'tool.failed' THEN 1 ELSE 0 END) AS failed,
                AVG(duration_ms) AS average_duration_ms,
                MAX(duration_ms) AS max_duration_ms,
                MAX(CASE WHEN duration_rank = CAST((tool_count * 95 + 99) / 100 AS INTEGER) THEN duration_ms END) AS p95_duration_ms,
                SUM(CASE WHEN json_extract(input_summary_json, '$.inputChars') IS NOT NULL OR json_extract(output_summary_json, '$.outputChars') IS NOT NULL THEN 1 ELSE 0 END) AS sized_calls,
                SUM(CASE WHEN json_extract(output_summary_json, '$.outputChars') IS NOT NULL THEN 1 ELSE 0 END) AS output_sized_calls,
                SUM(CASE WHEN json_extract(input_summary_json, '$.inputChars') IS NOT NULL THEN 1 ELSE 0 END) AS input_sized_calls,
                MAX(json_extract(output_summary_json, '$.outputChars')) AS max_output_chars,
                SUM(json_extract(output_summary_json, '$.outputChars')) AS total_output_chars,
                MAX(json_extract(input_summary_json, '$.inputChars')) AS max_input_chars,
                SUM(json_extract(input_summary_json, '$.inputChars')) AS total_input_chars
            FROM terminal
            GROUP BY tool ORDER BY calls DESC, tool
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const errors = this.db.prepare(`
            SELECT error_code AS code, COUNT(*) AS count
            FROM mcp_observability_events
            WHERE event = 'tool.failed' AND error_code IS NOT NULL
              ${dateFilter.where}
            GROUP BY error_code ORDER BY count DESC, error_code
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const taskObservationEvents = this.db.prepare(`
            SELECT tool, task_id, event, output_summary_json, created_at, id
            FROM mcp_observability_events
            WHERE event IN ('tool.succeeded', 'tool.failed')
              AND (task_id IS NOT NULL OR output_summary_json != '{}')
              ${dateFilter.where}
            ORDER BY created_at, id
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const observedTasks = collectObservedTaskLinks(taskObservationEvents);
        const taskStatusQuery = this.db.prepare("SELECT status, error FROM tasks WHERE id = ?");
        const taskStatusesByStatus = new Map<string, number>();
        const taskOutcomesByToolMap = new Map<string, number>();
        const taskFailureCategories = new Map<string, number>();
        for (const link of observedTasks.links) {
            const row = taskStatusQuery.get(link.taskId) as { status?: unknown; error?: unknown } | undefined;
            const status = String(row?.status || "missing");
            taskStatusesByStatus.set(status, (taskStatusesByStatus.get(status) || 0) + 1);
            const key = `${link.tool}\u0000${status}`;
            taskOutcomesByToolMap.set(key, (taskOutcomesByToolMap.get(key) || 0) + 1);
            if (["failed", "cancelled", "missing"].includes(status)) {
                const category = status === "missing" ? "TASK_MISSING" : status === "cancelled" ? "TASK_CANCELLED" : structuredTaskErrorCode(row?.error) || "TASK_FAILED_UNCLASSIFIED";
                const failureKey = `${link.tool}\u0000${category}`;
                taskFailureCategories.set(failureKey, (taskFailureCategories.get(failureKey) || 0) + 1);
            }
        }
        const recovery = this.db.prepare(`
            WITH terminal AS (
                SELECT session_id, event, tool, suggested_tool, created_at, id,
                    LEAD(event) OVER (PARTITION BY session_id ORDER BY created_at, id) AS next_event,
                    LEAD(tool) OVER (PARTITION BY session_id ORDER BY created_at, id) AS next_tool
                FROM mcp_observability_events
                WHERE event IN ('tool.succeeded', 'tool.failed')
                  ${dateFilter.where}
            )
            SELECT COUNT(*) AS suggested,
                SUM(CASE WHEN next_tool = suggested_tool THEN 1 ELSE 0 END) AS followed,
                SUM(CASE WHEN next_event = 'tool.succeeded' AND next_tool = suggested_tool THEN 1 ELSE 0 END) AS succeeded
            FROM terminal WHERE event = 'tool.failed' AND suggested_tool IS NOT NULL
        `).get(...dateFilter.params) as Record<string, unknown>;
        const sessions = this.db.prepare(`
            SELECT COUNT(*) AS total, AVG(calls) AS average_calls, MAX(calls) AS max_calls
            FROM (
                SELECT session_id, COUNT(*) AS calls
                FROM mcp_observability_events
                WHERE event IN ('tool.succeeded', 'tool.failed')
                  ${dateFilter.where}
                GROUP BY session_id
            )
        `).get(...dateFilter.params) as Record<string, unknown>;
        const terminalDurationRows = this.db.prepare(`
            SELECT tool, duration_ms, output_summary_json
            FROM mcp_observability_events
            WHERE event IN ('tool.succeeded', 'tool.failed') AND duration_ms IS NOT NULL
              ${dateFilter.where}
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const allLatency = summarizeDurations(terminalDurationRows);
        const ordinaryLatency = summarizeDurations(terminalDurationRows.filter((row) => !waitsForTasks(row.output_summary_json, row.tool)));
        const waitingLatency = summarizeDurations(terminalDurationRows.filter((row) => waitsForTasks(row.output_summary_json, row.tool)));
        const ordinaryByTool = new Map<string, Array<Record<string, unknown>>>();
        for (const row of terminalDurationRows) {
            if (waitsForTasks(row.output_summary_json, row.tool)) continue;
            const tool = String(row.tool || "");
            const rows = ordinaryByTool.get(tool) || [];
            rows.push(row);
            ordinaryByTool.set(tool, rows);
        }
        const daily = this.db.prepare(`
            SELECT date(created_at, 'localtime') AS date,
                COUNT(*) AS calls,
                SUM(CASE WHEN event = 'tool.succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN event = 'tool.failed' THEN 1 ELSE 0 END) AS failed,
                AVG(duration_ms) AS average_duration_ms,
                AVG(CASE WHEN json_extract(output_summary_json, '$.outputChars') IS NOT NULL THEN json_extract(output_summary_json, '$.outputChars') END) AS average_output_chars
            FROM mcp_observability_events
            WHERE event IN ('tool.succeeded', 'tool.failed')
              ${dateFilter.where}
            GROUP BY date(created_at, 'localtime') ORDER BY date
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const dailyByTool = this.db.prepare(`
            SELECT date(created_at, 'localtime') AS date, tool,
                COUNT(*) AS calls,
                SUM(CASE WHEN event = 'tool.succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN event = 'tool.failed' THEN 1 ELSE 0 END) AS failed,
                AVG(duration_ms) AS average_duration_ms,
                AVG(CASE WHEN json_extract(output_summary_json, '$.outputChars') IS NOT NULL THEN json_extract(output_summary_json, '$.outputChars') END) AS average_output_chars
            FROM mcp_observability_events
            WHERE event IN ('tool.succeeded', 'tool.failed')
              ${dateFilter.where}
            GROUP BY date(created_at, 'localtime'), tool
            ORDER BY date, tool
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const failuresByTool = this.db.prepare(`
            SELECT tool, COALESCE(error_code, 'UNKNOWN') AS code, COUNT(*) AS count,
                (
                    SELECT latest.trace_id
                    FROM mcp_observability_events AS latest
                    WHERE latest.event = 'tool.failed'
                      AND latest.tool = events.tool
                      AND COALESCE(latest.error_code, 'UNKNOWN') = COALESCE(events.error_code, 'UNKNOWN')
                      ${dateFilter.where}
                    ORDER BY latest.created_at DESC, latest.id DESC
                    LIMIT 1
                ) AS latest_trace_id
            FROM mcp_observability_events AS events
            WHERE event = 'tool.failed'
              ${dateFilter.where}
            GROUP BY tool, COALESCE(error_code, 'UNKNOWN')
            ORDER BY count DESC, tool, code
        `).all(...dateFilter.params, ...dateFilter.params) as Array<Record<string, unknown>>;
        const transitions = this.db.prepare(`
            WITH terminal AS (
                SELECT session_id, tool,
                    LEAD(tool) OVER (PARTITION BY session_id ORDER BY created_at, id) AS next_tool
                FROM mcp_observability_events
                WHERE event IN ('tool.succeeded', 'tool.failed')
                  ${dateFilter.where}
            )
            SELECT tool AS from_tool, next_tool AS to_tool, COUNT(*) AS count
            FROM terminal
            WHERE next_tool IS NOT NULL
            GROUP BY tool, next_tool
            ORDER BY count DESC, from_tool, to_tool
        `).all(...dateFilter.params) as Array<Record<string, unknown>>;
        const taskOutcomesByTool = [...taskOutcomesByToolMap.entries()]
            .map(([key, count]) => {
                const [tool, status] = key.split("\u0000");
                return { tool, status, count };
            })
            .sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool) || left.status.localeCompare(right.status));
        const started = Number(totals.started || 0);
        const completed = Number(totals.completed || 0);
        const succeeded = Number(totals.succeeded || 0);
        const recoverySuggested = Number(recovery.suggested || 0);
        const recoveryFollowed = Number(recovery.followed || 0);
        const recoverySucceeded = Number(recovery.succeeded || 0);
        const toolMetrics = byTool.map((row) => metricRow({
            ...row,
            ordinary_p95_duration_ms: ordinaryByTool.has(String(row.tool || ""))
                ? summarizeDurations(ordinaryByTool.get(String(row.tool || "")) || []).p95DurationMs
                : null,
        }));
        const dailyByToolMetrics = dailyByTool.map((row) => {
            const calls = Number(row.calls || 0);
            const succeeded = Number(row.succeeded || 0);
            return {
                date: String(row.date || ""),
                tool: String(row.tool || ""),
                calls,
                succeeded,
                failed: Number(row.failed || 0),
                successRate: calls ? succeeded / calls : null,
                averageDurationMs: row.average_duration_ms == null ? null : Math.round(Number(row.average_duration_ms)),
                averageOutputChars: row.average_output_chars == null ? null : Math.round(Number(row.average_output_chars)),
            };
        });
        const taskOutcomeMetrics = taskOutcomesByTool.map((row) => ({ tool: String(row.tool || ""), status: String(row.status || "unknown"), count: Number(row.count || 0) }));
        // 单次返回体超过该字符数即视为「会显著占用模型上下文」。实测 canvas_get_state 单次
        // 可达 2.2M 字符（≈55 万 tokens），阈值取 100k 字符以覆盖严重情形而不误报普通工具。
        const payloadWarnChars = 100_000;
        const oversizedCalls = Number(totals.oversized_calls || 0);
        const payloadTotals = {
            outputSizedCalls: Number(totals.output_sized_calls || 0),
            inputSizedCalls: Number(totals.input_sized_calls || 0),
            totalInputChars: Number(totals.total_input_chars || 0),
            totalOutputChars: Number(totals.total_output_chars || 0),
            maxOutputChars: totals.max_output_chars == null ? null : Number(totals.max_output_chars),
            maxInputChars: totals.max_input_chars == null ? null : Number(totals.max_input_chars),
        };
        const diagnostics = buildMcpObservabilityDiagnostics({
            started,
            completed,
            succeeded,
            failed: Number(totals.failed || 0),
            p95DurationMs: allLatency.p95DurationMs,
            recoverySuggested,
            recoveryFollowed,
            recoverySucceeded,
            tools: toolMetrics,
            taskOutcomes: taskOutcomeMetrics,
            payloadWarnChars,
            oversizedCalls,
        });
        return {
            generatedAt: new Date().toISOString(),
            efficiency: mcpEfficiencyReport(this.db, dateFilter, options.view === "full"),
            calls: {
                started,
                completed,
                incomplete: Math.max(0, started - completed),
                succeeded,
                failed: Number(totals.failed || 0),
                successRate: completed ? succeeded / completed : null,
                averageDurationMs: totals.average_duration_ms == null ? null : Math.round(Number(totals.average_duration_ms)),
                maxDurationMs: totals.max_duration_ms == null ? null : Number(totals.max_duration_ms),
                p95DurationMs: allLatency.p95DurationMs,
            },
            sessions: {
                total: Number(sessions.total || 0),
                averageCalls: sessions.average_calls == null ? null : Number(Number(sessions.average_calls).toFixed(1)),
                maxCalls: Number(sessions.max_calls || 0),
            },
            recovery: {
                suggested: recoverySuggested,
                followed: recoveryFollowed,
                succeeded: recoverySucceeded,
                followRate: recoverySuggested ? recoveryFollowed / recoverySuggested : null,
                successRate: recoverySuggested ? recoverySucceeded / recoverySuggested : null,
                followedSuccessRate: recoveryFollowed ? recoverySucceeded / recoveryFollowed : null,
                observation: "same_session_adjacent_terminal_call",
            },
            byTool: toolMetrics,
            errors: errors.map((row) => ({ code: String(row.code || "UNKNOWN"), count: Number(row.count || 0) })),
            failuresByTool: failuresByTool.map((row) => ({ tool: String(row.tool || ""), code: String(row.code || "UNKNOWN"), count: Number(row.count || 0), latestTraceId: row.latest_trace_id ? String(row.latest_trace_id) : undefined })),
            taskStatuses: [...taskStatusesByStatus.entries()].map(([status, count]) => ({ status, count })).sort((left, right) => right.count - left.count || left.status.localeCompare(right.status)),
            taskOutcomesByTool: taskOutcomeMetrics,
            taskFailureCategories: [...taskFailureCategories.entries()].map(([key, count]) => { const [tool, category] = key.split("\u0000"); return { tool, category, count }; }).sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool) || left.category.localeCompare(right.category)),
            taskAssociation: {
                incomplete: observedTasks.incomplete,
                note: observedTasks.incomplete
                    ? "部分历史事件只保存了任务数量，未保存全部 taskId；相关任务统计可能不完整。"
                    : "当前任务统计按创建工具和去重后的 taskId 计算。",
            },
            latency: {
                ordinary: ordinaryLatency,
                waiting: waitingLatency,
            },
            // MCP 输入/输出大小统计：字符数为序列化后的长度，token 为 4 字符≈1 token 的粗估。
            payload: {
                outputSizedCalls: payloadTotals.outputSizedCalls,
                inputSizedCalls: payloadTotals.inputSizedCalls,
                totalInputChars: payloadTotals.totalInputChars,
                totalOutputChars: payloadTotals.totalOutputChars,
                totalInputBytes: totals.total_input_bytes == null ? null : Number(totals.total_input_bytes),
                totalOutputBytes: totals.total_output_bytes == null ? null : Number(totals.total_output_bytes),
                inputByteSizedCalls: Number(totals.input_byte_sized_calls || 0),
                outputByteSizedCalls: Number(totals.output_byte_sized_calls || 0),
                estimatedTotalInputTokens: Math.round(payloadTotals.totalInputChars / 4),
                estimatedTotalOutputTokens: Math.round(payloadTotals.totalOutputChars / 4),
                averageOutputChars: payloadTotals.outputSizedCalls ? Math.round(payloadTotals.totalOutputChars / payloadTotals.outputSizedCalls) : null,
                maxOutputChars: payloadTotals.maxOutputChars,
                maxOutputTokens: payloadTotals.maxOutputChars == null ? null : Math.round(payloadTotals.maxOutputChars / 4),
                maxInputChars: payloadTotals.maxInputChars,
                warnThresholdChars: payloadWarnChars,
                oversizedCalls,
                note: "仅统计已记录 inputSummary/outputSummary 的调用；早期事件缺少尺寸字段时不参与均值计算。",
            },
            ...(options.view === "full" ? { transitions: transitions.map((row) => ({ fromTool: String(row.from_tool || ""), toTool: String(row.to_tool || ""), count: Number(row.count || 0) })) } : {}),
            ...(options.view === "full" ? { daily: daily.map((row) => {
                const calls = Number(row.calls || 0);
                const dailySucceeded = Number(row.succeeded || 0);
                return {
                    date: String(row.date || ""),
                    calls,
                    succeeded: dailySucceeded,
                    failed: Number(row.failed || 0),
                    successRate: calls ? dailySucceeded / calls : null,
                    averageDurationMs: row.average_duration_ms == null ? null : Math.round(Number(row.average_duration_ms)),
                    averageOutputChars: row.average_output_chars == null ? null : Math.round(Number(row.average_output_chars)),
                };
            }) } : {}),
            ...(options.view === "full" ? { dailyByTool: dailyByToolMetrics } : {}),
            filters: {
                from: options.from || null,
                to: options.to || null,
                tool: options.tool || null,
                view: options.view || "summary",
            },
            diagnostics,
        };
    }

    // ── task history tombstones ───────────────────────────────────────────

    /** 查询已清理任务 ID 的凭据；不存在返回 null。 */
    getTaskTombstone(taskId: string): { taskId: string; kind: string; terminalStatus: string; createdAt: string; terminalAt: string; prunedAt: string; policyVersion: number } | null {
        const row = this.db.prepare(
            "SELECT task_id, kind, terminal_status, created_at, terminal_at, pruned_at, policy_version FROM task_history_tombstones WHERE task_id = ?"
        ).get(taskId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            taskId: String(row.task_id),
            kind: String(row.kind),
            terminalStatus: String(row.terminal_status),
            createdAt: String(row.created_at),
            terminalAt: String(row.terminal_at),
            prunedAt: String(row.pruned_at),
            policyVersion: Number(row.policy_version),
        };
    }

    /**
     * 记录已清理任务 ID 的凭据（幂等）。在任务族删除事务内、删除任务之前调用。
     * 凭据永久保留：不关联 tasks FK、不按 TTL 删除。
     */
    recordTaskTombstone(taskId: string, kind: string, terminalStatus: string, createdAt: string, terminalAt: string, policyVersion: number): void {
        this.db.prepare(
            "INSERT INTO task_history_tombstones (task_id, kind, terminal_status, created_at, terminal_at, pruned_at, policy_version) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(task_id) DO UPDATE SET terminal_status = excluded.terminal_status, pruned_at = excluded.pruned_at, policy_version = excluded.policy_version"
        ).run(taskId, kind, terminalStatus, createdAt, terminalAt, new Date().toISOString(), policyVersion);
    }

    // ── tasks ─────────────────────────────────────────────────────────────

    createTask(idOrKind: string, inputOrKindOrInput?: string | Record<string, unknown>, paramsOrInput?: Record<string, unknown>, paramsOrParams?: Record<string, unknown>): RuntimeTask {
        // 兼容两种调用：
        //   createTask(kind, input, params)
        //   createTask(id, kind, input, params) — 客户端预生成 taskId 用于「前端能跨刷新
        //   跨进程找回任务」，避免 onTaskId 回调还没写盘时用户刷新导致任务 ID 丢失。
        let id: string;
        let kind: string;
        let input: Record<string, unknown>;
        let params: Record<string, unknown>;
        if (paramsOrParams !== undefined) {
            id = idOrKind;
            kind = inputOrKindOrInput as string;
            input = (paramsOrInput as Record<string, unknown>) || {};
            params = paramsOrParams;
            if (!/^[A-Za-z0-9._:\-]{1,128}$/.test(id)) throw new Error(`Invalid clientTaskId: ${id}`);
        } else {
            kind = idOrKind;
            input = (inputOrKindOrInput as Record<string, unknown>) || {};
            params = paramsOrInput || {};
            id = crypto.randomUUID();
        }
        const now = new Date().toISOString();
        try {
            const fields = taskSearchFields(kind, input, params);
            this.db.prepare(
                "INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at, project_id, node_id, segment_id, model, is_image, is_video) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).run(id, kind, encodeStoredJson(input), encodeStoredJson(params), now, now, fields.projectId, fields.nodeId, fields.segmentId, fields.model, fields.isImage, fields.isVideo);
        } catch (error) {
            // 客户端传来的 id 已存在（重试 / 多标签）→ 直接复用该任务，让新请求接上同一行记录。
            const existing = this.getTask(id);
            if (existing) return existing;
            // id 不在 tasks 但存在于 tombstone → 该 ID 已被容量清理删除，
            // 不能当作不存在而新建同 ID（会重新执行/收费）。返回明确的历史不可用语义。
            const tombstone = this.getTaskTombstone(id);
            if (tombstone) {
                const err = new Error(`TASK_HISTORY_PRUNED: ${id}`);
                (err as unknown as { code: string; retryable: boolean }).code = "TASK_HISTORY_PRUNED";
                (err as unknown as { retryable: boolean }).retryable = false;
                throw err;
            }
            throw error;
        }
        return this.getTask(id)!;
    }

    updateTask(id: string, patch: { status?: RuntimeTaskStatus; progress?: number; result?: Record<string, unknown> | null; error?: string | null; executor?: string; params?: Record<string, unknown> }): RuntimeTask {
        const current = this.getTask(id);
        if (!current) throw new Error(`Task not found: ${id}`);
        const nextParams = patch.params || patch.executor
            ? { ...current.params, ...(patch.params || {}), ...(patch.executor ? { executor: patch.executor } : {}) }
            : current.params;
        const next = {
            ...current,
            ...patch,
            params: nextParams,
            updatedAt: new Date().toISOString(),
        };
        this.db.prepare(
            "UPDATE tasks SET status = ?, progress = ?, params_json = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?"
        ).run(
            next.status,
            Math.max(0, Math.min(1, next.progress)),
            encodeStoredJson(next.params),
            next.result == null ? null : JSON.stringify(next.result),
            next.error || null,
            next.updatedAt,
            id,
        );
        // 任务终态由多个入口写入（dispatcher、孤儿回收、运维清理）。在这里集中把仍挂在
        // running/queued 的生成日志收敛到同一终态，避免制作台队列一直显示假「运行中」。
        if (patch.status && next.status !== current.status) this.syncTerminalGenerationLogs(next);
        return this.getTask(id)!;
    }

    /** 任务进入终态时同步其关联且尚未终结的生成日志；已终结的日志不改写。 */
    private syncTerminalGenerationLogs(task: RuntimeTask): void {
        if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled") return;
        const rows = this.db.prepare(
            "SELECT id, started_at FROM generation_logs WHERE runtime_task_id=? AND status IN ('queued','running')"
        ).all(task.id) as Array<{ id: string; started_at: string | null }>;
        if (!rows.length) return;
        const status = task.status === "succeeded" ? "success" : task.status;
        const finishedAt = task.updatedAt || new Date().toISOString();
        const startedMs = rows.find(row => row.started_at)?.started_at || task.createdAt;
        const parsed = Date.parse(startedMs);
        const durationMs = Number.isFinite(parsed) ? Math.max(0, Date.parse(finishedAt) - parsed) : 0;
        const outputs = Array.isArray(task.outputs) && task.outputs.length ? task.outputs
            : Array.isArray(task.result?.media) ? task.result!.media as Array<Record<string, unknown>> : [];
        for (const row of rows) {
            this.updateGenerationLog(row.id, { status, finishedAt, durationMs, error: task.error || undefined, outputs });
        }
    }

    /** H3 决议与事件必须在同一个 SQLite 事务里落库；状态和版本共同构成 CAS。 */
    transitionH3Task(id: string, expectedStatus: RuntimeTaskStatus, expectedRevision: number, patch: { status: RuntimeTaskStatus; progress?: number; result: Record<string, unknown>; error?: string | null }, event: { type: string; payload: Record<string, unknown> }): RuntimeTask | null {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.getTask(id);
            const confirmation = current?.result?.confirmation;
            const revision = confirmation && typeof confirmation === "object" && !Array.isArray(confirmation)
                ? Number((confirmation as Record<string, unknown>).revision || 0) : 0;
            if (!current || current.kind !== "canvas-h3-run" || current.status !== expectedStatus || revision !== expectedRevision) {
                this.db.exec("ROLLBACK");
                return null;
            }
            const task = this.updateTask(id, patch);
            this.addTaskEvent(id, event.type, event.payload);
            this.addTaskEvent(id, `status:${patch.status}`, { taskId: id, status: patch.status });
            this.db.exec("COMMIT");
            return task;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    getTask(id: string): RuntimeTask | null {
        const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? this.taskFromRow(row) : null;
    }

    getTaskSequence(id: string): number | undefined {
        const row = this.db.prepare("SELECT rowid AS sequence FROM tasks WHERE id = ?").get(id) as { sequence?: number } | undefined;
        return row && Number.isSafeInteger(Number(row.sequence)) ? Number(row.sequence) : undefined;
    }

    /** 启动恢复只读取最新候选；已结束任务仅限仍被 H3 画布绑定或日志未收口。 */
    listStartupRecoveryTasks(boundH3ParentIds: string[], limit = 10): RuntimeTask[] {
        const rows = this.db.prepare(`
            SELECT t.* FROM tasks t
            WHERE t.status IN ('running', 'queued', 'awaiting_confirmation')
               OR (t.kind = 'canvas-h3-run'
                   AND t.status IN ('succeeded', 'failed', 'cancelled')
                   AND t.id IN (SELECT value FROM json_each(?)))
               OR (t.kind IN ('comfyui:minimax-h3', 'runninghub:minimax-h3', 'runninghub:workflow')
                   AND t.status IN ('succeeded', 'failed', 'cancelled')
                   AND EXISTS (
                       SELECT 1 FROM generation_logs l
                       WHERE l.id = json_extract(stored_json_text(t.params_json), '$.canvasBinding.generationLogId')
                         AND l.runtime_task_id = t.id
                         AND l.status IN ('queued', 'running')
                   ))
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?
        `).all(JSON.stringify(boundH3ParentIds), limit) as Array<Record<string, unknown>>;
        return rows.map((row) => this.taskFromRow(row));
    }

    private taskListWhere(filter: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; parentThreadId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number } = {}): { where: string; values: Array<string | number>; limit: number; offset: number } {
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (filter.status) { clauses.push("status = ?"); values.push(filter.status); }
        if (filter.kind) { clauses.push("kind = ?"); values.push(filter.kind); }
        if (filter.model) { clauses.push("model = ?"); values.push(filter.model); }
        if (filter.projectId) { clauses.push("project_id = ?"); values.push(filter.projectId); }
        if (filter.parentThreadId) { clauses.push(`json_extract(stored_json_text(input_json), '$.parentThreadId') = ?`); values.push(filter.parentThreadId); }
        if (filter.scope === "canvas") clauses.push("project_id IS NOT NULL");
        if (filter.scope === "image") clauses.push("is_image = 1");
        if (filter.scope === "video") clauses.push("is_video = 1");
        if (filter.nodeIds?.length) {
            clauses.push(`node_id IN (${filter.nodeIds.map(() => "?").join(",")})`);
            values.push(...filter.nodeIds.map(String));
        }
        if (filter.segmentIds?.length) {
            clauses.push(`segment_id IN (${filter.segmentIds.map(() => "?").join(",")})`);
            values.push(...filter.segmentIds.map(String));
        }
        return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values, limit: Math.max(1, Math.min(500, Number(filter.limit || 500))), offset: Math.max(0, Number(filter.offset || 0)) };
    }

    listTasks(filter: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; parentThreadId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number } = {}): RuntimeTask[] {
        const { where, values, limit, offset } = this.taskListWhere(filter);
        const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as Array<Record<string, unknown>>;
        return rows.map((row) => this.taskFromRow(row));
    }

    /** 在跑任务的轻量绑定索引：只读状态与节点/段身份，供引用段反查判断跳过，避免逐段解码大任务行。 */
    listActiveTaskBindings(): Array<{ projectId: string; nodeIds: string[]; segmentIds: string[] }> {
        const rows = this.db.prepare("SELECT project_id AS projectId, node_id AS nodeId, segment_id AS segmentId, input_json AS inputJson FROM tasks WHERE status IN ('queued', 'running', 'awaiting_confirmation')").all() as Array<Record<string, unknown>>;
        return rows.map((row) => {
            let input: Record<string, unknown> = {};
            if (row.inputJson != null) {
                try { const parsed = decodeStoredJson<unknown>(row.inputJson); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>; } catch { /* 坏行不阻断反查 */ }
            }
            const ids = (value: unknown) => value === undefined || value === null ? [] : [String(value)];
            return {
                projectId: String(row.projectId || ""),
                nodeIds: [...new Set([...ids(row.nodeId), ...ids(input.nodeId)])],
                segmentIds: [...new Set([...ids(row.segmentId), ...ids(input.segmentId)])],
            };
        });
    }

    listCanvasTaskModelUsage(): Array<{ model: string; channelId: string; count: number }> {
        // params_json / input_json 可能是旧 TEXT 或 gzip BLOB（大参数经 updateTask 压缩）。
        // 直接 json_extract(BLOB) 会让 SQLite 抛 malformed JSON，整个统计接口 500。
        return this.db.prepare(`SELECT model,
            COALESCE(
                NULLIF(CASE WHEN json_valid(params) THEN json_extract(params, '$.channelId') END, ''),
                NULLIF(CASE WHEN json_valid(input) THEN json_extract(input, '$.channelId') END, ''),
                ''
            ) AS channelId,
            COUNT(*) AS count
            FROM (
                SELECT model, stored_json_text(params_json) AS params, stored_json_text(input_json) AS input
                FROM tasks WHERE project_id IS NOT NULL AND model IS NOT NULL AND model != ''
            )
            GROUP BY model, channelId`).all() as Array<{ model: string; channelId: string; count: number }>;
    }

    /**
     * 任务列表「摘要」投影：只保留卡片渲染所需标量 + 输出媒体引用，裁掉多 MB 的 input/params 大列。
     * 供首页、全局任务按钮、制作工作台等纯展示场景用；导出、任务中心和单任务详情仍走 list()。
     * 返回值在结构上就是合法的 RuntimeTask（重字段均为可选），可直接复用前端类型。
     */
    listTaskSummaries(filter: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; parentThreadId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number } = {}): RuntimeTask[] {
        const { where, values, limit, offset } = this.taskListWhere(filter);
        // Page before decoding. Extract routing fields in SQLite so large workflow snapshots
        // never become JavaScript object graphs during task-list polling.
        const rows = this.db.prepare(`WITH page AS MATERIALIZED (
            SELECT id, kind, status, progress, error, created_at, updated_at, project_id, node_id, segment_id, model,
            CASE WHEN json_valid(stored_json_text(params_json)) THEN json_extract(stored_json_text(params_json), '$.parentTaskId') END AS parent_task_id,
            input_json, result_json FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
        ) SELECT id, kind, status, progress, error, created_at, updated_at, project_id, node_id, segment_id, model,
            parent_task_id, result_json,
            CASE WHEN typeof(input_json) = 'blob' THEN json_extract(stored_json_text(input_json), '$.projectId', '$.scope')
                WHEN json_valid(input_json) THEN json_extract(input_json, '$.projectId', '$.scope')
                ELSE '[null,null]' END AS input_summary_json
            FROM page ORDER BY created_at DESC, id DESC`).all(...values, limit, offset) as Array<Record<string, unknown>>;
        return rows.map((row) => {
            const [projectId, scope] = JSON.parse(String(row.input_summary_json)) as unknown[];
            const inputScope = typeof scope === "string" && scope ? scope : undefined;
            const inputProjectId = typeof projectId === "string" && projectId ? projectId : undefined;
            const result = row.result_json ? parseJsonObject(row.result_json) : null;
            const outputs = result && Array.isArray(result.media)
                ? (result.media as Array<Record<string, unknown>>).filter((item) => item && typeof item === "object")
                : result && Array.isArray(result.images)
                    ? (result.images as Array<Record<string, unknown>>).filter((item) => item && typeof item === "object")
                    : [];
            // 文本结果体积小且是首页对话工作台/任务中心的唯一展示内容，摘要保留；
            // prompt/params 等大字段仍不入响应体。
            const texts = result && Array.isArray(result.texts) ? result.texts : [];
            const kind = String(row.kind);
            return {
                id: String(row.id), kind,
                status: String(row.status) as RuntimeTaskStatus,
                progress: Number(row.progress),
                // projectId 用反范式列（创建时已按 input||params||binding 归一化），缺失再退回 input.projectId。
                projectId: String(row.project_id || "") || inputProjectId || undefined,
                nodeId: String(row.node_id || "") || undefined,
                segmentId: String(row.segment_id || "") || undefined,
                model: String(row.model || "") || undefined,
                parentTaskId: String(row.parent_task_id || "") || undefined,
                executor: kind.startsWith("comfyui:") ? "comfy" : kind,
                // 只回传路由所需的两个标量，prompt/params 等大字段不入响应体。
                // RuntimeTask 的 input/params/result 必填：摘要里是空值占位（不是缺失数据），
                // 完整原文仍从 listTasks / getTask 获取。
                input: inputProjectId || inputScope ? { ...(inputProjectId ? { projectId: inputProjectId } : {}), ...(inputScope ? { scope: inputScope } : {}) } : {},
                params: {},
                result: texts.length ? { texts } : null,
                outputs,
                error: row.error ? String(row.error) : null,
                createdAt: String(row.created_at),
                updatedAt: String(row.updated_at),
            };
        });
    }

    private taskFromRow(row: Record<string, unknown>): RuntimeTask {
        const input = parseJsonObject(row.input_json);
        const params = parseJsonObject(row.params_json);
        // 插件文本等调用把归属节点/Clip 放在 input.params 里（顶层 nodeId 会触发画布回写绑定，不能放）
        const inputParams = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {};
        const result = row.result_json ? parseJsonObject(row.result_json) : null;
        const binding = params.canvasBinding && typeof params.canvasBinding === "object" && !Array.isArray(params.canvasBinding)
            ? params.canvasBinding as Record<string, unknown> : {};
        const outputs = result && Array.isArray(result.media) ? result.media.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>
            : result && Array.isArray(result.images) ? result.images.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
        return {
            id: String(row.id), kind: String(row.kind),
            status: String(row.status) as RuntimeTaskStatus,
            progress: Number(row.progress),
            input, params, result,
            error: row.error ? String(row.error) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
            parentTaskId: String(params.parentTaskId || "") || undefined,
            projectId: String(input.projectId || params.projectId || binding.projectId || "") || undefined,
            nodeId: String(input.nodeId || inputParams.nodeId || params.nodeId || binding.nodeId || "") || undefined,
            segmentId: String(input.segmentId || inputParams.segmentId || params.segmentId || binding.segmentId || "") || undefined,
            executor: String(params.executor || (String(row.kind).startsWith("comfyui:") ? "comfy" : String(row.kind))) || undefined,
            model: String(params.model || params.modelName || input.model || "") || undefined,
            outputs,
        };
    }


    /**
     * 历史维护：把旧任务和生成日志中的内联媒体改成摘要。
     * 只修改 JSON 字段，不删除媒体文件，也不改变任务状态和业务关联。
     */
    redactLegacyInlineMedia() {
        let tasks = 0;
        let logs = 0;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const taskRows = this.db.prepare("SELECT id, input_json, params_json, result_json FROM tasks").all() as Array<Record<string, unknown>>;
            for (const row of taskRows) {
                const input = redactJsonColumn(row.input_json);
                const params = redactJsonColumn(row.params_json);
                const result = row.result_json == null ? null : redactJsonColumn(row.result_json);
                if (!input.changed && !params.changed && !result?.changed) continue;
                this.db.prepare("UPDATE tasks SET input_json = ?, params_json = ?, result_json = ? WHERE id = ?")
                    .run(input.changed ? encodeStoredJson(JSON.parse(input.json)) : row.input_json as StoredJson, params.json, result?.json ?? null, String(row.id));
                tasks++;
            }

            const logRows = this.db.prepare("SELECT id, references_json, params_json, outputs_json FROM generation_logs").all() as Array<Record<string, unknown>>;
            for (const row of logRows) {
                const references = redactJsonColumn(row.references_json);
                const params = redactJsonColumn(row.params_json);
                const outputs = redactJsonColumn(row.outputs_json);
                if (!references.changed && !params.changed && !outputs.changed) continue;
                this.db.prepare("UPDATE generation_logs SET references_json = ?, params_json = ?, outputs_json = ? WHERE id = ?")
                    .run(references.json, params.json, outputs.json, String(row.id));
                logs++;
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return { tasks, logs };
    }

    addTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): RuntimeTaskEvent {
        const createdAt = new Date().toISOString();
        const result = this.db.prepare(
            "INSERT INTO task_events (task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)"
        ).run(taskId, type, JSON.stringify(payload), createdAt) as { lastInsertRowid: number };
        return { id: Number(result.lastInsertRowid), taskId, type, payload, createdAt };
    }

    listTaskEvents(taskId: string, after = 0): RuntimeTaskEvent[] {
        const rows = this.db.prepare(
            "SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC"
        ).all(taskId, after) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
            id: Number(row.id), taskId: String(row.task_id), type: String(row.type),
            payload: parseJsonObject(row.payload_json), createdAt: String(row.created_at),
        }));
    }

    // ── runtime_settings ──────────────────────────────────────────────────

    getSetting(key: string): unknown {
        const row = this.db.prepare("SELECT value_json FROM runtime_settings WHERE key = ?").get(key) as { value_json?: string } | undefined;
        if (!row?.value_json) return undefined;
        try { return JSON.parse(row.value_json); } catch { return undefined; }
    }

    setSetting(key: string, value: unknown) {
        this.db.prepare(
            "INSERT INTO runtime_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at"
        ).run(key, JSON.stringify(value), new Date().toISOString());
    }

    deleteSetting(key: string) {
        this.db.prepare("DELETE FROM runtime_settings WHERE key = ?").run(key);
    }
}

function mcpObservabilityDateFilter(options: McpObservabilityReportOptions) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.from) {
        clauses.push("date(created_at, 'localtime') >= ?");
        params.push(options.from);
    }
    if (options.to) {
        clauses.push("date(created_at, 'localtime') <= ?");
        params.push(options.to);
    }
    if (options.tool) {
        clauses.push("tool = ?");
        params.push(options.tool);
    }
    return {
        where: clauses.length ? `AND ${clauses.join(" AND ")}` : "",
        whereWhere: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
        params,
    };
}

function redactJsonColumn(value: unknown) {
    const json = value instanceof Uint8Array ? storedJsonText(value) : String(value ?? "");
    if (!json) return { json, changed: false };
    try {
        const parsed = JSON.parse(json);
        const redacted = redactInlineMedia(parsed);
        const next = JSON.stringify(redacted);
        return { json: next, changed: next !== json };
    } catch {
        // 损坏 JSON 不在本次维护范围内，保留原值，避免扩大影响面。
        return { json, changed: false };
    }
}

/** 图片结果节点尺寸：收口到图片节点默认尺寸（340×240）包围盒并保持原始宽高比；无有效宽高时用默认尺寸。 */
function fitImageNodeSize(width: number, height: number) {
    if (!(width > 0) || !(height > 0)) return { width: 340, height: 240 };
    const scale = Math.min(1, 340 / width, 240 / height);
    return { width: width * scale, height: height * scale };
}

function canvasMediaSourceStatus(project: CanvasProject, nodeId: string, sourceNodeId: string | undefined, taskId: string, status: string): CanvasOperation[] {
    if (!sourceNodeId || sourceNodeId === nodeId) return [];
    const source = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === sourceNodeId) as Record<string, any> | undefined;
    if (source?.type !== "config" || source.metadata?.runtimeTaskId !== taskId) return [];
    return [{ type: "update_node", id: sourceNodeId, metadata: { status }, metadataDelete: ["runtimeTaskId", "errorDetails"] }];
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function assetFromRow(row: Record<string, unknown>): Asset {
    return {
        id: String(row.id),
        kind: String(row.kind),
        title: String(row.title),
        coverUrl: String(row.cover_url || ""),
        tags: parseJsonArray(row.tags_json) as string[],
        folderId: row.folder_id ? String(row.folder_id) : null,
        dramaId: row.drama_id ? String(row.drama_id) : null,
        data: parseJsonObject(row.data_json),
        note: row.note ? String(row.note) : null,
        source: row.source ? String(row.source) : null,
        metadata: parseJsonObject(row.metadata_json),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}

function mediaFromRow(row: Record<string, unknown>): MediaFile {
    return {
        storageKey: String(row.storage_key),
        filePath: String(row.file_path),
        mimeType: String(row.mime_type),
        bytes: Number(row.file_size),
        width: row.width != null ? Number(row.width) : null,
        height: row.height != null ? Number(row.height) : null,
        durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
        createdAt: String(row.created_at),
        ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
    };
}

function generationLogFromRow(row: Record<string, unknown>): GenerationLog {
    return {
        id: String(row.id),
        projectId: String(row.project_id),
        nodeId: row.node_id ? String(row.node_id) : undefined,
        segmentId: row.segment_id ? String(row.segment_id) : undefined,
        status: String(row.status) as GenerationLogStatus,
        platform: String(row.platform),
        source: (row.source ? String(row.source) : "pipeline") as GenerationLog["source"],
        workflow: row.workflow ? String(row.workflow) : undefined,
        model: row.model ? String(row.model) : undefined,
        taskMode: row.task_mode ? String(row.task_mode) : undefined,
        prompt: row.prompt ? String(row.prompt) : undefined,
        references: parseJsonArray(row.references_json) as Array<Record<string, unknown>>,
        inputCounts: Object.fromEntries(Object.entries(parseJsonObject(row.input_counts_json)).map(([key, value]) => [key, Number(value) || 0])),
        runtimeTaskId: row.runtime_task_id ? String(row.runtime_task_id) : undefined,
        promptId: row.prompt_id ? String(row.prompt_id) : undefined,
        startedAt: String(row.started_at),
        finishedAt: row.finished_at ? String(row.finished_at) : undefined,
        durationMs: Number(row.duration_ms || 0),
        outputs: parseJsonArray(row.outputs_json) as Array<Record<string, unknown>>,
        error: row.error ? String(row.error) : undefined,
        params: parseJsonObject(row.params_json),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}

function mcpObservabilityEventFromRow(row: Record<string, unknown>): McpObservabilityEvent {
    return {
        id: String(row.id),
        sessionId: String(row.session_id),
        traceId: String(row.trace_id),
        event: String(row.event) as McpObservabilityEvent["event"],
        tool: String(row.tool),
        projectId: row.project_id ? String(row.project_id) : undefined,
        nodeId: row.node_id ? String(row.node_id) : undefined,
        operationId: row.operation_id ? String(row.operation_id) : undefined,
        taskId: row.task_id ? String(row.task_id) : undefined,
        durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
        errorCode: row.error_code ? String(row.error_code) : undefined,
        recoverable: row.recoverable == null ? undefined : Number(row.recoverable) === 1,
        suggestedTool: row.suggested_tool ? String(row.suggested_tool) : undefined,
        inputSummary: parseJsonObject(row.input_summary_json),
        outputSummary: parseJsonObject(row.output_summary_json),
        createdAt: String(row.created_at),
    };
}

function waitsForTasks(value: unknown, tool?: unknown) {
    return String(tool || "") === "canvas_wait_tasks" || parseJsonObject(value).waitsForTasks === true;
}

function summarizeDurations(rows: Array<Record<string, unknown>>) {
    const values = rows
        .map((row) => Number(row.duration_ms))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
    if (!values.length)
        return {
            calls: 0,
            averageDurationMs: null as number | null,
            maxDurationMs: null as number | null,
            p95DurationMs: null as number | null,
        };
    return {
        calls: values.length,
        averageDurationMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        maxDurationMs: values[values.length - 1],
        p95DurationMs: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)],
    };
}

function collectObservedTaskLinks(rows: Array<Record<string, unknown>>) {
    const links = new Map<string, { taskId: string; tool: string }>();
    let incomplete = false;
    for (const row of rows) {
        const output = parseJsonObject(row.output_summary_json);
        const createdTaskIds = isTaskCreationTool(String(row.tool || "")) && Array.isArray(output.createdTaskIds)
            ? [...new Set(output.createdTaskIds.map(String).filter(Boolean))]
            : [];
        const scalarTaskId = isTaskCreationTool(String(row.tool || "")) && row.task_id ? String(row.task_id) : "";
        const taskIds = [...new Set([...createdTaskIds, ...(scalarTaskId ? [scalarTaskId] : [])])];
        const declaredCount = typeof output.taskCount === "number" ? output.taskCount : undefined;
        if (isTaskCreationTool(String(row.tool || "")) && declaredCount != null && declaredCount > taskIds.length)
            incomplete = true;
        for (const taskId of taskIds) {
            if (!links.has(taskId)) links.set(taskId, { taskId, tool: String(row.tool || "unknown") });
        }
    }
    return { links: [...links.values()], incomplete };
}

function isTaskCreationTool(tool: string) {
    return new Set(["canvas_generate_text", "canvas_generate_image", "canvas_generate_video", "canvas_generate_audio", "canvas_generate_image_batch", "canvas_run_generation"]).has(tool);
}

function structuredTaskErrorCode(error: unknown): string | undefined {
    if (typeof error !== "string" || !error) return undefined;
    try {
        const parsed = JSON.parse(error);
        const code = parsed && typeof parsed.code === "string" ? parsed.code : parsed && typeof parsed.errorCode === "string" ? parsed.errorCode : "";
        return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
    } catch { return undefined; }
}

function metricRow(row: Record<string, unknown>) {
    const calls = Number(row.calls || 0);
    const succeeded = Number(row.succeeded || 0);
    const maxOutputChars = row.max_output_chars == null ? null : Number(row.max_output_chars);
    const totalOutputChars = row.total_output_chars == null ? null : Number(row.total_output_chars);
    const maxInputChars = row.max_input_chars == null ? null : Number(row.max_input_chars);
    const totalInputChars = row.total_input_chars == null ? null : Number(row.total_input_chars);
    const sizedCalls = Number(row.sized_calls || 0);
    // 输出/入参均值各自用自己的分母：某次调用只记录了入参时，不应拉低返回体均值。
    const outputSizedCalls = Number(row.output_sized_calls || 0);
    const inputSizedCalls = Number(row.input_sized_calls || 0);
    return {
        tool: String(row.tool || ""),
        calls,
        succeeded,
        failed: Number(row.failed || 0),
        successRate: calls ? succeeded / calls : null,
        averageDurationMs: row.average_duration_ms == null ? null : Math.round(Number(row.average_duration_ms)),
        maxDurationMs: row.max_duration_ms == null ? null : Number(row.max_duration_ms),
        p95DurationMs: row.p95_duration_ms == null ? null : Number(row.p95_duration_ms),
        ordinaryP95DurationMs: row.ordinary_p95_duration_ms == null ? null : Number(row.ordinary_p95_duration_ms),
        // 载荷口径：均值只对已记录尺寸的调用求平均；历史事件缺 summary 时不参与，避免把均值算低。
        sizedCalls,
        averageOutputChars: outputSizedCalls && totalOutputChars != null ? Math.round(totalOutputChars / outputSizedCalls) : null,
        maxOutputChars,
        estimatedOutputTokens: maxOutputChars == null ? null : Math.round(maxOutputChars / 4),
        estimatedMaxOutputTokens: maxOutputChars == null ? null : Math.round(maxOutputChars / 4),
        estimatedTotalOutputTokens: totalOutputChars == null ? null : Math.round(totalOutputChars / 4),
        totalInputBytes: row.total_input_bytes == null ? null : Number(row.total_input_bytes),
        totalOutputBytes: row.total_output_bytes == null ? null : Number(row.total_output_bytes),
        inputByteSizedCalls: Number(row.input_byte_sized_calls || 0),
        outputByteSizedCalls: Number(row.output_byte_sized_calls || 0),
        averageInputChars: inputSizedCalls && totalInputChars != null ? Math.round(totalInputChars / inputSizedCalls) : null,
        maxInputChars,
    };
}

function buildMcpObservabilityDiagnostics(input: {
    started: number;
    completed: number;
    succeeded: number;
    failed: number;
    p95DurationMs: number | null;
    recoverySuggested: number;
    recoveryFollowed: number;
    recoverySucceeded: number;
    tools: Array<ReturnType<typeof metricRow>>;
    taskOutcomes: Array<{ tool: string; status: string; count: number }>;
    /** 单次返回体字符数阈值：超过即认为会显著占用模型上下文。 */
    payloadWarnChars: number;
    oversizedCalls: number;
}) {
    const diagnostics: Array<{ severity: "success" | "info" | "warning" | "error"; code: string; title: string; detail: string; tool?: string }> = [];
    const incomplete = Math.max(0, input.started - input.completed);
    if (!input.completed) {
        diagnostics.push({ severity: "info", code: "NO_DATA", title: "等待真实调用数据", detail: "完成几次 MCP 画布操作后，这里会自动给出针对性的优化建议。" });
        return diagnostics;
    }
    if (incomplete) diagnostics.push({ severity: "error", code: "INCOMPLETE_CALLS", title: "存在未闭合调用", detail: `${incomplete} 次调用只有 started 事件，优先检查进程中断、连接断开或未捕获异常。` });
    const successRate = input.succeeded / input.completed;
    if (successRate < 0.9) diagnostics.push({ severity: "warning", code: "LOW_SUCCESS_RATE", title: "整体成功率偏低", detail: `当前成功率 ${(successRate * 100).toFixed(1)}%，建议先处理数量最多的错误代码和失败工具。` });
    for (const tool of input.tools) {
        if (tool.calls >= 5 && tool.failed / tool.calls >= 0.2) diagnostics.push({ severity: "warning", code: "TOOL_FAILURE_HOTSPOT", title: `${tool.tool} 失败率偏高`, detail: `${tool.calls} 次调用中失败 ${tool.failed} 次，优先检查参数说明、前置状态与错误恢复建议。`, tool: tool.tool });
        if (tool.calls >= 5 && tool.ordinaryP95DurationMs != null && tool.ordinaryP95DurationMs > 5000) diagnostics.push({ severity: "warning", code: "TOOL_LATENCY_HOTSPOT", title: `${tool.tool} 尾延迟偏高`, detail: `普通调用 P95 为 ${tool.ordinaryP95DurationMs} ms，已排除任务等待耗时；建议检查远端读取或重复调用路径。`, tool: tool.tool });
        // 返回体过大会直接挤占模型上下文：给出「最大返回体」实证，而不是泛泛提示省 token。
        if (tool.maxOutputChars != null && tool.maxOutputChars >= input.payloadWarnChars) diagnostics.push({
            severity: "warning",
            code: "TOOL_PAYLOAD_HOTSPOT",
            title: `${tool.tool} 返回体过大`,
            detail: `最大一次返回约 ${tool.maxOutputChars.toLocaleString("en-US")} 字符（≈${Math.round(tool.maxOutputChars / 4).toLocaleString("en-US")} tokens，估算），均值约 ${(tool.averageOutputChars ?? 0).toLocaleString("en-US")} 字符。单次调用即可挤占可观的模型上下文，建议改用更小的返回体或摘要型工具。`,
            tool: tool.tool,
        });
    }
    if (input.oversizedCalls > 0) diagnostics.push({
        severity: input.oversizedCalls >= 10 ? "error" : "warning",
        code: "OVERSIZED_PAYLOAD_CALLS",
        title: "存在超大 MCP 返回体",
        detail: `累计 ${input.oversizedCalls} 次调用返回超过 ${input.payloadWarnChars.toLocaleString("en-US")} 字符；这类工具一次调用就可能挤爆模型上下文，优先改用摘要型替代工具。`,
    });
    const taskOutcomes = new Map<string, { total: number; failed: number }>();
    for (const outcome of input.taskOutcomes) {
        const metric = taskOutcomes.get(outcome.tool) || { total: 0, failed: 0 };
        if (!["queued", "running"].includes(outcome.status)) metric.total += outcome.count;
        if (["failed", "cancelled", "missing"].includes(outcome.status)) metric.failed += outcome.count;
        taskOutcomes.set(outcome.tool, metric);
    }
    for (const [tool, metric] of taskOutcomes) {
        if (metric.total >= 3 && metric.failed / metric.total >= 0.2) diagnostics.push({ severity: "warning", code: "TASK_OUTCOME_HOTSPOT", title: `${tool} 后续任务失败率偏高`, detail: `${metric.total} 个已结束任务中有 ${metric.failed} 个失败、取消或丢失；工具调用成功不代表生成结果成功，应优先检查执行器和任务回写。`, tool });
    }
    if (input.recoverySuggested >= 3 && input.recoveryFollowed === 0) diagnostics.push({ severity: "warning", code: "LOW_RECOVERY_RATE", title: "没有观察到恢复建议被采纳", detail: `${input.recoverySuggested} 次恢复建议在同一会话的相邻终态调用中没有采纳样本；请检查调用指引、会话连续性或客户端是否中断。` });
    else if (input.recoveryFollowed >= 3 && input.recoverySucceeded / input.recoveryFollowed < 0.5) diagnostics.push({ severity: "warning", code: "LOW_RECOVERY_RATE", title: "已采纳恢复建议成功率偏低", detail: `${input.recoveryFollowed} 次被采纳的恢复建议中仅 ${input.recoverySucceeded} 次成功，应调整 suggestedAction 或工具参数说明。` });
    if (!diagnostics.length) diagnostics.push({ severity: "success", code: "HEALTHY", title: "当前 MCP 调用健康", detail: `已完成 ${input.completed} 次调用，未发现明显失败热点、未闭合调用或高尾延迟。` });
    return diagnostics;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
    if (value instanceof Uint8Array) {
        const parsed = decodeStoredJson<unknown>(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    }
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
}

function parseJsonArray(value: unknown): unknown[] {
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}
