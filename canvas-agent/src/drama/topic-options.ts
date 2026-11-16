/**
 * 选题选项表：**逐字照抄导演大师**（`E:\daoyanwork\asar-work\deob\dramaPipeline-3ba0339e` 与
 * `deob\director2` 里 Topic.vue 引用的常量）。
 *
 * 放在 canvas-agent 里是唯一真值的来源：网页的选题卡 / 新建向导从这里取，
 * 后端「粘贴剧本自动填写」也用它做取值校验与归一化 —— 不要再在任一侧抄一份。
 */

export const TOPIC_OPTIONS = {
    themes: ["霸道总裁", "甜宠", "复仇", "穿越", "重生", "悬疑", "宫斗", "都市", "玄幻", "末日", "校园", "职场", "古装言情"],
    gender: ["不限", "女性", "男性"],
    age: ["全龄", "幼儿", "儿童", "少年", "青年", "中年", "老年"],
    tones: ["甜", "虐", "甜虐", "爽", "燃", "搞笑", "暗黑", "温情"],
    ending: ["HE 好结局", "BE 坏结局", "OE 开放结局"],
    language: ["中文", "English"],
    artStyle: [
        "日系赛璐璐", "日系半厚涂", "新海诚", "吉卜力", "韩漫", "韩系唯美", "国风水墨", "新国风", "古风工笔", "国潮",
        "3D国漫", "半写实厚涂", "游戏原画", "写实电影", "真人写实", "复古胶片", "赛博朋克", "蒸汽朋克", "废土", "美式卡通",
        "美漫", "皮克斯", "3D 动画", "三渲二", "扁平插画", "Q版", "盲盒潮玩", "黏土定格", "水彩绘本", "像素", "黑白漫画",
        "浮世绘", "剪纸", "低多边形", "暗黑哥特",
    ],
    episodePresets: [1, 10, 30, 60, 80, 100],
    minutePresets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
} as const;

/** 新建选题的默认值（导演大师 `v()`：女性 / 全龄 / 甜虐 / HE / 60 集 / 中文 / 时长交给模型）。 */
export const TOPIC_DEFAULTS = {
    gender: "女性",
    age: "全龄",
    tones: ["甜虐"],
    ending: "HE 好结局",
    language: "中文",
    episodes: 60,
    episodeMinutes: 0,
    artStyle: "",
} as const;

/** 参考产品的别名表（`dramaPipeline` 里 S / u 两个映射）：模型爱写女频、青少年，要先落回正式枚举。 */
const OPTION_ALIASES: Record<string, Record<string, string>> = {
    gender: { 女频: "女性", 男频: "男性", 男女不限: "不限", 不限性别: "不限" },
    age: { 学前: "幼儿", 学龄前: "幼儿", 婴幼儿: "幼儿", 小朋友: "儿童", 青少年: "少年", 青壮年: "青年" },
    ending: { HE: "HE 好结局", BE: "BE 坏结局", OE: "OE 开放结局" },
    language: { "zh-CN": "中文", 简体中文: "中文", "en-US": "English", 英文: "English" },
};

/** 模型给的取值必须落回选项表（或作为「自定义」保留），不能凭它自由发明枚举。 */
export function normalizeTopicOption(value: unknown, options: readonly string[], fallback = "", field = ""): string {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    const alias = field ? OPTION_ALIASES[field]?.[text] : undefined;
    if (alias && options.includes(alias)) return alias;
    const direct = options.find((option) => option === text);
    if (direct) return direct;
    // 允许模型给「女性 · 青年」「HE」「国风」这类近义/缩写，按包含关系挑第一个命中
    const loose = options.find((option) => text.includes(option) || option.includes(text));
    return loose || fallback;
}

export function normalizeThemeList(value: unknown): string[] {
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[、,，/\s]+/) : [];
    const out: string[] = [];
    for (const item of list) {
        const theme = normalizeTopicOption(item, TOPIC_OPTIONS.themes);
        if (theme && !out.includes(theme)) out.push(theme);
        if (out.length >= 2) break;
    }
    return out;
}

/** 没给就是 0（未填），给了才夹到 1~200 —— 不要拿默认 1 集冒充用户选择。 */
export function normalizeEpsiodeCount(value: unknown): number {
    const number = Math.floor(Number(value) || 0);
    return number > 0 ? Math.min(200, number) : 0;
}

/** 时长 0 = 模型决定（导演大师同样用空串表示）。 */
export function normalizeEpisodeMinutes(value: unknown): number {
    const number = Number(value) || 0;
    return number <= 0 ? 0 : Math.min(180, Math.max(1, Math.round(number)));
}
