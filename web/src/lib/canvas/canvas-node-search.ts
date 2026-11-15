import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 画布内「找画面」的纯检索层。
 *
 * 制作画布走制作目录（角色 / 场次 / 镜头 / Clip），自由画布没有制作稿，
 * 只能搜节点本身。这里只负责「把节点变成可搜的文本 + 打分」，不碰视口与选中，
 * 定位统一交给已有的 `?nodeId=` 深链（project.tsx 会 focusNode）。
 */

export type CanvasNodeSearchHit = {
    id: string;
    title: string;
    type: string;
    sortKey: string;
    snippet: string;
    score: number;
};

/** 可能承载自然语言的 metadata 字段；只取字符串，避免把整棵 metadata 序列化。 */
const TEXT_FIELDS = ["prompt", "composerContent", "description", "content", "text", "summary", "note", "name", "caption", "subtitle"] as const;
const SEGMENT_FIELDS = ["prompt", "summary", "title", "visual", "shotName"] as const;
const ORDINARY_LABEL: Record<string, string> = {
    [CanvasNodeType.Image]: "图片",
    [CanvasNodeType.Text]: "文本",
    [CanvasNodeType.Config]: "生成配置",
    [CanvasNodeType.Video]: "视频",
    [CanvasNodeType.Audio]: "音频",
    [CanvasNodeType.Loop]: "循环",
    [CanvasNodeType.Group]: "分组",
    [CanvasNodeType.Character]: "角色",
    [CanvasNodeType.Scene]: "场景",
    [CanvasNodeType.Prop]: "道具",
};

export function canvasNodeTypeLabel(type: string): string {
    return ORDINARY_LABEL[type] || String(type || "节点").split(":").pop() || "节点";
}

/** 正文（不含标题）：摘要只取这一段，避免每行都重复同一个标题。 */
export function canvasNodeSearchBody(node: CanvasNodeData): string {
    const parts: string[] = [];
    const metadata = node.metadata as Record<string, unknown> | undefined;
    if (metadata) {
        for (const key of TEXT_FIELDS) {
            const value = metadata[key];
            if (typeof value === "string" && value.trim()) parts.push(value);
        }
        const segments = metadata.segments;
        if (Array.isArray(segments)) {
            for (const segment of segments.slice(0, 60)) {
                if (!segment || typeof segment !== "object") continue;
                const record = segment as Record<string, unknown>;
                for (const key of SEGMENT_FIELDS) {
                    const value = record[key];
                    if (typeof value === "string" && value.trim()) parts.push(value);
                }
            }
        }
    }
    return parts.join("\n");
}

/** 参与检索的文本：标题 + 常见文本字段 + H3 段落里的提示词/摘要。 */
export function canvasNodeSearchText(node: CanvasNodeData): string {
    const title = String(node.title || "");
    const body = canvasNodeSearchBody(node);
    return body ? `${title}\n${body}` : title;
}

function normalize(value: string): string {
    return value.toLowerCase();
}

function snippetAround(text: string, terms: string[]): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (!flat) return "";
    const lower = normalize(flat);
    let index = -1;
    for (const term of terms) {
        const found = lower.indexOf(term);
        if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    if (index < 0) return flat.slice(0, 72);
    const start = Math.max(0, index - 24);
    return `${start > 0 ? "…" : ""}${flat.slice(start, start + 72).trim()}${start + 72 < flat.length ? "…" : ""}`;
}

/**
 * 按词检索节点：标题命中权重高于正文；多词为 AND（每个词都要出现）。
 * 空查询返回全部节点（按更新时间无关的稳定顺序），供「还没输入时先浏览」。
 */
export function searchCanvasNodes(nodes: readonly CanvasNodeData[], query: string, limit = 40): CanvasNodeSearchHit[] {
    const terms = normalize(query).split(/\s+/).map(item => item.trim()).filter(Boolean);
    const hits: CanvasNodeSearchHit[] = [];
    for (const node of nodes) {
        const title = String(node.title || "");
        const body = canvasNodeSearchBody(node);
        const haystack = normalize(body ? `${title}\n${body}` : title);
        if (terms.length && !terms.every(term => haystack.includes(term))) continue;
        const titleLower = normalize(title);
        let score = 0;
        for (const term of terms) {
            if (titleLower.includes(term)) score += titleLower.startsWith(term) ? 6 : 4;
            else if (haystack.includes(term)) score += 1;
        }
        hits.push({
            id: node.id,
            title: title || "(未命名)",
            type: canvasNodeTypeLabel(String(node.type)),
            sortKey: String(node.type || ""),
            snippet: terms.length ? snippetAround(body, terms) : body.replace(/\s+/g, " ").trim().slice(0, 72),
            score,
        });
    }
    hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, "zh-Hans-CN"));
    return hits.slice(0, Math.max(1, limit));
}

/** 点结果要跳的地址：复用画布已有的 `?nodeId=` 深链定位，不新增视口接口。 */
export function canvasNodeFocusHref(projectId: string, nodeId: string): string {
    return `/canvas/${encodeURIComponent(projectId)}?nodeId=${encodeURIComponent(nodeId)}`;
}
