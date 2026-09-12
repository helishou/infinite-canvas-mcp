import type { H3Ref, H3Segment } from "../types";

export type H3PlanDraft = {
  id: string;
  sourceShotId: string;
  title: string;
  duration: number;
  openingState: string;
  timeline: Array<{ start: number; end: number; action: string; camera: string; composition?: string; effects?: string }>;
  endingState: string;
  continuityIn?: string;
  continuityOut?: string;
  soundscape?: string;
  music?: string;
  constraints?: string[];
  subjects?: Array<{ subjectId: string; name?: string; role?: string }>;
  referenceSlots?: number[];
};

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown, field: string, id: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`结构化分镜 ${id} 缺少 ${field}`);
  return text;
}

function parseJson(text: string): unknown {
  const clean = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(clean); } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("智能分镜必须返回合法 JSON");
  }
}

export function parseStructuredStoryboard(text: string, count: number): H3PlanDraft[] {
  const root = objectOf(parseJson(text));
  const raw = Array.isArray(root.segments) ? root.segments : Array.isArray(root.plan) ? root.plan : [];
  if (raw.length !== count) throw new Error(`结构化分镜返回 ${raw.length} 段，但要求 ${count} 段`);
  const ids = new Set<string>();
  return raw.map((value, index) => {
    const item = objectOf(value);
    const id = textOf(item.id || `S${String(index + 1).padStart(2, "0")}`, "id", `第${index + 1}段`);
    if (ids.has(id)) throw new Error(`结构化分镜存在重复 id：${id}`);
    ids.add(id);
    const duration = Number(item.duration);
    if (!Number.isFinite(duration) || duration < 1 || duration > 15) throw new Error(`结构化分镜 ${id} 的 duration 必须为 1 到 15 秒`);
    const timelineRaw = Array.isArray(item.timeline) ? item.timeline : [];
    if (!timelineRaw.length) throw new Error(`结构化分镜 ${id} 缺少 timeline`);
    let cursor = 0;
    const timeline = timelineRaw.map((entry) => {
      const value = objectOf(entry);
      const start = Number(value.start);
      const end = Number(value.end);
      if (start !== cursor || !Number.isFinite(end) || end <= start || end > duration) throw new Error(`结构化分镜 ${id} 的 timeline 不连续`);
      cursor = end;
      return {
        start, end,
        action: textOf(value.action, "动作", id),
        camera: textOf(value.camera, "运镜", id),
        ...(value.composition ? { composition: String(value.composition) } : {}),
        ...(value.effects ? { effects: String(value.effects) } : {}),
      };
    });
    if (cursor !== duration) throw new Error(`结构化分镜 ${id} 的 timeline 末端必须等于 duration`);
    const slots = Array.isArray(item.referenceSlots) ? item.referenceSlots.map(Number) : [];
    if (slots.some((slot) => !Number.isInteger(slot) || slot < 1) || new Set(slots).size !== slots.length) throw new Error(`结构化分镜 ${id} 的 referenceSlots 无效`);
    const subjects = (Array.isArray(item.subjects) ? item.subjects : []).map((subject) => {
      const value = objectOf(subject);
      return { subjectId: textOf(value.subjectId, "subjectId", id), ...(value.name ? { name: String(value.name) } : {}), ...(value.role ? { role: String(value.role) } : {}) };
    });
    return {
      id,
      sourceShotId: textOf(item.sourceShotId || id.split("-")[0], "sourceShotId", id),
      title: textOf(item.title, "title", id),
      duration,
      openingState: textOf(item.openingState, "openingState", id),
      timeline,
      endingState: textOf(item.endingState, "endingState", id),
      ...(item.continuityIn ? { continuityIn: String(item.continuityIn) } : {}),
      ...(item.continuityOut ? { continuityOut: String(item.continuityOut) } : {}),
      ...(item.soundscape ? { soundscape: String(item.soundscape) } : {}),
      ...(item.music ? { music: String(item.music) } : {}),
      ...(Array.isArray(item.constraints) ? { constraints: item.constraints.map(String) } : {}),
      subjects,
      referenceSlots: slots,
    };
  });
}

function promptFor(draft: H3PlanDraft, refs: H3Ref[]) {
  const counters = { image: 0, video: 0, audio: 0 };
  const referenceList = refs.map((ref) => {
    const label = ref.type === "image" ? "图片" : ref.type === "video" ? "视频" : "音频";
    const ordinal = ++counters[ref.type];
    return `@${label}${ordinal}：${ref.name || `${label}${ordinal}`}`;
  }).join("；") || "无";
  const timeline = draft.timeline.map((item) => `${item.start.toFixed(1)}-${item.end.toFixed(1)}秒，动作：${item.action}；运镜：${item.camera}${item.composition ? `；构图：${item.composition}` : ""}${item.effects ? `；效果：${item.effects}` : ""}`).join("\n");
  return [
    `主体定义：${draft.subjects?.map((subject) => subject.name || subject.subjectId).join("、") || "按照参考图保持主体一致"}`,
    `镜头目标：${draft.title}`,
    `起始画面：${draft.openingState}`,
    `时间轴动作与运镜：\n${timeline}`,
    `结束画面：${draft.endingState}`,
    draft.continuityIn ? `连续性要求（接入）：${draft.continuityIn}` : "",
    draft.continuityOut ? `连续性要求（接出）：${draft.continuityOut}` : "",
    `参考素材：${referenceList}`,
    draft.soundscape ? `声音环境：${draft.soundscape}` : "",
    draft.music ? `配乐：${draft.music}` : "",
    draft.constraints?.length ? `限制条件：${draft.constraints.join("；")}` : "",
    "保持人物外观、服饰、比例、空间方向、动作轴和光线连续，不添加未指定的主体、文字或镜头外信息。",
  ].filter(Boolean).join("\n");
}

export function materializePlanSegment(draft: H3PlanDraft, refs: H3Ref[], taskMode: H3Segment["taskMode"], continuityEnabled: boolean) {
  const selected = (draft.referenceSlots || []).map((slot) => refs.find((ref) => Number(ref.slot) === slot)).filter((ref): ref is H3Ref => Boolean(ref));
  const unique = selected.filter((ref, index, all) => all.findIndex((other) => (ref.storageKey && other.storageKey ? ref.storageKey === other.storageKey : ref.url === other.url)) === index);
  const ordered = unique.map((ref, index) => ({ ...ref, slot: index + 1, order: index }));
  return {
    id: draft.id,
    sourceShotId: draft.sourceShotId,
    title: draft.title,
    duration: draft.duration,
    taskMode,
    openingState: draft.openingState,
    timeline: draft.timeline,
    endingState: draft.endingState,
    continuityIn: continuityEnabled ? draft.continuityIn : undefined,
    continuityOut: continuityEnabled ? draft.continuityOut : undefined,
    subjects: draft.subjects || [],
    soundscape: draft.soundscape,
    music: draft.music,
    constraints: draft.constraints || [],
    prompt: promptFor(draft, ordered),
    refItems: ordered,
    refs: { image: ordered.filter((ref) => ref.type === "image"), video: ordered.filter((ref) => ref.type === "video"), audio: ordered.filter((ref) => ref.type === "audio") },
    status: "idle",
    result: "",
    results: [],
    progress: 0,
    runtimeTaskId: "",
  } satisfies Partial<H3Segment> & Record<string, unknown>;
}
