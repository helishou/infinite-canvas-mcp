import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DB_FILE, MEDIA_DIR, ensureDataDirs } from "./config.js";
import { completedImageSlots, imageSlotStatus, imageSourceStatus } from "./canvas/image-result-slots.js";
import { applyCanvasProjectOperations, canonicalizeH3References, isH3CanvasNode, registerH3ReferenceAssets, type CanvasOperation } from "./canvas/project-ops.js";
import { prepareClientCanvasOperation, stripCanvasLocalViewState } from "./canvas/operation-authority.js";
import { collaborationError, commandFingerprint, concurrentCommandConflicts, type CanvasCommandContext, type CanvasCommit } from "./canvas/collaboration.js";
import { redactInlineMedia } from "./runtime/redact-inline-media.js";
import * as Y from "yjs";
import { textSuggestionInputSchema, type CanvasTextSuggestion } from "@basketikun/canvas-agent/schemas";
import { H3_RUNTIME_SEGMENT_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { editedTextTargets, loadTextDocument, readText, replaceText, textKey, textOperation, textTargetSchema, type CanvasTextTarget } from "./canvas/collaborative-text.js";
import type { McpObservabilityReportOptions } from "./stores/types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type RuntimeTaskStatus = "queued" | "running" | "awaiting_confirmation" | "succeeded" | "failed" | "cancelled";
export type GenerationLogStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type RuntimeTask = {
    id: string; kind: string; status: RuntimeTaskStatus; progress: number;
    input: Record<string, unknown>; params: Record<string, unknown>;
    result: Record<string, unknown> | null; error: string | null;
    createdAt: string; updatedAt: string;
    parentTaskId?: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    executor?: string;
    model?: string;
    outputs: Array<Record<string, unknown>>;
};

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
export type RuntimeTaskEvent = {
    id: number; taskId: string; type: string;
    payload: Record<string, unknown>; createdAt: string;
};
export type GenerationLog = {
    id: string; projectId: string; nodeId?: string; segmentId?: string;
    status: GenerationLogStatus; platform: string;
    workflow?: string; model?: string; taskMode?: string; prompt?: string;
    references: Array<Record<string, unknown>>; inputCounts: Record<string, number>;
    runtimeTaskId?: string; promptId?: string;
    startedAt: string; finishedAt?: string; durationMs: number;
    outputs: Array<Record<string, unknown>>; error?: string;
    params: Record<string, unknown>; createdAt: string; updatedAt: string;
};
export type McpObservabilityEventInput = {
    sessionId: string; traceId: string; event: "tool.started" | "tool.succeeded" | "tool.failed"; tool: string;
    projectId?: string; nodeId?: string; operationId?: string; taskId?: string;
    durationMs?: number; errorCode?: string; recoverable?: boolean; suggestedTool?: string;
    inputSummary?: Record<string, unknown>; outputSummary?: Record<string, unknown>;
};
export type McpObservabilityEvent = McpObservabilityEventInput & { id: string; createdAt: string };
export type MediaFile = {
    storageKey: string; filePath: string; mimeType: string;
    bytes: number; width: number | null; height: number | null; durationMs: number | null;
    createdAt: string;
};
export type AssetFolder = { id: string; name: string; parentId: string | null; createdAt: string };
export type CanvasFolder = {
    id: string; name: string; createdAt: string; updatedAt?: string;
    outline?: string; description?: string; coverStorageKey?: string | null; tags?: string[];
    /** 画布侧创建的普通文件夹为 false；旧客户端未传时按短剧兼容。 */
    isDrama?: boolean;
};
export type Asset = {
    id: string; kind: string; title: string; coverUrl: string; tags: string[];
    folderId: string | null; dramaId?: string | null; data: Record<string, unknown>; note: string | null;
    source: string | null; metadata: Record<string, unknown>;
    createdAt: string; updatedAt: string;
};
export type DramaEpisode = {
    id: string;
    dramaId: string;
    episodeNumber: number;
    title: string;
    synopsis: string;
    fullPlot: string;
    canvasId: string | null;
    createdAt: string;
    updatedAt: string;
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

// ── Workflow Import ──────────────────────────────────────────────────────

export type WorkflowFieldType = 'text' | 'number' | 'slider' | 'boolean' | 'dropdown' | 'image' | 'audio' | 'video';

export type WorkflowField = {
    id: string;
    node: string;
    input: string;
    name: string;
    type: WorkflowFieldType;
    required?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    randomEnabled?: boolean;
    isPrompt?: boolean;
};

export type WorkflowConfig = {
    title: string;
    backend: string;
    operation: string;
    description: string;
    fields: WorkflowField[];
    mediaInputs?: Record<string, unknown>;
    miniCards?: Record<string, unknown>;
};

export type WorkflowConfigRow = {
    name: string; title: string; backend: string; description: string; operation: string;
    fieldsJson: string; mediaInputsJson: string; miniCardsJson: string; updatedAt: string;
};

// ── Database ──────────────────────────────────────────────────────────────────

export class BackendDatabase {
    readonly db: DatabaseSync;
    private readonly filePath: string;
    private canvasCommitListener?: (commit: CanvasCommit) => void;

    onCanvasCommit(listener: (commit: CanvasCommit) => void) { this.canvasCommitListener = listener; }

    constructor(file: string = DB_FILE) {
        this.filePath = file;
        ensureDataDirs();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        try { this.migrate(); }
        catch (error) { this.db.close(); throw error; }
    }

    close() { this.db.close(); }

    // ── schema_migrations ─────────────────────────────────────────────────

    private migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_projects (
                id TEXT PRIMARY KEY,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_operation_batches (
                operation_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                base_revision INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                source_json TEXT NOT NULL DEFAULT '{}',
                operations_json TEXT NOT NULL,
                results_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS canvas_operation_batches_project_revision ON canvas_operation_batches(project_id, revision);
            CREATE TABLE IF NOT EXISTS canvas_command_receipts (
                operation_id TEXT PRIMARY KEY REFERENCES canvas_operation_batches(operation_id) ON DELETE CASCADE,
                request_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_collaboration_checkpoints (
                project_id TEXT PRIMARY KEY REFERENCES canvas_projects(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_text_documents (
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                target_key TEXT NOT NULL,
                state BLOB NOT NULL,
                PRIMARY KEY (project_id, target_key)
            );
            CREATE TABLE IF NOT EXISTS canvas_text_suggestions (
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                target_key TEXT NOT NULL,
                data_json TEXT NOT NULL,
                PRIMARY KEY (project_id, id)
            );
            CREATE TABLE IF NOT EXISTS canvas_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS drama_projects (
                folder_id TEXT PRIMARY KEY REFERENCES canvas_folders(id) ON DELETE CASCADE,
                outline TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                cover_storage_key TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS drama_episodes (
                id TEXT PRIMARY KEY,
                drama_id TEXT NOT NULL REFERENCES drama_projects(folder_id) ON DELETE CASCADE,
                episode_number INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                synopsis TEXT NOT NULL DEFAULT '',
                full_plot TEXT NOT NULL DEFAULT '',
                canvas_id TEXT REFERENCES canvas_projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(drama_id, episode_number),
                UNIQUE(canvas_id)
            );
            CREATE INDEX IF NOT EXISTS drama_episodes_drama_id ON drama_episodes(drama_id);
            CREATE INDEX IF NOT EXISTS drama_episodes_canvas_id ON drama_episodes(canvas_id);
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                cover_url TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                folder_id TEXT REFERENCES asset_folders(id) ON DELETE SET NULL,
                drama_id TEXT REFERENCES drama_projects(folder_id) ON DELETE SET NULL,
                data_json TEXT NOT NULL DEFAULT '{}',
                note TEXT,
                source TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS assets_kind ON assets(kind);
            CREATE INDEX IF NOT EXISTS assets_folder ON assets(folder_id);
            CREATE TABLE IF NOT EXISTS asset_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT REFERENCES asset_folders(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS media_files (
                storage_key TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                width INTEGER,
                height INTEGER,
                duration_ms INTEGER,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS generation_logs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT,
                segment_id TEXT,
                status TEXT NOT NULL,
                platform TEXT NOT NULL,
                workflow TEXT,
                model TEXT,
                task_mode TEXT,
                prompt TEXT,
                references_json TEXT NOT NULL DEFAULT '[]',
                input_counts_json TEXT NOT NULL DEFAULT '{}',
                runtime_task_id TEXT,
                prompt_id TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                outputs_json TEXT NOT NULL DEFAULT '[]',
                error TEXT,
                params_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS generation_logs_project_created ON generation_logs(project_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                input_json TEXT NOT NULL,
                params_json TEXT NOT NULL,
                result_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS task_events_task_id_id ON task_events(task_id, id);
            CREATE TABLE IF NOT EXISTS mcp_observability_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                trace_id TEXT NOT NULL,
                event TEXT NOT NULL,
                tool TEXT NOT NULL,
                project_id TEXT,
                node_id TEXT,
                operation_id TEXT,
                task_id TEXT,
                duration_ms INTEGER,
                error_code TEXT,
                recoverable INTEGER,
                suggested_tool TEXT,
                input_summary_json TEXT NOT NULL DEFAULT '{}',
                output_summary_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS mcp_observability_trace ON mcp_observability_events(trace_id, created_at);
            CREATE INDEX IF NOT EXISTS mcp_observability_tool_event ON mcp_observability_events(tool, event, created_at);
            CREATE TABLE IF NOT EXISTS runtime_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS plugin_declarations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                tools_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_configs (
                name TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                backend TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                operation TEXT NOT NULL DEFAULT '',
                fields_json TEXT NOT NULL DEFAULT '[]',
                media_inputs_json TEXT NOT NULL DEFAULT '{}',
                mini_cards_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );
        `);
        // 文本身份属于对象的一次生命周期，不得由可复用的 nodeId / segmentId 推导。
        const textColumns = this.db.prepare("PRAGMA table_info(canvas_text_documents)").all() as Array<{ name: string }>;
        if (!textColumns.some((column) => column.name === "document_id")) {
            this.db.exec("BEGIN IMMEDIATE");
            try {
                this.db.exec("ALTER TABLE canvas_text_documents ADD COLUMN document_id TEXT; UPDATE canvas_text_documents SET document_id = lower(hex(randomblob(16)))");
                this.db.exec("COMMIT");
            } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        }
        const version = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number } | undefined;
        const currentVersion = version?.version || 0;
        if (currentVersion < 1) {
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 2) {
            this.removeFlux2KleinCompositeFields();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 3) {
            // 旧 v2 已把这两个字段补了 name/default，这里统一清理掉（幂等）。
            this.removeFlux2KleinCompositeFields();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 4) {
            // 历史 H3 节点会把 segment 运行历史塞进 node.metadata.materials（每个 segment 含完整 sourcePrompt，
            // 单节点 metadata 累积可达 MB 级；画布 JSON 越大，canvas_get_state 等 MCP tool 返回就越易被截断）。
            // 现在 generation_logs.outputs_json 才是单一来源（url/storageKey/mimeType/width/height 都有），
            // node.metadata.materials 在写入端停摆，迁移脚本从老 canvas_projects.data_json 中物理删掉这个字段，
            // 下次读出来 metadata.materials 就一直是 undefined，前端走 generation_logs 派生路径。
            this.stripMaterialsFromCanvasProjects();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 5) {
            // 历史 H3 segment 还会把"生成时刻输入快照"（params / refItems / characterRefs /
            // characterPromptBlocks / sourceComfyParams / sourceParameters / sourcePrompt 等）
            // 复制进 segments[i].results[] 与 segments[i]，单节点 metadata 可达 MB 级。
            // generation_logs 才是单一来源（prompt + references_json + params_json 已有完整数据），
            // 写入端停摆，迁移脚本从老 canvas_projects.data_json 中物理剥掉这些字段。
            this.stripSegmentInputSnapshotsFromCanvasProjects();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 6) {
            // 短剧制作台 / 剧目（drama_projects）已经存在并挂在外层 canvas_folders 下，
            // 但画布（canvas_projects）之前没有 folder_id 列，前端 /drama 页面因此永远只能
            // 看到"全部场景"——"未编排场景"分类永远是空的、新建画布也没法挂剧目。
            // 这里加一列 + 索引，删除剧目时 ON DELETE SET NULL（画布掉回"未编排场景"分类）。
            this.attachCanvasProjectsToFolders();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 7) {
            // v6 的 folder_id 列假设是「画布 → 剧目」方向，但实际叙事模型是
            // 「剧目 → 分集 → 画布」三层：drama_projects 是根，每个 drama 下多个 episode，
            // 每个 episode 1:1 绑一个画布（asset 也算画布）。v6 抹平了 episode 这一层，导致
            // 「分集剧情」无处放、前端假设了 folder_id 但语义错位。
            // v7 改造：
            //   1. 新表 drama_episodes（episode_number + title + synopsis + canvas_id 1:1 可空）
            //   2. 删 canvas_projects.folder_id 列（关系由 drama_episodes.canvas_id 承接）
            //   3. 把既存 canvas_projects.folder_id 数据搬到 drama_episodes（自动建空 episode 1）
            //   4. drama_projects.outline 保留作「项目总纲」字段（与 episodes.synopsis 区分粒度）
            this.createDramaEpisodesTable();
            this.migrateV6FolderIdToV7Episodes();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 8) {
            // v7 已可能在旧服务进程中执行：补清 data_json.folderId，并把 episode 外键/唯一约束统一到最终模型。
            this.migrateV7ToV8EpisodeConstraints();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 9) {
            // 资产文件夹只表达库内整理方式；drama_id 单独记录资产所属剧目。
            // 旧 drama-file 已把归属写在 data_json.dramaId，迁移时回填到正式列。
            this.attachAssetsToDramas();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 10) {
            // 分集梗概用于快速浏览，完整剧情单独保存，避免长文本挤占卡片摘要。
            this.attachFullPlotToDramaEpisodes();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 11) {
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 12) {
            // MiniMax H3 工作流把宽高从比例/像素量计算改为可直接暴露的 PrimitiveInt 参数，
            // 让已经初始化过的数据库也能看到宽度、高度和时长字段。
            this.migrateMiniMaxH3WorkflowFields();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 13) {
            if (currentVersion > 0) this.backupBeforeH3Migration();
            this.indexTaskQueries();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?)").run(new Date().toISOString());
        }
        if (currentVersion < 14) {
            if (currentVersion === 13) this.backupBeforeH3Migration("v14-reference-archive");
            this.migrateH3References();
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?)").run(new Date().toISOString());
        }
    }

    private backupBeforeH3Migration(version = "v13") {
        const file = this.filePath;
        if (!file || file === ":memory:") return;
        const backup = `${file}.pre-h3-${version}.sqlite`;
        if (fs.existsSync(backup)) throw new Error(`已有 H3 迁移备份，拒绝覆盖：${backup}`);
        this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
        if (fs.statSync(backup).size === 0) throw new Error("H3 数据库迁移备份为空");
        const copy = new DatabaseSync(backup, { readOnly: true });
        try {
            const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
            if (check.integrity_check !== "ok") throw new Error("H3 数据库迁移备份完整性校验失败");
        } finally { copy.close(); }
    }

    private migrateH3References() {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.exec(`CREATE TABLE IF NOT EXISTS h3_reference_legacy_archive (
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                legacy_json TEXT NOT NULL,
                archived_at TEXT NOT NULL,
                PRIMARY KEY(project_id, node_id, segment_id)
            )`);
            const rows = this.db.prepare("SELECT id, data_json FROM canvas_projects").all() as Array<{ id: string; data_json: string }>;
            const update = this.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?");
            const findArchive = this.db.prepare("SELECT legacy_json FROM h3_reference_legacy_archive WHERE project_id = ? AND node_id = ? AND segment_id = ?");
            const saveArchive = this.db.prepare("INSERT INTO h3_reference_legacy_archive (project_id, node_id, segment_id, legacy_json, archived_at) VALUES (?, ?, ?, ?, ?)");
            for (const row of rows) {
                const project = JSON.parse(row.data_json) as Record<string, unknown>;
                const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
                let changed = false;
                for (const node of nodes) {
                    if (!isH3CanvasNode(node)) continue;
                    const before = JSON.stringify(node);
                    canonicalizeH3References(node, (segment, index) => {
                        const segmentId = String(segment.id || `index:${index}`);
                        const legacy = JSON.stringify({ refItems: segment.refItems, refs: segment.refs });
                        const existing = findArchive.get(row.id, String(node.id || ""), segmentId) as { legacy_json: string } | undefined;
                        if (existing && existing.legacy_json !== legacy) throw new Error(`H3 旧参考归档冲突：${row.id}/${String(node.id || "")}/${segmentId}`);
                        if (!existing) saveArchive.run(row.id, String(node.id || ""), segmentId, legacy, new Date().toISOString());
                    });
                    const metadata = recordOf(node.metadata);
                    const segments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
                    for (const segment of segments) {
                        for (const key of ["faceRepairSingle", "faceRepairMulti", "globalRepair"]) {
                            if (key in segment) { delete segment[key]; changed = true; }
                        }
                    }
                    metadata.segments = segments;
                    node.metadata = metadata;
                    if (JSON.stringify(node) !== before) changed = true;
                    const beforeCatalog = JSON.stringify(project.referenceCatalog || []);
                    registerH3ReferenceAssets(project, node);
                    if (JSON.stringify(project.referenceCatalog || []) !== beforeCatalog) changed = true;
                }
                if (changed) update.run(JSON.stringify(project), row.id);
            }
            this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    private indexTaskQueries() {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            for (const [name, type] of [["project_id", "TEXT"], ["node_id", "TEXT"], ["segment_id", "TEXT"], ["model", "TEXT"], ["is_image", "INTEGER NOT NULL DEFAULT 0"], ["is_video", "INTEGER NOT NULL DEFAULT 0"]]) {
                this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
            }
            const rows = this.db.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>;
            const update = this.db.prepare("UPDATE tasks SET project_id = ?, node_id = ?, segment_id = ?, model = ?, is_image = ?, is_video = ? WHERE id = ?");
            for (const row of rows) {
                const task = this.getTask(row.id);
                if (!task) continue;
                const fields = taskSearchFields(task.kind, task.input, task.params);
                update.run(fields.projectId, fields.nodeId, fields.segmentId, fields.model, fields.isImage, fields.isVideo, row.id);
            }
            this.db.exec("CREATE INDEX IF NOT EXISTS tasks_project_kind_status_created ON tasks(project_id, kind, status, created_at DESC)");
            this.db.exec("CREATE INDEX IF NOT EXISTS tasks_status_created ON tasks(status, created_at DESC)");
            this.db.exec("CREATE INDEX IF NOT EXISTS tasks_project_node_segment_created ON tasks(project_id, node_id, segment_id, created_at DESC)");
            this.db.exec("CREATE INDEX IF NOT EXISTS tasks_model_created ON tasks(model, created_at DESC)");
            this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }

    private attachFullPlotToDramaEpisodes() {
        const columns = this.db.prepare("PRAGMA table_info(drama_episodes)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "full_plot")) {
            this.db.exec("ALTER TABLE drama_episodes ADD COLUMN full_plot TEXT NOT NULL DEFAULT ''");
        }
    }

    private attachAssetsToDramas() {
        const columns = this.db.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "drama_id")) {
            this.db.exec("ALTER TABLE assets ADD COLUMN drama_id TEXT REFERENCES drama_projects(folder_id) ON DELETE SET NULL");
        }
        this.db.exec("CREATE INDEX IF NOT EXISTS assets_drama ON assets(drama_id)");
        const legacyFiles = this.db.prepare("SELECT id, data_json FROM assets WHERE kind = 'drama-file' AND drama_id IS NULL").all() as Array<{ id: string; data_json: string }>;
        const update = this.db.prepare("UPDATE assets SET drama_id = ? WHERE id = ?");
        for (const row of legacyFiles) {
            const dramaId = parseJsonObject(row.data_json).dramaId;
            if (typeof dramaId !== "string") continue;
            const exists = this.db.prepare("SELECT 1 FROM drama_projects WHERE folder_id = ?").get(dramaId);
            if (exists) update.run(dramaId, row.id);
        }
    }

    /**
     * 一次性把老 canvas_projects.data_json 里的 metadata.materials 字段删掉。
     * 解析每个 project 的 data_json → 找 type 以 minimax 开头的节点 → 删 metadata.materials 字段 → 写回。
     * 解析失败则保留原值。
     */
    private stripMaterialsFromCanvasProjects() {
        const rows = this.db.prepare("SELECT id, data_json FROM canvas_projects").all() as Array<{ id: string; data_json: string }>;
        let touched = 0;
        let totalStripped = 0;
        for (const row of rows) {
            let project: unknown;
            try { project = JSON.parse(row.data_json); } catch { continue; }
            if (!project || typeof project !== "object") continue;
            const nodes = (project as { nodes?: unknown }).nodes;
            if (!Array.isArray(nodes)) continue;
            let projectTouched = false;
            for (const node of nodes) {
                if (!node || typeof node !== "object") continue;
                const n = node as { type?: unknown; metadata?: unknown };
                if (typeof n.type !== "string" || !/^minimax|^smart-minimax/.test(n.type)) continue;
                if (!n.metadata || typeof n.metadata !== "object") continue;
                const meta = n.metadata as Record<string, unknown>;
                if (!("materials" in meta)) continue;
                delete meta.materials;
                projectTouched = true;
                totalStripped++;
            }
            if (!projectTouched) continue;
            const next = JSON.stringify(project);
            if (next === row.data_json) continue;
            this.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?").run(next, row.id);
            touched++;
        }
        if (touched) console.log(`[migrate v4] stripped metadata.materials from ${totalStripped} H3 node(s) across ${touched} canvas project(s)`);
    }

    /**
     * 把老 H3 节点的 segments 数组里的"生成时刻输入快照"剥掉：
     *   - segments[i].results[]：只留 url / storageKey / name / segmentId / kind / mimeType / type / imageIndex
     *   - segments[i] 上的 refItems / characterRefs / characterPromptBlocks /
     *     sourceComfyParams / sourceParameters / sourcePrompt / sourceCharacterRefs / comfyParams / comfyWorkflow 字段
     *   - segments[i].sourceRefs 内每个 ref 元素也只留 url / kind / role / imageIndex / name / segmentId
     *
     * generation_logs.prompt + references_json + params_json 已是单一来源（写入端停摆）。
     */
    private stripSegmentInputSnapshotsFromCanvasProjects() {
        const rows = this.db.prepare("SELECT id, data_json FROM canvas_projects").all() as Array<{ id: string; data_json: string }>;
        let touched = 0;
        let totalStripped = 0;
        const resultAllow = new Set(["url", "storageKey", "name", "segmentId", "kind", "mimeType", "type", "imageIndex"]);
        const segmentStrip = new Set([
            "refItems", "characterRefs", "characterPromptBlocks",
            "sourceComfyParams", "sourceParameters", "sourcePrompt",
            "sourceCharacterRefs", "comfyParams", "comfyWorkflow",
        ]);
        const refAllow = new Set(["url", "kind", "role", "imageIndex", "name", "segmentId"]);
        for (const row of rows) {
            let project: unknown;
            try { project = JSON.parse(row.data_json); } catch { continue; }
            if (!project || typeof project !== "object") continue;
            const nodes = (project as { nodes?: unknown }).nodes;
            if (!Array.isArray(nodes)) continue;
            let projectTouched = false;
            for (const node of nodes) {
                if (!node || typeof node !== "object") continue;
                const n = node as { type?: unknown; metadata?: unknown };
                if (typeof n.type !== "string" || !/^minimax|^smart-minimax/.test(n.type)) continue;
                if (!n.metadata || typeof n.metadata !== "object") continue;
                const meta = n.metadata as Record<string, unknown>;
                if (!Array.isArray(meta.segments)) continue;
                for (const segment of meta.segments as Array<Record<string, unknown>>) {
                    if (!segment || typeof segment !== "object") continue;
                    // 1) segment.results[] 瘦身
                    const results = Array.isArray(segment.results) ? segment.results as Array<Record<string, unknown>> : [];
                    let segTouched = false;
                    for (const item of results) {
                        if (!item || typeof item !== "object") continue;
                        for (const key of Object.keys(item)) {
                            if (!resultAllow.has(key)) {
                                delete item[key];
                                segTouched = true;
                            }
                        }
                    }
                    // 2) segment 上冗余的输入快照字段
                    for (const key of segmentStrip) {
                        if (key in segment) {
                            delete segment[key];
                            segTouched = true;
                        }
                    }
                    // 3) segment.sourceRefs 内每个 ref 元素瘦身
                    const sourceRefs = segment.sourceRefs;
                    if (sourceRefs && typeof sourceRefs === "object") {
                        for (const [kind, list] of Object.entries(sourceRefs as Record<string, unknown>)) {
                            if (!Array.isArray(list)) {
                                delete (sourceRefs as Record<string, unknown>)[kind];
                                segTouched = true;
                                continue;
                            }
                            const kept: Array<Record<string, unknown>> = [];
                            for (const entry of list) {
                                if (!entry || typeof entry !== "object") continue;
                                const slim: Record<string, unknown> = {};
                                for (const k of refAllow) if (k in (entry as Record<string, unknown>)) slim[k] = (entry as Record<string, unknown>)[k];
                                kept.push(slim);
                            }
                            (sourceRefs as Record<string, unknown>)[kind] = kept;
                            segTouched = true;
                        }
                    }
                    if (segTouched) {
                        projectTouched = true;
                        totalStripped++;
                    }
                }
            }
            if (!projectTouched) continue;
            const next = JSON.stringify(project);
            if (next === row.data_json) continue;
            this.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?").run(next, row.id);
            touched++;
        }
        if (touched) console.log(`[migrate v5] trimmed segment input snapshots from ${totalStripped} segment(s) across ${touched} canvas project(s)`);
    }

    /**
     * v7 migration: 新表 drama_episodes（episode_number / title / synopsis / canvas_id 1:1 可空）。
     * 列在 CREATE TABLE 里已预声明（新建库直接生效）；老库由 v7 migration 兜底。
     * UNIQUE(drama_id, episode_number) 防重；两个索引加速按剧目/按画布反查。
     */
    private createDramaEpisodesTable() {
        const epExists = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drama_episodes'").get() as { name?: string } | undefined)?.name;
        if (!epExists) {
            this.db.exec(`CREATE TABLE drama_episodes (
                id TEXT PRIMARY KEY,
                drama_id TEXT NOT NULL REFERENCES drama_projects(folder_id) ON DELETE CASCADE,
                episode_number INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                synopsis TEXT NOT NULL DEFAULT '',
                full_plot TEXT NOT NULL DEFAULT '',
                canvas_id TEXT REFERENCES canvas_projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(drama_id, episode_number),
                UNIQUE(canvas_id)
            )`);
        }
        this.attachFullPlotToDramaEpisodes();
        this.db.exec("CREATE INDEX IF NOT EXISTS drama_episodes_drama_id ON drama_episodes(drama_id)");
        this.db.exec("CREATE INDEX IF NOT EXISTS drama_episodes_canvas_id ON drama_episodes(canvas_id)");
        const epCount = (this.db.prepare("SELECT COUNT(*) AS n FROM drama_episodes").get() as { n: number }).n;
        console.log(`[migrate v7] drama_episodes ready (${epCount} episode(s))`);
    }

    /**
     * v7 migration: 把 v6 时代 canvas_projects.folder_id 的存量关系搬到 drama_episodes。
     * 规则：
     // 每对（drama, canvas）自动建一个空 episode 1（占位，待用户填标题/分集剧情）。
     // 同一 drama 下若已有 episode 1 且 canvas_id 未占，则新挂 canvas；
     // 已有 canvas_id 重复则跳过（防冲突）。
     // 每个 drama 即使没有任何 canvas，也建一个空 episode 1 占位。
     */
    private migrateV6FolderIdToV7Episodes() {
        // 列是否存在
        const cols = this.db.prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>;
        const hasFolderId = cols.some((c) => c.name === "folder_id");
        let migrated = 0;
        if (hasFolderId) {
            // 读 v6 时代所有 folder_id → canvas 映射
            const rows = this.db.prepare("SELECT p.id, p.folder_id FROM canvas_projects p INNER JOIN drama_projects d ON d.folder_id = p.folder_id WHERE p.folder_id IS NOT NULL").all() as Array<{ id: string; folder_id: string }>;
            for (const row of rows) {
                this.upsertDramaEpisode({
                    dramaId: row.folder_id,
                    episodeNumber: 1,
                    title: "",
                    synopsis: "",
                    canvasId: row.id,
                });
                migrated++;
            }
            // 同步清理 v6 写入 data_json 的冗余 folderId，避免画布读接口继续泄露旧直属关系。
            const projects = this.db.prepare("SELECT id, data_json FROM canvas_projects").all() as Array<{ id: string; data_json: string }>;
            const updateProject = this.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?");
            for (const row of projects) {
                let project: unknown;
                try { project = JSON.parse(row.data_json); } catch { continue; }
                if (!project || typeof project !== "object" || !("folderId" in project)) continue;
                delete (project as Record<string, unknown>).folderId;
                updateProject.run(JSON.stringify(project), row.id);
            }
            // 删列（ALTER TABLE DROP COLUMN 是 SQLite 3.35+ 才有；走重建表最稳）
            this.db.exec("PRAGMA foreign_keys=OFF");
            this.db.exec("BEGIN IMMEDIATE");
            try {
                this.db.exec(`CREATE TABLE canvas_projects_new (
                    id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )`);
                this.db.exec("INSERT INTO canvas_projects_new (id, data_json, updated_at) SELECT id, data_json, updated_at FROM canvas_projects");
                this.db.exec("DROP TABLE canvas_projects");
                this.db.exec("ALTER TABLE canvas_projects_new RENAME TO canvas_projects");
                this.db.exec("COMMIT");
            } catch (error) {
                this.db.exec("ROLLBACK");
                throw error;
            } finally {
                this.db.exec("PRAGMA foreign_keys=ON");
            }
        }
        // 给所有没建过 episode 的 drama 也建一个空 episode 1 占位
        const dramasWithoutEpisode = this.db.prepare(
            "SELECT d.folder_id AS id FROM drama_projects d LEFT JOIN drama_episodes e ON e.drama_id = d.folder_id WHERE e.id IS NULL"
        ).all() as Array<{ id: string }>;
        for (const d of dramasWithoutEpisode) {
            this.upsertDramaEpisode({
                dramaId: d.id,
                episodeNumber: 1,
                title: "",
                synopsis: "",
                canvasId: null,
            });
            migrated++;
        }
        console.log(`[migrate v7] migrated ${migrated} episode(s)`);
    }

    /** v8：修复已执行 v7 的旧进程留下的关系残留，保持迁移可重复执行。 */
    private migrateV7ToV8EpisodeConstraints() {
        const invalid = this.db.prepare(
            "SELECT e.id, e.drama_id FROM drama_episodes e LEFT JOIN drama_projects d ON d.folder_id = e.drama_id WHERE d.folder_id IS NULL"
        ).all() as Array<{ id: string; drama_id: string }>;
        if (invalid.length) throw new Error(`drama_episodes 存在不属于剧目的记录: ${invalid.map((row) => row.id).join(", ")}`);
        const duplicateCanvas = this.db.prepare(
            "SELECT canvas_id FROM drama_episodes WHERE canvas_id IS NOT NULL GROUP BY canvas_id HAVING COUNT(*) > 1"
        ).all() as Array<{ canvas_id: string }>;
        if (duplicateCanvas.length) throw new Error(`同一画布被多个分集绑定: ${duplicateCanvas.map((row) => row.canvas_id).join(", ")}`);

        this.db.exec("PRAGMA foreign_keys=OFF");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const projects = this.db.prepare("SELECT id, data_json FROM canvas_projects").all() as Array<{ id: string; data_json: string }>;
            const updateProject = this.db.prepare("UPDATE canvas_projects SET data_json = ? WHERE id = ?");
            for (const row of projects) {
                let project: unknown;
                try { project = JSON.parse(row.data_json); } catch { continue; }
                if (!project || typeof project !== "object" || !("folderId" in project)) continue;
                delete (project as Record<string, unknown>).folderId;
                updateProject.run(JSON.stringify(project), row.id);
            }

            this.db.exec(`CREATE TABLE drama_episodes_v8 (
                id TEXT PRIMARY KEY,
                drama_id TEXT NOT NULL REFERENCES drama_projects(folder_id) ON DELETE CASCADE,
                episode_number INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                synopsis TEXT NOT NULL DEFAULT '',
                canvas_id TEXT REFERENCES canvas_projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(drama_id, episode_number),
                UNIQUE(canvas_id)
            )`);
            this.db.exec("INSERT INTO drama_episodes_v8 SELECT id, drama_id, episode_number, title, synopsis, canvas_id, created_at, updated_at FROM drama_episodes");
            this.db.exec("DROP TABLE drama_episodes");
            this.db.exec("ALTER TABLE drama_episodes_v8 RENAME TO drama_episodes");
            this.db.exec("CREATE INDEX drama_episodes_drama_id ON drama_episodes(drama_id)");
            this.db.exec("CREATE INDEX drama_episodes_canvas_id ON drama_episodes(canvas_id)");
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        } finally {
            this.db.exec("PRAGMA foreign_keys=ON");
        }
        console.log("[migrate v8] cleaned legacy canvas folder fields and normalized episode constraints");
    }

    /**
     * v6 migration: 给老 canvas_projects 加 folder_id 列 + 索引。
     * 列在 CREATE TABLE 里已经预声明（新建库直接生效）；老库用 ALTER TABLE 兜底。
     * ON DELETE SET NULL：删剧目时画布自动掉到"未编排场景"分类，不级联删画布。
     */
    private attachCanvasProjectsToFolders() {
        const cols = this.db.prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>;
        const hasFolderId = cols.some((c) => c.name === "folder_id");
        if (!hasFolderId) {
            this.db.exec("ALTER TABLE canvas_projects ADD COLUMN folder_id TEXT REFERENCES canvas_folders(id) ON DELETE SET NULL");
        }
        this.db.exec(`
            UPDATE canvas_projects
            SET folder_id = (
                SELECT id FROM canvas_folders
                WHERE id = json_extract(canvas_projects.data_json, '$.folderId')
            )
            WHERE folder_id IS NULL AND json_extract(data_json, '$.folderId') IS NOT NULL;
            UPDATE canvas_projects
            SET data_json = json_remove(data_json, '$.folderId')
            WHERE folder_id IS NULL AND json_extract(data_json, '$.folderId') IS NOT NULL;
        `);
        this.db.exec("CREATE INDEX IF NOT EXISTS canvas_projects_folder_id ON canvas_projects(folder_id)");
        const projectCount = (this.db.prepare("SELECT COUNT(*) AS n FROM canvas_projects").get() as { n: number }).n;
        console.log(`[migrate v6] canvas_projects.folder_id ready (${projectCount} project(s))`);
    }

    /**
     * 删除 Flux2-Klein 内置工作流中 `node: "152,156"` 的 width/height 复合字段。
     * 这两类字段的 node 是「同时注入节点152+156」的复合写法，不是真实节点名，
     * 因此工作流管理面板无法显示/删除它，却又会出现在运行面板；且其 default 被
     * 注入 0 时会覆盖节点 157（GetImageSize）的尺寸连接，破坏生图。尺寸本就由
     * 节点 157 自动驱动，故直接移除。
     */
    private removeFlux2KleinCompositeFields() {
        const row = this.db.prepare("SELECT fields_json FROM workflow_configs WHERE name = ?").get("Flux2-Klein.json") as { fields_json?: string } | undefined;
        if (!row) return;
        let fields: WorkflowField[] = [];
        try {
            fields = row.fields_json ? (JSON.parse(row.fields_json) as WorkflowField[]) : [];
        } catch {
            return;
        }
        const removeIds = new Set(["152,156.width", "152,156.height"]);
        const next = fields.filter((f) => !removeIds.has(f.id));
        if (next.length !== fields.length) {
            this.upsertWorkflowConfig("Flux2-Klein.json", {
                title: "Flux2-Klein",
                fieldsJson: JSON.stringify(next),
            });
        }
    }

    private migrateMiniMaxH3WorkflowFields() {
        const row = this.db.prepare("SELECT fields_json FROM workflow_configs WHERE name = ?").get("MiniMax_H3.json") as { fields_json?: string } | undefined;
        if (!row?.fields_json) return;
        let fields: WorkflowField[];
        try { fields = JSON.parse(row.fields_json) as WorkflowField[]; } catch { return; }
        if (!Array.isArray(fields) || fields.some((field) => ["width", "height"].includes(field.id))) return;
        const legacy = new Set(["aspect_ratio", "megapixels"]);
        if (!fields.some((field) => legacy.has(field.id))) return;
        const next = fields.filter((field) => !legacy.has(field.id));
        const durationIndex = next.findIndex((field) => field.id === "duration");
        const sizeFields: WorkflowField[] = [
            { id: "width", node: "140", input: "value", name: "宽度（像素）", type: "number", default: 864, step: 32 },
            { id: "height", node: "141", input: "value", name: "高度（像素）", type: "number", default: 480, step: 32 },
        ];
        next.splice(durationIndex < 0 ? next.length : durationIndex, 0, ...sizeFields);
        this.upsertWorkflowConfig("MiniMax_H3.json", { fieldsJson: JSON.stringify(next) });
        console.log("[migrate v12] exposed MiniMax H3 width/height workflow fields");
    }

    // ── canvas_projects ───────────────────────────────────────────────────

    listCanvasProjects(): CanvasProject[] {
        // v7 后画布不再有 folder_id 列；关系由 drama_episodes.canvas_id 承接。
        // 按 episode 过滤用 listCanvasProjectsByEpisode（canvas-agent / REST 那边）。
        const rows = this.db.prepare("SELECT data_json FROM canvas_projects ORDER BY updated_at DESC").all() as Array<{ data_json: string }>;
        return rows.flatMap((row) => {
            try {
                const value = stripCanvasLocalViewState(JSON.parse(row.data_json) as Record<string, unknown>) as unknown as CanvasProject;
                return value && typeof value === "object" && value.id ? [value] : [];
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
        // v7: 画布表无 folder_id 列，按 episode 过滤走 listCanvasProjectsByEpisode 路径。
        // 这里保留纯 id 过滤（web /drama 页按画布 ID 查摘要时用）。
        if (filter?.episodeId) {
            const ep = this.getDramaEpisode(filter.episodeId);
            if (!ep?.canvasId) return [];
            const proj = this.getCanvasProject(ep.canvasId);
            if (!proj) return [];
            return [{
                id: proj.id,
                title: String((proj as Record<string, unknown>).title || ""),
                episodeId: ep.id,
                dramaId: ep.dramaId,
                updatedAt: String((proj as Record<string, unknown>).updatedAt || ""),
                revision: Number((proj as Record<string, unknown>).revision || 0),
                nodeCount: Array.isArray((proj as Record<string, unknown>).nodes) ? ((proj as unknown as { nodes: unknown[] }).nodes.length) : 0,
                connectionCount: Array.isArray((proj as Record<string, unknown>).connections) ? ((proj as unknown as { connections: unknown[] }).connections.length) : 0,
            } as unknown as CanvasProject];
        }
        const where: string[] = [];
        const params: Array<string> = [];
        if (filter?.id) {
            where.push("id = ?");
            params.push(filter.id);
        }
        const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        return this.db.prepare(`SELECT id, updated_at AS updatedAt,
            json_extract(data_json, '$.title') AS title,
            json_extract(data_json, '$.createdAt') AS createdAt,
            COALESCE(json_extract(data_json, '$.revision'), 0) AS revision,
            COALESCE(json_array_length(data_json, '$.nodes'), 0) AS nodeCount,
            COALESCE(json_array_length(data_json, '$.connections'), 0) AS connectionCount
            FROM canvas_projects ${whereClause} ORDER BY updated_at DESC`).all(...params) as CanvasProject[];
    }

    createCanvasProject(input: CanvasProject) {
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
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.getCanvasProject(project.id);
            if (current) {
                const checkpoint = this.db.prepare("SELECT revision, data_json FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(project.id) as { revision: number; data_json: string } | undefined;
                if (!checkpoint || checkpoint.revision !== 0 || seedHash(JSON.parse(checkpoint.data_json)) !== seedHash(project)) {
                    throw Object.assign(collaborationError("PROJECT_EXISTS", "画布已存在，不能用整图覆盖；请提交增量操作或使用新 ID 导入"), { project: current, revision: current.revision });
                }
                this.db.exec("COMMIT");
                return { project: current, created: false };
            }
            const now = new Date().toISOString();
            project.createdAt ||= now;
            project.updatedAt = now;
            const json = JSON.stringify(project);
            this.db.prepare("INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?)").run(project.id, json, now);
            const archive = this.db.prepare("INSERT INTO h3_reference_legacy_archive (project_id, node_id, segment_id, legacy_json, archived_at) VALUES (?, ?, ?, ?, ?)");
            for (const item of referenceArchives) archive.run(project.id, item.nodeId, item.segmentId, item.legacy, now);
            this.db.prepare("INSERT INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, 0, ?)").run(project.id, json);
            this.db.exec("COMMIT");
            return { project, created: true };
        } catch (error) {
            this.db.exec("ROLLBACK");
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
        const log = this.getGenerationLog(String(operation.generationLogId || ""));
        if (!log || log.projectId !== projectId || log.nodeId !== nodeId) throw new Error("历史输出不属于当前 H3 节点");
        const node = (Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []).find((item) => String(item.id) === nodeId);
        if (!isH3CanvasNode(node)) throw new Error("找不到目标 H3 节点");
        const activeTaskId = String(recordOf(node!.metadata).runtimeTaskId || "");
        if (activeTaskId && ["queued", "running", "awaiting_confirmation"].includes(this.getTask(activeTaskId)?.status || "")) throw new Error("H3 节点正在运行，不能还原历史输出");
        const segment = (Array.isArray(recordOf(node!.metadata).segments) ? recordOf(node!.metadata).segments as Array<Record<string, unknown>> : []).find((item) => String(item.id) === segmentId);
        if (!segment) throw new Error("找不到目标 Clip");
        if (["queued", "loading", "awaiting_confirmation"].includes(String(segment.status || ""))) throw new Error("Clip 正在运行，不能还原历史输出");
        const requestedKey = String(operation.storageKey || "");
        const output = log.outputs.find((item) => (!requestedKey || item.storageKey === requestedKey) && String(item.mimeType || "video/mp4").startsWith("video/"));
        const storageKey = String(output?.storageKey || "");
        const media = storageKey ? this.getMediaFile(storageKey) : null;
        if (!media || !fs.existsSync(media.filePath)) throw new Error("历史输出媒体已丢失，不能还原");
        const settings = recordOf(operation.settings);
        if (Object.keys(settings).some((key) => key === "id" || H3_RUNTIME_SEGMENT_FIELDS.includes(key as typeof H3_RUNTIME_SEGMENT_FIELDS[number]))) throw new Error("历史参数包含后台运行字段");
        const url = `/media/${encodeURIComponent(storageKey)}`;
        return { type: "update_h3_segment", nodeId, segmentId, patch: {
            ...settings,
            result: url, resultStorageKey: storageKey, results: [{ url, storageKey, mimeType: String(output?.mimeType || "video/mp4") }],
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
        const commits: CanvasCommit[] = rows.map((row) => ({ projectId: id, operationId: String(row.operation_id), baseRevision: Number(row.base_revision), revision: Number(row.revision), source: JSON.parse(String(row.source_json)), operations: JSON.parse(String(row.operations_json)), operationResults: JSON.parse(String(row.results_json)), updatedAt: String(row.created_at) }));
        const complete = afterRevision <= revision && commits.length === revision - afterRevision && commits.every((commit, index) => commit.baseRevision === afterRevision + index && commit.revision === afterRevision + index + 1);
        return { projectId: id, revision, reset: !complete, commits: complete ? commits : [], ...(!complete ? { project } : {}) };
    }

    private canvasProjectAt(id: string, revision: number): CanvasProject {
        const row = this.db.prepare("SELECT revision, data_json FROM canvas_collaboration_checkpoints WHERE project_id = ?").get(id) as { revision: number; data_json: string } | undefined;
        if (!row || row.revision > revision) throw collaborationError("RECEIPT_UNAVAILABLE", "旧请求没有可恢复回执，请读取最新画布后重新操作");
        const project = stripCanvasLocalViewState(JSON.parse(row.data_json) as Record<string, unknown>) as unknown as CanvasProject;
        const rows = this.db.prepare("SELECT revision, operations_json, created_at FROM canvas_operation_batches WHERE project_id = ? AND revision > ? AND revision <= ? ORDER BY revision").all(id, row.revision, revision) as Array<{ revision: number; operations_json: string; created_at: string }>;
        if (rows.length !== revision - row.revision) throw collaborationError("RECEIPT_UNAVAILABLE", "操作历史不连续，不能还原旧请求回执");
        for (const entry of rows) {
            applyCanvasProjectOperations(project, JSON.parse(entry.operations_json));
            project.revision = entry.revision;
            project.updatedAt = entry.created_at;
        }
        return stripCanvasLocalViewState(project as unknown as Record<string, unknown>) as unknown as CanvasProject;
    }

    applyCanvasProjectOperations(id: string, expectedRevision: number | undefined, inputOperations: CanvasOperation[], context?: CanvasCommandContext) {
        const operationId = context?.operationId || crypto.randomUUID();
        const fingerprint = commandFingerprint({ id, expectedRevision, baseRevision: context?.baseRevision, operations: inputOperations });
        const operations = structuredClone(inputOperations);
        let commit: CanvasCommit;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.getCanvasProject(id);
            if (!current) throw new Error(`画布不存在: ${id}`);
            const currentRevision = Number(current.revision || 0);
            {
                const existing = this.db.prepare("SELECT b.project_id AS projectId, b.revision, b.operations_json AS operationsJson, b.results_json AS resultsJson, r.request_hash AS requestHash FROM canvas_operation_batches b LEFT JOIN canvas_command_receipts r ON r.operation_id = b.operation_id WHERE b.operation_id = ?").get(operationId) as { projectId: string; revision: number; operationsJson: string; resultsJson: string; requestHash?: string } | undefined;
                if (existing) {
                    if (existing.projectId !== id || existing.requestHash !== fingerprint) throw collaborationError("OPERATION_ID_REUSED", "operationId 已用于不同请求，请勿修改重试请求内容");
                    const project = this.canvasProjectAt(id, Number(existing.revision));
                    this.db.exec("COMMIT");
                    return { project, revision: Number(existing.revision), operationId, operationResults: JSON.parse(existing.resultsJson), operations: JSON.parse(existing.operationsJson), duplicated: true };
                }
            }
            if (!operations.length || operations.some((operation) => !operation || typeof operation.type !== "string")) throw new Error("operations 必须为非空有效操作数组");
            if (context?.baseRevision !== undefined) {
                const history = this.readCanvasChanges(id, context.baseRevision);
                const conflicts = history.reset ? ["history"] : concurrentCommandConflicts(operations, history.commits.flatMap((entry) => entry.operations));
                if (conflicts.length) throw Object.assign(collaborationError("FIELD_CONFLICT", "目标字段已被其他协作者修改"), { project: current, revision: currentRevision, conflictTargets: conflicts });
            }
            if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
                const error = new Error("画布版本冲突");
                (error as Error & { code?: string; project?: CanvasProject; revision?: number }).code = "REVISION_CONFLICT";
                (error as Error & { project?: CanvasProject }).project = current;
                (error as Error & { revision?: number }).revision = currentRevision;
                throw error;
            }
            const project = structuredClone(current) as Record<string, unknown>;
            this.db.prepare("INSERT OR IGNORE INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, ?, ?)").run(id, currentRevision, JSON.stringify(current));
            const operationResults = operations.flatMap((operation, index) => {
                if (operation.type === "text_suggestion") throw new Error("text_suggestion 是服务端回执，不能直接提交");
                // 文本增量与候选通知必须由本次事务计算，不能信任客户端夹带的回执字段。
                delete operation.textUpdate;
                delete operation.textUpdates;
                delete operation.textSuggestion;
                const isSuggestion = operation.type === "save_text_suggestion" || operation.type === "resolve_text_suggestion";
                const isText = isSuggestion || operation.type === "text_update" || operation.type === "text_replace";
                if (operation.type === "restore_h3_output") operations[index] = this.restoreH3OutputOperation(id, project, operation);
                if (isSuggestion) operations[index] = this.applyTextSuggestion(id, project, operation);
                else if (isText) operations[index] = this.applyCanvasTextOperation(id, project, operation);
                if (!context?.runtimeWrite && operation.type !== "restore_h3_output") prepareClientCanvasOperation(project, operations[index]);
                const result = applyCanvasProjectOperations(project, [operations[index]]);
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
            const revision = currentRevision + 1;
            project.revision = revision;
            project.updatedAt = new Date().toISOString();
            this.db.prepare("UPDATE canvas_projects SET data_json = ?, updated_at = ? WHERE id = ?")
                .run(JSON.stringify(project), String(project.updatedAt), id);
            const source = context?.source || { clientId: "system:backend", kind: "system", label: "后台" };
            this.db.prepare("INSERT INTO canvas_operation_batches (operation_id, project_id, base_revision, revision, source_json, operations_json, results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .run(operationId, id, currentRevision, revision, JSON.stringify(source), JSON.stringify(operations), JSON.stringify(operationResults), String(project.updatedAt));
            this.db.prepare("INSERT INTO canvas_command_receipts (operation_id, request_hash) VALUES (?, ?)").run(operationId, fingerprint);
            this.db.exec("COMMIT");
            commit = { projectId: id, operationId, baseRevision: currentRevision, revision, operations, operationResults, source, updatedAt: String(project.updatedAt) };
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        // 已提交的数据不能因为通知失败而被报告成事务失败，更不能尝试 ROLLBACK。
        try { this.canvasCommitListener?.(commit); } catch (error) { console.error("画布提交成功，但实时通知失败", error); }
        return { project: this.getCanvasProject(id)!, revision: commit.revision, operationId, operationResults: commit.operationResults, operations: commit.operations, duplicated: false };
    }

    writeBackH3Task(
        task: RuntimeTask,
        binding: { projectId: string; nodeId: string; segmentId: string; generationLogId?: string },
        output: Record<string, unknown> | null,
    ): { project: CanvasProject; log: GenerationLog | null; operations: CanvasOperation[] } | null {
        // 日志描述的是任务本身的终态，不受画布 Clip 是否已被另一任务接管影响。
        // 先收口日志，再用 runtimeTaskId CAS 尝试更新画布投影；否则 CAS 失败会留下永久 running 日志。
        const currentLog = binding.generationLogId ? this.getGenerationLog(binding.generationLogId) : null;
        const actualSubmission = task.result?.actualSubmission && typeof task.result.actualSubmission === "object" ? task.result.actualSubmission as Record<string, unknown> : null;
        const log = binding.generationLogId
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
        const terminalStatus = task.status === "succeeded" ? "success" : task.status === "cancelled" ? "cancelled" : "error";
        const segmentPatch: Record<string, unknown> = {
            status: terminalStatus,
            progress: task.progress,
            runtimeTaskId: "",
            ...(task.error ? { errorDetails: task.error } : {}),
        };
        if (output) {
            segmentPatch.result = output.url;
            segmentPatch.resultStorageKey = output.storageKey;
            const previousResults = Array.isArray(segments[index].results) ? segments[index].results as Array<Record<string, unknown>> : [];
            segmentPatch.results = [
                ...previousResults.filter((item) => String(item.url || "") !== String(output.url || "")),
                { ...output, name: `Clip ${index + 1}` },
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
            status: terminalStatus,
            runProgress: task.progress,
        };
        if (output) {
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
            if (recordOf(recordOf(task.input).params).writeBackToTarget === true) {
                const output = media[0];
                if (!output) throw new Error("生成完成但没有返回图片");
                const metadata = {
                    content: output.url, url: output.url, storageKey: output.storageKey || "", mimeType: output.mimeType || "image/png",
                    bytes: output.bytes, naturalWidth: output.width, naturalHeight: output.height,
                    prompt: input.prompt, model: input.model, generationType: input.references?.length ? "edit" : "generation",
                    status: "success", runProgress: 1, generationTaskId: task.id,
                };
                const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata,
                    metadataDelete: ["runtimeTaskId", "errorDetails"] }];
                const result = this.applyCanvasProjectOperations(input.projectId, Number(project.revision || 0), operations,
                    { runtimeWrite: true, operationId: `image-task-result:${task.id}`, source: { clientId: `task:${task.id}`, kind: "task", label: "图片生成任务" } });
                return { project: result.project, operations: result.operations };
            }
            if (input.imageIds) {
                if (!media.length) throw new Error("生成完成但没有返回图片");
                const slots = completedImageSlots(sourceMetadata, input.imageIds, media);
                const initialSize = recordOf(task.params.imageTargetSize);
                const keepSmartLayout = source.type === "config" && sourceMetadata.smart === true;
                const resultSize = slots.content && !keepSmartLayout && !sourceMetadata.freeResize && source.width === initialSize.width && source.height === initialSize.height
                    ? fitImageNodeSize(Number(slots.naturalWidth || 0), Number(slots.naturalHeight || 0)) : {};
                const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId,
                    patch: resultSize,
                    metadata: { ...slots, status: "success", runProgress: 1, generationTaskId: task.id },
                    metadataDelete: ["runtimeTaskId", "errorDetails"] },
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
            const metadataPatch = { status, runtimeTaskId: undefined, errorDetails,
                ...imageSlotStatus(project, input.nodeId, task.input.imageIds as string[] | undefined, status, errorDetails) };
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
            const size = !keepSmartLayout && !metadata.freeResize && node.width === initialSize.width && node.height === initialSize.height && naturalWidth > 0 && naturalHeight > 0
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

    deleteCanvasProject(id: string): number {
        return Number(this.db.prepare("DELETE FROM canvas_projects WHERE id = ?").run(id).changes);
    }

    listCanvasFolders(): CanvasFolder[] {
        const rows = this.db.prepare(
            "SELECT f.*, d.outline, d.description, d.cover_storage_key, d.tags_json, d.updated_at AS drama_updated_at, CASE WHEN d.folder_id IS NULL THEN 0 ELSE 1 END AS is_drama FROM canvas_folders f LEFT JOIN drama_projects d ON d.folder_id = f.id ORDER BY f.created_at ASC"
        ).all() as Array<Record<string, unknown>>;
        return rows.map((row) => {
            const value = JSON.parse(String(row.tags_json || "[]"));
            const tags = Array.isArray(value) ? value.map(String) : [];
            return {
                id: String(row.id), name: String(row.name), createdAt: String(row.created_at),
                updatedAt: String(row.drama_updated_at || row.created_at),
                outline: String(row.outline || ""), description: String(row.description || ""),
                coverStorageKey: row.cover_storage_key ? String(row.cover_storage_key) : null, tags,
                isDrama: Number(row.is_drama) === 1,
            };
        });
    }

    upsertCanvasFolder(folder: CanvasFolder) {
        const updatedAt = String(folder.updatedAt || new Date().toISOString());
        const tags = Array.isArray(folder.tags) ? folder.tags.map(String) : [];
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare(
                "INSERT INTO canvas_folders (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name"
            ).run(folder.id, folder.name, folder.createdAt);
            // 旧客户端没有 isDrama 字段，按原行为创建剧目；新画布普通文件夹显式传 false。
            if (folder.isDrama !== false) {
                this.db.prepare(
                    "INSERT INTO drama_projects (folder_id, outline, description, cover_storage_key, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(folder_id) DO UPDATE SET outline = excluded.outline, description = excluded.description, cover_storage_key = excluded.cover_storage_key, tags_json = excluded.tags_json, updated_at = excluded.updated_at"
                ).run(folder.id, String(folder.outline || ""), String(folder.description || ""), folder.coverStorageKey || null, JSON.stringify(tags), updatedAt);
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return { ...folder, updatedAt, outline: String(folder.outline || ""), description: String(folder.description || ""), coverStorageKey: folder.coverStorageKey || null, tags, isDrama: this.isDramaProject(folder.id) };
    }

    // ── drama_episodes ───────────────────────────────────────────
    // episode 主键是 id（nanoid），drama_id + episode_number 唯一。
    // upsertDramaEpisode 接受传入的 episode 对象，若 id 未填则随机生成；
    // 同 (drama_id, episode_number) 已存在时按 id 替换（保留原 id）。
    upsertDramaEpisode(input: { id?: string; dramaId: string; episodeNumber: number; title: string; synopsis: string; fullPlot?: string; canvasId?: string | null }): DramaEpisode {
        const now = new Date().toISOString();
        const id = input.id || `episode-${input.dramaId}-${input.episodeNumber}-${Math.random().toString(36).slice(2, 8)}`;
        const existing = this.getDramaEpisodeByNumber(input.dramaId, input.episodeNumber);
        const createdAt = existing?.createdAt || now;
        const canvasId = input.canvasId ?? null;
        const fullPlot = input.fullPlot ?? "";
        if (existing) {
            this.db.prepare(
                "UPDATE drama_episodes SET title=?, synopsis=?, full_plot=?, canvas_id=?, updated_at=? WHERE id=?"
            ).run(input.title, input.synopsis, fullPlot, canvasId, now, existing.id);
            return this.getDramaEpisode(existing.id)!;
        }
        this.db.prepare(
            "INSERT INTO drama_episodes (id, drama_id, episode_number, title, synopsis, full_plot, canvas_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, input.dramaId, input.episodeNumber, input.title, input.synopsis, fullPlot, canvasId, createdAt, now);
        return this.getDramaEpisode(id)!;
    }

    updateDramaEpisode(id: string, patch: { episodeNumber?: number; title?: string; synopsis?: string; fullPlot?: string; canvasId?: string | null }): DramaEpisode | null {
        const existing = this.getDramaEpisode(id);
        if (!existing) return null;
        const nextNumber = patch.episodeNumber ?? existing.episodeNumber;
        const nextTitle = patch.title ?? existing.title;
        const nextSynopsis = patch.synopsis ?? existing.synopsis;
        const nextFullPlot = patch.fullPlot ?? existing.fullPlot;
        const nextCanvasId = patch.canvasId === undefined ? existing.canvasId : patch.canvasId;
        const conflict = this.getDramaEpisodeByNumber(existing.dramaId, nextNumber);
        if (conflict && conflict.id !== id) throw new Error(`分集编号已存在: ${existing.dramaId}/${nextNumber}`);
        if (nextCanvasId) {
            const canvasConflict = this.getDramaEpisodeByCanvasId(nextCanvasId);
            if (canvasConflict && canvasConflict.id !== id) throw new Error(`画布已绑定到分集: ${canvasConflict.id}`);
        }
        this.db.prepare(
            "UPDATE drama_episodes SET episode_number=?, title=?, synopsis=?, full_plot=?, canvas_id=?, updated_at=? WHERE id=?"
        ).run(nextNumber, nextTitle, nextSynopsis, nextFullPlot, nextCanvasId, new Date().toISOString(), id);
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

    deleteDramaEpisode(id: string): number {
        return Number(this.db.prepare("DELETE FROM drama_episodes WHERE id = ?").run(id).changes);
    }

    private mapDramaEpisodeRow(row: Record<string, unknown>): DramaEpisode {
        return {
            id: String(row.id),
            dramaId: String(row.drama_id),
            episodeNumber: Number(row.episode_number),
            title: String(row.title || ""),
            synopsis: String(row.synopsis || ""),
            fullPlot: String(row.full_plot || ""),
            canvasId: row.canvas_id ? String(row.canvas_id) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
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

    deleteDramaProject(id: string): number {
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

    getCanvasProject(id: string): CanvasProject | null {
        const row = this.db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(id) as { data_json?: string } | undefined;
        if (!row?.data_json) return null;
        try { return stripCanvasLocalViewState(JSON.parse(row.data_json) as Record<string, unknown>) as unknown as CanvasProject; } catch { return null; }
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
                updatedAt: String(row.updated_at),
            };
        } catch { return null; }
    }

    upsertWorkflowConfig(name: string, config: {
        title?: string; backend?: string; description?: string; operation?: string;
        fieldsJson?: string; mediaInputsJson?: string; miniCardsJson?: string;
    }): void {
        const now = new Date().toISOString();
        const existing = this.getWorkflowConfig(name);
        this.db.prepare(`
            INSERT INTO workflow_configs (name, title, backend, description, operation, fields_json, media_inputs_json, mini_cards_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                title = excluded.title, backend = excluded.backend, description = excluded.description,
                operation = excluded.operation, fields_json = excluded.fields_json,
                media_inputs_json = excluded.media_inputs_json, mini_cards_json = excluded.mini_cards_json,
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
            now,
        );
    }

    deleteWorkflowConfig(name: string): number {
        return Number(this.db.prepare("DELETE FROM workflow_configs WHERE name = ?").run(name).changes);
    }

    listAssets(options: { kind?: string; folderId?: string; dramaId?: string } = {}): Asset[] {
        const clauses: string[] = [];
        const values: Array<string | null> = [];
        if (options.kind) { clauses.push("kind = ?"); values.push(options.kind); }
        if (options.folderId) { clauses.push("folder_id = ?"); values.push(options.folderId); }
        if (options.dramaId) { clauses.push("drama_id = ?"); values.push(options.dramaId); }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db.prepare(`SELECT * FROM assets ${where} ORDER BY updated_at DESC`).all(...values) as Array<Record<string, unknown>>;
        return rows.map(assetFromRow);
    }

    getAsset(id: string): Asset | null {
        const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? assetFromRow(row) : null;
    }

    upsertAsset(asset: Asset) {
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
        return this.getAsset(asset.id)!;
    }

    replaceAssets(assets: Asset[], folders: AssetFolder[]) {
        const now = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("DELETE FROM assets").run();
            this.db.prepare("DELETE FROM asset_folders").run();
            const insertFolder = this.db.prepare("INSERT INTO asset_folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)");
            for (const folder of folders) insertFolder.run(folder.id, folder.name, folder.parentId, folder.createdAt);
            const insertAsset = this.db.prepare(`
                INSERT INTO assets (id, kind, title, cover_url, tags_json, folder_id, drama_id, data_json, note, source, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const asset of assets) {
                const dramaId = asset.dramaId && this.db.prepare("SELECT 1 FROM drama_projects WHERE folder_id = ?").get(asset.dramaId) ? asset.dramaId : null;
                insertAsset.run(
                    asset.id, asset.kind, asset.title ?? "", asset.coverUrl ?? "", JSON.stringify(asset.tags ?? []),
                    asset.folderId ?? null, dramaId, JSON.stringify(asset.data ?? {}), asset.note ?? null, asset.source ?? null,
                    JSON.stringify(asset.metadata ?? {}), asset.createdAt ?? now, asset.updatedAt ?? now,
                );
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    deleteAsset(id: string): number {
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
            INSERT INTO media_files (storage_key, file_path, mime_type, file_size, width, height, duration_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(storage_key) DO UPDATE SET
                file_path = excluded.file_path, mime_type = excluded.mime_type,
                file_size = excluded.file_size, width = excluded.width,
                height = excluded.height, duration_ms = excluded.duration_ms
        `).run(
            media.storageKey, media.filePath, media.mimeType, media.bytes,
            media.width, media.height, media.durationMs, media.createdAt,
        );
    }

    getMediaFile(storageKey: string): MediaFile | null {
        const row = this.db.prepare("SELECT * FROM media_files WHERE storage_key = ?").get(storageKey) as Record<string, unknown> | undefined;
        return row ? mediaFromRow(row) : null;
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
                "SELECT id FROM generation_logs WHERE project_id = ? AND json_extract(params_json, '$.legacyLogId') = ? LIMIT 1"
            ).get(input.projectId, legacyId) as { id?: string } | undefined;
            if (existing?.id) return this.getGenerationLog(existing.id)!;
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT INTO generation_logs
                (id, project_id, node_id, segment_id, status, platform, workflow, model, task_mode, prompt,
                 references_json, input_counts_json, runtime_task_id, prompt_id, started_at, finished_at,
                 duration_ms, outputs_json, error, params_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, input.projectId, input.nodeId || null, input.segmentId || null, input.status, input.platform,
            input.workflow || null, input.model || null, input.taskMode || null, input.prompt || null,
            JSON.stringify(input.references || []), JSON.stringify(input.inputCounts || {}),
            input.runtimeTaskId || null, input.promptId || null,
            input.startedAt || now, input.finishedAt || null, input.durationMs || 0,
            JSON.stringify(input.outputs || []), input.error || null,
            JSON.stringify(input.params || {}), now, now,
        );
        // 每项目保留最近 500 条
        this.db.prepare(
            "DELETE FROM generation_logs WHERE project_id = ? AND id NOT IN (SELECT id FROM generation_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 500)"
        ).run(input.projectId, input.projectId);
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
                node_id=?, segment_id=?, status=?, platform=?, workflow=?, model=?, task_mode=?, prompt=?,
                references_json=?, input_counts_json=?, runtime_task_id=?, prompt_id=?,
                started_at=?, finished_at=?, duration_ms=?, outputs_json=?, error=?, params_json=?, updated_at=?
            WHERE id=?
        `).run(
            next.nodeId || null, next.segmentId || null, next.status, next.platform,
            next.workflow || null, next.model || null, next.taskMode || null, next.prompt || null,
            JSON.stringify(next.references || []), JSON.stringify(next.inputCounts || {}),
            next.runtimeTaskId || null, next.promptId || null,
            next.startedAt, next.finishedAt || null, next.durationMs || 0,
            JSON.stringify(next.outputs || []), next.error || null,
            JSON.stringify(next.params || {}), next.updatedAt, id,
        );
        return this.getGenerationLog(id)!;
    }

    getGenerationLog(id: string): GenerationLog | null {
        const row = this.db.prepare("SELECT * FROM generation_logs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? generationLogFromRow(row) : null;
    }

    listGenerationLogs(options: { projectId?: string; nodeId?: string; segmentId?: string; runtimeTaskId?: string; platform?: string; model?: string; status?: GenerationLogStatus; from?: string; to?: string; limit?: number; offset?: number } = {}): GenerationLog[] {
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (options.projectId) { clauses.push("project_id = ?"); values.push(options.projectId); }
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
            `SELECT * FROM generation_logs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(...values, limit, offset) as Array<Record<string, unknown>>;
        return rows.map(generationLogFromRow);
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
        return out;
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
        const taskStatusQuery = this.db.prepare("SELECT status FROM tasks WHERE id = ?");
        const taskStatusesByStatus = new Map<string, number>();
        const taskOutcomesByToolMap = new Map<string, number>();
        for (const link of observedTasks.links) {
            const row = taskStatusQuery.get(link.taskId) as { status?: unknown } | undefined;
            const status = String(row?.status || "missing");
            taskStatusesByStatus.set(status, (taskStatusesByStatus.get(status) || 0) + 1);
            const key = `${link.tool}\u0000${status}`;
            taskOutcomesByToolMap.set(key, (taskOutcomesByToolMap.get(key) || 0) + 1);
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
            transitions: transitions.map((row) => ({ fromTool: String(row.from_tool || ""), toTool: String(row.to_tool || ""), count: Number(row.count || 0) })),
            daily: daily.map((row) => {
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
            }),
            dailyByTool: dailyByToolMetrics,
            filters: {
                from: options.from || null,
                to: options.to || null,
            },
            diagnostics,
        };
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
            ).run(id, kind, JSON.stringify(input), JSON.stringify(params), now, now, fields.projectId, fields.nodeId, fields.segmentId, fields.model, fields.isImage, fields.isVideo);
        } catch (error) {
            // 客户端传来的 id 已存在（重试 / 多标签）→ 直接复用该任务，让新请求接上同一行记录。
            const existing = this.getTask(id);
            if (existing) return existing;
            throw error;
        }
        return this.getTask(id)!;
    }

    updateTask(id: string, patch: { status?: RuntimeTaskStatus; progress?: number; result?: Record<string, unknown> | null; error?: string | null }): RuntimeTask {
        const current = this.getTask(id);
        if (!current) throw new Error(`Task not found: ${id}`);
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        this.db.prepare(
            "UPDATE tasks SET status = ?, progress = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?"
        ).run(
            next.status,
            Math.max(0, Math.min(1, next.progress)),
            next.result == null ? null : JSON.stringify(next.result),
            next.error || null,
            next.updatedAt,
            id,
        );
        return this.getTask(id)!;
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

    listTasks(filter: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number } = {}): RuntimeTask[] {
        const clauses: string[] = [];
        const values: Array<string | number> = [];
        if (filter.status) { clauses.push("status = ?"); values.push(filter.status); }
        if (filter.kind) { clauses.push("kind = ?"); values.push(filter.kind); }
        if (filter.model) { clauses.push("model = ?"); values.push(filter.model); }
        if (filter.projectId) { clauses.push("project_id = ?"); values.push(filter.projectId); }
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
        const limit = Math.max(1, Math.min(500, Number(filter.limit || 500)));
        const offset = Math.max(0, Number(filter.offset || 0));
        const rows = this.db.prepare(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as Array<Record<string, unknown>>;
        return rows.map((row) => this.taskFromRow(row));
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
                    .run(input.json, params.json, result?.json ?? null, String(row.id));
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
    return {
        where: clauses.length ? `AND ${clauses.join(" AND ")}` : "",
        whereWhere: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
        params,
    };
}

function redactJsonColumn(value: unknown) {
    const json = String(value ?? "");
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
        const createdTaskIds = Array.isArray(output.createdTaskIds)
            ? [...new Set(output.createdTaskIds.map(String).filter(Boolean))]
            : [];
        const scalarTaskId = row.task_id ? String(row.task_id) : "";
        const taskIds = [...new Set([...createdTaskIds, ...(scalarTaskId ? [scalarTaskId] : [])])];
        const declaredCount = typeof output.taskCount === "number" ? output.taskCount : undefined;
        if (declaredCount != null && declaredCount > taskIds.length)
            incomplete = true;
        for (const taskId of taskIds) {
            if (!links.has(taskId)) links.set(taskId, { taskId, tool: String(row.tool || "unknown") });
        }
    }
    return { links: [...links.values()], incomplete };
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
