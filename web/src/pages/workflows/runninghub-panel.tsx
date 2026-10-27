import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, InputNumber, Select } from "antd";
import { useTranslation } from "react-i18next";
import { fetchRunningHubConfig, inspectRunningHubWorkflow, saveRunningHubConfig, fetchRunningHubSession, importRunningHubBrowserSession, saveRunningHubSession, deleteRunningHubSession, type RunningHubConfig, type RunningHubSessionStatus, type RunningHubSite } from "@/services/api/runninghub";
import { keepTypedRunningHubSecret, runningHubSecretMask } from "@/lib/runninghub-secret-field";

const initial: RunningHubConfig = { baseUrl: "https://www.runninghub.ai", apiKey: "", mode: "workflow", workflowId: "", appId: "", fields: [], useWallet: false, instanceType: "default", concurrency: 1, uploadSite: "default", siteApiKeys: { ai: "", cn: "" } };
/** 站点下拉：`default` 跟随运行环境那条链路，另外两档固定站点。 */
const sites: RunningHubSite[] = ["default", "ai", "cn"];
/**
 * 在 runninghub 页面控制台运行取令牌脚本。
 * 国内站 Rh-Accesstoken 存在 Cookie 里，但**不是 HttpOnly**——页面 JS 能直接读，绕开 App-Bound Encryption；
 * 而 Edge 136+ 又禁止在默认配置目录上开远程调试端口，所以走「页面内取令牌」比 CDP 可靠。
 */
const TOKEN_SNIPPET = `(()=>{const m=document.cookie.match(/(?:^|;\\s*)Rh-Accesstoken=([^;]+)/);if(!m){console.warn("%c未找到 Rh-Accesstoken","color:#dc2626;font-weight:600","\\n当前页面："+location.href+"\\n当前 cookie："+document.cookie.split(";").map(s=>s.split("=")[0].trim()).filter(Boolean).join(", "));return;}const v=decodeURIComponent(m[1]);const done=()=>console.log("%c已复制 Rh-Accesstoken（长度 "+v.length+"），回到画布粘贴即可","color:#16a34a;font-weight:600");if(typeof copy==="function"){copy(v);done();return;}navigator.clipboard.writeText(v).then(done,()=>{console.log("%c自动复制失败，请手动复制下面这行：","color:#d97706;font-weight:600");console.log(v);});})()`;

export function RunningHubPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [config, setConfig] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [session, setSession] = useState<RunningHubSessionStatus | null>(null);
    const [sessionBusy, setSessionBusy] = useState(false);
    const [sessionToken, setSessionToken] = useState("");
    // 上传站点：决定本地工作流上传到哪个站，也决定这里的会话连的是哪个站。
    const uploadSite: RunningHubSite = config.uploadSite || "default";
    // `default` 跟随运行环境的 baseUrl；实际落到国内站时，「从本机浏览器读取」也读不到（令牌在 Cookie 里）。
    const effectiveSite: RunningHubSite = uploadSite !== "default" ? uploadSite
        : /runninghub\.cn/i.test(config.baseUrl) ? "cn"
            : /runninghub\.ai/i.test(config.baseUrl) ? "ai"
                : "default";
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
    const copyTokenSnippet = async () => {
        try { await navigator.clipboard.writeText(TOKEN_SNIPPET); message.success(t("runningHub.session.snippetCopied")); }
        catch { setError(t("runningHub.session.snippetCopyFailed")); }
    };
    const patch = (value: Partial<RunningHubConfig>) => setConfig((current) => ({ ...current, ...value }));
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
    return <section className="mx-auto max-w-5xl rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-6" aria-label="RunningHub">
        <header className="mb-4">
            <h2 className="text-base font-semibold">RunningHub · H3</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("runningHub.description")}</p>
        </header>
        <div className="sticky top-0 z-20 -mx-4 mb-5 flex flex-wrap items-center justify-between gap-3 border-y border-border bg-card/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <span className="text-xs text-muted-foreground">{t("runningHub.saveHint")}</span>
            <div className="flex gap-2">
                <Button disabled={!loaded || busy || !config.workflowId?.trim() || !config.apiKey} onClick={() => void save(true)}>{t("runningHub.inspect")}</Button>
                <Button type="primary" loading={busy} disabled={!loaded} onClick={() => void save()}>{t("runningHub.save")}</Button>
            </div>
        </div>
        <div className="mb-4 rounded-lg border border-border bg-background p-4">
            <div className="mb-1 text-xs font-semibold">{t("runningHub.session.title")}</div>
            <p className="mb-2 text-xs text-muted-foreground">{t("runningHub.session.hint")}</p>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("runningHub.upload.site")}</span>
                <Select size="small" aria-label={t("runningHub.upload.site")} className="min-w-56" value={uploadSite} onChange={(value) => void setUploadSite(value as RunningHubSite)} options={sites.map((value) => ({ value, label: t(`runningHub.upload.sites.${value}`) }))} />
                <span className="text-xs text-muted-foreground">{uploadSite === "default" ? config.baseUrl : t(`runningHub.upload.sites.${uploadSite}`)}</span>
            </div>
            {session?.connected ? <p className="mb-2 text-xs text-muted-foreground">{t("runningHub.session.state")}：{session.source === "browser" ? t("runningHub.session.fromBrowser") : t("runningHub.session.manual")}{session.expired ? ` · ${t("runningHub.session.expired")}` : ""}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
                {effectiveSite !== "cn" ? <Button size="small" loading={sessionBusy} onClick={() => void connectSession(() => importRunningHubBrowserSession(uploadSite))}>{t("runningHub.session.readBrowser")}</Button> : null}
                <Input.Password aria-label={t("runningHub.session.token")} size="small" className="max-w-64" autoComplete="off" placeholder={t("runningHub.session.tokenPlaceholder")} value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} />
                <Button size="small" loading={sessionBusy} disabled={!sessionToken.trim()} onClick={() => void connectSession(() => saveRunningHubSession(sessionToken.trim(), uploadSite))}>{t("runningHub.session.useToken")}</Button>
                {session?.connected ? <Button size="small" danger loading={sessionBusy} onClick={() => void connectSession(() => deleteRunningHubSession(uploadSite), "runningHub.session.disconnected")}>{t("runningHub.session.disconnect")}</Button> : null}
            </div>
            <div className="mb-2 mt-4 text-xs font-semibold">{t("runningHub.siteCredentials")}</div>
            <p className="mb-3 text-xs text-muted-foreground">{t("runningHub.siteCredentialsHint")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
                {(["ai", "cn"] as const).map((site) => {
                    const key = config.siteApiKeys?.[site] || "";
                    return <div key={site}>
                        <div className="mb-1 text-xs text-muted-foreground">{t("runningHub.upload.siteKeyHint", { site: t(`runningHub.upload.sites.${site}`) })}</div>
                        <Input.Password aria-label={`${t("runningHub.upload.siteKey")} · ${t(`runningHub.upload.sites.${site}`)}`} size="small" className="max-w-96" autoComplete="off" placeholder={key === runningHubSecretMask ? t("runningHub.secretStored") : t("runningHub.upload.siteKeyPlaceholder")} visibilityToggle={!!key && key !== runningHubSecretMask} value={key === runningHubSecretMask ? "" : key} onChange={(event) => patch({ siteApiKeys: { ...(config.siteApiKeys || {}), [site]: event.target.value } })} />
                    </div>;
                })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("runningHub.session.snippetHint")}</p>
            <Button size="small" className="mt-1" onClick={() => void copyTokenSnippet()}>{t("runningHub.session.copySnippet")}</Button>
        </div>
        {error && <Alert type="error" showIcon message={error} className="mb-4" />}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t("runningHub.invite")}</div>
                <p className="mt-1 text-xs text-muted-foreground">{t("runningHub.inviteHint")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button size="small" href="https://www.runninghub.cn?inviteCode=lm9odavp" target="_blank" rel="noopener noreferrer">{t("runningHub.inviteChina")}</Button>
                <Button size="small" href="https://www.runninghub.ai?inviteCode=rxnab3lr" target="_blank" rel="noopener noreferrer">{t("runningHub.inviteGlobal")}</Button>
            </div>
        </div>
        <section className="rounded-lg border border-border bg-background p-4">
        <h3 className="mb-4 text-sm font-semibold">{t("runningHub.runtimeSettings")}</h3>
        <Form layout="vertical" requiredMark={false} disabled={busy || !loaded}>
            <div className="grid gap-x-4 md:grid-cols-2">
                <Form.Item label={t("runningHub.site")}><Select aria-label={t("runningHub.site")} value={config.baseUrl} onChange={(baseUrl) => patch({ baseUrl })} options={[{ value: "https://www.runninghub.ai", label: t("runningHub.global") }, { value: "https://www.runninghub.cn", label: t("runningHub.china") }]} /></Form.Item>
                <Form.Item label="API Key" extra={t("runningHub.upload.defaultKeyHint")}><Input.Password aria-label="RunningHub API Key" autoComplete="off" placeholder={config.apiKey === runningHubSecretMask ? t("runningHub.secretStored") : undefined} visibilityToggle={!!config.apiKey && config.apiKey !== runningHubSecretMask} value={config.apiKey === runningHubSecretMask ? "" : config.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} /></Form.Item>
                <Form.Item label={t("runningHub.instance")}><Select aria-label={t("runningHub.instance")} value={config.instanceType || "default"} onChange={(instanceType) => patch({ instanceType })} options={[{ value: "default", label: "default · 24G" }, { value: "plus", label: "plus · 48G" }, { value: "ultra", label: "ultra" }]} /></Form.Item>
                <Form.Item label={t("runningHub.concurrency")} extra={t("runningHub.capacityHint")}><InputNumber aria-label={t("runningHub.concurrency")} min={1} precision={0} value={config.concurrency} onChange={(concurrency) => patch({ concurrency: concurrency ?? undefined })} /></Form.Item>
                <Form.Item label={t("runningHub.localConcurrency")}><InputNumber aria-label={t("runningHub.localConcurrency")} value={1} disabled /></Form.Item>
            </div>
        </Form>
        </section>
    </section>;
}
