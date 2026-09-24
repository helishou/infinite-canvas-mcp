import { useEffect, useState } from "react";
import { App, Button, Form, Input, Switch } from "antd";
import { CheckCircle2, CircleAlert, Copy, Network, ShieldCheck, Wifi } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { useBackendStore } from "@/stores/use-backend-store";
import { getBackendConnectionInfo, normalizeBackendAddress, saveBackendNetworkSettings, testBackendConnection, type BackendConnectionInfo } from "@/services/api/backend-connection";

export function ConfigConnection({ active }: { active: boolean }) {
    const { modal } = App.useApp();
    const copy = useCopyText();
    const currentUrl = useBackendStore((state) => state.url);
    const currentToken = useBackendStore((state) => state.token);
    const connected = useBackendStore((state) => state.connected);
    const [url, setUrl] = useState(currentUrl);
    const [token, setToken] = useState(currentToken);
    const [info, setInfo] = useState<BackendConnectionInfo>();
    const [enabled, setEnabled] = useState(false);
    const [origins, setOrigins] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    useEffect(() => {
        if (!active) return;
        let disposed = false;
        void getBackendConnectionInfo().then((value) => {
            if (disposed) return;
            setInfo(value); setEnabled(value.configured.lanEnabled); setOrigins(value.configured.origins.join("\n"));
        }).catch(() => { if (!disposed) setInfo(undefined); });
        return () => { disposed = true; };
    }, [active, currentUrl, connected]);
    const check = async (switchTo: boolean) => {
        setBusy(true); setError(""); setNotice("");
        try {
            const address = normalizeBackendAddress(url);
            await testBackendConnection(address, token);
            if (switchTo) useBackendStore.getState().setConnection(address, token.trim());
            else setNotice("地址、密钥和网页来源验证通过；尚未切换连接。");
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const save = async () => {
        setBusy(true); setError(""); setNotice("");
        try {
            const value = await saveBackendNetworkSettings({ lanEnabled: enabled, origins: origins.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) });
            setInfo(value); setOrigins(value.configured.origins.join("\n"));
            setNotice(value.restartRequired ? "已保存。请手动重启后台；当前监听和连接暂未改变。" : "配置与当前运行状态一致。");
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return (
        <Form layout="vertical" requiredMark={false} className="py-2">
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold"><Network className="size-4" />此窗口连接</div>
                        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">所有协作者连接同一后台，再打开同一项目。不是账号云同步；密钥拥有整个后台权限，只交给可信协作者。</p>
                    </div>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${connected ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300" : "bg-stone-100 text-stone-500 dark:bg-stone-900 dark:text-stone-400"}`}>
                        {connected ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                        {connected ? "已连接" : "未连接"}
                    </span>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <Form.Item label="后台地址" className="mb-0"><Input aria-label="后台地址" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://192.168.1.10:17370" disabled={busy} /></Form.Item>
                    <Form.Item label="连接密钥" className="mb-0"><Input.Password aria-label="连接密钥" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" disabled={busy} /></Form.Item>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button icon={<Wifi className="size-4" />} disabled={busy} onClick={() => void check(false)}>测试连接</Button>
                    <Button type="primary" disabled={busy} onClick={() => modal.confirm({ title: "切换此窗口的后台？", content: "验证通过后页面将重新加载。原后台的未确认草稿按后台与窗口保留，不会提交给新后台；其他已打开窗口不切换。", okText: "验证并连接", cancelText: "取消", onOk: () => check(true) })}>连接并重新加载</Button>
                    <Button type="text" icon={<Copy className="size-4" />} onClick={() => copy(window.location.origin)}>复制当前网页来源</Button>
                </div>
                <div className="mt-3 rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-500 dark:bg-stone-900 dark:text-stone-400">当前：{currentUrl} · {connected ? "已连接" : "未连接"}。在其他设备输入主机的局域网地址，不能填写 127.0.0.1。</div>
                {info ? <div className="mt-5 border-t border-stone-200 pt-5 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4" />主机 · 可信局域网协作</div>
                        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">控制其他设备是否可以通过局域网访问当前后台。</p>
                    </div>
                    <div className="flex items-center gap-3"><Switch aria-label="允许局域网连接" checked={enabled} onChange={setEnabled} disabled={!info.canConfigure || busy} /><span className="text-sm">允许其他设备连接</span></div>
                </div>
                <p className="mt-4 rounded-md border border-orange-200 bg-orange-50/70 px-3 py-2 text-xs leading-5 text-orange-900 dark:border-orange-900/60 dark:bg-orange-950/20 dark:text-orange-200">默认仅本机。开启后监听所有网卡，请确认防火墙与网络可信，不要映射到公网。HTTP 传输未加密，建议使用可信 HTTPS 代理。设置保存后需重启后台，不会自动中断当前任务。</p>
                <Form.Item label="允许的网页来源（每行一个，包含协议和端口）" className="mb-0 mt-4"><Input.TextArea aria-label="允许的网页来源" rows={3} value={origins} onChange={(event) => setOrigins(event.target.value)} disabled={!info.canConfigure || busy} placeholder="http://192.168.1.10:3001" /></Form.Item>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    {info.canConfigure ? <Button type="primary" disabled={busy} onClick={() => modal.confirm({ title: enabled ? "保存局域网开放设置？" : "保存仅本机设置？", content: "仅保存到后台，重启后生效。开放后持有密钥的人能访问所有画布、素材与模型配置；这不是按项目授权的邀请。", okText: "保存设置", cancelText: "取消", onOk: save })}>保存主机设置</Button> : <p className="text-xs text-stone-500 dark:text-stone-400">请在主机的 localhost 页面修改开放设置。</p>}
                    {info.canConfigure ? <Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={() => modal.confirm({ title: "复制后台密钥？", content: "密钥允许访问整个后台，请只通过可信渠道发送，不要放进公开链接或截图。", okText: "复制密钥", cancelText: "取消", onOk: () => copy(currentToken) })}>复制主机密钥</Button> : null}
                </div>
                <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">实际运行：{info.current.lanEnabled ? "局域网开放" : "仅本机"}{info.restartRequired ? " · 有配置等待重启" : ""}。前端网页服务也须能被另一台设备访问；这里只配置后台。</p>
                {info.addresses.length ? <div className="mt-3 space-y-1.5">{info.addresses.map((address) => <div key={address} className="flex items-center justify-between gap-3 rounded-md bg-stone-100 px-3 py-2 text-xs dark:bg-stone-900"><code className="min-w-0 truncate">{address}</code><Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copy(address)}>复制地址</Button></div>)}</div> : null}
                </div> : null}
            </section>
            {!window.isSecureContext ? <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">当前为普通 HTTP 地址：本机草稿通过后台租约防止多窗口重复提交；异常断线后约 30 秒可由其他窗口恢复。在线画布同步不受影响。</p> : null}
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">{error}</p> : null}
            {notice ? <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">{notice}</p> : null}
        </Form>
    );
}
