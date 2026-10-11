import { request } from "@/services/backend-api";
import { normalizeBackendAddress } from "@/lib/backend-connection";
export { normalizeBackendAddress } from "@/lib/backend-connection";

export type NetworkSettings = { lanEnabled: boolean; origins: string[] };
export type BackendConnectionInfo = { ok: boolean; current: NetworkSettings; configured: NetworkSettings; canConfigure: boolean; restartRequired: boolean; addresses: string[] };

export async function testBackendConnection(address: string, token: string, signal?: AbortSignal): Promise<BackendConnectionInfo> {
    const response = await fetch(`${normalizeBackendAddress(address)}/connection`, { headers: { Authorization: `Bearer ${token.trim()}` }, signal });
    if (!response.ok) throw new Error(response.status === 401 ? "连接密钥不正确" : response.status === 403 ? "网页来源未获允许，请在主机上添加当前网页来源" : `连接失败（HTTP ${response.status}）`);
    const info = await response.json() as BackendConnectionInfo;
    if (!info.ok || !info.current || !info.configured) throw new Error("该地址不是支持实时协作的后台");
    return info;
}

export const getBackendConnectionInfo = () => request<BackendConnectionInfo>("GET", "/connection");
export const saveBackendNetworkSettings = (settings: NetworkSettings) => request<BackendConnectionInfo>("PUT", "/connection", settings);
