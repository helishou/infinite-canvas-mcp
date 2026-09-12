import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3CharacterGroup, H3CharacterOutfit, H3CharacterVoice, H3Ref, H3Segment } from "../types";
import { sameRef } from "./h3-compatibility";
import { segmentsFor } from "../hooks/useH3Segments";

export function refsForSegment(segment: H3Segment) {
    const buckets = segment.refs;
    const bucketItems = [ ...(buckets?.image || []), ...(buckets?.video || []), ...(buckets?.audio || []) ];
    // Older MCP-written nodes may keep the canonical refs in buckets while
    // persisting an empty refItems array. Treat that empty array as absent;
    // once refItems contains entries it is the canonical ordered list.
    const items = segment.refItems?.length ? segment.refItems : bucketItems;
    const refs = items.filter((item) => (item?.url || item?.storageKey) && String(item.role || "") !== "character_identity").map((item) => ({ ...item, type: item.type || (item as H3Ref & { kind?: H3Ref["type"] }).kind || "image" as const }));
    return refs.filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function segmentRefsPatch(refs: H3Ref[]): Pick<H3Segment, "refItems" | "refs"> {
    return {
        refItems: refs,
        refs: {
            image: refs.filter((item) => item.type === "image"),
            video: refs.filter((item) => item.type === "video"),
            audio: refs.filter((item) => item.type === "audio"),
        },
    };
}

export function withSegmentRefs(segment: H3Segment, refs: H3Ref[]): H3Segment {
    return { ...segment, ...segmentRefsPatch(refs) };
}

// ---- 角色组：拖入角色资产/角色节点时建组，ref 槽里 image/audio ref 都标 groupId ----

function genGroupId(): string {
    return `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function genOutfitId(): string {
    return `of-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function findCharacterGroup(segment: H3Segment, groupId: string): H3CharacterGroup | undefined {
    return segment.h3CharacterGroups?.[groupId];
}

/** 按 characterAssetId 或 characterNodeId 找已有同源角色组；用于重复拖入时复用选择。 */
export function findCharacterGroupBySource(segment: H3Segment, source: { characterAssetId?: string; characterNodeId?: string }): H3CharacterGroup | undefined {
    const groups = segment.h3CharacterGroups;
    if (!groups) return undefined;
    return Object.values(groups).find((group) => (
        (source.characterAssetId && group.characterAssetId === source.characterAssetId)
        || (source.characterNodeId && group.characterNodeId === source.characterNodeId)
    ));
}

/** 从一个角色组派生当前应在 ref 槽里的 refs：每张 enabled outfit 拆为 image ref，voiceEnabled 时 voice 拆为 audio ref。 */
export function refsFromCharacterGroup(group: H3CharacterGroup): H3Ref[] {
    const refs: H3Ref[] = [];
    for (const outfit of group.outfits) {
        if (!outfit.enabled) continue;
        refs.push({
            url: outfit.url,
            type: "image",
            name: `${group.characterName} · ${outfit.name}`,
            storageKey: outfit.storageKey,
            mimeType: outfit.mimeType,
            groupId: group.id,
            outfitId: outfit.id,
        });
    }
    if (group.voiceEnabled && group.voice?.url) {
        refs.push({
            url: group.voice.url,
            type: "audio",
            name: group.voice.name || `${group.characterName} · 声线`,
            storageKey: group.voice.storageKey,
            role: "character_voice",
            groupId: group.id,
        });
    }
    return refs;
}

/** 把 segment 上的 refs 重写：原 refs 拆成 "group 派生 refs" + "非 group refs（独立 image/video/audio ref）"，再合并。 */
function rewriteRefsWithGroups(segment: H3Segment, groups: Record<string, H3CharacterGroup>): H3Ref[] {
    const previous = refsForSegment(segment);
    const fromGroups: H3Ref[] = [];
    const standalone: H3Ref[] = [];
    for (const ref of previous) {
        if (ref.groupId && groups[ref.groupId]) {
            fromGroups.push(ref);
        } else if (ref.groupId) {
            // group 已被删，对应的 ref 一并丢弃
        } else {
            standalone.push(ref);
        }
    }
    const derived: H3Ref[] = [];
    for (const group of Object.values(groups)) {
        for (const ref of refsFromCharacterGroup(group)) {
            if (!fromGroups.some((item) => sameRef(item, ref) && item.groupId === ref.groupId)) derived.push(ref);
        }
    }
    return [...standalone, ...derived].filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function setSegmentCharacterGroups(segment: H3Segment, groups: Record<string, H3CharacterGroup>): H3Segment {
    const next = { ...segment, h3CharacterGroups: groups };
    return withSegmentRefs(next, rewriteRefsWithGroups(next, groups));
}

/** 登记一个新角色组，或按 source 复用现有组并补齐最新 outfit/voice 列表（保留当前 enabled / voiceEnabled 选择）。 */
export function upsertCharacterGroup(segment: H3Segment, input: {
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    outfits: Array<{ url: string; name: string; storageKey?: string; mimeType?: string }>;
    voice?: H3CharacterVoice;
    defaultVoiceEnabled?: boolean;
}): H3Segment {
    const existing = findCharacterGroupBySource(segment, input);
    const groups = { ...(segment.h3CharacterGroups || {}) };
    if (existing) {
        // 同源角色：保留当前 enabled 选择，仅补齐新增的 outfit / 更新 voice 字段
        const existingByUrl = new Map(existing.outfits.map((outfit) => [outfit.url, outfit]));
        const nextOutfits: H3CharacterOutfit[] = input.outfits.map((item) => {
            const prev = existingByUrl.get(item.url);
            return {
                id: prev?.id || genOutfitId(),
                url: item.url,
                name: item.name,
                storageKey: item.storageKey,
                mimeType: item.mimeType,
                enabled: prev ? prev.enabled : true,
            };
        });
        groups[existing.id] = {
            ...existing,
            characterName: input.characterName || existing.characterName,
            voice: input.voice || existing.voice,
            outfits: nextOutfits,
        };
        return setSegmentCharacterGroups(segment, groups);
    }
    const id = genGroupId();
    groups[id] = {
        id,
        characterName: input.characterName,
        characterAssetId: input.characterAssetId,
        characterNodeId: input.characterNodeId,
        voice: input.voice,
        outfits: input.outfits.map((item) => ({
            id: genOutfitId(),
            url: item.url,
            name: item.name,
            storageKey: item.storageKey,
            mimeType: item.mimeType,
            enabled: true,
        })),
        voiceEnabled: input.voice ? (input.defaultVoiceEnabled ?? true) : false,
    };
    return setSegmentCharacterGroups(segment, groups);
}

export function removeCharacterGroup(segment: H3Segment, groupId: string): H3Segment {
    const groups = { ...(segment.h3CharacterGroups || {}) };
    if (!groups[groupId]) return segment;
    delete groups[groupId];
    return setSegmentCharacterGroups(segment, groups);
}

/** 在 modal 里编辑后整体写回：outfit.enabled 与 voiceEnabled 变更。 */
export function applyCharacterGroupEdits(segment: H3Segment, groupId: string, patch: { outfitEnabled?: Record<string, boolean>; voiceEnabled?: boolean }): H3Segment {
    const group = segment.h3CharacterGroups?.[groupId];
    if (!group) return segment;
    const nextGroup: H3CharacterGroup = {
        ...group,
        outfits: patch.outfitEnabled ? group.outfits.map((outfit) => ({
            ...outfit,
            enabled: patch.outfitEnabled![outfit.id] ?? outfit.enabled,
        })) : group.outfits,
        voiceEnabled: patch.voiceEnabled ?? group.voiceEnabled,
    };
    // 全部 outfit 都关了 → 直接删组
    if (!nextGroup.outfits.some((outfit) => outfit.enabled)) {
        return removeCharacterGroup(segment, groupId);
    }
    return setSegmentCharacterGroups(segment, { ...(segment.h3CharacterGroups || {}), [groupId]: nextGroup });
}

/** 通过 ref 在 ref 槽里的 groupId/outfitId 找到所属角色组。 */
export function findGroupForRef(segment: H3Segment, ref: H3Ref): H3CharacterGroup | undefined {
    if (!ref.groupId) return undefined;
    return segment.h3CharacterGroups?.[ref.groupId];
}

// ---- 截取尾帧 → 下一段提示词 retention_analysis 标注 ----

// H3 全参考提示词的标准 section 顺序；仅这些词会被当作「下一个 section 头」识别，
// 避免把正文里的 "http:"、"note:" 等误判为 section 边界。
const KNOWN_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"] as const;

// 把一行追加到指定 section 末尾（在下一个 section 头之前）。若该 section 不存在则新建。
function appendToSection(prompt: string, section: string, line: string): string {
    const headerRe = new RegExp(`^${section}\\s*[:：]`, "m");
    const headerMatch = prompt.match(headerRe);
    if (!headerMatch) {
        const base = prompt.replace(/\s+$/, "");
        return base ? `${base}\n\n${section}:\n${line}\n` : `${section}:\n${line}\n`;
    }
    const headerIndex = headerMatch.index ?? 0;
    const afterHeader = prompt.slice(headerIndex + headerMatch[0].length);
    const others = KNOWN_SECTIONS.filter((item) => item !== section);
    const nextRe = new RegExp(`\\n(${others.join("|")})\\s*[:：]`);
    const nextMatch = afterHeader.match(nextRe);
    const insertAt = nextMatch ? headerIndex + headerMatch[0].length + (nextMatch.index ?? 0) : prompt.length;
    const before = prompt.slice(0, insertAt).replace(/\s+$/, "");
    const after = prompt.slice(insertAt).replace(/^\s+/, "");
    return `${before}\n${line}\n${after}`;
}

// 计算下一段 prompt 里下一个 <Picture N> 的编号：取 prompt 已有最大编号 +1，
// 并至少为「已有图片参考数 +1」，避免与参考区已有图槽位冲突。
export function nextPictureNumber(prompt?: string, imageRefCount = 0): number {
    const text = prompt || "";
    let max = 0;
    for (const match of text.matchAll(/<Picture\s+(\d+)>/gi)) {
        const n = parseInt(match[1], 10);
        if (!Number.isNaN(n) && n > max) max = n;
    }
    // 取 max+1 与 imageRefCount 的较大值：
    // - prompt 有 Picture 1..max → 下一个是 max+1
    // - imageRefCount 是已有图片数（含尾帧），尾帧序号不能小于已有图片数
    // 原逻辑 Math.max(max + 1, imageRefCount + 1) 会跳号（如 max=1, imageRefCount=2 → 3）
    return Math.max(max + 1, imageRefCount);
}

// <Picture N> 的定义行（放在 subject_definitions；H3 规范要求标签先在此定义再被引用）。
export function appendSubjectDefinition(prompt: string, pictureNumber: number, fromClipLabel: string): string {
    const line = `<Picture ${pictureNumber}> is the opening frame of this segment, hard-cut from the ending frame of ${fromClipLabel} to anchor character and scene continuity.`;
    return appendToSection(prompt, "subject_definitions", line);
}

// 尾帧接续：把上一段尾帧作为本段「切镜」首帧参考，但保持人物与动作连续性。
// 注意用 partially_preserved（而非 fully_preserved）——这是一次 scene cut，
// 不是无缝 match-cut 续接；帧被复用为开场帧，但人物身份/姿态/进行中的动作要跨切保持。
// 同时把 prompt 里已有的 <Picture N> 编号全部 +1，为尾帧（Picture 1）腾出首位。
export function buildTailFrameContinuation(prompt: string, pictureNumber: number, fromClipLabel: string): string {
    let p = prompt;
    // 先顺延：把所有 <Picture N> 替换为 <Picture N+1>，从大到小编号避免重复覆盖（如先改1→2，再改2→3会覆盖新生成的2）
    let maxN = 0;
    for (const m of p.matchAll(/<Picture\s+(\d+)>/gi)) { maxN = Math.max(maxN, parseInt(m[1], 10)); }
    for (let n = maxN; n >= 1; n--) {
        p = p.replace(new RegExp(`<Picture\\s+${n}>`, "gi"), `<Picture ${n + 1}>`);
    }
    if (/^subject_definitions\s*[:：]/m.test(p)) {
        p = appendSubjectDefinition(p, pictureNumber, fromClipLabel);
    }
    const line = `<Picture ${pictureNumber}> ([Shot 1] first frame): partially_preserved - the ending frame of ${fromClipLabel} is hard-cut into this segment as the opening frame; preserve the character's identity, pose, and ongoing action across the cut, but treat it as a new shot/scene (not a seamless match-cut continuation).`;
    return appendToSection(p, "retention_analysis", line);
}

// 截取视频尾帧为 PNG data URL（略回退 1/30s 防踩在 duration 边界取到黑屏/空帧）。
// 返回 null 表示截取失败。仅在浏览器环境调用。
export function captureVideoTailFrameDataUrl(src: string): Promise<string | null> {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.src = src;
        video.muted = true;
        video.preload = "auto";
        let settled = false;
        const cleanup = () => { try { video.removeAttribute("src"); video.load(); } catch { /* ignore */ } };
        const fail = (reason: string) => { if (!settled) { settled = true; cleanup(); resolve(null); console.warn("[minimax-h3] tail-frame capture failed:", reason); } };
        video.addEventListener("error", () => fail("video load error"));
        video.addEventListener("loadedmetadata", () => {
            const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
            video.currentTime = Math.max(0, duration - 1 / 30);
        });
        video.addEventListener("seeked", () => {
            if (settled) return;
            try {
                const vw = video.videoWidth || 1280;
                const vh = video.videoHeight || 720;
                const maxLong = 768;
                const scale = Math.min(1, maxLong / Math.max(vw, vh));
                const cw = Math.max(1, Math.round(vw * scale));
                const ch = Math.max(1, Math.round(vh * scale));
                const canvas = document.createElement("canvas");
                canvas.width = cw;
                canvas.height = ch;
                const cx = canvas.getContext("2d");
                if (!cx) return fail("no 2d context");
                cx.drawImage(video, 0, 0, cw, ch);
                settled = true;
                cleanup();
                resolve(canvas.toDataURL("image/png"));
            } catch (error) {
                fail(error instanceof Error ? error.message : String(error));
            }
        });
        video.load();
    });
}

export function resultUrl(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const item = value as Record<string, unknown>;
    return String(item.url || item.video_url || item.content || item.localUrl || "");
}

export function appendVideoMaterials(existing: unknown, additions: Array<{ url: string; storageKey?: string; type: string; name: string; segmentId?: string; params?: Record<string, unknown> }>) {
    const current = Array.isArray(existing) ? existing.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
    // 保留现有 item 上的 segmentId，避免 dedupe-by-URL 把归属信息丢掉。
    // 如果 existing 里的某条已被新 additions 覆盖，使用新 additions 的 segmentId。
    const additionKeys = new Set(additions.map((item) => String(item.url || "")));
    const merged = [
        ...current.filter((item) => !additionKeys.has(String(item.url || ""))),
        ...additions,
    ];
    return merged.filter((item, index, all) => Boolean(item.url) && all.findIndex((candidate) => String(candidate.url || "") === String(item.url || "")) === index);
}

export function updateSegment(ctx: CanvasNodeContext, metadata: Record<string, unknown>, index: number, patch: Partial<H3Segment>) {
    ctx.updateMetadata({ segments: segmentsFor(metadata).map((segment, itemIndex) => itemIndex === index ? { ...segment, ...patch } : segment) });
}
