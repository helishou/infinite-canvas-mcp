import type { ReactNode } from "react";
import { AudioLines, ArrowLeft, ArrowRight, CheckCheck, Copy, History, Image as ImageIcon, LayoutGrid, Loader2, MessageSquarePlus, Orbit, Pencil, Type, UserRound, Video, X } from "lucide-react";
import { App, Button, Progress, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";
import { modelOptionLabel, useConfigStore } from "@/stores/use-config-store";
import type { BackendGenerationLog, BackendRuntimeTask } from "@/services/backend-api";
import { collectOutputs, launchStatus, launchTextResults, type CreativeLaunch, type WorkbenchOutput } from "./workbench-data";
import { WorkbenchMediaPreview } from "./workbench-media";

const MODE_ICONS = { image: ImageIcon, video: Video, text: Type, audio: AudioLines } as const;
const surface = "rounded-[10px] border border-border bg-card";

function statusColor(status: BackendRuntimeTask["status"]) {
    return status === "failed" ? "error" : status === "running" ? "processing" : status === "succeeded" ? "success" : status === "awaiting_confirmation" ? "warning" : "default";
}

/**
 * 首页「对话工作台」（对齐影策 thread-workbench）：
 * 提交后不跳转，首页原地进入对话形态——用户消息右置气泡 + 助手回复块（markdown / 结果网格），
 * 底部停靠 composer 随时追问；工具栏提供「新对话」「历史对话」与「继续在画布上编辑」（显式进入画布精修）。
 * 数据全部来自首页既有的任务 / 生成日志实时刷新，不额外发请求。
 */
export function CreativeGenerationFeed({ launches, tasks, logs, threadActive = false, composer, onDismiss, onOpenProject, onPreview, onNewThread, onContinueCanvas, onOpenHistory, hasOtherConversations = false, onEditPrompt, onBack }: {
    launches: CreativeLaunch[];
    tasks: BackendRuntimeTask[];
    logs: BackendGenerationLog[];
    /** true = 对话形态（工具栏 + 消息流 + 停靠 composer）；false = 历史形态（紧凑卡片网格）。 */
    threadActive?: boolean;
    /** 仅对话形态：停靠在消息流底部的追问输入条（CreativeLaunchPad variant="thread"）。 */
    composer?: ReactNode;
    onDismiss: (taskId: string) => void;
    onOpenProject: (projectId: string) => void;
    onPreview: (output: WorkbenchOutput) => void;
    /** 仅对话形态：新建对话。 */
    onNewThread?: () => void;
    /** 仅对话形态：把最近一次提交的成果交接进画布。 */
    onContinueCanvas?: (projectId: string, nodeId?: string) => void;
    /** 仅对话形态：打开历史对话抽屉。 */
    onOpenHistory?: () => void;
    /** 存在其他会话时才显示历史入口。 */
    hasOtherConversations?: boolean;
    /** 仅对话形态：编辑并重发（影策）——把提示词回填进追问输入条。 */
    onEditPrompt?: (text: string) => void;
    /** 仅对话形态：全屏对话页的返回按钮（收起对话回创作台）。 */
    onBack?: () => void;
}) {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const config = useConfigStore(state => state.config);
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(i18n.resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
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
        // 会话内多轮共享同一张画布：按本条提交的生成节点隔离日志，避免各消息互相串结果。
        const projectLogs = logs.filter(log => log.projectId === launch.projectId && (!launch.nodeId || !log.nodeId || log.nodeId === launch.nodeId));
        const status = launchStatus(task, projectLogs);
        const outputs = collectOutputs(projectLogs);
        const texts = launch.mode === "text" ? launchTextResults(task, projectLogs) : [];
        const error = task?.error || projectLogs.find(log => log.status === "failed")?.error || "";
        const running = status === "queued" || status === "running";
        return (
            <>
                {running && (
                    <Progress className="!mt-3" percent={Math.min(100, Math.max(0, Math.round((Number(task?.progress) || 0) * 100)))} size="small" status={status === "running" ? "active" : "normal"} />
                )}
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
                {outputs.length > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="creative-launch-outputs">
                        {outputs.slice(0, 8).map(output => (
                            <button
                                key={output.id}
                                type="button"
                                className="group h-24 cursor-pointer overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-foreground/40"
                                data-testid="creative-launch-output"
                                aria-label={t("home.workbench.previewNamed", { name: launch.prompt })}
                                onClick={() => onPreview(output)}
                            >
                                <WorkbenchMediaPreview media={output} label={t(`home.workbench.${output.kind}`)} />
                            </button>
                        ))}
                    </div>
                )}
                {status === "succeeded" && !outputs.length && !texts.length && (
                    <p className="ui-caption mt-3 text-muted-foreground">{t("home.workbench.feedNoOutputs")}</p>
                )}
                <div className="mt-3 flex items-center justify-end gap-2">
                    <Button type="link" size="small" className="!px-0" data-testid="creative-launch-open-canvas" onClick={() => onOpenProject(launch.projectId)}>
                        {t("home.workbench.feedOpenCanvas")}
                        <ArrowRight className="size-3.5" />
                    </Button>
                </div>
            </>
        );
    };

    if (!threadActive) {
        // 历史形态：保留紧凑卡片网格，作为「历史对话」的落点（跨会话按时间倒序铺平）。
        return (
            <section id="creative-generation-feed" className="mb-6 scroll-mt-24" data-testid="creative-generation-feed" aria-label={t("home.workbench.feedTitle")}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="ui-panel-title">{t("home.workbench.feedTitle")}</h2>
                    <span className="ui-caption text-muted-foreground">{t("home.workbench.feedHint")}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {launches.map(launch => {
                        const task = tasks.find(item => item.id === launch.taskId);
                        const status = launchStatus(task, logs.filter(log => log.projectId === launch.projectId));
                        const Icon = MODE_ICONS[launch.mode];
                        return (
                            <article key={launch.taskId} className={cn(surface, "min-w-0 p-4")} data-testid="creative-launch-card" data-launch-status={status}>
                                <div className="flex items-start gap-2.5">
                                    <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                                    <div className="min-w-0 flex-1">
                                        <p className="ui-group-title truncate" title={launch.prompt}>{launch.prompt}</p>
                                        <p className="ui-caption mt-1 truncate text-muted-foreground" title={modelOptionLabel(config, launch.model)}>
                                            {modelOptionLabel(config, launch.model)} · {date(launch.createdAt)}
                                        </p>
                                    </div>
                                    <Tag className="!mr-0 shrink-0" color={statusColor(status)}>{t(`home.workbench.status_${status}`)}</Tag>
                                    <Button
                                        type="text"
                                        size="small"
                                        className="ui-icon-button shrink-0"
                                        data-testid="creative-launch-dismiss"
                                        aria-label={t("home.workbench.feedDismiss")}
                                        icon={<X className="size-4" />}
                                        onClick={() => onDismiss(launch.taskId)}
                                    />
                                </div>
                                {messageBody(launch)}
                            </article>
                        );
                    })}
                </div>
            </section>
        );
    }

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
                            disabled={!latest}
                            onClick={() => onContinueCanvas?.(latest.projectId, latest.nodeId)}
                        >
                            {t("home.workbench.threadContinueCanvas")}
                            <ArrowRight className="size-3.5" />
                        </Button>
                    </div>
                </div>
                <div className="mx-auto flex w-full max-w-[1000px] min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 py-6">
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
                {composer ? (
                    <div className="border-t border-border px-4 pb-4 pt-3" data-testid="creative-thread-composer">
                        {composer}
                    </div>
                ) : null}
            </div>
        </section>
    );
}
