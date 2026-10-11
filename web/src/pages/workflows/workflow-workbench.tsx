import type { ReactNode } from "react";
import { Code, History, Play } from "lucide-react";

export type WorkbenchTab = "graph" | "run" | "history";

const TABS: Array<{ key: WorkbenchTab; label: string; icon: typeof Code }> = [
    { key: "graph", label: "节点图", icon: Code },
    { key: "run", label: "运行", icon: Play },
    { key: "history", label: "历史", icon: History },
];

type Props = {
    activeTab: WorkbenchTab;
    onTabChange: (tab: WorkbenchTab) => void;
    historyCount: number;
    /** 标题区（可含行内改名）。 */
    title: ReactNode;
    /** 标题下的灰色摘要，例如「workflowId · N 个节点 · M 个映射」。 */
    subtitle?: ReactNode;
    /** 标题区右侧操作按钮组。 */
    actions?: ReactNode;
    /** 标题区上方的提示条。 */
    alerts?: ReactNode;
    /** 未选中任何条目时的占位。 */
    emptyHint?: ReactNode;
    graph: ReactNode;
    run: ReactNode;
    history: ReactNode;
    /** 节点图页是否需要最小高度约束。 */
    graphMinHeight?: string;
};

/**
 * 工作台外壳：标题区 + 节点图/运行/历史三页签。
 * 本地 ComfyUI 与 RunningHub 的节点图和运行表单已经共用渲染层，
 * 剩下的差别只在数据源，所以这一层外壳也只保留一份。
 */
export function WorkflowWorkbench({
    activeTab, onTabChange, historyCount, title, subtitle, actions, alerts, emptyHint,
    graph, run, history, graphMinHeight = "min-h-[280px]",
}: Props) {
    return (
        <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex shrink-0 items-center justify-between rounded-lg border border-stone-200 bg-white px-4 py-3 dark:border-stone-700 dark:bg-stone-900">
                <div className="min-w-0">
                    <div className="truncate text-base font-semibold">{title}</div>
                    {subtitle ? <p className="mt-0.5 truncate text-xs text-stone-500">{subtitle}</p> : null}
                </div>
                {actions ? <div className="ml-3 flex shrink-0 gap-2">{actions}</div> : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                {alerts}
                <div className="flex shrink-0 border-b border-stone-200 dark:border-stone-700">
                    {TABS.map(({ key, label, icon: Icon }) => (
                        <button
                            key={key}
                            className={`flex items-center gap-1.5 px-3 py-2 text-xs transition ${activeTab === key ? "border-b-2 border-blue-500 text-blue-600" : "text-stone-500 hover:text-stone-700"}`}
                            onClick={() => onTabChange(key)}
                        >
                            <Icon className="size-3.5" /> {label}
                            {key === "history" ? ` (${historyCount})` : ""}
                        </button>
                    ))}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {emptyHint ?? (
                        <>
                            {activeTab === "graph" ? <div className={`h-full ${graphMinHeight}`}>{graph}</div> : null}
                            {activeTab === "run" ? run : null}
                            {activeTab === "history" ? history : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}