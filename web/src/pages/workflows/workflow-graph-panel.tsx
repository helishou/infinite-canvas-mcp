import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowField } from "@/types/workflow";
import { fetchWorkflowComboOptions } from "@/services/api/workflows";
import { WorkflowGraphView, type WorkflowGraphJson } from "./workflow-graph-view";
import { NodeFieldPopupShell } from "./node-field-popup";
import { FieldEditor } from "./field-editor";

type WorkflowJson = WorkflowGraphJson;

// --- 类型猜测 ---
function guessType(rawValue: unknown, inputName: string): WorkflowField["type"] {
    const lc = (inputName || "").toLowerCase();
    if (typeof rawValue === "boolean") return "boolean";
    if (typeof rawValue === "number") {
        if (/strength|cfg|denoise|scale/.test(lc)) return "slider";
        return "number";
    }
    if (typeof rawValue === "string") {
        if (/prompt|text|description/.test(lc) || (rawValue && rawValue.length > 60)) return "text";
        if (/audio|voice|sound/.test(lc) || /\.(wav|mp3|flac|m4a|aac|ogg|opus)$/i.test(rawValue)) return "audio";
        if (/video|movie/.test(lc) || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(rawValue)) return "video";
        if (/image|img|mask|filename|file/.test(lc) || /\.(png|jpe?g|webp|gif|bmp)/i.test(rawValue)) return "image";
        return "text";
    }
    return "text";
}

function friendlyInputName(key: string): string {
    return key.replace(/_/g, " ").replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
}

type Props = {
    name: string;
    workflow: WorkflowJson;
    fields: WorkflowField[];
    onFieldsChange: (fields: WorkflowField[]) => void;
    onWorkflowChange: (workflow: WorkflowJson) => void;
};

export function WorkflowGraphPanel({ name, workflow, fields, onFieldsChange, onWorkflowChange }: Props) {
    const { t } = useTranslation();
    const [popupNodeId, setPopupNodeId] = useState<string | null>(null);
    const [comboOptions, setComboOptions] = useState<Record<string, Record<string, string[]>>>({});

    useEffect(() => {
        if (!name) return;
        let cancelled = false;
        fetchWorkflowComboOptions(name)
            .then((res) => { if (!cancelled) setComboOptions(res.options || {}); })
            .catch(() => { if (!cancelled) setComboOptions({}); });
        return () => { cancelled = true; };
    }, [name]);

    // 孤儿字段：节点名含逗号（复合多节点写法，节点浮窗无法管理）或节点已不在 workflow 中。
    // 这类字段运行面板会渲染、却无法在节点浮窗里勾选/删除，需在此单独提供清理入口。
    const orphanedFields = useMemo(() => {
        const nodeIds = new Set(Object.keys(workflow));
        return fields.filter((f) => {
            const ids = f.node.split(",");
            if (ids.length > 1) return true;
            return !nodeIds.has(f.node);
        });
    }, [fields, workflow]);

    // --- 字段操作 ---
    const toggleField = (nodeId: string, inputKey: string, rawValue: unknown) => {
        const existing = fields.find(f => f.node === nodeId && f.input === inputKey);
        if (existing) {
            onFieldsChange(fields.filter(f => f !== existing));
        } else {
            const inputOptions = comboOptions[nodeId]?.[inputKey];
            const hasComboOptions = Array.isArray(inputOptions) && inputOptions.length > 0;
            // LoadImage/LoadAudio/LoadVideo 的输入是 COMBO（文件列表），必须按媒体类型处理，
            // 不能因为有下拉选项就判成 dropdown；媒体字段一律不带默认值（显式传入）。
            const classType = String((workflow[nodeId] as { class_type?: unknown } | undefined)?.class_type || "");
            const mediaType: WorkflowField["type"] | null =
                classType === "LoadImage" ? "image"
                : classType === "LoadAudio" ? "audio"
                : /(?:^|_)LoadVideo/.test(classType) ? "video"
                : null;
            const type = mediaType ?? (hasComboOptions ? "dropdown" : guessType(rawValue, inputKey));
            const newField: WorkflowField = {
                id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                node: nodeId,
                input: inputKey,
                name: friendlyInputName(inputKey),
                type,
                default: mediaType || typeof rawValue === "object" ? undefined : rawValue as any,
            };
            if (type === "number" || type === "slider") {
                if (typeof rawValue === "number") {
                    newField.min = 0;
                    newField.max = Math.max(rawValue * 2, 10);
                    newField.step = rawValue > 0 && rawValue < 5 ? 0.1 : 1;
                }
                if (type === "number") newField.randomEnabled = false;
            }
            if (type === "dropdown") newField.options = hasComboOptions ? inputOptions : [];
            onFieldsChange([...fields, newField]);
        }
    };

    const updateField = (fieldId: string, updates: Partial<WorkflowField>) => {
        onFieldsChange(fields.map(f => f.id === fieldId ? { ...f, ...updates } : f));
    };

    const removeField = (fieldId: string) => {
        onFieldsChange(fields.filter(f => f.id !== fieldId));
    };

    if (!workflow || Object.keys(workflow).length === 0) {
        return <div className="flex h-64 items-center justify-center text-sm text-stone-400">无可视化节点</div>;
    }

    return (
        <div className="relative h-full">
            <WorkflowGraphView
                workflow={workflow}
                fields={fields}
                renderNodePopup={(nodeId, close) => (
                    <NodeFieldPopup
                        nodeId={nodeId}
                        node={workflow[nodeId]}
                        fields={fields.filter(f => f.node === nodeId)}
                        comboOptions={comboOptions[nodeId] || {}}
                        onToggleField={(inputKey) => toggleField(nodeId, inputKey, workflow[nodeId]?.inputs?.[inputKey])}
                        onUpdateField={updateField}
                        onRemoveField={removeField}
                        onClose={close}
                    />
                )}
            />

            {orphanedFields.length > 0 && (
                <div className="absolute bottom-2 left-2 right-2 z-30 rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-700 dark:bg-amber-900/30">
                    <div className="mb-1 font-medium text-amber-700 dark:text-amber-300">
                        未关联节点的字段（运行面板会显示，但节点图里无法勾选，可在此删除）
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {orphanedFields.map((f) => (
                            <button
                                key={f.id}
                                onClick={() => onFieldsChange(fields.filter((x) => x.id !== f.id))}
                                className="rounded bg-white/70 px-2 py-1 text-xs text-stone-700 shadow-sm hover:bg-white dark:bg-stone-700/70 dark:text-stone-200 dark:hover:bg-stone-700"
                            >
                                {f.name || f.id} ✕
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── 浮窗组件 ───
function NodeFieldPopup({
    nodeId, node, fields, comboOptions, onToggleField, onUpdateField, onRemoveField, onClose,
}: {
    nodeId: string;
    node: { class_type?: string; inputs?: Record<string, unknown> };
    fields: WorkflowField[];
    comboOptions: Record<string, string[]>;
    onToggleField: (inputKey: string) => void;
    onUpdateField: (fieldId: string, updates: Partial<WorkflowField>) => void;
    onRemoveField: (fieldId: string) => void;
    onClose: () => void;
}) {
    // 只显示非连接型输入（连接型是 [nodeId, slot] 数组）
    const inputs = Object.entries(node.inputs || {}).filter(
        ([, v]) => !(Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
    );
    const fieldMap = new Map(fields.map(f => [f.input, f]));

    return (
        <NodeFieldPopupShell
            classType={node.class_type || ""}
            nodeId={nodeId}
            inputs={inputs}
            onToggle={onToggleField}
            onClose={onClose}
            rowState={(key) => {
                const field = fieldMap.get(key);
                return {
                    active: Boolean(field),
                    editor: field ? (
                        <FieldEditor
                            field={field}
                            rawValue={node.inputs?.[key]}
                            comboOptions={comboOptions[key]}
                            showRunningHub={false}
                            onUpdate={(patch) => onUpdateField(field.id, patch)}
                            onRemove={() => onRemoveField(field.id)}
                        />
                    ) : undefined,
                };
            }}
        />
    );
}
