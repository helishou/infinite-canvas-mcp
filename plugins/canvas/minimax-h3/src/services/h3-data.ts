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
