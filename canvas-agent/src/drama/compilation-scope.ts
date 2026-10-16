import crypto from "node:crypto";
import { canonicalProduction, isSubjectPromptAssembly, productionSceneEntries, resolveSubjectPictureBindingIds, type DirectorProduction } from "./production-contract.js";

export type CompilationScope = { sceneId?: string; targetIds?: string[]; output?: "selected" };
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
const key = (item: Record<string, any>) => String(item.asset_id || item.id || "");
const stableId = (item: Record<string, any>) => String(item.id || "");
export const compilationHash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");

/** A compiler input projection, never a second authored source or an authorization. */
export function compilationScopeInput(director: DirectorProduction, scope: CompilationScope) {
    const source = director.source;
    const scene = scope.sceneId ? productionSceneEntries(source).find(item => item.id === scope.sceneId) : undefined;
    if (scope.sceneId && !scene) throw new Error("COMPILATION_SCOPE_UNKNOWN_SCENE: 编译场次不存在");
    const allShots = rows(source.shots), allSegments = rows(source.segments), plans = rows(source.asset_plan), cards = rows(source.asset_cards);
    const subjectAssembly = isSubjectPromptAssembly(source);
    const wanted = new Set(scope.targetIds || []);
    const segmentIds = new Set(allSegments.map(stableId));
    // In Subject Prompt v2 the plan is dependency/identity metadata, not an
    // image-prompt output. Without this distinction, a full compile can narrow
    // down to plan-only "pending targets" after ready H3 artifacts are reused;
    // the resulting scope contains neither cards nor segments and is rejected
    // as though the saved episode had no compilable content.
    const sharedMediaAssetIds = new Set(plans.filter(plan => {
        const id = key(plan), media = director.assets[id];
        return Boolean(plan.sharedSource && media?.storageKey && media?.sha256);
    }).map(key));
    const standaloneCards = cards.filter(card => !sharedMediaAssetIds.has(key(card)));
    const assetTargetIds = new Set([...(!subjectAssembly ? plans.filter(plan => !sharedMediaAssetIds.has(key(plan))) : []), ...standaloneCards].map(key).filter(Boolean));
    const compilerTargetIds = new Set([...segmentIds, ...assetTargetIds]);
    const shots = new Set(wanted.size ? [] : scene?.shotIds || []);
    for (const id of wanted) {
        if (![...allShots.map(stableId), ...allSegments.map(stableId), ...assetTargetIds].includes(id)) throw new Error(`COMPILATION_SCOPE_UNKNOWN_TARGET: 编译目标不存在：${id}`);
        if (allShots.some(item => stableId(item) === id)) shots.add(id);
        for (const shotId of plans.find(item => key(item) === id)?.shot_ids || []) shots.add(String(shotId));
        const segment = allSegments.find(item => stableId(item) === id);
        for (const shotId of segment?.shot_ids || []) shots.add(String(shotId));
    }
    if (scene && [...shots].some(id => !scene.shotIds.includes(id))) throw new Error("COMPILATION_SCOPE_CROSS_SCENE: 目标不属于指定编译场次");
    const includeShotSegments = Boolean(scene && !wanted.size) || [...wanted].some(id => allShots.some(item => stableId(item) === id));
    const segments = allSegments.filter(item => wanted.has(stableId(item)) || includeShotSegments && (item.shot_ids || []).some((id: string) => shots.has(id)));
    for (const segment of segments) if ((segment.shot_ids || []).some((id: string) => !shots.has(id))) throw new Error("COMPILATION_SCOPE_CROSS_SCENE: Segment 跨越编译范围");
    const outputShotIds = new Set(shots);
    const subjectRegistry = rows(source.subject_registry);
    const subjectById = new Map(subjectRegistry.map(subject => [String(subject.id), subject]));
    const subjectReferenceShotIds = new Set(segments.filter(segment => String(segment.mode) === "Ref2VA").flatMap(segment => (segment.shot_ids || []).map(String)));
    const keyframeOutputShotIds = new Set(Object.entries(director.shotInputs)
        .filter(([, input]) => wanted.has(String(input.keyframeAssetId || ""))).map(([shotId]) => shotId));
    const subjectPictureShotIds = new Set([...subjectReferenceShotIds, ...keyframeOutputShotIds]);
    const bindingAssets = new Map<string, string>();
    if (subjectAssembly) for (const subject of subjectRegistry) for (const binding of rows(subject.pictureBindings)) bindingAssets.set(String(binding.id), String(binding.assetId || binding.id));
    const shotAssets = new Set<string>();
    if (subjectAssembly) for (const shot of allShots.filter(item => shots.has(stableId(item)))) {
        if (!subjectPictureShotIds.has(stableId(shot))) continue;
        for (const usage of rows(shot.subject_usages)) for (const bindingId of resolveSubjectPictureBindingIds(subjectById.get(String(usage.subjectId)), usage).bindingIds) {
            const assetId = bindingAssets.get(String(bindingId)); if (assetId) shotAssets.add(assetId);
        }
        for (const frame of rows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor !== "composition")) shotAssets.add(String(frame.assetId || frame.id));
        for (const reference of rows(shot.reference_requirements).filter(item => item.requiredForSubmission)) shotAssets.add(String(reference.asset_id || reference.id));
    }
    const activeFrame = (item: Record<string, any>) => item.kind !== "keyframe" || (subjectAssembly
        ? shotAssets.has(key(item))
        : Object.values(director.shotInputs).some(input => input.keyframePolicy !== "none" && input.keyframeAssetId === key(item)));
    const assets = new Set(plans.filter(item => wanted.has(key(item)) || activeFrame(item) && (item.shot_ids || []).some((id: string) => shots.has(id))).map(key));
    shotAssets.forEach(id => assets.add(id));
    if (scene && !wanted.size && !shots.size) for (const plan of plans) if (plan.canvas_scope === "shared") assets.add(key(plan));
    for (const shot of allShots.filter(item => shots.has(stableId(item)))) {
        if (subjectAssembly) {
            for (const usage of (subjectPictureShotIds.has(stableId(shot)) ? rows(shot.subject_usages) : [])) for (const bindingId of resolveSubjectPictureBindingIds(subjectById.get(String(usage.subjectId)), usage).bindingIds) {
                const assetId = bindingAssets.get(String(bindingId)); if (assetId) assets.add(assetId);
            }
            for (const frame of rows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor !== "composition")) assets.add(String(frame.assetId || frame.id));
            for (const reference of rows(shot.reference_requirements).filter(item => item.requiredForSubmission)) assets.add(String(reference.asset_id || reference.id));
        } else {
            for (const id of shot.required_assets || []) assets.add(String(id));
            const input = director.shotInputs[stableId(shot)];
            for (const id of input?.assetIds || []) assets.add(id);
            if (input?.keyframePolicy !== "none" && input?.keyframeAssetId) assets.add(input.keyframeAssetId);
        }
    }
    if (!subjectAssembly) for (const segment of segments) for (const ref of segment.references || []) if (ref.asset_id) assets.add(String(ref.asset_id));
    const visit = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return; seen.add(id);
        const card = rows(source.asset_cards).find(item => key(item) === id);
        for (const dep of [...(plans.find(item => key(item) === id)?.depends_on || []), ...rows(card?.references).map(item => item.asset_id)].filter(Boolean)) { assets.add(String(dep)); visit(String(dep), seen); }
    };
    for (const id of assets) visit(id);
    // `assets` also contains media-only dependencies such as Subject picture
    // bindings. They must be materialized as compiler inputs, but are not
    // compilation outputs and must never be sent to the artifact/apply scope.
    const targetIds = [...new Set(scope.output === "selected"
        ? [...wanted].filter(id => compilerTargetIds.has(id))
        : [...assetTargetIds].filter(id => assets.has(id)).concat(segments.map(stableId)))].sort();
    if (!targetIds.length) throw new Error("COMPILATION_SCOPE_EMPTY: 编译范围没有可生成的资产提示词卡或视频段落");
    const projected = structuredClone(director);
    projected.source.shots = allShots.filter(item => shots.has(stableId(item)));
    projected.source.segments = segments;
    projected.source.asset_plan = plans.filter(item => assets.has(key(item))).map(item => {
        const id = key(item), media = director.assets[id];
        if (!sharedMediaAssetIds.has(id) || !media?.sha256) return item;
        // A live shared reference is a media dependency already produced on the
        // source canvas, not a new image prompt target in this episode. Mark only
        // the compiler projection as generated so Acheng validates its frozen
        // bytes without demanding a second standalone asset card.
        return { ...item, status: "generated", file: `shared-assets/${encodeURIComponent(id)}.png`, sha256: media.sha256 };
    });
    // Asset cards are image-generation recipes, not media dependencies. Keep
    // cards only when an image target is part of this compile output; H3 clips
    // consume the already-bound Subject media and must not validate or regenerate
    // unrelated identity-image layouts as a side effect.
    const outputAssetCards = new Set(targetIds.filter(targetId => assetTargetIds.has(targetId)));
    projected.source.asset_cards = rows(source.asset_cards).filter(item => outputAssetCards.has(key(item)));
    if (subjectAssembly) {
        // The pinned storyboard validator predates Subject Prompt v2 and checks
        // attention IDs against character/scene/asset registries. Keep the
        // authored Subject IDs for prompt assembly, while exposing ephemeral
        // registry aliases in this isolated compiler projection only.
        const subjectsById = new Map(rows(source.subject_registry).map(subject => [String(subject.id), subject]));
        const aliases = new Map<string, Map<string, Record<string, any>>>();
        for (const shot of allShots.filter(item => outputShotIds.has(stableId(item)))) {
            const attentionIds: string[] = Array.isArray(shot.camera?.attention_subject_ids) ? shot.camera.attention_subject_ids.map(String) : [];
            for (const subjectId of attentionIds) {
                const subject = subjectsById.get(subjectId);
                const entityKind = String(subject?.entityRef?.kind || "");
                const registry = entityKind === "character" ? "character_registry" : entityKind === "scene" ? "scene_registry" : entityKind === "asset" ? "asset_plan" : "";
                if (!registry) continue;
                const entityId = String(subject?.entityRef?.id || "");
                const entity = rows(source[registry]).find(item => key(item) === entityId);
                if (!entity) continue;
                const alias = structuredClone(entity);
                alias.id = subjectId;
                alias._compiler_subject_alias = true;
                const sourceAssetId = key(entity), media = registry === "asset_plan" ? director.assets[sourceAssetId] : undefined;
                if (media?.storageKey && media?.sha256) {
                    alias.status = "generated";
                    alias.file = `compiler-subject-aliases/${encodeURIComponent(subjectId)}.png`;
                    alias.sha256 = media.sha256;
                    alias._compiler_source_asset_id = sourceAssetId;
                }
                delete alias.entity_id;
                delete alias.asset_id;
                const entries = aliases.get(registry) || new Map<string, Record<string, any>>();
                entries.set(subjectId, alias); aliases.set(registry, entries);
            }
        }
        for (const [registry, entries] of aliases) {
            const rowsForRegistry = rows(projected.source[registry]);
            const existing = new Set(rowsForRegistry.map(item => key(item)));
            projected.source[registry] = [...rowsForRegistry, ...[...entries].filter(([id]) => !existing.has(id)).map(([, alias]) => alias)];
        }
    }
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
            const blockIds = new Set(rows(source.script_scenes).filter(item => sceneIds.has(String(item.id || item.scene_id))).flatMap(item => rows(Array.isArray(item.blocks) ? item.blocks : typeof item.text === "string" ? [item] : []).map(block => String(block.id))));
            const coverage = rows(ledger.coverage).filter(item => blockIds.has(String(item.source_anchor?.block_id || item.block_id)));
            const eventIds = new Set(coverage.flatMap(item => (item.event_ids || []).map(String)));
            for (const requirement of rows(ledger.requirements).filter(item => contextShots.has(String(item.shot_id)))) for (const eventId of requirement.event_ids || []) eventIds.add(String(eventId));
            for (const item of coverage) for (const shotId of item.shot_ids || []) if (allShots.some(shot => stableId(shot) === String(shotId))) contextShots.add(String(shotId));
            for (const event of rows(ledger.events)) if (eventIds.has(stableId(event)) && allShots.some(shot => stableId(shot) === String(event.shot_id))) contextShots.add(String(event.shot_id));
            // Replaying only the selected shot would lose earlier changes on its timeline.
            const lastOrders = new Map<string, number>();
            for (const shot of allShots.filter(item => contextShots.has(stableId(item)))) if (shot.timeline_id && Number.isFinite(Number(shot.story_order))) lastOrders.set(String(shot.timeline_id), Math.max(lastOrders.get(String(shot.timeline_id)) ?? -Infinity, Number(shot.story_order)));
            for (const shot of allShots) if (shot.timeline_id && Number(shot.story_order) <= (lastOrders.get(String(shot.timeline_id)) ?? -Infinity)) contextShots.add(stableId(shot));
            for (const entry of entries) if (entry.shotIds.some(id => contextShots.has(id))) sceneIds.add(entry.id);
            changed = before !== contextShots.size + sceneIds.size;
        }
        projected.source.shots = allShots.filter(item => contextShots.has(stableId(item)));
        projected.source.script_scenes = rows(source.script_scenes).filter(item => sceneIds.has(String(item.id || item.scene_id)));
        const blocks = new Set(rows(projected.source.script_scenes).flatMap(item => rows(Array.isArray(item.blocks) ? item.blocks : typeof item.text === "string" ? [item] : []).map(block => String(block.id))));
        projected.source.ledger = { ...structuredClone(ledger),
            events: rows(ledger.events).filter(item => contextShots.has(String(item.shot_id))),
            requirements: rows(ledger.requirements).filter(item => contextShots.has(String(item.shot_id))),
            coverage: rows(ledger.coverage).filter(item => blocks.has(String(item.source_anchor?.block_id || item.block_id))),
        };
        if (subjectAssembly) {
            const clipShots = new Set(segments.flatMap(segment => (segment.shot_ids || []).map(String)));
            const allSubjectRows = rows(source.subject_registry), entitySubjects = new Map(allSubjectRows.map(subject => [`${subject.entityRef?.kind}:${subject.entityRef?.id}`, String(subject.id)]));
            const usedSubjects = new Set<string>();
            const usedFacts = new Set<string>();
            const outputUtteranceIds = new Set<string>();
            for (const shot of allShots.filter(item => contextShots.has(stableId(item)))) {
                for (const usage of rows(shot.subject_usages)) {
                    usedSubjects.add(String(usage.subjectId));
                    for (const factId of usage.continuityFactIds || []) usedFacts.add(String(factId));
                }
                for (const frame of rows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor !== "composition")) for (const subjectId of frame.subjectIds || []) usedSubjects.add(String(subjectId));
                for (const factId of shot.continuity_facts || []) usedFacts.add(String(factId));
                if (clipShots.has(stableId(shot))) for (const ref of rows(shot.utterance_refs)) outputUtteranceIds.add(String(ref.utteranceId));
            }
            for (const shot of allShots.filter(item => outputShotIds.has(stableId(item)))) for (const ref of rows(shot.utterance_refs)) outputUtteranceIds.add(String(ref.utteranceId));
            const outputUtterances = rows(source.utterances).filter(item => outputUtteranceIds.has(String(item.id)));
            // A clipped utterance depends on its registered speaker even when
            // that Subject has no visible picture usage in this Clip (text-only
            // T2VA and dialogue-focused shots are valid examples).
            for (const utterance of outputUtterances) usedSubjects.add(String(utterance.speakerSubjectId || ""));
            const scopedLedger = projected.source.ledger as Record<string, any>;
            for (const req of rows(scopedLedger.requirements)) usedFacts.add(String(req.fact_id || ""));
            for (const event of rows(scopedLedger.events)) usedFacts.add(String(event.fact_id || ""));
            const coverageEvents = new Set(rows(scopedLedger.coverage).flatMap(item => (item.event_ids || []).map(String)));
            for (const event of rows(ledger.events).filter(item => coverageEvents.has(stableId(item)))) usedFacts.add(String(event.fact_id || ""));
            const facts = rows(ledger.facts);
            for (const fact of facts) {
                const subjectId = entitySubjects.get(`${fact.object_kind}:${fact.object_id}`);
                if (subjectId && usedSubjects.has(subjectId)) usedFacts.add(String(fact.id));
            }
            for (const fact of facts) {
                const subjectId = entitySubjects.get(`${fact.object_kind}:${fact.object_id}`);
                if (subjectId && usedFacts.has(String(fact.id))) usedSubjects.add(subjectId);
            }
            const scopedSubjects = allSubjectRows.filter(subject => usedSubjects.has(String(subject.id)));
            // Subject Prompt v2 stores props as asset-kind entity references.
            // Their asset_plan rows are registry metadata, even when this scoped
            // compile does not consume their images. Keep those rows for schema
            // validation without adding them to `assets` or `targetIds`.
            const subjectAssetIds = new Set(scopedSubjects
                .filter(subject => subject.entityRef?.kind === "asset")
                .map(subject => String(subject.entityRef?.id || "")));
            const registryOnlyPlans = plans.filter(item => subjectAssetIds.has(key(item)) && !assets.has(key(item))).map(item => {
                const id = key(item), media = director.assets[id];
                if (!media?.storageKey || !media.sha256) return item;
                return { ...item, status: "generated", file: `compiler-registry-assets/${encodeURIComponent(id)}.png`, sha256: media.sha256,
                    _compiler_registry_media: true, _compiler_source_asset_id: id };
            });
            projected.source.asset_plan = [...rows(projected.source.asset_plan), ...registryOnlyPlans];
            projected.source.subject_registry = scopedSubjects.map(subject => {
                // Shots kept only for continuity replay remain in this projection with
                // their authored Subject usages, and the source schema validates every
                // retained Shot's pictureBindingIds against this registry. Trim by the
                // retained shot set so those bindings stay resolvable; media and the Clip
                // reference closure stay scoped to output Shots through
                // subjectPictureShotIds, so a replay Shot never pulls in a picture file.
                const selectedBindings = new Set(rows(source.shots).filter(shot => contextShots.has(stableId(shot))).flatMap(shot => rows(shot.subject_usages).filter(usage => usage.subjectId === subject.id).flatMap(usage => resolveSubjectPictureBindingIds(subject, usage).bindingIds)));
                return { ...subject, pictureBindings: rows(subject.pictureBindings).filter(binding => selectedBindings.has(String(binding.id))) };
            });
            scopedLedger.facts = facts.filter(fact => usedFacts.has(String(fact.id)));
            scopedLedger.timelines = rows(ledger.timelines).filter(item => [...contextShots].some((shotId: string) => String(allShots.find(shot => stableId(shot) === shotId)?.timeline_id) === String(item.id)));
            scopedLedger.initial = rows(ledger.initial).filter(item => usedFacts.has(String(item.fact_id)) && scopedLedger.timelines.some((timeline: Record<string, any>) => timeline.id === item.timeline_id));
            scopedLedger.events = rows(ledger.events).filter(item => contextShots.has(String(item.shot_id)) && usedFacts.has(String(item.fact_id)));
            scopedLedger.requirements = rows(ledger.requirements).filter(item => contextShots.has(String(item.shot_id)) && usedFacts.has(String(item.fact_id)));
            scopedLedger.coverage = rows(ledger.coverage).filter(item => blocks.has(String(item.source_anchor?.block_id || item.block_id)));
            projected.source.utterances = outputUtterances;
        }
    }
    projected.assets = Object.fromEntries(Object.entries(director.assets).filter(([id]) => assets.has(id)));
    for (const plan of rows(projected.source.asset_plan).filter(item => item._compiler_registry_media === true)) {
        const id = key(plan), media = director.assets[id];
        if (media) projected.assets[id] = media;
    }
    projected.shotInputs = Object.fromEntries(Object.entries(director.shotInputs).filter(([id]) => shots.has(id)));
    projected.boundaries = director.boundaries.filter(item => segments.some(s => stableId(s) === item.from) && segments.some(s => stableId(s) === item.to));
    projected.artifacts = director.artifacts.filter(item => targetIds.includes(item.targetId));
    projected.sourceHash = compilationHash(projected.source);
    // Authored global facts remain inputs. Run cursors and unrelated artifacts do not.
    const referenced = new Set<string>([
        ...rows(projected.source.asset_cards).flatMap(item => rows(item.references).map(ref => String(ref.asset_id || ""))),
        ...(subjectAssembly ? [] : segments.flatMap(item => rows(item.references).map(ref => String(ref.asset_id || "")))),
        ...rows(projected.source.shots).flatMap(item => (item.required_assets || []).map(String)),
        ...(subjectAssembly ? rows(projected.source.shots).filter(item => subjectPictureShotIds.has(stableId(item))).flatMap(item => rows(item.subject_usages).flatMap(usage => resolveSubjectPictureBindingIds(subjectById.get(String(usage.subjectId)), usage).bindingIds.map(bindingId => bindingAssets.get(String(bindingId)) || ""))) : []),
        ...(subjectAssembly ? rows(projected.source.shots).flatMap(item => rows(item.keyframes).filter(frame => frame.requiredForSubmission && frame.anchor !== "composition").map(frame => String(frame.assetId || frame.id))) : []),
        ...(subjectAssembly ? rows(projected.source.shots).flatMap(item => rows(item.reference_requirements).filter(reference => reference.requiredForSubmission).map(reference => String(reference.asset_id || reference.id))) : []),
        ...rows(projected.source.asset_plan).filter(item => item._compiler_registry_media === true).map(key),
        ...rows(projected.source.asset_plan).flatMap(item => (item.depends_on || []).map(String)),
    ]);
    const inputAssets = Object.fromEntries(Object.entries(projected.assets).filter(([id]) => referenced.has(id) || Boolean(scene && !shots.size)).map(([id, asset]) => [id, { nodeId: asset.nodeId, assetId: asset.assetId, version: asset.version, storageKey: asset.storageKey, sha256: asset.sha256, sharedSource: asset.sharedSource }]));
    const bindings = Object.fromEntries(Object.entries(projected.assets).map(([id, asset]) => [id, { nodeId: asset.nodeId ?? null, assetId: asset.assetId ?? null }]));
    const hashSource = { ...projected.source };
    // Backend compiler isolation markers and the derived continuity asset lookup
    // are validation context, not authored model inputs. Exclude them so packet
    // hashes remain valid when the scoped prompt is applied to the unmarked source.
    if (hashSource._canvas_compilation_scope) delete hashSource.delivery_scope;
    delete hashSource._canvas_compilation_scope;
    delete hashSource._canvas_continuity_asset_registry;
    const inputs = { source: hashSource, assets: inputAssets, bindings, shotInputs: projected.shotInputs, boundaries: projected.boundaries };
    const inputHash = compilationHash(inputs);
    const legacyInputHash = compilationHash({ ...inputs, engine: projected.engine });
    return { director: projected, inputHash, legacyInputHash, targetIds };
}

export type CompilationArtifactStaleReason = "receipt_missing" | "compiler_changed" | "prompt_hash_mismatch" | "source_changed" | "runtime_changed" | "scope_input_changed" | "scope_unavailable";
export type CompilationArtifactFreshness = { current: true } | { current: false; staleReason: CompilationArtifactStaleReason };

export function compilationArtifactFreshness(director: DirectorProduction, artifact: DirectorProduction["artifacts"][number]): CompilationArtifactFreshness {
    const receipt = artifact.receipt as (typeof artifact.receipt & Record<string, any>) | undefined;
    if (!receipt) return { current: false, staleReason: "receipt_missing" };
    const compiledEngine = receipt.engine as DirectorProduction["engine"] | undefined;
    if ((compiledEngine?.compilerHash || "") !== (director.engine.compilerHash || "")) return { current: false, staleReason: "compiler_changed" };
    if (typeof artifact.prompt !== "string" || !artifact.prompt) return { current: false, staleReason: "prompt_hash_mismatch" };
    const promptHash = crypto.createHash("sha256").update(artifact.prompt, "utf8").digest("hex");
    if (promptHash !== artifact.sha256 || receipt.promptHash !== artifact.sha256) return { current: false, staleReason: "prompt_hash_mismatch" };

    const scoped = receipt.compilationScope as { scope: CompilationScope; inputHash: string; engine?: DirectorProduction["engine"] } | undefined;
    if (scoped) {
        const sourceMatches = receipt.sourceHash === director.sourceHash && artifact.sourceHash === director.sourceHash;
        if (!sourceMatches && compiledEngine && compiledEngine.runtimeId !== receipt.engineRuntimeId) return { current: false, staleReason: "runtime_changed" };
        if (!sourceMatches && scoped.engine && receipt.engineRuntimeId && scoped.engine.runtimeId !== receipt.engineRuntimeId) return { current: false, staleReason: "runtime_changed" };
        try {
            const input = compilationScopeInput({ ...director, engine: scoped.engine || director.engine }, scoped.scope);
            if (input.inputHash === scoped.inputHash || input.legacyInputHash === scoped.inputHash) return { current: true };
            return { current: false, staleReason: "scope_input_changed" };
        } catch { return { current: false, staleReason: "scope_unavailable" }; }
    }
    if (artifact.sourceHash === director.sourceHash && receipt.sourceHash === director.sourceHash) return { current: true };
    return { current: false, staleReason: "source_changed" };
}

export function currentCompilationArtifact(director: DirectorProduction, artifact: DirectorProduction["artifacts"][number]) {
    return compilationArtifactFreshness(director, artifact).current;
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
    const wanted = new Set(scope.targetIds || []);
    const outputShotIds = new Set<string>();
    if (scope.sceneId && !wanted.size) {
        const scene = productionSceneEntries(next.source).find(item => item.id === scope.sceneId);
        for (const shotId of scene?.shotIds || []) outputShotIds.add(String(shotId));
    }
    for (const targetId of wanted) {
        const segment = rows(next.source.segments).find(item => stableId(item) === targetId);
        if (segment) for (const shotId of segment.shot_ids || []) outputShotIds.add(String(shotId));
        else if (shots.some(shot => stableId(shot) === targetId)) {
            const containing = rows(next.source.segments).find(item => (item.shot_ids || []).map(String).includes(targetId));
            if (containing) for (const shotId of containing.shot_ids || []) outputShotIds.add(String(shotId));
            else outputShotIds.add(targetId);
        }
    }
    const shifts = new Map<string, number>(); let cursor = 0;
    for (const shot of shots) {
        const start = Number(shot.start_frame), end = Number(shot.end_frame);
        if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
        shifts.set(stableId(shot), cursor - start); shot.start_frame = cursor; cursor += end - start; shot.end_frame = cursor;
    }
    for (const segment of rows(next.source.segments)) {
        const covered = shots.filter(shot => (segment.shot_ids || []).includes(stableId(shot)));
        if (covered.length) {
            const shift = shifts.get(stableId(covered[0])) || 0;
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
    next.source._canvas_compilation_scope = {
        scope,
        // Active runtime source validation reads targetIds at this marker's
        // top level to distinguish selected output from retained ledger context.
        targetIds: scope.targetIds || [],
        // Continuity replay may retain earlier Shots that are not outputs of this
        // scene compile. Keep the expected output set explicit for the Python
        // source contract so context-only Shots are not mistaken for ungrouped output.
        outputShotIds: shots.filter(shot => outputShotIds.has(stableId(shot))).map(shot => stableId(shot)),
        authoredInputHash: compilationHash(input.source),
        frameShifts: Object.fromEntries(shifts),
    };
    next.sourceHash = compilationHash(next.source);
    return next;
}
