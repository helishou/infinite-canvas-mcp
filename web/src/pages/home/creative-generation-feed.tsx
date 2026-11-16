import { useEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines, ArrowLeft, ArrowRight, CheckCheck, Copy, Download, FileText, Film, History, Image as ImageIcon, LayoutGrid, Loader2, MessageSquarePlus, Orbit, Pencil, RefreshCw, Type, UserRound, Video, X } from "lucide-react";
import { App, Button, Progress } from "antd";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";
import { backendMediaUrl, type BackendGenerationLog, type BackendRuntimeTask } from "@/services/backend-api";
import { launchStatus, launchTextResults, resolveLaunchOutputs, type CreativeLaunch, type CreativeLaunchReference, type WorkbenchOutput } from "./workbench-data";
import { WorkbenchMediaPreview } from "./workbench-media";

const MODE_ICONS = { image: ImageIcon, video: Video, text: Type, audio: AudioLines } as const;
const PENDING_STEPS = ["pendingStepQueue", "pendingStepGenerate", "pendingStepSave"] as const;

/** 生成时选的比例 / 像素尺寸 → 占位卡 aspect-ratio；异常值收敛到合理区间。 */
function mediaAspect(size: string | undefined, mode: CreativeLaunch["mode"]) {
    const fallback = mode === "video" ? 16 / 9 : 1;
    const value = (size || "").trim();
    const ratio = value.match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
    const pixels = value.match(/^(\d+)\s*x\s*(\d+)$/i);
    const match = ratio || pixels;
    if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width > 0 && height > 0) return Math.min(2.5, Math.max(0.45, width / height));
    }
    return fallback;
}

function elapsedLabel(createdAt: string, now: number) {
    const started = Date.parse(createdAt);
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * 影策 CreationMediaPending 的本地形态：按最终画面比例占位，标题跟随真实任务阶段
 * （排队 / 生成 / 保存），底部三段进度与耗时。图片/视频生成中显示，文本/音频仍用细进度条。
 */
function CreativeMediaPending({ launch, task }: { launch: CreativeLaunch; task?: BackendRuntimeTask }) {
    const { t } = useTranslation();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    const progress = Math.min(100, Math.max(0, Math.round((Number(task?.progress) || 0) * 100)));
    const step = !task || task.status === "queued" ? 0 : progress >= 90 ? 2 : 1;
    const kind = launch.mode === "video" ? t("home.workbench.pendingKindVideo") : t("home.workbench.pendingKindImage");
    const title = step === 0 ? t("home.workbench.pendingQueued") : step === 2 ? t("home.workbench.pendingSaving", { kind }) : t("home.workbench.pendingGenerating", { kind });
    const hint = step === 0 ? t("home.workbench.pendingHintQueue") : step === 2 ? t("home.workbench.pendingHintSaving") : launch.mode === "video" ? t("home.workbench.pendingHintVideo") : "";
    const specs = [
        launch.params?.size,
        launch.mode === "image" && (launch.params?.count || 0) > 1 ? t("home.workbench.pendingCount", { count: launch.params?.count }) : "",
        launch.mode === "video" && launch.params?.seconds ? t("home.workbench.pendingSeconds", { value: launch.params.seconds }) : "",
    ].filter(Boolean).join(" · ");
    const Icon = MODE_ICONS[launch.mode];
    return (
        <div
            className="relative mt-3 flex w-full flex-col gap-4 overflow-hidden rounded-xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-5"
            data-testid="creative-media-pending"
            data-phase={step === 0 ? "queued" : step === 2 ? "saving" : "generating"}
            role="status"
        >
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/5" aria-hidden="true" />
            <span className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-tr from-transparent via-foreground/[0.04] to-transparent" aria-hidden="true" />
            {/* 画幅预览：按目标比例定宽定高。消息列铺满后不再把整张状态卡拉成巨型方图。 */}
            <div
                className="relative flex h-40 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background/50 shadow-inner sm:h-44 sm:w-auto"
                style={{ aspectRatio: String(mediaAspect(launch.params?.size, launch.mode)) }}
                data-testid="creative-media-pending-frame"
            >
                <span className="inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"><Loader2 className="size-6 animate-spin" aria-hidden="true" /></span>
            </div>
            <div className="relative flex min-w-0 flex-1 flex-col justify-center gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Icon className="size-3.5" aria-hidden="true" />
                    <span className="truncate">{specs || kind}</span>
                </div>
                <div className="flex flex-col gap-1">
                    <strong className="ui-body font-medium">{title}</strong>
                    <span className="ui-caption text-muted-foreground">
                        {[progress > 0 ? `${progress}%` : "", t("home.workbench.pendingElapsed", { value: elapsedLabel(launch.createdAt, now) })].filter(Boolean).join(" · ")}
                    </span>
                    {hint ? <span className="ui-caption text-muted-foreground">{hint}</span> : null}
                </div>
                <ol className="relative flex w-full gap-1.5" aria-label={t("home.workbench.pendingProgress")}>
                    {PENDING_STEPS.map((key, index) => {
                        const state = index < step ? "done" : index === step ? "active" : "todo";
                        return (
                            <li key={key} className="min-w-0 flex-1" data-state={state} aria-current={state === "active" ? "step" : undefined}>
                                <span className="block h-1 overflow-hidden rounded-full bg-muted">
                                    <span
                                        className={cn("block h-full rounded-full bg-primary", state === "done" ? "w-full opacity-100" : state === "active" ? "opacity-70 animate-pulse" : "opacity-0")}
                                        style={state === "active" && progress > 0 ? { width: `${progress}%` } : undefined}
                                    />
                                </span>
                                <span className="mt-1 block truncate text-[11px] text-muted-foreground">{t(`home.workbench.${key}`)}</span>
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}

/** 影策 creation-user-message-references：用户气泡下方的引用缩略图行。 */
function CreativeMessageReferences({ references }: { references: CreativeLaunchReference[] }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap justify-end gap-1.5" data-testid="creative-thread-references" aria-label={t("home.workbench.references")}>
            {references.map(item => {
                const src = item.storageKey ? backendMediaUrl(item.storageKey) : item.url;
                const Icon = item.kind === "video" ? Film : item.kind === "audio" ? AudioLines : item.kind === "image" ? ImageIcon : FileText;
                return (
                    <span key={item.id} className="inline-flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border bg-card py-1 pl-1 pr-2 text-xs text-muted-foreground" title={item.title}>
                        {src && item.kind === "image" ? <img src={src} alt="" className="size-6 rounded object-cover" />
                            : src && item.kind === "video" ? <video src={src} muted preload="metadata" className="size-6 rounded object-cover" aria-label={item.title} />
                                : <Icon className="size-4" aria-hidden="true" />}
                        <span className="truncate">{item.title}</span>
                    </span>
                );
            })}
        </div>
    );
}


/**
 * 生成结果的展示层：单个图片/视频按真实画幅整幅铺开，不再塞进 128px 的裁切小方图；
 * 多结果才回落到等比网格。图片加载后用原始像素修正容器比例，避免 params.size 猜错画幅。
 * 点击仍走首页既有的预览弹窗。
 */
function CreativeResultGallery({ outputs, launch, onPreview }: {
    outputs: WorkbenchOutput[];
    launch: CreativeLaunch;
    onPreview: (output: WorkbenchOutput) => void;
}) {
    const { t } = useTranslation();
    const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
    const fallback = mediaAspect(launch.params?.size, launch.mode);
    const ratio = natural && natural.width > 0 && natural.height > 0
        ? Math.min(2.5, Math.max(0.45, natural.width / natural.height))
        : fallback;
    const single = outputs.length === 1 && (outputs[0].kind === "image" || outputs[0].kind === "video");
    // 横图可以铺得更宽，竖图收窄以免把消息流撑得过长；仍受父容器 100% 宽度约束。
    const maxWidth = ratio >= 1.4 ? 960 : ratio >= 0.9 ? 720 : 460;
    const ariaLabel = t("home.workbench.previewNamed", { name: launch.prompt });
    if (single) {
        const output = outputs[0];
        return (
            <div className="mt-3 w-full" data-testid="creative-launch-outputs">
                <button
                    type="button"
                    className="group relative block w-full cursor-pointer overflow-hidden rounded-xl border border-border bg-muted/40 text-left transition-colors hover:border-foreground/40"
                    style={{ aspectRatio: String(ratio), maxWidth: `min(${maxWidth}px, calc(var(--thread-media-max-h, 46vh) * ${ratio}))` }}
                    data-testid="creative-launch-output"
                    data-display="full"
                    aria-label={ariaLabel}
                    title={t("home.workbench.clickToPreview")}
                    onClick={() => onPreview(output)}
                >
                    <WorkbenchMediaPreview media={output} label={t(`home.workbench.${output.kind}`)} fit="contain" onImageSize={setNatural} />
                    <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                        {t("home.workbench.clickToPreview")}
                    </span>
                </button>
            </div>
        );
    }
    return (
        <div className="mt-3 grid w-full grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-testid="creative-launch-outputs">
            {outputs.slice(0, 8).map(output => (
                <button
                    key={output.id}
                    type="button"
                    className="group relative cursor-pointer overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-foreground/40"
                    style={{ aspectRatio: String(fallback) }}
                    data-testid="creative-launch-output"
                    aria-label={ariaLabel}
                    onClick={() => onPreview(output)}
                >
                    <WorkbenchMediaPreview media={output} label={t(`home.workbench.${output.kind}`)} fit="contain" />
                </button>
            ))}
        </div>
    );
}

/**
 * 首页「对话工作台」（对齐影策 thread-workbench）：
 * 提交后不跳转，首页原地进入对话形态——用户消息右置气泡 + 助手回复块（markdown / 结果网格），
 * 底部停靠 composer 随时追问；工具栏提供「新对话」「历史对话」与「新建画布」（显式进入画布精修）。
 * 数据来自首页既有的任务 / 生成日志实时刷新：对话阶段没有画布，结果直接读任务详情的 result.media。
 * 「生成动态」历史卡片网格已下线：非对话形态不再渲染，历史对话走工具栏的「历史对话」抽屉。
 */
export function CreativeGenerationFeed({ launches, tasks, logs, threadActive = false, composer, onDismiss, onOpenProject, onPreview, onNewThread, onCreateCanvas, canCreateCanvas = false, onOpenHistory, hasOtherConversations = false, onEditPrompt, onBack, onRegenerate }: {
    launches: CreativeLaunch[];
    tasks: BackendRuntimeTask[];
    logs: BackendGenerationLog[];
    /** true = 对话形态（工具栏 + 消息流 + 停靠 composer）；false = 不渲染（「生成动态」历史卡片网格已下线）。 */
    threadActive?: boolean;
    /** 仅对话形态：停靠在消息流底部的追问输入条（CreativeLaunchPad variant="thread"）。 */
    composer?: ReactNode;
    onDismiss: (taskId: string) => void;
    onOpenProject: (projectId?: string) => void;
    onPreview: (output: WorkbenchOutput) => void;
    /** 仅对话形态：新建对话。 */
    onNewThread?: () => void;
    /** 仅对话形态：显式新建画布并把本轮成果导入（对话阶段不建画布）。 */
    onCreateCanvas?: () => void;
    /** 有已完成的结果时才允许新建画布。 */
    canCreateCanvas?: boolean;
    /** 仅对话形态：打开历史对话抽屉。 */
    onOpenHistory?: () => void;
    /** 存在其他会话时才显示历史入口。 */
    hasOtherConversations?: boolean;
    /** 仅对话形态：编辑并重发（影策）——把提示词回填进追问输入条。 */
    onEditPrompt?: (text: string) => void;
    /** 仅对话形态：全屏对话页的返回按钮（收起对话回创作台）。 */
    onBack?: () => void;
    /** 生成同款（影策 creation-message-variant-action）：按该条消息的模式与参数再跑一次。 */
    onRegenerate?: (launch: CreativeLaunch) => void;
}) {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const threadScrollRef = useRef<HTMLDivElement>(null);
    const threadContentRef = useRef<HTMLDivElement>(null);
    const stickToBottom = useRef(true);
    // 新消息到达时跟随到底部：全屏对话页里生成中的占位卡不能被停靠 composer 挡住。
    // 只在条数变化时滚动，任务进度轮询不会打断用户回看历史消息。
    useEffect(() => {
        if (!threadActive) return;
        const node = threadScrollRef.current;
        if (node) {
            stickToBottom.current = true;
            node.scrollTop = node.scrollHeight;
        }
    }, [threadActive, launches.length]);
    // 结果大图是异步加载的：图片撑高消息后再补一次滚动，否则下半张会被 composer 挡住。
    // 只在用户本来就在底部时跟随，回看历史不会被拽回去。
    useEffect(() => {
        if (!threadActive) return;
        const node = threadScrollRef.current;
        const content = threadContentRef.current;
        if (!node || !content || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            if (stickToBottom.current) node.scrollTop = node.scrollHeight;
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [threadActive]);
    // 把「消息区实际可用高度」写进 CSS 变量：结果大图按这个高度而非整个视口收敛，
    // 高窗口能显示得更大，矮窗口也不会被底部 composer 切掉。
    useEffect(() => {
        if (!threadActive) return;
        const node = threadScrollRef.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            const available = Math.max(220, Math.round(node.clientHeight - 150));
            node.style.setProperty("--thread-media-max-h", `${available}px`);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [threadActive]);
    const time = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" }) : "");
    const latest = launches[0];
    const chronological = [...launches].reverse();
    const assistantTitle = (launch: CreativeLaunch) => {
        if (/hermes|director/i.test(launch.model)) return t("home.workbench.threadTitleDirector");
        if (launch.mode === "text") return t("home.workbench.threadTitleText");
        if (launch.mode === "image") return t("home.workbench.threadTitleImage");
        if (launch.mode === "video") return t("home.workbench.threadTitleVideo");
        return t("home.workbench.threadTitleAudio");
    };

    const messageBody = (launch: CreativeLaunch) => {
        const task = tasks.find(item => item.id === launch.taskId);
        // 旧会话按生成节点隔离日志；新会话没有画布，结果直接来自任务详情。
        const projectLogs = launch.projectId ? logs.filter(log => log.projectId === launch.projectId && (!launch.nodeId || !log.nodeId || log.nodeId === launch.nodeId)) : [];
        const status = launchStatus(task, projectLogs);
        const outputs = resolveLaunchOutputs(task, projectLogs, launch);
        const texts = launch.mode === "text" ? launchTextResults(task, projectLogs) : [];
        const error = task?.error || projectLogs.find(log => log.status === "failed")?.error || "";
        const running = status === "queued" || status === "running";
        return (
            <>
                {/* 影策 CreationMediaPending：图片/视频按画幅比例占位并显示阶段/耗时/三段进度，文本/音频保留细进度条。 */}
                {running && (launch.mode === "image" || launch.mode === "video") ? (
                    <CreativeMediaPending launch={launch} task={task} />
                ) : running ? (
                    <Progress className="!mt-3" percent={Math.min(100, Math.max(0, Math.round((Number(task?.progress) || 0) * 100)))} size="small" status={status === "running" ? "active" : "normal"} />
                ) : null}
                {status === "failed" && error && <p className="ui-body mt-3 whitespace-pre-wrap break-words text-destructive">{error}</p>}
                {texts.length > 0 && (
                    <div className="mt-3 min-w-0" data-testid="creative-launch-text">
                        {texts.map((text, index) => (
                            <div key={index} className="ui-body min-w-0 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3">
                                <Streamdown>{text}</Streamdown>
                            </div>
                        ))}
                    </div>
                )}
                {outputs.length > 0 && <CreativeResultGallery outputs={outputs} launch={launch} onPreview={onPreview} />}
                {outputs.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-3" data-testid="creative-launch-actions">
                        <span className="ui-caption text-muted-foreground">{t("home.workbench.resultCount", { count: outputs.length })}</span>
                        {outputs.slice(0, 8).map((output, index) => {
                            const href = output.storageKey ? backendMediaUrl(output.storageKey) : output.url || "";
                            return href ? (
                                <a key={output.id} href={href} download data-testid="creative-launch-download" className="ui-caption inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
                                    <Download className="size-3.5" aria-hidden="true" />
                                    {outputs.length > 1 ? `${t("home.workbench.download")} ${index + 1}` : t("home.workbench.download")}
                                </a>
                            ) : null;
                        })}
                    </div>
                )}
                {status === "succeeded" && !outputs.length && !texts.length && (
                    <p className="ui-caption mt-3 text-muted-foreground">{t("home.workbench.feedNoOutputs")}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {status === "succeeded" && onRegenerate ? (
                        <Button
                            type="text"
                            size="small"
                            className="!text-muted-foreground"
                            data-testid="creative-launch-regenerate"
                            title={t("home.workbench.regenerateHint")}
                            icon={<RefreshCw className="size-3.5" />}
                            onClick={() => onRegenerate(launch)}
                        >
                            {t("home.workbench.regenerate")}
                        </Button>
                    ) : null}
                    {/* 会话级落地统一由工具栏一个「新建画布」承担；无画布绑定的结果不再每轮各挂一个入口。
                        历史（非对话）卡片没有工具栏，保留一个显式入口以便落地。 */}
                    {launch.projectId || !threadActive ? (
                        <Button type="link" size="small" className="!px-0" data-testid="creative-launch-open-canvas" onClick={() => onOpenProject(launch.projectId)}>
                            {t(launch.projectId ? "home.workbench.feedOpenCanvas" : "home.workbench.feedCreateCanvas")}
                            <ArrowRight className="size-3.5" />
                        </Button>
                    ) : null}
                </div>
            </>
        );
    };

    // 「生成动态」历史卡片网格已下线：非对话形态不再渲染任何 feed 区块。
    // 生成进度 / 结果统一在全屏对话工作台（threadActive）里呈现，历史对话走工具栏的「历史对话」抽屉。
    if (!threadActive) return null;

    // 对话形态：工具栏 + 影策式消息流（用户消息右置气泡，助手回复块紧随其后）+ 底部停靠 composer。
    return (
        <section id="creative-generation-feed" className="flex min-h-0 flex-1 flex-col" data-testid="creative-thread-workbench" aria-label={t("home.workbench.threadTitle")}>
            <div className="flex min-h-0 flex-1 flex-col rounded-[14px] border border-border bg-background/60">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3" data-testid="creative-thread-toolbar">
                    <div className="flex min-w-0 items-center gap-2">
                        {onBack ? (
                            <Button
                                type="text"
                                size="small"
                                className="ui-icon-button !text-muted-foreground"
                                data-testid="creative-thread-back"
                                aria-label={t("home.workbench.threadBack")}
                                icon={<ArrowLeft className="size-4" />}
                                onClick={onBack}
                            />
                        ) : null}
                        <h2 className="ui-panel-title shrink-0">{t("home.workbench.threadTitle")}</h2>
                        <span className="ui-caption hidden min-w-0 truncate text-muted-foreground lg:inline">{t("home.workbench.threadHint")}</span>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button size="small" icon={<MessageSquarePlus className="size-3.5" />} data-testid="creative-thread-new" onClick={() => onNewThread?.()}>
                            {t("home.workbench.threadNew")}
                        </Button>
                        {hasOtherConversations && onOpenHistory ? (
                            <Button size="small" icon={<History className="size-3.5" />} data-testid="creative-thread-history" onClick={() => onOpenHistory()}>
                                {t("home.workbench.threadHistory")}
                            </Button>
                        ) : null}
                        <Button
                            size="small"
                            type="primary"
                            icon={<LayoutGrid className="size-3.5" />}
                            data-testid="creative-thread-continue-canvas"
                            data-canvas-action="create"
                            disabled={!latest || !onCreateCanvas || !canCreateCanvas}
                            title={canCreateCanvas ? undefined : t("home.workbench.threadCanvasPending")}
                            onClick={() => onCreateCanvas?.()}
                        >
                            {t("home.workbench.threadContinueCanvas")}
                            <ArrowRight className="size-3.5" />
                        </Button>
                    </div>
                </div>
                <div
                    ref={threadScrollRef}
                    className="mx-auto flex w-full max-w-[1440px] min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6 lg:px-8"
                    onScroll={(event) => {
                        const el = event.currentTarget;
                        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                    }}
                >
                    <div ref={threadContentRef} className="flex flex-col gap-7">
                    {chronological.length === 0 ? (
                        <p className="ui-caption py-8 text-center text-muted-foreground" data-testid="creative-thread-empty">{t("home.workbench.threadEmpty")}</p>
                    ) : chronological.map(launch => {
                        const task = tasks.find(item => item.id === launch.taskId);
                        const projectLogs = logs.filter(log => log.projectId === launch.projectId && (!launch.nodeId || !log.nodeId || log.nodeId === launch.nodeId));
                        const status = launchStatus(task, projectLogs);
                        const running = status === "queued" || status === "running";
                        const Icon = MODE_ICONS[launch.mode];
                        return (
                            <div key={launch.taskId} className="flex min-w-0 flex-col gap-4" data-testid="creative-thread-message">
                                {/* 用户消息：右置气泡 + 元信息 + 复制/编辑（影策 creation-user-message） */}
                                <article className="flex min-w-0 flex-col items-end gap-1.5">
                                    <div className="flex items-center gap-2">
                                        <span className="ui-caption text-muted-foreground">{time(launch.createdAt)}</span>
                                        <span className="ui-caption font-medium text-foreground">{t("home.workbench.threadYou")}</span>
                                        <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                                            <UserRound className="size-3.5" />
                                        </span>
                                        <Button
                                            type="text"
                                            size="small"
                                            className="ui-icon-button size-6 !p-0"
                                            data-testid="creative-thread-message-dismiss"
                                            aria-label={t("home.workbench.feedDismiss")}
                                            icon={<X className="size-3.5" />}
                                            onClick={() => onDismiss(launch.taskId)}
                                        />
                                    </div>
                                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-muted/70 px-4 py-2.5" data-testid="creative-thread-user-bubble">
                                        <p className="ui-body min-w-0 whitespace-pre-wrap break-words text-left leading-6">{launch.prompt}</p>
                                    </div>
                                    {launch.references?.length ? <CreativeMessageReferences references={launch.references} /> : null}
                                    <div className="flex items-center gap-1">
                                        <Button
                                            type="text"
                                            size="small"
                                            className="ui-icon-button !text-muted-foreground"
                                            aria-label={t("home.workbench.feedTextCopy")}
                                            icon={<Copy className="size-3.5" />}
                                            onClick={() => {
                                                void navigator.clipboard.writeText(launch.prompt)
                                                    .then(() => message.success(t("home.workbench.feedTextCopied")))
                                                    .catch(() => message.error(t("home.workbench.feedTextCopyFailed")));
                                            }}
                                        />
                                        {onEditPrompt ? (
                                            <Button
                                                type="text"
                                                size="small"
                                                className="ui-icon-button !text-muted-foreground"
                                                data-testid="creative-thread-edit"
                                                aria-label={t("home.workbench.threadEditResend")}
                                                icon={<Pencil className="size-3.5" />}
                                                onClick={() => onEditPrompt(launch.prompt)}
                                            />
                                        ) : null}
                                    </div>
                                </article>
                                {/* 助手回复块：模式徽标 + 标题 + 状态 chip + 内容（影策 creation-assistant-message） */}
                                <article className="flex min-w-0 flex-col items-stretch gap-2 pl-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                                            <Orbit className="size-3.5" />
                                        </span>
                                        <strong className="ui-body font-semibold">{assistantTitle(launch)}</strong>
                                        <span className="ui-caption text-muted-foreground">{time(launch.createdAt)}</span>
                                        {running ? (
                                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="creative-thread-state-running">
                                                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                                                {t("home.workbench.status_running")}
                                            </span>
                                        ) : status === "succeeded" ? (
                                            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                                <CheckCheck className="size-3" aria-hidden="true" />
                                                {t("home.workbench.threadDone")}
                                            </span>
                                        ) : status === "failed" ? (
                                            <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                                                {t("home.workbench.status_failed")}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="min-w-0 rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3">
                                        <div className="flex items-start gap-2.5">
                                            <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                                            <div className="min-w-0 flex-1">{messageBody(launch)}</div>
                                        </div>
                                    </div>
                                </article>
                            </div>
                        );
                    })}
                    </div>
                </div>
                {composer ? (
                    <div className="border-t border-border px-4 pb-4 pt-3" data-testid="creative-thread-composer">
                        {composer}
                    </div>
                ) : null}
            </div>
        </section>
    );
}
