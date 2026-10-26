import crypto from "node:crypto";
import { compilationArtifactFreshness } from "@basketikun/canvas-agent/drama/compilation-scope";
import fs from "node:fs";
import { canonicalProduction, productionSceneEntries, type DirectorProduction, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import { resolveCanvasCharacterImageReferences, resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import { resolveAchengEngine } from "@basketikun/canvas-agent/skills/acheng";
import { isSubjectPromptAssembly, resolveSubjectPictureBindingIds } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { ref2vaPromptDiagnostics, ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { assertImageReferenceCoverage } from "./image-inputs.js";
import { productionCanvasContext } from "./production-canvas.js";
import { isArchivedStoryboardKeyframeBinding } from "./storyboard-media.js";

export function assertDirectorEngine(_engine: DirectorProduction["engine"]) {
    return resolveAchengEngine();
}

export const directorHash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
export const promptHash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const obj = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value.map(obj) : [];
const prose = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? {});

export function projectDirector(data: EpisodeProductionData, validate = true) {
    const d = data.director; if (!d) return;
    if (validate && directorHash(d.source) !== d.sourceHash) throw new Error("Acheng sourceHash 与完整制作稿不一致");
    // Any canonical source or compiler-runtime change invalidates a ready receipt.
    // Retire that derived artifact before projection validates current bindings;
    // otherwise a normal edit is rejected for an artifact that is stale by definition.
    if (validate) d.artifacts = d.artifacts.map(artifact => artifact.status === "ready" && !compilationArtifactFreshness(d, artifact).current
        ? { ...artifact, status: "stale" as const }
        : artifact);
    const source = d.source;
    if (validate && JSON.stringify(source).includes('"legacy_fixture"')) throw new Error("新制作不能使用 legacy_fixture");
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("Acheng fps 无效");
    const shots = list(source.shots);
    const subjectAssembly = isSubjectPromptAssembly(source);
    const shotWindows = subjectShotWindows(source);
    const stateProjection = subjectStateProjection(source);
    const subjectsById = new Map(list(source.subject_registry).map(subject => [String(subject.id), subject]));
    const subjectBindings = new Map<string, Record<string, any>>();
    for (const subject of list(source.subject_registry)) for (const binding of list(subject.pictureBindings)) subjectBindings.set(String(binding.id), binding);
    const scenes = list(source.script_scenes);
    // Location is the shared Shot scene identity; preserve authored scene blocks.
    const sceneIds = [...new Set([...scenes.map(s => String(s.scene_id || s.id)), ...shots.map(s => String(s.scene_id))])];
    data.scenes = sceneIds.map(sceneId => {
        const sceneRows = scenes.filter(s => String(s.scene_id || s.id) === sceneId);
        const first = sceneRows[0];
        const blocks = sceneRows.flatMap(scene => {
            const rows = Array.isArray(scene.blocks) ? list(scene.blocks) : [scene];
            return rows.map(block => ({ id: String(block.id || block.scene_id), kind: block.kind === "dialogue" ? "dialogue" as const : "action" as const,
                ...(typeof block.speaker === "string" && block.speaker ? { speaker: block.speaker } : {}), text: String(block.text || "") }));
        });
        return { id: sceneId, heading: String(first?.scene_name || first?.heading || sceneId), location: String(first?.location || sceneId),
            timeOfDay: String(first?.time_of_day || first?.timeOfDay || ""), blocks };
    });
    data.shots = shots.map(s => {
        const input = d.shotInputs[String(s.id)];
        const window = shotWindows.get(String(s.id));
        const usages = subjectAssembly ? list(s.subject_usages) : [];
        const assetIds = subjectAssembly ? usages.flatMap(usage => resolveSubjectPictureBindingIds(subjectsById.get(String(usage.subjectId)), usage).bindingIds.map(bindingId => String(subjectBindings.get(bindingId)?.assetId || "")))
            : [...(input?.assetIds || [])];
        const keyframeAssetIds = subjectAssembly ? list(s.keyframes).filter(frame => frame.anchor !== "composition").map(frame => String(frame.assetId || frame.id)) : input?.keyframeAssetId ? [input.keyframeAssetId] : [];
        const assetNodeIds = [...new Set([...assetIds, ...keyframeAssetIds].flatMap(id => d.assets[id]?.nodeId ? [d.assets[id]!.nodeId!] : []))];
        const durationFrames = subjectAssembly ? Number(s.duration_frames) : Number(s.end_frame) - Number(s.start_frame);
        const duration = durationFrames / fps;
        const projectedState = stateProjection[String(s.id)];
        const openingState = subjectAssembly ? JSON.stringify(projectedState?.start || []) : prose(s.state_in);
        const endingState = subjectAssembly ? JSON.stringify(projectedState?.end || []) : prose(s.state_out);
        const characters = subjectAssembly ? usages.flatMap(usage => {
            const subject = subjectsById.get(String(usage.subjectId));
            const entity = subject?.entityRef;
            if (entity?.kind !== "character" || usage.presentation !== "visible") return [];
            const row = list(source.character_registry).find(item => item.id === entity.id);
            return [{ id: String(entity.id), name: String(row?.name || entity.id) }];
        }) : undefined;
        return { id: String(s.id), sceneId: String(s.scene_id || s.source_scene_id || ""), title: String(s.title || s.id), duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
            visual: prose(s.visual), camera: prose(s.camera), openingState, endingState,
            sound: prose(subjectAssembly ? { utterance_refs: s.utterance_refs, audio: s.audio } : { dialogues: s.dialogues, audio: s.audio }), assetNodeIds,
            ...(characters ? { characters } : {}),
            ...(subjectAssembly && window ? { startFrame: window.startFrame, endFrame: window.endFrame, stateUnresolved: projectedState?.unresolved || [] } : {}),
            keyframePolicy: data.settings.storyboardImageMode === "skip" || subjectAssembly && !keyframeAssetIds.length ? "none" : input?.keyframePolicy || (keyframeAssetIds.length ? "reuse" : "none") };
    });
    // Stored Subject Prompt v2 drafts keep only the authored source: the legacy
    // `clipGroups`/`shots`/`scenes` projection is derived and never persisted, so a
    // projection rebuilt from storage (shared-asset propagation, recovery) must not
    // assume the previous projection exists.
    const priorGroups = list(data.clipGroups);
    const prior = new Map(priorGroups.map(g => [g.id, g]));
    const shotIds = new Set(shots.map(s => String(s.id)));
    const sceneForShot = new Map(productionSceneEntries(source).flatMap(scene => scene.shotIds.map(id => [String(id), scene.id] as const)));
    const sceneScope = (ids: unknown) => [...new Set((Array.isArray(ids) ? ids : []).map(String).map(id => sceneForShot.get(id) || ""))].sort();
    const validSegments = list(source.segments).filter(s => Array.isArray(s.shot_ids) && s.shot_ids.length && s.shot_ids.every((id: unknown) => shotIds.has(String(id))));
    // A boundary adjustment changes source segment IDs. Keep each prior runtime
    // H3 row attached to the new group with the largest shot overlap so compile
    // updates that row in place instead of appending a replacement beside a
    // manually edited orphan. One-to-one matching means a split still creates
    // the genuinely new H3 row, while a two-Clip repartition stays two rows.
    const claimedPrior = new Set<string>();
    for (const segment of validSegments) if (prior.has(String(segment.id))) claimedPrior.add(String(segment.id));
    const overlapCandidates = validSegments.flatMap(segment => {
        const nextId = String(segment.id), nextShots = new Set(segment.shot_ids.map(String));
        if (prior.has(nextId)) return [];
        const nextScenes = sceneScope(segment.shot_ids);
        return priorGroups.flatMap(old => {
            const oldId = String(old.id);
            if (!old.nodeId || !old.segmentId || claimedPrior.has(oldId)) return [];
            if (canonicalProduction(sceneScope(old.shotIds)) !== canonicalProduction(nextScenes)) return [];
            const overlap = Array.isArray(old.shotIds) ? old.shotIds.filter((id: unknown) => nextShots.has(String(id))).length : 0;
            return overlap ? [{ nextId, oldId, overlap }] : [];
        });
    }).sort((a, b) => b.overlap - a.overlap || a.oldId.localeCompare(b.oldId) || a.nextId.localeCompare(b.nextId));
    const runtimeSourceBySegment = new Map<string, Record<string, any>>();
    for (const candidate of overlapCandidates) {
        if (runtimeSourceBySegment.has(candidate.nextId) || claimedPrior.has(candidate.oldId)) continue;
        runtimeSourceBySegment.set(candidate.nextId, prior.get(candidate.oldId)!);
        claimedPrior.add(candidate.oldId);
    }
    data.clipGroups = validSegments.map(s => {
        const id = String(s.id), old = prior.get(id) || runtimeSourceBySegment.get(id);
        return { id, shotIds: s.shot_ids.map(String), nodeId: old?.nodeId || null, segmentId: old?.segmentId || null, sourceVersion: old?.sourceVersion || 0,
            ...(old?.inputOutdated === undefined ? {} : { inputOutdated: old.inputOutdated }) };
    });
    if (!validate) return;
    if (new Set(d.artifacts.map(a => `${a.kind}:${a.targetId}`)).size !== d.artifacts.length) throw new Error("同一目标只能有一个当前编译产物");
    for (const artifact of d.artifacts) {
        if (artifact.sha256 !== promptHash(artifact.prompt)) throw new Error(`产物 ${artifact.id} 正文字节摘要不一致`);
        if (artifact.status === "ready" && (!compilationArtifactFreshness(d, artifact).current || artifact.receipt.promptHash !== artifact.sha256)) throw new Error(`产物 ${artifact.id} 回执版本不一致`);

    }
    const sourceContract = /^[a-f0-9]{40}-[a-f0-9]{16}$/.test(d.engine.runtimeId) ? resolveAchengEngine().sourceContract : null;
    const promptIssues = ref2vaPromptDiagnostics(d, sourceContract ? sourceContract.ref2vaMaximumWords : 2900);
    if (promptIssues.length) throw new ProductionValidationError(promptIssues);
}

/** Canonical storage and v2 API payloads never persist the derived legacy storyboard view. */
export function withoutDirectorProjection<T extends EpisodeProductionData>(value: T): Omit<T, "scenes" | "shots" | "clipGroups"> & Partial<Pick<T, "scenes" | "shots" | "clipGroups">> {
    const result = structuredClone(value) as Record<string, any>;
    delete result.storageFormat;
    if (result.director && isSubjectPromptAssembly(result.director.source)) {
        delete result.scenes;
        delete result.shots;
        delete result.clipGroups;
    }
    return result as Omit<T, "scenes" | "shots" | "clipGroups"> & Partial<Pick<T, "scenes" | "shots" | "clipGroups">>;
}

export function publicProductionRecord<T extends { draft: EpisodeProductionData; published: EpisodeProductionData | null; storageFormat?: unknown }>(value: T) {
    if (!value || typeof value !== "object" || !("draft" in value) || !("published" in value)) return value;
    const draft = withoutDirectorProjection(value.draft), published = value.published ? withoutDirectorProjection(value.published) : null;
    const legacyPublished = Boolean(draft.director && isSubjectPromptAssembly(draft.director.source)
        && published?.director && !isSubjectPromptAssembly(published.director.source));
    return { ...value, draft, published: legacyPublished ? null : published,
        ...(legacyPublished ? { publishedFormatStatus: "legacy-maintenance-required" } : {}) };
}

/** Verify actual media bytes and project ownership, never a supplied PASS string. */
export function validateDirectorMedia(db: BackendDatabase, projectId: string, d: DirectorProduction, targetIds?: string[]) {
    const nodes = db.getCanvasProject(projectId)?.nodes as Array<Record<string, any>> | undefined;
    if (!nodes) throw new Error("画布不存在");
    const canvasRole = productionCanvasContext(db, projectId).role;
    const plan = new Map(list(d.source.asset_plan).map(a => [String(a.asset_id || a.id), a]));
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error(`资产依赖存在循环：${id}`);
        if (visited.has(id)) return;
        const entry = plan.get(id); if (!entry) throw new Error(`资产依赖未登记：${id}`);
        visiting.add(id);
        for (const dependency of entry.depends_on || []) visit(String(dependency));
        visiting.delete(id); visited.add(id);
    };
    const selected = targetIds ? new Set(targetIds) : undefined;
    const artifacts = d.artifacts.filter(a => a.status === "ready" && (!selected || selected.has(a.targetId)));
    for (const artifact of artifacts) {
        if (canvasRole === "shared-assets" && artifact.kind === "h3") throw new Error("剧目共享资产画布不能生产分集视频 Clip");
        if (canvasRole === "shared-assets" && artifact.kind === "image" && Object.values(d.shotInputs).some(input => input.keyframeAssetId === artifact.targetId)) throw new Error("关键帧属于本集，不能在剧目共享资产画布生产");
        if (artifact.kind === "image") assertImageReferenceCoverage(d, artifact);
        const dependencies = artifact.kind === "image" ? plan.get(artifact.targetId)?.depends_on || []
            : list(d.source.shots).filter(s => list(d.source.segments).find(seg => seg.id === artifact.targetId)?.shot_ids?.includes(s.id)).flatMap(s => s.required_assets || []);
        for (const id of dependencies) visit(String(id));
        const consumedAssets = [...new Set([...dependencies, ...(artifact.kind === "image" ? [artifact.targetId] : [])])];
        for (const id of consumedAssets) {
            const scope = String(plan.get(String(id))?.canvas_scope || (plan.get(String(id))?.sharedSource || canvasRole === "shared-assets" ? "shared" : "episode"));
            if (!["shared", "episode"].includes(scope)) throw new Error(`资产 ${id} 的画布归属无效：${scope}`);
            if (canvasRole === "shared-assets" && scope !== "shared") throw new Error(`资产 ${id} 标记为本集专用，不能在剧目共享资产画布生产`);
            if (canvasRole !== "shared-assets" && scope === "shared" && !plan.get(String(id))?.sharedSource) throw new Error(`共享资产 ${id} 尚未选择共享画布节点`);
        }
        for (const id of dependencies) {
            const asset = d.assets[String(id)];
            if (!asset || !asset.storageKey || !asset.sha256 || (plan.get(String(id))?.version && plan.get(String(id))?.version !== asset.version)) throw new Error(`产物 ${artifact.id} 依赖媒体未就绪或版本不一致：${id}`);
        }
        if (d.source.style_policy === "waived" && !String(d.source.style_policy_reason || "").trim()) throw new Error("风格豁免缺少用户决定与理由");
        const styleRequired = d.source.style_policy === "required";
        const styleAnchorNodeId = String(d.source.style_anchor_node_id || "");
        const planKind = String(plan.get(artifact.targetId)?.kind || plan.get(artifact.targetId)?.asset_type || "").toLowerCase();
        const isStyleAsset = artifact.kind === "image" && planKind === "style";
        if (artifact.kind === "image" && styleAnchorNodeId && !isStyleAsset) {
            const styleReference = artifact.references.at(-1);
            if (styleReference?.nodeId !== styleAnchorNodeId || styleReference.role !== "style") throw new Error("所选画布风格锚点未作为末槽风格参考编译");
        }
        if (artifact.kind === "image" && styleRequired && !isStyleAsset && !styleAnchorNodeId && artifact.targetId !== obj(d.source.style_lock).anchor_asset_id) {
            const styleId = String(obj(d.source.style_lock).anchor_asset_id || "");
            const style = d.assets[styleId];
            if (!style || !style.storageKey || !style.sha256 || artifact.references.at(-1)?.storageKey !== style.storageKey || !dependencies.includes(styleId)) throw new Error("缺少有效的末槽 STYLE_MOTHER 引用");
        }
        for (const ref of artifact.references) {
            const node = nodes.find(n => n.id === ref.nodeId);
            const archivedStoryboardBinding = !ref.nodeId && Boolean(ref.assetId)
                && isArchivedStoryboardKeyframeBinding({ director: d, nodes, targetId: artifact.targetId, assetId: String(ref.assetId), bindingId: ref.bindingId, storageKey: ref.storageKey, sha256: ref.sha256 });
            const meta = obj(node?.metadata);
            const boundStoryboardMedia = Boolean(node && String(node.type || "").startsWith("minimax-h3:")
                && list(meta.segments).some(segment => list(segment.referenceBindings).some(binding => binding.enabled !== false
                    && ["storyboard", "keyframe"].includes(String(binding.role || "")) && String(binding.storageKey || "") === ref.storageKey)));
            const keys = node ? [...(node.type === "character" ? resolveCanvasCharacterImageReferences(node) : resolveCanvasImageReferenceNode(node)).map(r => r.storageKey), node.storageKey, meta.storageKey, meta.resultStorageKey,
                ...(boundStoryboardMedia ? [ref.storageKey] : [])] : [];
            if ((!node || !keys.includes(ref.storageKey)) && !archivedStoryboardBinding) throw new Error(`参考不属于目标画布节点或正式分镜轨：${ref.label}`);
            const media = db.getMediaFile(ref.storageKey);
            if (!media || !fs.existsSync(media.filePath) || crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") !== ref.sha256) throw new Error(`参考媒体字节或版本不一致：${ref.label}`);
            const selectedCanvasStyleAnchor = ref.role === "style" && ref.nodeId === styleAnchorNodeId;
            const registeredAssetBinding = ref.assetId
                ? d.assets[ref.assetId]?.storageKey === ref.storageKey && d.assets[ref.assetId]?.sha256 === ref.sha256
                : Object.values(d.assets).some(a => a.nodeId === ref.nodeId && a.storageKey === ref.storageKey && a.sha256 === ref.sha256);
            if (!selectedCanvasStyleAnchor && !registeredAssetBinding && !archivedStoryboardBinding) throw new Error(`参考媒体未就绪或缺少可验证归属：${ref.label}`);
        }
    }
}

export function directorArtifact(data: EpisodeProductionData, kind: "image" | "h3", targetId: string) {
    const d = data.director;
    const a = d?.artifacts.find(a => a.kind === kind && a.targetId === targetId && a.status === "ready");
    if (!d || !a || !compilationArtifactFreshness(d, a).current || promptHash(a.prompt) !== a.sha256) throw new Error(`${targetId} 缺少当前版本完整 ${kind} 产物；请由 Acheng 编译，不从镜头摘要生成`);
    return a;
}
