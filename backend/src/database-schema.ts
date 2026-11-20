/** Canonical fresh-database schema. Historical ALTER chains are not part of runtime. */
export const CURRENT_DATABASE_SCHEMA = String.raw`
CREATE TABLE asset_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT REFERENCES asset_folders(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );

CREATE TABLE assets (
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

CREATE TABLE canvas_collaboration_checkpoints (
                project_id TEXT PRIMARY KEY REFERENCES canvas_projects(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );

CREATE TABLE "canvas_command_receipts" (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        committed_revision INTEGER NOT NULL
    );

CREATE TABLE canvas_connections (
        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, connection_json TEXT NOT NULL,
        PRIMARY KEY(project_id,ordinal)
    );

CREATE TABLE canvas_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE canvas_nodes (
        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, ordinal INTEGER NOT NULL, node_json TEXT NOT NULL,
        PRIMARY KEY(project_id,node_id)
    );

CREATE TABLE canvas_operation_batches (
                operation_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                base_revision INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                source_json TEXT NOT NULL DEFAULT '{}',
                operations_json TEXT NOT NULL,
                results_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE canvas_production_batches (
                        run_id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                        idempotency_key TEXT NOT NULL,
                        request_hash TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        source_revision INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        targets_json TEXT NOT NULL,
                        plan_json TEXT NOT NULL,
                        engine_json TEXT,
                        settings_json TEXT NOT NULL,
                        submitted_json TEXT NOT NULL DEFAULT '[]',
                        error TEXT,
                        pause_requested INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL, execution_snapshot_json TEXT,
                        UNIQUE (project_id, idempotency_key)
                    );

CREATE TABLE canvas_production_operations (
                        operation_id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                        request_hash TEXT NOT NULL,
                        receipt_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );

CREATE TABLE canvas_production_runs (
                        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                        version INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        plan_json TEXT NOT NULL,
                        submitted_json TEXT NOT NULL DEFAULT '[]',
                        error TEXT,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (project_id, version)
                    );

CREATE TABLE canvas_production_versions (
                        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                        version INTEGER NOT NULL,
                        stage TEXT NOT NULL,
                        snapshot_json TEXT NOT NULL,
                        impact_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY (project_id, version)
                    );

CREATE TABLE canvas_productions (
                        project_id TEXT PRIMARY KEY REFERENCES canvas_projects(id) ON DELETE CASCADE,
                        revision INTEGER NOT NULL DEFAULT 0,
                        draft_json TEXT NOT NULL,
                        published_json TEXT,
                        published_version INTEGER NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL
                    , archived_at TEXT);

CREATE TABLE "canvas_projects" (
                    id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                , node_count INTEGER NOT NULL DEFAULT 0, connection_count INTEGER NOT NULL DEFAULT 0, nodes_present INTEGER NOT NULL DEFAULT 1, connections_present INTEGER NOT NULL DEFAULT 1);

CREATE TABLE canvas_text_documents (
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                target_key TEXT NOT NULL,
                state BLOB NOT NULL, document_id TEXT,
                PRIMARY KEY (project_id, target_key)
            );

CREATE TABLE canvas_text_suggestions (
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                target_key TEXT NOT NULL,
                data_json TEXT NOT NULL,
                PRIMARY KEY (project_id, id)
            );

CREATE TABLE drama_asset_adoptions_legacy_archive (
                        id TEXT PRIMARY KEY, approved_id TEXT NOT NULL, episode_id TEXT NOT NULL, scene_id TEXT,
                        target_asset_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, status TEXT NOT NULL,
                        error TEXT, updated_at TEXT NOT NULL
                    );

CREATE TABLE drama_asset_versions (
                        id TEXT PRIMARY KEY, drama_id TEXT NOT NULL REFERENCES drama_projects(folder_id) ON DELETE CASCADE,
                        asset_id TEXT NOT NULL, source_project_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
                        source_version INTEGER NOT NULL, storage_key TEXT NOT NULL, sha256 TEXT NOT NULL,
                        snapshot_json TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL,
                        UNIQUE(drama_id, asset_id, source_version, storage_key)
                    );

CREATE TABLE "drama_episodes" (
                id TEXT PRIMARY KEY,
                drama_id TEXT NOT NULL REFERENCES drama_projects(folder_id) ON DELETE CASCADE,
                episode_number INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                synopsis TEXT NOT NULL DEFAULT '',
                canvas_id TEXT REFERENCES canvas_projects(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, full_plot TEXT NOT NULL DEFAULT '',
                source_format TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '',
                UNIQUE(drama_id, episode_number),
                UNIQUE(canvas_id)
            );

CREATE TABLE drama_projects (
                folder_id TEXT PRIMARY KEY REFERENCES canvas_folders(id) ON DELETE CASCADE,
                outline TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                cover_storage_key TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            , shared_asset_canvas_id TEXT REFERENCES canvas_projects(id), production_plan_json TEXT);

CREATE TABLE drama_scene_canvases (
                    scene_id TEXT PRIMARY KEY REFERENCES drama_scene_instances(id) ON DELETE CASCADE,
                    canvas_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE RESTRICT,
                    created_at TEXT NOT NULL,
                    UNIQUE(canvas_id)
                );

CREATE TABLE drama_scene_instances (
                    id TEXT PRIMARY KEY,
                    drama_id TEXT NOT NULL REFERENCES drama_projects(folder_id) ON DELETE CASCADE,
                    episode_id TEXT REFERENCES drama_episodes(id) ON DELETE SET NULL,
                    source_scene_key TEXT NOT NULL,
                    environment_id TEXT,
                    scene_order INTEGER NOT NULL DEFAULT 0,
                    title TEXT NOT NULL DEFAULT '',
                    source_hash TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(drama_id, source_scene_key)
                );

CREATE TABLE episode_production_batches (
                        run_id TEXT PRIMARY KEY,
                        episode_id TEXT NOT NULL REFERENCES drama_episodes(id) ON DELETE CASCADE,
                        idempotency_key TEXT NOT NULL,
                        request_hash TEXT NOT NULL,
                        version INTEGER NOT NULL,
                        source_revision INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        targets_json TEXT NOT NULL,
                        plan_json TEXT NOT NULL,
                        engine_json TEXT,
                        settings_json TEXT NOT NULL,
                        submitted_json TEXT NOT NULL DEFAULT '[]',
                        error TEXT,
                        pause_requested INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL, execution_snapshot_json TEXT,
                        UNIQUE (episode_id, idempotency_key)
                    );

CREATE TABLE episode_production_operations (
                        operation_id TEXT PRIMARY KEY,
                        episode_id TEXT NOT NULL REFERENCES drama_episodes(id) ON DELETE CASCADE,
                        request_hash TEXT NOT NULL,
                        receipt_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );

CREATE TABLE episode_production_runs (
                        episode_id TEXT NOT NULL REFERENCES drama_episodes(id) ON DELETE CASCADE,
                        version INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        plan_json TEXT NOT NULL,
                        submitted_json TEXT NOT NULL DEFAULT '[]',
                        error TEXT,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (episode_id, version)
                    );

CREATE TABLE episode_production_versions (
                        episode_id TEXT NOT NULL REFERENCES drama_episodes(id) ON DELETE CASCADE,
                        version INTEGER NOT NULL,
                        stage TEXT NOT NULL,
                        snapshot_json TEXT NOT NULL,
                        impact_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY (episode_id, version)
                    );

CREATE TABLE episode_productions (
                        episode_id TEXT PRIMARY KEY REFERENCES drama_episodes(id) ON DELETE CASCADE,
                        revision INTEGER NOT NULL DEFAULT 0,
                        draft_json TEXT NOT NULL,
                        published_json TEXT,
                        published_version INTEGER NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL
                    , archived_at TEXT);

CREATE TABLE generation_logs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT,
                segment_id TEXT,
                status TEXT NOT NULL,
                platform TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'pipeline',
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

CREATE TABLE h3_reference_legacy_archive (
                project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                legacy_json TEXT NOT NULL,
                archived_at TEXT NOT NULL,
                PRIMARY KEY(project_id, node_id, segment_id)
            );

CREATE TABLE mcp_command_receipts (
                    operation_id TEXT PRIMARY KEY,
                    tool TEXT NOT NULL,
                    target_id TEXT,
                    project_id TEXT REFERENCES canvas_projects(id) ON DELETE CASCADE,
                    request_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('prepared','committed','rejected')),
                    payload_json TEXT,
                    receipt_json TEXT,
                    committed_revision INTEGER,
                    error_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

CREATE TABLE mcp_observability_events (
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

CREATE TABLE media_files (
                storage_key TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                width INTEGER,
                height INTEGER,
                duration_ms INTEGER,
                created_at TEXT NOT NULL
            , sha256 TEXT);

CREATE TABLE plugin_declarations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                tools_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );

CREATE TABLE production_clip_refresh_jobs (
                    owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, operation_id TEXT NOT NULL,
                    parent_operation_id TEXT NOT NULL, compilation_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, job_json TEXT NOT NULL,
                    PRIMARY KEY (owner_kind, owner_id, operation_id));

CREATE TABLE production_clip_source_dependencies (
                    owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, segment_id TEXT NOT NULL,
                    source_project_id TEXT NOT NULL, source_node_id TEXT NOT NULL, binding_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL, subject_id TEXT, role TEXT NOT NULL,
                    PRIMARY KEY(owner_kind, owner_id, segment_id, binding_id));

CREATE TABLE production_compilation_jobs (
                    owner TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    prepared_id TEXT,
                    status TEXT NOT NULL,
                    expected_revision INTEGER NOT NULL,
                    source_hash TEXT,
                    engine_runtime_id TEXT,
                    compiler_hash TEXT,
                    packet_gzip BLOB,
                    packet_hash TEXT,
                    job_gzip BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(owner, operation_id),
                    UNIQUE(prepared_id)
                );

CREATE TABLE production_continuity_reports (
                    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('episode','canvas','scene')),
                    owner_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    snapshot TEXT NOT NULL CHECK(snapshot IN ('draft','published')),
                    source_hash TEXT NOT NULL,
                    runtime_id TEXT,
                    checked_at TEXT,
                    report_gzip BLOB NOT NULL,
                    result_gzip BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(owner_kind, owner_id, operation_id)
                );

CREATE TABLE production_layout_plans (
                    project_id TEXT PRIMARY KEY REFERENCES canvas_projects(id) ON DELETE CASCADE,
                    plan_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

CREATE TABLE production_operation_keys (
                    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('episode','canvas')),
                    owner_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    committed_revision INTEGER,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(owner_kind, owner_id, operation_id)
                );

CREATE TABLE production_preparations (
                        operation_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                        bindings_json TEXT, receipt_json TEXT
                    , layout_plan_json TEXT, layout_receipt_json TEXT);

CREATE TABLE production_scene_archives (
                    archive_id TEXT PRIMARY KEY,
                    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('episode','canvas')),
                    owner_id TEXT NOT NULL,
                    scene_id TEXT NOT NULL,
                    scene_title TEXT NOT NULL,
                    delete_operation_id TEXT NOT NULL UNIQUE,
                    deleted_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    restored_at TEXT,
                    restore_operation_id TEXT
                );

CREATE TABLE production_source_lifecycle_events (
                    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('episode','canvas')),
                    owner_id TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    generation INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('alive','deleted')),
                    snapshot_json TEXT,
                    operation_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(owner_kind, owner_id, entity_type, entity_id, revision)
                );

CREATE TABLE production_source_lifecycle_floors (
                    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('episode','canvas')),
                    owner_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    PRIMARY KEY(owner_kind, owner_id)
                );

CREATE TABLE production_task_bindings (
                        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
                        owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL,
                        source_hash TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
                        project_id TEXT NOT NULL, node_id TEXT NOT NULL, targets_json TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'submitted', error TEXT
                    );

CREATE TABLE runtime_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE scene_production_batches (
                    run_id TEXT PRIMARY KEY,
                    scene_id TEXT NOT NULL REFERENCES drama_scene_instances(id) ON DELETE CASCADE,
                    idempotency_key TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    source_revision INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    targets_json TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    engine_json TEXT,
                    settings_json TEXT NOT NULL,
                    submitted_json TEXT NOT NULL DEFAULT '[]',
                    error TEXT,
                    pause_requested INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, execution_snapshot_json TEXT,
                    UNIQUE (scene_id, idempotency_key)
                );

CREATE TABLE scene_production_operations (
                    operation_id TEXT PRIMARY KEY,
                    scene_id TEXT NOT NULL REFERENCES drama_scene_instances(id) ON DELETE CASCADE,
                    request_hash TEXT NOT NULL,
                    receipt_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

CREATE TABLE scene_production_runs (
                    scene_id TEXT NOT NULL REFERENCES drama_scene_instances(id) ON DELETE CASCADE,
                    version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    submitted_json TEXT NOT NULL DEFAULT '[]',
                    error TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (scene_id, version)
                );

CREATE TABLE scene_production_versions (
                    scene_id TEXT NOT NULL REFERENCES drama_scene_instances(id) ON DELETE CASCADE,
                    version INTEGER NOT NULL,
                    stage TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    impact_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (scene_id, version)
                );

CREATE TABLE scene_productions (
                    scene_id TEXT PRIMARY KEY REFERENCES drama_scene_instances(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL DEFAULT 0,
                    draft_json TEXT NOT NULL,
                    published_json TEXT,
                    published_version INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

CREATE TABLE shared_library_receipts (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL);

CREATE TABLE task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE task_history_tombstones (
                        task_id TEXT PRIMARY KEY,
                        kind TEXT NOT NULL,
                        terminal_status TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        terminal_at TEXT NOT NULL,
                        pruned_at TEXT NOT NULL,
                        policy_version INTEGER NOT NULL
                    );

CREATE TABLE tasks (
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
            , project_id TEXT, node_id TEXT, segment_id TEXT, model TEXT, is_image INTEGER NOT NULL DEFAULT 0, is_video INTEGER NOT NULL DEFAULT 0);

CREATE TABLE workflow_configs (
                name TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                backend TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                operation TEXT NOT NULL DEFAULT '',
                fields_json TEXT NOT NULL DEFAULT '[]',
                media_inputs_json TEXT NOT NULL DEFAULT '{}',
                mini_cards_json TEXT NOT NULL DEFAULT '{}',
                runninghub_profile_id TEXT NOT NULL DEFAULT '',
                run_target TEXT NOT NULL DEFAULT 'local',
                output_nodes_json TEXT NOT NULL DEFAULT '',
                preview_node_id TEXT NOT NULL DEFAULT '',
                duration_target_json TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );

CREATE INDEX assets_drama ON assets(drama_id);

CREATE INDEX assets_folder ON assets(folder_id);

CREATE INDEX assets_kind ON assets(kind);

CREATE INDEX canvas_command_receipts_project ON canvas_command_receipts(project_id);

CREATE INDEX canvas_nodes_project_ordinal ON canvas_nodes(project_id,ordinal);

CREATE INDEX canvas_operation_batches_project_revision ON canvas_operation_batches(project_id, revision);

CREATE INDEX canvas_production_batches_status ON canvas_production_batches(status, updated_at);

CREATE INDEX clip_refresh_parent ON production_clip_refresh_jobs(owner_kind, owner_id, parent_operation_id);

CREATE INDEX clip_refresh_pending ON production_clip_refresh_jobs(owner_kind, status);

CREATE INDEX drama_episodes_canvas_id ON drama_episodes(canvas_id);

CREATE INDEX drama_episodes_drama_id ON drama_episodes(drama_id);

CREATE INDEX drama_scene_instances_environment ON drama_scene_instances(environment_id);

CREATE INDEX drama_scene_instances_episode ON drama_scene_instances(episode_id);

CREATE INDEX drama_scene_instances_order ON drama_scene_instances(drama_id, scene_order);

CREATE UNIQUE INDEX drama_shared_asset_canvas ON drama_projects(shared_asset_canvas_id);

CREATE INDEX episode_production_batches_status ON episode_production_batches(status, updated_at);

CREATE INDEX episode_production_operations_episode ON episode_production_operations(episode_id);

CREATE INDEX generation_logs_created_global ON generation_logs(created_at DESC, id DESC);

CREATE INDEX generation_logs_project_created ON generation_logs(project_id, created_at DESC);

CREATE INDEX generation_logs_status_updated ON generation_logs(status, updated_at);

CREATE INDEX mcp_command_receipts_project ON mcp_command_receipts(project_id, created_at);

CREATE INDEX mcp_observability_created_at ON mcp_observability_events(created_at);

CREATE INDEX mcp_observability_tool_event ON mcp_observability_events(tool, event, created_at);

CREATE INDEX mcp_observability_trace ON mcp_observability_events(trace_id, created_at);

CREATE INDEX production_compilation_jobs_status ON production_compilation_jobs(status, updated_at);

CREATE INDEX production_continuity_reports_read ON production_continuity_reports(owner_kind, owner_id, snapshot, checked_at DESC);

CREATE INDEX production_operation_keys_lookup ON production_operation_keys(operation_id);

CREATE UNIQUE INDEX production_scene_archives_active ON production_scene_archives(owner_kind, owner_id, scene_id) WHERE restored_at IS NULL;

CREATE INDEX production_scene_archives_expiry ON production_scene_archives(owner_kind, owner_id, expires_at, restored_at);

CREATE INDEX production_source_lifecycle_revision ON production_source_lifecycle_events(owner_kind, owner_id, revision);

CREATE INDEX production_source_node_consumers ON production_clip_source_dependencies(source_project_id, source_node_id, owner_kind, owner_id);

CREATE INDEX production_task_bindings_owner ON production_task_bindings(owner_kind, owner_id, target_id);

CREATE INDEX scene_production_batches_status ON scene_production_batches(status, updated_at);

CREATE INDEX scene_production_operations_scene ON scene_production_operations(scene_id);

CREATE INDEX task_events_task_id_id ON task_events(task_id, id);

CREATE INDEX tasks_created_global ON tasks(created_at DESC, id DESC);

CREATE INDEX tasks_model_created ON tasks(model, created_at DESC);

CREATE INDEX tasks_project_kind_status_created ON tasks(project_id, kind, status, created_at DESC);

CREATE INDEX tasks_project_node_segment_created ON tasks(project_id, node_id, segment_id, created_at DESC);

CREATE INDEX tasks_status_created ON tasks(status, created_at DESC);

CREATE INDEX tasks_status_updated ON tasks(status, updated_at);

CREATE TRIGGER episode_canvas_role_insert BEFORE INSERT ON drama_episodes
                    WHEN NEW.canvas_id IS NOT NULL AND (
                        EXISTS(SELECT 1 FROM drama_projects WHERE shared_asset_canvas_id=NEW.canvas_id) OR
                        EXISTS(SELECT 1 FROM canvas_productions WHERE project_id=NEW.canvas_id))
                    BEGIN SELECT RAISE(ABORT, '画布已有其他制作归属，不能覆盖'); END;

CREATE TRIGGER episode_canvas_role_scene_insert BEFORE INSERT ON drama_episodes
                    WHEN NEW.canvas_id IS NOT NULL AND EXISTS(SELECT 1 FROM drama_scene_canvases WHERE canvas_id=NEW.canvas_id)
                    BEGIN SELECT RAISE(ABORT, '画布已属于制作场次，不能覆盖'); END;

CREATE TRIGGER episode_canvas_role_scene_update BEFORE UPDATE OF canvas_id ON drama_episodes
                    WHEN NEW.canvas_id IS NOT NULL AND NEW.canvas_id IS NOT OLD.canvas_id AND EXISTS(SELECT 1 FROM drama_scene_canvases WHERE canvas_id=NEW.canvas_id)
                    BEGIN SELECT RAISE(ABORT, '画布已属于制作场次，不能覆盖'); END;

CREATE TRIGGER episode_canvas_role_update BEFORE UPDATE OF canvas_id ON drama_episodes
                    WHEN NEW.canvas_id IS NOT NULL AND NEW.canvas_id IS NOT OLD.canvas_id AND (
                        EXISTS(SELECT 1 FROM drama_projects WHERE shared_asset_canvas_id=NEW.canvas_id) OR
                        EXISTS(SELECT 1 FROM canvas_productions WHERE project_id=NEW.canvas_id))
                    BEGIN SELECT RAISE(ABORT, '画布已有其他制作归属，不能覆盖'); END;

CREATE TRIGGER fixed_episode_canvas BEFORE UPDATE OF canvas_id ON drama_episodes
                    WHEN OLD.canvas_id IS NOT NULL AND NEW.canvas_id IS NOT OLD.canvas_id
                    BEGIN SELECT RAISE(ABORT, '分集画布已固定，不允许改绑或解绑'); END;

CREATE TRIGGER fixed_scene_canvas BEFORE UPDATE OF canvas_id ON drama_scene_canvases
                    WHEN OLD.canvas_id IS NOT NULL AND NEW.canvas_id IS NOT OLD.canvas_id
                    BEGIN SELECT RAISE(ABORT, '场次画布已固定，不允许改绑'); END;

CREATE TRIGGER fixed_shared_canvas BEFORE UPDATE OF shared_asset_canvas_id ON drama_projects
                    WHEN OLD.shared_asset_canvas_id IS NOT NULL AND NEW.shared_asset_canvas_id IS NOT OLD.shared_asset_canvas_id
                    BEGIN SELECT RAISE(ABORT, '共享资产画布已固定，不允许改绑或解绑'); END;

CREATE TRIGGER scene_cannot_be_episode_canvas BEFORE INSERT ON drama_scene_canvases
                    WHEN EXISTS(SELECT 1 FROM drama_episodes WHERE canvas_id=NEW.canvas_id)
                        OR EXISTS(SELECT 1 FROM drama_projects WHERE shared_asset_canvas_id=NEW.canvas_id)
                    BEGIN SELECT RAISE(ABORT, '画布已属于分集或共享资产，不能改绑给场次'); END;

CREATE TRIGGER shared_canvas_role BEFORE UPDATE OF shared_asset_canvas_id ON drama_projects
                    WHEN NEW.shared_asset_canvas_id IS NOT NULL AND EXISTS(SELECT 1 FROM drama_episodes WHERE canvas_id=NEW.shared_asset_canvas_id)
                    BEGIN SELECT RAISE(ABORT, '画布已属于分集'); END;

CREATE TRIGGER shared_canvas_role_scene BEFORE UPDATE OF shared_asset_canvas_id ON drama_projects
                    WHEN NEW.shared_asset_canvas_id IS NOT NULL AND EXISTS(SELECT 1 FROM drama_scene_canvases WHERE canvas_id=NEW.shared_asset_canvas_id)
                    BEGIN SELECT RAISE(ABORT, '画布已属于制作场次'); END;

CREATE TRIGGER task_history_tombstone_guard
                    BEFORE INSERT ON tasks
                    WHEN EXISTS (SELECT 1 FROM task_history_tombstones WHERE task_id = NEW.id)
                    BEGIN
                        SELECT RAISE(ABORT, 'task id already pruned (tombstone)');
                    END;
`;

/**
 * 运行时补建表（不进 CURRENT_DATABASE_SCHEMA，避免升 schema version；现有库有版本记录时
 * migrate() 不会重放 schema，故用 CREATE TABLE IF NOT EXISTS 在 db 构造时补建）：
 * - 全自动流水线作业队列（对齐影策 drama_jobs）→ DRAMA_PIPELINE_DDL。
 * - 强一致分集（对齐影策 chapterIDsJSON / plan_cursor / plan_done）→ DRAMA_EPISODE_PLANNING_DDL：
 *   source_chapters 存每章稳定 ID（首次切章写入、之后只复用不重算）；
 *   drama_episode_planning_state 存剧目级游标，批量建集用 plan_cursor 做 CAS、plan_done 锁写。
 * - 逐clip成片真值 → CLIP_VIDEO_VERSIONS_DDL：快照 director.artifacts 只有 h3 clip 的哈希/状态/receipt，
 *   没有成片 storageKey（唯一成片地址是整集 workflow.finalResource），逐段成片真值只在画布段上，
 *   故发布版本时按 clip 捕获画布 resultStorageKey 落此表，供版本对比逐 clip 判定成片是否更换。
 */
export const DRAMA_EPISODE_PLANNING_DDL = String.raw`
CREATE TABLE IF NOT EXISTS source_chapters (
    id TEXT PRIMARY KEY,
    drama_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL DEFAULT '',
    chars INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    source_format TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    UNIQUE(drama_id, chapter_index)
);
CREATE INDEX IF NOT EXISTS idx_source_chapters_drama ON source_chapters(drama_id, chapter_index);

CREATE TABLE IF NOT EXISTS drama_episode_planning_state (
    drama_id TEXT PRIMARY KEY,
    episode_mode TEXT NOT NULL DEFAULT 'chapter',
    plan_cursor INTEGER NOT NULL DEFAULT 0,
    plan_done INTEGER NOT NULL DEFAULT 0,
    source_fingerprint TEXT NOT NULL DEFAULT '',
    last_chapter_index INTEGER NOT NULL DEFAULT 0,
    batch_chapters INTEGER NOT NULL DEFAULT 12,
    batch_chars INTEGER NOT NULL DEFAULT 30000,
    updated_at TEXT NOT NULL
);
`;

export const DRAMA_PIPELINE_DDL = String.raw`
CREATE TABLE IF NOT EXISTS drama_pipeline_jobs (
    id TEXT PRIMARY KEY,
    drama_id TEXT NOT NULL,
    episode_id TEXT,
    kind TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT NOT NULL,
    task_id TEXT,
    label TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    attempts_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drama_pipeline_jobs_drama_status ON drama_pipeline_jobs(drama_id, status);
CREATE INDEX IF NOT EXISTS idx_drama_pipeline_jobs_dedupe ON drama_pipeline_jobs(dedupe_key);

CREATE TABLE IF NOT EXISTS drama_pipelines (
    drama_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    review_mode TEXT NOT NULL DEFAULT 'auto',
    media_mode TEXT NOT NULL DEFAULT 'auto',
    pause_reason TEXT,
    last_tick_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drama_pipeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id TEXT NOT NULL,
    job_id TEXT,
    episode_id TEXT,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drama_pipeline_events_drama ON drama_pipeline_events(drama_id, id);

-- 审批/媒体闸门放行记录（重启后恢复；对齐影策 approve/release 持久化）。
-- kind='approve' 时 target=episodeId（或 'all'）；kind='release' 时 target=媒体 target（assets/episodes/all）。
CREATE TABLE IF NOT EXISTS drama_pipeline_approvals (
    drama_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (drama_id, kind, target)
);
CREATE INDEX IF NOT EXISTS idx_drama_pipeline_approvals_drama ON drama_pipeline_approvals(drama_id, kind);
`;

/**
 * 逐clip成片真值表：逐段成片 storageKey 在画布节点上、不在版本快照里，故发布版本时按 clip
 * 捕获画布当前段结果入库；duration_ms 从 media_files 读真实值，未归档/未查到就是 null（不编造）。
 * 不进 CURRENT_DATABASE_SCHEMA（不升 schema version），老库重开由 db 构造时 CREATE IF NOT EXISTS 补建。
 */
export const CLIP_VIDEO_VERSIONS_DDL = String.raw`
CREATE TABLE IF NOT EXISTS clip_video_versions (
    episode_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    clip_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    storage_key TEXT NOT NULL,
    duration_ms INTEGER,
    source TEXT,
    generation_log_id TEXT,
    status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (episode_id, version, clip_id)
);
CREATE INDEX IF NOT EXISTS idx_clip_video_versions_episode_clip ON clip_video_versions(episode_id, clip_id, version);
`;
