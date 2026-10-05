import { useEffect, useState } from "react";
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Select, Table } from "antd";
import { useTranslation } from "react-i18next";
import { fetchRunningHubConfig, inspectRunningHubWorkflow, saveRunningHubConfig, type RunningHubConfig, type RunningHubField } from "@/services/api/runninghub";

const initial: RunningHubConfig = { baseUrl: "https://www.runninghub.ai", apiKey: "", mode: "workflow", workflowId: "", appId: "", fields: [], useWallet: false, instanceType: "default", concurrency: 1 };

export function RunningHubPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [config, setConfig] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [filter, setFilter] = useState("");
    useEffect(() => {
        let active = true;
        fetchRunningHubConfig().then(({ config }) => { if (active) { setConfig(config); setLoaded(true); } }).catch((error) => { if (active) setError(String(error.message || error)); });
        return () => { active = false; };
    }, []);
    const patch = (value: Partial<RunningHubConfig>) => setConfig((current) => ({ ...current, ...value }));
    const patchField = (index: number, value: Partial<RunningHubField>) => setConfig((current) => ({ ...current, fields: (current.fields || []).map((field, i) => i === index ? { ...field, ...value } : field) }));
    const save = async (inspect = false) => {
        setBusy(true); setError("");
        try {
            const saved = await saveRunningHubConfig(config);
            if (inspect) {
                const result = await inspectRunningHubWorkflow(config.workflowId || "");
                const oldFields = new Map((config.fields || []).map((field) => [`${field.nodeId}::${field.fieldName}`, field]));
                const fields = result.fields.map((field) => ({ ...field, ...oldFields.get(`${field.nodeId}::${field.fieldName}`) }));
                setConfig({ ...saved.config, fields });
                message.success(t("runningHub.inspected"));
            } else { setConfig(saved.config); message.success(t("runningHub.saved")); }
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const fields = (config.fields || []).map((field, index) => ({ ...field, indexInConfig: index })).filter((field) => `${field.nodeId} ${field.fieldName} ${field.label}`.toLowerCase().includes(filter.toLowerCase()));
    const sources = ["constant", "prompt", "image", "video", "audio"] as const;
    return <section className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900" aria-label="RunningHub">
        <h2 className="mb-2 text-sm font-semibold">RunningHub · H3</h2>
        <p className="mb-4 text-xs text-stone-500">{t("runningHub.description")}</p>
        {error && <Alert type="error" showIcon message={error} className="mb-4" />}
        <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-950/40">
            <div className="mb-1 text-xs font-semibold">{t("runningHub.invite")}</div>
            <p className="mb-2 text-xs text-stone-500">{t("runningHub.inviteHint")}</p>
            <div className="flex flex-wrap gap-2">
                <Button size="small" href="https://www.runninghub.cn?inviteCode=lm9odavp" target="_blank" rel="noopener noreferrer">{t("runningHub.inviteChina")}</Button>
                <Button size="small" href="https://www.runninghub.ai?inviteCode=rxnab3lr" target="_blank" rel="noopener noreferrer">{t("runningHub.inviteGlobal")}</Button>
            </div>
        </div>
        <Form layout="vertical" requiredMark={false} disabled={busy || !loaded}>
            <div className="grid gap-x-4 md:grid-cols-2">
                <Form.Item label={t("runningHub.site")}><Select aria-label={t("runningHub.site")} value={config.baseUrl} onChange={(baseUrl) => patch({ baseUrl })} options={[{ value: "https://www.runninghub.ai", label: t("runningHub.global") }, { value: "https://www.runninghub.cn", label: t("runningHub.china") }]} /></Form.Item>
                <Form.Item label="API Key"><Input.Password aria-label="RunningHub API Key" autoComplete="off" value={config.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} /></Form.Item>
                <Form.Item label={t("runningHub.workflowId")}><Input aria-label={t("runningHub.workflowId")} value={config.workflowId} onChange={(event) => patch({ workflowId: event.target.value, fields: [], mode: "workflow" })} /></Form.Item>
                <Form.Item label={t("runningHub.instance")}><Select aria-label={t("runningHub.instance")} value={config.instanceType || "default"} onChange={(instanceType) => patch({ instanceType })} options={[{ value: "default", label: "default · 24G" }, { value: "plus", label: "plus · 48G" }, { value: "ultra", label: "ultra" }]} /></Form.Item>
                <Form.Item label={t("runningHub.concurrency")} extra={t("runningHub.capacityHint")}><InputNumber aria-label={t("runningHub.concurrency")} min={1} precision={0} value={config.concurrency} onChange={(concurrency) => patch({ concurrency: concurrency ?? undefined })} /></Form.Item>
                <Form.Item label={t("runningHub.localConcurrency")}><InputNumber aria-label={t("runningHub.localConcurrency")} value={1} disabled /></Form.Item>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button loading={busy} onClick={() => void save()}>{t("runningHub.save")}</Button>
                <Button disabled={!config.workflowId?.trim() || !config.apiKey} onClick={() => void save(true)}>{t("runningHub.inspect")}</Button>
            </div>
        </Form>
        <div className="mb-2 text-sm font-semibold">{t("runningHub.mappings")}</div>
        <p className="mb-3 text-xs text-stone-500">{t("runningHub.mappingHint")}</p>
        <Input aria-label={t("runningHub.search")} placeholder={t("runningHub.search")} value={filter} onChange={(event) => setFilter(event.target.value)} allowClear className="mb-3" />
        <Table size="small" rowKey={(field) => `${field.nodeId}::${field.fieldName}`} dataSource={fields} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 840 }} columns={[
            { title: t("runningHub.enabled"), width: 70, render: (_value, field) => <Checkbox aria-label={`${t("runningHub.enabled")} ${field.nodeId}.${field.fieldName}`} checked={field.enabled !== false} disabled={busy} onChange={(event) => patchField(field.indexInConfig, { enabled: event.target.checked })} /> },
            { title: t("runningHub.target"), width: 260, render: (_value, field) => <div><div>{field.nodeId} · {field.fieldName}</div><div className="text-xs text-stone-500">{field.label}</div></div> },
            { title: t("runningHub.source"), width: 150, render: (_value, field) => <Select aria-label={`${t("runningHub.source")} ${field.nodeId}.${field.fieldName}`} style={{ width: "100%" }} disabled={busy} value={field.source || (["prompt", "image", "video", "audio"].includes(field.fieldType || "") ? field.fieldType : "constant")} options={sources.map((value) => ({ value, label: t(`runningHub.sources.${value}`) }))} onChange={(source) => patchField(field.indexInConfig, { source: source as RunningHubField["source"] })} /> },
            { title: t("runningHub.value"), width: 240, render: (_value, field) => ["image", "video", "audio"].includes(field.source || field.fieldType || "") ? <InputNumber disabled={busy} aria-label={`${t("runningHub.ordinal")} ${field.nodeId}.${field.fieldName}`} min={1} precision={0} value={field.index} placeholder={t("runningHub.inOrder")} onChange={(index) => patchField(field.indexInConfig, { index: index ?? undefined })} /> : field.source === "prompt" || field.fieldType === "prompt" && !field.source ? <span className="text-xs">{t("runningHub.currentPrompt")}</span> : <Input disabled={busy} aria-label={`${t("runningHub.value")} ${field.nodeId}.${field.fieldName}`} value={typeof field.fieldValue === "string" ? field.fieldValue : JSON.stringify(field.fieldValue ?? "")} onChange={(event) => { let fieldValue: unknown = event.target.value; try { fieldValue = JSON.parse(event.target.value); } catch {} patchField(field.indexInConfig, { fieldValue }); }} /> },
            { title: t("runningHub.required"), width: 70, render: (_value, field) => <Checkbox disabled={busy} checked={field.required === true} onChange={(event) => patchField(field.indexInConfig, { required: event.target.checked })} /> },
        ]} />
    </section>;
}
