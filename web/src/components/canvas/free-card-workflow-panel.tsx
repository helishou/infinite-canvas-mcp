import { useEffect, useMemo, useState } from "react";
import { Button, Empty, Modal, Spin } from "antd";
import { Crosshair, Workflow as WorkflowIcon } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { WorkflowSelectModal } from "@/components/layout/workflow-select-modal";
import { WorkflowCustomFields, labelWorkflowFields } from "@/components/workflow-custom-fields";
import { canvasNodeFocusHref, searchCanvasNodes } from "@/lib/canvas/canvas-node-search";
import { fetchWorkflowDetail, type WorkflowDetail } from "@/services/api/workflows";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { resolveModelWorkflow, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

const EMPTY_NODES: never[] = [];

type FreeCardWorkflowPanelProps = {
    open: boolean;
    onClose: () => void;
    node: CanvasNodeData;
    /** 本次生成的参考数量，用于解析模型在该输入场景下实际走的工作流。 */
    referenceCount: number;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
};

/**
 * 自由卡片的「工作流参数」面板。
 *
 * 沿用节点 model 已绑定的工作流（「使用此工作流」复用工作流选择弹窗，选中后写入 model），
 * 把它的非媒体 / 非提示词输入暴露成可编辑控件；seed 的固定/随机由 WorkflowCustomFields 处理，
 * 同名字段由 labelWorkflowFields 消歧。编辑值写入 metadata.comfyParams，随画布既有
 * ops → Backend 事务保存；这里不直连 ComfyUI、不写库。
 *
 * 每个参数可按字段名在现有检索层里找到对应画布节点，点击走 ?nodeId= 深链定位，
 * 不另造视口接口；找不到就不显示跳转按钮，不凭空指定目标。
 */
export function FreeCardWorkflowPanel({ open, onClose, node, referenceCount, onConfigChange }: FreeCardWorkflowPanelProps) {
    const { id: projectId = "" } = useParams();
    const navigate = useNavigate();
    const config = useEffectiveConfig();
    const nodes = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.nodes || EMPTY_NODES);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [detail, setDetail] = useState<WorkflowDetail | null>(null);
    const [loading, setLoading] = useState(false);

    // 面板展示与生成提交共用同一份解析：场景不支持时返回空串，明确提示而不是猜一个工作流。
    const workflowName = useMemo(
        () => resolveModelWorkflow(config, node.metadata?.model || config.model || "", referenceCount),
        [config, node.metadata?.model, referenceCount],
    );

    useEffect(() => {
        if (!open || !workflowName) {
            setDetail(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        fetchWorkflowDetail(workflowName)
            .then((next) => {
                if (!cancelled) setDetail(next);
            })
            .catch(() => {
                if (!cancelled) setDetail(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, workflowName]);

    const fields = useMemo(() => {
        const raw = (detail?.config?.fields || []).filter(
            (field) => !["image", "audio", "video"].includes(field.type) && !field.isPrompt,
        );
        return labelWorkflowFields(raw).map(({ field, label }) => {
            // 用一个词匹配画布节点标题，避免带空格的字段名被当成 AND 查询后一个都命中不了。
            const term = (field.name || field.input || label).trim().split(/\s+/)[0] || "";
            const hit = term ? searchCanvasNodes(nodes, term, 5)[0] : undefined;
            return { field, label, targetNodeId: hit?.id };
        });
    }, [detail, nodes]);

    const values = node.metadata?.comfyParams || {};
    const changeField = (id: string, value: unknown) => {
        onConfigChange(node.id, { comfyParams: { ...values, [id]: value } });
    };
    const applyWorkflow = (names: string[]) => {
        // 换实现后旧字段属于旧工作流，直接清掉，避免把别的实现的参数带进新一轮生成。
        onConfigChange(node.id, { model: names[0] || "", comfyParams: {} });
    };
    const focusNode = (nodeId: string) => {
        onClose();
        navigate(canvasNodeFocusHref(projectId, nodeId));
    };

    return (
        <>
            <Modal
                open={open}
                onCancel={onClose}
                footer={null}
                width={560}
                centered
                destroyOnHidden
                title="自由卡片 · 工作流参数"
                styles={{ body: { maxHeight: "64vh", overflowY: "auto" } }}
            >
                <div className="flex flex-wrap items-center gap-2">
                    <Button icon={<WorkflowIcon className="size-3.5" />} onClick={() => setPickerOpen(true)}>
                        使用此工作流
                    </Button>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {workflowName || "未绑定工作流（当前使用模型的默认工作流）"}
                    </span>
                </div>

                <div className="mt-4">
                    <div className="mb-2 text-sm font-semibold">暴露参数</div>
                    {!workflowName ? (
                        <div className="py-6 text-center text-xs text-muted-foreground">先绑定工作流，或为当前模型配置工作流。</div>
                    ) : loading ? (
                        <div className="py-8 text-center"><Spin /></div>
                    ) : fields.length ? (
                        <div className="space-y-3">
                            {fields.map(({ field, label, targetNodeId }) => (
                                <div key={field.id} className="flex items-end gap-2">
                                    <div className="min-w-0 flex-1">
                                        <WorkflowCustomFields fields={[{ ...field, name: label }]} values={values} onChange={changeField} />
                                    </div>
                                    {targetNodeId ? (
                                        <Button
                                            type="text"
                                            size="small"
                                            className="!mb-0.5"
                                            icon={<Crosshair className="size-3.5" />}
                                            title={`定位到节点：${label}`}
                                            onClick={() => focusNode(targetNodeId)}
                                        />
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该工作流没有可暴露的非媒体参数" />
                    )}
                </div>
            </Modal>

            <WorkflowSelectModal
                open={pickerOpen}
                selectedNames={workflowName ? [workflowName] : []}
                onConfirm={applyWorkflow}
                onClose={() => setPickerOpen(false)}
            />
        </>
    );
}
