import { useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { BookMarked, FileText, Search, X } from "lucide-react";

import { fetchMarketSkills, fetchSkillDetail, type MarketSkill } from "@/services/api/skill-market";
import { cn } from "@/lib/utils";

/**
 * 文字步骤的写作技能选择——真值来自本地已添加的技能（skill-market）。
 * 对齐影策 PromptSkillField：列出已添加技能 → 预览 SKILL.md → 保存引用 {name,title,path}。
 * 本地生成链路的 instruction 上限 2000 字，选中技能会取其「方法要点」（frontmatter 描述 + 正文前段）
 * 作为 instruction 注入改编请求，确保选择的技能真实影响生成，而不是填了没用的字段。
 */
export type SkillRef = { name: string; title: string; path: string };

const STEP_COPY: Record<string, { title: string; detail: string; empty: string }> = {
    extract: {
        title: "选择资产提取技能",
        detail: "建立作品设定时，把所选技能的方法要点交给文本模型，按其方法提取角色、道具与场景；输出结构由系统固定。",
        empty: "未选择技能，按内置规则提取角色、道具与场景。",
    },
    storyboard: {
        title: "选择分镜拆分技能",
        detail: "改编每集剧本时，把所选技能的方法要点交给文本模型，按其方法拆分镜头；输出结构由系统固定。",
        empty: "未选择技能，按内置规则拆分镜头。",
    },
    prompt: {
        title: "选择视频提示词技能",
        detail: "撰写剧情段视频提示词时，把所选技能的方法要点交给文本模型，按其结构和写法输出。",
        empty: "未选择技能，按内置格式撰写。",
    },
};

/** 从 SKILL.md 抽出可作为 instruction 的「方法要点」，限制在 1900 字内（后端上限 2000）。 */
export function skillInstruction(content: string, title: string): string {
    const text = String(content || "").replace(/\r\n/g, "\n");
    // 取 frontmatter description（方法意图），再取正文去 YAML 后的前段
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    const desc = fmMatch ? (fmMatch[1].match(/^description:\s*(.+)$/m)?.[1] || "").trim() : "";
    let body = fmMatch ? text.slice(fmMatch[0].length) : text;
    body = body.replace(/^#+\s*/gm, "").replace(/```[\s\S]*?```/g, "").replace(/\n{2,}/g, "\n").trim();
    const head = [`写作方法参考「${title}」`, desc ? `方法意图：${desc}` : "", body].filter(Boolean).join("\n");
    return head.slice(0, 1900);
}

export function SkillPickerField({ step, value, onChange }: {
    step: string;
    value: SkillRef | null;
    onChange: (ref: SkillRef | null) => void;
}) {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const copy = STEP_COPY[step] || STEP_COPY.prompt;

    return (
        <div className="flex min-w-0 items-center gap-2" data-studio-skill={step}>
            {value ? (
                <>
                    <BookMarked className="size-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 truncate text-[11px]" title={`${value.title} · ${value.path}`}>{value.title}</span>
                    <button type="button" onClick={() => setOpen(true)}
                        className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">更换</button>
                    <button type="button" aria-label="不使用技能" title="不使用技能" onClick={() => onChange(null)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
                </>
            ) : (
                <>
                    <span className="text-[11px] text-muted-foreground">{copy.empty}</span>
                    <button type="button" onClick={() => setOpen(true)}
                        className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-muted"
                        data-studio-skill-pick={step}><BookMarked className="size-3" /> 选择技能</button>
                </>
            )}
            {open ? (
                <SkillModal step={step} initial={value} onClose={() => setOpen(false)}
                    onPick={(ref) => { onChange(ref); setOpen(false); message.success(`已选用写作技能「${ref.title}」`); }} />
            ) : null}
        </div>
    );
}

function SkillModal({ step, initial, onClose, onPick }: {
    step: string;
    initial: SkillRef | null;
    onClose: () => void;
    onPick: (ref: SkillRef) => void;
}) {
    const { message } = App.useApp();
    const copy = STEP_COPY[step] || STEP_COPY.prompt;
    const [keyword, setKeyword] = useState("");
    const [skills, setSkills] = useState<MarketSkill[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string>(initial?.name || "");
    const [content, setContent] = useState("");
    const [loadingContent, setLoadingContent] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void fetchMarketSkills()
            .then((r) => { if (!cancelled) setSkills((r.skills || []).filter((s) => s.added || s.installed)); })
            .catch((e) => { if (!cancelled) message.error(`读取本地技能失败：${(e as Error).message}`); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [message]);

    const filtered = useMemo(() => skills.filter((s) =>
        !keyword.trim() || `${s.title} ${s.name} ${s.description || ""}`.toLowerCase().includes(keyword.trim().toLowerCase())
    ), [skills, keyword]);

    useEffect(() => {
        if (!selected) { setContent(""); return; }
        let cancelled = false;
        setLoadingContent(true);
        void fetchSkillDetail(selected)
            .then((detail) => { if (!cancelled) setContent(detail?.content || ""); })
            .catch(() => { if (!cancelled) setContent(""); })
            .finally(() => { if (!cancelled) setLoadingContent(false); });
        return () => { cancelled = true; };
    }, [selected]);

    const skill = skills.find((s) => s.name === selected);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={copy.title}>
            <div className="flex h-[600px] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl" data-studio-skill-modal>
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">{copy.title}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{copy.detail}</div>
                </div>
                <div className="flex min-h-0 flex-1">
                    <aside className="flex w-60 shrink-0 flex-col border-r border-border">
                        <div className="border-b border-border p-2">
                            <div className="flex items-center gap-1.5 rounded-md border border-border px-2">
                                <Search className="size-3.5 opacity-50" />
                                <input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                                    placeholder="搜索本地已添加技能" aria-label="搜索技能"
                                    className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none" />
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            {loading ? <div className="p-4 text-center text-[11px] text-muted-foreground">读取本地技能…</div> :
                                filtered.map((s) => (
                                    <button key={s.name} type="button" onClick={() => setSelected(s.name)}
                                        aria-pressed={s.name === selected}
                                        className={cn("block w-full border-b border-border/50 px-3 py-2 text-left transition hover:bg-muted",
                                            s.name === selected && "bg-primary/10")}>
                                        <div className="truncate text-xs font-medium">{s.title || s.name}</div>
                                        <div className="truncate text-[10px] text-muted-foreground">{s.description || s.name}</div>
                                    </button>
                                ))}
                            {!loading && !filtered.length ? <div className="p-4 text-center text-[11px] text-muted-foreground">没有匹配的技能</div> : null}
                        </div>
                    </aside>
                    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
                            <FileText className="size-3.5" />
                            {skill ? `${skill.title || skill.name} · SKILL.md` : "选择技能后预览方法全文"}
                            {content ? <span className="ml-auto">{content.length.toLocaleString("zh-CN")} 字 · 注入改编时取方法要点（≤1900 字）</span> : null}
                        </div>
                        <pre className="thin-scrollbar min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 text-[11px] leading-relaxed" data-studio-skill-preview>
                            {loadingContent ? "正在读取…" : content || "选择左侧技能后在这里查看全文。"}
                        </pre>
                    </section>
                </div>
                <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
                    <span className="text-[11px] text-muted-foreground">技能来自本地「技能」库；修改技能后下次改编会读到新内容。</span>
                    <div className="flex gap-2">
                        <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">取消</button>
                        <button type="button" disabled={!skill || !content}
                            onClick={() => skill && onPick({ name: skill.name, title: skill.title || skill.name, path: "SKILL.md" })}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                            data-studio-skill-use>使用这个技能</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
