import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { sameRef } from "./h3-compatibility";
import { segmentsFor } from "../hooks/useH3Segments";

export function refsForSegment(segment: H3Segment) {
    const buckets = segment.refs;
    const items = segment.refItems || [ ...(buckets?.image || []), ...(buckets?.video || []), ...(buckets?.audio || []) ];
    const refs = items.filter((item) => item?.url || item?.storageKey).map((item) => ({ ...item, type: item.type || (item as H3Ref & { kind?: H3Ref["type"] }).kind || "image" as const }));
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
    return Math.max(max + 1, imageRefCount + 1);
}

// <Picture N> 的定义行（放在 subject_definitions；H3 规范要求标签先在此定义再被引用）。
export function appendSubjectDefinition(prompt: string, pictureNumber: number, fromClipLabel: string): string {
    const line = `<Picture ${pictureNumber}> is the opening frame of this segment, reused from the ending frame of ${fromClipLabel} to anchor character and scene continuity.`;
    return appendToSection(prompt, "subject_definitions", line);
}

// retention_analysis 里的引用行：用官方格式 `<Picture N> ([Shot 1] first frame): fully_preserved - ...`，
// 说明该帧是上一段尾帧、作为本段首帧参考以保持人物/场景连续。
export function appendRetentionAnalysis(prompt: string, pictureNumber: number, fromClipLabel: string): string {
    const line = `<Picture ${pictureNumber}> ([Shot 1] first frame): fully_preserved - the ending frame of ${fromClipLabel}, reused as the opening frame of this segment to preserve character identity and scene continuity.`;
    return appendToSection(prompt, "retention_analysis", line);
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
