import { useState } from "react";
import { Alert, Button, Input, Modal, Select, Tooltip, message } from "antd";
import { DownloadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchRunningHubWorkflows, inspectRunningHubWorkflow, type RunningHubField, type RunningHubWorkflowGraph, type RunningHubWorkflowProfile } from "@/services/api/runninghub";
import { importWorkflowPackage, type WorkflowConfig, type WorkflowField, type WorkflowPackage } from "@/services/api/workflows";

type WorkflowName = { name: string };

function localField(field: RunningHubField): WorkflowField | null {
    // 只迁移用户已经启用的映射。其他输入的默认值仍保存在节点图里，
    // 用户可在统一的本地节点图编辑器里按需公开为运行字段。
    if (field.enabled === false) return null;
    const type: WorkflowField["type"] = field.fieldType === "image" || field.fieldType === "video" || field.fieldType === "audio"
        ? field.fieldType
        : field.fieldType === "number" || field.fieldType === "boolean" || field.fieldType === "slider" || field.fieldType === "dropdown"
            ? field.fieldType
            : "text";
    const media = type === "image" || type === "video" || type === "audio";
    return {
        id: field.id || `${field.nodeId}::${field.fieldName}`,
        node: field.nodeId,
        input: field.fieldName,
        name: field.label || `${field.nodeId}.${field.fieldName}`,
        type,
        ...(field.required ? { required: true } : {}),
        ...(media ? {} : { default: field.fieldValue }),
        ...(field.source === "prompt" ? { isPrompt: true } : {}),
    };
}

function safeFileName(value: string) {
    const safe = value.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return safe || "runninghub-workflow";
}

export function RunningHubWorkflowImport({ workflows, onImported }: { workflows: WorkflowName[]; onImported: (name: string) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [profiles, setProfiles] = useState<RunningHubWorkflowProfile[]>([]);
    const [profileId, setProfileId] = useState("");
    const [workflowId, setWorkflowId] = useState("");
    const [loadingProfiles, setLoadingProfiles] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState("");

    const show = () => {
        setOpen(true);
        setError("");
        setLoadingProfiles(true);
        void fetchRunningHubWorkflows()
            .then(({ workflows: saved }) => setProfiles(saved))
            .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
            .finally(() => setLoadingProfiles(false));
    };

    const importWorkflow = async () => {
        const profile = profiles.find((item) => item.id === profileId);
        const id = (profile?.workflowId || workflowId).trim();
        if (!id) {
            setError(t("runningHub.import.selectRequired"));
            return;
        }
        setImporting(true);
        setError("");
        try {
            const savedGraph = profile?.workflowJson;
            const inspected = savedGraph && typeof savedGraph === "object" && !Array.isArray(savedGraph)
                ? { workflowId: id, workflowJson: savedGraph as RunningHubWorkflowGraph, fields: profile.fields }
                : await inspectRunningHubWorkflow(id);
            const title = profile?.name?.trim() || `RunningHub ${id}`;
            const baseName = safeFileName(profile?.name || `RunningHub-${id}`);
            const occupied = new Set(workflows.map((item) => item.name.toLocaleLowerCase()));
            let fileName = `${baseName}.json`;
            let suffix = 2;
            while (occupied.has(`custom/${fileName}`.toLocaleLowerCase()) || occupied.has(fileName.toLocaleLowerCase())) {
                fileName = `${baseName}-${suffix++}.json`;
            }
            const config: WorkflowConfig = {
                title,
                backend: "",
                operation: "",
                description: `Imported from RunningHub workflow ${id}`,
                fields: (inspected.fields || []).map(localField).filter((field): field is WorkflowField => field !== null),
            };
            const workflowPackage: WorkflowPackage = {
                format: "infinite-canvas-workflow",
                version: 1,
                name: fileName,
                workflow: inspected.workflowJson,
                config,
            };
            const uploaded = await importWorkflowPackage(fileName, workflowPackage);
            message.success(`已生成本地副本 ${uploaded.name}；云端档案与本地副本此后各自独立`);
            setOpen(false);
            onImported(uploaded.name);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setImporting(false);
        }
    };

    return <>
        <Tooltip title="把云端工作流抓成一份本地 ComfyUI JSON，与云端各自独立；云端后续改动不会同步到本地副本">
            <Button icon={<DownloadCloud className="size-3.5" />} onClick={show}>转换为本地副本</Button>
        </Tooltip>
        <Modal
            title={t("runningHub.import.title")}
            open={open}
            onCancel={() => setOpen(false)}
            onOk={() => void importWorkflow()}
            okText={t("runningHub.import.submit")}
            confirmLoading={importing}
            destroyOnClose
        >
            <p className="mb-3 text-sm text-stone-500">{t("runningHub.import.description")}</p>
            <Select
                className="mb-3 w-full"
                aria-label={t("runningHub.import.savedProfileLabel")}
                placeholder={t("runningHub.import.savedProfile")}
                allowClear
                showSearch
                optionFilterProp="label"
                loading={loadingProfiles}
                value={profileId || undefined}
                options={profiles.map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.workflowId}` }))}
                onChange={(value) => setProfileId(value || "")}
            />
            <Input
                aria-label="RunningHub workflowId"
                placeholder={t("runningHub.import.idPlaceholder")}
                value={workflowId}
                disabled={!!profileId}
                onChange={(event) => setWorkflowId(event.target.value)}
                onPressEnter={() => void importWorkflow()}
            />
            {error ? <Alert className="mt-3" type="error" showIcon message={error} /> : null}
        </Modal>
    </>;
}
