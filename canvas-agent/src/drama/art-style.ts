/**
 * 画风是全剧统一的生图后缀：导演大师的「画风」选中后，后续每一张图的提示词都带同一句风格约束
 * （角色三视图 / 场景主图 / 道具设定 / 分镜关键帧都一样），不是只在选题页显示。
 *
 * 这里只做纯字符串处理，谁都能安全复用：出图派发、资产提示词预览、agent 拼提示词。
 * 幂等：提示词里已经带过同一句就不再追加，避免重跑把后缀叠成两遍。
 */

const SUFFIX_MARK = "全片统一画风";

/** 语言只影响那句约束的措辞，不影响画风取值本身。 */
function markOf(style: string) {
    return `${SUFFIX_MARK}：${style}`;
}

export function normalizeArtStyle(style: unknown): string {
    return String(style ?? "").trim();
}

export function artStyleLine(style: unknown, language: string = "zh"): string {
    const value = normalizeArtStyle(style);
    if (!value) return "";
    return language.toLowerCase().startsWith("en")
        ? `Art style (whole series, keep consistent): ${value}`
        : `${markOf(value)}（角色、场景、道具、分镜沿用同一画风，勿混搭）`;
}

/** 把画风约束拼进提示词；没有画风就原样返回。 */
export function withArtStyle(prompt: string, style: unknown, language: string = "zh"): string {
    const value = normalizeArtStyle(style);
    const text = String(prompt ?? "");
    if (!value) return text;
    if (text.includes(markOf(value)) || text.includes(`Art style (whole series, keep consistent): ${value}`)) return text;
    const line = artStyleLine(value, language);
    return text.trim() ? `${text.trimEnd()}\n${line}` : line;
}
