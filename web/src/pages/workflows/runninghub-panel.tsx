import { useEffect, useState } from "react";
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Select, Table } from "antd";
import { useTranslation } from "react-i18next";
import { fetchRunningHubConfig, inspectRunningHubWorkflow, saveRunningHubConfig, fetchRunningHubSession, importRunningHubBrowserSession, saveRunningHubSession, deleteRunningHubSession, type RunningHubConfig, type RunningHubField, type RunningHubSessionStatus, type RunningHubSite } from "@/services/api/runninghub";
import { keepTypedRunningHubSecret } from "@/lib/runninghub-secret-field";

const initial: RunningHubConfig = { baseUrl: "https://www.runninghub.ai", apiKey: "", mode: "workflow", workflowId: "", appId: "", fields: [], useWallet: false, instanceType: "default", concurrency: 1, uploadSite: "default", siteApiKeys: { ai: "", cn: "" } };
/** 站点下拉：`default` 跟随运行环境那条链路，另外两档固定站点。 */
const sites: RunningHubSite[] = ["default", "ai", "cn"];

export function RunningHubPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [config, setConfig] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [filter, setFilter] = useState("");
    const [session, setSession] = useState<RunningHubSessionStatus | null>(null);
    const [sessionBusy, setSessionBusy] = useState(false);
    const [sessionToken, setSessionToken] = useState("");
    // 上传站点：决定本地工作流上传到哪个站，也决定这里的会话连的是哪个站。
    const uploadSite: RunningHubSite = config.uploadSite || "default";
    const setUploadSite = async (site: RunningHubSite) => {
        patch({ uploadSite: site });
        setSession(null); setSessionToken("");
        try {
            await saveRunningHubConfig({ uploadSite: site });
            const { session } = await fetchRunningHubSession(site);
            setSession(session);
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    };
    useEffect(() => {
        let active = true;
        fetchRunningHubConfig().then(({ config }) => { if (active) { setConfig(config); setLoaded(true); } }).catch((error) => { if (active) setError(String(error.message || error)); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        let active = true;
        fetchRunningHubSession(uploadSite).then(({ session }) => { if (active) setSession(session); }).catch(() => { if (active) setSession({ connected: false }); });
        return () => { active = false; };
    }, [uploadSite]);
    const connectSession = async (read: () => Promise<{ session: RunningHubSessionStatus }>, okKey = "runningHub.session.connected") => {
        setSessionBusy(true); setError("");
        try {
            const { session } = await read();
            setSession(session);
            setSessionToken("");
            message.success(t(okKey));
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setSessionBusy(false); }
    };
    const patch = (value: Partial<RunningHubConfig>) => setConfig((current) => ({ ...current, ...value }));
    const patchField = (index: number, value: Partial<RunningHubField>) => setConfig((current) => ({ ...current, fields: (current.fields || []).map((field, i) => i === index ? { ...field, ...value } : field) }));
    const save = async (inspect = false) => {
        setBusy(true); setError("");
        try {
            const saved = await saveRunningHubConfig(config);
            // The Backend keeps the stored key when it receives its own mask back, so the
            // response carries no new secret: keep what is in the field instead of re-masking it.
            const apiKey = keepTypedRunningHubSecret(config.apiKey, saved.config.apiKey);
            if (inspect) {
                const result = await inspectRunningHubWorkflow(config.workflowId || "");
                const oldFields = new Map((config.fields || []).map((field) => [`${field.nodeId}::${field.fieldName}`, field]));
                const fields = result.fields.map((field) => ({ ...field, ...oldFields.get(`${field.nodeId}::${field.fieldName}`) }));
                setConfig({ ...saved.config, apiKey, fields });
                message.success(t("runningHub.inspected"));
            } else { setConfig({ ...saved.config, apiKey }); message.success(t("runningHub.saved")); }
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const fields = (config.fields || []).map((field, index) => ({ ...field, indexInConfig: index })).filter((field) => `${field.nodeId} ${field.fieldName} ${field.label}`.toLowerCase().includes(filter.toLowerCase()));
    const sources = ["constant", "prompt", "image", "video", "audio"] as const;
    return <section className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900" aria-label="RunningHub">
        <h2 className="mb-2 text-sm font-semibold">RunningHub · H3</h2>
        <p className="mb-4 text-xs text-stone-500">{t("runningHub.description")}</p>
        <div className="mb-4 rounded-md border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-1 text-xs font-semibold">{t("runningHub.session.title")}</div>
            <p className="mb-2 text-xs text-stone-500">{t("runningHub.session.hint")}</p>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-stone-500">{t("runningHub.upload.site")}</span>
                <Select size="small" aria-label={t("runningHub.upload.site")} className="min-w-56" value={uploadSite} onChange={(value) => void setUploadSite(value as RunningHubSite)} options={sites.map((value) => ({ value, label: t(`runningHub.upload.sites.${value}`) }))} />
                <span className="text-xs text-stone-500">{uploadSite === "default" ? config.baseUrl : t(`runningHub.upload.sites.${uploadSite}`)}</span>
            </div>
            {session?.connected ? <p className="mb-2 text-xs text-stone-500">{t("runningHub.session.state")}：{session.source === "browser" ? t("runningHub.session.fromBrowser") : t("runningHub.session.manual")}{session.expired ? ` · ${t("runningHub.session.expired")}` : ""}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
                <Button size="small" loading={sessionBusy} onClick={() => void connectSession(() => importRunningHubBrowserSession(uploadSite))}>{t("runningHub.session.readBrowser")}</Button>
                <Input.Password aria-label={t("runningHub.session.token")} size="small" className="max-w-64" autoComplete="off" placeholder={t("runningHub.session.tokenPlaceholder")} value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} />
                <Button size="small" loading={sessionBusy} disabled={!sessionToken.trim()} onClick={() => void connectSession(() => saveRunningHubSession(sessionToken.trim(), uploadSite))}>{t("runningHub.session.useToken")}</Button>
                {session?.connected ? <Button size="small" danger loading={sessionBusy} onClick={() => void connectSession(() => deleteRunningHubSession(uploadSite), "runningHub.session.disconnected")}>{t("runningHub.session.disconnect")}</Button> : null}
            </div>
            {uploadSite !== "default" ? <div className="mt-3">
                <div className="mb-1 text-xs text-stone-500">{t("runningHub.upload.siteKeyHint", { site: t(`runningHub.upload.sites.${uploadSite}`) })}</div>
                <Input.Password aria-label={t("runningHub.upload.siteKey")} size="small" className="max-w-96" autoComplete="off" placeholder={t("runningHub.upload.siteKeyPlaceholder")} value={config.siteApiKeys?.[uploadSite] || ""} onChange={(event) => patch({ siteApiKeys: { ...(config.siteApiKeys || {}), [uploadSite]: event.target.value } })} />
            </div> : null}
        </div>
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
