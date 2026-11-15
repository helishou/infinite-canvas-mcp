import { AgentSubagents } from "./agent-subagents";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useSpring, useTransform } from "motion/react";
import { CheckCircle2, ChevronDown, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { summarizeCanvasAgentOps } from "@/lib/canvas/canvas-agent-ops";
import { useAgentStore, type AgentChatItem, type AgentPendingApproval, type AgentPendingToolCall, type AgentTokenUsage } from "@/stores/use-agent-store";
import { AgentApprovalCard, AgentChatMessage, AgentCommandGroup, AgentPendingToolCard, AgentWorkingMessage } from "./agent-chat-message";
import { agentMessageToChatMessage, currentPlanMessage, isPlanMessage, latestPlanMessage, planFlow, toolCallDetail, toolName, workingActivity } from "./agent-event-formatters";
import { planFlowRows } from "./agent-plan-flow";
import { looksLikeOutlineWork, outlineFlowRows } from "./agent-outline-flow";
import { productionFlowRows } from "./agent-production-flow";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { AgentScrollToBottom } from "./agent-scroll-to-bottom";

const SCROLL_BOTTOM_THRESHOLD = 48;
const historyMessageStyle = { contentVisibility: "auto", containIntrinsicSize: "0 80px" } as const;

export function AgentChatTimeline({
    theme,
    pendingTool,
    pendingApprovals,
    sending,
    waiting,
    onRejectTool,
    onApproveTool,
    onApprovalDecision,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    pendingTool: AgentPendingToolCall | null;
    pendingApprovals: AgentPendingApproval[];
    sending: boolean;
    waiting: boolean;
    onRejectTool: () => void;
    onApproveTool: () => void;
    onApprovalDecision: (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => void;
}) {
    const { t } = useTranslation();
    const messages = useAgentStore((state) => state.messages);
    const bootstrapStatus = useAgentStore((state) => state.bootstrapStatus);
    const mcpStartupStatuses = useAgentStore((state) => state.mcpStartupStatuses);
    const connectError = useAgentStore((state) => state.connectError);
    const timeline = useMemo(() => groupTimelineMessages(messages), [messages]);
    const listRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const followMessagesRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const streaming = messages.some((message) => message.streamId);
    const showBootstrap = Boolean(bootstrapStatus && !messages.some((message) => message.role === "user" || message.role === "assistant"));
    const working = waiting && connectError ? { key: "runtime-sync-error", text: connectError, status: "failed" as const } : showBootstrap ? bootstrapStatus! : workingActivity(messages.at(-1));
    const updateScrollState = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
        followMessagesRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
    }, []);
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        if (!list) return;
        followMessagesRef.current = true;
        list.scrollTo({ top: list.scrollHeight, behavior });
        setShowScrollToBottom(false);
    }, []);
    useEffect(() => {
        const frame = requestAnimationFrame(() => (followMessagesRef.current ? scrollToBottom("auto") : updateScrollState()));
        return () => cancelAnimationFrame(frame);
    }, [messages, pendingApprovals, pendingTool, scrollToBottom, updateScrollState, waiting]);
    useEffect(() => {
        const content = contentRef.current;
        if (!content) return;
        let frame = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => (followMessagesRef.current ? scrollToBottom("auto") : updateScrollState()));
        });
        observer.observe(content);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [scrollToBottom, updateScrollState]);
    return (
        <div className="relative min-h-0 flex-1">
            <div ref={listRef} className="thin-scrollbar h-full select-text overflow-y-auto" onScroll={updateScrollState}>
                <div ref={contentRef} className="space-y-4 px-4 pt-4">
                    {timeline.map((entry) => entry.type === "commands"
                        ? <AgentCommandGroupRow key={entry.id} items={entry.items} theme={theme} />
                        : <AgentChatMessageRow key={entry.item.id} item={entry.item} theme={theme} />)}
                    <AgentSubagents theme={theme} />
                    {pendingTool ? (
                        <AgentPendingToolCard
                            summary={summarizeCanvasAgentOps(pendingTool.input?.ops || []) || toolName(pendingTool.name)}
                            detail={toolCallDetail(pendingTool.name, pendingTool.input, "pending")}
                            theme={theme}
                            onReject={onRejectTool}
                            onApprove={onApproveTool}
                        />
                    ) : null}
                    {pendingApprovals.map((approval) => <AgentApprovalCard key={approval.requestId} approval={approval} theme={theme} onDecision={(decision) => onApprovalDecision(approval, decision)} />)}
                    {(sending || waiting || showBootstrap) && !streaming && !pendingTool && !pendingApprovals.length ? <AgentWorkingMessage text={working.text} detail={"detail" in working && typeof working.detail === "string" ? working.detail : undefined} status={showBootstrap ? bootstrapStatus?.status : undefined} mcpStatuses={showBootstrap ? Object.entries(mcpStartupStatuses).map(([name, item]) => ({ name, ...item })) : []} activityKey={working.key} theme={theme} /> : null}
                </div>
            </div>
            {showScrollToBottom ? (
                <AgentScrollToBottom theme={theme} title={t("agent.chat.latestMessages")} onClick={() => scrollToBottom()} />
            ) : null}
        </div>
    );
}

/** 面板里一行：模型计划、制作阶段、大纲三种来源统一成这个形状，渲染只认它。 */
type PanelRow = { index: number | string; label: string; tone: "done" | "running" | "pending"; statusKey: string; depth: 0 | 1 };

export function AgentTaskProgress({ theme, busy }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; busy: boolean }) {
    const { t, i18n } = useTranslation();
    const messages = useAgentStore((state) => state.messages);
    const production = useProductionWorkspaceStore((state) => state.production);
    const plan = busy ? currentPlanMessage(messages) : latestPlanMessage(messages);
    const flow = planFlow(plan);
    const turnTexts = busy && !flow ? currentTurnTexts(messages) : [];
    // 有制作源稿阶段游标时，六段制作阶段就是「其他流程」的进度表（真值，不是推断）；当前阶段展开它自己的子步。
    const stageRows = flow ? [] : productionFlowRows(production?.draft?.settings?.productionStage ?? null, turnTexts, busy, i18n.language.startsWith("en"));
    // 没有制作游标、但这一轮明显在写大纲/剧本时，才用技能里的大纲六段顶上。
    const outline = flow || stageRows.length ? null : looksLikeOutlineWork(turnTexts) ? outlineFlowRows(turnTexts, busy) : null;
    const [open, setOpen] = useState(true);
    const [elapsed, setElapsed] = useState(0);
    // 计时按「本轮还在跑」算：清单每更新一次都会换 id，用 id 当键会把计时反复归零，所以只在 busy 翻转时重置。
    const startedAtRef = useRef(0);
    useEffect(() => {
        if (!busy) {
            startedAtRef.current = 0;
            setElapsed(0);
            return;
        }
        if (!startedAtRef.current) startedAtRef.current = Date.now();
        const tick = () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [busy]);
    // 三种来源统一成一种行，渲染只认 label/tone/depth，不关心的来源细节。
    const rows: PanelRow[] = flow
        ? planFlowRows(flow).map((row) => ({ ...row, depth: 0 as const }))
        : stageRows.length
            ? stageRows.map((row) => ({ index: row.index, label: row.labelKey ? t(row.labelKey) : row.label ?? "", tone: row.tone, statusKey: row.statusKey, depth: row.depth }))
            : (outline ?? []).map((row) => ({ ...row, depth: 0 as const }));
    if (!rows.length) return null;
    const topRows = rows.filter((row) => row.depth === 0);
    const done = topRows.filter((row) => row.tone === "done").length;
    const running = busy && rows.some((row) => row.tone === "running");
    const allDone = done === topRows.length;
    return (
        <div className="shrink-0 px-4 pt-2" data-agent-flow={flow ? "plan" : stageRows.length ? "stage" : "outline"}>
            <div className="min-w-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                <button type="button" className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
                    <ListChecks className="size-3.5 shrink-0" style={{ color: allDone ? "#16a34a" : theme.node.muted }} />
                    <span className="shrink-0 text-xs font-semibold">{t("agent.chat.flowTitle")}</span>
                    <span aria-live="polite" className="shrink-0 text-[11px] tabular-nums opacity-50">{done}/{topRows.length}</span>
                    <span className="min-w-0 flex-1" />
                    <span className="shrink-0 text-[11px] opacity-50">{open ? t("agent.chat.flowCollapse") : t("agent.chat.flowExpand")}</span>
                    <ChevronDown className={`size-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                {open ? (
                    <ol className="thin-scrollbar max-h-52 space-y-1 overflow-y-auto px-3 pb-2">
                        {rows.map((row) => {
                            const color = row.tone === "done" ? "#16a34a" : row.tone === "running" ? "#d97706" : theme.node.muted;
                            const note = row.tone === "running" && running
                                ? [flow?.explanation, elapsed >= 5 ? waitingLabel(t, elapsed) : ""].filter(Boolean).join(" · ")
                                : "";
                            return (
                                <li key={`${row.index}-${row.label}`} className="min-w-0">
                                    <div className={`flex min-w-0 items-start gap-2 leading-5 ${row.depth === 1 ? "pl-4 text-[11px]" : "text-xs"}`}>
                                        <span className="mt-1 shrink-0" style={{ color }}>{row.tone === "done" ? <CheckCircle2 className="size-3" /> : row.tone === "running" ? <LoaderCircle className="size-3 animate-spin" /> : <Circle className="size-3" />}</span>
                                        <span className={`min-w-0 break-words ${row.tone === "done" ? "opacity-55" : row.tone === "running" ? "font-medium" : "opacity-75"}`} style={{ color: row.tone === "running" ? theme.node.text : theme.node.muted }}>{row.depth === 1 ? `${row.index} ${row.label}` : `${row.index}. ${row.label}`}</span>
                                        <span className="ml-auto shrink-0 pl-2 text-[11px]" style={{ color }}>{t(row.statusKey)}</span>
                                    </div>
                                    {note ? <p className="ml-5 break-words text-[11px] leading-4" style={{ color: theme.node.muted }}>{note}</p> : null}
                                </li>
                            );
                        })}
                    </ol>
                ) : null}
            </div>
        </div>
    );
}

/** 本轮（最后一条用户消息之后）出现过的文案：工具卡片标题、正文、状态说明都算。 */
function currentTurnTexts(messages: AgentChatItem[]) {
    const texts: string[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === "user") break;
        const text = `${message.title || ""} ${message.text || ""}`.trim();
        if (text) texts.push(text);
    }
    return texts;
}

function waitingLabel(t: (key: string, options?: Record<string, unknown>) => string, seconds: number) {
    if (seconds < 60) return t("agent.message.waitingSeconds", { seconds });
    return t("agent.message.waitingMinutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

const AgentChatMessageRow = memo(function AgentChatMessageRow({ item, theme }: { item: AgentChatItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const endpoint = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    return (
        <div style={item.streamId ? undefined : historyMessageStyle}>
            <AgentChatMessage item={agentMessageToChatMessage(item, endpoint, token)} theme={theme} />
        </div>
    );
});

const AgentCommandGroupRow = memo(function AgentCommandGroupRow({ items, theme }: { items: AgentChatItem[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div style={items.some((item) => item.streamId) ? undefined : historyMessageStyle}>
            <AgentCommandGroup items={items} theme={theme} />
        </div>
    );
});

type AgentTimelineEntry = { type: "message"; item: AgentChatItem } | { type: "commands"; id: string; items: AgentChatItem[] };

function groupTimelineMessages(messages: AgentChatItem[]) {
    const timeline: AgentTimelineEntry[] = [];
    let commands: AgentChatItem[] = [];
    let commandScope = "";
    const flushCommands = () => {
        if (!commands.length) return;
        timeline.push({ type: "commands", id: `commands:${commands[0].id}`, items: commands });
        commands = [];
        commandScope = "";
    };
    messages.forEach((item) => {
        if (isPlanMessage(item)) return;
        if (isCommandMessage(item)) {
            const scope = item.threadId && item.turnId ? `${item.threadId}\0${item.turnId}` : item.id;
            if (commands.length && scope !== commandScope) flushCommands();
            commands.push(item);
            commandScope = scope;
            return;
        }
        flushCommands();
        timeline.push({ type: "message", item });
    });
    flushCommands();
    return timeline;
}

function isCommandMessage(item: AgentChatItem) {
    return item.role === "tool" && item.detail && typeof item.detail === "object" && (item.detail as { kind?: unknown }).kind === "command";
}

export function AgentUsageBar({ usage, theme }: { usage: AgentTokenUsage; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-center gap-4 px-4 pt-1 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
            <span className="opacity-70">{t("agent.chat.latestCall")}</span>
            <UsageNumber label={t("agent.chat.input")} value={usage.input} color={theme.node.text} />
            <UsageNumber label={t("agent.chat.cached")} value={usage.cached} color={theme.node.text} />
            <UsageNumber label={t("agent.chat.output")} value={usage.output} color={theme.node.text} />
        </div>
    );
}

function UsageNumber({ label, value, color }: { label: string; value: number; color: string }) {
    const spring = useSpring(value, { stiffness: 110, damping: 24, mass: 0.7 });
    const text = useTransform(spring, (current) => Math.round(current).toLocaleString());
    useEffect(() => spring.set(value), [spring, value]);
    return (
        <span className="inline-flex items-baseline gap-1" aria-label={`${label} ${value.toLocaleString()}`}>
            <span>{label}</span>
            <motion.span aria-hidden className="font-medium" style={{ color }}>
                {text}
            </motion.span>
        </span>
    );
}
