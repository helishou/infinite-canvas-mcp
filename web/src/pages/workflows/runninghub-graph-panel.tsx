// RunningHub 档案的节点图：展示平台当前节点图。
//
// 图结构以 RunningHub 平台为准，本地改节点/连线无法回写，所以图本身只读；
// 但节点输入的字段映射存在档案里、可以改——这与本地工作流完全一致，
// 改完立刻 PUT 回档案，运行页签就能收到自定义参数。
import { useCallback, useMemo } from "react";
import { Button, Empty } from "antd";
import { ExternalLink } from "lucide-react";
import { WorkflowGraphView, isGraphLinkValue, type GraphFieldRef } from "./workflow-graph-view";
import { NodeFieldPopupShell, type NodeInputEntry } from "./node-field-popup";
import { FieldEditor } from "./field-editor";
import type { WorkflowField } from "@/types/workflow";
import type { RunningHubWorkflowGraph, RunningHubField } from "@/services/api/runninghub";

export function RunningHubGraphPanel({
    workflowId,
    workflow,
    fields,
    baseUrl,
    onFieldsChange,
}: {
    workflowId: string;
    workflow?: RunningHubWorkflowGraph | null;
    fields: RunningHubField[];
    baseUrl: string;
    /** 映射改动立刻写回档案；与本地工作流的字段保存时机一致。 */
    onFieldsChange: (fields: RunningHubField[]) => void;
}) {
    // 节点图角标只统计已启用的输入映射；RunningHub 字段用 nodeId 关联，
    // 与本地字段的 node 同义，所以可直接喂给 GraphFieldRef。
    const exposedFields = useMemo<GraphFieldRef[]>(
        () => (fields || []).filter((field) => field.enabled !== false).map((field) => ({ node: field.nodeId })),
        [fields],
    );

    const graph = (workflow || {}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
    const openUrl = `${baseUrl.replace(/\/$/, "")}/workflow/${encodeURIComponent(workflowId)}`;

    /** 一个输入对应一条映射；key 用 nodeId::fieldName，与后端 validateFields 的去重键一致。 */
    const updateField = useCallback((nodeId: string, inputKey: string, patch: Partial<RunningHubField>) => {
        const key = `${nodeId}::${inputKey}`;
        const exists = (fields || []).some((field) => `${field.nodeId}::${field.fieldName}` === key);
        if (exists) {
            onFieldsChange((fields || []).map((field) => (`${field.nodeId}::${field.fieldName}` === key ? { ...field, ...patch } : field)));
        } else {
            onFieldsChange([...(fields || []), { id: key, nodeId, fieldName: inputKey, enabled: true, ...patch }]);
        }
    }, [fields, onFieldsChange]);

    const toggleField = useCallback((nodeId: string, inputKey: string) => {
        const key = `${nodeId}::${inputKey}`;
        const current = (fields || []).find((field) => `${field.nodeId}::${field.fieldName}` === key);
        // 取消勾选 = 删掉这条映射，运行时不覆盖该输入，沿用平台原值。
        if (current) onFieldsChange((fields || []).filter((field) => `${field.nodeId}::${field.fieldName}` !== key));
        else updateField(nodeId, inputKey, {});
    }, [fields, onFieldsChange, updateField]);

    const removeField = useCallback((nodeId: string, inputKey: string) => {
        const key = `${nodeId}::${inputKey}`;
        onFieldsChange((fields || []).filter((field) => `${field.nodeId}::${field.fieldName}` !== key));
    }, [fields, onFieldsChange]);

    return (
        <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-900">
                <span className="text-xs text-stone-500">
                    图结构以 RunningHub 平台为准，改结构请到平台操作后重新同步；节点输入映射可直接在这里配置
                </span>
                <Button size="small" icon={<ExternalLink className="size-3.5" />} href={openUrl} target="_blank" rel="noopener noreferrer">
                    在 RunningHub 打开
                </Button>
            </div>
            {Object.keys(graph).length ? (
                <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
                    <WorkflowGraphView
                        workflow={graph}
                        fields={exposedFields}
                        renderNodePopup={(nodeId, close) => {
                            const node = graph[nodeId];
                            // 连接型输入是 [源节点, 端口]，不是可填写的字段。
                            const inputs: NodeInputEntry[] = Object.entries(node?.inputs || {}).filter(
                                ([, value]) => !isGraphLinkValue(value),
                            );
                            const nodeFields = (fields || []).filter((field) => field.nodeId === nodeId);
                            const fieldMap = new Map(nodeFields.map((field) => [field.fieldName, field]));

                            return (
                                <NodeFieldPopupShell
                                    classType={node?.class_type || ""}
                                    nodeId={nodeId}
                                    inputs={inputs}
                                    emptyText="该节点没有可配置的输入"
                                    onToggle={(inputKey) => toggleField(nodeId, inputKey)}
                                    onClose={close}
                                    rowState={(inputKey) => {
                                        const field = fieldMap.get(inputKey);
                                        return {
                                            active: Boolean(field),
                                            editor: field ? (
                                                <FieldEditor
                                                    field={toLocalField(field)}
                                                    rawValue={node?.inputs?.[inputKey]}
                                                    showRunningHub
                                                    onUpdate={(patch) => updateField(nodeId, inputKey, fromLocalPatch(patch))}
                                                    onRemove={() => removeField(nodeId, inputKey)}
                                                />
                                            ) : undefined,
                                        };
                                    }}
                                />
                            );
                        }}
                    />
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                    <Empty description="该档案还没有节点图快照，点「重新同步」从平台读取" />
                </div>
            )}
        </div>
    );
}

/**
 * 档案映射 → 字段编辑器用的本地字段。
 * FieldEditor 是本地与 RH 共用的编辑器，它读的是 WorkflowField；
 * 这一层只做形状转换，不改变映射语义。
 */
function toLocalField(field: RunningHubField): WorkflowField {
    const type = fieldTypeOf(field);
    // 契约仍允许读出 param（老档案兼容，见 normalizeRunningHubFieldSources），
    // 但它已不是可写入的来源；后端读档案时会降级成 constant，这里同样归一。
    const source = field.source === "param" ? "constant" : field.source;
    return {
        id: `${field.nodeId}::${field.fieldName}`,
        node: field.nodeId,
        input: field.fieldName,
        name: field.label || `${field.nodeId}.${field.fieldName}`,
        type,
        default: field.fieldValue as never,
        ...(field.required ? { required: true } : {}),
        ...(type === "text" && source === "prompt" ? { isPrompt: true } : {}),
        // 值来源等 RH 语义用 rh* 字段带回编辑器，编辑器不直接改 RunningHubField。
        ...(source ? { rhSource: source } : {}),
        ...(field.index !== undefined ? { rhIndex: field.index } : {}),
    };
}

/** 字段编辑器改出的本地字段 → 档案映射补丁；只回写 RH 认识的键。 */
function fromLocalPatch(patch: Partial<WorkflowField>): Partial<RunningHubField> {
    return {
        ...(patch.name !== undefined ? { label: patch.name } : {}),
        ...(patch.type !== undefined ? { fieldType: patch.type } : {}),
        ...(patch.type !== undefined ? { fieldValue: mediaTypeOf(patch.type) ? undefined : patch.default } : {}),
        ...(patch.default !== undefined ? { fieldValue: patch.default } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.rhSource !== undefined ? { source: patch.rhSource } : {}),
        ...(patch.isPrompt !== undefined ? { source: patch.isPrompt ? "prompt" : undefined } : {}),
        ...(patch.rhIndex !== undefined ? { index: patch.rhIndex } : {}),
    };
}

/** LoadImage/LoadAudio/LoadVideo 的输入是 COMBO 文件列表，必须按媒体类型处理。 */
function mediaTypeOf(type: WorkflowField["type"]): boolean {
    return type === "image" || type === "audio" || type === "video";
}

function fieldTypeOf(field: RunningHubField): WorkflowField["type"] {
    if (field.fieldType === "image" || field.fieldType === "video" || field.fieldType === "audio") return field.fieldType;
    if (field.fieldType === "number" || field.fieldType === "boolean" || field.fieldType === "slider" || field.fieldType === "dropdown") return field.fieldType;
    return "text";
}
