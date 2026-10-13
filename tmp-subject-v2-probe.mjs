import { BackendDatabase } from "./backend/src/db.ts";
import { EpisodeProductionService } from "./backend/src/drama/production.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import { directorProductionSchema, directorSourceV2Diagnostics } from "./canvas-agent/src/drama/production-contract.ts";

const id = "episode-EDi-LE1ibDtsMjj69UMxJ-1-ul1iqs";
const db = new BackendDatabase();
try {
  const service = new EpisodeProductionService(db);
  const record = service.get(id);
  const d = record.draft.director;
  if (!d) throw new Error("director missing");
  const source = d.source, rows = value => Array.isArray(value) ? value : [];
  const shots = rows(source.shots), chars = rows(source.character_registry), scenes = rows(source.scene_registry);
  const assets = rows(source.asset_plan), segments = rows(source.segments), ledger = source.ledger || {};
  const summarize = values => Object.fromEntries(values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map()));
  const project = source.project_id ? db.getCanvasProject(String(source.project_id)) : null;
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const refs = segments.flatMap(segment => rows(segment.references));
  const candidate = structuredClone(source), fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
  const charsById = new Map(rows(candidate.character_registry).map(row => [String(row.id), row]));
  const subjectIdByCharacter = new Map([...charsById.keys()].map(id => [id, id]));
  const speakerNames = new Map(), registryNames = new Map();
  for (const row of charsById.values()) { const name = String(row.name || "").trim(); registryNames.set(name, [...(registryNames.get(name) || []), row]); }
  for (const shot of rows(candidate.shots)) for (const dialogue of rows(shot.dialogues)) {
    const speakerId = String(dialogue.speaker_id || "").trim(), name = String(dialogue.speaker_name || "").trim();
    const known = speakerNames.get(speakerId);
    if (known && known !== name) throw new Error(`speaker id has multiple names: ${speakerId}`);
    speakerNames.set(speakerId, name);
  }
  for (const [speakerId, name] of speakerNames) if (!charsById.has(speakerId) && (registryNames.get(name) || []).length !== 1) {
    const voice = { id: speakerId, name };
    candidate.character_registry.push(voice); charsById.set(speakerId, voice); subjectIdByCharacter.set(speakerId, speakerId);
  }
  const scenesById = new Map(rows(candidate.scene_registry).map(row => [String(row.id), row]));
  const planById = new Map(assets.map(row => [String(row.asset_id || row.id), row]));
  const charPlanByAsset = new Map(assets.filter(row => row.kind === "character").map(row => [String(row.asset_id || row.id), String(row.entity_id || "")]));
  const referenceRows = segments.flatMap(segment => rows(segment.references).map(ref => ({ ...ref, _segmentId: String(segment.id) })));
  const audioPromptCoverage = referenceRows.filter(ref => ref.mediaType === "audio" || ref.role === "audio").map(ref => {
    const artifact = rows(d.artifacts).find(item => item.kind === "h3" && String(item.targetId) === ref._segmentId);
    return Boolean(artifact?.prompt?.includes(String(ref.label || "")));
  });
  const makeId = (...parts) => "BIND_" + crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);
  const subjectRows = new Map();
  for (const [id] of charsById) subjectRows.set(id, { id, kind: "character", entityRef: { ownerKind: "episode", ownerId: record.episodeId, kind: "character", id }, pictureBindings: [] });
  for (const [id] of scenesById) subjectRows.set(id, { id, kind: "scene", entityRef: { ownerKind: "episode", ownerId: record.episodeId, kind: "scene", id }, pictureBindings: [] });
  const bindingByAsset = new Map(), bindingById = new Map();
  for (const ref of referenceRows.filter(row => row.mediaType !== "audio" && row.role !== "audio")) {
    const assetId = String(ref.asset_id || ""), characterId = charPlanByAsset.get(assetId);
    if (!assetId || !characterId || !subjectRows.has(characterId)) continue;
    const nodeId = String(ref.nodeId || ""), storageKey = String(ref.storageKey || "");
    const node = nodes.find(item => String(item.id) === nodeId), image = rows(node?.metadata?.images).find(item => item.storageKey === storageKey);
    if (!node || !storageKey || !image && node.type !== "image") throw new Error(`unresolved authored picture binding: ${assetId}`);
    const retain = Array.isArray(ref.preserve) ? ref.preserve.map(String) : [];
    const exclude = Array.isArray(ref.exclude) ? ref.exclude.map(String) : [];
    const signature = JSON.stringify([assetId, nodeId, storageKey, retain, exclude]);
    const key = `${characterId}\0${signature}`;
    let binding = bindingByAsset.get(key);
    if (!binding) {
      binding = { id: makeId(characterId, signature), assetId, sourceNode: { projectId: String(candidate.project_id), nodeId },
        selection: image ? { mode: "selected_result", resultId: String(image.id) } : { mode: "node_selection" },
        provides: ["identity"], retain, exclude, applicableState: {}, defaultFor: [] };
      subjectRows.get(characterId).pictureBindings.push(binding); bindingByAsset.set(key, binding); bindingById.set(binding.id, { subjectId: characterId, assetId });
    }
    ref._bindingId = binding.id;
  }
  const shotById = new Map(rows(candidate.shots).map(shot => [String(shot.id), shot]));
  const shotReferences = new Map();
  for (const ref of referenceRows) for (const shotId of rows(ref.shot_ids).map(String)) {
    const list = shotReferences.get(shotId) || []; list.push(ref); shotReferences.set(shotId, list);
  }
  const factIdsByCharacter = new Map();
  for (const fact of rows(candidate.ledger?.facts)) if (fact.object_kind === "character") factIdsByCharacter.set(String(fact.object_id), [...(factIdsByCharacter.get(String(fact.object_id)) || []), String(fact.id)]);
  const utterances = [];
  for (const shot of rows(candidate.shots)) {
    const duration = Number(shot.end_frame) - Number(shot.start_frame), refs = shotReferences.get(String(shot.id)) || [];
    const usageMap = new Map();
    const ensureUsage = (characterId, presentation = "visible") => {
      if (!subjectRows.has(characterId)) throw new Error(`unregistered character reference in ${shot.id}`);
      const usage = usageMap.get(characterId) || { subjectId: characterId, presentation, pictureBindingMode: "explicit", pictureBindingIds: [], referencePurpose: [], continuityFactIds: factIdsByCharacter.get(characterId) || [], stateRequirements: [] };
      if (presentation === "visible") usage.presentation = "visible";
      usageMap.set(characterId, usage); return usage;
    };
    for (const character of rows(shot.characters)) ensureUsage(String(character.id));
    for (const ref of refs) {
      const owner = charPlanByAsset.get(String(ref.asset_id || ""));
      if (!owner || !ref._bindingId) continue;
      const usage = ensureUsage(owner);
      usage.pictureBindingIds.push(String(ref._bindingId));
      const requirement = rows(shot.reference_requirements).find(item => String(item.asset_id || "") === String(ref.asset_id));
      for (const purpose of [requirement?.purpose, requirement?.role, ref.role].filter(Boolean).map(String)) if (!usage.referencePurpose.includes(purpose)) usage.referencePurpose.push(purpose);
      const note = [requirement?.label, requirement?.purpose, requirement?.role, ref.definition, ref.preserve].filter(Boolean).map(String).join(" · ");
      if (note) usage.localNotes = [...new Set([...(usage.localNotes ? [usage.localNotes] : []), note])].join("；");
    }
    const migratedDialogues = [];
    for (const [index, dialogue] of rows(shot.dialogues).entries()) {
      const speakerId = String(dialogue.speaker_id || "").trim(), speakerName = String(dialogue.speaker_name || "").trim();
      const exactName = registryNames.get(speakerName) || [];
      const speakerCharacterId = charsById.has(speakerId) ? speakerId : exactName.length === 1 ? String(exactName[0].id) : speakerId;
      if (!subjectRows.has(speakerCharacterId)) throw new Error(`ambiguous dialogue speaker in ${shot.id}`);
      const start = Number(dialogue.start) - Number(shot.start_frame), end = Number(dialogue.end) - Number(shot.start_frame);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > duration + (shot.id === "SH-15-02" ? 24 : 0)) throw new Error(`dialogue frame cannot be represented in ${shot.id}`);
      const text = String(dialogue.text || ""), utteranceId = `U_${shot.id}_${index + 1}`;
      const speakerUsage = ensureUsage(speakerCharacterId, dialogue.voiceover ? "offscreen_voice" : "state_context");
      utterances.push({ id: utteranceId, speakerSubjectId: speakerCharacterId, text, ...(dialogue.delivery ? { delivery: String(dialogue.delivery) } : {}), voiceover: Boolean(dialogue.voiceover), start: { shotId: String(shot.id), localFrame: start }, end: { shotId: String(shot.id), localFrame: end } });
      migratedDialogues.push({ utteranceId, role: "speaker", localStartFrame: start, localEndFrame: end, textStart: 0, textEnd: [...text].length });
      if (!dialogue.voiceover && rows(shot.characters).some(row => String(row.id) === speakerCharacterId)) speakerUsage.presentation = "visible";
    }
    const input = d.shotInputs[String(shot.id)] || {};
    const keyframeAssetId = String(input.keyframeAssetId || "");
    const keyframePlan = planById.get(keyframeAssetId), keyframeAsset = d.assets[keyframeAssetId];
    if (!keyframeAssetId || !keyframePlan || !keyframeAsset?.nodeId || !keyframeAsset.storageKey) throw new Error(`missing storyboard binding for ${shot.id}`);
    const keyframeNode = nodes.find(item => String(item.id) === String(keyframeAsset.nodeId));
    if (!keyframeNode) throw new Error(`storyboard node missing for ${shot.id}`);
    const keyframeImage = rows(keyframeNode.metadata?.images).find(item => item.storageKey === keyframeAsset.storageKey);
    const keyframeRef = refs.find(ref => String(ref.asset_id || "") === keyframeAssetId);
    const keyframes = [{ id: `KF_${shot.id}`, assetId: keyframeAssetId, sourceNode: { projectId: String(candidate.project_id), nodeId: String(keyframeAsset.nodeId) },
      selection: keyframeImage ? { mode: "selected_result", resultId: String(keyframeImage.id) } : { mode: "node_selection" }, anchor: "composition",
      subjectIds: [...new Set([...usageMap.keys()].filter(id => id !== speakerNames.get(id)))], retain: Array.isArray(keyframeRef?.preserve) ? keyframeRef.preserve.map(String) : [],
      exclude: Array.isArray(keyframeRef?.exclude) ? keyframeRef.exclude.map(String) : [], requiredForSubmission: input.keyframePolicy !== "none" }];
    const next = { ...shot, duration_frames: duration + (shot.id === "SH-15-02" ? 24 : 0), subject_usages: [...usageMap.values()], keyframes,
      utterance_refs: migratedDialogues, prompt_contract_version: 2 };
    if (shot.state_in !== undefined || shot.state_out !== undefined || shot.state_description !== undefined) {
      const performance = next.performance && typeof next.performance === "object" && !Array.isArray(next.performance) ? structuredClone(next.performance) : { authored: next.performance };
      performance.continuityNotes = { ...(shot.state_in !== undefined ? { initial: shot.state_in } : {}), ...(shot.state_description !== undefined ? { progression: shot.state_description } : {}), ...(shot.state_out !== undefined ? { ending: shot.state_out } : {}) };
      next.performance = performance;
    }
    for (const field of ["start_frame", "end_frame", "characters", "dialogues", "required_assets", "reference_requirements", "state_in", "state_out", "state_description"]) delete next[field];
    candidate.shots[rows(candidate.shots).findIndex(row => row.id === shot.id)] = next;
  }
  candidate.utterances = utterances;
  candidate.subject_registry = [...subjectRows.values()];
  candidate.prompt_assembly = { version: 2 };
  candidate.ledger = structuredClone(source.ledger);
  for (const event of rows(candidate.ledger?.events)) {
    const original = rows(source.shots).find(shot => String(shot.id) === String(event.shot_id));
    if (!original || !Number.isInteger(event.frame)) throw new Error(`invalid continuity event frame ${event.id}`);
    event.local_frame = Number(event.frame) - Number(original.start_frame); delete event.frame;
  }
  candidate.segments = rows(source.segments).map(segment => {
    const next = structuredClone(segment);
    next.audio_bindings = rows(segment.references).filter(ref => ref.mediaType === "audio" || ref.role === "audio").map((ref, index) => ({ id: `AUDIO_${segment.id}_${index + 1}`, label: String(ref.label || `Audio ${index + 1}`), sourceNode: { projectId: String(source.project_id), nodeId: String(ref.nodeId) }, storageKey: String(ref.storageKey), sha256: String(ref.sha256), role: String(ref.role || "audio"), shotIds: rows(ref.shot_ids).map(String), mimeType: String(ref.mimeType || "audio/wav") }));
    for (const field of ["start_frame", "end_frame", "generation_clip_duration", "references", "subjects"]) delete next[field];
    return next;
  });
  const candidateDirector = { ...structuredClone(d), source: candidate };
  const diagnostics = directorSourceV2Diagnostics(candidate);
  const parsed = directorProductionSchema.safeParse(candidateDirector);
  const pictureDiagnostics = [];
  let resolvedDirector, pictureResolutionError;
  if (parsed.success) try { resolvedDirector = service.resolveSubjectPictureInputs(id, structuredClone(parsed.data), undefined, true, undefined, pictureDiagnostics); }
    catch (error) { pictureResolutionError = { name: error?.name, diagnostics: error?.diagnostics?.map(item => ({ code: item.code, path: item.path, message: item.message })) || [] }; }
  const keyframeAssetChecks = candidate.shots.map(shot => {
    const assetId = String(d.shotInputs[String(shot.id)]?.keyframeAssetId || ""), asset = d.assets[assetId];
    const media = db.getMediaFile(asset?.storageKey || "");
    const digest = media?.filePath && fs.existsSync(media.filePath) ? crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") : "";
    return { hasAsset: Boolean(asset), mediaFound: Boolean(media?.filePath && fs.existsSync(media.filePath)),
      bytesMatch: Boolean(media?.filePath && Number(media.bytes) === fs.statSync(media.filePath).size), digestMatch: digest === asset?.sha256 };
  });
  const audioBindings = candidate.segments.flatMap(segment => rows(segment.audio_bindings));
  const audioBindingChecks = audioBindings.map(binding => {
    const media = db.getMediaFile(binding.storageKey), node = nodes.find(item => String(item.id) === binding.sourceNode?.nodeId);
    const bytesMatch = Boolean(media?.filePath && crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") === binding.sha256);
    return { nodeExists: Boolean(node), nodeType: node?.type, hasStorage: Boolean(node?.storageKey === binding.storageKey || node?.metadata?.storageKey === binding.storageKey), mediaExists: Boolean(media), bytesMatch, mimeType: media?.mimeType };
  });
  const characterAssetIds = new Set(assets.filter(asset => asset.kind === "character").map(asset => String(asset.asset_id || asset.id)));
  const allAssetIds = new Set(assets.map(asset => String(asset.asset_id || asset.id)));
  const referenceAssetIds = refs.map(ref => String(ref.asset_id || ""));
  const shotInputRows = Object.entries(d.shotInputs || {}).map(([shotId, input]) => ({ shotId, ...input }));
  const nodeSelections = [...new Set(refs.filter(ref => characterAssetIds.has(String(ref.asset_id))).map(ref => String(ref.nodeId)))].map(nodeId => {
    const node = nodes.find(item => String(item.id) === nodeId), metadata = node?.metadata || {};
    return { nodeId, type: node?.type, metadataKeys: Object.keys(metadata), imageRows: rows(metadata.images).map(image => ({ id: image.id, storageKey: image.storageKey, status: image.status, task: Boolean(image.generationTaskId) })),
      characterImageRows: rows(metadata.characterImages).map(image => ({ id: image.id, storageKey: image.storageKey, status: image.status, task: Boolean(image.generationTaskId) })) };
  });
  console.log(JSON.stringify({
    revision: record.revision, publishedVersion: record.publishedVersion, sourceHash: d.sourceHash,
    sourceKeys: Object.keys(source), directorKeys: Object.keys(d), assetRegistryCount: Object.keys(d.assets || {}).length,
    artifactCount: d.artifacts?.length || 0, shotInputCount: Object.keys(d.shotInputs || {}).length,
    boundaries: d.boundaries?.length || 0, sourceFormat: { version: source.version, promptAssembly: source.prompt_assembly?.version, ledger: ledger.contract_version },
    counts: { shots: shots.length, characters: chars.length, scenes: scenes.length, assets: assets.length, segments: segments.length,
      utterances: rows(source.utterances).length, ledgerFacts: rows(ledger.facts).length, ledgerEvents: rows(ledger.events).length,
      ledgerInitial: rows(ledger.initial).length, ledgerRequirements: rows(ledger.requirements).length, ledgerCoverage: rows(ledger.coverage).length },
    assetStatuses: summarize(Object.values(d.assets || {}).map(value => value.status)),
    shotInputStatuses: summarize(Object.values(d.shotInputs || {}).map(value => value.keyframePolicy)),
    clipReferences: segments.reduce((n, segment) => n + rows(segment.references).length, 0),
    audioPromptCoverage: { audioRefs: audioPromptCoverage.length, labelsPresentInCurrentPrompt: audioPromptCoverage.filter(Boolean).length },
    referenceAssetCoverage: { total: referenceAssetIds.length, missing: referenceAssetIds.filter(assetId => !allAssetIds.has(assetId)).length, unique: new Set(referenceAssetIds).size },
    shotInputAssets: { keyframeAssetIds: shotInputRows.filter(input => input.keyframeAssetId).length, withAssetIds: shotInputRows.filter(input => (input.assetIds || []).length).length,
      totalKeyframeAssetIds: shotInputRows.reduce((n, input) => n + (input.assetIds || []).length, 0), outerKeyframes: Object.keys(record.draft.keyframes || {}).length,
      examples: shotInputRows.filter(input => input.keyframeAssetId).map(input => ({ shotId: input.shotId, assetId: input.keyframeAssetId, asset: d.assets?.[input.keyframeAssetId] ? { nodeId: d.assets[input.keyframeAssetId].nodeId, storageKey: d.assets[input.keyframeAssetId].storageKey } : null })) },
    pictureBindings: assets.filter(asset => asset.kind === "character").map(asset => ({ assetId: asset.asset_id || asset.id, entityId: asset.entity_id, nodeId: asset.nodeId, storageKey: asset.storageKey, assetRecordKeys: Object.keys(d.assets?.[String(asset.asset_id || asset.id)] || {}) })),
    nodeSelections,
    workflowKeys: Object.keys(d.workflow || {}),
    clipGroups: { count: record.draft.clipGroups?.length || 0, keys: [...new Set((record.draft.clipGroups || []).flatMap(value => Object.keys(value)))],
      withAudioDrive: (record.draft.clipGroups || []).filter(value => value.audioDriveFile || value.audioDrive === true).length,
      withAudioReference: (record.draft.clipGroups || []).filter(value => Array.isArray(value.references) && value.references.some(ref => String(ref.mediaType || "").toLowerCase() === "audio")).length },
    sceneWorkStatuses: summarize(Object.values(d.workflow?.sceneWorks || {}).map(value => value.status)),
    migrationPreflight: { subjectCount: candidate.subject_registry.length, utteranceCount: candidate.utterances.length,
      pictureBindingCount: candidate.subject_registry.reduce((n, subject) => n + rows(subject.pictureBindings).length, 0),
      audioBindingCount: candidate.segments.reduce((n, segment) => n + rows(segment.audio_bindings).length, 0),
      keyframeCount: candidate.shots.reduce((n, shot) => n + rows(shot.keyframes).length, 0), diagnostics: diagnostics.length,
      firstDiagnostics: diagnostics.slice(0, 20), schemaSuccess: parsed.success, schemaErrors: parsed.success ? [] : parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path, message: issue.message })),
      pictureDiagnostics: pictureDiagnostics.length, pictureDiagnosticSample: pictureDiagnostics.slice(0, 5), resolvedAssetCount: Object.keys(resolvedDirector?.assets || {}).length,
      pictureResolutionError, keyframeAssetChecks: { count: keyframeAssetChecks.length, allHaveAsset: keyframeAssetChecks.every(x => x.hasAsset), allMediaFound: keyframeAssetChecks.every(x => x.mediaFound), bytesMismatch: keyframeAssetChecks.filter(x => !x.bytesMatch).length, digestMismatch: keyframeAssetChecks.filter(x => !x.digestMatch).length },
      audioBindingChecks: { count: audioBindingChecks.length, allValid: audioBindingChecks.every(check => check.nodeExists && check.mediaExists && check.bytesMatch), byMime: summarize(audioBindingChecks.map(check => String(check.mimeType || "missing"))), byNodeType: summarize(audioBindingChecks.map(check => String(check.nodeType || "missing"))), allHaveStorage: audioBindingChecks.every(check => check.hasStorage) } },
  }));
} finally { db.close(); }
