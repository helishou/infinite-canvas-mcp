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
    onUploaded: (profile: RunningHubWorkflowProfile, cloudRead: boolean) => void;
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
                site,
            });
            message.success(t(result.cloudRead ? "runningHub.upload.success" : "runningHub.upload.successDraft", { id: result.workflowId }));
            onUploaded(result.profile, result.cloudRead);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setUploading(null);
        }
    }, [message, onUploaded, site, t, uploading, workflows]);

    return { uploading, upload };
}
