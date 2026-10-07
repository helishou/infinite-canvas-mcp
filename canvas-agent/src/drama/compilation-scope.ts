import crypto from "node:crypto";
import { canonicalProduction, productionSceneEntries, type DirectorProduction } from "./production-contract.js";

export type CompilationScope = { sceneId?: string; targetIds?: string[] };
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
const key = (item: Record<string, any>) => String(item.asset_id || item.id || "");
export const compilationHash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");

/** A compiler input projection, never a second authored source or an authorization. */
export function compilationScopeInput(director: DirectorProduction, scope: CompilationScope) {
    const source = director.source;
    const scene = scope.sceneId ? productionSceneEntries(source).find(item => item.id === scope.sceneId) : undefined;
    if (scope.sceneId && !scene) throw new Error("COMPILATION_SCOPE_UNKNOWN_SCENE: 编译场次不存在");
    const allShots = rows(source.shots), allSegments = rows(source.segments), plans = rows(source.asset_plan);
    const wanted = new Set(scope.targetIds || []);
    const shots = new Set(wanted.size ? [] : scene?.shotIds || []);
    for (const id of wanted) {
        if (![...allShots, ...allSegments, ...plans].some(item => key(item) === id)) throw new Error(`COMPILATION_SCOPE_UNKNOWN_TARGET: 编译目标不存在：${id}`);
        if (allShots.some(item => key(item) === id)) shots.add(id);
        for (const shotId of plans.find(item => key(item) === id)?.shot_ids || []) shots.add(String(shotId));
        const segment = allSegments.find(item => key(item) === id);
        for (const shotId of segment?.shot_ids || []) shots.add(String(shotId));
    }
    if (scene && [...shots].some(id => !scene.shotIds.includes(id))) throw new Error("COMPILATION_SCOPE_CROSS_SCENE: 目标不属于指定编译场次");
    const includeShotSegments = Boolean(scene && !wanted.size) || [...wanted].some(id => allShots.some(item => key(item) === id));
    const segments = allSegments.filter(item => wanted.has(key(item)) || includeShotSegments && (item.shot_ids || []).some((id: string) => shots.has(id)));
    for (const segment of segments) if ((segment.shot_ids || []).some((id: string) => !shots.has(id))) throw new Error("COMPILATION_SCOPE_CROSS_SCENE: Segment 跨越编译范围");
    const assets = new Set(plans.filter(item => wanted.has(key(item)) || (item.shot_ids || []).some((id: string) => shots.has(id))).map(key));
    if (scene && !wanted.size && !shots.size) for (const plan of plans) if (plan.canvas_scope === "shared") assets.add(key(plan));
    for (const shot of allShots.filter(item => shots.has(key(item)))) {
        for (const id of shot.required_assets || []) assets.add(String(id));
        const input = director.shotInputs[key(shot)];
        for (const id of input?.assetIds || []) assets.add(id);
        if (input?.keyframeAssetId) assets.add(input.keyframeAssetId);
    }
    for (const segment of segments) for (const ref of segment.references || []) if (ref.asset_id) assets.add(String(ref.asset_id));
    const visit = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return; seen.add(id);
        const card = rows(source.asset_cards).find(item => key(item) === id);
        for (const dep of [...(plans.find(item => key(item) === id)?.depends_on || []), ...rows(card?.references).map(item => item.asset_id)].filter(Boolean)) { assets.add(String(dep)); visit(String(dep), seen); }
    };
    for (const id of assets) visit(id);
    const targetIds = [...new Set([...assets, ...segments.map(key)])].sort();
    if (!targetIds.length && !shots.size && !scene) throw new Error("COMPILATION_SCOPE_EMPTY: 编译范围没有正式目标");
    const projected = structuredClone(director);
    projected.source.shots = allShots.filter(item => shots.has(key(item)));
    projected.source.segments = segments;
    projected.source.asset_plan = plans.filter(item => assets.has(key(item)));
    projected.source.asset_cards = rows(source.asset_cards).filter(item => assets.has(key(item)));
    const sceneIds = new Set(productionSceneEntries(source).filter(item => scene ? item.id === scene.id : item.shotIds.some(id => shots.has(id))).map(item => item.id));
    projected.source.script_scenes = rows(source.script_scenes).filter(item => sceneIds.has(String(item.id || item.scene_id)));
    const ledger = source.ledger as Record<string, any> | undefined;
    if (ledger?.contract_version === 2) {
        // Replay may reference registered assets outside the output scope.
        // Retain their identities as lookup context, without adding media,
        // cards or output targets to this compilation.
        projected.source._canvas_continuity_asset_registry = plans.map(item => ({ id: key(item) }));
        // Coverage belongs to authored blocks, which may span several Clips. Keep
        // its validation dependencies without adding those Clips to output targets.
        const contextShots = new Set(shots);
        const entries = productionSceneEntries(source);
        let changed = true;
        while (changed) {
            const before = contextShots.size + sceneIds.size;
            const blockIds = new Set(rows(source.script_scenes).filter(item => sceneIds.has(String(item.id || item.scene_id))).flatMap(item => rows(item.blocks).map(block => String(block.id))));
            const coverage = rows(ledger.coverage).filter(item => blockIds.has(String(item.source_anchor?.block_id || item.block_id)));
            const eventIds = new Set(coverage.flatMap(item => (item.event_ids || []).map(String)));
            for (const requirement of rows(ledger.requirements).filter(item => contextShots.has(String(item.shot_id)))) for (const eventId of requirement.event_ids || []) eventIds.add(String(eventId));
            for (const item of coverage) for (const shotId of item.shot_ids || []) if (allShots.some(shot => key(shot) === String(shotId))) contextShots.add(String(shotId));
            for (const event of rows(ledger.events)) if (eventIds.has(key(event)) && allShots.some(shot => key(shot) === String(event.shot_id))) contextShots.add(String(event.shot_id));
            // Replaying only the selected shot would lose earlier changes on its timeline.
            const lastOrders = new Map<string, number>();
            for (const shot of allShots.filter(item => contextShots.has(key(item)))) if (shot.timeline_id && Number.isFinite(Number(shot.story_order))) lastOrders.set(String(shot.timeline_id), Math.max(lastOrders.get(String(shot.timeline_id)) ?? -Infinity, Number(shot.story_order)));
            for (const shot of allShots) if (shot.timeline_id && Number(shot.story_order) <= (lastOrders.get(String(shot.timeline_id)) ?? -Infinity)) contextShots.add(key(shot));
            for (const entry of entries) if (entry.shotIds.some(id => contextShots.has(id))) sceneIds.add(entry.id);
            changed = before !== contextShots.size + sceneIds.size;
        }
        projected.source.shots = allShots.filter(item => contextShots.has(key(item)));
        projected.source.script_scenes = rows(source.script_scenes).filter(item => sceneIds.has(String(item.id || item.scene_id)));
        const blocks = new Set(rows(projected.source.script_scenes).flatMap(item => rows(item.blocks).map(block => String(block.id))));
        projected.source.ledger = { ...structuredClone(ledger),
            events: rows(ledger.events).filter(item => contextShots.has(String(item.shot_id))),
            requirements: rows(ledger.requirements).filter(item => contextShots.has(String(item.shot_id))),
            coverage: rows(ledger.coverage).filter(item => blocks.has(String(item.source_anchor?.block_id || item.block_id))),
        };
    }
    projected.assets = Object.fromEntries(Object.entries(director.assets).filter(([id]) => assets.has(id)));
    projected.shotInputs = Object.fromEntries(Object.entries(director.shotInputs).filter(([id]) => shots.has(id)));
    projected.boundaries = director.boundaries.filter(item => segments.some(s => key(s) === item.from) && segments.some(s => key(s) === item.to));
    projected.artifacts = director.artifacts.filter(item => targetIds.includes(item.targetId));
    projected.sourceHash = compilationHash(projected.source);
    // Authored global facts remain inputs. Run cursors and unrelated artifacts do not.
    const referenced = new Set<string>([
        ...rows(projected.source.asset_cards).flatMap(item => rows(item.references).map(ref => String(ref.asset_id || ""))),
        ...segments.flatMap(item => rows(item.references).map(ref => String(ref.asset_id || ""))),
        ...rows(projected.source.shots).flatMap(item => (item.required_assets || []).map(String)),
        ...rows(projected.source.asset_plan).flatMap(item => (item.depends_on || []).map(String)),
    ]);
    const inputAssets = Object.fromEntries(Object.entries(projected.assets).filter(([id]) => referenced.has(id) || Boolean(scene && !shots.size)).map(([id, asset]) => [id, { nodeId: asset.nodeId, assetId: asset.assetId, version: asset.version, storageKey: asset.storageKey, sha256: asset.sha256, sharedSource: asset.sharedSource }]));
    const bindings = Object.fromEntries(Object.entries(projected.assets).map(([id, asset]) => [id, { nodeId: asset.nodeId ?? null, assetId: asset.assetId ?? null }]));
    const hashSource = { ...projected.source };
    // This derived identity lookup is checked by the fresh continuity report;
    // it is not a model input and must preserve historical scoped receipt hashes.
    delete hashSource._canvas_continuity_asset_registry;
    const inputs = { source: hashSource, assets: inputAssets, bindings, shotInputs: projected.shotInputs, boundaries: projected.boundaries };
    const inputHash = compilationHash(inputs);
    const legacyInputHash = compilationHash({ ...inputs, engine: projected.engine });
    return { director: projected, inputHash, legacyInputHash, targetIds };
}

export function currentCompilationArtifact(director: DirectorProduction, artifact: DirectorProduction["artifacts"][number]) {
    const identity = artifact.receipt.engine as DirectorProduction["engine"] | undefined;
    if (identity && identity.runtimeId !== artifact.receipt.engineRuntimeId) return false;
    const scoped = artifact.receipt.compilationScope as { scope: CompilationScope; inputHash: string; engine?: DirectorProduction["engine"] } | undefined;
    if (!scoped) return artifact.sourceHash === director.sourceHash && artifact.receipt.sourceHash === director.sourceHash;
    if (scoped.engine && artifact.receipt.engineRuntimeId && scoped.engine.runtimeId !== artifact.receipt.engineRuntimeId) return false;
    try {
        const input = compilationScopeInput({ ...director, engine: scoped.engine || director.engine }, scoped.scope);
        return input.inputHash === scoped.inputHash || input.legacyInputHash === scoped.inputHash;
    } catch { return false; }
}

/** Record the existing receipt identity before changing a production's last compiler. */
export function preserveCompilationProvenance(director: DirectorProduction) {
    for (const artifact of director.artifacts) {
        if (!artifact.receipt.engine && artifact.receipt.engineRuntimeId === director.engine.runtimeId) artifact.receipt.engine = structuredClone(director.engine);
        const scoped = artifact.receipt.compilationScope as { engine?: DirectorProduction["engine"] } | undefined;
        if (scoped && !scoped.engine) scoped.engine = structuredClone(director.engine);
    }
    for (const work of Object.values(director.workflow.sceneWorks || {})) if (!work.inputEngine) work.inputEngine = structuredClone(director.engine);
}

/** Review identity includes actual outputs, even when an image is not a compiler reference. */
export function productionReviewHash(inputHash: string, media: Array<{ targetId: string; storageKey: string; sha256: string }>) {
    return compilationHash({ inputHash, media: media.map(({ targetId, storageKey, sha256 }) => ({ targetId, storageKey, sha256 })).sort((a, b) => a.targetId.localeCompare(b.targetId)) });
}

/** Normalize an isolated compiler timeline; authored frames and provenance stay unchanged. */
export function scopedCompilerInput(input: DirectorProduction, scope: CompilationScope) {
    const next = structuredClone(input), shots = rows(next.source.shots);
    const shifts = new Map<string, number>(); let cursor = 0;
    for (const shot of shots) {
        const start = Number(shot.start_frame), end = Number(shot.end_frame);
        if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
        shifts.set(key(shot), cursor - start); shot.start_frame = cursor; cursor += end - start; shot.end_frame = cursor;
    }
    for (const segment of rows(next.source.segments)) {
        const covered = shots.filter(shot => (segment.shot_ids || []).includes(key(shot)));
        if (covered.length) {
            const shift = shifts.get(key(covered[0])) || 0;
            for (const ref of [...rows(segment.references), ...rows(segment.subjects)]) {
                if (typeof ref.start_frame === "number") ref.start_frame += shift;
                if (typeof ref.end_frame === "number") ref.end_frame += shift;
            }
            segment.start_frame = covered[0].start_frame; segment.end_frame = covered.at(-1)!.end_frame;
        }
    }
    const ledger = next.source.ledger as Record<string, any> | undefined;
    if (ledger) for (const event of rows(ledger.events)) if (typeof event.frame === "number" && shifts.has(String(event.shot_id))) event.frame += shifts.get(String(event.shot_id))!;
    if (cursor > 0) next.source.production_total_duration = `${cursor * Number(next.source.fps_den || 1)}/${Number(next.source.fps_num || 24)}`;
    next.source.delivery_scope = "prompt_only";
    next.source._canvas_compilation_scope = { scope, authoredInputHash: compilationHash(input.source), frameShifts: Object.fromEntries(shifts) };
    next.sourceHash = compilationHash(next.source);
    return next;
}
