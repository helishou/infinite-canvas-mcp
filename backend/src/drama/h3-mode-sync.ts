import { canonicalH3TaskMode } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import type { DirectorProduction, EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import type { CanvasCommandContext } from "../canvas/collaboration.js";
import { directorHash, projectDirector, withoutDirectorProjection } from "./director.js";

const productionModeByH3Mode: Record<string, string> = {
    t2v: "T2VA", i2v: "I2VA", fl2v: "FL2VA", l2v: "L2VA", ref2va: "Ref2VA",
};

export function productionModeFromH3TaskMode(value: unknown) {
    return productionModeByH3Mode[canonicalH3TaskMode(value)];
}

const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Project the authoritative H3 mode into the Acheng mode fields for a draft view or compilation. */
export function synchronizeDirectorModesFromH3(director: DirectorProduction, project: Record<string, any>, targetIds?: ReadonlySet<string>, owner?: { kind: string; id: string }) {
    if (!isSubjectPromptAssembly(director.source)) return false;
    const h3ModeByTarget = new Map<string, string>();
    for (const node of rows(project.nodes)) {
        if (!String(node.type || "").startsWith("minimax-h3:")) continue;
        const metadata = record(node.metadata);
        if (metadata.productionArchiveLabel) continue;
        if (owner?.id && metadata.productionOwnerId && String(metadata.productionOwnerId) !== owner.id) continue;
        if (owner?.kind && metadata.productionOwnerKind && String(metadata.productionOwnerKind) !== owner.kind) continue;
        if (metadata.productionArchiveLabel) continue;
        for (const segment of rows(metadata.segments)) {
            const targetId = String(record(segment.productionClipProjection).targetId || "");
            const mode = productionModeFromH3TaskMode(segment.taskMode ?? segment.mode);
            if (targetId && mode && (!targetIds || targetIds.has(targetId))) h3ModeByTarget.set(targetId, mode);
        }
    }
    if (!h3ModeByTarget.size) return false;

    let changed = false;
    for (const segment of rows(director.source.segments)) {
        const mode = h3ModeByTarget.get(String(segment.id || ""));
        if (!mode) continue;
        const reason = "Synchronized from the authoritative H3 Clip taskMode.";
        if (segment.mode === mode && segment.mode_lock === mode && segment.mode_selection_reason === reason) continue;
        segment.mode = mode;
        segment.mode_lock = mode;
        segment.mode_selection_reason = reason;
        changed = true;
    }
    if (changed) director.sourceHash = directorHash(director.source);
    return changed;
}

function segmentRows(node: Record<string, any>) { return rows(record(node.metadata).segments); }

/** Mirror explicit H3 mode edits into the bound draft production source in the Canvas ops transaction. */
export function syncH3ModeEdits(
    db: BackendDatabase,
    projectId: string,
    before: Record<string, any>,
    after: Record<string, any>,
    context?: CanvasCommandContext,
) {
    if (context?.runtimeWrite || context?.source?.kind === "system" || String(context?.source?.clientId || "").startsWith("production:")) return [];

    const episode = db.getDramaEpisodeByCanvasId(projectId);
    const owner = episode ? { id: episode.id, kind: "episode", table: "episode_productions", column: "episode_id" }
        : db.db.prepare("SELECT 1 FROM canvas_productions WHERE project_id=?").get(projectId)
            ? { id: projectId, kind: "canvas", table: "canvas_productions", column: "project_id" }
            : null;
    if (!owner) return [];
    const beforeNodes = rows(before.nodes), afterNodes = rows(after.nodes);
    const targets = new Set<string>();
    for (const node of afterNodes) {
        if (!String(node.type || "").startsWith("minimax-h3:")) continue;
        const nodeMetadata = record(node.metadata);
        if (nodeMetadata.productionArchiveLabel) continue;
        if (nodeMetadata.productionOwnerId && String(nodeMetadata.productionOwnerId) !== owner.id) continue;
        if (nodeMetadata.productionOwnerKind && String(nodeMetadata.productionOwnerKind) !== owner.kind) continue;
        const priorNode = beforeNodes.find(item => String(item.id || "") === String(node.id || ""));
        const priorSegments = new Map(segmentRows(priorNode || {}).map(segment => [String(segment.id || ""), segment]));
        for (const segment of segmentRows(node)) {
            const targetId = String(record(segment.productionClipProjection).targetId || "");
            const segmentId = String(segment.id || "");
            if (!targetId || !segmentId) continue;
            const previous = priorSegments.get(segmentId);
            const previousMode = productionModeFromH3TaskMode(previous?.taskMode ?? previous?.mode);
            const currentMode = productionModeFromH3TaskMode(segment.taskMode ?? segment.mode);
            if (!currentMode || currentMode === previousMode) continue;
            targets.add(targetId);
        }
    }
    if (!targets.size) return [];

    const row = db.db.prepare(`SELECT revision, draft_json FROM ${owner.table} WHERE ${owner.column}=?`).get(owner.id) as { revision: number; draft_json: string } | undefined;
    if (!row) return [];
    const draft = JSON.parse(row.draft_json) as EpisodeProductionData;
    if (!draft.director || !synchronizeDirectorModesFromH3(draft.director, after, targets, owner)) return [];
    projectDirector(draft);
    const revision = row.revision + 1;
    db.db.prepare(`UPDATE ${owner.table} SET revision=?, draft_json=?, updated_at=? WHERE ${owner.column}=?`)
        .run(revision, JSON.stringify(withoutDirectorProjection(draft)), new Date().toISOString(), owner.id);
    return [{ entityId: owner.id, revision }];
}
