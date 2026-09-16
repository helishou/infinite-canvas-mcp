import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DB_FILE, MEDIA_DIR, ensureDataDirs } from "./config.js";
import { applyCanvasProjectOperations, type CanvasOperation } from "./canvas/project-ops.js";
import { redactInlineMedia } from "./runtime/redact-inline-media.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type RuntimeTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
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
export type MediaFile = {
    storageKey: string; filePath: string; mimeType: string;
    bytes: number; width: number | null; height: number | null; durationMs: number | null;
    createdAt: string;
};
export type AssetFolder = { id: string; name: string; parentId: string | null; createdAt: string };
export type CanvasFolder = {
    id: string; name: string; createdAt: string; updatedAt?: string;
    outline?: string; description?: string; coverStorageKey?: string | null; tags?: string[];
};
export type Asset = {
    id: string; kind: string; title: string; coverUrl: string; tags: string[];
    folderId: string | null; data: Record<string, unknown>; note: string | null;
    source: string | null; metadata: Record<string, unknown>;
    createdAt: string; updatedAt: string;
};
export type DramaEpisode = {
    id: string;
    dramaId: string;
    episodeNumber: number;
    title: string;
    synopsis: string;
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

    constructor(file: string = DB_FILE) {
        ensureDataDirs();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.migrate();
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
                canvas_id TEXT REFERENCES canvas_projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(drama_id, episode_number),
                UNIQUE(canvas_id)
            )`);
        }
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

    // ── canvas_projects ───────────────────────────────────────────────────

    listCanvasProjects(): CanvasProject[] {
        // v7 后画布不再有 folder_id 列；关系由 drama_episodes.canvas_id 承接。
        // 按 episode 过滤用 listCanvasProjectsByEpisode（canvas-agent / REST 那边）。
        const rows = this.db.prepare("SELECT data_json FROM canvas_projects ORDER BY updated_at DESC").all() as Array<{ data_json: string }>;
        return rows.flatMap((row) => {
            try {
                const value = JSON.parse(row.data_json) as CanvasProject;
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

    upsertCanvasProject(project: CanvasProject) {
        const now = new Date().toISOString();
        const updatedAt = String(project.updatedAt || now);
        const current = this.getCanvasProject(project.id);
        const currentRevision = Number(current?.revision || 0);
        const incomingRevision = Number(project.revision ?? currentRevision);
        // revision 是画布写入的权威顺序；旧全量快照不能靠较新的时间戳覆盖新操作。
        if (current && incomingRevision < currentRevision) return current;
        // 客户端可能持有旧的全量画布快照；不能让它覆盖 MCP 刚写入的节点状态。
        if (current && Date.parse(String(current.updatedAt || "")) > Date.parse(updatedAt)) return current;
        project.revision = Math.max(currentRevision, incomingRevision);
        // v7: 画布表已删 folder_id 列；画布与剧目/分集的关系由 drama_episodes.canvas_id 承载。
        const persistedProject = structuredClone(project) as Record<string, unknown>;
        delete persistedProject.folderId;
        this.db.prepare(
            "INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at"
        ).run(project.id, JSON.stringify(persistedProject), updatedAt);
        return this.getCanvasProject(project.id)!;
    }

    applyCanvasProjectOperations(id: string, expectedRevision: number | undefined, operations: CanvasOperation[]) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.getCanvasProject(id);
            if (!current) throw new Error(`画布不存在: ${id}`);
            const currentRevision = Number(current.revision || 0);
            if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
                const error = new Error("画布版本冲突");
                (error as Error & { code?: string; project?: CanvasProject; revision?: number }).code = "REVISION_CONFLICT";
                (error as Error & { project?: CanvasProject }).project = current;
                (error as Error & { revision?: number }).revision = currentRevision;
                throw error;
            }
            const project = structuredClone(current) as Record<string, unknown>;
            const operationResults = applyCanvasProjectOperations(project, operations);
            const revision = currentRevision + 1;
            project.revision = revision;
            project.updatedAt = new Date().toISOString();
            this.db.prepare("UPDATE canvas_projects SET data_json = ?, updated_at = ? WHERE id = ?")
                .run(JSON.stringify(project), String(project.updatedAt), id);
            this.db.exec("COMMIT");
            return { project: project as CanvasProject, revision, operationResults, operations };
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
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
            this.applyCanvasProjectOperations(binding.projectId, Number(project.revision || 0), operations);
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
        input: { projectId: string; nodeId: string; prompt: string; model: string; references?: Array<Record<string, unknown>>; resultPolicy?: "replace-active" | "append" },
        media: Array<Record<string, unknown>>,
    ): { project: CanvasProject; operations: CanvasOperation[] } | null {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const project = this.getCanvasProject(input.projectId);
            if (!project) { this.db.exec("COMMIT"); return null; }
            const nodes = Array.isArray(project.nodes) ? structuredClone(project.nodes) as Array<Record<string, any>> : [];
            const connections = Array.isArray(project.connections) ? structuredClone(project.connections) as Array<Record<string, any>> : [];
            const source = nodes.find((item) => String(item.id || "") === input.nodeId);
            if (!source || String(recordOf(source.metadata).runtimeTaskId || "") !== task.id) { this.db.exec("COMMIT"); return null; }
            const sourceMetadata = recordOf(source.metadata);
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
            const sourceMetadataPatch = { status: "success", runtimeTaskId: undefined, errorDetails: undefined, model: input.model, prompt: input.prompt, primaryImageId: createdIds[0], generatedResultIds: createdIds, generationTaskId: task.id };
            source.metadata = { ...sourceMetadata, ...sourceMetadataPatch };
            operations.push({ type: "update_node", id: input.nodeId, metadata: sourceMetadataPatch, metadataDelete: ["runtimeTaskId", "errorDetails"] });
            const nextProject: CanvasProject = { ...project, nodes, connections, revision: Number(project.revision || 0) + 1, updatedAt: new Date().toISOString() };
            this.db.prepare(
                "INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at"
            ).run(nextProject.id, JSON.stringify(nextProject), String(nextProject.updatedAt));
            this.db.exec("COMMIT");
            return { project: this.getCanvasProject(nextProject.id)!, operations };
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    markCanvasImageTaskFailed(task: RuntimeTask, input: { projectId: string; nodeId: string }, error: string): { project: CanvasProject; operations: CanvasOperation[] } | null {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const project = this.getCanvasProject(input.projectId);
            if (!project) { this.db.exec("COMMIT"); return null; }
            const nodes = Array.isArray(project.nodes) ? structuredClone(project.nodes) as Array<Record<string, any>> : [];
            const source = nodes.find((item) => String(item.id || "") === input.nodeId);
            if (!source || String(recordOf(source.metadata).runtimeTaskId || "") !== task.id) { this.db.exec("COMMIT"); return null; }
            const metadataPatch = { status: task.status === "cancelled" ? "cancelled" : "error", runtimeTaskId: undefined, errorDetails: task.status === "cancelled" ? undefined : error };
            source.metadata = { ...recordOf(source.metadata), ...metadataPatch };
            const operations: CanvasOperation[] = [{ type: "update_node", id: input.nodeId, metadata: metadataPatch, metadataDelete: task.status === "cancelled" ? ["runtimeTaskId", "errorDetails"] : ["runtimeTaskId"] }];
            const nextProject: CanvasProject = { ...project, nodes, revision: Number(project.revision || 0) + 1, updatedAt: new Date().toISOString() };
            this.db.prepare(
                "INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at"
            ).run(nextProject.id, JSON.stringify(nextProject), String(nextProject.updatedAt));
            this.db.exec("COMMIT");
            return { project: this.getCanvasProject(nextProject.id)!, operations };
        } catch (caught) {
            this.db.exec("ROLLBACK");
            throw caught;
        }
    }

    replaceCanvasProjects(projects: CanvasProject[]): CanvasProject[] {
        const now = new Date().toISOString();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("DELETE FROM canvas_projects").run();
            const insert = this.db.prepare("INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (?, ?, ?)");
            for (const project of projects) {
                if (project.id) insert.run(project.id, JSON.stringify(project), String(project.updatedAt || now));
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return this.listCanvasProjects();
    }

    deleteCanvasProject(id: string): number {
        return Number(this.db.prepare("DELETE FROM canvas_projects WHERE id = ?").run(id).changes);
    }

    listCanvasFolders(): CanvasFolder[] {
        const rows = this.db.prepare(
            "SELECT f.*, d.outline, d.description, d.cover_storage_key, d.tags_json, d.updated_at AS drama_updated_at FROM canvas_folders f LEFT JOIN drama_projects d ON d.folder_id = f.id ORDER BY f.created_at ASC"
        ).all() as Array<Record<string, unknown>>;
        return rows.map((row) => {
            const value = JSON.parse(String(row.tags_json || "[]"));
            const tags = Array.isArray(value) ? value.map(String) : [];
            return {
                id: String(row.id), name: String(row.name), createdAt: String(row.created_at),
                updatedAt: String(row.drama_updated_at || row.created_at),
                outline: String(row.outline || ""), description: String(row.description || ""),
                coverStorageKey: row.cover_storage_key ? String(row.cover_storage_key) : null, tags,
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
            this.db.prepare(
                "INSERT INTO drama_projects (folder_id, outline, description, cover_storage_key, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(folder_id) DO UPDATE SET outline = excluded.outline, description = excluded.description, cover_storage_key = excluded.cover_storage_key, tags_json = excluded.tags_json, updated_at = excluded.updated_at"
            ).run(folder.id, String(folder.outline || ""), String(folder.description || ""), folder.coverStorageKey || null, JSON.stringify(tags), updatedAt);
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return { ...folder, updatedAt, outline: String(folder.outline || ""), description: String(folder.description || ""), coverStorageKey: folder.coverStorageKey || null, tags };
    }

    // ── drama_episodes ───────────────────────────────────────────
    // episode 主键是 id（nanoid），drama_id + episode_number 唯一。
    // upsertDramaEpisode 接受传入的 episode 对象，若 id 未填则随机生成；
    // 同 (drama_id, episode_number) 已存在时按 id 替换（保留原 id）。
    upsertDramaEpisode(input: { id?: string; dramaId: string; episodeNumber: number; title: string; synopsis: string; canvasId?: string | null }): DramaEpisode {
        const now = new Date().toISOString();
        const id = input.id || `episode-${input.dramaId}-${input.episodeNumber}-${Math.random().toString(36).slice(2, 8)}`;
        const existing = this.getDramaEpisodeByNumber(input.dramaId, input.episodeNumber);
        const createdAt = existing?.createdAt || now;
        const canvasId = input.canvasId ?? null;
        if (existing) {
            this.db.prepare(
                "UPDATE drama_episodes SET title=?, synopsis=?, canvas_id=?, updated_at=? WHERE id=?"
            ).run(input.title, input.synopsis, canvasId, now, existing.id);
            return this.getDramaEpisode(existing.id)!;
        }
        this.db.prepare(
            "INSERT INTO drama_episodes (id, drama_id, episode_number, title, synopsis, canvas_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, input.dramaId, input.episodeNumber, input.title, input.synopsis, canvasId, createdAt, now);
        return this.getDramaEpisode(id)!;
    }

    updateDramaEpisode(id: string, patch: { episodeNumber?: number; title?: string; synopsis?: string; canvasId?: string | null }): DramaEpisode | null {
        const existing = this.getDramaEpisode(id);
        if (!existing) return null;
        const nextNumber = patch.episodeNumber ?? existing.episodeNumber;
        const nextTitle = patch.title ?? existing.title;
        const nextSynopsis = patch.synopsis ?? existing.synopsis;
        const nextCanvasId = patch.canvasId === undefined ? existing.canvasId : patch.canvasId;
        const conflict = this.getDramaEpisodeByNumber(existing.dramaId, nextNumber);
        if (conflict && conflict.id !== id) throw new Error(`分集编号已存在: ${existing.dramaId}/${nextNumber}`);
        if (nextCanvasId) {
            const canvasConflict = this.getDramaEpisodeByCanvasId(nextCanvasId);
            if (canvasConflict && canvasConflict.id !== id) throw new Error(`画布已绑定到分集: ${canvasConflict.id}`);
        }
        this.db.prepare(
            "UPDATE drama_episodes SET episode_number=?, title=?, synopsis=?, canvas_id=?, updated_at=? WHERE id=?"
        ).run(nextNumber, nextTitle, nextSynopsis, nextCanvasId, new Date().toISOString(), id);
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
            canvasId: row.canvas_id ? String(row.canvas_id) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        };
    }

    deleteCanvasFolder(id: string): number {
        // v7: ON DELETE CASCADE 由 drama_episodes（drama_id）和 drama_projects（folder_id）链式删除；
        // canvas_projects 表无 folder_id 列，删除画布关联由 caller 决定（drama_episodes.canvas_id 是 SET NULL）。
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
        try { return JSON.parse(row.data_json) as CanvasProject; } catch { return null; }
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

    listAssets(options: { kind?: string; folderId?: string } = {}): Asset[] {
        const clauses: string[] = [];
        const values: Array<string | null> = [];
        if (options.kind) { clauses.push("kind = ?"); values.push(options.kind); }
        if (options.folderId) { clauses.push("folder_id = ?"); values.push(options.folderId); }
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
        this.db.prepare(`
            INSERT INTO assets (id, kind, title, cover_url, tags_json, folder_id, data_json, note, source, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind, title = excluded.title, cover_url = excluded.cover_url,
                tags_json = excluded.tags_json, folder_id = excluded.folder_id,
                data_json = excluded.data_json, note = excluded.note, source = excluded.source,
                metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
        `        ).run(
            asset.id, asset.kind, asset.title ?? "",
            asset.coverUrl ?? "", JSON.stringify(asset.tags ?? []),
            asset.folderId ?? null, JSON.stringify(asset.data ?? {}),
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
                INSERT INTO assets (id, kind, title, cover_url, tags_json, folder_id, data_json, note, source, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const asset of assets) {
                insertAsset.run(
                    asset.id, asset.kind, asset.title ?? "", asset.coverUrl ?? "", JSON.stringify(asset.tags ?? []),
                    asset.folderId ?? null, JSON.stringify(asset.data ?? {}), asset.note ?? null, asset.source ?? null,
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
            this.db.prepare(
                "INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)"
            ).run(id, kind, JSON.stringify(input), JSON.stringify(params), now, now);
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

    getTask(id: string): RuntimeTask | null {
        const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        const input = parseJsonObject(row.input_json);
        const params = parseJsonObject(row.params_json);
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
            nodeId: String(input.nodeId || params.nodeId || binding.nodeId || "") || undefined,
            segmentId: String(input.segmentId || params.segmentId || binding.segmentId || "") || undefined,
            executor: String(params.executor || (String(row.kind).startsWith("comfyui:") ? "comfy" : String(row.kind))) || undefined,
            model: String(params.model || params.modelName || input.model || "") || undefined,
            outputs,
        };
    }

    listTasks(filter: { status?: RuntimeTaskStatus; kind?: string; model?: string; scope?: "all" | "canvas" | "image" | "video"; projectId?: string; nodeIds?: string[]; segmentIds?: string[]; limit?: number; offset?: number } = {}): RuntimeTask[] {
        const clauses: string[] = [];
        const values: string[] = [];
        if (filter.status) { clauses.push("status = ?"); values.push(filter.status); }
        if (filter.kind) { clauses.push("kind = ?"); values.push(filter.kind); }
        const limit = Math.max(1, Math.min(500, Number(filter.limit || 500)));
        const offset = Math.max(0, Number(filter.offset || 0));
        const rows = this.db.prepare(`SELECT id FROM tasks ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC`).all(...values) as Array<{ id: string }>;
        const nodeIds = new Set((filter.nodeIds || []).map(String));
        const segmentIds = new Set((filter.segmentIds || []).map(String));
        return rows.map((row) => this.getTask(String(row.id))).filter((task): task is RuntimeTask => Boolean(task)).filter((task) => {
            if (filter.scope === "canvas" && !task.projectId) return false;
            if (filter.scope === "image" && !/image/i.test(`${task.kind} ${task.executor || ""} ${task.model || ""}`)) return false;
            if (filter.scope === "video" && !/video|h3/i.test(`${task.kind} ${task.executor || ""} ${task.model || ""}`)) return false;
            if (filter.model && task.model !== filter.model) return false;
            if (filter.projectId && task.projectId !== filter.projectId) return false;
            if (nodeIds.size && (!task.nodeId || !nodeIds.has(task.nodeId))) return false;
            if (segmentIds.size && (!task.segmentId || !segmentIds.has(task.segmentId))) return false;
            return true;
        }).slice(offset, offset + limit);
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
