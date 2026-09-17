/** 同一窗口的同步凭证入口，避免 API 与 Store 循环依赖；与窗口后台地址成对保存。 */
import { backendConnection, updateBackendToken } from "./backend-connection";

export function setBackendToken(token: string): void {
    updateBackendToken(token);
}

export function getBackendTokenShared(): string {
    return backendConnection().token;
}
