/** Migration metadata only. Retired names are never registered or automatically executed. */
export const productionToolMigrationPairs = [
    ["preflight_production", "production_preflight"], ["get_production", "production_get"], ["get_workflow_readiness", "production_get_readiness"],
    ["start_production_run", "production_start_run"], ["get_production_batch", "production_get_batch"], ["pause_production_run", "production_pause_run"],
    ["resume_production_run", "production_resume_run"], ["list_production_versions", "production_list_versions"], ["get_production_version", "production_get_version"],
    ["list_production_legacy", "production_list_legacy"], ["preview_production_impact", "production_preview_impact"], ["edit_production", "production_edit"],
    ["publish_production", "production_publish"], ["restore_production", "production_restore"], ["sync_production_clips", "production_sync_clips"],
    ["get_production_run", "production_get_run"], ["export_production_markdown", "production_export_markdown"],
] as const;
export const removedToolMigrations: Record<string, { replacement: string; kind?: "episode" | "canvas"; instructions: string }> = Object.fromEntries(
    productionToolMigrationPairs.flatMap(([suffix, replacement]) => (["episode", "canvas"] as const).map(kind => [
        `${kind === "episode" ? "drama" : "canvas"}_${suffix}`, { replacement, kind, instructions: `使用 kind:${kind} 和 id 替代 ${kind === "episode" ? "episodeId" : "projectId"}，其余业务参数保留。` },
    ])),
);
Object.assign(removedToolMigrations, {
    canvas_create_image_prompt_flow: { replacement: "canvas_create_generation_flow", instructions: "显式传 mode:image，其余参数保持原样。" },
    h3_update_clip: { replacement: "h3_update_clips", instructions: "读取 revision，提供稳定 operationId、expectedRevision 和单项 updates；运行状态与结果不得进入 patch。" },
    canvas_update_node_text: { replacement: "canvas_replace_text", instructions: "先 canvas_read_text，携带 documentId、expectedText、稳定 operationId；正文与标题一起改时用 canvas_apply_commands 原子提交。" },
});
export function removedToolNotice(name: string) {
    const migration = Object.hasOwn(removedToolMigrations, name) ? removedToolMigrations[name] : undefined;
    return migration ? { ok: false, code: "TOOL_REMOVED", error: `工具 ${name} 已移除，请使用 ${migration.replacement}。${migration.instructions}`, migration } : undefined;
}
function migrateAction(action: any) {
    const knownCanonical = productionToolMigrationPairs.some(([, name]) => name === action?.tool);
    const legacyInput = action?.input;
    const migration = Object.hasOwn(removedToolMigrations, action?.tool) ? removedToolMigrations[action.tool]
        : knownCanonical && !legacyInput?.kind && Boolean(legacyInput?.episodeId) !== Boolean(legacyInput?.projectId)
            ? { replacement: action.tool, kind: (legacyInput.episodeId ? "episode" : "canvas") as "episode" | "canvas" } : undefined;
    if (!migration?.kind) return action;
    const { episodeId, projectId, ...rest } = action.input || {};
    return { ...action, tool: migration.replacement, input: { ...rest, kind: migration.kind, id: (migration.kind === "episode" ? episodeId : projectId) ?? rest.id } };
}
/** Visit response guidance containers, never authored source, prompts or historical snapshots. */
export function migrateToolGuidance(value: any): any {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const result = { ...value };
    if (result.nextRead) result.nextRead = migrateAction(result.nextRead);
    if (Array.isArray(result.nextActions)) result.nextActions = result.nextActions.map(migrateAction);
    if (Array.isArray(result.diagnostics)) result.diagnostics = result.diagnostics.map((item: any) => item.nextAction ? { ...item, nextAction: migrateAction(item.nextAction) } : item);
    for (const key of ["preflight", "production", "readiness", "error", "suggestedAction"]) if (result[key] && typeof result[key] === "object") result[key] = migrateToolGuidance(result[key]);
    return result;
}
