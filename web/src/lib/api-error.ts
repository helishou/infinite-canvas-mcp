import i18n from "@/i18n";

/**
 * axios 报 ERR_NETWORK 且拿不到 response 时，浏览器侧只有两种可能：
 * 服务不可达，或跨域被 CORS 拒绝（预检/响应缺 Access-Control-Allow-Origin）。
 * JS 无法区分二者，所以提示语同时覆盖两种原因，避免误导。
 */
export function corsBlockedHint(): string {
    return i18n.t("apiErrors.corsBlocked");
}
