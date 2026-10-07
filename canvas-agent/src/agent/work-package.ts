import { compilationHash, compilationScopeInput, type CompilationScope } from "../drama/compilation-scope.js";
import { productionSceneEntries, type DirectorProduction } from "../drama/production-contract.js";

export const directorRoleModules = { story: ["story"], shots: ["shots", "performance", "effects"], assets: ["assets"], continuity: ["continuity"], review: ["continuity"] } as const;
export type DirectorRole = keyof typeof directorRoleModules;
export type DirectorWorkPolicy = {
    contentDeliveryMode: "auto_file_batch" | "interactive_segment";
    authorization: { id: string; inputHash: string; purpose: "creative_advice" };
};
export type DirectorAdoption = { operationId: string; revision: number; sourceHash: string; opsHash: string; artifactHash?: string };
export function directorWorkPolicy(mode: DirectorWorkPolicy["contentDeliveryMode"] | undefined, id: string, inputHash: string): DirectorWorkPolicy {
    return { contentDeliveryMode: mode || "auto_file_batch", authorization: { id, inputHash, purpose: "creative_advice" } };
}
export function directorAdoption(operationId: string, revision: number, sourceHash: string, ops: unknown, artifactHash: string): DirectorAdoption {
    // Provenance hashes the operation without its own adoption metadata.
    const semantic = (value: unknown): unknown => Array.isArray(value) ? value.map(semantic) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "workAdoptions").map(([key, item]) => [key, semantic(item)])) : value;
    return { operationId, revision, sourceHash, opsHash: compilationHash(semantic(ops)), artifactHash };
}
export type DirectorWorkPackage = {
    schemaVersion: 1; owner: { kind: "episode" | "canvas"; id: string }; projectId: string;
    revision: number; sourceHash: string; inputHash: string; scope?: CompilationScope;
    runtimeId: string; contractHash: string; modules: readonly string[]; skillPaths: string[];
    director: DirectorProduction;
    policy?: DirectorWorkPolicy;
    media?: Array<{ targetId: string; storageKey: string; sha256: string; mimeType: string }>;
    workerThreadId?: string; workerTurnId?: string;
};
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
const key = (item: Record<string, any>) => String(item.asset_id || item.id || "");

/** Runtime progress and compiler receipts are not authored inputs. */
export function directorWorkInput(director: DirectorProduction, scope?: CompilationScope) {
    const projection = scope ? compilationScopeInput(director, scope) : undefined;
    const selected = projection?.director || director;
    const assets = Object.fromEntries(Object.entries(selected.assets).map(([id, asset]) => [id, {
        nodeId: asset.nodeId, assetId: asset.assetId, version: asset.version, status: asset.status,
        storageKey: asset.storageKey, sha256: asset.sha256, sharedSource: asset.sharedSource, inputOutdated: asset.inputOutdated,
    }]));
    const source = { ...selected.source }; delete source._canvas_continuity_asset_registry;
    return { director: structuredClone(selected), inputHash: compilationHash({
        source, assets, shotInputs: selected.shotInputs, boundaries: selected.boundaries,
    }) };
}

/** Compare actual edits, including IDs and ledger ownership, rather than trusting the requested ops. */
export function assertDirectorWorkScope(before: DirectorProduction, after: DirectorProduction, scopes?: CompilationScope | Array<CompilationScope | undefined>) {
    if (compilationHash(before.assets) !== compilationHash(after.assets) || compilationHash(before.engine) !== compilationHash(after.engine)
        || compilationHash(before.workflow) !== compilationHash(after.workflow) || after.executionAuthorized && !before.executionAuthorized) throw new Error("ADOPTION_PROTECTED_FIELDS: 建议不能改变资产批准、引擎、运行状态或生成授权");
    const ranges = Array.isArray(scopes) ? scopes : [scopes];
    if (ranges.some(scope => !scope)) return;
    const allowed = new Set<string>(), shotIds = new Set<string>(), sceneIds = new Set<string>(), blockIds = new Set<string>();
    for (const scope of ranges as CompilationScope[]) {
        const scene = scope.sceneId ? productionSceneEntries(before.source).find(item => item.id === scope.sceneId) : undefined;
        const explicit = new Set(scope.targetIds || []);
        const localShotIds = new Set(scope.targetIds?.length ? rows(before.source.shots).filter(item => explicit.has(key(item))).map(key) : scene?.shotIds || []);
        for (const id of [...explicit, ...localShotIds]) allowed.add(id);
        if (!scope.targetIds?.length) {
            for (const item of rows(before.source.segments)) if (item.shot_ids?.length && item.shot_ids.every((id: string) => localShotIds.has(id))) allowed.add(key(item));
            for (const item of rows(before.source.asset_plan)) if (item.canvas_scope !== "shared" && item.shot_ids?.length && item.shot_ids.every((id: string) => localShotIds.has(id))) allowed.add(key(item));
            // New IDs may belong to this scene, but existing foreign IDs can never be claimed.
            const existing = new Set(["shots", "segments", "asset_plan"].flatMap(field => rows(before.source[field]).map(key)));
            for (const item of rows(after.source.shots)) if (!existing.has(key(item)) && item.source_scene_id === scope.sceneId) { localShotIds.add(key(item)); allowed.add(key(item)); }
            for (const field of ["segments", "asset_plan"]) for (const item of rows(after.source[field])) if (!existing.has(key(item)) && item.canvas_scope !== "shared" && item.shot_ids?.length && item.shot_ids.every((id: string) => localShotIds.has(id))) allowed.add(key(item));
            if (scope.sceneId) sceneIds.add(scope.sceneId);
        }
        if (scope.sceneId) {
            for (const item of rows(after.source.shots)) if (localShotIds.has(key(item)) && item.source_scene_id !== scope.sceneId) throw new Error("ADOPTION_OUTSIDE_SCOPE: 镜头不能迁往其他场次");
            const localTargets = new Set([...explicit, ...rows(before.source.segments).filter(item => item.shot_ids?.length && item.shot_ids.every((id: string) => localShotIds.has(id))).map(key)]);
            const sceneShotIds = new Set([...(scene?.shotIds || []), ...localShotIds]);
            for (const item of rows(after.source.segments)) if (localTargets.has(key(item)) && item.shot_ids?.some((id: string) => !sceneShotIds.has(id))) throw new Error("ADOPTION_OUTSIDE_SCOPE: Segment 不能跨场引用镜头");
        }
        for (const id of localShotIds) shotIds.add(id);
        if (!scope.targetIds?.length) for (const director of [before, after]) for (const item of rows(director.source.script_scenes).filter(item => (item.id || item.scene_id) === scope.sceneId)) for (const block of rows(item.blocks)) blockIds.add(key(block));
    }
    const outside = (director: DirectorProduction) => {
        const source = structuredClone(director.source);
        for (const field of ["shots", "segments", "asset_plan", "asset_cards"]) source[field] = rows(source[field]).filter(item => !allowed.has(key(item)));
        if (sceneIds.size) source.script_scenes = rows(source.script_scenes).filter(item => !sceneIds.has(String(item.id || item.scene_id)));
        if (source.ledger) {
            const ledger = source.ledger as Record<string, any>;
            for (const field of ["events", "requirements"]) ledger[field] = rows(ledger[field]).filter(item => !shotIds.has(String(item.shot_id)));
            ledger.coverage = rows(ledger.coverage).filter(item => !blockIds.has(String(item.source_anchor?.block_id || item.block_id)));
        }
        return { source, shotInputs: Object.fromEntries(Object.entries(director.shotInputs).filter(([id]) => !shotIds.has(id))), boundaries: director.boundaries.filter(item => !allowed.has(item.from) || !allowed.has(item.to)) };
    };
    if (compilationHash(outside(before)) !== compilationHash(outside(after))) throw new Error("ADOPTION_OUTSIDE_SCOPE: 实际变更越出工作包范围");
}

export function directorArtifact(inputHash: string | undefined, runtimeId: string | undefined, output: Record<string, unknown>, contractHash?: string) {
    const body = { schemaVersion: 1, inputHash, runtimeId, contractHash, output };
    return { ...body, artifactHash: compilationHash(body) };
}
