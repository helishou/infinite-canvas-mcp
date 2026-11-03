import { productionToolNames } from "../drama/production-tools.js";
import { productionWorkspaceToolNames } from "../drama/production-workspace-contract.js";

export const MCP_PROFILES = ["full", "canvas", "h3", "production", "diagnostics"] as const;
export type McpProfile = typeof MCP_PROFILES[number];

// Task dependencies are explicit; unknown plugin tools remain full-only.
const CONTEXT = ["canvas_list_projects", "canvas_get_state", "canvas_inspect", "canvas_next", "canvas_get_selection", "canvas_image_ops", "canvas_set_active_project", "site_navigate", "assets_list", "assets_get", "models_list", "mcp_get_command_receipt", "mcp_observability_report"];
const TASKS = ["canvas_task_status", "canvas_wait_tasks", "canvas_task_cancel", "canvas_h3_confirmation", "h3_get_task", "h3_cancel_task", "comfyui_get_task", "comfyui_cancel_task", "comfyui_status", "generation_get_status"];
const REFERENCES = ["canvas_list_reference_assets", "canvas_update_reference_asset", "canvas_analyze_reference_asset", "canvas_get_storyboard_slots", "canvas_replace_storyboard_slots"];
const PRODUCTION_READS = ["production_get", "production_get_source", "production_get_workbench", "production_get_artifact", "production_get_artifact_index", "production_get_contract", "production_get_compilation", "production_get_readiness", "production_get_canvas_context", "production_get_batch", "production_get_continuity", "production_get_scene_production", "production_get_scene", "production_list_scenes", "drama_get_episode", "drama_list_episodes", "drama_get_project"];
const H3 = ["h3_get_node", "h3_get_clip", "h3_get_clip_prompt", "h3_get_clip_references", "h3_get_clip_runtime", "h3_get_node_materials", "h3_list_models", "h3_get_defaults", "h3_set_defaults", "h3_reset_defaults", "h3_prepare_clip", "h3_prepare_clip_updates", "h3_discard_clip_updates", "h3_update_clips", "h3_apply_video_plan", "h3_bind_existing_character_groups", "h3_set_reference_bindings", "h3_replace_storyboard_binding", "h3_write_storyboard_prompt", "h3_move_clip", "h3_delete_clip", "h3_preview_run", "h3_run_clip", "h3_run_all_clips", "canvas_validate_generation"];
const CANVAS = ["canvas_create_project", "canvas_delete_project", "canvas_create_node", "canvas_create_config_node", "canvas_create_generation_flow", "canvas_apply_ops", "canvas_apply_commands", "canvas_update_node", "canvas_move_nodes", "canvas_resize_node", "canvas_delete_nodes", "canvas_connect_nodes", "canvas_select_nodes", "canvas_set_generation_references", "canvas_image_input_manifest", "canvas_run_generation", "canvas_generate_text", "canvas_generate_image", "canvas_generate_image_batch", "canvas_generate_video", "canvas_generate_audio", "canvas_import_local_images", "canvas_export_snapshot", "canvas_read_text", "canvas_edit_text", "canvas_replace_text", "canvas_get_collaboration_state", "canvas_list_text_suggestions", "canvas_save_text_suggestion", "canvas_resolve_text_suggestion", "canvas_diagnose_project", "canvas_fix_diagnostics", "assets_add", "assets_upsert_batch"];
const PRODUCTION = [...productionToolNames, ...productionWorkspaceToolNames, "production_compile", "production_get_compilation", "production_apply_compilation", "production_translate_compiled_prompts", "production_diagnose_bindings", "production_diagnose_clips", "production_get_contract", "production_initialize_from_current_demand", "drama_create_project", "drama_create_episode", "drama_update_episode", "drama_set_active_project", "director_subagent"];
const FORMAL_EDIT = ["production_edit", "production_compile", "production_apply_compilation", "production_translate_compiled_prompts", "production_diagnose_bindings", "production_diagnose_clips"];
const H3_READS = ["h3_get_node", "h3_get_clip", "h3_get_clip_prompt", "h3_get_clip_references", "h3_get_clip_runtime", "h3_get_node_materials", "h3_get_task", "h3_list_models", "h3_get_defaults", "h3_preview_run", "canvas_validate_generation"];

const PROFILE_TOOLS: Record<Exclude<McpProfile, "full">, ReadonlySet<string>> = {
    canvas: new Set([...CONTEXT, ...TASKS, ...CANVAS, ...REFERENCES, ...PRODUCTION_READS]),
    h3: new Set([...CONTEXT, ...TASKS, ...H3, ...REFERENCES, ...PRODUCTION_READS, ...FORMAL_EDIT, "canvas_import_local_images", "canvas_export_snapshot"]),
    production: new Set([...CONTEXT, ...TASKS, ...PRODUCTION, ...PRODUCTION_READS, ...H3_READS, "h3_update_clips", "h3_set_reference_bindings", "h3_bind_existing_character_groups", ...REFERENCES, "canvas_import_local_images", "canvas_generate_image_batch"]),
    diagnostics: new Set([...CONTEXT, ...PRODUCTION_READS, ...H3_READS, "canvas_task_status", "canvas_wait_tasks", "comfyui_status", "comfyui_get_task", "generation_get_status", "production_diagnose_bindings", "production_diagnose_clips", "production_preflight", "production_check_continuity", "canvas_diagnose_project", "canvas_export_snapshot", "canvas_get_collaboration_state"]),
};

export function isMcpProfile(value: unknown): value is McpProfile {
    return typeof value === "string" && (MCP_PROFILES as readonly string[]).includes(value);
}

export function isToolInProfile(profile: McpProfile, name: string): boolean {
    return profile === "full" || PROFILE_TOOLS[profile].has(name);
}
