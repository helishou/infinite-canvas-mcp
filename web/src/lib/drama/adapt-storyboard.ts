/**
 * 分镜草案的编辑模型（纯函数）。
 *
 * 草案只活在浏览器里，点「写稿」才落库。这里负责三件事：
 * 1. 把解析出来的节拍变成可编辑行（改时长、调顺序、拆合、删）；
 * 2. 把行翻译成 `planChapterStoryboard` 的入参，拿到 Shot / Clip 计划；
 * 3. 把计划翻成正式 op 列表（分镜 + 台词），交给制作稿接口。
 *
 * 一个后端硬约束决定了第 3 步的写法：同一场次重复写分镜时，
 * `replace_director_scene_storyboard` 要求 **Clip ID 集合与原来完全一致**，
 * 改了镜头数就会撞 `SCENE_STORYBOARD_SEGMENTS`。所以这里支持把原 Clip ID 传进来复用。
 */

import { planChapterStoryboard, toSceneStoryboardOps, type ChapterBeat, type StoryboardPlan } from "@basketikun/canvas-agent/drama/chapter-storyboard";
import { composeDemandText, type ParsedDemand } from "@basketikun/canvas-agent/drama/demand-beats";

export type DraftShot = {
    /** 行 ID，仅用于 React key 与增删定位，不进正式稿。 */
    key: string;
    title: string;
    visual: string;
    camera: string;
    seconds: number;
    dialogue: string;
    speaker: string;
};

let rowSeed = 0;
function nextKey() {
    rowSeed += 1;
    return `row-${rowSeed}`;
}

export function draftFromParsed(parsed: ParsedDemand): DraftShot[] {
    return parsed.beats.map(beat => ({
        key: nextKey(),
        title: beat.title,
        visual: beat.visual,
        camera: beat.camera || "",
        seconds: beat.seconds,
        dialogue: beat.dialogue || "",
        speaker: beat.speaker || "",
    }));
}

export function emptyShot(index: number): DraftShot {
    return { key: nextKey(), title: `镜头 ${index + 1}`, visual: "", camera: "", seconds: 2, dialogue: "", speaker: "" };
}

export function patchShot(rows: readonly DraftShot[], key: string, patch: Partial<DraftShot>) {
    return rows.map(row => row.key === key ? { ...row, ...patch } : row);
}

export function removeShot(rows: readonly DraftShot[], key: string) {
    return rows.filter(row => row.key !== key);
}

/** 上下移动；到边界时原样返回。 */
export function moveShot(rows: readonly DraftShot[], key: string, delta: -1 | 1) {
    const index = rows.findIndex(row => row.key === key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= rows.length) return [...rows];
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

/**
 * 拆一镜为两镜：优先在句子边界切（句号/问号/叹号），没有边界就按字数对半切。
 * 时长按字数比例分，保证两段加起来还是原来那么长。
 */
export function splitShot(rows: readonly DraftShot[], key: string) {
    const index = rows.findIndex(row => row.key === key);
    if (index < 0) return [...rows];
    const row = rows[index];
    const text = row.visual.trim();
    if (text.length < 8) return [...rows];
    const sentences = text.split(/(?<=[。！？!?；;])/).filter(Boolean);
    let head = "", tail = "";
    if (sentences.length >= 2) {
        const half = Math.ceil(sentences.length / 2);
        head = sentences.slice(0, half).join("");
        tail = sentences.slice(half).join("");
    } else {
        const cut = Math.max(1, Math.floor(text.length / 2));
        head = text.slice(0, cut);
        tail = text.slice(cut);
    }
    head = head.trim();
    tail = tail.trim();
    if (!head || !tail) return [...rows];
    const ratio = head.length / (head.length + tail.length);
    const headSeconds = Math.max(0.5, Math.round(row.seconds * ratio * 2) / 2);
    const tailSeconds = Math.max(0.5, Math.round((row.seconds - headSeconds) * 2) / 2);
    const next = [...rows];
    next.splice(index, 1,
        { ...row, visual: head, seconds: headSeconds },
        { ...row, key: nextKey(), title: `${row.title} · 续`, visual: tail, seconds: tailSeconds, dialogue: "", speaker: "" },
    );
    return next;
}

/** 与下一镜合并：画面拼接、时长相加，第二镜的台词丢弃（只保留第一镜的）。 */
export function mergeWithNext(rows: readonly DraftShot[], key: string) {
    const index = rows.findIndex(row => row.key === key);
    if (index < 0 || index >= rows.length - 1) return [...rows];
    const current = rows[index], next = rows[index + 1];
    const next2 = [...rows];
    next2.splice(index, 2, {
        ...current,
        visual: [current.visual.trim(), next.visual.trim()].filter(Boolean).join(" "),
        seconds: Math.round((current.seconds + next.seconds) * 2) / 2,
    });
    return next2;
}

/** 行 → 节拍。空画面的行被跳过（与 planChapterStoryboard 的过滤保持一致）。 */
export function toBeats(rows: readonly DraftShot[]): ChapterBeat[] {
    return rows
        .filter(row => row.visual.trim())
        .map((row, index) => ({
            title: row.title.trim() || `镜头 ${index + 1}`,
            visual: row.visual.trim(),
            ...(row.camera.trim() ? { camera: row.camera.trim() } : {}),
            seconds: Math.max(0.5, Number(row.seconds) || 2),
            ...(row.dialogue.trim() && row.speaker.trim() ? { dialogue: row.dialogue.trim(), speaker: row.speaker.trim() } : {}),
        }));
}

export function buildPlan(input: {
    chapterId: string;
    environmentId: string;
    rows: readonly DraftShot[];
    fps?: number;
    clipSeconds?: number;
}): StoryboardPlan {
    const beats = toBeats(input.rows);
    return planChapterStoryboard({
        chapterId: input.chapterId,
        fps: input.fps,
        clipSeconds: input.clipSeconds,
        scenes: [{ sceneKey: input.environmentId, environmentId: input.environmentId, beats }],
    });
}

export type StoryboardOp = {
    type: "replace_director_scene_storyboard" | "set_director_shot_utterances";
    [key: string]: unknown;
};

/** 台词帧窗：按 4.5 字/秒估算，水平居中放在镜头内，至少 0.5 秒。 */
function utteranceWindow(shotFrames: number, text: string, fps: number) {
    const needFrames = Math.max(Math.round(0.5 * fps), Math.round((text.replace(/\s/g, "").length / 4.5) * fps));
    const frames = Math.min(shotFrames, needFrames);
    const start = Math.max(0, Math.floor((shotFrames - frames) / 2));
    const end = Math.min(shotFrames, start + frames);
    return end > start ? { localStartFrame: start, localEndFrame: end } : null;
}

/**
 * 计划 → 正式 op。
 *
 * - `sceneId`：制作稿里的场次 ID（由 `productionSceneEntries` 推出，可能等于 environmentId）；
 * - `reuseClipIds`：该场次已有 Clip 时传原 ID 列表，按顺序替换，避免撞「Clip ID 集合不一致」；
 * - `fps` 只用于算台词帧窗，必须与制作稿一致。
 */
export function toWriteOps(input: {
    plan: StoryboardPlan;
    sceneId: string;
    environmentId: string;
    fps?: number;
    reuseClipIds?: readonly string[];
}): StoryboardOp[] {
    const fps = Math.max(1, Math.floor(input.fps ?? 24));
    const plan = input.reuseClipIds?.length ? withReusedClipIds(input.plan, input.reuseClipIds) : input.plan;
    const ops: StoryboardOp[] = toSceneStoryboardOps(plan, new Map([[input.environmentId, input.sceneId]]))
        .map(op => ({ ...op, type: "replace_director_scene_storyboard" as const }));
    for (const shot of plan.shots) {
        if (!shot.dialogue) continue;
        const window = utteranceWindow(shot.duration_frames, shot.dialogue.text, fps);
        if (!window) continue;
        ops.push({
            type: "set_director_shot_utterances",
            shotId: shot.id,
            utterances: [{
                speakerName: shot.dialogue.speaker,
                text: shot.dialogue.text,
                voiceover: false,
                localStartFrame: window.localStartFrame,
                localEndFrame: window.localEndFrame,
            }],
        });
    }
    return ops;
}

/**
 * 把新计划的 Clip ID 换成原 ID。数量不一致时抛错 —— 后端不允许这里改分组，
 * 真要重排分组得走 `repartition_director_clips`，那是制作台的活。
 */
export function withReusedClipIds(plan: StoryboardPlan, existingIds: readonly string[]): StoryboardPlan {
    if (plan.segments.length !== existingIds.length) {
        throw new Error(`SCENE_STORYBOARD_CLIPS: 该场次已有 ${existingIds.length} 段，本次草案是 ${plan.segments.length} 段。改写镜头数会改变分段，请先在制作台把该场次分镜清空，或调整草案让段数一致。`);
    }
    const map = new Map<string, string>();
    plan.segments.forEach((segment, index) => map.set(segment.id, existingIds[index]));
    return {
        ...plan,
        segments: plan.segments.map(segment => ({ ...segment, id: map.get(segment.id) || segment.id })),
    };
}

/** 草案 → 需求正文（写进分集 synopsis，后端据此切剧本块）。 */
export function draftToDemand(rows: readonly DraftShot[], meta: { sceneName?: string; timeOfDay?: string }) {
    return composeDemandText({
        sceneName: meta.sceneName,
        timeOfDay: meta.timeOfDay,
        beats: toBeats(rows),
    });
}

/** 一段镜头里有台词却没写说话人 —— 草案面板要标红提示，否则写稿时会被静默丢弃。 */
export function shotIssues(rows: readonly DraftShot[]) {
    const issues: string[] = [];
    rows.forEach((row, index) => {
        if (!row.visual.trim()) issues.push(`第 ${index + 1} 镜没有画面描述`);
        if (row.dialogue.trim() && !row.speaker.trim()) issues.push(`第 ${index + 1} 镜有台词但没写说话人`);
        if (Number(row.seconds) <= 0) issues.push(`第 ${index + 1} 镜时长必须大于 0`);
    });
    return issues;
}

/**
 * 写稿之后的「接入画布」编排：发布 → 编译 → 应用 → 再发布 → 准备节点 → 同步 Clip。
 *
 * 这条链是探针实测出来的（tmp/clip-chain-probe.mjs），缺任何一步画布上都不会出现 H3 节点：
 * - 编译产物应用在 draft，`sync-clips` 校验的是 **published** 视图，所以 apply 之后要再发布一次；
 * - `prepare-targets` 负责在画布上建场次/H3 节点（探针确认它会投影 segments 到节点）；
 * - 全部 segment ready 才允许 sync，提前调会 400。
 *
 * 步骤幂等：segment 全部 ready 时跳过编译发布，直接准备与同步。
 */
export type PromoteStoryboardDeps = {
    /** 所有 segment 目标的就绪状态。 */
    segmentTargets: () => Promise<Array<{ id: string; status: string; blockers?: string[] }>>;
    /** 发布当前 draft（stage=director），返回新 pubVer。 */
    publish: () => Promise<{ publishedVersion: number }>;
    /** 提交编译，返回可轮询的 operationId。 */
    compile: () => Promise<{ operationId: string }>;
    /** 轮询一次编译状态；status 为 succeeded/failed/blocked 时调用方停止轮询。 */
    pollCompilation: (operationId: string) => Promise<{ status: string; preparedId?: string; blockedMessage?: string }>;
    /** 应用编译产物（preparedId 来自编译回执 nextAction.input）。 */
    applyCompilation: (preparedId: string) => Promise<void>;
    /** 在画布上准备 segment 对应的节点。 */
    prepareTargets: (targets: string[]) => Promise<void>;
    /** 把正式 Clip 输入同步进画布节点。 */
    syncClips: () => Promise<void>;
};

const COMPILE_POLL_INTERVAL_MS = 3000;
const COMPILE_POLL_LIMIT = 60;

export async function promoteStoryboardToCanvas(deps: PromoteStoryboardDeps, onStep?: (message: string) => void) {
    const notify = (message: string) => onStep?.(message);
    const targets = await deps.segmentTargets();
    if (!targets.length) throw new Error("制作稿里还没有 Clip：先写分镜再接入画布");
    const readyOf = (rows: Array<{ id: string; status: string; blockers?: string[] }>) =>
        rows.filter(item => item.status === "ready" || item.status === "complete");

    if (readyOf(targets).length !== targets.length) {
        notify("发布制作稿");
        await deps.publish();
        notify("提交编译");
        const { operationId } = await deps.compile();
        let last: Awaited<ReturnType<typeof deps.pollCompilation>> | null = null;
        for (let poll = 0; poll < COMPILE_POLL_LIMIT; poll++) {
            await new Promise(resolve => setTimeout(resolve, COMPILE_POLL_INTERVAL_MS));
            last = await deps.pollCompilation(operationId);
            if (["succeeded", "failed", "blocked"].includes(last.status)) break;
        }
        if (!last || last.status !== "succeeded") {
            throw new Error(last?.blockedMessage || `编译没有成功（${last?.status || "unknown"}）`);
        }
        if (!last.preparedId) throw new Error("编译成功但没有返回 preparedId，无法应用");
        notify("应用编译产物");
        await deps.applyCompilation(last.preparedId);
        notify("重新发布");
        await deps.publish();
    }

    const fresh = await deps.segmentTargets();
    const blocked = fresh.filter(item => item.status !== "ready" && item.status !== "complete");
    if (blocked.length) {
        throw new Error(`仍有 ${blocked.length} 个 Clip 未就绪：${blocked.map(item => item.blockers?.[0] || item.id).join("；")}`);
    }

    notify("准备画布节点");
    await deps.prepareTargets(fresh.map(item => item.id));
    notify("同步 Clip 到画布");
    await deps.syncClips();
    return { segments: fresh.length };
}
