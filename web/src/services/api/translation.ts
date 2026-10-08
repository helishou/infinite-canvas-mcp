import { request } from "@/services/backend-api";

/** 画布右键翻译：由 Backend 调用设置里选定的文本模型完成。 */
export async function translateText(text: string, target: "zh-CN" | "en") {
    return request<{ ok: boolean; translatedText: string }>("POST", "/translation/text", { text, target });
}
