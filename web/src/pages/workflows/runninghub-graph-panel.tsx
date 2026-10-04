// RunningHub 档案的节点图：只读展示平台当前节点图。
//
// 云端图以 RunningHub 平台为准，本地改图无法回写，因此不提供编辑与保存；
// 需要改结构时到平台改完再用档案的「重新同步」拉取。
import { useMemo } from "react";
import { Button, Empty } from "antd";
import { ExternalLink } from "lucide-react";
import { WorkflowGraphView, type GraphFieldRef } from "./workflow-graph-view";
import type { RunningHubWorkflowGraph, RunningHubField } from "@/services/api/runninghub";

export function RunningHubGraphPanel({
    workflowId,
    workflow,
    fields,
    baseUrl,
}: {
    workflowId: string;
    workflow?: RunningHubWorkflowGraph | null;
    fields: RunningHubField[];
    baseUrl: string;
}) {
    // 节点图角标只统计已启用的输入映射；RunningHub 字段用 nodeId 关联，
    // 与本地字段的 node 同义，所以可直接喂给 GraphFieldRef。
    const exposedFields = useMemo<GraphFieldRef[]>(
        () => (fields || []).filter((field) => field.enabled !== false).map((field) => ({ node: field.nodeId })),
        [fields],
    );

    const graph = (workflow || {}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    const openUrl = `${baseUrl.replace(/\/$/, "")}/workflow/${encodeURIComponent(workflowId)}`;

    return (
        <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-900">
                <span className="text-xs text-stone-500">
                    只读 · 节点图以 RunningHub 平台为准，改结构请到平台操作后重新同步
                </span>
                <Button size="small" icon={<ExternalLink className="size-3.5" />} href={openUrl} target="_blank" rel="noopener noreferrer">
                    在 RunningHub 打开
                </Button>
            </div>
            {Object.keys(graph).length ? (
                <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                    <WorkflowGraphView workflow={graph} fields={exposedFields} renderNodePopup={() => null} />
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                    <Empty description="该档案还没有节点图快照，点「重新同步」从平台读取" />
                </div>
            )}
        </div>
    );
}
