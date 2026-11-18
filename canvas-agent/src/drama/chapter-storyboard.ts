/**
 * 章节分镜草案 → 正式制作稿的 Shot / Clip 计划（纯函数，不写库、不调模型）。
 *
 * 方案 A 的第二跳：一次提示词产出的「场次 → 镜头 → 台词」草案，在这里被翻译成
 * `replace_director_scene_storyboard` 能直接吃的形状。规则全部来自
 * backend/src/drama/scene-storyboard.ts 的硬校验，写错一条就会被拒：
 * - 镜头只给正整数 `duration_frames`，**不能出现** start_frame / end_frame；
 * - 镜头必须属于某个 environmentId 场次（scene_id）；
 * - 同一场次只有一个叙事时间线（默认 main）；
 * - Clip 不保存任何帧窗字段，时长由镜头时长求和派生；
 * - 每个 Clip 必须完整覆盖本场次的镜头，且镜头顺序与片中位置一致。
 *
 * 这里不猜剧情、不改写画面描述，只做时长量化、分段与稳定 ID，让「同一章跑两次」得到
 * 同一批 ID，重跑幂等、不会在制作稿里堆重复镜头。
 */


export type ChapterBeat = {
    /** 镜头标题，进 Shot.title。 */
    title: string;
    /** 画面描述，进 Shot.visual；H3 提示词正文的主要来源。 */
    visual: string;
    /** 运镜，进 Shot.camera；省略时按固定镜头处理。 */
    camera?: string;
    /** 时长（秒，允许小数）；按 fps 量化成帧。 */
    seconds: number;
    /** 本镜台词全文；与 speaker 同时给出时才写入。 */
    dialogue?: string;
    /** 台词说话人称呼（契约里 speakerName 路径，不需要先登记 Subject）。 */
    speaker?: string;
};

export type ChapterScenePlan = {
    /** 章节内的场次键，只用于生成稳定 ID，不进正式稿。 */
    sceneKey: string;
    /** 场次名；仅用于诊断输出。 */
    sceneName?: string;
    /** 已登记的场景环境 ID（scene_registry 的 id），写进 Shot.scene_id。 */
    environmentId: string;
    beats: ChapterBeat[];
};

export type ChapterStoryboardInput = {
    /** 章节标识（建议用分集 ID 或章节 hash），参与稳定 ID 计算。 */
    chapterId: string;
    scenes: ChapterScenePlan[];
    /** 帧率，默认 24（与制作稿 fps_num/fps_den 一致）。 */
    fps?: number;
    /** 单段 Clip 的目标时长上限，默认 5 秒；以 H3 实际档位为准由调用方覆盖。 */
    clipSeconds?: number;
    /** 单镜最短时长，默认 1 秒；过短的镜头被抬到该值而不是被丢弃。 */
    minShotSeconds?: number;
    /** 叙事时间线，默认 main。 */
    timelineId?: string;
    /** Clip 执行模式；默认 T2VA（无参考图）。绑定了身份/场景参考时传 Ref2VA。 */
    executionMode?: SegmentExecutionMode;
};

/** 编译器（canvas_source_contract.py）只认这七个景别，写别的值直接判非法。 */
export type ShotFraming = "EWS" | "WS" | "FS" | "MS" | "MCU" | "CU" | "ECU";

/**
 * Shot.camera 是对象而不是一句运镜描述。编译器强制要求 `framing` 与 `editorial_reason`
 * 非空（`INVALID_SUBJECT_SOURCE`），缺了连发布都过不去 —— 这正是「写稿成功、画布没东西」的根因之一。
 */
export type ShotCamera = {
    description: string;
    framing: ShotFraming;
    editorial_reason: string;
    lens_mm: number;
    sensor_basis: string;
    shutter_angle: number;
};

export type PlannedShot = {
    id: string;
    scene_id: string;
    timeline_id: string;
    story_order: number;
    title: string;
    visual: string;
    camera: ShotCamera;
    duration_frames: number;
    duration_seconds: number;
    dialogue?: { speaker: string; text: string };
};

/** H3 的执行模式枚举；`h3` 不是合法值，必须落到这五个之一。 */
export type SegmentExecutionMode = "T2VA" | "I2VA" | "FL2VA" | "L2VA" | "Ref2VA";

export type PlannedSegment = {
    id: string;
    shot_ids: string[];
    /** 交付给 H3 的批次模式；无参考图时用 T2VA，有身份/场景参考时用 Ref2VA。 */
    mode: SegmentExecutionMode;
};

export type StoryboardPlan = {
    shots: PlannedShot[];
    segments: PlannedSegment[];
    totalFrames: number;
    totalSeconds: number;
    /** 非致命提示：镜头被抬到最短时长、单镜超过单段上限而独占一段等。 */
    diagnostics: string[];
};

const DEFAULT_FPS = 24;
// 对齐影策：剧情段目标 8–15 秒（编译器硬限 4–15）。影策真实段多为 10–11 秒，
// 旧默认 5 秒导致实测每段只有 5–6 秒，远低于 UI 标注的「剧情段8–15秒」。
const DEFAULT_CLIP_SECONDS = 10;
const DEFAULT_MIN_SHOT_SECONDS = 1;

/**
 * 稳定 ID 只要求「同输入同输出、不同输入不同输出」，不需要密码学强度：
 * 用 FNV-1a 两轮得到 ~62 bit，浏览器与 Node 都能跑（不引入 node:crypto）。
 */
function stableId(prefix: string, ...parts: Array<string | number>) {
    const text = parts.map(value => String(value)).join("|");
    let first = 0x811c9dc5, second = 0x01000193;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second + code, 0x85ebca6b) >>> 0;
        second = (second ^ (second >>> 13)) >>> 0;
    }
    return `${prefix}-${first.toString(36)}${second.toString(36)}`.slice(0, prefix.length + 1 + 12);
}

/**
 * 从运镜/画面文字里认景别。认不出来就按中景（MS）——它是能同时容纳动作与表情的
 * 安全档位；猜错景别不会阻断编译，但缺 `framing` 会。
 */
export function inferFraming(text: string): ShotFraming {
    const value = String(text || "");
    if (/大特写|极端特写/.test(value)) return "ECU";
    if (/特写/.test(value)) return "CU";
    if (/近景/.test(value)) return "MCU";
    if (/中景/.test(value)) return "MS";
    if (/全身/.test(value)) return "FS";
    if (/大远景|极远景/.test(value)) return "EWS";
    if (/全景|远景|空镜/.test(value)) return "WS";
    return "MS";
}

/** 焦距跟着景别走：特写用长焦压缩，全景用广角交代空间。 */
const LENS_BY_FRAMING: Record<ShotFraming, number> = { EWS: 24, WS: 28, FS: 35, MS: 50, MCU: 85, CU: 85, ECU: 100 };

/**
 * 组装 Shot.camera：`framing` 与 `editorial_reason` 是编译器的必填项，
 * `description` 缺省时退回运镜文本或画面描述首句，保证提示词里有可读的机位说明。
 */
export function buildShotCamera(input: { camera?: string; visual?: string; framing?: ShotFraming }): ShotCamera {
    const movement = String(input.camera || "").trim();
    const framing = input.framing || inferFraming(movement || String(input.visual || ""));
    const description = movement || "固定机位，按画面描述构图";
    const reason = movement || String(input.visual || "").trim().slice(0, 60) || "推进当前节拍的情绪落点";
    return {
        description,
        framing,
        editorial_reason: reason,
        lens_mm: LENS_BY_FRAMING[framing],
        sensor_basis: "full-frame equivalent",
        shutter_angle: 180,
    };
}

/**
 * 把章节草案排成可直接提交的 Shot / Clip 计划。
 * 结构性错误（没有场次、场次没有镜头、环境 ID 为空）抛 `CODE: message`，与制作台的报错风格一致。
 */
export function planChapterStoryboard(input: ChapterStoryboardInput): StoryboardPlan {
    const fps = Math.max(1, Math.floor(input.fps ?? DEFAULT_FPS));
    const clipFrames = Math.max(1, Math.round(Math.max(0.5, input.clipSeconds ?? DEFAULT_CLIP_SECONDS) * fps));
    const minFrames = Math.max(1, Math.round(Math.max(0.1, input.minShotSeconds ?? DEFAULT_MIN_SHOT_SECONDS) * fps));
    const timelineId = (input.timelineId || "main").trim() || "main";
    // 编译器只认 T2VA/I2VA/FL2VA/L2VA/Ref2VA；无参考图的分镜走 T2VA。
    const mode: SegmentExecutionMode = input.executionMode || "T2VA";
    const scenes = (input.scenes || []).filter(scene => scene && Array.isArray(scene.beats));
    if (!scenes.length) throw new Error("CHAPTER_STORYBOARD_EMPTY: 章节草案没有场次");
    if (!input.chapterId?.trim()) throw new Error("CHAPTER_STORYBOARD_CHAPTER: 缺少章节标识");

    const shots: PlannedShot[] = [];
    const segments: PlannedSegment[] = [];
    const diagnostics: string[] = [];
    let order = 0;

    for (const scene of scenes) {
        const environmentId = String(scene.environmentId || "").trim();
        if (!environmentId) throw new Error(`CHAPTER_STORYBOARD_ENVIRONMENT: 场次 ${scene.sceneKey || "(未命名)"} 缺少 environmentId`);
        const beats = scene.beats.filter(beat => beat && String(beat.visual || "").trim());
        if (!beats.length) throw new Error(`CHAPTER_STORYBOARD_BEATS: 场次 ${scene.sceneKey || environmentId} 没有可用镜头`);

        const sceneShots: PlannedShot[] = [];
        beats.forEach((beat, beatIndex) => {
            const seconds = Number(beat.seconds);
            const rawFrames = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * fps) : minFrames;
            const durationFrames = Math.max(minFrames, rawFrames);
            if (Number.isFinite(seconds) && seconds > 0 && durationFrames !== rawFrames) diagnostics.push(`镜头「${beat.title}」时长过短，已抬到 ${minFrames} 帧`);
            if (!Number.isFinite(seconds) || seconds <= 0) diagnostics.push(`镜头「${beat.title}」缺少有效时长，按 ${minFrames} 帧处理`);
            if (durationFrames > clipFrames) diagnostics.push(`镜头「${beat.title}」${durationFrames} 帧超过单段 ${clipFrames} 帧，将独占一段`);
            const shot: PlannedShot = {
                id: stableId("shot", input.chapterId, scene.sceneKey || environmentId, beatIndex, beat.title, beat.visual),
                scene_id: environmentId,
                timeline_id: timelineId,
                story_order: order + beatIndex,
                title: beat.title || `镜头 ${beatIndex + 1}`,
                visual: beat.visual.trim(),
                camera: buildShotCamera({ camera: beat.camera, visual: beat.visual }),
                duration_frames: durationFrames,
                duration_seconds: Number((durationFrames / fps).toFixed(3)),
            };
            const speaker = String(beat.speaker || "").trim();
            const text = String(beat.dialogue || "").trim();
            if (speaker && text) shot.dialogue = { speaker, text };
            else if (text && !speaker) diagnostics.push(`镜头「${beat.title}」有台词但没说话人，未写入对白`);
            sceneShots.push(shot);
        });
        order += sceneShots.length;
        shots.push(...sceneShots);
        segments.push(...planSceneSegments(input.chapterId, scene, sceneShots, clipFrames, diagnostics, mode, fps));
    }

    const totalFrames = shots.reduce((sum, shot) => sum + shot.duration_frames, 0);
    return {
        shots,
        segments,
        totalFrames,
        totalSeconds: Number((totalFrames / fps).toFixed(3)),
        diagnostics,
    };
}

/**
 * Clip 时长由 Shots 派生，且硬性落在 4–15 秒（编译器校验，越界直接拒）。
 * 切段策略：目标 5 秒一段；没到 4 秒下限就不切（继续装下一镜）；尾段不足 4 秒并入前一段。
 */
function planSceneSegments(chapterId: string, scene: ChapterScenePlan, shots: PlannedShot[], clipFrames: number, diagnostics: string[], mode: SegmentExecutionMode, fps: number): PlannedSegment[] {
    const minClipFrames = Math.round(4 * fps);
    const maxClipFrames = Math.round(15 * fps);
    const segments: PlannedSegment[] = [];
    let current: PlannedShot[] = [];
    let currentFrames = 0;
    const flush = () => {
        if (!current.length) return;
        const shotIds = current.map(shot => shot.id);
        segments.push({ id: stableId("clip", chapterId, scene.sceneKey || scene.environmentId, shotIds.join(",")), shot_ids: shotIds, mode });
        current = [];
        currentFrames = 0;
    };
    for (const shot of shots) {
        // 「装下这一镜会超目标」时才考虑切；但当前段还没到 4 秒下限就继续装
        //（除非装下会突破 15 秒硬上限，那时只能硬切并靠诊断提示）。
        const wouldOverflowTarget = currentFrames + shot.duration_frames > clipFrames;
        const wouldOverflowHard = currentFrames + shot.duration_frames > maxClipFrames;
        if (current.length && wouldOverflowHard) flush();
        else if (current.length && wouldOverflowTarget && currentFrames >= minClipFrames) flush();
        current.push(shot);
        currentFrames += shot.duration_frames;
    }
    flush();
    // 尾段不足 4 秒：并回前一段（合并后仍在 15 秒内）或者整体重排 —— 简单起见直接并回。
    if (segments.length >= 2) {
        const last = segments[segments.length - 1];
        if (last.shot_ids.length) {
            const lastFrames = shots.filter(shot => last.shot_ids.includes(shot.id)).reduce((sum, shot) => sum + shot.duration_frames, 0);
            if (lastFrames < minClipFrames) {
                const previous = segments[segments.length - 2];
                const previousFrames = shots.filter(shot => previous.shot_ids.includes(shot.id)).reduce((sum, shot) => sum + shot.duration_frames, 0);
                if (previousFrames + lastFrames <= maxClipFrames) {
                    previous.shot_ids = [...previous.shot_ids, ...last.shot_ids];
                    segments.pop();
                    diagnostics.push(`末段只有 ${(lastFrames / fps).toFixed(1)} 秒，低于 4 秒下限，已并入前一段`);
                }
            }
        }
    }
    for (const segment of segments) {
        const frames = shots.filter(shot => segment.shot_ids.includes(shot.id)).reduce((sum, shot) => sum + shot.duration_frames, 0);
        if (frames < minClipFrames) diagnostics.push(`Clip ${(frames / fps).toFixed(1)} 秒低于 4 秒下限，编译会被拒；请加长镜头或增加镜头数`);
        if (frames > maxClipFrames) diagnostics.push(`Clip ${(frames / fps).toFixed(1)} 秒超过 15 秒上限，编译会被拒；请拆分镜头`);
    }
    if (segments.length) {
        const covered = new Set(segments.flatMap(segment => segment.shot_ids));
        if (covered.size !== shots.length) diagnostics.push(`场次 ${scene.sceneKey || scene.environmentId} 的 Clip 未完整覆盖镜头`);
    }
    return segments;
}

/** 按场次拆成 `replace_director_scene_storyboard` 的 op 载荷，一场一次提交。 */
export function toSceneStoryboardOps(plan: StoryboardPlan, environmentOfScene: Map<string, string>) {
    const ops: Array<{ type: "replace_director_scene_storyboard"; sceneId: string; shots: Array<Record<string, unknown>>; segments: Array<Record<string, unknown>>; shotInputs: Record<string, unknown> }> = [];
    const byScene = new Map<string, PlannedShot[]>();
    for (const shot of plan.shots) {
        const rows = byScene.get(shot.scene_id) || [];
        rows.push(shot);
        byScene.set(shot.scene_id, rows);
    }
    for (const [environmentId, shots] of byScene) {
        const sceneId = environmentOfScene.get(environmentId) || environmentId;
        const shotIds = new Set(shots.map(shot => shot.id));
        ops.push({
            type: "replace_director_scene_storyboard",
            sceneId,
            // start_frame / end_frame 一律不出现：v2 由 duration_frames 派生帧窗。
            shots: shots.map(shot => ({
                id: shot.id,
                scene_id: shot.scene_id,
                timeline_id: shot.timeline_id,
                story_order: shot.story_order,
                title: shot.title,
                visual: shot.visual,
                camera: shot.camera,
                duration_frames: shot.duration_frames,
            })),
            segments: plan.segments
                .filter(segment => segment.shot_ids.some(id => shotIds.has(id)))
                .map(segment => ({ id: segment.id, shot_ids: segment.shot_ids, mode: segment.mode })),
            // 后端要求 shotInputs 精确覆盖本场每个镜头（键集合 === 镜头 ID 集合），空对象会被拒。
            shotInputs: Object.fromEntries(shots.map(shot => [shot.id, { keyframePolicy: "none", assetIds: [] }])),
        });
    }
    return ops;
}
