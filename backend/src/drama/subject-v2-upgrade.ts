/** Deterministic v1 → Subject Prompt v2 source migration (drag/repartition capable). */
import { directorSourceV2Diagnostics } from "@basketikun/canvas-agent/drama/production-contract";

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
const str = (value: unknown) => String(value ?? "");
const cleanId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "X";

export type SubjectV2UpgradeResult = { source: Row; notes: string[]; issues: Array<{ path: (string | number)[]; message: string }> };

export function convertDirectorSourceToSubjectV2(episodeId: string, input: Row): SubjectV2UpgradeResult {
    const notes: string[] = [];
    const source = structuredClone(input);
    const fps = Number(source.fps_num || 24) / Math.max(1, Number(source.fps_den || 1));
    const ownerId = str(episodeId);
    const subjects: Row[] = [];
    const subjectByEntity = new Map<string, string>();
    const registerSubject = (entityKind: "character" | "scene" | "asset", entityId: string, subjectKind: "character" | "scene" | "prop") => {
        const key = `${entityKind}:${entityId}`;
        const known = subjectByEntity.get(key);
        if (known) return known;
        const id = `SUB_${subjects.length + 1}_${cleanId(entityId)}`;
        subjects.push({ id, kind: subjectKind, entityRef: { ownerKind: "episode", ownerId, kind: entityKind, id: entityId } });
        subjectByEntity.set(key, id);
        return id;
    };
    const characterNames = new Map<string, string>();
    for (const character of rows(source.character_registry)) {
        const id = str(character.id); if (!id) continue;
        characterNames.set(str(character.name).trim(), id);
        registerSubject("character", id, "character");
    }
    for (const scene of rows(source.scene_registry)) { const id = str(scene.id); if (id) registerSubject("scene", id, "scene"); }
    for (const plan of rows(source.asset_plan)) {
        const assetId = str(plan.asset_id || plan.id); if (!assetId) continue;
        registerSubject("asset", assetId, plan.kind === "character" ? "character" : plan.kind === "scene" ? "scene" : "prop");
    }
    const subjectForSpeaker = (dialogue: Row, extraCharacters: Row[]) => {
        const name = str(dialogue.speaker_name).trim();
        const byName = characterNames.get(name);
        if (byName) return registerSubject("character", byName, "character");
        const speakerId = `CHAR_OFF_${cleanId(str(dialogue.speaker_id) || name || "voice")}`;
        if (!extraCharacters.some(character => str(character.id) === speakerId)) {
            extraCharacters.push({ id: speakerId, name: name || str(dialogue.speaker_id) || "画外音", identity: "Offscreen speaker migrated from legacy dialogue.", prompt_description: str(dialogue.delivery) });
            characterNames.set(name, speakerId);
        }
        return registerSubject("character", speakerId, "character");
    };

    const shots = rows(source.shots);
    const utterances: Row[] = [];
    const extraCharacters: Row[] = [];
    const orderCounters = new Map<string, number>();
    const migratedShots = shots.map(shot => {
        const shotId = str(shot.id);
        const startFrame = Number(shot.start_frame || 0);
        const rawDuration = Number.isFinite(Number(shot.end_frame)) && shot.end_frame !== undefined
            ? Number(shot.end_frame) - startFrame
            : Math.round(Number(shot.duration_seconds || 0) * fps);
        const duration = Math.max(1, Number.isFinite(rawDuration) ? rawDuration : Math.round(4 * fps));
        const timelineId = str(shot.timeline_id || "main");
        const order = orderCounters.get(timelineId) || 0;
        orderCounters.set(timelineId, order + 1);

        const usages: Row[] = [];
        const offscreen: string[] = [];
        const subjectHasBindings = (subjectId: string) => rows(subjects.find(subject => subject.id === subjectId)?.pictureBindings).length > 0;
        for (const character of rows(shot.characters)) {
            const id = str(character.id); if (!id) continue;
            const subjectId = registerSubject("character", id, "character");
            // 迁移后主体还没有 pictureBindings；visible 会触发 identity 默认绑定校验失败，先以 state_context 入场。
            usages.push({ subjectId, presentation: subjectHasBindings(subjectId) ? "visible" : "state_context", pictureBindingIds: [], referencePurpose: [], continuityFactIds: [], stateRequirements: [] });
        }
        for (const assetId of rows(shot.required_assets).map(item => typeof item === "string" ? item : str(item?.asset_id || item?.id))) {
            if (!assetId) continue;
            usages.push({ subjectId: registerSubject("asset", assetId, "prop"), presentation: "state_context", pictureBindingIds: [], referencePurpose: [], continuityFactIds: [], stateRequirements: [] });
        }
        const refs: Row[] = [];
        for (const [index, dialogue] of rows(shot.dialogues).entries()) {
            const text = str(dialogue.text).trim(); if (!text) continue;
            const speakerSubjectId = subjectForSpeaker(dialogue, extraCharacters);
            const utteranceId = `U_${cleanId(shotId)}_${index + 1}`;
            const voiceover = Boolean(dialogue.voiceover);
            if (voiceover && !rows(shot.characters).some(character => subjectByEntity.get(`character:${str(character.id)}`) === speakerSubjectId)) {
                if (!offscreen.includes(speakerSubjectId)) offscreen.push(speakerSubjectId);
                if (!usages.some(usage => usage.subjectId === speakerSubjectId)) {
                    usages.push({ subjectId: speakerSubjectId, presentation: "offscreen_voice", pictureBindingIds: [], referencePurpose: [], continuityFactIds: [], stateRequirements: [] });
                }
            }
            const localStart = Math.min(Math.max(Math.round(Number(dialogue.start ?? 0) - startFrame), 0), Math.max(0, duration - 1));
            let localEnd = Math.round(Number(dialogue.end ?? startFrame + duration) - startFrame);
            if (!Number.isFinite(localEnd) || localEnd <= localStart) localEnd = localStart + 1;
            localEnd = Math.min(localEnd, duration);
            utterances.push({ id: utteranceId, speakerSubjectId, text, delivery: str(dialogue.delivery) || undefined, voiceover, start: { shotId, localFrame: localStart }, end: { shotId, localFrame: localEnd } });
            refs.push({ utteranceId, role: "speaker", localStartFrame: localStart, localEndFrame: localEnd, textStart: 0, textEnd: text.length });
        }
        const next: Row = {
            id: shotId, title: str(shot.title || shot.display_name) || undefined, visual: shot.visual, scene_id: shot.scene_id, camera: shot.camera,
            audio: shot.audio, features: shot.features, outcome_events: shot.outcome_events,
            timeline_id: timelineId, story_order: order, duration_frames: duration,
            subject_usages: usages, keyframes: [], utterance_refs: refs,
            offscreen_character_ids: offscreen, prompt_contract_version: 2,
        };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next;
    });

    if (extraCharacters.length) {
        source.character_registry = [...rows(source.character_registry), ...extraCharacters];
        notes.push(`为画外音/未登记说话人补充了 ${extraCharacters.length} 个角色档案：${extraCharacters.map(character => str(character.name) || str(character.id)).join("、")}`);
    }
    source.prompt_assembly = { version: 2 };
    source.shots = migratedShots;
    source.utterances = utterances;
    source.subject_registry = subjects;
    // v2 Clip 由 Shots 派生：只保留编组/执行配置字段，时长与参考由编译派生。
    source.segments = rows(source.segments).map(segment => {
        const next: Row = { id: str(segment.id), shot_ids: Array.isArray(segment.shot_ids) ? segment.shot_ids.map(str) : [],
            mode: segment.mode, mode_lock: segment.mode_lock, mode_selection_reason: segment.mode_selection_reason };
        if (segment.styleTemplateId !== undefined) next.styleTemplateId = segment.styleTemplateId;
        return next;
    });
    if (source.ledger && source.ledger.contract_version !== 2) {
        source.legacyContinuityProjection = source.ledger;
        notes.push("旧连续性账本整体保留在 legacyContinuityProjection，v2 台账为空白基线（facts/requirements 需在连续性工作台重建）");
    } else if (!source.ledger) {
        notes.push("旧稿没有连续性账本，已创建空白 v2 台账");
    }
    source.ledger = { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] };
    notes.push(`Subject 画像绑定（pictureBindings）为空：迁移后请在 Subject 工作台为每个主体重新挂接画布图片，挂好后把对应镜头的 subject_usages.presentation 改回 visible，编译生成才会带参考图`);
    const dropped = shots.reduce((count, shot) => count + rows(shot.dialogues).length, 0);
    notes.push(`已结构化迁移 ${dropped} 条对白为 utterances/utterance_refs；state_in/state_out/required_prop_ids/reference_requirements 等旧 prose 字段随 v1 弃用`);
    const issues = directorSourceV2Diagnostics(source);
    return { source, notes, issues };
}
