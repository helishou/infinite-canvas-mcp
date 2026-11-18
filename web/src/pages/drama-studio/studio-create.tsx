import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Input } from "antd";
import { ArrowLeft, BookOpenText, ClipboardPaste, FileText, FileUp, Clapperboard, Sparkles } from "lucide-react";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { TOPIC_DEFAULTS } from "@/pages/drama/planning-topic-logic";
import { writeNewDramaDraft } from "@/pages/drama/new-drama-draft";
import { cn } from "@/lib/utils";

/**
 * 新制作台的「新建短剧」整页，形态全抄影策 /projects/new：
 * 来源三选（小说原文/剧本/分镜）→ 拖入文件或直接粘贴 → 5 步流水线说明。
 * 解析正文后把原文写进新建草稿，跳回 /drama-studio?new=1 打开已有的设置向导（阶段 2）。
 */
type SourceFormat = "novel" | "script" | "storyboard";
const FORMATS: Array<{ value: SourceFormat; title: string; desc: string; placeholder: string }> = [
    { value: "novel", title: "小说原文", desc: "按原文改成镜头，引号里的对白逐字保留", placeholder: "在这里粘贴小说原文" },
    { value: "script", title: "剧本", desc: "已写好的剧情与台词。只拆镜头，台词一字不改", placeholder: "在这里粘贴剧本" },
    { value: "storyboard", title: "分镜", desc: "已做好的分镜表，按原镜头转录；表格可直接导入", placeholder: "在这里粘贴分镜表" },
];
const STEPS = ["解析分集", "建立角色、道具与场景", "改编剧本与段提示词", "按剧情段生成视频", "合成成片"];

export default function StudioCreatePage() {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [dragOver, setDragOver] = useState(false);
    const [sourceFormat, setSourceFormat] = useState<SourceFormat>("novel");
    const [pasteMode, setPasteMode] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const fmt = FORMATS.find((f) => f.value === sourceFormat) || FORMATS[0];

    const acceptText = async (text: string, name?: string) => {
        const clean = text.replace(/^\uFEFF/, "").trim();
        if (!clean) { message.warning("内容为空"); return; }
        // 原文写进草稿，交给已有的设置向导继续（章节解析/分集/选题都在那里）。
        const blank = dramaProductionPlanSchema.parse({});
        await writeNewDramaDraft({
            name: name || "新建短剧",
            plan: { ...blank, topic: { ...blank.topic, ...TOPIC_DEFAULTS, tones: [...TOPIC_DEFAULTS.tones] }, sourceScript: clean },
            styleMode: "none", stylePrompt: "", autoEpisodes: true, handoff: true, step: 1,
        });
        // 回到制作台并打开设置向导（阶段 2）。
        navigate("/drama-studio?new=1");
    };
    const loadFile = async (file: File) => {
        try {
            let text = await file.text();
            // GBK 兜底：UTF-8 解码出现替换符时用 GBK 再解码。
            if (text.includes("\uFFFD")) {
                try { text = new TextDecoder("gbk").decode(await file.arrayBuffer()); } catch { /* 保持 UTF-8 */ }
            }
            await acceptText(text, file.name.replace(/\.(txt|md|markdown)$/i, ""));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };
    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void loadFile(file);
    };

    return (
        <div className="flex h-screen flex-col overflow-auto bg-background text-foreground">
            {/* 顶部条 */}
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
                <button type="button" aria-label="返回制作台" onClick={() => navigate("/drama-studio")} className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground">
                    <ArrowLeft className="size-4" />
                </button>
                <h1 className="text-lg font-semibold">新建短剧</h1>
            </header>

            <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-8">
                {/* 来源三选：卡片 + 圆形单选 */}
                <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3" data-studio-create-formats>
                    {FORMATS.map((f) => {
                        const active = sourceFormat === f.value;
                        return (
                            <button
                                key={f.value}
                                type="button"
                                data-studio-create-format={f.value}
                                aria-pressed={active}
                                onClick={() => setSourceFormat(f.value)}
                                className={cn(
                                    "flex items-start gap-3 rounded-xl border p-4 text-left transition",
                                    active ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border bg-card/40 hover:border-foreground/30",
                                )}
                            >
                                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", active ? "border-primary" : "border-muted-foreground")}>
                                    {active ? <span className="size-2 rounded-full bg-primary" /> : null}
                                </span>
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium">{f.title}</span>
                                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">{f.desc}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* 大拖拽面板 */}
                <div
                    data-studio-create-drop
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    className={cn(
                        "flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed bg-card/30 px-6 py-12 text-center transition",
                        dragOver ? "border-primary bg-primary/5" : "border-border",
                    )}
                >
                    {pasteMode ? (
                        <div className="grid w-full max-w-3xl gap-3">
                            <Input.TextArea
                                autoFocus
                                value={pasteText}
                                onChange={(e) => setPasteText(e.target.value)}
                                placeholder={`${fmt.placeholder}\n\n包含“第一章 / 第1集 / Chapter 1”这类标题时会自动拆分；${sourceFormat === "novel" ? "" : "每个标题就是一集，"}也可以只放第 1 集，之后在制作台逐集追加。`}
                                autoSize={{ minRows: 14, maxRows: 24 }}
                            />
                            <div className="flex justify-end gap-2">
                                <Button onClick={() => setPasteMode(false)}>取消</Button>
                                <Button type="primary" disabled={!pasteText.trim()} onClick={() => void acceptText(pasteText)}>解析正文</Button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <span className="grid size-14 place-items-center rounded-2xl bg-muted text-foreground">
                                {sourceFormat === "novel" ? <BookOpenText className="size-7" /> : sourceFormat === "script" ? <FileText className="size-7" /> : <Clapperboard className="size-7" />}
                            </span>
                            <h2 className="text-xl font-semibold">拖入{fmt.title}文件，剩下的交给流水线</h2>
                            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                                TXT 或 Markdown，自动识别 GBK / UTF-8 编码与“第 N 章 / 第 N 集”标题。可以只放第 1 集，做完再在制作台追加下一集；
                                {sourceFormat === "novel" ? "引号里的对白会逐字保留为台词。" : "台词逐字保留，不会被改写。"}
                            </p>
                            <Button type="primary" size="large" icon={<FileUp className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                选择{fmt.title}文件
                            </Button>
                            <button type="button" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline" onClick={() => setPasteMode(true)}>
                                <ClipboardPaste className="size-3.5" /> 没有文件？直接粘贴
                            </button>
                            <div className="mt-4 flex flex-wrap items-center justify-center gap-2" data-studio-create-steps>
                                {(sourceFormat === "storyboard" ? ["导入分镜", ...STEPS.slice(1)] : STEPS).map((step, i) => (
                                    <span key={step} className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
                                        <b className="grid size-4 place-items-center rounded-full bg-foreground/10 text-[10px] font-semibold text-foreground">{i + 1}</b>
                                        {step}
                                    </span>
                                ))}
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".txt,.md,.markdown,text/plain,text/markdown"
                                className="hidden"
                                onChange={(e) => { const file = e.target.files?.[0]; if (file) void loadFile(file); e.target.value = ""; }}
                            />
                        </>
                    )}
                </div>
            </div>

            {/* 右下角助手形象（影策同款位置） */}
            <div className="pointer-events-none fixed bottom-6 right-6 grid size-14 place-items-center rounded-full bg-primary/15 text-primary shadow-lg" aria-hidden>
                <Sparkles className="size-6" />
            </div>
        </div>
    );
}
