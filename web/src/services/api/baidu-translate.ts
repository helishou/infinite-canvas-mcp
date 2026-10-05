import { request } from "@/services/backend-api";

export async function getBaiduTranslateStatus() {
    return request<{ ok: boolean; hasAppId: boolean; hasSecretKey: boolean }>("GET", "/settings/baidu-translate");
}

export async function saveBaiduTranslateCredentials(input: { appId?: string; secretKey?: string; clear?: boolean }) {
    return request<{ ok: boolean; hasAppId: boolean; hasSecretKey: boolean }>("PUT", "/settings/baidu-translate", input);
}

export async function translateWithBaidu(text: string, target: string) {
    return request<{ ok: boolean; translatedText: string }>("POST", "/translation/baidu", { text, target });
}
