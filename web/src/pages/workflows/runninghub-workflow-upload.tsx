// 把本地工作流上传到 RunningHub：拿到云端 workflowId，同时在本地建档。
// 上传完成后调用方负责刷新云端库并选中新档案。
import { useCallback, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { uploadRunningHubWorkflow, type RunningHubSite, type RunningHubWorkflowProfile } from "@/services/api/runninghub";
import { exportWorkflowPackage } from "@/services/api/workflows";

/** 本地工作流库列表项的最小描述：文件名 + 显示标题。 */
export type LocalWorkflowEntry = { name: string; title?: string };

export function useRunningHubUpload({
    workflows,
    site,
    onUploaded,
}: {
    workflows: LocalWorkflowEntry[];
    /** 上传到哪个站点；缺省跟随运行环境那条 RH 链路。 */
    site?: RunningHubSite;
    /** cloudRead=false：平台侧还是草稿，OpenAPI 暂时读不回节点图。 */
    onUploaded: (profile: RunningHubWorkflowProfile, cloudRead: boolean, localName: string) => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [uploading, setUploading] = useState<string | null>(null);

    const upload = useCallback(async (name: string) => {
        if (uploading) return;
        const workflow = workflows.find((item) => item.name === name);
        if (!workflow) return;
        setUploading(name);
        try {
            const pkg = await exportWorkflowPackage(name);
            const result = await uploadRunningHubWorkflow({
                name: workflow.title || workflow.name.replace(/^custom\//, ""),
                graph: pkg.workflow,
                // 有原始 UI 格式就传它：RunningHub 编辑器只认 nodes/links，API 格式解析不出节点。
                uiWorkflow: pkg.uiWorkflow,
                // 本地已配置的字段：上传后云端档案要沿用，否则平台自动发现的全是未勾选状态。
                localFields: (pkg.config?.fields || []) as unknown as Array<Record<string, unknown>>,
                site,
            });
            const key = result.format === "ui" ? "runningHub.upload.successUi" : result.cloudRead ? "runningHub.upload.success" : "runningHub.upload.successDraft";
            message.success(t(key, { id: result.workflowId }));
            // 没找到本地 UI 原件就只能按 API 格式传，RunningHub 编辑器解析不出节点——必须让用户知道，不能静默降级。
            if (result.format !== "ui") message.warning(t("runningHub.upload.noUiSource"));
            // 云端收尾节点：加了就明说，没加（没有输出节点/已有/非 UI 格式）也交代一句，免得以为静默失败。
            if (result.tail === "added") message.info(t("runningHub.upload.tailAdded"));
            else if (result.tail === "added-video") message.info(t("runningHub.upload.tailAddedVideo"));
            else if (result.tail === "added-api") message.info(t("runningHub.upload.tailAddedApi"));
            else if (result.tail === "no-sink") message.warning(t("runningHub.upload.tailNoSink"));
            // 本地字段在云端图里找不到可写位置（连线输入没解开）时如实报出来，别让配置静默消失。
            if (result.fieldMisses > 0) message.warning(t("runningHub.upload.fieldMissed", { count: result.fieldMisses, fields: (result.fieldMissNames || []).join("、") }));
            // Anything Everywhere 是纯前端广播，RunningHub 没有这个插件：上传前已把广播展开成真实连线。
            if (result.broadcastNodes > 0) message.info(t("runningHub.upload.broadcastFlattened", { nodes: result.broadcastNodes, links: result.broadcastLinks }));
            onUploaded(result.profile, result.cloudRead, name);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setUploading(null);
        }
    }, [message, onUploaded, site, t, uploading, workflows]);

    return { uploading, upload };
}
