import { useMemo, useRef, useState, useEffect, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { App, Modal, Input, Tooltip, Dropdown, Popconfirm, Popover, Checkbox, type MenuProps } from "antd";
import {
    BookOpen, Sparkles, RefreshCw, Clapperboard, Download, Film, Play, FileUp,
    AlertCircle, LoaderCircle, Loader2, Check, Eye, Scissors, Wand2, Pencil, Quote, Save, ScanSearch,
    ArrowUpToLine, ArrowDownToLine, ArrowUp, ArrowDown, RotateCcw, Wrench,
    Trash2, AlertTriangle, CheckCircle2, MessageCircle, Volume2, VolumeX,
    PanelRightClose, PanelRightOpen, FolderOpen, Upload,
} from "lucide-react";
import type { EpisodeProduction, SegmentVideoReprocessPreview, DramaSourceFormat } from "@/services/backend-api";
import { BackendApiError, backendMediaUrl, editEpisodeProduction, fetchEpisodeProduction, fetchDramaPlanningSource, patchDramaPlanningSource, fetchBackendProject, fetchProductionWorkbench, prepareProductionTargets, startCanvasGeneration, applyBackendCanvasOperations, getSegmentVideoReprocessStatus, reprocessSegmentVideo, getEpisodeChapters, getChapter, patchChapter, upsertProjectReferenceAssets, prerunEpisode, type VideoPrerunReport } from "@/services/backend-api";
import { nanoid } from "nanoid";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import type { StudioClipMedia, StudioSegmentState, StudioSegmentVersion } from "./use-studio-data";
import type { StudioEpisode } from "./use-studio-data";
import { deriveFinalStale, SOURCE_LABEL } from "./use-studio-data";
// 设置的真值读取放在轻模块里：studio-settings-tab 是大组件（按需 chunk），
// 这里只需要 loadStudioSettings，静态从 tab 模块导入会把整个设置页拉回首屏。
import { loadStudioSettings } from "./studio-settings-store";
import { PRERUN_TONE_CLASS, PRERUN_TONE_LABEL, prerunBanner, prerunTone } from "./studio-prerun";
import { projectVoiceReferenceNotes, VOICE_NOTE_LABEL, VOICE_NOTE_STYLE, type VoiceReferenceNoteView } from "./voice-reference-note-view";
import { dialogueShotLinesOf, speakerRegistryOf, utterancesOfShot, type ShotUtteranceLine } from "./studio-utterance";
import { cn } from "@/lib/utils";
import { splitSourceIntoEpisodes, groupSynopsis } from "@/lib/drama/adapt";
import { modelOptionLabel, modelVideoCapabilitiesOf, selectableModelsByCapability, segmentAudioLimitOf, useConfigStore } from "@/stores/use-config-store";

/** H3 的默认出片模型（新/未配置的段回落到这里），与后端 h3-runner 的同名常量一致。 */
const DEFAULT_SEGMENT_VIDEO_MODEL = "engine-local::H3 展开流";

/** 段视频版本列表默认展示上限（对齐影策 take-list.tsx limit=6，更早的版本用计数文案提示）。 */
const SEGMENT_VERSION_LIMIT = 6;

/**
 * 版本行里的模型名去掉渠道前缀，避免右侧窄栏被长 id 撑出横向滚动（对齐影策 take-list.tsx shortModelName）。
 * 纯字符串处理：去 local:: / engine-local:: 等渠道前缀与 wb-/minimax- 等旧前缀，不动真实模型名主体。
 */
function shortModelName(model: string): string {
    return String(model || "")
        .replace(/^(engine-local|local|hermes-local)::/i, "")
        .replace(/^(wb-|wb_|ohmybb-)/i, "")
        .replace(/^minimax-/i, "");
}

/** 版本行里的模型展示名：本地模型值是权重路径，只留文件名并裁掉超长后缀（完整值留在 title）。 */
function prettyModelName(model: string): string {
    const base = shortModelName(model).split(/[\\/]/).pop()!.replace(/\.(safetensors|ckpt|pt|gguf)$/i, "");
    return base.length > 26 ? `${base.slice(0, 24)}…` : base;
}

/** 按章编辑原文的文件导入：与建集弹窗（index.tsx importEpisodeFile）完全同一口径。 */
const CHAPTER_FILE_MAX_BYTES = 2 * 1024 * 1024;
const CHAPTER_TEXT_FILE = /\.(txt|md|markdown|csv|tsv)$/i;
/** 去空白字数（含空格/换行/全角空格 \u3000），与后端和建集弹窗字数口径一致。 */
const sourceCharCount = (text: string) => [...text.replace(/\s/g, "")].length;
/** TXT/MD/CSV/TSV ≤2MB，UTF-8 失败回退 GBK，去 BOM 并统一换行；空文件/超限/类型不符直接报错。 */
async function parseSourceTextFile(file: File): Promise<string> {
    if (!CHAPTER_TEXT_FILE.test(file.name)) throw new Error("支持 TXT、Markdown、CSV、TSV 文本文件");
    if (file.size > CHAPTER_FILE_MAX_BYTES) throw new Error("单章文件不超过 2MB");
    let text = await file.text();
    if (text.includes("\uFFFD")) {
        try { text = new TextDecoder("gbk").decode(await file.arrayBuffer()); } catch { /* 保留 UTF-8 解码结果 */ }
    }
    text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!text.trim()) throw new Error("文件内容为空");
    return text;
}

/** 段卡片预览的镜头数上限（对齐影策 SHOT_PREVIEW）。 */
const SHOT_PREVIEW = 3;

/** 影策 final-view STAGE_LABEL 的本地对齐（StudioStage=draft/script/assets/shots/video，无 render 阶段）。 */
const STAGE_LABEL: Record<string, string> = {
    draft: "改编剧本", script: "改编剧本", assets: "资产建档", shots: "镜头设计",
    video: "生成视频", render: "合成成片", done: "已完成",
};
/**
 * 素材类型真值源，与影策 drama-shared.tsx 的 SOURCE_FORMAT_LABEL 对齐：title/detail/placeholder/guide 文案照搬影策。
 * 本地 episode 目前不带 sourceFormat，读不到时回落「小说原文」，不伪造。
 * guide 即原文弹窗的「怎么写」指引，placeholder 即各类型的类型专属占位，避免各类型共用一句占位。
 */
const SOURCE_FORMAT_LABEL: Record<string, { title: string; detail: string; placeholder: string; guide: string[] }> = {
    novel: {
        title: "小说原文",
        detail: "按原文改编成镜头，引号里的对白逐字保留",
        placeholder: "粘贴小说正文。对白放在引号里，会逐字保留为台词。",
        guide: ["引号“”「」里的对白逐字保留为台词", "叙述与心理描写改成可拍到的动作和表情", "需要旁白时只摘原文句子，不另写"],
    },
    script: {
        title: "剧本",
        detail: "已写好的剧情与台词，只拆镜头，台词一字不改",
        placeholder: "粘贴本集剧本，例如：\n第1场 内景 客厅 夜\n△林晚推门而入。\n林晚（冷笑）：你怎么还在这里？\n顾言：我等你很久了。",
        guide: ["一行一句：角色：台词，或 角色（表情）：台词", "△ 开头的行写动作与画面", "旁白写成 旁白：……；台词一字不改"],
    },
    storyboard: {
        title: "分镜",
        detail: "已做好的分镜表，按原镜头转录",
        placeholder: "粘贴分镜表（Markdown 表格或从表格软件复制的内容），第一行为表头，例如：\n| 场景 | 角色 | 景别 | 画面 | 台词 | 时长 |\n| 客厅 | 林晚 | 近景 | 林晚推门而入 | 林晚：你怎么还在这里？ | 3 |",
        guide: ["第一行是表头：场景、角色、景别、运镜、画面、台词、时长、转场", "Markdown 表格或从 Excel 复制的内容直接导入，不经过模型", "一格多句台词用 <br> 分开，会拆成连续镜头"],
    },
};
/** 原文弹窗提交文案随素材类型切换，照搬影策 AddEpisodeModal 的真实文案：分镜=导入这一集，小说/剧本=添加并开始拆镜。 */
const chapterCommitLabel = (format: string): string => format === "storyboard" ? "导入这一集" : "添加并开始拆镜";
/** 取素材类型对应的真值；未知类型一律回落小说原文，不伪造。 */
const formatTruthOf = (format: string) => SOURCE_FORMAT_LABEL[format] || SOURCE_FORMAT_LABEL.novel;
/** 运镜词表（对齐影策 segment-dialog.tsx CAMERAS）：只做 datalist 建议，不强改 shot.camera 里已有的自由文本。 */
const CAMERAS = ["固定", "推", "拉", "摇", "跟", "环绕", "升降", "手持"];

/** 成片播放器画幅：设置页 videoAspectRatio 真值（16:9/9:16 走 Tailwind，其余比例用 inline aspect-ratio，缺省 16:9）。 */
function finalAspectOf(ratio: unknown): { className: string; style?: CSSProperties } {
    const r = typeof ratio === "string" ? ratio.trim() : "";
    if (r === "9:16") return { className: "aspect-[9/16]" };
    if (r === "16:9" || !r) return { className: "aspect-video" };
    const m = /^([1-9]\d*):([1-9]\d*)$/.exec(r);
    return m ? { className: "", style: { aspectRatio: `${m[1]} / ${m[2]}` } } : { className: "aspect-video" };
}

/**
 * 影策制作台「详情区」原生复刻（对照 tmp/oac/scrape/detail-*.png + y-detailhead.png）。
 * 三个 tab 的内容是影策独有的，不是本地 ProductionEditor：
 * - 剧本：本集梗概卡 + 开场钩子/结尾悬念 + 分镜规则 + 失败提示/重新改编 + 右侧原文对照
 * - 分镜：剧情段→镜头表，点镜头联动右侧原文；段提示词 + @引用资产
 * - 成片：播放器 + 集信息 + 合成成品/下载/导出剪映
 * 所有数据来自本地制作稿真实字段（director.source），无第二份真值。
 */

type Source = Record<string, any>;
type Row = Record<string, any>;

const rows = (v: unknown): Row[] => Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];

/** 参考图角色分类（对齐影策 @引用三色：角色蓝/环境绿/道具黄，规则同 canvas-agent inferReferenceRole）。 */
function referenceKindOf(text: string): "character" | "scene" | "prop" | "other" {
    const t = text.toLowerCase();
    if (/人物|角色|定妆|形象|identity|portrait|character/.test(t)) return "character";
    if (/场景|环境|scene|room|interior|exterior/.test(t)) return "scene";
    if (/道具|prop|ticket|phone/.test(t)) return "prop";
    return "other";
}
const REF_KIND_LABEL: Record<ReturnType<typeof referenceKindOf>, string> = {
    character: "角色",
    scene: "场景",
    prop: "道具",
    other: "参考",
};
/** 影策引用 chip 文案：`角色1 / 场景2 / 道具3`（种类取 referenceKindOf 真值，编号取 ordinal）；种类不明时用原始 label。 */
export function refChipLabel(t: { roleKind?: string; ordinal?: number; label?: string }) {
    const kind = t.roleKind as ReturnType<typeof referenceKindOf> | undefined;
    if (kind && kind !== "other" && t.ordinal) return `${REF_KIND_LABEL[kind]}${t.ordinal}`;
    return String(t.label || "");
}
const REF_KIND_STYLE: Record<ReturnType<typeof referenceKindOf>, string> = {
    character: "border-sky-400 bg-sky-500/10 text-sky-300",
    scene: "border-emerald-400 bg-emerald-500/10 text-emerald-300",
    prop: "border-amber-400 bg-amber-500/10 text-amber-300",
    other: "border-border bg-muted/40 text-muted-foreground",
};

/** 富提示词编辑器用的彩色 token 样式（原型同 REF_KIND_STYLE，描边+浅底+彩色文字）。 */
const PROMPT_TOKEN_STYLE: Record<string, string> = {
    character: "border-sky-400/60 bg-sky-500/10 text-sky-300",
    scene: "border-emerald-400/60 bg-emerald-500/10 text-emerald-300",
    prop: "border-amber-400/60 bg-amber-500/10 text-amber-300",
    other: "border-border bg-muted/40 text-muted-foreground",
};

/** innerHTML 片段用的转义（正文 pill 只能拼字符串：contentEditable 里不能放 React 节点）。 */
const escapeHtmlText = (v: unknown): string => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeHtmlAttr = (v: unknown): string => escapeHtmlText(v).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** 引用缩略图：有真实 url 用圆图；没有就用资产名首字占位，不伪造图片。 */
function RefThumb({ url, name, size = 20 }: { url?: unknown; name?: unknown; size?: number }) {
    const src = str(url).trim();
    const style = { width: size, height: size };
    if (src) return <img src={src} alt="" className="shrink-0 rounded-full object-cover" style={style} />;
    return (
        <span className="inline-grid shrink-0 place-items-center rounded-full bg-foreground/10 text-[10px] font-semibold" style={style}>
            {(str(name).trim() || "图").slice(0, 1)}
        </span>
    );
}
/** 与 RefThumb 同口径的 innerHTML 版本（正文 pill 用）。 */
function refThumbHtml(url: unknown, name: unknown, size = 20): string {
    const src = str(url).trim();
    const style = `width:${size}px;height:${size}px`;
    if (src) return `<img src="${escapeHtmlAttr(src)}" alt="" class="shrink-0 rounded-full object-cover" style="${style}" />`;
    return `<span class="inline-grid shrink-0 place-items-center rounded-full bg-foreground/10 text-[10px] font-semibold" style="${style}">${escapeHtmlText((str(name).trim() || "图").slice(0, 1))}</span>`;
}

/** 引用的参考图短文案：有资产真名才带名字，没有就只写编号（不编名）。 */
const refCaptionOf = (t: { n: number; name?: unknown }): string => str(t.name).trim() ? `参考图 ${t.n} · ${t.name}` : `参考图 ${t.n}`;

/**
 * 正文内联引用 pill（对齐影策 canvas-resource-inline-mention）：
 * `(@` + 20px 圆缩略图 + `参考图 N · 名称` + 类型小标。仍是 contenteditable=false 的叶子节点，
 * 序列化（editableText）还原成 `<Picture N>`，存回画布/字数口径不变。
 */
function pictureTokenHtml(t: { n: number; kind?: string; url?: unknown; name?: unknown }): string {
    const kind = str(t.kind) || "other";
    const caption = refCaptionOf(t);
    const kindLabel = REF_KIND_LABEL[kind as ReturnType<typeof referenceKindOf>] || "参考";
    return `<span contenteditable="false" data-picture-token="${t.n}" title="${escapeHtmlAttr(caption)}" class="mx-0.5 inline-flex items-center gap-1 rounded-full border px-1 py-[1px] align-middle text-[11px] leading-none ${PROMPT_TOKEN_STYLE[kind] || PROMPT_TOKEN_STYLE.other}"><span class="opacity-75">(@</span>${refThumbHtml(t.url, t.name, 20)}<span class="font-medium">${escapeHtmlText(caption)}</span><span class="rounded-sm border border-current/40 px-1 text-[10px] opacity-80">${escapeHtmlText(kindLabel)}</span><span class="opacity-75">)</span></span>`;
}

function tokenizedPromptHtml(text: string, tokens: Array<{ n: number; kind: string; url?: string; name?: string }>): string {
    return escapeHtmlText(text).replace(/&lt;Picture\s+(\d+)&gt;/g, (_all, raw: string) => {
        const n = Number(raw);
        const t = tokens.find((x) => x.n === n);
        return pictureTokenHtml({ n, kind: t?.kind, url: t?.url, name: t?.name });
    });
}

/** contentEditable 的 innerHTML → 纯文本（保留换行，不丢 <Picture N> 原文）。 */
function editableText(el: HTMLElement): string {
    let out = "";
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) { out += node.textContent || ""; return; }
        // 引用 pill 只负责显示（缩略图+名称+类型），序列化必须还原成 <Picture N>，不许把富 HTML 存回画布。
        const tokenN = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement).getAttribute("data-picture-token") : null;
        if (tokenN) { out += `<Picture ${tokenN}>`; return; }
        if (node.nodeName === "BR") { out += "\n"; return; }
        const isBlock = node.nodeName === "DIV" || node.nodeName === "P";
        if (isBlock && out && !out.endsWith("\n")) out += "\n";
        node.childNodes.forEach(walk);
        if (isBlock && !out.endsWith("\n")) out += "\n";
    };
    el.childNodes.forEach(walk);
    return out.replace(/\n+$/, "");
}

/**
 * 影策「完整视频提示词」富编辑器（对齐 segment-dialog.tsx SegmentPrompt）：
 * 标题/说明在卡片头，编辑器内依次是资产类型图例 → 提交口径 + 查看原文 → 引用条 → 正文。
 * 引用条每个参考图一个 chip（20px 圆缩略图 + 类型 + 参考图 N · 名称），单击在光标处插入引用，双击看原图；
 * 存回的仍是含 <Picture N> 的原文，不引入富文本协议。
 */
function RichPromptEditor({ value, onChange, tokens, onEscape, placeholder, originalText }: {
    value: string;
    onChange: (next: string) => void;
    tokens: Array<{ n: number; kind: string; url?: string; name?: string }>;
    onEscape?: () => void;
    placeholder?: string;
    originalText?: string;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    const lastValue = useRef<string | null>(null);
    const caret = useRef<Range | null>(null);
    // 单击 chip 插入引用，240ms 内的第二击按双击处理（预览原图），因此插入要等一个短窗。
    const insertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [preview, setPreview] = useState<{ url: string; caption: string } | null>(null);

    // 外部改写（重新撰写 / 恢复模型版本）才重绘；用户打字时不重绘，避免光标跳动。
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (value === lastValue.current) return;
        lastValue.current = value;
        el.innerHTML = tokenizedPromptHtml(value, tokens);
    }, [value, tokens]);

    useEffect(() => () => { if (insertTimer.current) clearTimeout(insertTimer.current); }, []);

    const commit = () => {
        const el = ref.current;
        if (!el) return;
        const text = editableText(el);
        lastValue.current = text;
        onChange(text);
    };
    const rememberCaret = () => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) caret.current = sel.getRangeAt(0).cloneRange();
    };
    /** 只有真有缩略图地址时才预览原图，缺图不弹空窗。 */
    const openPreview = (t: { n: number; url?: string; name?: string }) => {
        const url = str(t.url).trim();
        if (!url) return;
        setPreview({ url, caption: refCaptionOf(t) });
    };
    const insertToken = (n: number) => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        const range = caret.current && el.contains(caret.current.startContainer) ? caret.current : null;
        if (range) { sel?.removeAllRanges(); sel?.addRange(range); }
        else {
            const r = document.createRange();
            r.selectNodeContents(el);
            r.collapse(false);
            sel?.removeAllRanges();
            sel?.addRange(r);
        }
        const t = tokens.find((x) => x.n === n);
        const holder = document.createElement("div");
        holder.innerHTML = pictureTokenHtml({ n, kind: t?.kind, url: t?.url, name: t?.name });
        const span = holder.firstElementChild;
        const r = sel?.getRangeAt(0);
        if (span && r) {
            r.deleteContents();
            r.insertNode(span);
            r.setStartAfter(span);
            r.collapse(true);
            sel?.removeAllRanges();
            sel?.addRange(r);
        }
        commit();
    };
    const activateChip = (t: { n: number; url?: string; name?: string }) => {
        if (insertTimer.current) {
            clearTimeout(insertTimer.current);
            insertTimer.current = null;
            openPreview(t);
            return;
        }
        insertTimer.current = setTimeout(() => { insertTimer.current = null; insertToken(t.n); }, 240);
    };

    return (
        <div className="rounded-[8px] border border-border bg-background" data-studio-seg-prompt-rich>
            {/* 第二行：资产类型图例（影策 drama-asset-legend 是类型图例，不是筛选 tab）+ 正文可直接修改。 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
                {(["角色", "环境", "道具", "素材"] as const).map((g) => {
                    const kind = g === "角色" ? "character" : g === "环境" ? "scene" : g === "道具" ? "prop" : "other";
                    return (
                        <span key={g} data-studio-prompt-group={g}
                            className={cn("inline-flex h-[18px] items-center rounded-[4px] border px-1 text-[11px]", PROMPT_TOKEN_STYLE[kind])}>{g}</span>
                    );
                })}
                <span className="flex-1" />
                <span className="text-[11px] text-muted-foreground/80" data-studio-prompt-editable-hint>正文可直接修改</span>
            </div>
            {/* 第三行：提交口径说明 + 查看原文（本地不显示提交头，原文弹层保留）。 */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1">
                <span className="text-[10px] text-muted-foreground">提交时附加，参考编号按模型收到的图片顺序对齐</span>
                <Popover trigger="click" placement="bottomRight"
                    content={<div className="max-h-64 max-w-[420px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed" data-studio-prompt-original>{originalText?.trim() || "本段镜头没有原文回指"}</div>}>
                    <button type="button" className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground transition hover:text-foreground" data-studio-prompt-view-original>查看原文</button>
                </Popover>
            </div>
            {/* 引用条：一行（可横向滚动）chip，单击插引用，双击看原图。 */}
            <div className="thin-scrollbar flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-border px-2 py-2" data-studio-ref-bar>
                {tokens.length ? tokens.map((t) => {
                    const kind = (t.kind || "other") as ReturnType<typeof referenceKindOf>;
                    const caption = refCaptionOf(t);
                    return (
                        <button key={t.n} type="button" data-studio-prompt-token={t.n} data-studio-ref-chip={t.n}
                            onClick={() => activateChip(t)}
                            onDoubleClick={() => openPreview(t)}
                            title={str(t.url).trim() ? `${caption} · 双击查看原图` : caption}
                            className={cn("inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border pl-[3px] pr-2 text-[12px] transition hover:opacity-85", PROMPT_TOKEN_STYLE[kind] || PROMPT_TOKEN_STYLE.other)}>
                            <RefThumb url={t.url} name={t.name} size={20} />
                            <span className="font-semibold">{REF_KIND_LABEL[kind] || "参考"}</span>
                            <span className="opacity-80">{caption}</span>
                        </button>
                    );
                }) : <span className="text-[11px] text-muted-foreground">本段没有参考图，正文可先手写</span>}
            </div>
            <div
                ref={ref}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                data-studio-seg-prompt-input
                data-placeholder={placeholder}
                onInput={commit}
                onKeyUp={rememberCaret}
                onMouseUp={rememberCaret}
                onDoubleClick={(e) => {
                    const pill = (e.target as HTMLElement | null)?.closest?.("[data-picture-token]") as HTMLElement | null;
                    if (!pill) return;
                    const n = Number(pill.getAttribute("data-picture-token") || 0);
                    const t = tokens.find((x) => x.n === n);
                    if (t) openPreview(t);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Escape" && onEscape) { e.stopPropagation(); e.preventDefault(); onEscape(); }
                }}
                style={{ fontSize: 14, lineHeight: 1.85, whiteSpace: "pre-wrap" }}
                className="thin-scrollbar max-h-[558px] min-h-[558px] overflow-y-auto px-[14px] py-3 outline-none empty:before:pointer-events-none empty:before:text-muted-foreground/70 empty:before:content-[attr(data-placeholder)]"
            />
            <Modal open={Boolean(preview)} onCancel={() => setPreview(null)} centered width={760} title={preview?.caption || "参考图原图"}
                footer={<button type="button" onClick={() => setPreview(null)} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground">关闭</button>}
                data-studio-ref-preview-modal>
                {preview ? <img src={preview.url} alt={preview.caption} className="max-h-[70vh] w-full rounded-lg object-contain" /> : null}
            </Modal>
        </div>
    );
}
const str = (v: unknown): string => (typeof v === "string" || typeof v === "number") ? String(v) : "";

/** 参考图分类：优先用绑定自身 role（character_identity/scene/prop），label 只有 <Picture N> 时按它兜底。 */
function refBindingKind(binding: { role?: unknown; label?: unknown }): "character" | "scene" | "prop" | "other" {
    const role = str(binding?.role).toLowerCase();
    if (role.includes("character")) return "character";
    if (role === "scene" || role === "environment") return "scene";
    if (role === "prop") return "prop";
    return referenceKindOf(str(binding?.label));
}

/** 音色派生绑定（role=character_voice / mediaType=audio）不是一张参考图：不进参考卡分组，音色由角色卡内的音色行承载。 */
function isVoiceReferenceBinding(binding: { role?: unknown; mediaType?: unknown }): boolean {
    return str(binding?.mediaType).toLowerCase() === "audio" || str(binding?.role).toLowerCase().includes("voice");
}

/**
 * 参考图绑定的 name 在历史数据里可能是空的（只存了 `<Picture N>`）：用资产真名表兜底。
 * 绑定 id 可能带实例后缀（`asset-character-526xuk-f7f8ca75d0`），先整体匹配，再逐段去掉尾部片段匹配。
 */
function resolveAssetName(id: string, names: Readonly<Record<string, string>> | undefined): string {
    const key = str(id);
    if (!key || !names) return "";
    if (names[key]) return names[key];
    // 资产真名表的 id 与参考绑定 id 同源但前缀/后缀不同（`shared-image-asset-character-526xuk`
    // vs `asset-character-526xuk-f7f8ca75d0`）：按「类型-编号」签名匹配。
    const signature = (value: string) => {
        const hit = value.match(/(character|scene|prop)-([a-z0-9]+)/i);
        return hit ? `${hit[1].toLowerCase()}-${hit[2].toLowerCase()}` : "";
    };
    const wanted = signature(key);
    if (wanted) {
        const found = Object.keys(names).find((k) => signature(k) === wanted);
        if (found) return names[found];
    }
    const parts = key.split("-");
    for (let i = parts.length - 1; i >= 3; i -= 1) {
        const candidate = parts.slice(0, i).join("-");
        if (names[candidate]) return names[candidate];
    }
    const hit = Object.keys(names).find((k) => k && (key.startsWith(k) || k.startsWith(key)));
    return hit ? names[hit] : "";
}

/** 等待原因的短标签：取冒号或括号前的部分，完整原因放 detail（对齐影策 videoWaitLabel，segment-parts.tsx:17-20）。 */
export function videoWaitLabel(wait: string) {
    return wait.split(/[:：（(]/)[0] || wait;
}

/** 参考图标号真值：兼容 Picture N / 参考图N / 图N；取不到返回 0，不猜。 */
function referenceOrdinalOf(label: unknown): number {
    return Number(str(label).match(/(?:Picture|参考图|图)\s*(\d+)/i)?.[1] || 0) || 0;
}

/**
 * 未附图文案（对齐影策 SegmentInputs：ref.sent=false 时显示「未附图：<reason>」）：
 * 只展示后端 state.references 下发的真值；missingReason 缺失时只说「未附图」，不编造原因。
 */
export function referenceMissingLabel(ref: { sent?: unknown; missingReason?: unknown }): string | null {
    if (ref?.sent !== false) return null;
    const reason = str(ref.missingReason).trim();
    return reason ? `未附图：${reason}` : "未附图";
}

/** hover 类型段：角色/环境/道具（影策口径）；种类不明时整段省略，不用「参考」占位。 */
export function referenceHoverKindLabel(kind: unknown): string {
    const key = typeof kind === "string" ? kind : referenceKindOf(str(kind));
    return key === "character" ? "角色" : key === "scene" ? "环境" : key === "prop" ? "道具" : "";
}

/**
 * 参考图 hover 文案（对齐影策 `参考图2 · 角色 · 蛇妻`）：只写编号/类型/名称。
 * assetId/nodeId/storageKey 等内部来源与点击行为留在元素上，不进提示；
 * 名称是「<图N>」占位编号时视为无名；只有后端真值 sent=false 才追加一行未附图说明。
 */
export function referenceHoverText(t: { ordinal?: unknown; label?: unknown; name?: unknown; roleKind?: unknown; role?: unknown; sent?: unknown; missingReason?: unknown }): string {
    const ordinal = Number(t.ordinal) > 0 ? Number(t.ordinal) : referenceOrdinalOf(t.label);
    const kindKey = str(t.roleKind) || referenceKindOf(`${str(t.label)} ${str(t.role)} ${str(t.name)}`);
    const name = str(t.name).trim();
    const head = [ordinal > 0 ? `参考图 ${ordinal}` : "参考图", referenceHoverKindLabel(kindKey), /^<图\d+>$/.test(name) ? "" : name]
        .filter(Boolean).join(" · ");
    const missing = referenceMissingLabel(t);
    return missing ? `${head}\n${missing}` : head;
}

/**
 * 段卡片状态：后端派生真值 segment.state（promptStatus/promptError/waitReason/upstreamStage/
 * references/videoStatus/videoError/request）按影策 segmentState 的 6 态（failed/blocked/busy/stale/ready/idle）
 * 细分；画布 H3 段 status/errorDetails/inputOutdated 是本地真实字段，原有分支全部保留。
 * 任何字段缺失都只回落到本地真能证实的态，不编造等待原因、上游阶段或失败原因。
 */
export type SegmentCardTone = "idle" | "busy" | "failed" | "stale" | "ready" | "blocked";
export type SegmentCardState = { tone: SegmentCardTone; label: string; detail?: string };
/** 画布 H3 段的真实占用态：段卡的忙碌遮罩、按钮与状态徽标必须共用同一份真值，不能各判各的。 */
const BUSY_VIDEO_STATUSES = new Set(["queued", "running", "loading", "awaiting_confirmation", "pending", "generating"]);
export function segmentCardState(input: {
    prompt: string;
    artStatus?: string;
    /** 画布 H3 段的 status（本地真值）；未传 stateVideoStatus 时用它判视频态。 */
    videoStatus?: string;
    inputOutdated?: boolean;
    hasVideo?: boolean;
    /** 画布 H3 节点级 errorDetails（本地真值），失败原因优先级最高。 */
    errorDetails?: string;
    // 以下来自 draft segment.state（后端派生真值，未落地时全部缺省）。
    promptStatus?: StudioSegmentState["promptStatus"];
    promptError?: string;
    waitReason?: string;
    upstreamStage?: string;
    references?: StudioSegmentState["references"];
    custom?: StudioSegmentState["custom"];
    videoReprocessable?: StudioSegmentState["videoReprocessable"];
    /** state.videoStatus：有真值时覆盖画布段 status，失败原因取 state.videoError（无则不编造）。 */
    stateVideoStatus?: StudioSegmentState["videoStatus"];
    videoError?: StudioSegmentState["videoError"];
    request?: StudioSegmentState["request"];
}): SegmentCardState {
    const promptStatus = str(input.promptStatus).toLowerCase();
    const writing = promptStatus === "queued" || promptStatus === "running";
    const waitReason = str(input.waitReason).trim();
    const upstreamStage = str(input.upstreamStage).trim();
    const promptError = str(input.promptError).trim();
    // 视频阶段：后端 state 优先，画布 H3 段 status 兜底（兼容历史数据与未落地字段）。
    const stateVideoStatus = str(input.stateVideoStatus).toLowerCase();
    const videoStatus = stateVideoStatus || str(input.videoStatus).toLowerCase();
    // 失败原因：画布 errorDetails → state.videoError → 仅画布态可说明「详见生成日志」；state 失败无原因则不带 detail。
    const failureDetail = str(input.errorDetails).trim() || str(input.videoError).trim()
        || (stateVideoStatus ? "" : `画布 H3 段 status=${videoStatus}；未记录具体原因，详见生成日志。`);
    // request.firstFramePending 是后端真值：生成中但首帧还在等上一段，显示 blocked 而不是「生成视频中」。
    const firstFramePending = input.request?.firstFramePending === true;
    // 影策优先级 1：提示词撰写失败是提示词阶段终态，先于「无提示词」与视频态。
    if (promptStatus === "failed") return { tone: "failed", label: "提示词撰写失败", ...(promptError ? { detail: promptError } : {}) };
    // 影策优先级 2：视频失败（error/failed）；videoReprocessable 真值时成片已在库，重试只重做后处理。
    if (videoStatus === "error" || videoStatus === "failed") {
        return {
            tone: "failed",
            label: input.videoReprocessable ? "视频后处理失败" : "视频生成失败",
            ...(failureDetail ? { detail: failureDetail } : {}),
        };
    }
    // 影策优先级 2.5：画布段确有视频任务在跑时，视频态是唯一真值，必须压过 promptStatus=stale。
    // 否则「提示词已过期」徽标会和按钮/遮罩的「生成中」同时出现，用户看到互相矛盾的状态。
    if (BUSY_VIDEO_STATUSES.has(videoStatus)) {
        if (videoStatus === "queued" && waitReason) return { tone: "blocked", label: videoWaitLabel(waitReason), detail: waitReason };
        if (videoStatus === "queued") return { tone: "busy", label: "排队提交中" };
        if (firstFramePending) return { tone: "blocked", label: "等待上一段" };
        return upstreamStage ? { tone: "busy", label: upstreamStage, detail: `上游进度：${upstreamStage}` } : { tone: "busy", label: "生成视频中" };
    }
    // 影策优先级 3：撰写作业已排队但还没提交——显示真实等待原因，不冒充「撰写中」。
    if (writing && waitReason) return { tone: "blocked", label: videoWaitLabel(waitReason), detail: waitReason };
    // 影策优先级 4：撰写中；上游阶段是真值时直接展示阶段而非笼统文案。
    if (writing) return upstreamStage ? { tone: "busy", label: upstreamStage, detail: `上游进度：${upstreamStage}` } : { tone: "busy", label: "撰写提示词中" };
    // 影策优先级 5-6：待撰写 / 提示词已过期。custom（手写）为真时 stale 不显示过期，继续往下判。
    if (promptStatus === "none") return { tone: "idle", label: "待撰写提示词" };
    if (promptStatus === "stale" && !input.custom) return { tone: "stale", label: "提示词已过期" };
    // 本地 H3 段真实取消态（影策无对应字段，保留不回归）。
    if (videoStatus === "cancelled") return { tone: "idle", label: "视频生成已取消", detail: "画布 H3 段 status=cancelled，可重新发起生成。" };
    // 影策视频 stale：需重新生成（state.videoStatus 真值，不伪造输入变更原因）。
    if (videoStatus === "stale") return { tone: "stale", label: "视频需重新生成" };
    // inputOutdated 是 H3 段真实字段：提示词/参考图变更后当前视频为旧版（对齐影策 stale「视频需重新生成」）。
    if (input.inputOutdated) return { tone: "stale", label: "视频需重新生成（输入已更改）", detail: "本段提示词或参考图已变更，当前视频为旧版。" };
    if (str(input.artStatus) === "stale") return { tone: "stale", label: "视频需重新生成" };
    if (input.hasVideo || ["ready", "success", "succeeded"].includes(videoStatus)) return { tone: "ready", label: "视频已生成" };
    // 后端 state 未落地时的本地真值：没有提示词就是待撰写。
    if (!input.prompt && !promptStatus) return { tone: "idle", label: "待撰写提示词" };
    return { tone: "idle", label: "待生成视频" };
}

/** 参考图来源只取 artifact.references 里的真字段（assetId / nodeId / storageKey），不用名字猜来源。 */
export function referenceSourceLabel(ref: { assetId?: unknown; nodeId?: unknown; storageKey?: unknown }): string {
    if (str(ref.assetId)) return "项目资产设定";
    if (str(ref.nodeId)) return "画布设定节点";
    if (str(ref.storageKey)) return "制作稿编译参考";
    return "未绑定设定";
}

/**
 * 提示词字数上限真值（对齐影策 segment-dialog.tsx:740-751）：
 * - 影策用 VideoReferenceConfig.PromptMaxChars（视频默认 8000）按码点硬校验，超限禁止保存，
 *   界面 role=alert 明示「超过视频模型上限 N 个字符」。
 * - 本地由 D 路在 ChannelModel / 模型目录派生 promptMaxChars，前端按约定从
 *   modelVideoCapabilitiesOf(config, 段模型).promptMaxChars 读取（number | undefined）。
 *   字段尚未落地的中间态读不到真值 → 不编造上限、不拦截保存，仅保留本地软提醒。
 */
export const LOCAL_PROMPT_SOFT_LIMIT_CHARS = 40_000;

/** 只认有限正数；undefined / NaN / 0 / 负数一律视为「无真值」，兼容字段未落地的中间态。 */
export function modelPromptMaxChars(capabilities: unknown): number | null {
    const value = (capabilities as { promptMaxChars?: unknown } | null | undefined)?.promptMaxChars;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 影策段卡「上限 15s」：模型声明的单次视频时长上限（/settings/ai-config 已下发的能力真值，无声明则 null）。 */
export function modelMaxVideoSeconds(capabilities: unknown): number | null {
    const value = (capabilities as { maxVideoSeconds?: unknown } | null | undefined)?.maxVideoSeconds;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 与影策同口径按 Unicode 码点计数；maxChars 为 null 时永不拦截。 */
export function isPromptOverModelLimit(text: string, maxChars: number | null): boolean {
    return maxChars !== null && Array.from(text || "").length > maxChars;
}

/** 按 Unicode 码点计提交正文长度（对齐影策 Array.from(...).length 与后端 RuneCount）。 */
export function promptCharStats(text: string, softLimit = LOCAL_PROMPT_SOFT_LIMIT_CHARS): { sentChars: number; overSoftLimit: boolean } {
    const sentChars = Array.from(text || "").length;
    return { sentChars, overSoftLimit: sentChars > softLimit };
}

/**
 * 影策 segment-dialog.tsx:573-586 referenceUsage 的本地对齐（纯前端、不写真值）。
 * 本地提示词用尖括号 <Picture N> 形式引用（富编辑器引用条/pill 序列化后的 token，回执也按此口径统计），
 * 本段可用编号来自 h3 artifact references[].label 派生的 thumbnails[].ordinal。
 * 返回正文引用到的编号，以及不属于本段参考图的非法编号（去重、按出现顺序）。
 */
export function pictureReferenceUsage(text: string, validOrdinals: readonly number[]): { used: Set<number>; unknown: number[] } {
    const valid = new Set(validOrdinals.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0));
    const used = new Set<number>();
    const unknown: number[] = [];
    for (const match of text.matchAll(/<Picture\s*(\d+)\s*>/gi)) {
        const n = Number(match[1]);
        used.add(n);
        if (!valid.has(n) && !unknown.includes(n)) unknown.push(n);
    }
    return { used, unknown };
}

/**
 * 段级音色真值视图。真值在画布 H3 Clip 的 metadata.segments[].h3CharacterGroups[]：
 * voiceEnabled + voice.url/voice.storageKey 会在 reference-contract.resolveCharacterGroupBindings
 * 里派生出一条 mediaType=audio 的引用，最终由 h3-runner 随本段视频请求发送（上限取自模型 maxAudios）。
 * 制作稿 draft 里没有这份字段，必须定向读画布 project；写回走 update_h3_segment。
 * 段级模式 audioReferenceMode('auto'|'custom') 与 autoVoiceGroupIds(按对白派生的组 ID 列表)
 * 是本段真值的一部分：auto 时 h3-runner 只发送派生组，custom 时只发送 voiceEnabled 组。
 */

type SegmentVoiceView = {
    groupId: string; name: string; enabled: boolean; hasVoice: boolean;
    voiceName: string; storageKey: string; url: string;
    /** 段级音色覆写：本组当前指定的声音样本 storageKey（空表示沿用本体自动音色）。 */
    overrideStorageKey: string; overrideName: string;
};
type SegmentVoiceTruth = {
    canvasId: string; nodeId: string; canvasSegmentId: string; revision: number;
    voices: SegmentVoiceView[]; audioLimit: number; videoModel: string;
    audioReferenceMode: "auto" | "custom"; autoVoiceGroupIds: string[];
    notes: VoiceReferenceNoteView[];
};

/** 段 → 画布 H3 目标解析（与 use-studio-data 的 resolveSegmentCanvasTarget 同构，避免新增父组件 prop）。 */
async function resolveSegmentVoiceTruth(ep: StudioEpisode, segmentId: string): Promise<SegmentVoiceTruth> {
    if (!ep?.canvasId) throw new Error("本集画布尚未就绪，请先在画布中打开本集");
    const projectRes = await fetchBackendProject(ep.canvasId);
    const project = ((projectRes as any).project || projectRes) as Row;
    const nodes = (Array.isArray(project?.nodes) ? project.nodes : []) as Row[];
    let nodeId = "";
    let canvasSegmentId = "";
    try {
        const prodRes = await fetchEpisodeProduction(ep.id as never);
        const draft = ((prodRes?.production?.draft || {}) as Record<string, unknown>);
        const clipGroups = (Array.isArray(draft.clipGroups) ? draft.clipGroups : []) as Row[];
        const group = clipGroups.find(g => str(g?.id) === segmentId);
        nodeId = str(group?.nodeId);
        canvasSegmentId = str(group?.segmentId);
    } catch { /* clipGroups 只是加速路径，解析不到就按 targetId 扫画布 */ }
    if (!nodeId || !canvasSegmentId) {
        outer: for (const n of nodes) {
            if (!String(n?.type || "").includes("minimax-h3")) continue;
            for (const cs of (Array.isArray(n?.metadata?.segments) ? n.metadata.segments : []) as Row[]) {
                if (str((cs?.productionClipProjection as Row | undefined)?.targetId) === segmentId) {
                    nodeId = str(n.id);
                    canvasSegmentId = str(cs.id);
                    break outer;
                }
            }
        }
    }
    if (!nodeId || !canvasSegmentId) throw new Error("该段尚未同步到画布 H3 节点，请先在画布中打开本集");
    const node = nodes.find(n => str(n.id) === nodeId);
    const seg = ((Array.isArray(node?.metadata?.segments) ? node.metadata.segments : []) as Row[]).find(s => str(s.id) === canvasSegmentId);
    const groups = (seg?.h3CharacterGroups || {}) as Record<string, Row>;
    const overrides = (seg?.voiceOverrides || {}) as Record<string, unknown>;
    const voices: SegmentVoiceView[] = Object.entries(groups).map(([groupId, g]) => {
        const v = (g?.voice || {}) as Row;
        const ovRaw = overrides[groupId];
        const ov = (ovRaw && typeof ovRaw === "object" ? ovRaw : {}) as Row;
        return {
            groupId,
            name: str(g?.characterName || groupId),
            enabled: g?.voiceEnabled === true,
            // reference-contract.resolveCharacterGroupBindings 只在 voice.url 非空时派生 audio 绑定，
            // 这里的 hasVoice 必须与那个真实条件一致，不能把「有 storageKey 但无 url」误报成会随请求发送。
            hasVoice: Boolean(str(v.url)),
            voiceName: str(v.name),
            storageKey: str(v.storageKey),
            url: str(v.url),
            overrideStorageKey: typeof ovRaw === "string" ? ovRaw : str(ov.storageKey),
            overrideName: str(ov.name),
        };
    });
    const rawMode = str(seg?.taskMode || seg?.mode || "ref2va");
    const mode = ["t2v", "i2v", "fl2v"].includes(rawMode) ? rawMode : "ref2va";
    const autoVoiceGroupIds = (Array.isArray(seg?.autoVoiceGroupIds) ? seg.autoVoiceGroupIds : []).map(str).filter(Boolean);
    // 当前段实际选用的视频模型：段级 → 节点 → 制作设置默认 → H3 默认。
    // 上限按该模型的 maxAudios 真实能力读取（影策 profile.MaxAudios），非 ref2va 模式 0。
    const config = useConfigStore.getState().config;
    const videoModel = str(seg?.selectedVideoModel) || str((node?.metadata as Row | undefined)?.selectedVideoModel)
        || str(config.videoModel) || DEFAULT_SEGMENT_VIDEO_MODEL;
    const audioLimit = segmentAudioLimitOf(config, videoModel, mode);
    // 段级 Note 随段详情从画布 H3 段 voiceReferenceNotes 读出（不只在生成日志 warnings 里）。
    const notes = projectVoiceReferenceNotes(seg?.voiceReferenceNotes);
    return {
        canvasId: ep.canvasId, nodeId, canvasSegmentId,
        revision: Number(project?.revision || 0), voices,
        audioLimit, videoModel,
        audioReferenceMode: seg?.audioReferenceMode === "custom" ? "custom" : "auto",
        autoVoiceGroupIds, notes,
    };
}

/**
 * 写回段级音色真值：整张 h3CharacterGroups 映射一起发送，绕过深合并歧义。
 * buildPatch 可同时改 audioReferenceMode 与逐组 voiceEnabled，保证模式与开关一次原子落盘。
 */
async function applySegmentVoicePatch(truth: SegmentVoiceTruth, buildPatch: (groups: Record<string, Row>) => Record<string, unknown>): Promise<void> {
    const projectRes = await fetchBackendProject(truth.canvasId);
    const project = ((projectRes as any).project || projectRes) as Row;
    const nodes = (Array.isArray(project?.nodes) ? project.nodes : []) as Row[];
    const node = nodes.find(n => str(n.id) === truth.nodeId);
    const seg = ((Array.isArray(node?.metadata?.segments) ? node.metadata.segments : []) as Row[]).find(s => str(s.id) === truth.canvasSegmentId);
    if (!seg) throw new Error("段数据已变化，请刷新后重试");
    const groups = { ...((seg.h3CharacterGroups || {}) as Record<string, Row>) };
    const patch = buildPatch(groups);
    await applyBackendCanvasOperations(truth.canvasId, [{
        type: "update_h3_segment", nodeId: truth.nodeId, segmentId: truth.canvasSegmentId,
        patch: { ...patch, h3CharacterGroups: groups },
    }], Number(project?.revision || truth.revision || 0));
}

/** 段 → 画布 H3 Clip 目标解析（参考图策略 / 视频重跑共用；generation_logs.segmentId 用画布 Clip id）。 */
async function resolveSegmentCanvasTargetForPanel(ep: StudioEpisode, segmentId: string) {
    if (!ep?.canvasId) throw new Error("本集画布尚未就绪，请先在画布中打开本集");
    const projectRes = await fetchBackendProject(ep.canvasId);
    const project = ((projectRes as any).project || projectRes) as Row;
    const nodes = (Array.isArray(project?.nodes) ? project.nodes : []) as Row[];
    let nodeId = "";
    let canvasSegmentId = "";
    try {
        const prodRes = await fetchEpisodeProduction(ep.id as never);
        const draft = ((prodRes?.production?.draft || {}) as Record<string, unknown>);
        const clipGroups = (Array.isArray(draft.clipGroups) ? draft.clipGroups : []) as Row[];
        const group = clipGroups.find(g => str(g?.id) === segmentId);
        nodeId = str(group?.nodeId);
        canvasSegmentId = str(group?.segmentId);
    } catch { /* clipGroups 只是加速路径，解析不到就按 targetId 扫画布 */ }
    if (!nodeId || !canvasSegmentId) {
        outer: for (const n of nodes) {
            if (!String(n?.type || "").includes("minimax-h3")) continue;
            for (const cs of (Array.isArray(n?.metadata?.segments) ? n.metadata.segments : []) as Row[]) {
                if (str((cs?.productionClipProjection as Row | undefined)?.targetId) === segmentId) {
                    nodeId = str(n.id);
                    canvasSegmentId = str(cs.id);
                    break outer;
                }
            }
        }
    }
    if (!nodeId || !canvasSegmentId) throw new Error("该段尚未同步到画布 H3 节点，请先在画布中打开本集");
    const node = nodes.find(n => str(n.id) === nodeId);
    const seg = ((Array.isArray(node?.metadata?.segments) ? node.metadata.segments : []) as Row[]).find(s => str(s.id) === canvasSegmentId);
    if (!seg) throw new Error("段数据已变化，请刷新后重试");
    return { canvasId: ep.canvasId, nodeId, canvasSegmentId, revision: Number(project?.revision || 0), seg };
}

/** 段级参考图真值：画布 H3 Clip 的 referenceBindings（稳定 id / 顺序 / enabled）+ 制作稿 referenceOverrides。 */
export type SegmentReferenceView = {
    id: string; label: string; role: string; storageKey: string; url: string; ordinal: number; enabled: boolean;
    /** 媒体类型：audio 是角色音色派生的音频绑定，不是一张参考图卡。 */
    mediaType: string;
    /** 角色组 id：与 h3CharacterGroups 的 key 同源，用来把参考卡和音色组对上。 */
    groupId: string;
    /** 绑定自带的名字（多数历史绑定只有 <Picture N>，真名要靠资产名表/本段 thumbnails 兜底）。 */
    name: string;
};
export type SegmentReferenceTruth = {
    canvasId: string; nodeId: string; canvasSegmentId: string; revision: number;
    bindings: SegmentReferenceView[]; mode: "auto" | "manual"; order: string[]; disabled: string[];
};
async function resolveSegmentReferenceTruth(ep: StudioEpisode, segmentId: string): Promise<SegmentReferenceTruth> {
    const target = await resolveSegmentCanvasTargetForPanel(ep, segmentId);
    // 段弹窗真值 = 画布存储段的 referenceBindings（prepare 时由源稿直接投影写入）。
    // 不再读派生轨覆盖：源稿改动只有在 prepare 投影落画布后才可见，保证单一数据源。
    const shownSeg = target.seg;
    const raw = (Array.isArray(shownSeg.referenceBindings) ? shownSeg.referenceBindings : []) as Row[];
    const compiledOrder = (Array.isArray(shownSeg.referenceOrder) ? shownSeg.referenceOrder : []).map(str).filter(Boolean);
    // 展示顺序以画布当前生效顺序为准：referenceOrder 缺行时按数组顺序补齐。
    const ids = compiledOrder.length
        ? [...compiledOrder, ...raw.map(b => str(b.id)).filter(id => id && !compiledOrder.includes(id))]
        : raw.map(b => str(b.id));
    const bindings: SegmentReferenceView[] = raw.map((b, i) => ({
        id: str(b.id),
        label: str(b.label || b.name || `参考 ${i + 1}`),
        role: str(b.role),
        storageKey: str(b.storageKey),
        url: str(b.storageKey) ? backendMediaUrl(str(b.storageKey)) : str(b.url),
        ordinal: Number.isFinite(Number(b.order)) ? Number(b.order) + 1 : i + 1,
        enabled: b.enabled !== false,
        mediaType: str(b.mediaType),
        groupId: str(b.groupId),
        name: str(b.name),
    }));
    let mode: "auto" | "manual" = "auto";
    let truthOrder: string[] = ids;
    let disabled: string[] = [];
    try {
        const prodRes = await fetchEpisodeProduction(ep.id as never);
        const draft = ((prodRes?.production?.draft || {}) as Record<string, unknown>);
        const director = (draft.director || {}) as Record<string, unknown>;
        // v2 制作的 referenceOverrides 真值在 director.source.segments[]，draft 不带旧 segments 投影数组。
        const segments = (Array.isArray(director.source && (director.source as Row).segments) ? (director.source as Row).segments : (Array.isArray(draft.segments) ? draft.segments : [])) as Row[];
        const ov = segments.find(s => str(s.id) === segmentId)?.referenceOverrides as Row | undefined;
        if (ov && str(ov.mode) === "manual") {
            mode = "manual";
            truthOrder = Array.isArray(ov.order) ? ov.order.map(str).filter(Boolean) : ids;
            disabled = Array.isArray(ov.disabled) ? ov.disabled.map(str).filter(Boolean) : [];
        }
    } catch { /* 读不到覆写就按画布当前生效顺序展示 */ }
    // disabled 真值优先取源稿覆写；画布 binding 上已 disabled 的也纳入（兼容尚未重新编译的场景）。
    const disabledSet = new Set([...disabled, ...bindings.filter(b => !b.enabled).map(b => b.id)]);
    // UI 顺序必须立即反映用户写入的覆写真值，不能等异步重新编译把画布 referenceOrder 改过来。
    // 未列入覆写 order 的绑定按当前生效顺序追加到末尾（与后端 applySegmentReferenceOverrides 一致）。
    const displayOrder = mode === "manual" ? [...truthOrder, ...ids.filter(id => !truthOrder.includes(id))] : ids;
    bindings.sort((a, b) => displayOrder.indexOf(a.id) - displayOrder.indexOf(b.id));
    return {
        canvasId: target.canvasId, nodeId: target.nodeId, canvasSegmentId: target.canvasSegmentId,
        revision: target.revision,
        bindings: bindings.map(b => ({ ...b, enabled: !disabledSet.has(b.id) })),
        mode, order: truthOrder, disabled: [...disabledSet],
    };
}

/** 参考图管理弹窗里的一条候选（全部来自真实素材 / 画布节点，storageKey 为空的条目不可加入）。 */
type ManageImageItem = { key: string; storageKey: string; url: string; label: string };

/** 提交头的单行真值：编号来自编译器提交顺序，label/storageKey 来自画布绑定快照。 */
export type SubmissionRefLine = { ordinal: number; label: string; storageKey: string };

/**
 * 把已按提交顺序编号的参考图拼成「提交全文」的头部（纯函数，不读 DOM、不发请求）。
 * 本地段上并不存在影策的 request.header 字段，这里只用已有真值现拼等价文本，绝不伪造该字段。
 * 没有 storageKey 的条目如实标注，避免让人误以为它会随请求发送。
 */
export function buildSegmentSubmissionHeader(refs: SubmissionRefLine[]): string {
    const lines = refs.map((ref) => {
        const label = ref.label || `参考 ${ref.ordinal}`;
        const key = ref.storageKey ? ref.storageKey : "无 storageKey（不会随请求发送）";
        return `Picture ${ref.ordinal}: ${label} · ${key}`;
    });
    return lines.length ? `【本段参考图 · 按提交顺序】\n${lines.join("\n")}` : "";
}

/**
 * 「复制提交全文」真值：段 prompt + compileReferenceSubmission 按提交顺序编号的参考图头。
 * 复用画布 H3 段的 referenceBindings + referenceOrder，编号与真正提交给视频模型的一致；
 * 不读取也不伪造影策的 request.header。
 */
async function buildSegmentSubmissionFull(ep: StudioEpisode, segmentId: string, prompt: string): Promise<string> {
    const target = await resolveSegmentCanvasTargetForPanel(ep, segmentId);
    const projectRes = await fetchBackendProject(target.canvasId);
    const project = ((projectRes as any).project || projectRes) as Row;
    const compiled = compileReferenceSubmission(project as Record<string, unknown>, target.seg as Record<string, unknown>);
    const images: SubmissionRefLine[] = compiled.references
        .filter((r) => r.mediaType === "image")
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((r) => ({ ordinal: r.ordinal, label: str(r.label || r.subjectId || r.groupId), storageKey: str(r.storageKey) }));
    const header = buildSegmentSubmissionHeader(images);
    return [header, String(prompt || "").trim()].filter(Boolean).join("\n\n");
}

/** 生产稿 op 提交：读最新 revision 作基线；409 REVISION_CONFLICT / 400 SOURCE_CHANGED_DURING_VALIDATION 都回读重试（连续失焦多字段不丢写）。 */
async function commitProductionOps(episodeId: string, ops: ProductionOperation[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const fresh = await fetchEpisodeProduction(episodeId as never);
            await editEpisodeProduction(episodeId as never, fresh.production?.revision ?? 0, ops);
            return;
        } catch (error) {
            lastError = error;
            const conflict = error instanceof BackendApiError && (
                error.status === 409
                || String(error.message || "").includes("SOURCE_CHANGED_DURING_VALIDATION")
                || String((error.details as Row)?.code || "") === "SOURCE_CHANGED_DURING_VALIDATION"
            );
            if (!conflict) throw error;
        }
    }
    throw lastError;
}

/**
 * 参考真值写回源稿后立刻 prepare 目标段：让 prepare 事务把源稿参考直接投影进画布 Clip 的 referenceBindings，
 * 画布与制作台只读这一份，不再依赖读时派生/编译快照兜底。prepare 失败不吞：保留源稿改动，提示用户重编译。
 */
async function prepareSegmentReference(episodeId: string, segmentId: string): Promise<void> {
    const fresh = await fetchEpisodeProduction(episodeId as never);
    await prepareProductionTargets(episodeId as never, Number(fresh.production?.revision || 0), [`segment:${segmentId}`], `studio-ref-prepare-${nanoid()}`);
}

/** 段级音色覆写写回：voiceOverrides 走 update_h3_segment.patch（整张对象替换）；恢复自动用 patchDelete。 */
async function applyVoiceOverridePatch(truth: SegmentVoiceTruth, patch: Record<string, unknown>, patchDelete: string[] = []): Promise<void> {
    const projectRes = await fetchBackendProject(truth.canvasId);
    const project = ((projectRes as any).project || projectRes) as Row;
    await applyBackendCanvasOperations(truth.canvasId, [{
        type: "update_h3_segment", nodeId: truth.nodeId, segmentId: truth.canvasSegmentId,
        patch, ...(patchDelete.length ? { patchDelete } : {}),
    }], Number(project?.revision || truth.revision || 0));
}

/** duration_frames 一律按制作稿 fps_num/fps_den 换算（默认 24）；旧的 f>100 启发式会把 96 帧当成 96 秒，已废弃。 */
function framesToSec(frames: unknown, source?: Source): number {
    const f = Number(frames || 0);
    if (!Number.isFinite(f) || f <= 0) return 0;
    const fps = Number(source?.fps_num || 24) / Number(source?.fps_den || 1) || 24;
    return f / fps;
}

function sourceOf(production: EpisodeProduction | undefined): Source {
    const draft = (production?.draft || {}) as Record<string, unknown>;
    return ((draft.director as Record<string, unknown> | undefined)?.source as Source) || {};
}

/** 影策 lib/drama/storyboard.ts:56 的 TRANSITION_LABEL（分镜转场码 → 中文），
 *  剧本页 chip 用 `${label}进入` 展示；未收录的码回退显示原码，不编造。 */
const STORYBOARD_TRANSITION_LABEL: Record<string, string> = { cut: "硬切", fadeblack: "黑场过渡", fadewhite: "闪白" };

/** 镜头在全集里的真实编号（影策 storyboard.tsx:178 用 shot.position + 1）。
 *  本地真值是 source.shots[].story_order；缺失时回退到它在全量 shots 数组里的位置，
 *  绝不用「段内序号」冒充——同一段里的镜头可能是第 8、9 镜。 */
function shotDisplayNumber(source: Source, sh: Row): number {
    // 制作稿 story_order 是 **0 基**（第一镜 = 0），影策 storyboard.tsx:178 也按 `position + 1` 显示，
    // 所以这里必须 +1；之前直接把 story_order 当编号，会让第 2 镜起全部少 1，缺字段时还会两镜都显示 1。
    const order = Number(sh.story_order);
    if (Number.isFinite(order) && order >= 0) return order + 1;
    const list = rows(source.shots);
    const at = list.findIndex((item) => String(item.id || "") === String(sh.id || ""));
    return at >= 0 ? at + 1 : 1;
}

/** 影策剧本页数据：梗概、钩子、悬念、分镜规则，全部从真实制作稿/分集字段派生。 */
function scriptData(ep: StudioEpisode, source: Source) {
    const scenes = rows(source.script_scenes);
    const synopsis = String(ep.synopsis || "").trim();
    const hook = str(source.hook || source.opening_hook || source.lead_hook);
    const cliffhanger = str(source.cliffhanger || source.ending_hook || source.suspense);
    // 分镜规则：优先制作稿设置，其次用真实统计派生（不编造档位名）
    const settings = (source.settings || source.storyboard_rules || {}) as Row;
    const pacing = str(settings.pacing || settings.shot_pace);
    const dialogue = str(settings.dialogue_density);
    const segRange = str(settings.segment_range || settings.segment_duration);
    const transition = str(settings.transition);
    const shotCount = rows(source.shots).length;
    const totalSec = rows(source.shots).reduce((s, sh) => s + framesToSec(sh.duration_frames || sh.durationMs, source), 0);
    const ruleParts = [pacing, dialogue, segRange, transition].filter(Boolean);
    const rule = ruleParts.length ? ruleParts.join(" · ") : `标准节奏 · 对白标准 · 剧情段8–15秒 · 转场智能`;
    return { scenes, synopsis, hook, cliffhanger, rule, shotCount, totalSec: Math.round(totalSec) };
}

/**
 * 影策剧本页「按场次组织的镜头列表」数据，全部从真实制作稿 source 派生。
 * - 场次：按 shot.scene_id 分组，连续同 scene_id 合并为一场；场名取自 scene_registry。
 * - 镜头：编号 / 景别·运镜·时长 / 动作(shot.visual) / 台词(utterances.start.shotId 关联)。
 * - 说话人：speakerSubjectId → subject_registry.entityRef.id → character_registry.name，
 *   缺失时回退 speakerName / speakerSubjectId。
 */
type ScreenplayLine = ShotUtteranceLine;

/** 景别码→中文（canvas-agent 真实词表 EWS/WS/FS/MS/MCU/CU/ECU；对齐影策中文标签展示，码保留在 title）。 */
const FRAMING_LABEL: Record<string, string> = {
    EWS: "大远景", WS: "远景", FS: "全景", MS: "中景", MCU: "中近景", CU: "近景", ECU: "特写",
};
const framingLabel = (code: string) => FRAMING_LABEL[code.trim().toUpperCase()] || code;
type ScreenplayShot = {
    no: string; id: string; title: string; visual: string;
    framing: string; movement: string; sec: number; durationFrames: number; lines: ScreenplayLine[];
    /** 影策动作/起幅画面/转场：directorPatchFields.shot 已含 action/imagePrompt/transition，可写回。 */
    action?: string; imagePrompt?: string; transition?: string;
    /** 影策 script-view「有原文出处」：本镜对应的原文小句（shots[].sourceQuote 真值）。 */
    sourceQuote?: string;
};
type ScreenplayScene = { key: string; no: number; name: string; sec: number; shots: ScreenplayShot[] };

function screenplayData(source: Source): { scenes: ScreenplayScene[] } {
    const shots = rows(source.shots);
    const sceneName = new Map<string, string>();
    for (const sc of rows(source.scene_registry)) {
        if (str(sc.id)) sceneName.set(str(sc.id), str(sc.name || sc.heading || sc.title));
    }
    const speakerReg = speakerRegistryOf(source);
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1) || 24;
    const shotSec = (sh: Row) => Number(sh.duration_frames || sh.durationMs || 0) / fps;

    const scenes: ScreenplayScene[] = [];
    shots.forEach((sh, idx) => {
        const sceneId = str(sh.scene_id);
        const last = scenes[scenes.length - 1];
        let scene = last && last.key === sceneId ? last : null;
        if (!scene) {
            scene = {
                key: sceneId,
                no: scenes.length + 1,
                name: sceneName.get(sceneId) || sceneId || "未分场",
                sec: 0,
                shots: [],
            };
            scenes.push(scene);
        }
        const cam = (sh.camera || {}) as Row;
        const sec = shotSec(sh);
        const lines = utterancesOfShot(source, sh, speakerReg);
        scene.shots.push({
            no: String(idx + 1).padStart(2, "0"),
            id: str(sh.id),
            title: str(sh.title),
            visual: str(sh.visual),
            framing: str(cam.framing),
            // ShotCamera 只有 description（没有 movement）：先读真字段，再兼容历史/自由文本 movement。
            movement: str(cam.movement) || str(cam.description),
            sec,
            durationFrames: Number(sh.duration_frames || sh.durationMs || 0),
            action: str(sh.action),
            sourceQuote: str(sh.sourceQuote),
            imagePrompt: str(sh.imagePrompt),
            transition: str(sh.transition),
            lines,
        });
        scene.sec += sec;
    });
    return { scenes };
}

function ErrorBanner({ error, failed }: { error: string; failed: number }) {
    if (!error && !failed) return null;
    return (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300" data-studio-error-banner>
            <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="size-3.5 shrink-0" /> 本集遇到问题
                <span className="ml-auto font-normal opacity-70">{failed ? `${failed} 次失败 · ` : ""}可在底部队列「全部重试」</span>
            </div>
            {error ? <p className="mt-1 truncate opacity-80" title={error}>{error}</p> : null}
        </div>
    );
}

/** 景别下拉：canvas-agent 真实七档词表（code 写回，中文 label 仅展示）。 */
const SHOT_FRAMINGS: Array<{ code: string; label: string }> = [
    { code: "EWS", label: "大远景" }, { code: "WS", label: "远景" },
    { code: "FS", label: "全景" }, { code: "MS", label: "中景" },
    { code: "MCU", label: "中近景" }, { code: "CU", label: "近景" },
    { code: "ECU", label: "特写" },
];
const FRAMING_CODES = SHOT_FRAMINGS.map(f => f.code);

/** 转场下拉（照搬影策 lib/drama/storyboard TRANSITION_LABEL：cut/fadeblack/fadewhite）；空值表示不设转场，按硬切处理。 */
const SHOT_TRANSITIONS: Array<{ code: string; label: string }> = [
    { code: "", label: "硬切" },
    { code: "cut", label: "硬切" },
    { code: "fadeblack", label: "黑场过渡" },
    { code: "fadewhite", label: "闪白" },
];

type ShotDraft = { title: string; visual: string; framing: string; movement: string; seconds: string; action: string; imagePrompt: string; transition: string };
type ShotDialogueChange = { utteranceId?: string; text: string; speaker?: string };
function shotDraftOf(shot: ScreenplayShot): ShotDraft {
    return { title: shot.title, visual: shot.visual, framing: shot.framing, movement: shot.movement, seconds: shot.sec.toFixed(1), action: shot.action || "", imagePrompt: shot.imagePrompt || "", transition: shot.transition || "" };
}
const dialogueDraftOf = (shot: ScreenplayShot): ShotUtteranceLine[] =>
    shot.lines.length ? shot.lines.map(line => ({ ...line })) : [{ speaker: "", text: "" }];

/**
 * 影策式镜头内联编辑器：镜头字段来自真实 source.shots（title/visual/camera.framing/
 * camera.movement/duration_frames），台词/说话人来自 source.utterances（按 shot.utterance_refs 聚合）。
 * 镜头字段失焦写 patch_director_source；台词失焦写 update_shot_dialogue 真值 op。
 * 保存按钮把本轮全部改动一次写回。camera / performance 由后端深合并，未提交的子字段保留。
 * action/imagePrompt/transition 已进 directorPatchFields.shot allowlist，可直接 patch 写回；首镜无转场，transition 禁用。
 */
function ShotEditor({ shot, fps, busy, isFirst, onPatch, onDialogueSave, onDone }: {
    shot: ScreenplayShot; fps: number; busy: boolean; isFirst: boolean;
    onPatch: (patch: Record<string, unknown>) => void;
    onDialogueSave: (changes: ShotDialogueChange[]) => void; onDone: () => void;
}) {
    const [draft, setDraft] = useState<ShotDraft>(() => shotDraftOf(shot));
    const saved = useRef<ShotDraft>(shotDraftOf(shot));
    const [dialogueDraft, setDialogueDraft] = useState<ShotUtteranceLine[]>(() => dialogueDraftOf(shot));
    const savedDialogue = useRef<ShotUtteranceLine[]>(dialogueDraftOf(shot));
    // 保存后父组件刷新 source → shot.lines 更新；同步基线，避免下一次 flush 把旧值当成新改动重提。
    useEffect(() => {
        const incoming = dialogueDraftOf(shot);
        setDialogueDraft(incoming);
        savedDialogue.current = incoming;
    }, [shot.id, JSON.stringify(shot.lines)]);
    const change = (key: keyof ShotDraft) => (e: { target: { value: string } }) =>
        setDraft(d => ({ ...d, [key]: e.target.value }));

    const flush = () => {
        const base = saved.current;
        const patch: Record<string, unknown> = {};
        if (draft.title !== base.title) patch.title = draft.title;
        if (draft.visual !== base.visual) patch.visual = draft.visual;
        if (draft.action !== base.action) patch.action = draft.action;
        if (draft.imagePrompt !== base.imagePrompt) patch.imagePrompt = draft.imagePrompt;
        if (draft.transition !== base.transition) patch.transition = draft.transition;
        const sec = Number(draft.seconds);
        if (Number.isFinite(sec) && sec > 0 && Math.abs(sec - Number(base.seconds)) >= 0.05) {
            patch.duration_frames = Math.round(sec * fps);
        }
        const camera: Record<string, unknown> = {};
        if (draft.framing !== base.framing && FRAMING_CODES.includes(draft.framing)) camera.framing = draft.framing;
        if (draft.movement !== base.movement) camera.movement = draft.movement;
        if (Object.keys(camera).length) patch.camera = camera;
        if (!Object.keys(patch).length) return;
        saved.current = draft;
        onPatch(patch);
    };
    const flushDialogue = () => {
        const changes: ShotDialogueChange[] = [];
        dialogueDraft.forEach((line, i) => {
            const text = line.text.trim();
            if (!text) return; // 空行不下发，后端 schema 要求非空台词
            const base = savedDialogue.current[i];
            if (base && base.text === text && base.speaker === line.speaker) return;
            const speaker = line.speaker.trim();
            changes.push({
                ...(line.utteranceId ? { utteranceId: line.utteranceId } : {}),
                text,
                ...(speaker && (!base || base.speaker !== line.speaker) ? { speaker } : {}),
            });
        });
        if (!changes.length) return;
        savedDialogue.current = dialogueDraft.map(line => ({ ...line }));
        onDialogueSave(changes);
    };
    const enterBlur = (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

    return (
        <div className="space-y-2">
            {/* 影策 ShotEditor 字段顺序：台词/说话人 → 时长 → 景别/运镜/转场 → 动作 → 起幅画面 → 原文。 */}
            <div className="border-b border-border pb-2" data-studio-shot-dialogue>
                <div className="mb-1 flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-muted-foreground">台词</span>
                    <button type="button" onClick={() => setDialogueDraft(lines => [...lines, { speaker: "", text: "" }])}
                        style={{ fontSize: 12 }} className="h-7 rounded-[8px] border border-border px-2 font-medium text-muted-foreground transition hover:bg-muted/60">+ 添加一句</button>
                </div>
                <div className="space-y-1.5">
                    {dialogueDraft.map((line, i) => (
                        <div key={i} className="grid grid-cols-[84px_1fr] gap-1.5">
                            <input value={line.speaker} data-studio-shot-speaker={i} aria-label="说话人"
                                onChange={e => setDialogueDraft(lines => lines.map((x, j) => j === i ? { ...x, speaker: e.target.value } : x))}
                                onBlur={flushDialogue} onKeyDown={enterBlur}
                                style={{ fontSize: 13 }} className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none focus:border-primary"
                                placeholder="旁白" />
                            <textarea value={line.text} data-studio-shot-dialogue-text={i} rows={2} aria-label="台词"
                                title="Ctrl+Enter 保存"
                                onChange={e => setDialogueDraft(lines => lines.map((x, j) => j === i ? { ...x, text: e.target.value } : x))}
                                onBlur={flushDialogue}
                                onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.blur(); }}
                                style={{ fontSize: 13, lineHeight: "21px" }} className="resize-y rounded-[12px] border border-border bg-background px-3 py-[5.5px] outline-none focus:border-primary"
                                placeholder="无台词" />
                        </div>
                    ))}
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
                <label className="block" data-studio-shot-field="title">
                    <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">标题</span>
                    <input value={draft.title} onChange={change("title")} onBlur={flush} onKeyDown={enterBlur}
                        style={{ fontSize: 13 }} className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none focus:border-primary" placeholder="镜头标题" />
                </label>
                <label className="block" data-studio-shot-field="seconds">
                    <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">时长</span>
                    <span className="relative block">
                        <input type="number" min={1} max={60} step={0.5} value={draft.seconds} onChange={change("seconds")} onBlur={flush} onKeyDown={enterBlur}
                            aria-label="镜头时长"
                            style={{ fontSize: 13 }} className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 pr-7 outline-none focus:border-primary" />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">秒</span>
                    </span>
                </label>
            </div>
            {/* 影策 segment-dialog 的 景别/运镜/转场 三联动：directorPatchFields.shot 已含三字段，
                随 patch_director_source 真写回制作稿；首镜无转场，transition 禁用。 */}
            <div className="grid grid-cols-3 gap-2" data-studio-shot-extra>
                <label className="block" data-studio-shot-field="framing">
                    <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">景别</span>
                    <select value={draft.framing} onChange={change("framing")} onBlur={flush} aria-label="景别"
                        style={{ fontSize: 13 }} className="h-[34px] w-full rounded-[8px] border border-border bg-background px-[11px] outline-none focus:border-primary">
                        {!FRAMING_CODES.includes(draft.framing) ? <option value={draft.framing}>{draft.framing || "自动"}</option> : null}
                        {SHOT_FRAMINGS.map(f => <option key={f.code} value={f.code}>{f.label}</option>)}
                    </select>
                </label>
                <label className="block" data-studio-shot-field="movement">
                    <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">运镜</span>
                    <select value={draft.movement} onChange={change("movement")} onBlur={flush} aria-label="运镜"
                        style={{ fontSize: 13 }} className="h-[34px] w-full rounded-[8px] border border-border bg-background px-[11px] outline-none focus:border-primary">
                        <option value="">自动</option>
                        {/* 已存在的自由文本保留为可选项，不静默丢掉 shot.camera 里的旧值。 */}
                        {draft.movement && !CAMERAS.includes(draft.movement) ? <option value={draft.movement}>{draft.movement}</option> : null}
                        {CAMERAS.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                </label>
                <label className="block" data-studio-shot-field="transition" title={isFirst ? "首镜无转场" : undefined}>
                    <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">转场</span>
                    <select value={draft.transition} disabled={isFirst} onChange={change("transition")} onBlur={flush} aria-label="转场"
                        style={{ fontSize: 13 }} className="h-[34px] w-full rounded-[8px] border border-border bg-background px-[11px] outline-none focus:border-primary disabled:opacity-50">
                        <option value="">{isFirst ? "首镜无转场" : "硬切"}</option>
                        {draft.transition && !SHOT_TRANSITIONS.some(t => t.code === draft.transition) ? <option value={draft.transition}>{draft.transition}</option> : null}
                        {SHOT_TRANSITIONS.filter(t => t.code).map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
                    </select>
                </label>
            </div>
            <label className="block" data-studio-shot-field="visual">
                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">画面描述</span>
                <textarea value={draft.visual} onChange={change("visual")} onBlur={flush} rows={3}
                    style={{ fontSize: 13, lineHeight: "21px" }} className="w-full resize-y rounded-[12px] border border-border bg-background px-3 py-[5.5px] outline-none focus:border-primary" placeholder="这一镜的画面内容" />
            </label>
            <label className="block" data-studio-shot-field="action">
                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">动作</span>
                <textarea value={draft.action} onChange={change("action")} onBlur={flush} rows={2}
                    style={{ fontSize: 13, lineHeight: "21px" }} className="w-full resize-y rounded-[12px] border border-border bg-background px-3 py-[5.5px] outline-none focus:border-primary" />
            </label>
            <label className="block" data-studio-shot-field="imagePrompt">
                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">起幅画面</span>
                <textarea value={draft.imagePrompt} onChange={change("imagePrompt")} onBlur={flush} rows={2}
                    style={{ fontSize: 13, lineHeight: "21px" }} className="w-full resize-y rounded-[12px] border border-border bg-background px-3 py-[5.5px] outline-none focus:border-primary" />
            </label>
            {/* 影策 segment-dialog.tsx:841-848：编辑态最后一块是「原文」引用（shot.sourceQuote 真值），
                没有出处就不渲染。 */}
            {shot.sourceQuote ? (
                <div className="rounded-[12px] bg-foreground/[0.04] px-3 py-2" data-studio-shot-field="sourceQuote">
                    <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">原文</span>
                    <p style={{ fontSize: 12, lineHeight: "19px" }} className="whitespace-pre-wrap text-muted-foreground">「{shot.sourceQuote}」</p>
                </div>
            ) : null}
            {/* 影策 ShotEditor 里没有「保存/完成」按钮：失焦即保存，收起靠卡片头部的「编辑/收起」或再次点该镜头。 */}
        </div>
    );
}

function ScriptPanel({ ep, production, dramaId, onRescript, onChanged, busy, processJobs, onDiscussShot }: { ep: StudioEpisode; production: EpisodeProduction | undefined; dramaId?: string | null; onRescript: () => void; onChanged?: () => void; busy: boolean; processJobs?: ProcessJobView[]; onDiscussShot?: (shot: { title?: string; visual?: string; camera?: unknown; duration_seconds?: number; dialogues?: unknown }) => void }) {
    const { message, modal } = App.useApp();
    const [processOpen, setProcessOpen] = useState(false);
    // 原文栏显隐（影策 script-view.tsx:80,126-135 sourceOpen；纯 UI，不影响原文真值）。
    const [sourceOpen, setSourceOpen] = useState(true);
    const source = useMemo(() => sourceOf(production), [production]);
    const d = useMemo(() => scriptData(ep, source), [ep, source]);
    const sp = useMemo(() => screenplayData(source), [source]);
    // 素材类型：episode 真有 sourceFormat 才读（novel/script/storyboard），本地当前无此字段则回落小说原文。
    const sourceFormat = String((ep as unknown as Record<string, unknown>).sourceFormat || "");
    const formatInfo = SOURCE_FORMAT_LABEL[sourceFormat] || SOURCE_FORMAT_LABEL.novel;
    const [selectedShot, setSelectedShot] = useState<string | null>(null);
    const [savingShot, setSavingShot] = useState(false);
    // 编辑原文：按章编辑改 source_chapters.body（真值，改编链直接读）；剧目级 sourceScript 全文保留为可选补充入口。
    const [editSourceOpen, setEditSourceOpen] = useState(false);
    const [sourceDraft, setSourceDraft] = useState("");
    const [sourceUpdatedAt, setSourceUpdatedAt] = useState("");
    const [sourceSaving, setSourceSaving] = useState(false);
    // 按章编辑弹窗（对齐影策 SourceEditModal）：每章一行 body/title/sourceFormat，PATCH 带 revision 乐观锁。
    type EditableChapter = { id: string; no: number; title: string; body: string; sourceFormat: string; revision: number; dirty: boolean };
    const [chapterEditOpen, setChapterEditOpen] = useState(false);
    const [chapterRows, setChapterRows] = useState<EditableChapter[]>([]);
    const [chapterLoading, setChapterLoading] = useState(false);
    const [chapterSavingId, setChapterSavingId] = useState<string | null>(null);
    const [chapterSavingAll, setChapterSavingAll] = useState(false);
    const [rescriptAfterSave, setRescriptAfterSave] = useState(true);
    const [chapterEditTip, setChapterEditTip] = useState("");
    /** 保存成功后递增，强制重读本集章节：原文对照与重新改编都用新正文。 */
    const [chapterEditVersion, setChapterEditVersion] = useState(0);
    // 按章文件导入：与建集弹窗同一个隐藏 input，按点选/拖入的目标章行导入正文。
    const chapterFileInputRef = useRef<HTMLInputElement>(null);
    const chapterImportTarget = useRef<string | null>(null);
    // 原文对照 = 本集覆盖章节正文（真值，与 pipeline.runScript 同源）；老数据无章映射时回退剧目级 sourceScript 派生。
    const [chapterSource, setChapterSource] = useState("");
    const [sourceChapters, setSourceChapters] = useState<Array<{ no: number; title: string; body: string; id?: string; sourceFormat?: string }>>([]);
    /** 原文对照首次读取指示：初值 true，避免首帧「本集暂无原文」先把真实正文闪没。 */
    const [sourceLoading, setSourceLoading] = useState(true);
    const [activeChapter, setActiveChapter] = useState<number | null>(null);
    useEffect(() => {
        let alive = true;
        setSourceLoading(true);
        // 老数据兜底：剧目级 sourceScript 按章切分派生（真值仍是 chapters API，只有无章映射时才走这里）。
        const fallback = () => {
            if (!dramaId || !ep?.no) { setChapterSource(""); setSourceChapters([]); setSourceLoading(false); return; }
            void fetchDramaPlanningSource(dramaId).then((res) => {
                if (!alive) return;
                const source = String(res?.sourceScript || "");
                if (!source.trim()) { setChapterSource(""); setSourceChapters([]); return; }
                const { rows: chapterRows, groups } = splitSourceIntoEpisodes(source, {});
                const chapters = groups.map((g) => {
                    const raw = groupSynopsis(chapterRows, g, 400000);
                    const body = raw.split("\n").filter((line) => !/^\s*【章】/.test(line)).join("\n").trim();
                    return { no: g.episodeNumber, title: `第 ${g.episodeNumber} 章`, body };
                });
                setSourceChapters(chapters);
                const group = groups.find((g) => g.episodeNumber === ep.no);
                if (!group) { setChapterSource(""); setActiveChapter(null); return; }
                const mine = chapters.find((ch) => ch.no === ep.no);
                setActiveChapter(mine?.no ?? null);
                setChapterSource(mine?.body || "");
            }).catch(() => { if (alive) { setChapterSource(""); setSourceChapters([]); } })
                .finally(() => { if (alive) setSourceLoading(false); });
        };
        if (!ep?.id) { fallback(); return () => { alive = false; }; }
        void getEpisodeChapters(ep.id).then((res) => {
            if (!alive) return;
            const chapters = Array.isArray(res?.chapters) ? res.chapters : [];
            if (!chapters.length) { fallback(); return; }
            const rows = chapters.map((ch) => ({
                no: Number(ch.chapterIndex ?? 0),
                id: ch.id,
                title: String(ch.title || `第 ${ch.chapterIndex} 章`),
                body: String(ch.body || ""),
                sourceFormat: String(ch.sourceFormat || "novel"),
            }));
            setSourceChapters(rows);
            setActiveChapter(rows[0]?.no ?? null);
            setChapterSource(rows.map((r) => r.body).join("\n\n"));
            setSourceLoading(false);
        }).catch(() => { if (alive) fallback(); });
        return () => { alive = false; };
    }, [dramaId, ep?.id, ep?.no, sourceUpdatedAt, chapterEditVersion]);
    // 原文对照优先显示派生的章节原文；没有才回退分场正文（fullPlot）。绝不再用 synopsis（那是梗概）。
    const fullText = (activeChapter != null
        ? (sourceChapters.find((ch) => ch.no === activeChapter)?.body || "")
        : "") || (chapterSource || String(ep.fullPlot || "").trim());
    // 对白逐字核查：原文引号台词 vs 导演源稿台词（shot.utterance_refs → source.utterances，兼容老剧目 dialogues）。
    const dialogueSourceLines = useMemo(() => quotedSourceLines(fullText), [fullText]);
    const dialogueShotLines = useMemo(() => dialogueShotLinesOf(source), [source]);
    // 原文对照定位：点镜头时在其所在章节原文里尽力定位出处（台词逐字优先，其次画面描述）。
    const markRef = useRef<HTMLElement>(null);
    const { sourceHit, sourceHitLen } = useMemo(() => {
        if (!selectedShot || !fullText) return { sourceHit: -1, sourceHitLen: 0 };
        const shot = (source?.shots as Array<Record<string, unknown>> | undefined)?.find((s) => String(s.id) === selectedShot);
        if (!shot) return { sourceHit: -1, sourceHitLen: 0 };
        const lines = utterancesOfShot(source, shot);
        const candidates = [...lines.map(u => u.text), String(shot.visual || "")];
        const norm = (s: string) => s.replace(/[\s，。！？、；：""''「」『』（）()]/g, "");
        const nText = norm(fullText);
        for (const raw of candidates) {
            const key = norm(raw).slice(0, 12);
            if (key.length < 4) continue;
            const at = nText.indexOf(key);
            if (at < 0) continue;
            let seen = 0; let idx = 0;
            for (; idx < fullText.length && seen <= at; idx++) if (!/[\s，。！？、；：""''「」『』（）()]/.test(fullText[idx])) seen++;
            const start = Math.max(0, idx - 1);
            return { sourceHit: start, sourceHitLen: Math.min(key.length, fullText.length - start) };
        }
        return { sourceHit: -1, sourceHitLen: 0 };
    }, [selectedShot, fullText, source]);
    useEffect(() => { if (sourceHit >= 0) markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [sourceHit, activeChapter]);
    const openEditSource = async () => {
        if (!dramaId) { message.warning("请先选择剧目"); return; }
        try {
            const res = await fetchDramaPlanningSource(dramaId);
            setSourceDraft(String(res.sourceScript || ""));
            setSourceUpdatedAt(String(res.updatedAt || ""));
            setEditSourceOpen(true);
        } catch (error) { message.error(`读取原文失败：${error instanceof Error ? error.message : String(error)}`); }
    };
    const saveSource = async () => {
        if (!dramaId || sourceSaving) return;
        setSourceSaving(true);
        try {
            const res = await patchDramaPlanningSource(dramaId, sourceDraft, sourceUpdatedAt || undefined);
            if (!res.ok) throw new Error("保存失败");
            setSourceUpdatedAt(String(res.updatedAt || ""));
            setEditSourceOpen(false);
            message.success("原文已保存");
            onChanged?.();
        } catch (error) { message.error(`保存原文失败：${error instanceof Error ? error.message : String(error)}`); }
        finally { setSourceSaving(false); }
    };

    /** 按章编辑原文的文件导入：与建集弹窗同一解析口径，真写本地章草稿，随「保存本章/保存并重新改编」落库。 */
    const importChapterFile = async (file: File, rowId: string) => {
        try {
            const text = await parseSourceTextFile(file);
            const row = chapterRows.find((r) => r.id === rowId);
            setChapterRows((rows) => rows.map((r) => r.id === rowId ? { ...r, body: text, dirty: true } : r));
            message.success(`已将 ${file.name} 导入第 ${row?.no ?? ""} 章正文（${sourceCharCount(text).toLocaleString()} 字，去空白口径）`);
        } catch (error) {
            message.error(`导入失败：${(error as Error).message}`);
        }
    };

    /** 按章编辑：列本集覆盖章节，真值来自 GET /drama/episodes/:id/chapters（非剧目全文派生）。 */
    const openChapterEdit = async () => {
        if (!ep?.id) { message.warning("请先选中本集中的一集"); return; }
        setChapterLoading(true);
        try {
            const res = await getEpisodeChapters(ep.id);
            const rows: EditableChapter[] = (Array.isArray(res?.chapters) ? res.chapters : []).map((ch) => ({
                id: ch.id,
                no: Number(ch.chapterIndex ?? 0),
                title: String(ch.title || `第 ${ch.chapterIndex} 章`),
                body: String(ch.body || ""),
                sourceFormat: String(ch.sourceFormat || "novel"),
                revision: Number(ch.revision ?? 0),
                dirty: false,
            }));
            setChapterRows(rows);
            setRescriptAfterSave(true);
            setChapterEditTip(rows.length ? "" : "本集暂无章节原文；请先在设置页导入原文并完成分集，或改用右侧「全文」入口。");
            setChapterEditOpen(true);
        } catch (error) {
            message.error(`读取章节原文失败：${error instanceof Error ? error.message : String(error)}`);
        } finally { setChapterLoading(false); }
    };

    const patchChapterRow = async (row: EditableChapter): Promise<boolean> => {
        if (!row.body.trim()) { message.error(`第 ${row.no} 章正文不能为空`); return false; }
        const buildPatch = (revision: number) => ({
            body: row.body,
            title: row.title.trim() || `第 ${row.no} 章`,
            sourceFormat: (["novel", "script", "storyboard"].includes(row.sourceFormat) ? row.sourceFormat : "novel") as DramaSourceFormat,
            expectedRevision: revision,
        });
        setChapterSavingId(row.id);
        try {
            let res: Awaited<ReturnType<typeof patchChapter>>;
            try {
                res = await patchChapter(row.id, buildPatch(row.revision));
            } catch (error) {
                if (!(error instanceof BackendApiError) || error.status !== 409) throw error;
                // 409：回读单章拿最新 revision，保留本地草稿重试一次（真冲突仍由后端拦截并报错）。
                const fresh = await getChapter(row.id, dramaId || undefined);
                const freshRevision = Number(fresh?.chapter?.revision ?? 0);
                setChapterRows((rows) => rows.map((r) => r.id === row.id ? { ...r, revision: freshRevision } : r));
                setChapterEditTip("检测到其他窗口修改，已回读最新版本并重试保存本章正文");
                res = await patchChapter(row.id, buildPatch(freshRevision));
            }
            const server = res.chapter;
            setChapterRows((rows) => rows.map((r) => r.id === row.id ? {
                ...r,
                title: String(server?.title ?? r.title),
                body: String(server?.body ?? r.body),
                sourceFormat: String(server?.sourceFormat ?? r.sourceFormat),
                revision: Number(server?.revision ?? r.revision),
                dirty: false,
            } : r));
            if (res.message) setChapterEditTip(res.message);
            return true;
        } catch (error) {
            message.error(`第 ${row.no} 章保存失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally { setChapterSavingId(null); }
    };

    const saveChaptersAndClose = async () => {
        if (chapterSavingAll) return;
        const dirty = chapterRows.filter((r) => r.dirty);
        setChapterSavingAll(true);
        try {
            for (const row of dirty) {
                if (!await patchChapterRow(row)) return; // 单章失败留在弹窗里，不误报整体成功
            }
            setChapterEditOpen(false);
            setChapterEditVersion((v) => v + 1); // 触发原文对照重读，与改编链同一份真值
            onChanged?.();
            if (dirty.length && rescriptAfterSave) {
                message.success("原文已保存，正在按新原文重新改编");
                onRescript();
            } else {
                message.success(dirty.length ? "原文已保存，点「重新改编」后生效" : "原文未变化");
            }
        } finally { setChapterSavingAll(false); }
    };

    const shots = rows(source.shots);
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1) || 24;
    // 对齐影策 segmentSizes：按 source.segments[].shot_ids 统计每个镜头所属剧情段的镜头数；段内仅 1 镜时禁止删除。
    const segmentSizes = useMemo(() => {
        const sizes = new Map<string, number>();
        for (const seg of rows(source.segments)) {
            const ids = Array.isArray(seg.shot_ids) ? seg.shot_ids.map((id: unknown) => String(id)) : [];
            for (const id of ids) sizes.set(id, ids.length);
        }
        return sizes;
    }, [source]);

    /** 写回单镜头：commitProductionOps 读最新 revision 并做 409 回读重试，连续失焦多字段不丢写；camera 由后端深合并。 */
    const patchShot = async (shotId: string, patch: Record<string, unknown>) => {
        if (!ep?.id) return;
        setSavingShot(true);
        try {
            await commitProductionOps(ep.id as never, [{ type: "patch_director_source", entity: "shot", id: shotId, patch }]);
            message.success("镜头已保存，本段提示词与视频已标记为过期");
            onChanged?.();
        } catch (error) {
            message.error(`保存失败：${(error as Error).message}`);
        } finally {
            setSavingShot(false);
        }
    };

    /** 镜头级操作：insert_shot / delete_shot 经真实 production op 写回，成功后触发上层刷新。 */
    const submitShotOp = async (ops: ProductionOperation[], ok: string, keepOpen = false) => {
        if (!ep?.id) return;
        setSavingShot(true);
        try {
            await commitProductionOps(ep.id as never, ops);
            message.success(ok);
            if (!keepOpen) setSelectedShot(null);
            onChanged?.();
        } catch (error) {
            message.error(`操作失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSavingShot(false);
        }
    };
    const insertShot = (shotId: string, position: "before" | "after") =>
        void submitShotOp([{ type: "insert_shot", id: shotId, position }], position === "before" ? "已在前面插入镜头" : "已在后面插入镜头");
    const deleteShot = (shotId: string) => {
        const shot = (source?.shots as Array<Record<string, unknown>> | undefined)?.find(s => String(s.id) === shotId);
        const title = String(shot?.title || "该镜头").slice(0, 24);
        const lineCount = shot ? utterancesOfShot(source, shot).length : 0;
        const dialogue = lineCount ? `该镜头引用的 ${lineCount} 句台词会从镜头上移除。` : "";
        modal.confirm({
            title: `删除镜头「${title}」？`,
            // 影策 segment-dialog.tsx:538 的删除语义 + 本地真值（制作稿标记过期、写入 draft）。
            content: `${dialogue}删除后本段提示词与视频需要重新生成；本地制作稿会把本段标记为过期。此操作写入制作稿。`,
            okText: "删除镜头",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => submitShotOp([{ type: "delete_shot", id: shotId }], "镜头已删除，本段提示词与视频已标记为过期"),
        });
    };

    const confirmRescript = () => modal.confirm({
        title: `重新改编第 ${ep.no} 集？`,
        // 影策 script-view.tsx:101：已生成的段视频保留在版本记录中；本地真值补充制作稿段标记为过期。
        content: "会基于原文重新生成剧本、镜头与剧情段，各段提示词与视频都需要重新生成；已生成的段视频保留在版本记录中（本地制作稿会把相关段标记为过期）。",
        okText: "重新改编",
        cancelText: "取消",
        onOk: () => onRescript(),
    });

    return (
        <>
        <div className={cn("grid min-h-0 flex-1 gap-3 p-3", sourceOpen ? "grid-cols-[minmax(0,1fr)_minmax(300px,0.75fr)]" : "grid-cols-[minmax(0,1fr)]")} data-studio-panel="script">
            {/* 左：本集梗概 + 钩子/悬念 + 分镜规则 + 状态 */}
            <div className="min-w-0 space-y-3 overflow-y-auto pr-1">
                <ErrorBanner error={ep.error || ""} failed={ep.jobs.failed} />

                <section className="rounded-lg border border-border bg-card/60 p-4" data-studio-script-synopsis>
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold">
                        <BookOpen className="size-3.5 text-muted-foreground" /> 本集梗概
                        <Tooltip title={formatInfo.detail}>
                            <span className="cursor-help whitespace-nowrap font-normal text-muted-foreground" data-studio-source-format>素材：{formatInfo.title}</span>
                        </Tooltip>
                        <div className="ml-auto flex shrink-0 items-center gap-3 text-[11px] font-normal text-muted-foreground">
                            <button type="button" onClick={() => setProcessOpen(true)} disabled={!processJobs?.length} className="flex items-center gap-1 whitespace-nowrap transition hover:text-foreground disabled:opacity-50" data-studio-process-open>
                                <ScanSearch className={cn("size-3")} /> 改编过程
                            </button>
                            <button type="button" onClick={confirmRescript} disabled={busy} className="flex items-center gap-1 whitespace-nowrap transition hover:text-foreground disabled:opacity-50">
                                <Wand2 className="size-3" /> 重新改编
                            </button>
                            <Tooltip title={sourceOpen ? "收起原文" : "对照原文"}>
                                <button type="button" aria-pressed={sourceOpen} aria-label={sourceOpen ? "收起原文" : "对照原文"}
                                    onClick={() => setSourceOpen((open) => !open)}
                                    className="flex items-center gap-1 whitespace-nowrap transition hover:text-foreground" data-studio-source-toggle>
                                    {sourceOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
                                    <span>{sourceOpen ? "收起原文" : "对照原文"}</span>
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                    <p className="text-[13px] leading-6 text-foreground/90">
                        {d.synopsis || "尚无本集梗概。可在右侧编辑原文或改编过程生成。"}
                    </p>

                    {/* 影策 script-view.tsx:139-148：钩子/悬念卡常显，空值显示「—」 */}
                    <div className="mt-4 grid grid-cols-2 gap-2" data-studio-script-beats>
                        <div className="rounded-md border border-border bg-background/60 p-2.5">
                            <div className="mb-1 text-[11px] font-medium text-muted-foreground">开场钩子</div>
                            <div className="text-xs leading-5">{d.hook || "—"}</div>
                        </div>
                        <div className="rounded-md border border-border bg-background/60 p-2.5">
                            <div className="mb-1 text-[11px] font-medium text-muted-foreground">结尾悬念</div>
                            <div className="text-xs leading-5">{d.cliffhanger || "—"}</div>
                        </div>
                    </div>

                    {/* 对齐影策 script-view.tsx:149-155 的「标签 + 加粗规则 + 实际统计」三段式：
                        规则是这一行真正要读的内容，单独提亮加粗；实际统计维持辅助色，避免整行同色糊成一片。 */}
                    <div className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
                        <Clapperboard className="size-3 shrink-0 self-center" />
                        <span className="font-medium">分镜规则</span>
                        <b className="font-medium text-foreground/80">{d.rule}</b>
                        <span>· 实际 {d.shotCount} 镜 · {d.totalSec} 秒</span>
                    </div>
                </section>

                {/* 对白逐字核查（影策 script-view.tsx:271-308）：原文引号台词逐句核对镜头台词 */}
                <DialogueCheckNotice sourceLines={dialogueSourceLines} shotLines={dialogueShotLines} busy={busy} onRescript={confirmRescript} />

                {/* 按场次组织的镜头列表（对齐影策 ScriptView）：点镜头联动右侧原文定位 */}
                {sp.scenes.length ? (
                    <section className="rounded-lg border border-border bg-card/60 p-3" data-studio-script-screenplay>
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                            <Clapperboard className="size-3.5 text-muted-foreground" /> 镜头列表
                            <span className="font-normal text-muted-foreground">按场次组织 · 点选镜头定位原文并原地编辑</span>
                        </div>
                        <div className="space-y-2">
                            {sp.scenes.map((scene) => (
                                <div key={`${scene.key}-${scene.no}`} className="overflow-hidden rounded-md border border-border">
                                    <div className="flex items-center gap-2 bg-foreground/[0.03] px-2.5 py-1.5 text-[11px]">
                                        <span className="font-semibold">场 {scene.no}</span>
                                        <span className="min-w-0 truncate text-muted-foreground" title={scene.name}>/ {scene.name}</span>
                                        <span className="ml-auto shrink-0 font-normal text-muted-foreground">{scene.shots.length}镜 · {Math.round(scene.sec)}秒</span>
                                    </div>
                                    <div className="divide-y divide-border">
                                        {scene.shots.map((shot) => {
                                            const isSelected = selectedShot === shot.id;
                                            return (
                                                <div key={shot.id} className={cn(isSelected && "bg-foreground/[0.04] ring-1 ring-inset ring-foreground/15")}>
                                                    <div
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-current={isSelected}
                                                        onClick={() => setSelectedShot(prev => (prev === shot.id ? null : shot.id))}
                                                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedShot(prev => (prev === shot.id ? null : shot.id)); } }}
                                                        className="flex w-full cursor-pointer gap-2 px-2.5 py-2 text-left transition hover:bg-foreground/[0.03]"
                                                        data-studio-script-shot={shot.id}
                                                    >
                                                        <span className="mt-0.5 shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">{shot.no}</span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                                                {shot.framing ? <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-medium" title={shot.framing}>{framingLabel(shot.framing)}</span> : null}
                                                                {shot.movement ? <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5">{shot.movement}</span> : null}
                                                                <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 tabular-nums">{shot.sec.toFixed(1)}s</span>
                                                                {shot.transition && shot.transition !== "cut" ? <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5" title={shot.transition}>{STORYBOARD_TRANSITION_LABEL[shot.transition] ?? shot.transition}进入</span> : null}
                                                                {shot.sourceQuote ? <span className="inline-flex items-center gap-1 rounded bg-foreground/[0.06] px-1.5 py-0.5" title={shot.sourceQuote} data-studio-shot-source-quote><Quote className="size-3" />有原文出处</span> : null}
                                                                {shot.title ? <span className="min-w-0 truncate">{shot.title}</span> : null}
                                                            </span>
                                                            {/* 影策 script-view.tsx:230 优先展示 action（可拍到的动作/画面），本地无 action 时退回 visual；未选中只给两行，密度对齐影策。 */}
                                                            {(() => {
                                                                const body = shot.action || shot.visual;
                                                                if (!body) return null;
                                                                return <span title={body} className={cn("mt-1 block whitespace-pre-wrap text-[12px] leading-5 text-foreground/80", !isSelected && "line-clamp-1")}>{body}</span>;
                                                            })()}
                                                            {shot.lines.length ? (
                                                                <span className="mt-1 block space-y-0.5">
                                                                    {shot.lines.map((ln, li) => (
                                                                        <span key={li} className="block text-[12px] leading-5 text-foreground/80">
                                                                            <span className="font-semibold text-foreground/60">{ln.speaker}：</span>{ln.text}
                                                                        </span>
                                                                    ))}
                                                                </span>
                                                            ) : null}
                                                            {/* 影策 script-view.tsx:234：空镜头占位提示（原有字段派生，不新增假数据） */}
                                                            {!shot.visual && !shot.action && !shot.lines.length ? (
                                                                <span className="mt-1 block text-[11px] italic leading-5 text-muted-foreground/60">空镜头，点击填写动作或台词</span>
                                                            ) : null}
                                                        </span>
                                                        {!isSelected ? <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" /> : null}
                                                    </div>
                                                    {isSelected ? (
                                                        <div className="border-t border-border px-2.5 pb-2 pt-4" data-studio-shot-editor onClick={(e) => e.stopPropagation()}>
                                                            <ShotEditor
                                                                key={shot.id}
                                                                shot={shot}
                                                                fps={fps}
                                                                busy={savingShot}
                                                                isFirst={shots[0]?.id === shot.id}
                                                                onPatch={(patch) => void patchShot(shot.id, patch)}
                                                                onDialogueSave={(changes) => void submitShotOp(
                                                                    changes.map(change => ({
                                                                        type: "update_shot_dialogue" as const,
                                                                        shotId: shot.id,
                                                                        ...(change.utteranceId ? { utteranceId: change.utteranceId } : {}),
                                                                        text: change.text,
                                                                        ...(change.speaker ? { speaker: change.speaker } : {}),
                                                                    })),
                                                                    "台词已保存，本段提示词与视频已标记为过期",
                                                                    true,
                                                                )}
                                                                onDone={() => setSelectedShot(null)}
                                                            />
                                                            {/* 对齐影策 ScriptView：选中镜头展开后的 4 个操作中的 3 个（前插/后插/删除），写回真实 production op。 */}
                                                            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2" data-studio-shot-actions>
                                                                <button type="button" disabled={savingShot} onClick={() => insertShot(shot.id, "before")}
                                                                    className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50"
                                                                    data-studio-shot-insert-before>
                                                                    <ArrowUpToLine className="size-3" /> 在前面插入镜头
                                                                </button>
                                                                <button type="button" disabled={savingShot} onClick={() => insertShot(shot.id, "after")}
                                                                    className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50"
                                                                    data-studio-shot-insert-after>
                                                                    <ArrowDownToLine className="size-3" /> 在后面插入镜头
                                                                </button>
                                                                {onDiscussShot ? (
                                                                    <button type="button" onClick={() => onDiscussShot(shot as unknown as { title?: string; visual?: string; camera?: unknown; duration_seconds?: number; dialogues?: unknown })}
                                                                        className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted/60"
                                                                        data-studio-shot-discuss>
                                                                        <MessageCircle className="size-3" /> 跟导演讨论
                                                                    </button>
                                                                ) : null}
                                                                <Tooltip title={(segmentSizes.get(shot.id) || 0) <= 1 ? "这是本剧情段唯一的镜头，删除会改变分段；可以改写内容或重新改编本集" : ""}>
                                                                    <span>
                                                                        <button type="button" disabled={savingShot || (segmentSizes.get(shot.id) || 0) <= 1} onClick={() => deleteShot(shot.id)}
                                                                            className="flex h-6 items-center gap-1 rounded border border-rose-200 px-1.5 text-[10px] text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10"
                                                                            data-studio-shot-delete>
                                                                            <Trash2 className="size-3" /> 删除镜头
                                                                        </button>
                                                                    </span>
                                                                </Tooltip>
                                                            </div>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}

                {/* 影策 script-view.tsx:243-250：结构化整页空态，条件只看「是否真的没有镜头」，不再被空梗概误判。 */}
                {!sp.scenes.length ? (
                    <section className="flex flex-col items-center rounded-lg border border-border bg-card/40 px-4 py-10 text-center" data-studio-script-empty>
                        <div className="mb-3 flex size-14 items-center justify-center rounded-full border border-border"><Clapperboard className="size-6 text-muted-foreground/50" /></div>
                        <div className="text-sm font-medium">{ep.error ? "本集改编未完成" : "本集剧本尚未编写"}</div>
                        <p className="mt-1.5 max-w-xs text-[11px] leading-5 text-muted-foreground">
                            {ep.error ? "改编失败，原因见上方提示；可重新改编本集，或在底部队列重试。" : "改编完成后这里会按场次列出镜头与台词；右侧可以先读本集对应的小说原文。"}
                        </p>
                        <button type="button" onClick={confirmRescript} disabled={busy} className="mt-4 flex h-8 items-center gap-1.5 rounded-md bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-60">
                            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                            {busy ? "改编中…" : "重新改编本集"}
                        </button>
                    </section>
                ) : null}
            </div>

            {/* 右：原文对照（影策 sourceOpen：可收起整栏，不影响原文真值） */}
            {sourceOpen ? (
            <section className="flex min-h-0 flex-col rounded-lg border border-border bg-card/40" data-studio-script-source>
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium">
                    <BookOpen className="size-3.5 text-muted-foreground" /> 原文对照
                    <div className="ml-auto flex items-center gap-2">
                        <button type="button" onClick={() => void openChapterEdit()} className="text-[11px] font-medium text-muted-foreground transition hover:text-foreground" data-studio-chapter-edit-open>按章编辑</button>
                        <button type="button" onClick={() => void openEditSource()} className="text-[11px] font-normal text-muted-foreground/70 transition hover:text-foreground" data-studio-source-edit-full>全文</button>
                    </div>
                </div>
                {sourceChapters.length > 1 ? (
                    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5" role="tablist" aria-label="原文章节" data-studio-source-tabs>
                        {sourceChapters.map((ch) => (
                            <button key={ch.no} type="button" role="tab" aria-selected={activeChapter === ch.no} onClick={() => setActiveChapter(ch.no)}
                                className={cn("shrink-0 rounded px-2 py-0.5 text-[11px] transition", activeChapter === ch.no ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
                                {ch.title}
                                {/* 影策 script-view.tsx:351：章节 tab 带字数（从本文 body 派生，真值不是伪造字段） */}
                                <span className="ml-1 font-normal opacity-60">{ch.body.length.toLocaleString()} 字</span>
                            </button>
                        ))}
                    </div>
                ) : null}
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span>{activeChapter != null ? `第 ${activeChapter} 章` : `第 ${ep.no} 段`}</span><span>{fullText.length.toLocaleString()} 字</span>
                    {selectedShot ? <span className="ml-auto text-rose-500">已定位镜头 {selectedShot}</span> : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-studio-source-text aria-busy={sourceLoading}>
                    {fullText ? (
                        <p className="whitespace-pre-wrap text-[12px] leading-6 text-foreground/85">
                            {sourceHit >= 0 ? (
                                <>{fullText.slice(0, sourceHit)}<mark ref={markRef} className="rounded bg-amber-500/30 px-0.5 text-inherit">{fullText.slice(sourceHit, sourceHit + sourceHitLen)}</mark>{fullText.slice(sourceHit + sourceHitLen)}</>
                            ) : fullText}
                        </p>
                    ) : sourceLoading ? (
                        <div className="flex h-full items-center justify-center gap-2 text-center text-xs text-muted-foreground" role="status" data-studio-source-loading>
                            <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> 正在读取章节原文…
                        </div>
                    ) : (
                        <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
                            本集暂无原文。可在分集中文「原文」字段补充。
                        </div>
                    )}
                </div>
                <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
                    {selectedShot && fullText && sourceHit < 0 ? "当前镜头的出处不在这一章，可切换章节查看" : sourceHit >= 0 ? "已高亮当前镜头的原文出处" : "点选左侧镜头，自动定位对应原文"}
                </div>
            </section>
            ) : null}
            <Modal
                title="按章编辑原文"
                open={chapterEditOpen}
                data-studio-chapter-edit-modal
                onCancel={() => setChapterEditOpen(false)}
                onOk={() => void saveChaptersAndClose()}
                okText={rescriptAfterSave ? chapterCommitLabel(chapterRows[0]?.sourceFormat || sourceFormat) : "保存原文"}
                okButtonProps={{ disabled: chapterLoading || chapterSavingAll || !chapterRows.length }}
                confirmLoading={chapterSavingAll || chapterLoading}
                width={980}
                destroyOnClose
            >
                <p className="mb-2 text-xs text-muted-foreground">改的是本集各章的原文真值（source_chapters.body）；已写好的剧本保持不变，重新改编后才按新正文重写。每章可粘贴，也可「从文件导入」或把 TXT / Markdown 文件直接拖进正文框（TXT/MD/CSV/TSV，单文件 ≤2MB）。切换「素材类型」后，该章会显示对应的「怎么写」指引与示例占位，提交按钮也随之切换。</p>
                {chapterEditTip ? <p className="mb-2 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground" data-studio-chapter-edit-tip>{chapterEditTip}</p> : null}
                {chapterLoading ? <p className="py-6 text-center text-xs text-muted-foreground">读取章节原文…</p> : null}
                <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1" data-studio-chapter-edit-list>
                    {chapterRows.map((row) => (
                        <div key={row.id} className="rounded-md border border-border bg-background/40 p-2.5" data-studio-chapter-row={row.id}>
                            <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                                <span className="shrink-0 font-semibold">第 {row.no} 章</span>
                                <Input
                                    value={row.title}
                                    onChange={(e) => setChapterRows((rows) => rows.map((r) => r.id === row.id ? { ...r, title: e.target.value, dirty: true } : r))}
                                    maxLength={200}
                                    aria-label={`第 ${row.no} 章标题`}
                                    className="h-6 max-w-[240px] flex-1 text-[11px]"
                                />
                                <select
                                    value={row.sourceFormat}
                                    onChange={(e) => setChapterRows((rows) => rows.map((r) => r.id === row.id ? { ...r, sourceFormat: e.target.value, dirty: true } : r))}
                                    aria-label={`第 ${row.no} 章素材类型`}
                                    className="h-6 rounded border border-border bg-background px-1 text-[11px] text-foreground"
                                    data-studio-chapter-format={row.id}
                                >
                                    <option value="novel">小说原文</option>
                                    <option value="script">剧本</option>
                                    <option value="storyboard">分镜</option>
                                </select>
                                <span className="shrink-0 text-muted-foreground" data-studio-chapter-chars={row.id}>{sourceCharCount(row.body).toLocaleString()} 字</span>
                                <button
                                    type="button"
                                    onClick={() => { chapterImportTarget.current = row.id; chapterFileInputRef.current?.click(); }}
                                    title="从 TXT/Markdown/CSV/TSV 文件导入本章正文（≤2MB）"
                                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted/60"
                                    data-studio-chapter-import={row.id}
                                >
                                    <FileUp className="mr-0.5 inline size-3" />从文件导入
                                </button>
                                {row.dirty ? <span className="shrink-0 text-amber-500">未保存</span> : null}
                                <button
                                    type="button"
                                    disabled={Boolean(chapterSavingId) || !row.dirty}
                                    onClick={() => void patchChapterRow(row)}
                                    title="保存本章原文与素材类型；配合下方勾选可立即重新改编本集"
                                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-muted/60 disabled:opacity-40"
                                    data-studio-chapter-save={row.id}
                                >
                                    {chapterSavingId === row.id ? "保存中…" : chapterCommitLabel(row.sourceFormat)}
                                </button>
                            </div>
                            <div className="mb-1.5 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-[10px] leading-5 text-muted-foreground" data-studio-chapter-guide={row.id}>
                                <span className="font-semibold text-foreground/80">{formatTruthOf(row.sourceFormat).title}怎么写</span>
                                <ul className="ml-4 list-disc">
                                    {formatTruthOf(row.sourceFormat).guide.map((line) => <li key={line}>{line}</li>)}
                                </ul>
                            </div>
                            <Input.TextArea
                                value={row.body}
                                onChange={(e) => setChapterRows((rows) => rows.map((r) => r.id === row.id ? { ...r, body: e.target.value, dirty: true } : r))}
                                autoSize={{ minRows: 5, maxRows: 12 }}
                                placeholder={`${formatTruthOf(row.sourceFormat).placeholder}\n\n也可以把 TXT / Markdown 文件拖到这里。`}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) void importChapterFile(file, row.id); }}
                                aria-label={`第 ${row.no} 章正文`}
                                data-studio-chapter-body={row.id}
                            />
                        </div>
                    ))}
                    {!chapterRows.length && !chapterLoading ? <p className="py-6 text-center text-xs text-muted-foreground">本集没有可编辑的章节原文</p> : null}
                </div>
                <input ref={chapterFileInputRef} type="file" accept=".txt,.md,.markdown,.csv,.tsv,text/plain,text/markdown" className="hidden" data-studio-chapter-file
                    onChange={(e) => { const file = e.target.files?.[0]; const rowId = chapterImportTarget.current; e.target.value = ""; if (file && rowId) void importChapterFile(file, rowId); }} />
                <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
                    <Checkbox checked={rescriptAfterSave} onChange={(e) => setRescriptAfterSave(e.target.checked)} data-studio-chapter-rescript>
                        保存后重新改编本集
                    </Checkbox>
                    <span className="text-[10px] text-muted-foreground">影策口径：改章不重写已有剧本，勾选才按新正文重新改编。</span>
                </div>
            </Modal>
            <Modal
                title="全文编辑（剧目级原文）"
                open={editSourceOpen}
                onCancel={() => setEditSourceOpen(false)}
                onOk={() => void saveSource()}
                okText={sourceSaving ? "保存中…" : "保存"}
                confirmLoading={sourceSaving}
                width={840}
                destroyOnClose
            >
                <p className="mb-2 text-xs text-muted-foreground">可选入口：这里改的是剧目级原文真值（planning.sourceScript），会影响全剧分集；只改本集原文请用「按章编辑」。保存后重新改编本集会使用新原文。</p>
                <Input.TextArea
                    value={sourceDraft}
                    onChange={(e) => setSourceDraft(e.target.value)}
                    autoSize={{ minRows: 18, maxRows: 30 }}
                    aria-label="原文正文"
                />
                <p className="mt-1 text-right text-[11px] text-muted-foreground">{sourceDraft.length.toLocaleString()} 字</p>
            </Modal>
        </div>
        <Modal
            title="改编过程 · 任务记录"
            open={processOpen}
            onCancel={() => setProcessOpen(false)}
            footer={null}
            width={720}
            destroyOnClose
        >
            <p className="mb-3 text-xs text-muted-foreground">本集在全自动流水线中的真实任务记录（来自 pipeline jobs）。</p>
            <div className="space-y-2" data-studio-process-list>
                {(processJobs || []).map((j) => {
                    const statusLabel: Record<string, string> = { succeeded: "成功", running: "执行中", queued: "排队", failed: "失败", canceled: "已取消", blocked: "等待前置" };
                    const color = j.status === "succeeded" ? "text-emerald-500" : j.status === "failed" ? "text-rose-500" : j.status === "running" ? "text-sky-500" : "text-muted-foreground";
                    return (
                        <div key={j.id} className="flex items-start gap-3 rounded border border-border px-3 py-2 text-xs">
                            <span className={cn("w-20 shrink-0 font-medium", color)}>{statusLabel[j.status] || j.status}</span>
                            <span className="w-28 shrink-0 text-muted-foreground">{j.stage}</span>
                            <span className="min-w-0 flex-1">{j.error ? <span className="text-rose-400">{j.error}</span> : <span className="text-muted-foreground">第 {j.attempt} 次尝试</span>}</span>
                        </div>
                    );
                })}
                {!processJobs?.length && <p className="py-4 text-center text-xs text-muted-foreground">暂无任务记录</p>}
            </div>
        </Modal>
        </>
    );
}

/** 影策 dialogue_check.go 的前端等价：去引号/空白/标点后小写，用于逐字比对。 */
function dialogueKey(line: string): string {
    return String(line || "").replace(/[\s"'“”"'「」『』《》〈〉,，。.!！?？:：;；、\u2014\u2026\-]/g, "").toLowerCase();
}
/** 从小说原文提取引号台词，去重、过滤元指令（对齐影策 quotedLines）。 */
function quotedSourceLines(text: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const re = /[「『“"]([^「」『』“”"]{2,120})[」』”"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const line = m[1].trim();
        const key = dialogueKey(line);
        if (!key || seen.has(key)) continue;
        if (/第.章|本节|此处|如下|台词如下|旁白说明/.test(line)) continue;
        // 对齐影策 dialogue_check.go:72：不足 4 字且不带句读的引号多是专有名词/强调/拟声
        // （所谓的"天才"、"哐当"），不算台词，不参与逐字核查告警。
        if ([...key].length < 4 && !/[，。！？…!?,~～、；]/.test(line)) continue;
        seen.add(key);
        result.push(line);
    }
    return result;
}
/** 没在镜头台词里逐字出现的原文台词（镜头台词按顺序拼接，长句拆镜不算缺失）。 */
function missingDialogue(sourceLines: string[], shotLines: string[]): string[] {
    const all = shotLines.map(dialogueKey).join("");
    return sourceLines.filter(line => { const k = dialogueKey(line); return k && !all.includes(k); });
}
/** 对白逐字核查告警条：数据来自本集原文引号台词 + 镜头 dialogues（影策 script-view.tsx:271-308）。 */
function DialogueCheckNotice({ sourceLines, shotLines, busy, onRescript }: { sourceLines: string[]; shotLines: string[]; busy: boolean; onRescript: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const missing = useMemo(() => missingDialogue(sourceLines, shotLines), [sourceLines, shotLines]);
    if (!sourceLines.length) return null;
    if (!missing.length) {
        return <div className="flex items-center gap-2 rounded-md border border-border bg-foreground/[0.02] px-3 py-2 text-[11px] text-muted-foreground" data-studio-dialogue-check="ok">
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" /> 原文 {sourceLines.length} 句台词都已逐字保留在镜头对白里
        </div>;
    }
    const shown = expanded ? missing : missing.slice(0, 3);
    return <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px]" role="status" data-studio-dialogue-check="missing">
        <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0" />
            <strong>原文 {sourceLines.length} 句台词中 {missing.length} 句未逐字保留在镜头对白里</strong>
            <span className="flex-1" />
            <button type="button" disabled={busy} onClick={onRescript} className="rounded border border-amber-500/40 px-2 py-0.5 text-[10px] transition hover:bg-amber-500/10 disabled:opacity-50">重新改编</button>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">可能被删掉或改写了。可以点镜头直接改台词、插入镜头补上，或重新改编本集。</p>
        <ul className="mt-1 space-y-0.5">{shown.map((line, i) => <li key={i} className="text-amber-700 dark:text-amber-300">「{line}」</li>)}</ul>
        {missing.length > 3 ? <button type="button" onClick={() => setExpanded(v => !v)} className="mt-1 text-[10px] text-amber-600 underline-offset-2 hover:underline dark:text-amber-400">{expanded ? "收起" : `展开全部（显示前 3 句）`}</button> : null}
    </div>;
}

function formatSec(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** 影策分镜段卡片时长用小数秒（11.8s），非 m:ss。 */
function formatClipSec(sec: number): string {
    return `${Math.max(0, Number(sec) || 0).toFixed(1)}s`;
}

/** 段封面静帧：首帧解码前用真实 video 事件（loadeddata/canplay）驱动 shimmer，不用定时器假装；换片源按 url 隔离状态。 */
function SegmentCoverVideo({ url }: { url: string }) {
    const [media, setMedia] = useState<{ url: string; decoded: boolean; failed: boolean }>({ url, decoded: false, failed: false });
    const view = media.url === url ? media : { url, decoded: false, failed: false };
    return (
        <>
            <video key={url} src={`${url}#t=0.1`} muted playsInline preload="metadata" className="pointer-events-none size-full object-cover"
                onLoadedData={() => setMedia({ url, decoded: true, failed: false })}
                onCanPlay={() => setMedia({ url, decoded: true, failed: false })}
                onError={() => setMedia({ url, decoded: false, failed: true })}
                data-studio-segment-video />
            {!view.decoded && !view.failed ? (
                <span className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-r from-muted/20 via-muted/50 to-muted/20" role="status" data-studio-cover-shimmer />
            ) : null}
            {view.failed ? (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-muted/40 text-[9px] text-muted-foreground" data-studio-cover-error>封面加载失败</span>
            ) : null}
        </>
    );
}

/** 影策「分镜/board」页数据：统计条 + 剧情段卡片 + 参考图，全部从真实制作稿派生。 */
/** 段卡片镜头预览：画面描述与台词分成两栏真值。
 *  影策 storyboard.tsx:163-172 单镜卡片是「画面描述一行 + 台词一行」，不是二选一；
 *  之前只有台词时把画面描述吞掉了，卡片就只剩台词。 */
function shotPreview(source: Source, sh: Row): { speaker: string; text: string; action: string; dialogue: string } {
    const first = utterancesOfShot(source, sh)[0];
    const dialogue = String(first?.text || "").trim();
    const speaker = dialogue ? String(first?.speaker || "旁白") : "";
    const action = str(sh.visual || sh.action || sh.imagePrompt || "");
    return {
        speaker,
        text: dialogue || action || "未描述画面",
        action: action || "未描述画面",
        dialogue,
    };
}

/** 把制作稿 draft 投影成段卡片数据（含后端 segment.state 真值接线）；导出供 gap C 契约测试直接验证。 */
/** 卡片徽标的紧凑文案（影策 .drama-sg-status 只有 2-4 个字）：去掉「视频」前缀与括号原因，完整文案留在 Tooltip。 */
export function compactStateLabel(label: string) {
    return label.replace(/（[^）]*）/g, "").replace(/^视频/, "").trim() || label;
}

/** 影策 .drama-sg-actions 的按钮文案状态机：等上一段 / 生成中 / 重新生成 / 生成。 */
export function segmentGenerateLabel(tone: string) {
    if (tone === "busy") return "生成中…";
    if (tone === "blocked") return "等上一段";
    if (tone === "ready" || tone === "stale") return "重新生成";
    return "生成";
}

export function boardData(production: EpisodeProduction | undefined, clipMedia: readonly StudioClipMedia[] = [], clipFailureByTarget: Readonly<Record<string, string>> = {}, assetNames: Readonly<Record<string, string>> = {}) {
    const draft = (production?.draft || {}) as Record<string, unknown>;
    const director = (draft.director || {}) as Record<string, unknown>;
    const source = (director.source || {}) as Source;
    const shots = rows(source.shots);
    const segments = rows(source.segments);
    const artifacts = rows(director.artifacts);
    const h3ByTarget = new Map<string, Row>();
    for (const a of artifacts) if (str(a.kind) === "h3" && str(a.targetId)) h3ByTarget.set(str(a.targetId), a);
    // 段卡片视频主视觉：clipMedia.targetId 是画布 H3 段的 draft 段 id（segId），按它关联真实产物。
    // 没匹配到就不填 URL——卡片显示占位，不拿别段视频冒充。
    const clipByTarget = new Map<string, StudioClipMedia>();
    for (const clip of clipMedia) if (clip.targetId && !clipByTarget.has(clip.targetId)) clipByTarget.set(clip.targetId, clip);
    const shotById = new Map<string, Row>();
    for (const sh of shots) if (str(sh.id)) shotById.set(str(sh.id), sh);
    const sceneName = new Map<string, string>();
    for (const sc of rows(source.scene_registry)) if (str(sc.id)) sceneName.set(str(sc.id), str(sc.name || sc.heading || sc.title));
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1) || 24;
    const shotSec = (sh: Row) => framesToSec(sh.duration_frames || sh.durationMs, source);
    const totalSec = shots.reduce((s, sh) => s + shotSec(sh), 0);

    const cards = segments.map((seg, idx) => {
        const segId = str(seg.id);
        const ids = (Array.isArray(seg.shot_ids) ? seg.shot_ids : []).map(str).filter(Boolean);
        const segShots = ids.map(id => shotById.get(id)).filter(Boolean) as Row[];
        const shotsList = segShots.length ? segShots : shots.filter(sh => str(sh.segment_id) === segId);
        const sec = shotsList.reduce((s, sh) => s + shotSec(sh), 0);
        const art = h3ByTarget.get(segId);
        const clip = clipByTarget.get(segId);
        const clipKey = str(clip?.storageKey);
        // 只有本段真实 video: 产物才给 URL；其余段保持空串走占位分支。
        const videoUrl = clip && clipKey.startsWith("video:") ? backendMediaUrl(clipKey) : "";
        const videoInputOutdated = Boolean(clip?.inputOutdated);
        const videoStatus = str(clip?.status);
        // 画布 H3 节点级失败原因是本地真值，命名与 state.videoError 区分开，避免两处失败原因混淆。
        const clipError = str(clip?.errorDetails).trim() || str(clipFailureByTarget[segId]).trim();
        const videoDuration = Number(clip?.duration || 0) || sec;
        // 创作真值优先取画布段（clip.prompt/referenceBindings），artifact 只是过时的编译快照，作兜底。
        const prompt = str(clip?.prompt || "") || str(art?.prompt || "");
        const canvasRefs = Array.isArray(clip?.referenceBindings) ? clip!.referenceBindings! : [];
        const refs = canvasRefs.length ? rows(canvasRefs) : rows(art?.references);
        // 后端派生真值：draft segment.state 挂 promptStatus/wait/upstream/references；无 state 时全部缺省，不编造。
        const segState = seg.state && typeof seg.state === "object" && !Array.isArray(seg.state) ? seg.state as StudioSegmentState : undefined;
        const stateRefs: StudioSegmentState["references"] = Array.isArray(segState?.references) ? segState!.references! : [];
        const thumbnails = refs.map((r, ri) => {
            const rawLabel = str(r.label);
            // 编号以编译器提交序号为唯一真值；没有编译结果时才退回 label/下标（旧数据兜底）。
            const compiledOrdinal = Number(clip?.submissionOrdinals?.[str(r.id)]);
            const ordinal = (Number.isFinite(compiledOrdinal) && compiledOrdinal > 0 ? compiledOrdinal : 0)
                || referenceOrdinalOf(rawLabel) || ri + 1;
            const storageKey = str(r.storageKey);
            const assetId = str(r.assetId);
            const nodeId = str(r.nodeId || r.sourceNodeId);
            // 按标号/文案把 state.references 的 sent/missingReason 对齐到同一张参考图；匹配不到就不带真值。
            const stateRef = stateRefs.find(sr => referenceOrdinalOf(sr?.label) > 0 && referenceOrdinalOf(sr?.label) === ordinal)
                || stateRefs.find(sr => str(sr?.label) === rawLabel);
            return {
                label: ordinal > 0 ? `图 ${ordinal}` : rawLabel.replace(/[<>]/g, "").trim() || "参考图",
                storageKey,
                url: storageKey ? backendMediaUrl(storageKey) : str(r.url),
                role: str(r.role),
                name: str(r.name || "") || resolveAssetName(assetId || nodeId, assetNames),
                assetId,
                nodeId,
                source: referenceSourceLabel({ assetId, nodeId, storageKey }),
                ordinal,
                roleKind: referenceKindOf(`${rawLabel} ${str(r.role)} ${str(r.name || "")}`),
                sent: stateRef?.sent,
                missingReason: str(stateRef?.missingReason),
            };
        });
        // 视频真值只认画布 H3 段上真实关联到的 video: 产物（clip.storageKey → videoUrl）。
        // 编译回执 art.receipt 只证明「提示词编译过」，不代表这段出过片——之前拿它兜底，
        // 分镜重建后段 id 变了、媒体关联丢了，卡片却仍写「视频已生成」，点开却没有视频。
        const hasVideo = Boolean(videoUrl);
        // 影策优先级真值来自 segment.state；画布 H3 段 status/errorDetails/inputOutdated 仍是本地真实字段，一并传入。
        // 画布段已成为创作真值（prompt/refs 优先取画布）：当画布段确有提示词且生成成功时，
        // artifact 的 stale 只是过时编译快照，不该再显示「提示词已过期」；仅画布无提示词时才沿用 artifact 状态派生。
        const canvasHasPrompt = Boolean(clip?.prompt && str(clip!.prompt).trim());
        const canvasOk = canvasHasPrompt && ["success", "ready", "succeeded"].includes(videoStatus);
        const effectivePromptStatus = canvasOk ? undefined : segState?.promptStatus;
        const state = segmentCardState({
            prompt, artStatus: canvasOk ? "ready" : str(art?.status), videoStatus, inputOutdated: videoInputOutdated, hasVideo, errorDetails: clipError,
            promptStatus: effectivePromptStatus,
            promptError: segState?.promptError,
            waitReason: segState?.waitReason,
            upstreamStage: segState?.upstreamStage,
            references: stateRefs,
            custom: segState?.custom,
            videoReprocessable: segState?.videoReprocessable,
            // state 新字段有真值时优先于画布段 status；失败原因保留两条真值来源，互不覆盖。
            stateVideoStatus: segState?.videoStatus,
            videoError: segState?.videoError,
            request: segState?.request,
        });
        // 说明：影策段卡 footer 左侧的「H3 展开流」不是入口，而是**模型显示名**（storyboard.tsx:197-200
        // 的 .drama-sg-model 显示 segment.videoModel.label；本地默认模型名就是 engine-local::H3 展开流）。
        // 影策没有额外的「逐镜明细」入口，本地也不做（别的入口只会和段弹窗重复）。
        const first = shotsList[0];
        const scene = sceneName.get(str(first?.scene_id)) || "";
        const shotTitle = str(first?.title || "");
        const title = [scene, shotTitle].filter(Boolean).join(" / ") || str(seg.summary || seg.title || `第 ${idx + 1} 段`);
        // 尾帧参考真值来自画布上一段 Clip：上一段开了 tailFrameContinuation，本段首帧就是它截下的尾帧图片。
        // 影策 storyboard/segment-parts 的「首帧」格即此语义；本地不再按剧目设置推断，直接读画布。
        const prevSeg = idx > 0 ? segments[idx - 1] : undefined;
        const prevClip = prevSeg ? clipByTarget.get(str(prevSeg.id)) : undefined;
        const tailFromPrev = prevClip?.tailFrameContinuation === true;
        const tailAnchorKey = tailFromPrev ? str(prevClip?.tailFrameAnchorKey) : "";
        const firstFrame = tailFromPrev ? {
            fromSegment: idx,
            storageKey: tailAnchorKey,
            url: tailAnchorKey ? backendMediaUrl(tailAnchorKey) : "",
        } : undefined;
        return {
            id: segId, index: idx, title,
            // 模式标签以画布段真实 taskMode 为准：拆镜/绑定会更新画布段，source.segment.mode 可能过时（T2VA）。
            prompt, mode: str(clip?.taskMode || seg.mode || ""), shots: shotsList, sec, thumbnails, hasVideo,
            firstShot: first, state,
            // 段卡片视频封面（影策 SegmentVideo 对齐）：无匹配 clipMedia 时 videoUrl 为空，走占位。
            videoUrl, videoInputOutdated, videoStatus, videoDuration,
            firstFrame,
            tailFrameContinuation: clip?.tailFrameContinuation === true,
        };
    });
    const promptReady = cards.filter(c => c.prompt).length;
    const videoReady = cards.filter(c => c.hasVideo).length;
    return { shots, segments, cards, totalSec, promptReady, videoReady, fps };
}

function ShotsPanel({ ep, production, clipMedia, clipFailureByTarget, dramaId, assetNames, onRescript, onOpenCanvas, onSwitchToScript, onWriteSegmentPrompt, onSaveSegmentPrompt, onApproveVideo, onSwitchToAssets, onListSegmentVersions, onSetSegmentCurrentVideo, onListSegmentVideoModels, onSetSegmentVideoModel, onChanged, busy, paused, onAutoResume, onDiscussShot }: {
    ep: StudioEpisode; production: EpisodeProduction | undefined; clipMedia: StudioClipMedia[]; clipFailureByTarget?: Readonly<Record<string, string>>; dramaId?: string | null;
    /** 资产真名表：参考图绑定缺 name 时用它兜底显示「角色 参考图 2 · 崇良」。 */
    assetNames?: Readonly<Record<string, string>>;
    onRescript: () => void; onOpenCanvas: (segmentId?: string) => void; onSwitchToScript: () => void; busy: boolean;
    /** 流水线暂停真值：暂停不是硬闸门——点生成会先自动恢复制作（影策暂停横幅同语义）。 */
    paused?: boolean;
    /** 把全局暂停转回运行（点生成/重试时调用）。 */
    onAutoResume?: () => Promise<void>;
    onWriteSegmentPrompt?: (segmentId: string) => Promise<{ text: string; warnings: string[] }>;
    onSaveSegmentPrompt?: (segmentId: string, text: string) => Promise<void>;
    onApproveVideo?: () => Promise<{ ok: boolean; missing: string[]; assetCount: number }>;
    onSwitchToAssets?: () => void;
    onListSegmentVersions?: (segmentId: string) => Promise<StudioSegmentVersion[]>;
    onSetSegmentCurrentVideo?: (segmentId: string, version: StudioSegmentVersion) => Promise<void>;
    onListSegmentVideoModels?: () => Promise<Record<string, string>>;
    onSetSegmentVideoModel?: (segmentId: string, model: string) => Promise<void>;
    onChanged?: () => void;
    /** 段弹窗「本段镜头 · 与小影讨论」：复用剧本页同一个讨论入口。 */
    onDiscussShot?: (shot: { title?: string; visual?: string; camera?: unknown; duration_seconds?: number; dialogues?: unknown }) => void;
}) {
    const { message, modal } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const videoModelOptions = useMemo(() => selectableModelsByCapability(config, "video"), [config]);
    const modelLabel = (value: string) => modelOptionLabel(config, value || config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL).replace(/（[^）]*）$/, "");
    // 生成控制条只读剧目级设置真值（段级模型另取 segmentVideoModels），不伪造段级参数。
    const studioGenSettings = useMemo(() => loadStudioSettings(dramaId ?? null), [dramaId]);
    const { cards, shots, segments, totalSec, promptReady, videoReady, fps } = useMemo(() => boardData(production, clipMedia, clipFailureByTarget, assetNames), [production, clipMedia, clipFailureByTarget, assetNames]);
    const [active, setActive] = useState<string | null>(cards[0] ? cards[0].id : null);
    const [matrix, setMatrix] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [writingPrompt, setWritingPrompt] = useState<string | null>(null);
    const [batchWriting, setBatchWriting] = useState(false);
    const [approving, setApproving] = useState(false);
    const [promptResult, setPromptResult] = useState<{ text: string; warnings: string[] } | null>(null);
    // 生成前只读体检：结果只在本组件展示，不回写制作稿/画布，也不触发任何生成任务。
    const [prerunReport, setPrerunReport] = useState<VideoPrerunReport | null>(null);
    const [prerunning, setPrerunning] = useState(false);
    // 影策「段编辑弹窗」：点「打开剧情段」进这里，不再只跳画布
    const [editIdx, setEditIdx] = useState<number | null>(null);
    const [editPrompt, setEditPrompt] = useState("");
    // 影策 segment-dialog.tsx:747 同口径：失焦或 ⌘↵ 自动保存，Esc 放弃，切段/关闭不再拦一次确认。
    // 基线在开段 / 保存成功 / 恢复模型版时重置。
    const [promptBaseline, setPromptBaseline] = useState("");
    const [savingPrompt, setSavingPrompt] = useState(false);
    const promptDirty = editIdx !== null && editPrompt.trim() !== promptBaseline.trim();
    const editingCard = editIdx !== null ? cards[editIdx] : undefined;
    // 影策 referenceUsage 的本地对齐：正文 <Picture N> 必须落在本段 thumbnails[].ordinal 内，非法则红字提示并禁止保存。
    const promptRefUsage = pictureReferenceUsage(editPrompt, editingCard ? editingCard.thumbnails.map(t => t.ordinal) : []);
    const promptRefInvalid = promptRefUsage.unknown.length > 0;
    // 影策 SegmentPrompt 的 unmentioned：正文已写但没引用到的本段参考图（真值=thumbnails.ordinal）。
    const promptUnmentioned = editingCard && editPrompt.trim()
        ? editingCard.thumbnails.filter((t, i) => !promptRefUsage.used.has(Number(t.ordinal) || i + 1))
        : [];
    // 字数只做统计显示 + 本地软提醒；本地无模型字数上限真值，不据此禁止保存（见 promptCharStats 注释）。
    const { sentChars, overSoftLimit } = promptCharStats(editPrompt);
    // 影策段视频版本：所有 Hooks 必须在下面「还没有分镜」的早退之前声明。
    const [segmentVersions, setSegmentVersions] = useState<StudioSegmentVersion[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [versionsError, setVersionsError] = useState("");
    const [versionReload, setVersionReload] = useState(0);
    const [previewVersion, setPreviewVersion] = useState<StudioSegmentVersion | null>(null);
    const [versionsExpanded, setVersionsExpanded] = useState(false);
    const [settingVersionId, setSettingVersionId] = useState<string | null>(null);
    /**
     * 本次生成依据回执（影策 SegmentReceipt 的后端聚合版）：按段缓存，展开折叠区时才请求。
     * 只读 clip_workbench 的 runtime.directorArtifacts / context.resolvedSubjects，不改制作稿也不触发生成。
     */
    const [segmentReceipts, setSegmentReceipts] = useState<Record<string, { loading: boolean; error: string; workbench: Record<string, any> | null }>>({});
    const loadSegmentReceipt = (segmentId: string) => {
        const cached = segmentReceipts[segmentId];
        if (cached && (cached.loading || cached.workbench)) return;
        setSegmentReceipts(prev => ({ ...prev, [segmentId]: { loading: true, error: "", workbench: null } }));
        // includeContext/includeRuntime：默认投影会裁掉 artifacts 与 resolvedSubjects，这里只读显式索取。
        fetchProductionWorkbench(ep.id, "clip_workbench", segmentId, "draft", { includeContext: true, includeRuntime: true })
            .then((res) => {
                const workbench = (res.production?.workbench || res.production?.clipWorkbench) as Record<string, any> | undefined;
                setSegmentReceipts(prev => ({ ...prev, [segmentId]: workbench
                    ? { loading: false, error: "", workbench }
                    : { loading: false, error: "后端未返回 clip_workbench 回执", workbench: null } }));
            })
            .catch((error: unknown) => {
                setSegmentReceipts(prev => ({ ...prev, [segmentId]: { loading: false, error: (error as Error)?.message || "读取本次生成依据失败", workbench: null } }));
            });
    };
    // 用 ref 取回调，避免父组件每次渲染的新箭头函数触发 effect 重跑（无限请求）。
    const versionsLoaderRef = useRef(onListSegmentVersions);
    versionsLoaderRef.current = onListSegmentVersions;
    const editingSegmentId = editIdx !== null ? cards[editIdx]?.id : undefined;
    useEffect(() => {
        if (!editingSegmentId) { setSegmentVersions([]); setVersionsError(""); return; }
        let cancelled = false;
        setVersionsLoading(true);
        setVersionsError("");
        Promise.resolve(versionsLoaderRef.current?.(editingSegmentId) ?? [])
            .then((rows) => { if (!cancelled) setSegmentVersions(rows); })
            .catch((error: unknown) => {
                if (!cancelled) { setSegmentVersions([]); setVersionsError((error as Error)?.message || "读取生成历史失败"); }
            })
            .finally(() => { if (!cancelled) setVersionsLoading(false); });
        return () => { cancelled = true; };
    }, [editingSegmentId, versionReload]);
    // 段视频模型映射：制作稿 draft 不存这个字段，真值在画布 H3 Clip，需定向读一次。
    const [segmentVideoModels, setSegmentVideoModels] = useState<Record<string, string>>({});
    /** 段模型映射读取态：初值 true，回包前不把默认模型当作本段真值展示。 */
    const [modelsLoading, setModelsLoading] = useState(true);
    const [modelReload, setModelReload] = useState(0);
    const [changingModel, setChangingModel] = useState<string | null>(null);
    // 影策批量出片：批选工具栏选视频模型 + 真提交 h3-run 的进度。
    const [batchVideoModel, setBatchVideoModel] = useState("");
    const [batchGenerating, setBatchGenerating] = useState(false);
    const modelsLoaderRef = useRef(onListSegmentVideoModels);
    modelsLoaderRef.current = onListSegmentVideoModels;
    useEffect(() => {
        let cancelled = false;
        setModelsLoading(true);
        Promise.resolve(modelsLoaderRef.current?.() ?? {})
            .then((map) => { if (!cancelled) setSegmentVideoModels(map); })
            .catch(() => { if (!cancelled) setSegmentVideoModels({}); })
            .finally(() => { if (!cancelled) setModelsLoading(false); });
        return () => { cancelled = true; };
    }, [ep.id, production?.revision, modelReload]);
    // 提示词硬上限真值：与本段实际出片模型同源（画布段 selectedVideoModel → 全局配置 → 默认模型），
    // 与下方 generateAudio 走同一条 modelVideoCapabilitiesOf 链。D 路 promptMaxChars 未落地时读不到
    // 真值 → promptMaxChars=null → 不拦截保存，保留软上限提示；字段落地后自动按真值硬校验。
    const editingSegModel = editingCard ? (segmentVideoModels[editingCard.id] || config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL)
        : (config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL);
    const promptMaxChars = modelPromptMaxChars(modelVideoCapabilitiesOf(config, editingSegModel));
    // 影策生成控制条「模型单次最长 N 秒」真值：与本段出片模型同源的能力字段，无声明则 null。
    const editingSegMaxSeconds = modelMaxVideoSeconds(modelVideoCapabilitiesOf(config, editingSegModel));
    const overModelLimit = isPromptOverModelLimit(editPrompt, promptMaxChars);
    const handleChangeVideoModel = async (segmentId: string, model: string) => {
        if (!onSetSegmentVideoModel) return void message.warning("模型切换入口尚未就绪");
        setChangingModel(segmentId);
        try {
            await onSetSegmentVideoModel(segmentId, model);
            message.success(`本段出片模型已切换为「${modelLabel(model)}」`);
            setModelReload((n) => n + 1);
            onChanged?.();
        } catch (error) {
            message.error(`切换失败：${(error as Error).message}`);
        } finally { setChangingModel(null); }
    };
    // 影策 generatable：提示词已就绪且不在生成中的段才提交，其余跳过并计数（busy 真值与段卡共用模块级集合）。
    const toGenerate = cards.filter((c) => selected.has(c.id) && Boolean(c.prompt) && !BUSY_VIDEO_STATUSES.has(String(c.videoStatus || "").toLowerCase()));
    const batchSkipped = selected.size - toGenerate.length;
    const prerunBannerView = prerunReport ? prerunBanner(prerunReport.failed, prerunReport.warnings, prerunReport.total) : null;
    /** 影策「体检」：批量生成前只读检查每段参考图/提示词/时长，绝不创建任务、不写库、不扣费。 */
    const handlePrerun = async () => {
        if (prerunning) return;
        if (!ep.canvasId) return void message.warning("本集画布尚未就绪，请先打开本集画布后再体检");
        setPrerunning(true);
        try {
            // 体检必须全量：skipCompleted 会跳过已有结果段，而断链段(T2VA+空绑定)的"成功结果"
            // 恰恰是最该体检的坏产物；只读体检不创建任务/不扣费，全量检查才是正确语义。
            const report = await prerunEpisode(ep.id, { model: batchVideoModel || undefined, includeAll: true });
            setPrerunReport(report);
            const banner = prerunBanner(report.failed, report.warnings, report.total);
            if (banner.tone === "error") message.warning(banner.text);
            else message.success(banner.text);
        } catch (error) {
            message.error(`体检失败：${(error as Error).message}`);
        } finally { setPrerunning(false); }
    };
    /** 影策「生成视频 · N 段」：对每段真设模型 + 真提交 h3-run（skipCompleted 幂等，已完成段由后端跳过）。 */
    const handleBatchGenerate = async () => {
        if (!toGenerate.length || batchGenerating) return;
        if (!ep.canvasId) return void message.warning("本集画布尚未就绪，请先在画布中打开本集");
        if (batchVideoModel && !onSetSegmentVideoModel) return void message.warning("批量设模型入口尚未就绪");
        // 影策语义：暂停不是硬闸门——点生成会自动把全局暂停转回运行（见暂停横幅文案）。
        if (paused && onAutoResume) {
            try { await onAutoResume(); } catch (error) { return void message.error(`恢复制作失败：${(error as Error).message}`); }
        }
        // 真闸门：提交前实时只读体检，failed>0 一律拦住（如「资产已有参考图但段 0 绑定」断链）。
        // 用后端 prerun 唯一真值，不在前端重复实现判定；体检不创建任务/不扣费。
        setBatchGenerating(true);
        let gatePassed = false;
        try {
            const gate = await prerunEpisode(ep.id, { includeAll: true });
            if (gate.failed > 0) {
                const firstIssue = gate.items.find(item => item.status === "error")?.issues?.[0];
                message.error(`体检未通过（${gate.failed} 个失败项），已阻止生成。${firstIssue ? `原因：${firstIssue}` : "请先修正后再生成"}`);
                setPrerunReport(gate);
                return;
            }
            gatePassed = true;
        } catch (error) {
            message.error(`体检失败，已阻止生成：${(error as Error).message}`);
            return;
        } finally {
            if (!gatePassed) setBatchGenerating(false);
        }
        let ok = 0;
        const errors: string[] = [];
        try {
            for (const card of toGenerate) {
                try {
                    if (batchVideoModel) await onSetSegmentVideoModel!(card.id, batchVideoModel);
                    const target = await resolveSegmentCanvasTargetForPanel(ep, card.id);
                    await startCanvasGeneration({
                        mode: "video", operation: "h3-run", projectId: ep.canvasId,
                        nodeId: target.nodeId, segmentId: target.canvasSegmentId, skipCompleted: true,
                    });
                    ok++;
                } catch (error) {
                    errors.push(`第 ${card.index + 1} 段：${(error as Error).message}`);
                }
            }
            if (ok) {
                message.success(`已提交 ${ok}/${toGenerate.length} 段视频生成任务（画布 H3 执行，已完成段自动跳过）`);
                setSelected(new Set());
                setModelReload((n) => n + 1);
                onChanged?.();
            }
            if (errors.length) message.warning(`${errors.length} 段提交失败：${errors.slice(0, 3).join("；")}${errors.length > 3 ? "…" : ""}`);
        } finally { setBatchGenerating(false); }
    };
    const handleSetCurrentVersion = async (version: StudioSegmentVersion) => {
        if (!editingSegmentId || !onSetSegmentCurrentVideo) return void message.warning("版本写回入口尚未就绪");
        setSettingVersionId(version.id);
        try {
            await onSetSegmentCurrentVideo(editingSegmentId, version);
            message.success(version.version ? `已将 V${version.version} 设为本段当前视频` : "已将该版本设为本段当前视频");
            setVersionReload((n) => n + 1);
            onChanged?.();
        } catch (error) {
            message.error(`设为当前失败：${(error as Error).message}`);
        } finally { setSettingVersionId(null); }
    };
    /** 分镜卡里点某个镜头时带过来的镜头 id：弹窗打开后展开并滚到该镜（对齐影策 ?shot= 定位）。 */
    const focusShotRef = useRef<string | null>(null);
    /** 开段/切段：提示词正文与 dirty 基线一起重置，避免把上一段的改动带到下一段。 */
    const openPromptSegment = (idx: number, shotId?: string) => {
        const text = cards[idx]?.prompt || "";
        const nextId = cards[idx]?.id;
        const switching = nextId !== editingSegmentId;
        focusShotRef.current = shotId || null;
        setEditIdx(idx);
        setEditPrompt(text);
        setPromptBaseline(text);
        if (switching) {
            // 切段同帧清掉上一段的异步读数（effect 在提交后才跑），否则首帧旧列表配新段标题闪一次。
            setSegmentVersions([]); setVersionsError(""); setVersionsLoading(true); setPreviewVersion(null);
            setSegmentVoices([]); setVoiceTruth(null); setVoicesError(""); setVoicesLoading(true);
            setRefTruth(null); setRefError(""); setRefLoading(true);
        }
    };
    /** 切段 / 关闭前：影策 segment-dialog.tsx:747 是「失焦即保存」，这里同样先保存再继续；
     *  非法引用 / 超模型上限 / 保存失败才停在原地，避免把用户打的字丢掉。 */
    const guardPromptDiscard = (next: () => void) => {
        if (!promptDirty) { next(); return; }
        if (promptRefInvalid || (overModelLimit && promptMaxChars !== null)) { next(); return; }
        void handleSavePrompt().then((ok) => { if (ok) next(); });
    };

    // ===== #8 段级音色：真值在画布 H3 段 h3CharacterGroups[].voiceEnabled，随本段视频请求发送 =====
    const [segmentVoices, setSegmentVoices] = useState<SegmentVoiceView[]>([]);
    const [voicesLoading, setVoicesLoading] = useState(false);
    const [voicesError, setVoicesError] = useState("");
    const [voiceTruth, setVoiceTruth] = useState<SegmentVoiceTruth | null>(null);
    const [voiceBusy, setVoiceBusy] = useState<string | null>(null);
    const [voiceModeBusy, setVoiceModeBusy] = useState(false);
    const [voiceReload, setVoiceReload] = useState(0);
    useEffect(() => {
        if (!editingSegmentId) { setSegmentVoices([]); setVoiceTruth(null); setVoicesError(""); return; }
        let cancelled = false;
        setVoicesLoading(true);
        setVoicesError("");
        resolveSegmentVoiceTruth(ep, editingSegmentId)
            .then((truth) => { if (!cancelled) { setVoiceTruth(truth); setSegmentVoices(truth.voices); } })
            .catch((error: unknown) => {
                if (!cancelled) { setVoiceTruth(null); setSegmentVoices([]); setVoicesError((error as Error)?.message || "读取音色失败"); }
            })
            .finally(() => { if (!cancelled) setVoicesLoading(false); });
        return () => { cancelled = true; };
    }, [editingSegmentId, ep.id, ep.canvasId, voiceReload]);
    const handleSetVoiceMode = async (mode: "auto" | "custom") => {
        if (!voiceTruth) return void message.warning("本段音色数据尚未就绪，请稍后刷新重试");
        if (voiceTruth.audioReferenceMode === mode) return;
        setVoiceModeBusy(true);
        try {
            await applySegmentVoicePatch(voiceTruth, (groups) => {
                if (mode === "auto") {
                    // 恢复自动：把编译期从台词派生的组重新写回 voiceEnabled，让下游派生链一致。
                    const autoIds = new Set(voiceTruth.autoVoiceGroupIds);
                    for (const [groupId, group] of Object.entries(groups)) groups[groupId] = { ...group, voiceEnabled: autoIds.has(groupId) };
                }
                return { audioReferenceMode: mode };
            });
            const enabledById = mode === "auto" ? voiceTruth.autoVoiceGroupIds : null;
            setSegmentVoices(prev => prev.map(v => enabledById ? { ...v, enabled: enabledById.includes(v.groupId) } : v));
            setVoiceTruth(prev => prev ? { ...prev, audioReferenceMode: mode, voices: prev.voices.map(v => enabledById ? { ...v, enabled: enabledById.includes(v.groupId) } : v) } : prev);
            message.success(mode === "auto" ? "已恢复按对白自动音色" : "已切换为手动指定音色");
            setVoiceReload((n) => n + 1);
        } catch (error) {
            message.error(`音色模式切换失败：${(error as Error).message}`);
        } finally { setVoiceModeBusy(false); }
    };
    const handleToggleVoice = async (groupId: string, enabled: boolean) => {
        if (!voiceTruth) return void message.warning("本段音色数据尚未就绪，请稍后刷新重试");
        // 影策式手工校验：提交前按当前模型的 maxAudios 拦截超限，而不是等运行时静默跳过。
        if (enabled) {
            if (voiceTruth.audioLimit <= 0) return void message.warning(`当前段模式或模型「${voiceTruth.videoModel}」不支持参考音色`);
            const enabledCount = voiceTruth.voices.filter(v => v.enabled).length;
            if (enabledCount >= voiceTruth.audioLimit) return void message.warning(`当前视频模型每段最多 ${voiceTruth.audioLimit} 段参考音色，请先关闭一个再开启`);
        }
        setVoiceBusy(groupId);
        try {
            await applySegmentVoicePatch(voiceTruth, (groups) => {
                const current = groups[groupId];
                if (!current) throw new Error("角色组已变化，请刷新后重试");
                groups[groupId] = { ...current, voiceEnabled: enabled };
                // 逐组开关是手动行为，落盘时切到 custom，避免下次编译被 auto 派生覆盖。
                return { audioReferenceMode: "custom" };
            });
            setSegmentVoices(prev => prev.map(v => v.groupId === groupId ? { ...v, enabled } : v));
            setVoiceTruth(prev => prev ? { ...prev, audioReferenceMode: "custom", voices: prev.voices.map(v => v.groupId === groupId ? { ...v, enabled } : v) } : prev);
            message.success(enabled ? "音色已开启（手动模式），将随本段视频请求发送" : "音色已关闭（手动模式），不再随本段视频请求发送");
            setVoiceReload((n) => n + 1);
        } catch (error) {
            message.error(`音色切换失败：${(error as Error).message}`);
        } finally { setVoiceBusy(null); }
    };

    // ===== #10 段级参考图排序/启停（真值：director.source.segments[].referenceOverrides + 画布 referenceBindings）=====
    const [refTruth, setRefTruth] = useState<SegmentReferenceTruth | null>(null);
    const [refLoading, setRefLoading] = useState(false);
    const [refError, setRefError] = useState("");
    const [refBusy, setRefBusy] = useState<string | null>(null);
    const [refReload, setRefReload] = useState(0);
    useEffect(() => {
        if (!editingSegmentId) { setRefTruth(null); setRefError(""); return; }
        let cancelled = false;
        setRefLoading(true); setRefError("");
        resolveSegmentReferenceTruth(ep, editingSegmentId)
            .then(t => { if (!cancelled) setRefTruth(t); })
            .catch((error: unknown) => { if (!cancelled) { setRefTruth(null); setRefError((error as Error)?.message || "读取参考图策略失败"); } })
            .finally(() => { if (!cancelled) setRefLoading(false); });
        return () => { cancelled = true; };
    }, [editingSegmentId, ep.id, ep.canvasId, refReload]);

    /** 组内上移/下移：改 order（稳定 binding id 数组），保留当前 disabled，写 mode=manual。 */
    const handleReferenceMove = async (index: number, delta: number) => {
        if (!refTruth || !editingSegmentId) return void message.warning("本段参考图数据尚未就绪，请稍后刷新重试");
        const ids = refTruth.bindings.map(b => b.id);
        const target = index + delta;
        if (target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        setRefBusy(`move:${index}`);
        try {
            await commitProductionOps(ep.id as never, [{
                type: "set_segment_reference_policy", segmentId: editingSegmentId,
                mode: "manual", order: ids, disabled: refTruth.disabled,
            }]);
            await prepareSegmentReference(ep.id as never, editingSegmentId);
            message.success(delta < 0 ? "参考图已上移，画布已按新顺序投影" : "参考图已下移，画布已按新顺序投影");
            setRefReload(n => n + 1);
            onChanged?.();
        } catch (error) { message.error(`参考图排序失败：${(error as Error).message}`); }
        finally { setRefBusy(null); }
    };
    const handleReferenceToggle = async (bindingId: string, enabled: boolean) => {
        if (!refTruth || !editingSegmentId) return void message.warning("本段参考图数据尚未就绪，请稍后刷新重试");
        const disabled = enabled ? refTruth.disabled.filter(id => id !== bindingId) : [...new Set([...refTruth.disabled, bindingId])];
        setRefBusy(`toggle:${bindingId}`);
        try {
            await commitProductionOps(ep.id as never, [{
                type: "set_segment_reference_policy", segmentId: editingSegmentId,
                mode: "manual", order: refTruth.order, disabled,
            }]);
            await prepareSegmentReference(ep.id as never, editingSegmentId);
            message.success(enabled ? "参考图已启用，画布已同步" : "参考图已禁用，不随本段视频请求发送");
            setRefReload(n => n + 1);
            onChanged?.();
        } catch (error) { message.error(`参考图启停失败：${(error as Error).message}`); }
        finally { setRefBusy(null); }
    };
    const handleReferenceRestoreAuto = async () => {
        if (!editingSegmentId) return void message.warning("请先打开一个剧情段");
        setRefBusy("restore");
        try {
            await commitProductionOps(ep.id as never, [{ type: "set_segment_reference_policy", segmentId: editingSegmentId, mode: "auto" }]);
            message.success("已恢复自动参考图：顺序与启停改回编译派生");
            setRefReload(n => n + 1);
            onChanged?.();
        } catch (error) { message.error(`恢复自动参考失败：${(error as Error).message}`); }
        finally { setRefBusy(null); }
    };

    // ===== #11 段级指定音色（voiceOverrides：groupId → 声音样本 storageKey）=====
    const allAssets = useAssetStore(s => s.assets);
    const addAsset = useAssetStore(s => s.addAsset);

    // ===== 参考图管理统一入口：本项目资产 / 本集分集图 / 上传，三者都落到画布 H3 段真实 referenceBindings =====
    const [refManageOpen, setRefManageOpen] = useState(false);
    const [refManageSource, setRefManageSource] = useState<"project" | "episode" | "upload">("project");
    const [refManageSelected, setRefManageSelected] = useState<Record<string, ManageImageItem>>({});
    const [refManageEpisodeItems, setRefManageEpisodeItems] = useState<ManageImageItem[]>([]);
    const [refManageLoading, setRefManageLoading] = useState(false);
    const [refManageBusy, setRefManageBusy] = useState(false);
    const refUploadRef = useRef<HTMLInputElement>(null);

    // 本项目资产：与创作输入框素材库同口径，只列带 storageKey/url 的真实图片类资产，不造占位图。
    const refManageProjectItems = useMemo<ManageImageItem[]>(() => {
        const out: ManageImageItem[] = [];
        const seen = new Set<string>();
        for (const asset of allAssets) {
            const a = asset as unknown as Row;
            const data = (a.data || {}) as Row;
            let storageKey = "", url = "";
            if (a.kind === "image") {
                storageKey = str(data.storageKey); url = str(data.dataUrl || data.url);
            } else if (["character", "scene", "prop"].includes(str(a.kind))) {
                const images = (Array.isArray(data.images) ? data.images : []) as Row[];
                const img = images[Number(data.primaryIndex) || 0] || images[0] || {};
                storageKey = str(img.storageKey); url = str(img.url || data.coverUrl);
            } else continue;
            if (!storageKey && !url) continue;
            const key = storageKey || url;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ key, storageKey, url: storageKey ? backendMediaUrl(storageKey) : url, label: str(a.title) || key });
        }
        return out;
    }, [allAssets]);

    // 本集分集图：从本集画布工程的真实图片节点读取，storageKey/URL 都是节点上的既有值。
    useEffect(() => {
        if (!refManageOpen || refManageSource !== "episode" || !ep?.canvasId) return;
        let cancelled = false;
        setRefManageLoading(true);
        fetchBackendProject(ep.canvasId)
            .then((res) => {
                const project = ((res as any).project || res) as Row;
                const nodes = (Array.isArray(project?.nodes) ? project.nodes : []) as Row[];
                const items: ManageImageItem[] = [];
                const seen = new Set<string>();
                for (const node of nodes) {
                    const meta = (node.metadata || {}) as Row;
                    const key = str(meta.storageKey);
                    const urls = [meta.content, meta.url, meta.localUrl, meta.sourceUrl]
                        .filter((v): v is string => typeof v === "string" && Boolean(v));
                    const type = str(node.type);
                    const isImage = /image/i.test(type) || key.startsWith("image:") || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(urls[0] || "");
                    if (!isImage) continue;
                    const storageKey = key || (urls[0]?.startsWith("image:") ? urls[0] : "");
                    const itemKey = storageKey || urls[0] || "";
                    if (!itemKey || seen.has(itemKey)) continue;
                    seen.add(itemKey);
                    items.push({
                        key: itemKey, storageKey,
                        url: storageKey ? backendMediaUrl(storageKey) : urls[0],
                        label: str(meta.title || meta.name || `画布图 ${items.length + 1}`),
                    });
                }
                if (!cancelled) setRefManageEpisodeItems(items);
            })
            .catch(() => { if (!cancelled) setRefManageEpisodeItems([]); })
            .finally(() => { if (!cancelled) setRefManageLoading(false); });
        return () => { cancelled = true; };
    }, [refManageOpen, refManageSource, ep.id, ep.canvasId]);

    /** 上传：真实写入图片存储并登记到本项目资产，再用其 storageKey 作为候选，绝不伪造媒体字段。 */
    const handleManageUpload = async (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) return void message.warning("只支持上传图片文件");
        setRefManageBusy(true);
        try {
            const image = await uploadImage(file, { category: "library" });
            const title = file.name.replace(/\.[^.]+$/, "") || file.name;
            await addAsset({
                kind: "image", title, coverUrl: image.url, tags: [], source: "本地上传", note: "",
                data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
            });
            const key = image.storageKey || image.url;
            if (key) setRefManageSelected(prev => ({ ...prev, [key]: { key, storageKey: image.storageKey || "", url: image.url, label: title } }));
            message.success("已上传并加入本项目资产，点「加入本段参考」写入");
        } catch (error) {
            message.error(`上传失败：${(error as Error).message}`);
        } finally {
            setRefManageBusy(false);
            if (refUploadRef.current) refUploadRef.current.value = "";
        }
    };

    /** 统一落盘：候选以 ReferenceBinding 写入制作稿 referenceOverrides.additions + 登记参考资产；画布段由读时派生投影，不再双写。 */
    const handleReferenceManageApply = async () => {
        if (!refTruth || !editingSegmentId) return void message.warning("本段参考图数据尚未就绪，请稍后重试");
        const boundKeys = new Set(refTruth.bindings.map(b => b.storageKey).filter(Boolean));
        const chosen = Object.values(refManageSelected).filter(item => item.storageKey && !boundKeys.has(item.storageKey));
        if (!chosen.length) return void message.info("所选图片已在本段参考图中，无需重复加入");
        setRefManageBusy(true);
        try {
            const additions = chosen.map(item => ({
                id: `binding-${item.storageKey}`, assetId: `asset-${item.storageKey}`, label: item.label,
                role: "other", tags: [], enabled: true, usage: "reference", mediaType: "image",
                storageKey: item.storageKey, url: item.url,
            }));
            // 写入收敛到制作稿单一入口：additions 进 director.source.segments[].referenceOverrides，
            // 由读时派生统一投影回画布段（storyboard-track.ts）。不再直写画布 binding，避免双源。
            await commitProductionOps(ep.id as never, [{
                type: "set_segment_reference_policy", segmentId: editingSegmentId,
                mode: refTruth.mode === "manual" ? "manual" : "auto",
                ...(refTruth.mode === "manual" ? { order: refTruth.order, disabled: refTruth.disabled } : {}),
                additions,
            }]);
            await upsertProjectReferenceAssets(refTruth.canvasId, chosen.map(item => ({
                id: `asset-${item.storageKey}`, label: item.label, mediaType: "image", role: "other",
                tags: [], storageKey: item.storageKey, url: item.url, mimeType: "image/*",
            })));
            message.success(`已加入 ${chosen.length} 张参考图，可在下方继续排序 / 启停`);
            setRefManageOpen(false);
            setRefManageSelected({});
            setRefReload(n => n + 1);
            onChanged?.();
        } catch (error) {
            message.error(`加入参考图失败：${(error as Error).message}`);
        } finally {
            setRefManageBusy(false);
        }
    };
    const voiceSamples = useMemo(() => {
        const out = new Map<string, { storageKey: string; name: string; url: string }>();
        for (const asset of allAssets) {
            const a = asset as unknown as Row;
            const kind = str(a.kind);
            const data = (a.data || {}) as Row;
            if (kind === "audio") {
                const key = str(data.storageKey);
                if (key) out.set(key, { storageKey: key, name: str(a.title) || key, url: str(data.url) });
            } else if (kind === "character") {
                const key = str(data.voiceStorageKey);
                if (key) out.set(key, { storageKey: key, name: str(data.voiceName) || str(a.title) || key, url: str(data.voice) });
            }
        }
        for (const v of segmentVoices) {
            if (v.overrideStorageKey && !out.has(v.overrideStorageKey)) out.set(v.overrideStorageKey, { storageKey: v.overrideStorageKey, name: v.overrideName || v.name, url: v.url });
            if (v.storageKey && !out.has(v.storageKey)) out.set(v.storageKey, { storageKey: v.storageKey, name: v.voiceName || v.name, url: v.url });
        }
        return [...out.values()];
    }, [allAssets, segmentVoices]);
    const [overrideBusy, setOverrideBusy] = useState<string | null>(null);
    /** 指定/清除某角色组的声音样本：整张 voiceOverrides 对象替换写回；空 storageKey = 去掉该组覆写。 */
    const handleSetVoiceOverride = async (groupId: string, storageKey: string) => {
        if (!voiceTruth) return void message.warning("本段音色数据尚未就绪，请稍后刷新重试");
        const overrides: Record<string, { storageKey: string; name?: string }> = {};
        for (const v of voiceTruth.voices) {
            if (v.groupId === groupId) {
                if (storageKey) {
                    const name = voiceSamples.find(s => s.storageKey === storageKey)?.name;
                    overrides[groupId] = { storageKey, ...(name ? { name } : {}) };
                }
                continue;
            }
            if (v.overrideStorageKey) overrides[v.groupId] = { storageKey: v.overrideStorageKey, ...(v.overrideName ? { name: v.overrideName } : {}) };
        }
        setOverrideBusy(groupId);
        try {
            await applyVoiceOverridePatch(voiceTruth, { voiceOverrides: overrides });
            message.success(storageKey ? "已为该角色指定声音样本（段级覆写）" : "已清除该角色的段级音色覆写");
            setVoiceReload(n => n + 1);
            onChanged?.();
        } catch (error) { message.error(`指定音色失败：${(error as Error).message}`); }
        finally { setOverrideBusy(null); }
    };
    const handleRestoreVoiceOverrides = async () => {
        if (!voiceTruth) return void message.warning("本段音色数据尚未就绪，请稍后刷新重试");
        setOverrideBusy("restore");
        try {
            await applyVoiceOverridePatch(voiceTruth, {}, ["voiceOverrides"]);
            message.success("已恢复自动音色：段级覆写已清除，沿用角色本体声音");
            setVoiceReload(n => n + 1);
            onChanged?.();
        } catch (error) { message.error(`恢复自动音色失败：${(error as Error).message}`); }
        finally { setOverrideBusy(null); }
    };

    // ===== #12 视频后处理重跑（GET 判定 reprocessable，POST 用冻结参数核验并回写，不调模型不扣费）=====
    const [reprocessStatus, setReprocessStatus] = useState<Record<string, SegmentVideoReprocessPreview>>({});
    const [reprocessBusy, setReprocessBusy] = useState<string | null>(null);
    const [reprocessResult, setReprocessResult] = useState<{ code: string; message: string } | null>(null);
    const reprocessPreview = editingSegmentId ? reprocessStatus[editingSegmentId] : undefined;
    useEffect(() => {
        if (!editingSegmentId) return;
        let cancelled = false;
        resolveSegmentCanvasTargetForPanel(ep, editingSegmentId)
            .then(target => getSegmentVideoReprocessStatus(ep.id as never, target.canvasSegmentId))
            .then(preview => { if (!cancelled) setReprocessStatus(prev => ({ ...prev, [editingSegmentId]: preview })); })
            .catch(() => { if (!cancelled) setReprocessStatus(prev => ({ ...prev, [editingSegmentId]: { ok: false, reprocessable: false } })); });
        return () => { cancelled = true; };
    }, [editingSegmentId, ep.id, ep.canvasId, versionReload]);
    const handleReprocess = async () => {
        if (!editingSegmentId || !reprocessStatus[editingSegmentId]?.reprocessable) return;
        setReprocessBusy(editingSegmentId);
        setReprocessResult(null);
        try {
            const target = await resolveSegmentCanvasTargetForPanel(ep, editingSegmentId);
            const result = await reprocessSegmentVideo(ep.id as never, target.canvasSegmentId);
            setReprocessResult({ code: result.code, message: result.message || "" });
            message.success(`视频后处理完成：${result.code}（未重新生成、未扣费）`);
            setReprocessStatus(prev => ({ ...prev, [editingSegmentId]: { ok: true, reprocessable: false, alreadyReady: true } }));
            setVersionReload(n => n + 1);
            onChanged?.();
        } catch (error) {
            const code = error instanceof BackendApiError ? str((error.details as Row)?.code) : "";
            setReprocessResult({ code: code || "REPROCESS_FAILED", message: (error as Error).message });
            message.error(`重新处理失败：${code || (error as Error).message}`);
        } finally { setReprocessBusy(null); }
    };

    // ===== #9 分镜键盘快捷键（影策 storyboard.tsx:296-343），基于已有 selected 多选状态 =====
    const anchorRef = useRef<string | null>(null);
    const cardsRef = useRef<HTMLDivElement>(null);
    const toggleSel = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const selectRange = (fromId: string, toId: string) => {
        const a = cards.findIndex(c => c.id === fromId);
        const b = cards.findIndex(c => c.id === toId);
        if (a < 0 || b < 0) return;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        setSelected(prev => { const n = new Set(prev); for (let i = lo; i <= hi; i++) n.add(cards[i].id); return n; });
    };
    const openSegmentEditor = (id: string) => {
        const idx = cards.findIndex(c => c.id === id);
        if (idx < 0) return;
        setActive(id);
        openPromptSegment(idx);
    };
    useEffect(() => {
        // 弹窗打开时交给 antd / 输入框处理键盘，避免破坏现有输入行为（Enter blur、textarea 换行）。
        if (!cards.length || editIdx !== null || Boolean(promptResult) || Boolean(previewVersion)) return;
        // 影策 storyboard.tsx:299-303、328-329：上下方向键按网格列数跨整行，而不是固定 ±1。
        // 本地段卡片当前是纵向单列堆叠（space-y-2），读不到 gridTemplateColumns 时回落 1，行为与现有一致；
        // 若容器改为多列网格，这里按浏览器算出的真实列数跨行。
        const columns = () => {
            const grid = cardsRef.current;
            if (!grid) return 1;
            const template = getComputedStyle(grid).gridTemplateColumns;
            if (!template || template === "none") return 1;
            return Math.max(1, template.split(" ").filter(Boolean).length);
        };
        const onKey = (event: KeyboardEvent) => {
            const el = event.target as HTMLElement | null;
            // 对齐影策 use-studio.ts isTypingTarget：只有真正吃键的输入类目标（含 antd 弹层）才让开；
            // 卡内的按钮（标题/封面/镜头行）不作为屏蔽条件，否则点过按钮后快捷键就全失效。
            if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
                || el.closest(".ant-select, .ant-modal, .ant-drawer, .ant-popover, .ant-dropdown, [role=dialog], [aria-haspopup], [role=listbox]:not([data-studio-segment-board])"))) return;
            if (event.altKey) return;
            const key = event.key.toLowerCase();
            if ((event.metaKey || event.ctrlKey) && key === "a") {
                event.preventDefault();
                setSelected(new Set(cards.map(c => c.id)));
                return;
            }
            if (event.metaKey || event.ctrlKey) return;
            const position = active ? cards.findIndex(c => c.id === active) : -1;
            const move = (delta: number) => {
                event.preventDefault();
                const nextIdx = Math.min(cards.length - 1, Math.max(0, position < 0 ? (delta > 0 ? 0 : cards.length - 1) : position + delta));
                const next = cards[nextIdx].id;
                if (event.shiftKey) selectRange(anchorRef.current ?? next, next);
                else anchorRef.current = next;
                setActive(next);
                cardsRef.current?.querySelector<HTMLElement>(`[data-segment="${CSS.escape(next)}"]`)?.focus({ preventScroll: true });
            };
            // 左右/J/K 逐段，上下按真实列数跨行（对齐影策 storyboard.tsx:326-329）。
            if (key === "j" || event.key === "ArrowRight") move(1);
            else if (key === "k" || event.key === "ArrowLeft") move(-1);
            else if (event.key === "ArrowDown") move(columns());
            else if (event.key === "ArrowUp") move(-columns());
            else if (event.key === "Home") move(-cards.length);
            else if (event.key === "End") move(cards.length);
            else if (event.key === "Escape") setSelected(new Set());
            else if ((key === "x" || event.key === " ") && active) { event.preventDefault(); toggleSel(active); }
            else if (event.key === "Enter" && active) { event.preventDefault(); openSegmentEditor(active); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [cards, active, editIdx, promptResult, previewVersion]);
    useEffect(() => {
        if (!active) return;
        cardsRef.current?.querySelector<HTMLElement>(`[data-segment="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);
    // 段弹窗「本段镜头」的内联编辑与镜头级操作：与剧本页同源，走真实 production op。
    const [editingShotId, setEditingShotId] = useState<string | null>(null);
    // 段弹窗打开后把分镜卡带过来的镜头展开并滚到可见处，其余情况不改镜头展开状态。
    useEffect(() => {
        const shotId = focusShotRef.current;
        if (editIdx === null || !shotId) return;
        focusShotRef.current = null;
        setEditingShotId(shotId);
        window.requestAnimationFrame(() => {
            document.querySelector(`[data-studio-seg-shot-cards] [data-studio-shot-id="${CSS.escape(shotId)}"]`)?.scrollIntoView({ block: "center" });
        });
    }, [editIdx]);
    const [savingShot, setSavingShot] = useState(false);

    if (!shots.length) {
        return (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" data-studio-panel="shots">
                <div className="mb-4 flex size-20 items-center justify-center rounded-full border-4 border-muted"><Clapperboard className="size-8 text-muted-foreground/40" /></div>
                <h3 className="text-sm font-semibold">还没有分镜</h3>
                <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                    先在「剧本」页改编成功本集剧本，分镜表会随改编过程生成。也可以在精修画布里手动拆分镜头。
                </p>
            </div>
        );
    }

    /** 镜头级操作：insert_shot / delete_shot / patch_director_source 都是剧本页在用的真实 production op。 */
    const submitShotOp = async (ops: ProductionOperation[], ok: string) => {
        if (!ep?.id) return;
        setSavingShot(true);
        try {
            await commitProductionOps(ep.id as never, ops);
            message.success(ok);
            onChanged?.();
        } catch (error) {
            message.error(`操作失败：${error instanceof Error ? error.message : String(error)}`);
        } finally { setSavingShot(false); }
    };
    const patchShot = async (shotId: string, patch: Record<string, unknown>) => {
        if (!ep?.id) return;
        setSavingShot(true);
        try {
            await commitProductionOps(ep.id as never, [{ type: "patch_director_source", entity: "shot", id: shotId, patch }]);
            message.success("镜头已保存，本段提示词与视频已标记为过期");
            onChanged?.();
        } catch (error) {
            message.error(`保存失败：${(error as Error).message}`);
        } finally { setSavingShot(false); }
    };
    const insertShot = (shotId: string) => void submitShotOp([{ type: "insert_shot", id: shotId, position: "after" }], "已在后面插入镜头");
    const deleteShot = (shotId: string) => void submitShotOp([{ type: "delete_shot", id: shotId }], "镜头已删除，本段提示词与视频已标记为过期");

    const handleWritePrompt = async (segmentId: string) => {
        if (!onWriteSegmentPrompt) return void message.warning("撰写入口尚未就绪");
        setWritingPrompt(segmentId);
        try {
            const result = await onWriteSegmentPrompt(segmentId);
            setPromptResult(result);
            if (result.warnings.length) message.warning(`提示词已写入，但有非法参考图引用：${result.warnings.join("、")}`);
            else message.success("提示词已撰写并写入画布，可直接生成视频");
        } catch (error) { message.error(`撰写失败：${(error as Error).message}`); }
        finally { setWritingPrompt(null); }
    };
    /** 影策批量重写：对已选段逐个调用真实 prompts 链路写回画布。 */
    const handleBatchWritePrompt = async () => {
        if (!onWriteSegmentPrompt) return void message.warning("撰写入口尚未就绪");
        const ids = [...selected];
        if (!ids.length) return;
        setBatchWriting(true);
        let ok = 0;
        try {
            for (const id of ids) {
                try { await onWriteSegmentPrompt(id); ok++; } catch { /* 单段失败不阻断其余 */ }
            }
            message.success(`已重写 ${ok}/${ids.length} 段提示词并写入画布`);
        } finally { setBatchWriting(false); }
    };
    const handleSavePrompt = async (): Promise<boolean> => {
        const card = cards[editIdx ?? -1];
        if (!card) return false;
        if (promptRefInvalid) {
            message.warning(`提示词里的 ${promptRefUsage.unknown.map(n => `<Picture ${n}>`).join("、")} 不是本段参考图，请先改成正确编号再保存`);
            return false;
        }
        // 模型能力读到 promptMaxChars 真值时硬校验：超限禁止保存（影策 segment-dialog.tsx:740-751 同口径）。
        // 字段未落地时 promptMaxChars=null、overModelLimit=false，行为与原先软提醒一致。
        if (overModelLimit && promptMaxChars !== null) {
            message.error(`当前正文 ${sentChars} 个字符，超过视频模型上限 ${promptMaxChars} 个字符，请精简后再保存`);
            return false;
        }
        if (!onSaveSegmentPrompt) { message.warning("保存入口尚未就绪"); return false; }
        const savingText = editPrompt;
        setSavingPrompt(true);
        try {
            await onSaveSegmentPrompt(card.id, savingText);
            setPromptBaseline(savingText);
            message.success("提示词已保存到画布 H3 段，生成视频将读取最新内容");
            return true;
        } catch (error) { message.error(`保存失败：${(error as Error).message}`); return false; }
        finally { setSavingPrompt(false); }
    };
    /** 影策 segment-dialog.tsx:747 的「失焦或 ⌘↵ 保存」：脏了才写，正在保存/非法引用/超上限时不写。 */
    const autosavePrompt = () => {
        if (!promptDirty || savingPrompt || promptRefInvalid || (overModelLimit && promptMaxChars !== null)) return;
        void handleSavePrompt();
    };
    /** 影策「恢复模型版」：把模型生成的原版提示词（artifact.prompt）写回画布，清掉手动改写。 */
    const handleRestorePrompt = async () => {
        const card = cards[editIdx ?? -1];
        if (!card || !card.prompt) return void message.warning("本段没有模型原版提示词");
        if (promptMaxChars !== null && isPromptOverModelLimit(card.prompt, promptMaxChars)) {
            return void message.error(`模型原版提示词超过视频模型上限 ${promptMaxChars} 个字符，无法恢复`);
        }
        if (!onSaveSegmentPrompt) return void message.warning("保存入口尚未就绪");
        setSavingPrompt(true);
        try {
            await onSaveSegmentPrompt(card.id, card.prompt);
            setEditPrompt(card.prompt);
            setPromptBaseline(card.prompt);
            message.success("已恢复模型生成的原版提示词");
        } catch (error) { message.error(`恢复失败：${(error as Error).message}`); }
        finally { setSavingPrompt(false); }
    };
    const approval = (((production?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.reviewApproval as { approvedAt?: string; assetCount?: number } | undefined;
    const handleApprove = async () => {
        if (!onApproveVideo) return void onOpenCanvas();
        setApproving(true);
        try {
            const result = await onApproveVideo();
            if (!result.ok) {
                message.warning(`还有 ${result.missing.length} 项资产未生成参考图：${result.missing.slice(0, 4).join("、")}${result.missing.length > 4 ? "…" : ""}。请到「项目资产」先生成并锁定。`);
                onSwitchToAssets?.();
                return;
            }
            message.success("参考图已就绪，放行通过；即将在画布中按段生成视频");
            onOpenCanvas();
        } catch (error) { message.error(`放行失败：${(error as Error).message}`); }
        finally { setApproving(false); }
    };

    // 影策 .drama-studio-board.is-landscape：横屏项目卡片最小 400px，竖屏 320px。
    const boardAspect = (() => {
        const ratio = String((production?.draft as Record<string, any> | undefined)?.settings?.videoAspectRatio || "16:9");
        const [w, h] = ratio.split(":").map(Number);
        return !w || !h ? "16 / 9" : `${w} / ${h}`;
    })();
    const [boardW, boardH] = boardAspect.split("/").map(Number);
    const boardLandscape = !boardW || !boardH ? true : boardW >= boardH;

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-studio-panel="shots">
            {/* 顶部工具条（对齐影策 .drama-board-toolbar：单行统计 + 双进度 + 顺序提示） */}
            <div className="sticky top-0 z-10 flex min-h-12 shrink-0 items-center border-b border-border bg-background/85 px-5 py-2 backdrop-blur" data-studio-progress>
                <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-2">
                    {selected.size ? (
                        <>
                            {/* 影策 .drama-board-toolbar.is-selecting：选中后工具条整体换成批量动作，不再另放底浮条。 */}
                            <span className="text-xs font-medium" data-studio-segment-batch-bar>已选 {selected.size} 段</span>
                            <Dropdown
                                trigger={["click"]}
                                disabled={!videoModelOptions.length}
                                menu={{
                                    selectedKeys: [batchVideoModel],
                                    items: [{ key: "", label: "沿用各段已选模型" }, ...videoModelOptions.map((value) => ({ key: value, label: modelLabel(value) }))],
                                    onClick: ({ key }) => setBatchVideoModel(key),
                                }}
                            >
                                <button type="button" className="flex h-7 min-w-0 max-w-[40vw] items-center gap-1 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground" data-studio-segment-batch-model>
                                    <Sparkles className="size-3 shrink-0" /><span className="truncate">{batchVideoModel ? modelLabel(batchVideoModel) : "视频模型：各段已选"}</span>
                                </button>
                            </Dropdown>
                            <Tooltip title={batchSkipped ? `${batchSkipped} 段提示词未就绪或正在生成，会跳过` : undefined}>
                                <button type="button" onClick={() => void handleBatchGenerate()} disabled={batchGenerating || !toGenerate.length}
                                    title={paused ? "已暂停：点击会先自动继续制作，再提交逐段出片" : "逐段真提交画布 H3 出片任务；已完成段由 skipCompleted 幂等跳过"}
                                    className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-[11px] font-medium text-background transition hover:opacity-85 disabled:opacity-50"
                                    data-studio-segment-batch-generate>
                                    <Play className="size-3" /> {batchGenerating ? "提交中…" : `生成视频 · ${toGenerate.length} 段`}
                                </button>
                            </Tooltip>
                            <button type="button" onClick={() => void handleBatchWritePrompt()} disabled={batchWriting || !onWriteSegmentPrompt}
                                className="flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground disabled:opacity-50" data-studio-segment-batch-rewrite>
                                <Sparkles className="size-3" /> {batchWriting ? "重写中…" : `重新撰写提示词 · ${selected.size} 段`}
                            </button>
                            {batchSkipped ? <span className="text-[11px] text-amber-500" data-studio-segment-batch-skipped>跳过 {batchSkipped} 段（未就绪/生成中）</span> : null}
                            <span className="flex-1" />
                            <button type="button" onClick={() => setSelected(new Set(cards.map(c => c.id)))} className="h-7 rounded-md px-2 text-[11px] text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground" data-studio-segment-select-all>全选</button>
                            <button type="button" onClick={() => setSelected(new Set())} className="h-7 rounded-md px-2 text-[11px] text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground" data-studio-segment-clear-selection>取消选择</button>
                        </>
                    ) : (
                        <>
                    <div className="flex shrink-0 items-baseline gap-1 text-[11px] text-muted-foreground">
                        <span className="font-semibold text-foreground">{segments.length}</span> 段
                        <span className="text-muted-foreground/40">·</span>
                        <span className="font-semibold text-foreground">{shots.length}</span> 镜
                        <span className="text-muted-foreground/40">·</span>
                        <span className="font-semibold text-foreground">{formatSec(totalSec)}</span> 时长
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="shrink-0">提示词 <span className="font-medium text-foreground/75 tabular-nums">{promptReady}/{segments.length}</span></span>
                        <span className="h-1 w-[72px] shrink-0 overflow-hidden rounded-full bg-foreground/15">
                            <span className="block h-full rounded-full bg-foreground/55" style={{ width: `${segments.length ? (promptReady / segments.length) * 100 : 0}%` }} />
                        </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="shrink-0">视频 <span className="font-medium text-emerald-600 tabular-nums dark:text-emerald-500">{videoReady}/{segments.length}</span></span>
                        <span className="h-1 w-[72px] shrink-0 overflow-hidden rounded-full bg-foreground/15">
                            <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${segments.length ? (videoReady / segments.length) * 100 : 0}%` }} />
                        </span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground/80">段按顺序生成，第 2 段起以上一段最后一帧为首帧</span>
                        </>
                    )}
                    <button type="button" aria-label="切换矩阵视图" onClick={() => setMatrix(v => !v)} className="ml-auto rounded p-1 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground" title={matrix ? "列表视图" : "矩阵视图"}>
                        <Film className="size-4" />
                    </button>
                </div>
            </div>

            {/* 剧情段卡片列表（对齐影策 .drama-sg 卡片：320/400px 自动填充网格）。
                影策快捷键提示是滚动内容的一部分（storyboard.tsx:460，滚到底才出现），
                所以滚动容器放在外层，网格与提示同属滚动内容，不再是固定底栏。 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-1 pt-3">
            <div ref={cardsRef} role="listbox" data-studio-segment-board aria-multiselectable aria-label="剧情段" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${boardLandscape ? 400 : 320}px, 1fr))` }} className="grid content-start items-stretch gap-2" aria-busy={busy || modelsLoading}>
                {cards.map((c) => {
                    // 本段出片进行中：封面盖真实状态遮罩 + 生成按钮转 loading，成功/失败后随轮询自动还原。
                    const videoBusy = BUSY_VIDEO_STATUSES.has(String(c.videoStatus || "").toLowerCase());
                    // 影策三分支用真实段状态：排队（可能等上一段）/ 生成中；不拿提示词状态冒充视频状态。
                    // 影策生成中卡片的文案：状态位是「作品创作中」+ 转圈，封面只留占位（不压大字）。
                    const videoBusyLabel = String(c.videoStatus || "").toLowerCase() === "queued"
                        ? (c.state.tone === "blocked" ? compactStateLabel(c.state.label) : "等待中")
                        : "作品创作中";
                    /** 影策 storyboard.tsx:278-291 的卡体点击语义（逐字对齐）：
                     *  普通单击 = **只聚焦**（aria-current 高亮），绝不勾选；⌘/Ctrl 单击 = 切换勾选；Shift 单击 = 连选。
                     *  勾选只能靠卡头 checkbox。 */
                    const selectSurface = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        if (e.metaKey || e.ctrlKey) { toggleSel(c.id); anchorRef.current = c.id; setActive(c.id); return; }
                        if (e.shiftKey) { selectRange(anchorRef.current ?? c.id, c.id); setActive(c.id); return; }
                        setActive(c.id); anchorRef.current = c.id;
                    };
                    return (
                    <section key={c.id} data-segment={c.id} tabIndex={0} role="option" aria-selected={selected.has(c.id)} aria-current={active === c.id}
                        onFocus={() => setActive(c.id)}
                        onDoubleClick={(e) => {
                            // 双击卡体才进段弹窗；落在卡内按钮/输入上的双击归控件自己处理。
                            if ((e.target as HTMLElement).closest("button, a, input, .ant-select, .ant-checkbox-wrapper")) return;
                            setActive(c.id);
                            openPromptSegment(c.index);
                        }}
                        onClick={(e) => {
                            // 影策 storyboard.tsx:278-291 的原样语义：普通单击卡体 = **只聚焦**（高亮当前段），
                            // 不勾选；⌘/Ctrl 单击才切换勾选，Shift 单击连选；勾选也可以只点卡头 checkbox。
                            if ((e.target as HTMLElement).closest("button, a, input, label, .ant-select, .ant-checkbox-wrapper")) return;
                            if (e.metaKey || e.ctrlKey) { toggleSel(c.id); anchorRef.current = c.id; setActive(c.id); return; }
                            if (e.shiftKey) { selectRange(anchorRef.current ?? c.id, c.id); setActive(c.id); return; }
                            anchorRef.current = c.id;
                            setActive(c.id);
                        }}
                        className={cn("flex cursor-default select-none flex-col gap-2 rounded-[8px] border border-border bg-card p-2 outline-none transition-colors hover:border-foreground/25",
                            active === c.id && "border-primary/45",
                            c.state.tone === "failed" && !selected.has(c.id) && "border-rose-500/45",
                            selected.has(c.id) && "border-primary/70 bg-primary/[0.06]")} aria-label={`第 ${c.index + 1} 段 ${c.title}`}>
                        <div className="flex items-center gap-2">
                            <label className="-m-1 flex size-[24px] shrink-0 cursor-pointer items-center justify-center" data-studio-seg-checkbox-hit>
                            <input type="checkbox" checked={selected.has(c.id)} onClick={(e) => {
                                // 影策 storyboard.tsx:111-122：Shift 单击只连选，不额外切换本段，也不冒泡到卡体。
                                e.stopPropagation();
                                if (e.shiftKey && anchorRef.current) { e.preventDefault(); selectRange(anchorRef.current, c.id); }
                            }} onChange={() => { toggleSel(c.id); anchorRef.current = c.id; }} aria-label={`选择第 ${c.index + 1} 段`} className="size-4 shrink-0 cursor-pointer rounded-[4px] accent-primary" data-studio-seg-checkbox />
                            </label>
                            <span className="grid h-[22px] min-w-[22px] shrink-0 place-items-center rounded-[8px] bg-primary/10 px-2 text-[11px] font-semibold tabular-nums text-primary" data-studio-seg-num>{c.index + 1}</span>
                            <button type="button" onClick={(e) => { e.stopPropagation(); setActive(c.id); openPromptSegment(c.index); }} style={{ fontSize: 11 }} className="min-w-0 flex-1 cursor-pointer truncate text-left text-[11px] font-semibold leading-[1.6] transition hover:text-primary" title={c.title} data-studio-open-segment-title>{c.title}</button>
                            {!c.prompt ? <AlertCircle className="size-3.5 shrink-0 text-amber-500" aria-label="缺少提示词" /> : null}
                        </div>
                        {/* 横向主体（对齐影策 .drama-sg-body：左封面 + 右信息） */}
                        <div className={cn("grid min-h-0 flex-1 content-start gap-2", boardLandscape ? "grid-cols-[136px_minmax(0,1fr)]" : "grid-cols-[76px_minmax(0,1fr)]")}>
                        {/* 左列封面：影策 drama-sg-cover 也是「打开段弹窗」的按钮（单击就开，不再单独去画布）。 */}
                        <button type="button"
                            onClick={(e) => { e.stopPropagation(); setActive(c.id); openPromptSegment(c.index); }}
                            style={{ aspectRatio: boardAspect }} className="relative w-full cursor-pointer overflow-hidden rounded-[8px] bg-foreground/[0.04] outline outline-1 -outline-offset-1 outline-border"
                            data-studio-segment-cover
                            data-studio-video={c.videoUrl && (c.state.tone === "ready" || c.state.tone === "stale") ? "1" : "0"}
                            data-studio-video-status={c.videoStatus || "none"}
                            aria-label={`打开第 ${c.index + 1} 段`}>
                            {/* 出片 loading：影策生成中的封面只留深色占位 + 转圈，不压文字（文字在状态位「作品创作中」）。
                                绝对定位遮罩不改变封面/卡片尺寸，避免轮询时重排。 */}
                            {videoBusy ? (
                                <span className="absolute inset-0 z-10 grid place-items-center bg-muted/70" data-studio-segment-video-busy aria-busy="true" role="status" aria-label={videoBusyLabel}>
                                    <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                                </span>
                            ) : null}
                            {c.videoUrl && (c.state.tone === "ready" || c.state.tone === "stale") ? (
                                <>
                                    <SegmentCoverVideo url={c.videoUrl} />
                                    <span className="pointer-events-none absolute right-1 top-1 rounded bg-black/60 px-1 text-[11px] font-semibold leading-[15px] tabular-nums text-white">{formatClipSec(c.videoDuration)}</span>
                                    <span className="pointer-events-none absolute bottom-1 left-1 flex size-7 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/40"><Play className="size-2.5" aria-hidden /></span>
                                </>
                            ) : videoBusy ? null : (
                                // 忙碌遮罩已经用 videoBusyLabel 表达唯一真值；底层占位文案必须让位，
                                // 否则半透明遮罩下会透出「提示词已过期」，和「生成中」叠成「提示生成中过期」。
                                <span className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground" data-studio-segment-video-empty>
                                    <Film className="size-4" aria-hidden />
                                    {/* 制作稿回执说已出片、但画布段没关联到媒体时，别写「视频已生成」冒充可播放：
                                        明确指出封面未关联，避免用户点开发现没东西。 */}
                                    <span className="text-[11px]" title={c.hasVideo && !c.videoUrl ? "制作稿显示已产出视频，但画布 H3 段没有关联到该媒体（常见于分镜重建后段 id 变化）" : undefined}>
                                        {c.hasVideo && !c.videoUrl ? "封面未关联" : c.state.label}
                                    </span>
                                </span>
                            )}
                        </button>
                            <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex items-center gap-2 overflow-hidden text-[11px]">
                            <Tooltip title={c.state.detail || `第 ${c.index + 1} 段状态：${c.state.label}`} mouseEnterDelay={0.3}>
                                <span data-studio-segment-state={c.state.tone} className={cn("inline-flex h-5 max-w-[62%] min-w-0 shrink-0 items-center gap-1 rounded-full px-2 font-semibold",
                                    c.state.tone === "ready" ? "bg-emerald-500/10 text-emerald-500"
                                    : c.state.tone === "stale" ? "bg-amber-500/10 text-amber-500"
                                    : c.state.tone === "failed" ? "bg-rose-500/10 text-rose-500"
                                    : c.state.tone === "busy" ? "bg-sky-500/10 text-sky-500"
                                    : c.state.tone === "blocked" ? "bg-amber-500/10 text-amber-500"
                                    : "bg-muted text-muted-foreground")}>
                                    {c.state.tone === "ready" ? <Check className="size-3" />
                                        : c.state.tone === "failed" ? <AlertCircle className="size-3" />
                                        : c.state.tone === "busy" || videoBusy ? <Loader2 className="size-3 animate-spin" />
                                        : <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />}
                                    <span className="truncate">{videoBusy ? videoBusyLabel : compactStateLabel(c.state.label)}</span>
                                </span>
                            </Tooltip>
                            <span className="shrink-0 whitespace-nowrap text-muted-foreground">{c.shots.length} 镜{(() => {
                                // 影策「N 镜 · 上限 15s」：上限取本段实际出片模型能力（/settings/ai-config 真值），无声明时退回 mode。
                                const cap = modelMaxVideoSeconds(modelVideoCapabilitiesOf(config, segmentVideoModels[c.id] || config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL));
                                return cap ? ` · 上限 ${cap}s` : c.mode ? ` · ${c.mode}` : "";
                            })()}</span>
                        </div>
                        {/* 参考图 chips（影策 .drama-chip）：首帧单独黑底 chip，其余「图 N」；没有首帧真值不造。 */}
                        {(c.thumbnails.length || c.firstFrame) ? (() => {
                            const firstFrame = c.thumbnails.find(t => /首帧|first[_ ]?frame|continuity_anchor|storyboard/i.test(`${t.label} ${t.role} ${t.name}`));
                            const chips = [...(firstFrame ? [firstFrame] : []), ...c.thumbnails.filter(t => t !== firstFrame)];
                            return (
                            <div className="flex flex-wrap items-start gap-1" data-studio-segment-refs
                                onClick={(e) => {
                                    // chips 之间的空白也归卡体（单击选中）；chip 自己是 button/div，会各自处理。
                                    if ((e.target as HTMLElement).closest("button, a, input, label")) return;
                                    selectSurface(e);
                                }}>
                                    {/* 影策首帧格：作为普通「首帧」chip 排在最前，与图 N 并排；真值来自画布上一段尾帧。 */}
                                    {c.firstFrame && !firstFrame ? <Tooltip title={c.firstFrame.url ? `本段首帧 = 第 ${c.firstFrame.fromSegment} 段视频最后一帧` : `第 ${c.firstFrame.fromSegment} 段尚未截到尾帧`} mouseEnterDelay={0.3}>
                                        <div className="inline-flex max-w-[140px] shrink-0 items-center gap-1 text-[11px]" aria-label="首帧" data-studio-card-first-frame data-studio-segment-ref-first-frame>
                                            <span className="relative block shrink-0 overflow-hidden rounded-[4px] bg-foreground/[0.05] outline outline-1 -outline-offset-1 outline-border" style={{ width: 34, aspectRatio: "4 / 3" }}>
                                                {c.firstFrame.url
                                                    ? <img src={c.firstFrame.url} alt="首帧" className="size-full object-cover" loading="lazy" data-studio-card-first-frame-thumb />
                                                    : <span className="grid size-full place-items-center text-[11px] text-muted-foreground">等待</span>}
                                                <em className="absolute bottom-0.5 left-0.5 rounded-[4px] bg-black/60 px-1 text-[11px] font-semibold not-italic leading-[12px] text-white">首帧</em>
                                            </span>
                                        </div>
                                    </Tooltip> : null}
                                    {chips.map((t, ti) => {
                                        const isFirst = Boolean(firstFrame && t === firstFrame);
                                        const chipLabel = isFirst ? "首帧" : t.label;
                                        const cls = cn("inline-flex max-w-[140px] shrink-0 items-center gap-1 text-[11px]", isFirst ? "" : "text-muted-foreground");
                                        // 只有后端 segment.state.references 真值 sent=false 才显示未附图；无 state 时为 null，原有展示不回归。
                                        const missingLabel = referenceMissingLabel(t);
                                        const body = (
                                            <>
                                                <span className="relative block shrink-0 overflow-hidden rounded-[4px] bg-foreground/[0.05] outline outline-1 -outline-offset-1 outline-border" style={{ width: isFirst ? 34 : 40, aspectRatio: isFirst ? "4 / 3" : "16 / 9" }}>
                                                    {t.url
                                                        ? <img src={t.url} alt={chipLabel} className={cn("size-full object-cover", missingLabel && "opacity-45")} loading="lazy" />
                                                        : <span className="grid size-full place-items-center text-[11px] text-muted-foreground">{isFirst ? "首帧" : chipLabel.replace("图 ", "")}</span>}
                                                    <em className="absolute bottom-0.5 left-0.5 rounded-[4px] bg-black/60 px-1 text-[11px] font-semibold not-italic leading-[12px] text-white">{chipLabel}</em>
                                                    {missingLabel ? <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-rose-500" title={missingLabel} data-studio-segment-ref-missing /> : null}
                                                </span>
                                                {matrix && !isFirst ? <span className="truncate text-[11px] text-foreground/45">{t.name}</span> : null}
                                            </>
                                        );
                                        // hover 只保留用户能读懂的编号/类型/名称；真实来源（assetId/nodeId）仍决定是否可点击，不写进提示。
                                        if (!t.storageKey) return <div key={ti} className={cls} title={referenceHoverText(t)} aria-label={chipLabel}>{body}</div>;
                                        const linked = Boolean(t.assetId || t.nodeId);
                                        return (
                                            <Tooltip key={t.storageKey || ti} title={referenceHoverText(t)} mouseEnterDelay={0.3}>
                                                {linked ? (
                                                    <button type="button" data-studio-segment-ref-open={t.assetId || t.nodeId}
                                                        aria-label={chipLabel}
                                                        onClick={(e) => { e.stopPropagation(); onSwitchToAssets?.(); }}
                                                        className={cn(cls, "cursor-pointer transition hover:border-foreground/25 hover:text-foreground")}>
                                                        {body}
                                                    </button>
                                                ) : <div className={cls} aria-label={chipLabel}>{body}</div>}
                                            </Tooltip>
                                        );
                                    })}
                            </div>
                            );
                        })() : (
                            <div className="text-[11px] text-muted-foreground/80">本段尚未配置参考资产，可进入剧情段补充。</div>
                        )}
                        {/* 镜头内容预览（对齐影策 storyboard.tsx:163-194 + drama.css:5600-5648）：
                            单镜 = 画面最多 3 行 + 台词最多 2 行；多镜 = **每镜一行**（nowrap + ellipsis）+ 还有N镜。
                            多镜不再换行成两三行，一行一镜才能像影策那样一屏看清每段有几个镜。 */}
                        <div className="h-[52px] shrink-0 overflow-hidden">
                        {c.shots.length === 1 ? (() => {
                            const p = shotPreview(sourceOf(production), c.shots[0]);
                            // 影策 storyboard.tsx:163-172：单镜预览整体是一个按钮，单击直接打开本段弹窗并定位该镜。
                            // 字号用内联：全局无层级 `button{font:inherit}` 会压掉 text-[Npx]，导致卡片正文比影策大一号。
                            return <button type="button"
                                onClick={(e) => selectSurface(e)}
                                onDoubleClick={(e) => { e.stopPropagation(); setActive(c.id); openPromptSegment(c.index, c.shots[0].id); }}
                                style={{ fontSize: 11, lineHeight: "17px" }}
                                className="block w-full cursor-pointer rounded px-1 text-left transition hover:bg-foreground/[0.03]" data-studio-shot-single
                                title="单击选中本段，双击打开段弹窗定位该镜">
                                <span className={cn("block text-foreground/80", p.dialogue ? "line-clamp-2" : "line-clamp-3")} data-studio-shot-action>{p.action}</span>
                                {p.dialogue ? (
                                    <span className="line-clamp-1 block text-foreground/75" data-studio-shot-dialogue>
                                        <em className="not-italic font-semibold text-foreground">{p.speaker}：</em>{p.dialogue}
                                    </span>
                                ) : null}
                            </button>;
                        })() : c.shots.length > 1 ? (
                            <ol className="space-y-px" data-studio-segment-shots>
                                {c.shots.slice(0, SHOT_PREVIEW).map((sh, si) => {
                                    const p = shotPreview(sourceOf(production), sh);
                                    return <li key={si}><button type="button"
                                        onClick={(e) => selectSurface(e)}
                                        onDoubleClick={(e) => { e.stopPropagation(); setActive(c.id); openPromptSegment(c.index, sh.id); }}
                                        title={p.dialogue ? `${p.speaker}：${p.dialogue}` : p.action}
                                        style={{ fontSize: 11, lineHeight: "17px" }}
                                        className="flex w-full cursor-pointer items-baseline gap-2 rounded-[4px] px-1 text-left transition hover:bg-foreground/[0.03]">
                                        <b className="min-w-[14px] shrink-0 font-semibold tabular-nums text-muted-foreground/80">{shotDisplayNumber(sourceOf(production), sh)}</b>
                                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground/75" data-studio-shot-line>
                                            {p.dialogue
                                                ? <><em className="not-italic font-semibold text-foreground">{p.speaker} </em>{p.dialogue}</>
                                                : p.action}
                                        </span>
                                    </button></li>;
                                })}
                                {c.shots.length > SHOT_PREVIEW ? <li className="pl-6 pr-1 text-[11px] leading-[1.55] text-muted-foreground/80">还有 {c.shots.length - SHOT_PREVIEW} 镜</li> : null}
                            </ol>
                        ) : null}
                        </div>
                            </div>
                        </div>
                        {/* 卡片底部操作条（影策 storyboard.tsx:197-218 + drama.css:5653-5673）：
                            模型名 flex:1 单行省略推左，动作按钮 flex:none 靠右、gap 6；
                            「生成」用主题 primary（可生成且还没有视频时），已有视频/不可生成才是次级描边。 */}
                        <div className="mt-auto flex items-center gap-1.5 border-t border-border/70 pt-2"
                            onClick={(e) => {
                                // 底栏空白也算卡体：单击选中本段（⌘多选/Shift 连选），避免大片区域点了没反应。
                                if ((e.target as HTMLElement).closest("button, a, input, label")) return;
                                selectSurface(e);
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
                            data-studio-segment-foot>
                            <Dropdown
                                trigger={["click"]}
                                disabled={!videoModelOptions.length || !onSetSegmentVideoModel}
                                menu={{
                                    selectedKeys: [segmentVideoModels[c.id] || config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL],
                                    items: videoModelOptions.map((value) => ({ key: value, label: modelLabel(value) })),
                                    onClick: ({ key }) => void handleChangeVideoModel(c.id, key),
                                } satisfies MenuProps}
                            >
                                <button type="button" onClick={(e) => { e.stopPropagation(); setActive(c.id); }}
                                    title="点击切换本段出片视频模型（写回画布 H3 段）"
                                    style={{ fontSize: 11 }} className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-1 truncate rounded px-1 text-[11px] text-muted-foreground/80 transition hover:bg-foreground/5 hover:text-foreground", changingModel === c.id && "opacity-60")}
                                    data-studio-segment-video-model>
                                    <span className="truncate">{changingModel === c.id ? "切换中…" : modelsLoading ? "读取模型…" : modelLabel(segmentVideoModels[c.id] || config.videoModel || "")}</span>
                                </button>
                            </Dropdown>
                            <button type="button" onClick={async (e) => {
                                e.stopPropagation();
                                // 暂停不是硬闸门：先自动恢复制作，再打开画布生成该段。
                                if (paused && onAutoResume) {
                                    try { await onAutoResume(); } catch (error) { return void message.error(`恢复制作失败：${(error as Error).message}`); }
                                }
                                setSelected(new Set([c.id])); setActive(c.id); onOpenCanvas(c.id);
                            }}
                                disabled={busy || !c.prompt || videoBusy}
                                title={paused ? "已暂停：点击会先自动继续制作，再生成该段" : videoBusy ? `本段${videoBusyLabel}` : !c.prompt ? "先撰写或确认本段视频提示词" : c.hasVideo ? "重新调用视频模型生成本段，会产生新的费用" : "在画布中打开本段并按段生成视频（画布已定位到该段）"}
                                style={{ fontSize: 12, color: c.prompt && !c.hasVideo ? "var(--background)" : undefined }} className={cn("flex h-[30px] shrink-0 cursor-pointer items-center gap-[7px] rounded-[8px] px-[7px] text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
                                    c.prompt && !c.hasVideo
                                        ? "bg-primary hover:bg-primary/90"
                                        : "border border-border text-foreground/85 hover:border-foreground/25 hover:bg-foreground/[0.04]")}
                                data-studio-segment-generate data-studio-segment-generating={videoBusy ? "1" : undefined}>
                                <Play className="size-3" /> {videoBusy ? videoBusyLabel : c.state.tone === "blocked" ? "等上一段" : c.hasVideo ? "重新生成" : "生成"}
                            </button>
                        </div>
                    </section>
                    );
                })}
            </div>
                {prerunReport && prerunBannerView ? (
                    <div className="mt-2 rounded-lg border border-border bg-card px-3 py-2" data-studio-prerun-report>
                        <div className="flex items-center gap-2">
                            <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", PRERUN_TONE_CLASS[prerunBannerView.tone])}>{PRERUN_TONE_LABEL[prerunBannerView.tone]}</span>
                            <span className="text-[11px] text-foreground">{prerunBannerView.text}</span>
                            <button type="button" onClick={() => setPrerunReport(null)} className="ml-auto text-muted-foreground hover:text-foreground" data-studio-prerun-close>关闭</button>
                        </div>
                        <div className="mt-1.5 max-h-44 space-y-1 overflow-auto">
                            {prerunReport.items.map(item => {
                                const tone = prerunTone(item.status);
                                return (
                                    <div key={item.segmentId || item.index} className={cn("rounded border px-2 py-1", PRERUN_TONE_CLASS[tone])} data-studio-prerun-item>
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">第 {item.index + 1} 段</span>
                                            <span className="truncate text-muted-foreground">{item.title}</span>
                                            <span className="ml-auto shrink-0">{PRERUN_TONE_LABEL[tone]}</span>
                                        </div>
                                        {item.issues?.length ? (
                                            <ul className="mt-0.5 list-inside list-disc opacity-90">{item.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                        {prerunReport.notes.length ? <div className="mt-1.5 text-[10px] text-muted-foreground">{prerunReport.notes.join("；")}</div> : null}
                        <div className="mt-1 text-[10px] text-muted-foreground">{prerunReport.next}</div>
                    </div>
                ) : null}

                {/* 影策 .drama-kbd-hint（storyboard.tsx:460）：滚动内容末尾的一行快捷键提示，
                    只有滚到底才看到；键盘行为由 window keydown 监听承载，这里只是视觉提示。 */}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[11px] text-muted-foreground" data-studio-kbd-hint>
                    {([
                        ["⌘ A", "全选"],
                        ["⌘", "单击 多选"],
                        ["⇧", "单击 / ⇧←→ 连选"],
                        ["X / 空格", "选中当前"],
                        ["J K /方向键", "切换"],
                        ["Enter", "打开"],
                        ["Esc", "取消选择"],
                    ] as const).map(([keycap, label]) => (
                        <span key={keycap + label} className="inline-flex items-center gap-1">
                            <kbd style={{ fontSize: 10 }} className="inline-flex h-[18px] items-center rounded-[4px] border border-border bg-muted/60 px-1 font-medium leading-none text-foreground/80">{keycap}</kbd>
                            <span>{label}</span>
                        </span>
                    ))}
                </div>
            </div>
            <Modal
                open={Boolean(promptResult)}
                onCancel={() => setPromptResult(null)}
                title="段视频提示词（已写入画布）"
                footer={<button type="button" onClick={() => setPromptResult(null)} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground">完成</button>}
                width={720}
            >
                <p className="mb-2 text-xs text-muted-foreground">由文本模型按本段镜头、台词与参考图撰写，已写回画布 H3 段的提示词，可直接用于生成视频。</p>
                <Input.TextArea value={promptResult?.text || ""} readOnly autoSize={{ minRows: 12, maxRows: 22 }} className="font-mono text-[11px]" data-studio-written-prompt />
                {promptResult?.warnings.length ? <p className="mt-2 text-xs text-amber-500">参考图告警：{promptResult.warnings.join("、")}</p> : null}
            </Modal>

            {/* 影策段编辑弹窗：镜头 / 提示词 / 参考图 / 生成入口（真实读写，数据均来自本段制作稿与画布） */}
            {/* 编辑器内 Esc = 放弃本次修改（RichPromptEditor onEscape）；dirty 时仍禁用 antd 自带的 Esc 关窗，
                避免连按把整段改动关掉——失焦自动保存已覆盖正常写回路径。 */}
            <Modal
                open={editIdx !== null}
                onCancel={() => guardPromptDiscard(() => setEditIdx(null))}
                keyboard={!promptDirty}
                width={1360}
                centered
                data-studio-segment-editor
                // 影策 .drama-sd-head / .drama-sdx-main / .drama-sdx-side 的内边距：弹窗容器留白归零，改由头部与两列各自持有。
                styles={{
                    container: { padding: 0 },
                    header: { padding: "16px 16px 12px 20px", borderBottom: "1px solid var(--border)" },
                    footer: { padding: "12px 20px 16px" },
                }}
                title={editIdx !== null && cards[editIdx] ? (
                    <span className="flex items-start gap-3 pr-10">
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="text-[11px] font-semibold leading-[1.62] text-muted-foreground">第 {ep.no} 集 · 第 {editIdx + 1} / {cards.length} 段 · 镜头 {cards[editIdx].shots.length ? `1–${cards[editIdx].shots.length}` : "—"}</span>
                            <span className="flex flex-wrap items-center gap-2 pb-2">
                                <span className="text-[16px] font-semibold leading-[1.3]">{cards[editIdx].title}</span>
                                <span className="text-[11px] text-muted-foreground">总时长 {formatClipSec(cards[editIdx].sec)}</span>
                                <span className={cn("inline-flex h-[22px] items-center rounded-full px-2 text-[11px] font-semibold", cards[editIdx].state.tone === "ready" ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-500" : cards[editIdx].state.tone === "stale" ? "bg-amber-500/12 text-amber-600 dark:text-amber-500" : cards[editIdx].state.tone === "failed" ? "bg-rose-500/12 text-rose-500" : "bg-foreground/[0.06] text-muted-foreground")}>{compactStateLabel(cards[editIdx].state.label)}</span>
                                <span className="text-[11px] text-muted-foreground">{cards[editIdx].shots.length} 镜</span>
                            </span>
                        </span>
                        {/* 影策 segment-dialog 头部动作：精修镜头下拉 + 上一段/下一段，和关闭按钮同一行。 */}
                        <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <button type="button" onClick={() => { const card = cards[editIdx]; if (card) { setSelected(new Set([card.id])); onOpenCanvas(card.id); } }}
                                style={{ fontSize: 13 }} className="flex h-[34px] items-center gap-[6px] rounded-[8px] border border-border px-2 text-muted-foreground transition hover:border-foreground/25 hover:text-foreground" data-studio-seg-refine>
                                <Wand2 className="size-4" /> 精修镜头
                            </button>
                            <button type="button" aria-label="上一段" disabled={editIdx === null || editIdx <= 0}
                                onClick={() => { const i = (editIdx ?? 0) - 1; guardPromptDiscard(() => openPromptSegment(i)); }}
                                className="grid size-[34px] place-items-center rounded-[8px] border border-border text-muted-foreground transition hover:border-foreground/25 hover:text-foreground disabled:opacity-40" data-studio-seg-prev>‹</button>
                            <button type="button" aria-label="下一段" disabled={editIdx === null || editIdx >= cards.length - 1}
                                onClick={() => { const i = (editIdx ?? 0) + 1; guardPromptDiscard(() => openPromptSegment(i)); }}
                                className="grid size-[34px] place-items-center rounded-[8px] border border-border text-muted-foreground transition hover:border-foreground/25 hover:text-foreground disabled:opacity-40" data-studio-seg-next>›</button>
                        </span>
                    </span>
                ) : "段编辑"}
                footer={
                    <div className="flex items-center justify-between">
                        <div className="flex gap-1">
                            <button type="button" disabled={editIdx === null || editIdx <= 0} onClick={() => { const i = (editIdx ?? 0) - 1; guardPromptDiscard(() => openPromptSegment(i)); }} style={{ fontSize: 12 }} className="h-7 rounded-[8px] border border-border px-2 text-muted-foreground disabled:opacity-40">‹ 上一段</button>
                            <button type="button" disabled={editIdx === null || editIdx >= cards.length - 1} onClick={() => { const i = (editIdx ?? 0) + 1; guardPromptDiscard(() => openPromptSegment(i)); }} style={{ fontSize: 12 }} className="h-7 rounded-[8px] border border-border px-2 text-muted-foreground disabled:opacity-40">下一段 ›</button>
                        </div>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => guardPromptDiscard(() => setEditIdx(null))} style={{ fontSize: 12 }} className="h-7 rounded-[8px] border border-border px-3 text-muted-foreground">关闭</button>
                            <button type="button" onClick={() => onOpenCanvas(cards[editIdx ?? -1]?.id)} style={{ fontSize: 12 }} className="h-7 rounded-[8px] border border-border px-3 text-muted-foreground" data-studio-seg-to-canvas>在画布中精修</button>
                            {/* 影策 segment-dialog.tsx:747 没有「保存提示词」按钮：失焦/⌘↵ 自动保存，这里不再放显式按钮。 */}
                        </div>
                    </div>
                }
            >
                {editIdx !== null && cards[editIdx] ? (() => {
                    const c = cards[editIdx];
                    // 逐镜卡片的对白取导演源稿 utterance 真值（新稿 utterance_refs / 老稿 dialogues）。
                    const editorDraft = (production?.draft || {}) as Record<string, any>;
                    const editorSource = (editorDraft.director?.source || {}) as Source;
                    // 影策 SegmentReceipt「生成依据回执」：常驻展开，每行只写本次生成实际读到的真值（state.references / 段模型能力 / 剧目设置）。
                    const receiptRows: Array<{ key: string; tone: "ok" | "warn" | "info"; text: string }> = (() => {
                        const out: Array<{ key: string; tone: "ok" | "warn" | "info"; text: string }> = [];
                        const totalRefs = c.thumbnails.length;
                        const sent = c.thumbnails.filter((t: any) => t.sent === true).length;
                        const hasSentTruth = c.thumbnails.some((t: any) => typeof t.sent === "boolean");
                        if (totalRefs) {
                            out.push(hasSentTruth
                                ? { key: "references", tone: sent === totalRefs ? "ok" : "warn", text: `参考图实发：${sent}/${totalRefs} 张` }
                                : { key: "references", tone: "info", text: `参考图 ${totalRefs} 张` });
                        }
                        const parallel = studioGenSettings.continuationMode === "parallel";
                        const prevCard = editIdx !== null && editIdx > 0 ? cards[editIdx - 1] : undefined;
                        if (editIdx === 0) {
                            out.push({ key: "firstFrame", tone: "info", text: "首帧：无（第 1 段）" });
                            out.push({ key: "mode", tone: "info", text: `生成方式：${totalRefs ? "图生参考（参考图 + 提示词）" : "文生视频（按提示词生成）"}` });
                        } else if (c.firstFrame) {
                            // 画布上一段已开尾帧参考：首帧真值是那段截下来的尾帧图片（tailFrameAnchor），
                            // 不再按剧目设置推断「有没有首帧」。
                            if (c.firstFrame.url) {
                                out.push({ key: "firstFrame", tone: "ok", text: `首帧：第 ${c.firstFrame.fromSegment} 段尾帧（画布尾帧参考已开）` });
                                out.push({ key: "mode", tone: "info", text: "生成方式：图生视频（上一段尾帧作首帧）" });
                            } else {
                                out.push({ key: "firstFrame", tone: "warn", text: `首帧：第 ${c.firstFrame.fromSegment} 段已开尾帧参考，但还没截到尾帧（等上一段出片或重跑）` });
                                out.push({ key: "mode", tone: "info", text: "生成方式：接上一段尾帧（待截帧）" });
                            }
                        } else if (parallel) {
                            out.push({ key: "firstFrame", tone: "info", text: "首帧：无（各段独立生成，不接上一段尾帧）" });
                            out.push({ key: "mode", tone: "info", text: "生成方式：文生视频/图生参考（剧目设置各段独立）" });
                        } else if (prevCard?.hasVideo) {
                            out.push({ key: "firstFrame", tone: "ok", text: `首帧：第 ${editIdx ?? 0} 段视频最后一帧` });
                            out.push({ key: "mode", tone: "info", text: "生成方式：图生视频（上一段尾帧作首帧）" });
                        } else {
                            out.push({ key: "firstFrame", tone: "warn", text: `首帧：第 ${editIdx ?? 0} 段还没有成片，暂无可接的尾帧` });
                            out.push({ key: "mode", tone: "info", text: "生成方式：接上一段尾帧（待上一段出片）" });
                        }
                        out.push({ key: "duration", tone: "info", text: `时长：${formatClipSec(c.sec)}${editingSegMaxSeconds ? `（模型单次最长 ${editingSegMaxSeconds} 秒）` : ""}` });
                        const ratio = studioGenSettings.videoAspectRatio;
                        const resolution = studioGenSettings.videoResolution;
                        if (ratio || resolution) {
                            const aspectText = ratio && resolution ? `${ratio}（按 ${resolution} 出片）` : ratio ? ratio : `模型默认（按 ${resolution} 出片）`;
                            out.push({ key: "aspect", tone: "info", text: `画面：${aspectText}` });
                        }
                        // 声音行：能力链默认「视频模型都能出声」，只有显式登记 generateAudio:false 才显示无声；模型未知时才不渲染。
                        const audio = modelVideoCapabilitiesOf(config, editingSegModel).generateAudio;
                        if (typeof audio === "boolean") {
                            out.push({ key: "audio", tone: audio ? "ok" : "warn", text: `声音：${audio ? "模型同步生成对白与音效" : "所选模型不出声，本段视频没有对白与音效"}` });
                        }
                        out.push({ key: "model", tone: "info", text: `视频模型：${modelsLoading ? "读取中…" : modelLabel(segmentVideoModels[c.id] || config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL)}` });
                        out.push(c.prompt
                            ? { key: "prompt", tone: "ok", text: "提示词：已就绪" }
                            : { key: "prompt", tone: "warn", text: "提示词：未就绪" });
                        return out;
                    })();
                    const receiptBlock = (
                        <div className="rounded-[8px] border border-border bg-card/60 p-3" data-studio-receipt-block>
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                <span className="text-[11px] font-semibold text-foreground">生成依据回执</span>
                                <span className="text-[11px] text-muted-foreground">本次生成实际读到的真值，只读</span>
                            </div>
                            <div className="space-y-1 text-[11px] leading-relaxed" data-studio-receipt-list>
                                {receiptRows.map((row) => (
                                    <div key={row.key} className="flex items-start gap-1.5" data-studio-receipt-row={row.key} data-studio-receipt-tone={row.tone}
                                        data-studio-seg-receipt-audio={row.key === "audio" ? (row.tone === "ok" ? "true" : "false") : undefined}>
                                        <span aria-hidden className={cn("w-3 shrink-0 text-center font-semibold", row.tone === "ok" ? "text-emerald-500" : row.tone === "warn" ? "text-amber-500" : "text-muted-foreground")}>
                                            {row.tone === "ok" ? "✓" : row.tone === "warn" ? "⚠" : "ⓘ"}
                                        </span>
                                        <span className={cn("min-w-0 flex-1", row.tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground/80")}>{row.text}</span>
                                    </div>
                                ))}
                            </div>
                            {/* 影策 SegmentReceipt：后端聚合的编译回执，展开时才读 clip_workbench（runtime/context），只读不写。 */}
                            <details key={`seg-receipt-${c.id}`} className="mt-2 border-t border-border pt-2 text-[10px] leading-relaxed text-muted-foreground" data-studio-seg-receipt
                                onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) loadSegmentReceipt(c.id); }}>
                                <summary className="cursor-pointer text-[11px] font-medium text-foreground">后端编译回执（只读）</summary>
                                <div className="mt-1.5 space-y-0.5">
                                    {(() => {
                                        const receipt = segmentReceipts[c.id];
                                        // 懒加载态：只有展开后才请求，请求前/请求中不展示任何推断值。
                                        if (!receipt || receipt.loading) return <p>正在读取本次生成依据…</p>;
                                        if (receipt.error) return <p className="text-rose-500" role="alert">读取本次生成依据失败：{receipt.error}</p>;
                                        const workbench = receipt.workbench || {};
                                        const artifacts = Array.isArray(workbench.runtime?.directorArtifacts) ? workbench.runtime.directorArtifacts as Array<Record<string, any>> : [];
                                        // 优先当前有效的编译回执；没有 current 时退回最后一条，并如实标注「非当前」。
                                        const artifact = artifacts.find((item) => item?.current === true) || artifacts[artifacts.length - 1];
                                        const refs = Array.isArray(artifact?.references) ? artifact.references as Array<Record<string, any>> : [];
                                        const subjects = Array.isArray(workbench.context?.resolvedSubjects) ? workbench.context.resolvedSubjects as Array<Record<string, any>> : [];
                                        const latestVersion = segmentVersions.reduce<StudioSegmentVersion | null>((best, item) =>
                                            !best || (Date.parse(item.startedAt || "") || 0) > (Date.parse(best.startedAt || "") || 0) ? item : best, null);
                                        // 模型/时间只取本段已加载真值（画布段 selectedVideoModel / generation_logs 版本），无值不渲染。
                                        const model = segmentVideoModels[c.id] || latestVersion?.model || "";
                                        const generatedAt = latestVersion?.startedAt || "";
                                        const refName = (ref: Record<string, any>) => String(ref.label || ref.role || ref.assetId || ref.storageKey || "未命名").slice(0, 60);
                                        return (
                                            <>
                                                {artifact?.sha256
                                                    ? <p>提示词指纹 <span className="font-mono text-foreground/80">{String(artifact.sha256).slice(0, 8)}</span></p>
                                                    : <p>提示词指纹：本段还没有编译回执</p>}
                                                {artifact ? <p>回执状态 {String(artifact.status || "未知")} · {artifact.current === true ? "当前有效" : "非当前（源稿或参考图已变更）"}</p> : null}
                                                <p>回执参考图 {refs.length} 张{refs.length ? `（${refs.map(refName).join("、")}）` : ""}</p>
                                                {subjects.length ? <p>参考对象 {subjects.length} 个（{subjects.map((subject) => String(subject.entityRef?.id || subject.id || "未命名")).join("、")}）</p> : null}
                                                {model ? <p>当前段模型 {prettyModelName(model)}</p> : null}
                                                {generatedAt ? <p>最近成功生成 {new Date(generatedAt).toLocaleString("zh-CN", { hour12: false })}</p> : null}
                                                {!artifact && !refs.length ? <p>后端回执里没有本段的编译产物与参考图记录。</p> : null}
                                            </>
                                        );
                                    })()}
                                    {/* 前端本段真实绑定回执：随请求发送的参考图编号与续接模式（与原 SegmentReceipt 同源计算）。 */}
                                    <p>
                                        随请求发送 {c.thumbnails.length} 张参考图；提示词引用：
                                        {(() => {
                                            const tokens = Array.from(new Set((editPrompt.match(/<Picture\s*\d+\s*>/gi) || []).map(s => s.replace(/\s+/g, " ").toLowerCase()))).sort();
                                            return tokens.length ? tokens.join("、") : "未显式引用编号（由提示词正文描述）";
                                        })()}
                                        。{studioGenSettings.continuationMode === "parallel" ? "各段独立生成，不依赖上一段尾帧。" : "第 2 段起以上一段尾帧为锚帧。"}
                                    </p>
                                </div>
                            </details>
                        </div>
                    );
                    // 影策「本段镜头」（左列底部）：逐镜卡片的字段与操作全部来自 shots[] 真值，操作复用剧本页的 production op。
                    const shotSceneNames = new Map<string, string>();
                    for (const sc of rows(editorSource.scene_registry)) if (str(sc.id)) shotSceneNames.set(str(sc.id), str(sc.name || sc.heading || sc.title));
                    const secText = (value: number) => Number.isInteger(value) ? `${value}s` : formatClipSec(value);
                    const shotsBlock = (
                        <div className="rounded-[8px] border border-border bg-card/60 p-3" data-studio-shots-block>
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                <span className="text-[11px] font-semibold text-foreground">本段镜头</span>
                                <span className="text-[11px] text-muted-foreground">改动镜头后本段提示词与视频需要重新生成</span>
                            </div>
                            {/* 影策段弹窗里「本段镜头」不单独限高：整列跟随弹窗滚动（.drama-sdx-main overflow-y-auto），
                                这里再加 max-h + 内滚动会出现“框内滚动条 + 内容被裁”的双滚动。 */}
                            <div className="space-y-2 rounded-[8px] border border-border p-2.5" data-studio-seg-shot-cards>
                                {c.shots.map((sh: any, si: number) => {
                                    const frames = Number(sh?.duration_frames || sh?.durationMs || 0);
                                    const startFrame = c.shots.slice(0, si).reduce((sum: number, prev: any) => sum + Number(prev?.duration_frames || prev?.durationMs || 0), 0);
                                    const cam = sh?.camera && typeof sh.camera === "object" ? sh.camera : {};
                                    const lines = utterancesOfShot(editorSource, sh);
                                    const kind = lines.length ? "对白" : str(sh?.action) ? "动作" : str(sh?.visual) ? "画面" : "";
                                    const shotId = str(sh?.id);
                                    const movement = str(cam.movement) || str(cam.description) || str(sh?.movement);
                                    const scene = str(sh?.scene_name) || shotSceneNames.get(str(sh?.scene_id)) || str(sh?.scene) || str(sh?.scene_id);
                                    const framing = str(cam.framing);
                                    const editing = Boolean(shotId) && editingShotId === shotId;
                                    const shotView: ScreenplayShot = {
                                        no: String(si + 1).padStart(2, "0"), id: shotId, title: str(sh?.title), visual: str(sh?.visual),
                                        framing, movement: str(cam.movement) || str(cam.description), sec: frames / fps, durationFrames: frames,
                                        action: str(sh?.action), imagePrompt: str(sh?.imagePrompt), transition: str(sh?.transition),
                                        sourceQuote: str(sh?.sourceQuote), lines,
                                    };
                                    const fields: Array<[string, string]> = [
                                        ["景别", [framing ? framingLabel(framing) : "", movement].filter(Boolean).join(" · ") || "—"],
                                        ["场景", scene || "—"],
                                        ["画面", str(sh?.visual) || "—"],
                                        ["动作", str(sh?.action) || "—"],
                                        // 运镜真值 = camera.description；镜内动作+运镜时序在 shot.videoPrompt。都没有才留「—」。
                                        ["运动", str(cam.description) || str(sh?.videoPrompt) || "—"],
                                        ["对白", lines.length ? lines.map((ln) => `${ln.speaker ? `${ln.speaker}：` : ""}${ln.text}`).join("；") : "无"],
                                    ];
                                    return (
                                        <div key={shotId || si} className="rounded-[8px] border border-border/70 bg-muted/15 px-3 py-2.5 text-[11px] leading-[1.7]" data-studio-shot-id={shotId} data-studio-seg-shot-card={si} data-studio-shot-card={si}>
                                            <div className="flex flex-wrap items-start justify-between gap-1.5">
                                                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[10px] font-medium">{si + 1}</span>
                                                    {kind ? <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">{kind}镜头</span> : null}
                                                    <span className="font-mono text-[10px] text-muted-foreground" title="起止时间（duration_frames / fps）" data-studio-shot-time>{secText(startFrame / fps)}–{secText((startFrame + frames) / fps)}</span>
                                                    <span className="font-mono text-[10px] text-muted-foreground" title="本镜时长（duration_frames / fps）" data-studio-shot-duration>{secText(frames / fps)}</span>
                                                    {str(sh?.title) ? <span className="min-w-0 truncate text-[10px] text-muted-foreground">{str(sh.title)}</span> : null}
                                                </div>
                                                <div className="flex shrink-0 flex-wrap items-center gap-1" data-studio-shot-actions>
                                                    {onDiscussShot ? (
                                                        <button type="button" onClick={() => onDiscussShot({ title: str(sh?.title), visual: str(sh?.visual), camera: sh?.camera, duration_seconds: frames / fps, dialogues: sh?.dialogues })}
                                                            className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted/60" data-studio-shot-discuss>
                                                            <MessageCircle className="size-3" /> 与小影讨论
                                                        </button>
                                                    ) : null}
                                                    {shotId ? (
                                                        <button type="button" disabled={savingShot} onClick={() => insertShot(shotId)}
                                                            title="在当前镜头后插入一个新镜头（写入制作稿）"
                                                            className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50" data-studio-shot-insert>
                                                            + 镜
                                                        </button>
                                                    ) : null}
                                                    {shotId ? (
                                                        <Popconfirm title="删除这个镜头？" description="删除后本段提示词与视频需要重新生成；此操作写入制作稿。"
                                                            okText="删除" cancelText="取消" okButtonProps={{ danger: true }} disabled={savingShot || c.shots.length <= 1}
                                                            onConfirm={() => deleteShot(shotId)}>
                                                            <button type="button" disabled={savingShot || c.shots.length <= 1}
                                                                title={c.shots.length <= 1 ? "这是本段唯一的镜头，删除会改变分段；可以改写内容或重新改编本集" : "删除这个镜头（写入制作稿）"}
                                                                className="flex h-6 items-center gap-1 rounded border border-rose-200 px-1.5 text-[10px] text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:hover:bg-rose-500/10" data-studio-shot-delete>
                                                                <Trash2 className="size-3" /> 删除
                                                            </button>
                                                        </Popconfirm>
                                                    ) : null}
                                                    {shotId ? (
                                                        <button type="button" disabled={savingShot} onClick={() => setEditingShotId(editing ? null : shotId)}
                                                            className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50" data-studio-shot-edit>
                                                            <Pencil className="size-3" /> {editing ? "收起" : "编辑"}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </div>
                                            <div className="mt-2 grid gap-0.5 text-[11px] leading-[1.7] text-foreground/85" data-studio-shot-card-fields>
                                                {fields.map(([label, value]) => (
                                                    <div key={label} className="grid grid-cols-[40px_minmax(0,1fr)] gap-2">
                                                        <span className="text-muted-foreground">{label}</span>
                                                        <span className="min-w-0 break-words">{value}</span>
                                                    </div>
                                                ))}
                                            </div>
                                            {editing ? (
                                                <div className="mt-2 border-t border-border pt-2" data-studio-shot-editor onClick={(e) => e.stopPropagation()}>
                                                    <ShotEditor
                                                        key={shotId}
                                                        shot={shotView}
                                                        fps={fps}
                                                        busy={savingShot}
                                                        isFirst={si === 0}
                                                        onPatch={(patch) => void patchShot(shotId, patch)}
                                                        onDialogueSave={(changes) => void submitShotOp(
                                                            changes.map(change => ({
                                                                type: "update_shot_dialogue" as const,
                                                                shotId,
                                                                ...(change.utteranceId ? { utteranceId: change.utteranceId } : {}),
                                                                text: change.text,
                                                                ...(change.speaker ? { speaker: change.speaker } : {}),
                                                            })),
                                                            "台词已保存，本段提示词与视频已标记为过期",
                                                        )}
                                                        onDone={() => setEditingShotId(null)}
                                                    />
                                                </div>
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                    // 影策 ReferenceBoard「本段资产」：抽成变量以便放在左主列（与影策左栏 资产 → 提示词 同构），渲染内容与内联时逐字一致。
                    const refsBoard = (
                        <div data-studio-segment-assets className="rounded-[8px] border border-border bg-card/60 p-3">
                            {/* 影策 ReferenceBoard 头部：左侧「本段资产 N 项 · 随请求发送 M 张」，右侧灰色说明取图规则。 */}
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                    <span className="font-semibold text-foreground">本段资产</span>
                                    <span className="inline-flex h-[22px] items-center rounded-full bg-muted px-2 text-[11px] font-semibold text-muted-foreground" data-studio-segment-assets-count>
                                        {c.thumbnails.length} 项 · 随请求发送 {c.thumbnails.length + (editIdx && editIdx > 0 ? 1 : 0)} 张
                                    </span>
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                    按镜头自动取 · {studioGenSettings.referenceLimit ? `本段最多发送 ${studioGenSettings.referenceLimit} 张（含首帧）` : "参考图上限由所选模型决定"}
                                </span>
                            </div>
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <button type="button" onClick={onSwitchToAssets} data-studio-seg-assets
                                    style={{ fontSize: 12 }} className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-border bg-background px-2 font-medium text-foreground transition hover:bg-muted/70">
                                    <Film className="size-3.5 text-muted-foreground" /> 项目资产窗口
                                </button>
                                <button type="button" onClick={() => { setRefManageSelected({}); setRefManageSource("episode"); setRefManageOpen(true); }} data-studio-seg-manage-refs title="从本集分集图导入"
                                    style={{ fontSize: 12 }} className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-border bg-background px-2 font-medium text-foreground transition hover:bg-muted/70">
                                    <FolderOpen className="size-3.5 text-muted-foreground" /> 从素材库导入
                                </button>
                                <button type="button" onClick={() => { setRefManageSelected({}); setRefManageSource("upload"); setRefManageOpen(true); }} data-studio-seg-upload-refs
                                    style={{ fontSize: 12 }} className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-border bg-background px-2 font-medium text-foreground transition hover:bg-muted/70">
                                    <Upload className="size-3.5 text-muted-foreground" /> 上传图片
                                </button>
                                <button type="button" onClick={onSwitchToAssets} data-studio-seg-check-refs
                                    style={{ fontSize: 12 }} className="inline-flex h-7 items-center gap-1.5 px-2 text-muted-foreground transition hover:text-foreground">
                                    按集核查
                                </button>
                            </div>
                            {c.thumbnails.length ? (
                                <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
                                    {c.thumbnails.map((t: any, ti: number) => {
                                        const missingLabel = referenceMissingLabel(t);
                                        // referenceKindOf 只接受字符串标签：用真值编号文本（如「角色1」）+ label 判定类型。
                                        const kind = referenceKindOf(`${refChipLabel(t)} ${String(t.label || "")}`);
                                        const kindStyle = REF_KIND_STYLE[kind];
                                        // 真值里的名字若只是「<图3>」这类占位编号，就不再当名字重复显示一遍。
                                        const rawName = String(t.name || "");
                                        const displayName = rawName && !/^<图\d+>$/.test(rawName) ? rawName : "";
                                        return (
                                        <div key={String(t.storageKey || ti)} className="overflow-hidden rounded-[8px] border border-border bg-card p-1" title={referenceHoverText({ ...t, ordinal: ti + 1 })}>
                                            {t.url ? <img src={t.url} alt={String(t.label || "参考图")} className="aspect-[4/3] w-full rounded-[8px] object-cover" /> : <div className="flex aspect-[4/3] w-full items-center justify-center rounded-[8px] text-[10px] text-muted-foreground">—</div>}
                                            <div className="pb-1 pt-1">
                                                {displayName ? <div className="truncate text-[11px] font-semibold text-foreground" data-studio-segment-ref-name>{displayName}</div> : null}
                                                <div className="mt-1 flex items-center gap-1">
                                                    <span className={`inline-flex h-[18px] items-center rounded-[4px] px-1 text-[11px] font-medium ${kindStyle}`} data-studio-segment-ref-kind>{REF_KIND_LABEL[kind]}</span>
                                                    <span className="truncate text-[11px] text-muted-foreground" data-studio-segment-ref-ordinal>参考图 {ti + 1}</span>
                                                </div>
                                            </div>
                                            {missingLabel ? <div className="truncate px-1 pb-1 text-[9px] text-rose-500" data-studio-segment-ref-missing>{missingLabel}</div> : null}
                                        </div>
                                        );
                                    })}
                                </div>
                            ) : <p className="text-[11px] text-muted-foreground">本段暂无参考图，可在项目资产或画布中补充。</p>}
                            {editIdx === 0 ? (
                                <p className="mt-3 text-[13px] text-muted-foreground" data-studio-segment-opening-note>开场段：无首帧，按提示词与参考图生成</p>
                            ) : null}
                        </div>
                    );
                    // 影策 ReferenceOrder「按角色分组的参考卡」：图片参考按类型分组（角色蓝 / 环境绿 / 道具琥珀），
                    // 音色派生的音频绑定（mediaType=audio）不是图片卡，不进分组，音色只挂在角色卡内。
                    const refCards = (refTruth?.bindings ?? []).filter((b) => !isVoiceReferenceBinding(b));
                    const refGroups = (["character", "scene", "prop", "other"] as const)
                        .map((kind) => ({ kind, items: refCards.filter((b) => refBindingKind(b) === kind) }))
                        .filter((group) => group.items.length > 0);
                    const enabledVoiceCount = segmentVoices.filter((v) => v.enabled).length;
                    const atVoiceLimit = Boolean(voiceTruth && voiceTruth.audioLimit > 0 && enabledVoiceCount >= voiceTruth.audioLimit);
                    const voiceByGroupId = new Map(segmentVoices.map((v) => [v.groupId, v] as const));
                    // 参考卡真名：绑定 label 常只是 <Picture N>，按 storageKey 合上本段 thumbnails 的资产真名（不编造）。
                    const refNameOf = (binding: SegmentReferenceView) => {
                        const thumbs = Array.isArray(c.thumbnails) ? c.thumbnails as Array<Record<string, any>> : [];
                        const thumb = thumbs.find((t) => Boolean(t?.storageKey) && String(t.storageKey) === binding.storageKey);
                        const raw = String(thumb?.name || binding.name || "").trim();
                        return /^<图\d+>$/.test(raw) ? "" : raw;
                    };
                    // 参考卡 ↔ 音色组：优先 groupId（同一角色组派生视图），绑定没有 groupId 时按角色真名对上；
                    // 都对不上就是「未绑定音色」，卡内如实显示 + 音色已关闭，绝不编造音色名。
                    const voiceOfCard = (binding: SegmentReferenceView) => {
                        if (refBindingKind(binding) !== "character") return undefined;
                        const byId = binding.groupId ? voiceByGroupId.get(binding.groupId) : undefined;
                        if (byId) return byId;
                        const cardName = refNameOf(binding);
                        if (!cardName) return undefined;
                        return segmentVoices.find((v) => v.name === cardName);
                    };
                    const voiceSeen = new Set<string>();
                    return (
                        <div className="max-h-[calc(100vh-200px)]">
                        {/* 影策 .drama-sdx-body：主列 1fr + 侧列 340px，两列各自滚动。 */}
                        <div className="grid h-[min(780px,100vh-270px)] grid-cols-[minmax(0,1fr)_340px]">
                            <div className="thin-scrollbar min-h-0 space-y-3 overflow-y-auto pb-5 pl-5 pr-5 pt-4">
                                {/* 生成控制条：段模型取画布 selectedVideoModel→全局→默认，时长取本段镜头 duration_frames/fps 求和，
                                    画幅/分辨率取剧目级制作设置（标注来源，不冒充段级参数）。本地出片在画布，故不放假的生成按钮。 */}
                                <div className="flex min-h-[62px] flex-wrap items-center gap-2 rounded-[8px] border border-border/60 bg-muted/20 px-3 py-3 text-[11px]" data-studio-seg-gen-bar>
                                    <span className="font-semibold text-muted-foreground">生成设置</span>
                                    {/* 影策 SegmentToolbar 的 DramaModelPicker：本段视频模型（只对本段生效）。 */}
                                    <span className="inline-flex h-8 items-center rounded-[8px] border border-border bg-background px-2 text-[11px] font-semibold text-muted-foreground" title={`本段视频模型（只对本段生效）：${editingSegModel}`}>
                                        <select value={editingSegModel} aria-label="视频模型" data-studio-seg-model
                                            disabled={!videoModelOptions.length || !onSetSegmentVideoModel || changingModel === c.id}
                                            onChange={(e) => { const value = e.target.value; if (value && value !== editingSegModel) void handleChangeVideoModel(c.id, value); }}
                                            style={{ fontSize: 11 }} className="max-w-[220px] bg-transparent outline-none disabled:opacity-50">
                                            {!videoModelOptions.includes(editingSegModel) ? <option value={editingSegModel}>{modelLabel(editingSegModel)}</option> : null}
                                            {videoModelOptions.map((value) => <option key={value} value={value}>{modelLabel(value)}</option>)}
                                        </select>
                                    </span>
                                    <span className="inline-flex h-[22px] items-center rounded border border-border bg-background px-2 text-[11px] font-semibold tabular-nums text-muted-foreground" title={editingSegMaxSeconds ? `按本段镜头时长生成；模型单次最长 ${editingSegMaxSeconds} 秒` : "按本段镜头时长生成"}>{formatClipSec(c.sec)}</span>
                                    {studioGenSettings.videoAspectRatio ? <span className="inline-flex h-[22px] items-center rounded border border-border bg-background px-2 text-[11px] font-semibold text-muted-foreground" title="画幅随作品设置，开工后不能修改（剧目级 videoAspectRatio）">{studioGenSettings.videoAspectRatio}</span> : null}
                                    <span className="inline-flex h-[22px] items-center rounded border border-border bg-background px-2 text-[11px] font-semibold text-muted-foreground" title="本段实际出片分辨率（剧目级 videoResolution）">{studioGenSettings.videoResolution || "模型默认"}</span>
                                </div>
                                {refsBoard}
                                    <details className="mt-3 rounded-[8px] border border-border p-2" data-studio-segment-reference-policy aria-busy={refLoading || voicesLoading}>
                                        <summary className="cursor-pointer text-[11px] font-semibold text-muted-foreground">参考顺序与角色音色（展开可排序 / 启停）</summary>
                                        <div className="mt-3">
                                        {/* 影策 ReferenceOrder：块级「刷新 / 恢复自动参考」+ 整段级音色模式（模式是段级语义，从右栏迁到块头）。 */}
                                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="text-[11px] text-muted-foreground">参考 {refCards.length} 个</span>
                                                <span className="text-[11px] text-muted-foreground" data-studio-ref-mode>（{refTruth?.mode === "manual" ? "手动" : "自动"}）</span>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <button type="button" aria-label="刷新参考图与音色真值" onClick={() => { setRefReload(n => n + 1); setVoiceReload(n => n + 1); }} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" data-studio-refs-refresh data-studio-voices-refresh><RefreshCw className="size-3" /> 刷新</button>
                                                {refTruth?.mode === "manual" ? (
                                                    <button type="button" disabled={Boolean(refBusy)} onClick={() => void handleReferenceRestoreAuto()} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50" data-studio-refs-restore-auto><RotateCcw className="size-3" /> 恢复自动参考</button>
                                                ) : null}
                                            </div>
                                        </div>
                                        {/* 音色模式（对白自动 / 手动指定）与恢复自动音色：影策语义是整段级，随块头常驻。 */}
                                        <div className="mb-1.5 mt-1 flex flex-wrap items-center gap-1.5" data-studio-voice-mode>
                                            <span className="text-[10px] text-muted-foreground">音色模式</span>
                                            <button type="button" aria-pressed={voiceTruth?.audioReferenceMode === "auto"} disabled={voiceModeBusy}
                                                onClick={() => void handleSetVoiceMode("auto")}
                                                className={cn("rounded border px-1.5 py-0.5 text-[10px] transition disabled:opacity-50", voiceTruth?.audioReferenceMode === "auto" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-border text-muted-foreground hover:bg-muted")}>
                                                按对白自动
                                            </button>
                                            <button type="button" aria-pressed={voiceTruth?.audioReferenceMode === "custom"} disabled={voiceModeBusy}
                                                onClick={() => void handleSetVoiceMode("custom")}
                                                className={cn("rounded border px-1.5 py-0.5 text-[10px] transition disabled:opacity-50", voiceTruth?.audioReferenceMode === "custom" ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border text-muted-foreground hover:bg-muted")}>
                                                手动指定
                                            </button>
                                            {voiceTruth?.audioReferenceMode === "custom" ? (
                                                <button type="button" disabled={voiceModeBusy} onClick={() => void handleSetVoiceMode("auto")}
                                                    className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50" data-studio-voice-restore-auto>
                                                    恢复自动
                                                </button>
                                            ) : null}
                                            <button type="button" disabled={overrideBusy !== null || !segmentVoices.some(v => v.overrideStorageKey)} onClick={() => void handleRestoreVoiceOverrides()}
                                                title="清除本段所有段级音色覆写（voiceOverrides），改回角色本体音色"
                                                className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50" data-studio-voice-restore-overrides>
                                                <RotateCcw className="size-3" /> 恢复自动音色
                                            </button>
                                        </div>
                                        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">顺序自上而下发送给视频模型；未引用项不随请求发送。上/下移与引用开关写入制作稿，恢复自动则改回源稿派生。</p>
                                        {refError ? <p className="mb-1 text-[10px] text-rose-500" role="alert">{refError}</p> : null}
                                        {voicesError ? <p className="mb-1 text-[10px] text-rose-500" role="alert">{voicesError}</p> : null}
                                        {refLoading ? (
                                            <p className="py-2 text-[11px] text-muted-foreground">读取参考图策略…</p>
                                        ) : refTruth?.bindings.length ? (
                                            <div className="space-y-3" data-studio-ref-groups>
                                                {refGroups.map((group) => (
                                                    <section key={group.kind} className="rounded-[8px] border border-border/60 bg-muted/10 p-2" data-studio-ref-group={group.kind}>
                                                        {/* 影策组头：类型徽标（角色蓝 / 环境绿 / 道具琥珀）+ N 个参考；角色组紧接着一行音色总口径。 */}
                                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                                            <span className={`inline-flex h-[18px] items-center rounded-[4px] border px-1 text-[11px] ${REF_KIND_STYLE[group.kind]}`} data-studio-ref-group-kind>{REF_KIND_LABEL[group.kind]}</span>
                                                            <span className="text-[11px] text-muted-foreground" data-studio-ref-group-count>{group.items.length} 个参考</span>
                                                        </div>
                                                        {group.kind === "character" ? (
                                                            <p className="mb-2 text-[11px] text-muted-foreground" data-studio-voice-line>
                                                                音色 {enabledVoiceCount}/{voiceTruth?.audioLimit ?? 0} · {voiceTruth?.audioReferenceMode === "custom" ? "手动指定" : "按对白自动开启"}{voiceTruth && voiceTruth.audioLimit > 0 ? ` · 当前模型音色不可多于 ${voiceTruth.audioLimit} 个` : ""}
                                                            </p>
                                                        ) : null}
                                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                                                            {group.items.map((b) => {
                                                                const i = refTruth?.bindings.findIndex((x) => x.id === b.id) ?? -1;
                                                                const kind = refBindingKind(b);
                                                                const voice = voiceOfCard(b);
                                                                const localIdx = group.items.findIndex((x) => x.id === b.id);
                                                                const prev = group.items[localIdx - 1];
                                                                const next = group.items[localIdx + 1];
                                                                // 组内排序：只与同类型相邻项交换（影策按类型分组后排序，不跨组乱序）。
                                                                const prevGlobal = prev ? (refTruth?.bindings.findIndex((x) => x.id === prev.id) ?? -1) : -1;
                                                                const nextGlobal = next ? (refTruth?.bindings.findIndex((x) => x.id === next.id) ?? -1) : -1;
                                                                const name = refNameOf(b);
                                                                const showVoiceRow = kind === "character" && (!voice || !voiceSeen.has(voice.groupId));
                                                                if (voice) voiceSeen.add(voice.groupId);
                                                                return (
                                                                <div key={b.id} className="relative overflow-hidden rounded-[8px] border border-border bg-card p-2" data-studio-ref-policy={b.id} data-studio-ref-card={b.id}>
                                                                    <div className="relative">
                                                                        {b.url ? <img src={b.url} alt="" className="aspect-[4/3] w-full rounded-[8px] object-cover" /> : <div className="grid aspect-[4/3] w-full place-items-center rounded-[8px] text-[10px] text-muted-foreground">无图</div>}
                                                                        <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white" data-studio-ref-badge>参考图 {i + 1}</span>
                                                                        {b.url ? (
                                                                            <div className="absolute right-1.5 top-1.5">
                                                                                <Popover trigger={["hover", "focus"]} mouseEnterDelay={0.2} placement="top"
                                                                                    content={<figure className="m-0 w-56"><img src={b.url} alt={`参考图 ${i + 1}`} className="max-h-64 w-full rounded object-contain" /><figcaption className="mt-1 text-[10px] text-muted-foreground">{referenceHoverText({ ordinal: i + 1, roleKind: kind, name: refNameOf(b) }).replace(/\n/g, " ")}</figcaption></figure>}>
                                                                                    <button type="button" aria-label={`放大查看参考图 ${i + 1}`} className="grid size-6 place-items-center rounded-full bg-black/60 text-white transition hover:bg-black/80"><ScanSearch className="size-3" /></button>
                                                                                </Popover>
                                                                            </div>
                                                                        ) : null}
                                                                    </div>
                                                                    <div className="pb-1 pt-1.5">
                                                                        {name ? <div className="truncate text-[13px] font-semibold text-foreground" title={name} data-studio-ref-card-name>{name}</div> : null}
                                                                        <div className="mt-1 flex flex-wrap items-center gap-1">
                                                                            <span className={`inline-flex h-[18px] items-center rounded-[4px] border px-1 text-[11px] ${REF_KIND_STYLE[kind]}`} data-studio-ref-card-kind>{REF_KIND_LABEL[kind]}</span>
                                                                            <span className="text-[11px] text-muted-foreground">{b.enabled ? "随请求发送" : "不随请求发送"}</span>
                                                                        </div>
                                                                    </div>
                                                                    <div className="mt-1 flex items-center justify-between gap-1">
                                                                        <button type="button" aria-pressed={b.enabled} disabled={Boolean(refBusy)} onClick={() => void handleReferenceToggle(b.id, !b.enabled)}
                                                                            title={b.enabled ? "点击后本段不再发送这张参考图" : "点击后重新随本段请求发送"}
                                                                            className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition disabled:opacity-50", b.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-border text-muted-foreground hover:bg-muted")}
                                                                            data-studio-ref-toggle={b.id} data-studio-ref-cited={b.enabled ? "true" : "false"}>
                                                                            {b.enabled ? <CheckCircle2 className="size-3" /> : null}{b.enabled ? "已引用" : "未引用"}
                                                                        </button>
                                                                        <div className="flex items-center gap-1">
                                                                            <button type="button" aria-label={`${REF_KIND_LABEL[kind]}组内上移 ${b.label}`} disabled={prevGlobal < 0 || Boolean(refBusy)} onClick={() => void handleReferenceMove(i, prevGlobal - i)} className="grid size-6 place-items-center rounded-full border border-border text-muted-foreground transition hover:bg-muted disabled:opacity-40" data-studio-ref-move-up={i}><ArrowUp className="size-3" /></button>
                                                                            <button type="button" aria-label={`${REF_KIND_LABEL[kind]}组内下移 ${b.label}`} disabled={nextGlobal < 0 || Boolean(refBusy)} onClick={() => void handleReferenceMove(i, nextGlobal - i)} className="grid size-6 place-items-center rounded-full border border-border text-muted-foreground transition hover:bg-muted disabled:opacity-40" data-studio-ref-move-down={i}><ArrowDown className="size-3" /></button>
                                                                        </div>
                                                                    </div>
                                                                    {showVoiceRow ? (
                                                                        <div className="mt-1.5 border-t border-border/60 pt-1.5" data-studio-ref-voice-row>
                                                                            {voice ? (
                                                                                <div className="space-y-1" data-studio-voice={voice.groupId}>
                                                                                    <div className="flex items-center justify-between gap-1">
                                                                                        <span className="truncate text-[11px] text-foreground" title={voice.voiceName || voice.name}>{voice.voiceName || "已绑定参考音频"}</span>
                                                                                        <button type="button" aria-pressed={voice.enabled} aria-label={`${voice.enabled ? "关闭" : "开启"}${voice.name}的音色`}
                                                                                            disabled={!voice.hasVoice || voiceBusy === voice.groupId || (atVoiceLimit && !voice.enabled)}
                                                                                            onClick={() => void handleToggleVoice(voice.groupId, !voice.enabled)}
                                                                                            className={cn("flex h-6 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] transition disabled:opacity-50", voice.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-border text-muted-foreground hover:bg-muted")}>
                                                                                            {voice.enabled ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
                                                                                            {voice.enabled ? "已开启" : "已关闭"}
                                                                                        </button>
                                                                                    </div>
                                                                                    <div className="flex items-center gap-1">
                                                                                        {voice.hasVoice && (voice.storageKey || voice.url) ? (
                                                                                            <button type="button" title="试听已绑定的参考音色" onClick={() => window.open(backendMediaUrl(voice.storageKey || voice.url), "_blank")}
                                                                                                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" data-studio-voice-preview>
                                                                                                试听
                                                                                            </button>
                                                                                        ) : null}
                                                                                        {/* 段级指定音色：选项来自素材库真实声音样本；写 voiceOverrides[groupId]，本体自动=清除该组覆写 */}
                                                                                        <select value={voice.overrideStorageKey} disabled={overrideBusy !== null}
                                                                                            aria-label={`为${voice.name}指定声音样本`}
                                                                                            title="段级指定音色：选一个真实声音样本写 voiceOverrides[groupId]；选「本体自动」清除该组覆写"
                                                                                            onChange={e => void handleSetVoiceOverride(voice.groupId, e.target.value)}
                                                                                            className="h-6 max-w-[110px] shrink-0 rounded border border-border bg-background px-1 text-[10px] text-muted-foreground outline-none focus:border-primary disabled:opacity-50"
                                                                                            data-studio-voice-override={voice.groupId}>
                                                                                            <option value="">本体自动</option>
                                                                                            {voiceSamples.map(s => <option key={s.storageKey} value={s.storageKey}>{s.name}</option>)}
                                                                                        </select>
                                                                                    </div>
                                                                                    <div className="truncate text-[10px] text-muted-foreground">
                                                                                        {!voice.hasVoice ? (voice.storageKey ? "已绑定音频但缺可提交的 URL，不会随请求发送" : "未绑定音色，请先在角色设定中添加参考音频") : voice.enabled ? "随本段视频请求发送（H3 参考音色）" : "不随本段视频请求发送"}{voice.overrideStorageKey ? ` · 段级指定：${voice.overrideName || voice.overrideStorageKey}` : ""}
                                                                                    </div>
                                                                                </div>
                                                                            ) : (
                                                                                <button type="button" onClick={onSwitchToAssets} title="到项目资产 / 角色设定里为本角色绑定参考音频"
                                                                                    className="flex w-full flex-col items-start gap-0.5 rounded border border-dashed border-border px-1.5 py-1 text-left transition hover:border-foreground/30 hover:bg-muted/40" data-studio-ref-voice-bind>
                                                                                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><VolumeX className="size-3" /> + 音色已关闭</span>
                                                                                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><VolumeX className="size-3" /> 无音频 · 请在角色设定中绑定音频</span>
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </section>
                                                ))}
                                            </div>
                                        ) : <p className="py-2 text-[11px] text-muted-foreground">本段画布 Clip 暂无参考绑定，暂无可排序项。</p>}
                                        {/* 段级音色 Note：未随请求发送的角色及原因（编译期与 h3-runner 写入 metadata.segments[].voiceReferenceNotes）。 */}
                                        {voiceTruth?.notes?.length ? (
                                            <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2" data-studio-voice-notes>
                                                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-amber-500">
                                                    <AlertTriangle className="size-3" /> 未随请求发送的音色（段级 Note · {voiceTruth.notes.length}）
                                                </div>
                                                <ul className="space-y-1">
                                                    {voiceTruth.notes.map((note, index) => (
                                                        <li key={`${note.groupId}:${note.code}:${index}`} className="flex items-start gap-1.5 text-[10px] leading-relaxed" data-studio-voice-note={note.groupId}>
                                                            <span className={cn("shrink-0 rounded border px-1 py-0.5 font-medium", VOICE_NOTE_STYLE[note.code])}>{VOICE_NOTE_LABEL[note.code]}</span>
                                                            <span className="min-w-0 text-muted-foreground"><b className="font-medium text-foreground">{note.characterName || note.groupId}</b>：{note.reason}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        ) : null}
                                        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                                            当前段模型「{voiceTruth?.videoModel || config.videoModel || DEFAULT_SEGMENT_VIDEO_MODEL}」参考音色上限 {voiceTruth?.audioLimit ?? 0} 个（取自模型 maxAudios 能力，非 ref2va 模式为 0）。「按对白自动」按本段台词开口顺序选中角色（最多 {voiceTruth?.audioLimit ?? 0} 个），每次编译从台词重算派生列表并写入各角色组开关；「手动指定」保留用户逐组开关，重新编译不会覆盖。超限的手工开关会被拦截，运行时若仍有超出（旧数据/派生变化）按影策写 Note 跳过而不发送。开关写入画布 H3 段，h3-runner 按模式过滤后随本段视频请求发送。
                                        </p>
                                        </div>
                                    </details>
                                <div className="space-y-2 rounded-[8px] border border-border bg-card/60 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className="text-[11px] font-semibold">完整视频提示词</span>
                                        {promptDirty ? <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400" data-studio-prompt-dirty>未保存</span> : null}
                                        {/* 影策 segment-dialog.tsx:624 的头行说明：按名称引用、双击看原图、名称对应参考图编号。 */}
                                        <span className="min-w-0 truncate text-[10px] text-muted-foreground" data-studio-prompt-mention-hint title="输入 @ 按名称引用资产，双击引用查看原图；资产名称对应当前参考图编号">输入 @ 按名称引用资产，双击引用查看原图；资产名称对应当前参考图编号</span>
                                    </span>
                                    <div className="flex shrink-0 gap-2">
                                        <button type="button" disabled={writingPrompt === c.id} onClick={() => void handleWritePrompt(c.id)} style={{ fontSize: 12 }} className="inline-flex h-7 items-center rounded-[8px] border border-border px-2 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground disabled:opacity-50" data-studio-seg-rewrite>{writingPrompt === c.id ? "撰写中…" : c.prompt ? "重新撰写提示词" : "撰写提示词"}</button>
                                        <button type="button" onClick={() => void navigator.clipboard.writeText(editPrompt).then(() => message.success("提示词已复制"))} style={{ fontSize: 12 }} className="inline-flex h-7 items-center rounded-[8px] border border-border px-2 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground" data-studio-seg-copy-prompt>复制提示词</button>
                                        <button type="button" disabled={!editPrompt} title="段提示词 + 按提交顺序编号的参考图（来自画布真实绑定，不含伪造字段）" onClick={() => void buildSegmentSubmissionFull(ep, c.id, editPrompt).then(text => navigator.clipboard.writeText(text)).then(() => message.success("提交全文已复制")).catch((error: unknown) => message.error(`复制提交全文失败：${(error as Error)?.message || "未知错误"}`))} style={{ fontSize: 12 }} className="inline-flex h-7 items-center rounded-[8px] border border-border px-2 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground disabled:opacity-50" data-studio-seg-copy-submission>复制提交全文</button>
                                        <button type="button" disabled={savingPrompt || !c.prompt} onClick={() => void handleRestorePrompt()} style={{ fontSize: 12 }} className="inline-flex h-7 items-center rounded-[8px] border border-border px-2 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground disabled:opacity-50" data-studio-seg-restore title="用模型生成的原版提示词覆盖当前手动改写">恢复模型版本</button>
                                        {/* 影策弹窗工具栏右侧主按钮「重新生成视频」：本地出片在画布，点了定位到本段画布 H3 节点。 */}
                                        <button type="button" disabled={!c.prompt || promptRefInvalid} onClick={() => { setSelected(new Set([c.id])); onOpenCanvas(c.id); }}
                                            title={!c.prompt ? "提示词就绪后才能生成视频" : promptRefInvalid ? "提示词含非法 Picture 编号，请先修正" : "在画布中定位本段 H3 节点并重新生成视频"}
                                            style={{ fontSize: 12 }} className="ml-1 flex h-7 items-center gap-[6px] rounded-[8px] bg-foreground px-2 font-medium text-background transition hover:opacity-85 disabled:opacity-50" data-studio-seg-regenerate>
                                            <Play className="size-3" /> 重新生成视频
                                        </button>
                                    </div>
                                </div>
                                {!c.prompt ? <p className="text-[11px] text-muted-foreground" data-studio-seg-prompt-hint>提示词就绪后才能生成视频</p> : null}
                                {/* 旧的一排「@引用 <图N>」chip 已删（与富编辑器引用条重复）；插入引用统一走引用条与正文 pill。 */}
                                {/* 影策 segment-dialog.tsx:747「失焦或 ⌘↵ 保存，Esc 放弃」：失焦自动写回，⌘/Ctrl+↵ 立刻保存。 */}
                                <div onBlur={autosavePrompt} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSavePrompt(); } }} data-studio-prompt-editor-wrap>
                                <RichPromptEditor
                                    value={editPrompt}
                                    onChange={(next) => setEditPrompt(next)}
                                    onEscape={() => {
                                        if (!promptDirty) return;
                                        setEditPrompt(promptBaseline);
                                        message.info("已放弃本次提示词修改");
                                    }}
                                    tokens={c.thumbnails.map((t: any, ti: number) => ({ n: Number(t.ordinal) || ti + 1, kind: str(t.roleKind) || referenceKindOf(`${refChipLabel(t)} ${String(t.label || "")}`), url: t.url, name: String(t.name || "").replace(/^<图\d+>$/, "") }))}
                                    originalText={c.shots.map((sh) => (sh as any).sourceQuote || "").filter(Boolean).join("\n")}
                                    placeholder="也可以直接在这里手写本段完整视频提示词；点引用条插入参考图，编号与本段参考图顺序一致；失焦或 ⌘↵ 自动写回画布，Esc 放弃。"
                                />
                                </div>
                                <p className={cn("text-[11px]", promptDirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} data-studio-prompt-foot>
                                    {savingPrompt ? "保存中…" : promptDirty ? "未保存 · 失焦或 ⌘↵ 保存，Esc 放弃" : "已保存到画布 H3 段，生成视频将读取最新内容"}
                                </p>
                                {/* 字数真值：统计实际提交正文（含 <Picture N>），按码点计，口径与影策 Array.from / 后端 RuneCount 一致。
                                    有模型 promptMaxChars 真值时按硬上限校验并禁止保存；无真值时回落本地软提醒。 */}
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px]" data-studio-prompt-chars>
                                    <span className={overModelLimit ? "text-rose-500" : overSoftLimit ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
                                        title="与视频模型校验口径一致：按码点计数，只统计本段提示词正文">
                                        提示词 {sentChars.toLocaleString()} 字{promptMaxChars !== null ? ` / ${promptMaxChars}` : ""}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {promptMaxChars !== null
                                            ? `视频模型上限 ${promptMaxChars} 字（取自模型能力，超限禁止保存）`
                                            : `本地软上限 ${LOCAL_PROMPT_SOFT_LIMIT_CHARS.toLocaleString()} 字（输入卫生提醒，非模型能力，不拦截保存）`}
                                    </span>
                                </div>
                                {promptMaxChars !== null ? (
                                    overModelLimit ? (
                                        <p className="text-[11px] leading-relaxed text-rose-500" role="alert" data-studio-prompt-over-model-limit>
                                            当前正文 {sentChars.toLocaleString()} 个字符，超过视频模型上限 {promptMaxChars} 个字符，请精简后再保存。
                                        </p>
                                    ) : null
                                ) : overSoftLimit ? (
                                    <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400" role="status" data-studio-prompt-soft-limit>
                                        当前正文 {sentChars.toLocaleString()} 字，已超过本地软上限 {LOCAL_PROMPT_SOFT_LIMIT_CHARS.toLocaleString()} 字。当前段出片模型未提供 promptMaxChars 真值，这里是输入卫生提醒，不会阻止保存；过长提示词可能影响生成，建议精简。
                                    </p>
                                ) : null}
                                {promptRefInvalid ? (
                                    <p className="text-[11px] leading-relaxed text-rose-500" role="alert" data-studio-prompt-invalid-ref>
                                        正文里的 {promptRefUsage.unknown.map(n => `<Picture ${n}>`).join("、")} 不是本段的参考图（本段共 {c.thumbnails.length} 张{c.thumbnails.length ? `，可用编号：${c.thumbnails.map(t => t.ordinal).join("、")}` : ""}），生成视频前请改成正确的编号，或点上方 @引用 重新插入。
                                    </p>
                                ) : promptUnmentioned.length ? (
                                    <p className="text-[11px] leading-relaxed text-muted-foreground" data-studio-prompt-unmentioned>
                                        正文还没有引用 {promptUnmentioned.map((t: any) => `${String(t.label || `图${t.ordinal}`)}（${String(t.name || t.label || "参考图")}）`).join("、")}；参考图仍会随请求发送，在正文里写明谁是谁，视频模型才不会认错。
                                    </p>
                                ) : null}
                                </div>
                                {receiptBlock}
                                {shotsBlock}
                            </div>
                            <div className="thin-scrollbar min-h-0 space-y-3 overflow-y-auto border-l border-border bg-muted/20 pb-5 pl-4 pr-5 pt-4">
                                {/* 影策 SegmentVideo：右侧内嵌播放器，真值取本段 video: 产物；无产物走占位。原版本列表保留在下方。 */}
                                <div data-studio-seg-video-preview>
                                    <div className="mb-1 flex items-center justify-between">
                                        <span className="text-[11px] font-bold">第 {editIdx !== null ? editIdx + 1 : 0} 段视频</span>
                                        <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px]", c.state.tone === "ready" ? "bg-emerald-500/15 text-emerald-500" : c.state.tone === "stale" ? "bg-amber-500/15 text-amber-500" : "bg-muted text-muted-foreground")}>{c.state.label}</span>
                                    </div>
                                    {c.videoUrl ? (
                                        <video key={c.videoUrl} src={c.videoUrl} controls playsInline preload="metadata" className="aspect-video w-full rounded-md border border-border bg-black" data-studio-seg-player />
                                    ) : (
                                        <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted/30 text-muted-foreground">
                                            <Film className="size-6" aria-hidden />
                                            <span className="text-[11px]">{c.state.label}</span>
                                            <small className="text-[10px]">{formatClipSec(c.sec)} · 对白与音效由视频模型生成</small>
                                        </div>
                                    )}
                                    {/* 影策 drama-sdx-facts：进入成片取本段真实产物时长；上次花费本地无消耗真值，显示 — 不造假。 */}
                                    <dl className="mt-2 grid grid-cols-2 gap-2" data-studio-seg-facts>
                                        <div className="rounded-[8px] border border-border bg-muted/30 px-2 py-1.5">
                                            <dt className="text-[11px] text-muted-foreground">进入成片</dt>
                                            <dd className="text-[11px] font-medium">{c.hasVideo ? formatClipSec(c.videoDuration) : "—"}</dd>
                                        </div>
                                        <div className="rounded-[8px] border border-border bg-muted/30 px-2 py-1.5">
                                            <dt className="text-[11px] text-muted-foreground">上次花费</dt>
                                            <dd className="text-[11px] font-medium" title="本地未接入消耗真值，显示 —">—</dd>
                                        </div>
                                    </dl>
                                </div>
                                
                                    <div className="mt-3 rounded-[8px] border border-border p-2" data-studio-segment-versions aria-busy={versionsLoading}>
                                        <div className="mb-1.5 flex items-center justify-between">
                                            <span className="text-[11px] font-semibold">本段视频版本（{segmentVersions.length}）</span>
                                            <button type="button" aria-label="刷新版本列表" onClick={() => setVersionReload((n) => n + 1)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" data-studio-versions-refresh>
                                                <RefreshCw className="size-3" /> 刷新
                                            </button>
                                        </div>
                                        {reprocessPreview?.reprocessable ? (
                                            <div className="mb-1.5 flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5" data-studio-segment-reprocess>
                                                <Wrench className="size-3 shrink-0 text-amber-500" />
                                                <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-amber-600 dark:text-amber-300">已生成视频但后处理未回写（{reprocessPreview.code || reprocessPreview.status || "可重跑"}）。重跑只用冻结参数核验并回写同一文件，不调模型、不扣费。</span>
                                                <button type="button" disabled={reprocessBusy === editingSegmentId} onClick={() => void handleReprocess()}
                                                    className="shrink-0 rounded bg-amber-500 px-2 py-0.5 text-[10px] font-medium text-white transition hover:opacity-90 disabled:opacity-50" data-studio-segment-reprocess-run>
                                                    {reprocessBusy === editingSegmentId ? "处理中…" : "重新处理视频"}
                                                </button>
                                            </div>
                                        ) : null}
                                        {reprocessResult ? (
                                            <div className="mb-1.5 flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1 text-[10px]" data-studio-segment-reprocess-result>
                                                <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
                                                <span className="font-mono font-medium">{reprocessResult.code}</span>
                                                <span className="min-w-0 truncate text-muted-foreground" title={reprocessResult.message}>{reprocessResult.message}</span>
                                            </div>
                                        ) : null}
                                        {versionsError ? <p className="mb-1 text-[10px] text-rose-500" role="alert">{versionsError}</p> : null}
                                        {versionsLoading ? (
                                            <p className="py-2 text-[11px] text-muted-foreground">读取生成历史…</p>
                                        ) : segmentVersions.length ? (
                                            <div className={cn("space-y-1 overflow-y-auto", versionsExpanded ? "max-h-[420px]" : "max-h-72")} data-studio-version-list>
                                                {(versionsExpanded ? segmentVersions : segmentVersions.slice(0, SEGMENT_VERSION_LIMIT)).map((v) => {
                                                    // 影策 take-list.tsx:83-84、114：预览态徽标只标真正被预览的那条。
                                                    // 本地真值=previewVersion（独立预览弹窗正展示的版本），不切换当前版本，徽标如实表示「此版本正在预览」，不伪造行内切换。
                                                    const previewing = previewVersion?.id === v.id;
                                                    // 影策 take-list 单行元信息：当前/失败/取消才在第二行补一句，success 不占第二行。
                                                    // 只在画布 Clip results[] 里留存的版本没有生成日志，如实标「画布留存」。
                                                    const metaNote = [v.canvasKept ? "画布留存（无生成日志）" : "", v.current ? "当前" : "", v.status && v.status !== "success" ? v.status : "", v.error || ""].filter(Boolean).join(" · ");
                                                    return (
                                                        <div
                                                            key={v.id}
                                                            className={cn("flex items-center gap-2 rounded-[8px] border border-border/60 bg-muted/30 px-2 py-1", previewing && "border-sky-500/60 bg-sky-500/5", v.current && !previewing && "border-foreground/25 bg-foreground/[0.04]")}
                                                            data-studio-version={v.id}
                                                            data-studio-version-previewing={previewing ? "true" : undefined}
                                                        >
                                                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", v.current ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground")}>
                                                            {v.version ? `V${v.version}` : v.canvasKept ? "留存" : "—"}
                                                        </span>
                                                        {/* 影策 take-list 来源标签：pipeline/upload/canvas/restore，className 带 is-${source} */}
                                                        <span
                                                            className={cn("drama-take-source shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", `is-${v.source}`,
                                                                v.source === "canvas" ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                                                                    : v.source === "upload" ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                                                                        : v.source === "restore" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                                                            : "bg-foreground/5 text-muted-foreground")}
                                                            data-studio-version-source={v.source}
                                                            title={`生成入口：${SOURCE_LABEL[v.source] ?? v.source}`}
                                                        >
                                                            {SOURCE_LABEL[v.source] ?? SOURCE_LABEL.pipeline}
                                                        </span>
                                                            <div className="min-w-0 flex-1">
                                                                {/* 影策 take-list takeMeta：模型名去渠道前缀（纯字符串）；完整原始 id 留在 title。
                                                                    视频时长是真值：成片 media_files.duration_ms 优先，缺失时回退 shots duration_frames/fps；
                                                                    generation_logs 顶层 durationMs 是生成耗时，绝不拿来当视频时长。 */}
                                                                <div className="truncate text-[11px]" title={`${v.model || ""}${v.taskMode ? ` · ${v.taskMode}` : ""}`}>{v.startedAt ? new Date(v.startedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "未知时间"} · {prettyModelName(v.model) || "未知模型"}{v.durationSec !== null ? ` · ${v.durationSec.toFixed(1)}秒` : ""}</div>
                                                                <div className="truncate text-[10px] text-muted-foreground" title={v.durationSource ? `时长取${v.durationSource === "media-file" ? "成片视频文件" : "分场镜头帧数折算"}` : undefined}>{metaNote}</div>
                                                            </div>
                                                        {/* 影策 take-list.tsx:114 预览态徽标：仅当该版本正在预览弹窗中展示时出现（真值 previewVersion）。 */}
                                                        {previewing ? (
                                                            <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400" data-studio-version-preview-badge>预览中</span>
                                                        ) : null}
                                                        {v.url ? (
                                                            <button type="button" aria-pressed={previewing} aria-label={`预览 V${v.version ?? ""}，不切换当前版本`} onClick={() => setPreviewVersion(v)} className="flex shrink-0 items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" data-studio-version-preview>
                                                                <Eye className="size-3" /> 预览
                                                            </button>
                                                        ) : null}
                                                        {v.storageKey && !v.current ? (
                                                            <Popconfirm
                                                                title={`把 V${v.version ?? "?"} 设为本段当前视频？`}
                                                                description="只改本段当前版本，成片会标记为需重新合成。不会重新生成，也不删除其它版本。"
                                                                okText="设为当前"
                                                                cancelText="取消"
                                                                onConfirm={() => void handleSetCurrentVersion(v)}
                                                            >
                                                                <button type="button" disabled={settingVersionId === v.id} className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground/80 transition hover:border-foreground/25 hover:bg-foreground/5 disabled:opacity-50" data-studio-version-set-current>
                                                                    {settingVersionId === v.id ? "设置中…" : "设为当前"}
                                                                </button>
                                                            </Popconfirm>
                                                        ) : null}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <p className="py-2 text-[11px] text-muted-foreground">本段还没有生成历史（generation_logs 无记录）</p>
                                        )}
                                        {/* 影策 take-list.tsx:132：超出上限的版本用计数文案提示，不再全塞进滚动区。 */}
                                        {segmentVersions.length > SEGMENT_VERSION_LIMIT ? (
                                            <button type="button" onClick={() => setVersionsExpanded(v => !v)} className="mt-1 text-left text-[10px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline" data-studio-versions-more>{versionsExpanded ? "收起更早版本" : `另有 ${segmentVersions.length - SEGMENT_VERSION_LIMIT} 个更早版本`}</button>
                                        ) : null}
                                        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Vn = 本段第 n 次成功生成（按时间升序）；「设为当前」只切换视频，保留当前提示词与参数。</p>
                                    </div>
                            </div>
                        </div>
                        </div>
                    );
                })() : null}
            </Modal>
            {/* 参考图管理统一入口：本项目资产 / 本集分集图 / 上传，三者都写入画布 H3 段真实 referenceBindings */}
            <Modal
                open={refManageOpen}
                onCancel={() => setRefManageOpen(false)}
                width={860}
                centered
                title={<span className="text-sm font-semibold">参考图管理 · 第 {(editIdx ?? 0) + 1} 段</span>}
                footer={
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">已选 {Object.keys(refManageSelected).length} 张 · 已在段内的不会重复加入</span>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => setRefManageOpen(false)} className="h-8 rounded border border-border px-3 text-[11px] text-muted-foreground">取消</button>
                            <button type="button" disabled={refManageBusy || !Object.keys(refManageSelected).length} onClick={() => void handleReferenceManageApply()} className="h-8 rounded bg-primary px-3 text-[11px] font-medium text-primary-foreground disabled:opacity-50" data-studio-ref-manage-apply>{refManageBusy ? "写入中…" : "加入本段参考"}</button>
                        </div>
                    </div>
                }
                data-studio-ref-manage-modal
            >
                <div className="space-y-3">
                    <div className="flex gap-1.5" data-studio-ref-manage-sources>
                        {([["project", "本项目资产"], ["episode", "本集分集图"], ["upload", "上传"]] as const).map(([key, label]) => (
                            <button key={key} type="button" aria-pressed={refManageSource === key} onClick={() => setRefManageSource(key)} className={cn("rounded border px-2.5 py-1 text-[11px] transition", refManageSource === key ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")} data-studio-ref-manage-source={key}>{label}</button>
                        ))}
                    </div>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">选中的图片登记到参考资产并写入制作稿的段参考清单；画布 H3 Clip 在读取时按同一份源稿投影，加入后可在段弹窗里继续排序 / 启停。</p>
                    {refManageSource === "upload" ? (
                        <div className="rounded-lg border border-dashed border-border p-6 text-center">
                            <input ref={refUploadRef} type="file" accept="image/*" hidden onChange={(e) => void handleManageUpload(e.target.files?.[0])} />
                            <FileUp className="mx-auto mb-2 size-6 text-muted-foreground" />
                            <button type="button" disabled={refManageBusy} onClick={() => refUploadRef.current?.click()} className="h-8 rounded bg-primary px-3 text-[11px] text-primary-foreground disabled:opacity-50">选择图片上传</button>
                            <p className="mt-2 text-[10px] text-muted-foreground">上传后自动加入本项目资产，可在「本项目资产」里查看与选择。</p>
                        </div>
                    ) : (
                        <div className="max-h-[380px] overflow-y-auto rounded-lg border border-border p-2" data-studio-ref-manage-grid>
                            {refManageLoading ? <p className="p-3 text-[11px] text-muted-foreground">读取本集画布图片…</p> : null}
                            {!refManageLoading && (refManageSource === "project" ? refManageProjectItems : refManageEpisodeItems).length === 0
                                ? <p className="p-3 text-[11px] text-muted-foreground">{refManageSource === "project" ? "本项目资产里没有带 storageKey 的图片，可切到「上传」添加。" : (ep?.canvasId ? "本集画布里没有可用图片。" : "本集尚未就绪画布，暂无分集图。")}</p>
                                : null}
                            <div className="grid grid-cols-4 gap-2">
                                {(refManageSource === "project" ? refManageProjectItems : refManageEpisodeItems).map(item => {
                                    const selected = Boolean(refManageSelected[item.key]);
                                    return (
                                        <button key={item.key} type="button" aria-pressed={selected} title={item.label} onClick={() => setRefManageSelected(prev => { const next = { ...prev }; if (next[item.key]) delete next[item.key]; else next[item.key] = item; return next; })} className={cn("overflow-hidden rounded border text-left transition", selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/40")} data-studio-ref-manage-item={item.key}>
                                            <div className="aspect-[4/3] w-full bg-muted">{item.url ? <img src={item.url} alt="" className="h-full w-full object-cover" /> : null}</div>
                                            <div className="truncate px-1.5 py-1 text-[10px]">{item.label}</div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {Object.keys(refManageSelected).length ? (
                        <div className="flex flex-wrap gap-1.5" data-studio-ref-manage-selected>
                            {Object.values(refManageSelected).map(item => (
                                <button key={item.key} type="button" onClick={() => setRefManageSelected(prev => { const next = { ...prev }; delete next[item.key]; return next; })} className="flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary" title="点击取消选择">{item.label} ×</button>
                            ))}
                        </div>
                    ) : null}
                </div>
            </Modal>
            {/* 段视频版本独立预览弹窗（真实 backendMediaUrl 视频流，不造假缩略图） */}
            <Modal
                open={Boolean(previewVersion)}
                onCancel={() => setPreviewVersion(null)}
                footer={<button type="button" onClick={() => setPreviewVersion(null)} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground">关闭</button>}
                title={previewVersion?.version ? `第 ${editIdx !== null ? editIdx + 1 : ""} 段 · V${previewVersion.version} 预览` : "视频版本预览"}
                width={800}
                centered
                data-studio-version-preview-modal
            >
                {previewVersion?.url ? (
                    <video key={previewVersion.url} src={previewVersion.url} controls playsInline preload="metadata" className="w-full rounded-lg bg-black" />
                ) : null}
                {previewVersion ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">{previewVersion.model}{previewVersion.taskMode ? ` · ${previewVersion.taskMode}` : ""} · {previewVersion.startedAt ? new Date(previewVersion.startedAt).toLocaleString("zh-CN", { hour12: false }) : ""}</p>
                ) : null}
            </Modal>
        </div>
    );
}

/** 段时长：对齐影策小数秒格式（11.8s），非 m:ss。 */
function fmtDur(sec: number): string {
    const s = Math.max(0, Number(sec) || 0);
    return `${s.toFixed(1)}s`;
}

function FinalPanel({ ep, production, clipMedia, onCompose, onExportJianying, onOpenCanvas, busy }: {
    ep: StudioEpisode; production: EpisodeProduction | undefined; clipMedia: StudioClipMedia[];
    onCompose: () => void; onExportJianying: () => void; onOpenCanvas: () => void; busy: boolean;
}) {
    const source = useMemo(() => sourceOf(production), [production]);
    const segments = rows(source.segments);
    const finalResource = (((production?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.finalResource as { storageKey?: string; at?: string; stale?: boolean } | undefined;
    const hasFinal = Boolean(finalResource?.storageKey);
    const aspectLabel = String((production?.draft as Record<string, any> | undefined)?.settings?.videoAspectRatio || "16:9");
    const aspect = finalAspectOf(aspectLabel);
    const totalSec = segments.reduce((s, seg) => s + framesToSec(seg.duration_frames, source), 0);
    const clips = clipMedia.filter((c) => c.storageKey.startsWith("video:"));
    // 影策 finalStale：只用真实产物对账（段输入 hash 变化 / 段视频晚于成片合成时间），不读只写不更新的 stale 字段。
    const finalStale = useMemo(() => deriveFinalStale(production, clipMedia), [production, clipMedia]);
    const [activeClip, setActiveClip] = useState(0);
    const videoRef = useRef<HTMLVideoElement>(null);
    const readyClips = clips.filter((c) => c.status === "success" || !c.status).length;
    const current = clips[activeClip];
    // 播放器读取态：只由 video 真实事件驱动；换片源按 key 隔离，避免上一段的缓冲/错误串到新片源。
    const playerKey = hasFinal ? `final:${finalResource!.storageKey}` : current ? `${current.id}:${current.storageKey}` : "";
    const [playerState, setPlayerState] = useState<{ key: string; buffering: boolean; error: string }>({ key: "", buffering: false, error: "" });
    const playerView = playerState.key === playerKey ? playerState : { key: playerKey, buffering: false, error: "" };
    const setBuffering = (buffering: boolean) => setPlayerState({ key: playerKey, buffering, error: "" });
    const playerEvents = {
        onLoadStart: () => setBuffering(true),
        onWaiting: () => setBuffering(true),
        onPlaying: () => setBuffering(false),
        onCanPlay: () => setBuffering(false),
        onError: () => setPlayerState({ key: playerKey, buffering: false, error: "视频加载失败，请检查网络或稍后重试" }),
    };
    // 本页只有「合成成品」会把 busy 置真 → 视作 rendering（影策 composing || rendering）。
    const rendering = busy;
    // 合成片的真实时间轴：按 clipMedia 顺序累加每段实测时长（与 index.tsx 的拼接顺序一致），胶片条点击跳到该段起点。
    const starts: number[] = [];
    clips.reduce((cursor, c) => { starts.push(cursor); return cursor + (Number(c.duration) || 0); }, 0);
    // 影策 composeReady：每段都有真实视频且未过期才允许手动立即合成；
    // 段视频重新生成并回写后，后端会自动重新合成成片（见 final-composer / task.completed 订阅）。
    const clipFor = (seg: Row, i: number) => clips.find((c) => c.targetId === String(seg.id) || c.id === String(seg.id)) ?? (clips.length === segments.length ? clips[i] : undefined);
    const composeReady = segments.length > 0 && segments.every((seg, i) => {
        const c = clipFor(seg, i);
        return Boolean(c && !c.inputOutdated && (c.status === "success" || !c.status));
    });

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4" data-studio-panel="final">
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(260px,0.6fr)] gap-5">
                <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex min-w-0 flex-1 items-center justify-center">
                        {/* 影策 final-view.tsx:35,53：有合成成片就放合成片（不是单片段）；画幅按设置页 videoAspectRatio 派生。 */}
                        <div className={cn("relative flex w-full max-w-2xl items-center justify-center overflow-hidden rounded-xl bg-black shadow-sm", aspect.className)} style={aspect.style} data-studio-player data-studio-aspect={aspectLabel} aria-busy={playerView.buffering}>
                            {hasFinal ? (
                                <video
                                    key={`final:${finalResource!.storageKey}`}
                                    ref={videoRef}
                                    src={backendMediaUrl(finalResource!.storageKey!)}
                                    controls
                                    playsInline
                                    preload="metadata"
                                    className="size-full object-contain"
                                    {...playerEvents}
                                    data-studio-video="final"
                                />
                            ) : current ? (
                                <video
                                    key={`${current.id}:${current.storageKey}`}
                                    ref={videoRef}
                                    src={backendMediaUrl(current.storageKey)}
                                    controls
                                    playsInline
                                    preload="metadata"
                                    className="size-full object-contain"
                                    {...playerEvents}
                                />
                            ) : (
                                <div className="text-center text-white/40">
                                    <Film className="mx-auto size-10" />
                                    <p className="mt-2 text-xs">{STAGE_LABEL[ep.stage] || STAGE_LABEL.draft} · {rendering ? "正在合成成片…" : "全部段视频生成后，点右侧「合成成品」生成成片"}</p>
                                </div>
                            )}
                            {playerView.error ? (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center text-xs text-rose-300" role="alert" data-studio-player-error>
                                    <AlertCircle className="size-6" aria-hidden />
                                    <span>{playerView.error}</span>
                                </div>
                            ) : playerView.buffering ? (
                                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/30 text-xs text-white/90" role="status" data-studio-player-buffering>
                                    <LoaderCircle className="size-4 animate-spin" aria-hidden /> 缓冲中…
                                </div>
                            ) : null}
                        </div>
                    </div>
                    {/* 胶片条：影策 final-view.tsx:65-83 —— 有合成片时点击跳到该段起点（不换片源）；尾帧图有则显示，无则保留 video（不造假）。 */}
                    {clips.length ? (
                        <div className="flex shrink-0 gap-2 overflow-x-auto rounded-lg border border-border bg-card/40 p-2" data-studio-filmstrip>
                            {clips.map((c, i) => {
                                const tail = ((c as unknown as Record<string, unknown>).tailFrameStorageKey || (c as unknown as Record<string, unknown>).tailFrameResourceId);
                                const tailKey = typeof tail === "string" && tail ? tail : "";
                                return (
                                <button key={`${c.id}:${i}`} type="button" onClick={() => { setActiveClip(i); if (videoRef.current) videoRef.current.currentTime = hasFinal ? (starts[i] || 0) : 0; }}
                                    className={`flex shrink-0 flex-col gap-1 rounded-md border p-1 text-left transition ${i === activeClip ? "border-foreground/40 bg-foreground/[0.04]" : "border-border hover:bg-muted/50"}`}
                                    title={`${c.title} · ${fmtDur(c.duration)}${c.inputOutdated ? " · 输入已更改" : ""}`}>
                                    {tailKey ? (
                                        <img src={backendMediaUrl(tailKey)} alt="" className="h-12 w-20 rounded bg-black object-cover" />
                                    ) : (
                                        <video src={backendMediaUrl(c.storageKey)} preload="metadata" muted className="h-12 w-20 rounded bg-black object-cover" />
                                    )}
                                    <span className="max-w-20 truncate text-[10px] text-muted-foreground">第 {i + 1} 段 · {fmtDur(c.duration)}</span>
                                </button>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
                <div className="space-y-3">
                    <div className="rounded-lg border border-border bg-card/50 p-4 text-xs">
                        <div className="text-sm font-semibold">第 {ep.no} 集 · {ep.title}</div>
                        <div className="mt-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground" data-studio-final-status>
                            {finalResource?.storageKey
                                ? `成片已合成 · ${finalResource.at ? new Date(finalResource.at).toLocaleString("zh-CN", { hour12: false }) : ""} · 可独立下载`
                                : clips.length && readyClips === clips.length
                                    ? "全部段视频已生成 · 可点「合成成品」生成集成片"
                                    : "等待段视频生成 · 全部就绪后可合成成片"}
                        </div>
                        {finalStale ? (
                            <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300" role="status" data-studio-final-stale>
                                {rendering ? "正在重新合成成片…" : "内容已修改，当前成片是修改前的版本：段提示词/引用已变更或段视频在成片合成后重新生成。相关段重新生成后会自动重新合成；如需立即更新也可点「合成成品」。"}
                            </p>
                        ) : null}
                        <div className="mt-2 text-muted-foreground">{Math.round(totalSec)}秒 · {segments.length} 个剧情段 · {clips.length} 个片段</div>
                        {clips.length ? <div className="mt-1 text-muted-foreground">已生成 {readyClips}/{clips.length} 段视频 · 点击胶片条{hasFinal ? "定位到对应段" : "切换片段"}</div> : null}
                        <div className="mt-1 text-muted-foreground">对白与音效来自视频模型</div>
                    </div>
                    {/* 影策 final-view.tsx:97-106：disabled=每段 ready、loading=合成中、title 说明原因。 */}
                    <button type="button" onClick={onCompose} disabled={!composeReady || rendering}
                        title={composeReady ? (rendering ? "正在合成成片" : "按各段视频实测时长重新拼接成片") : "所有剧情段视频就绪后才能合成"}
                        data-studio-compose
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs transition hover:bg-muted disabled:opacity-50">
                        {rendering ? <LoaderCircle className="size-3.5 animate-spin" /> : <Film className="size-3.5" />} {rendering ? "合成中…" : "合成成品"}
                    </button>
                    <button type="button" disabled={!hasFinal}
                        onClick={() => { if (finalResource?.storageKey) { const a = document.createElement("a"); a.href = backendMediaUrl(finalResource.storageKey); a.download = `${ep.title || "成片"}-第${ep.no}集.mp4`; document.body.appendChild(a); a.click(); a.remove(); } }}
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs text-foreground transition hover:bg-muted disabled:opacity-40" data-studio-download-final>
                        <Download className="size-3.5" /> 下载成片{hasFinal ? "" : "（先合成）"}
                    </button>
                    <button type="button" disabled={!current} onClick={() => { if (current) window.open(backendMediaUrl(current.storageKey), "_blank"); }} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs text-muted-foreground transition hover:bg-muted disabled:opacity-40">
                        <Download className="size-3.5" /> 下载当前片段
                    </button>
                    <button type="button" onClick={onExportJianying} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs text-muted-foreground transition hover:bg-muted">
                        <Scissors className="size-3.5" /> 导出剪映草稿
                    </button>
                </div>
            </div>
        </div>
    );
}

export type DetailTab = "story" | "shots" | "clips";

export type ProcessJobView = { id: string; stage: string; status: string; attempt: number; error?: string | null; startedAt?: string | null; finishedAt?: string | null };

export function StudioDetailPanel({ tab, episode, production, clipMedia, clipFailureByTarget, dramaId, assetNames, onRescript, onCompose, onExportJianying, onOpenCanvas, onSwitchToScript, onWriteSegmentPrompt, onSaveSegmentPrompt, onListSegmentVersions, onSetSegmentCurrentVideo, onListSegmentVideoModels, onSetSegmentVideoModel, onApproveVideo, onSwitchToAssets, onChanged, busy, paused, onAutoResume, processJobs, onDiscussShot }: {
    tab: DetailTab;
    episode: StudioEpisode;
    production: EpisodeProduction | undefined;
    clipMedia: StudioClipMedia[];
    clipFailureByTarget?: Readonly<Record<string, string>>;
    dramaId?: string | null;
    /** 资产真名表（assetId / 节点 id → 名称），来自项目资产真值；参考图绑定里没带 name 时用它兜底。 */
    assetNames?: Readonly<Record<string, string>>;
    onRescript: () => void;
    onCompose: () => void;
    onExportJianying: () => void;
    onOpenCanvas: (segmentId?: string) => void;
    onSwitchToScript: () => void;
    onWriteSegmentPrompt?: (segmentId: string) => Promise<{ text: string; warnings: string[] }>;
    onSaveSegmentPrompt?: (segmentId: string, text: string) => Promise<void>;
    onListSegmentVersions?: (segmentId: string) => Promise<StudioSegmentVersion[]>;
    onSetSegmentCurrentVideo?: (segmentId: string, version: StudioSegmentVersion) => Promise<void>;
    onListSegmentVideoModels?: () => Promise<Record<string, string>>;
    onSetSegmentVideoModel?: (segmentId: string, model: string) => Promise<void>;
    onApproveVideo?: () => Promise<{ ok: boolean; missing: string[]; assetCount: number }>;
    onSwitchToAssets?: () => void;
    onChanged?: () => void;
    busy: boolean;
    /** 流水线暂停真值：暂停不是硬闸门——点生成会先自动恢复制作（影策暂停横幅同语义）。 */
    paused?: boolean;
    /** 把全局暂停转回运行（卡片/批量生成点击时先调用）。 */
    onAutoResume?: () => Promise<void>;
    processJobs?: ProcessJobView[];
    onDiscussShot?: (shot: { title?: string; visual?: string; camera?: unknown; duration_seconds?: number; dialogues?: unknown }) => void;
}) {
    if (tab === "story") return <ScriptPanel ep={episode} production={production} dramaId={dramaId} onRescript={onRescript} onChanged={onChanged} busy={busy} processJobs={processJobs} onDiscussShot={onDiscussShot} />;
    if (tab === "shots") return <ShotsPanel ep={episode} production={production} clipMedia={clipMedia} clipFailureByTarget={clipFailureByTarget} dramaId={dramaId} assetNames={assetNames} onRescript={onRescript} onOpenCanvas={onOpenCanvas} onSwitchToScript={onSwitchToScript} onWriteSegmentPrompt={onWriteSegmentPrompt} onSaveSegmentPrompt={onSaveSegmentPrompt} onListSegmentVersions={onListSegmentVersions} onSetSegmentCurrentVideo={onSetSegmentCurrentVideo} onListSegmentVideoModels={onListSegmentVideoModels} onSetSegmentVideoModel={onSetSegmentVideoModel} onChanged={onChanged} onApproveVideo={onApproveVideo} onSwitchToAssets={onSwitchToAssets} busy={busy} paused={paused} onAutoResume={onAutoResume} onDiscussShot={onDiscussShot} />;
    return <FinalPanel ep={episode} production={production} clipMedia={clipMedia} onCompose={onCompose} onExportJianying={onExportJianying} onOpenCanvas={onOpenCanvas} busy={busy} />;
}
