/**
 * 画布快捷键单一数据源。
 *
 * 之前快捷键散在 canvas-shortcuts-dialog.tsx 的字面量数组里，键盘处理处另有一份，
 * 新增快捷键容易只改一处。这里集中成表，给帮助弹窗、搜索与未来的快捷键冲突检查共用。
 * 写法参考影策 web/src/lib/canvas/canvas-shortcuts.ts（分类 + keywords），但只保留本画布真实存在的键位。
 */

export type ShortcutCategory = "navigation" | "view" | "selection" | "editing" | "media";

export type ShortcutEntry = {
    id: string;
    /** 字面键位；{drag} 之类 token 由 resolveShortcutKeys 用 i18n 文案替换。 */
    keys: string;
    /** i18n key，沿用现有 canvas.shortcut.* / canvas.navigation.* 文案，不新增翻译条目。 */
    labelKey: string;
    category: ShortcutCategory;
    /** 中英搜索词，命中键位、说明或关键词均可。 */
    keywords: string[];
};

export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = ["navigation", "view", "selection", "editing", "media"];

export const SHORTCUT_CATEGORY_LABELS: Record<ShortcutCategory, { zh: string; en: string }> = {
    navigation: { zh: "导航", en: "Navigation" },
    view: { zh: "视图与工具", en: "View & tools" },
    selection: { zh: "选择", en: "Selection" },
    editing: { zh: "编辑", en: "Editing" },
    media: { zh: "媒体", en: "Media" },
};

const TOKEN_I18N_KEYS: Record<string, string> = {
    drag: "canvas.shortcut.drag",
    click: "canvas.shortcut.click",
    wheel: "canvas.shortcut.wheel",
    zoomSlider: "canvas.shortcut.zoomSlider",
    dropMedia: "canvas.shortcut.dropMedia",
    space: "canvas.shortcut.drag",
};

export const CANVAS_SHORTCUTS: ShortcutEntry[] = [
    { id: "search", keys: "Ctrl / Cmd + K", labelKey: "canvas.navigation.searchLabel", category: "navigation", keywords: ["搜索", "search", "command", "palette"] },
    { id: "focus-selection", keys: "F", labelKey: "canvas.navigation.focusSelection", category: "navigation", keywords: ["聚焦", "focus", "selected"] },
    { id: "fit-all", keys: "Shift + F", labelKey: "canvas.navigation.fitAll", category: "navigation", keywords: ["总览", "fit", "overview", "zoom"] },
    { id: "toggle-tool", keys: "Ctrl / Space + {drag}", labelKey: "canvas.shortcut.toggleTool", category: "view", keywords: ["工具", "tool", "pan", "space"] },
    { id: "zoom", keys: "{wheel}", labelKey: "canvas.shortcut.zoom", category: "view", keywords: ["缩放", "zoom", "wheel"] },
    { id: "precise-zoom", keys: "{zoomSlider}", labelKey: "canvas.shortcut.preciseZoom", category: "view", keywords: ["精确缩放", "slider", "zoom"] },
    { id: "box-select", keys: "{drag}", labelKey: "canvas.shortcut.boxSelect", category: "view", keywords: ["框选", "marquee", "drag"] },
    { id: "add-selection", keys: "Shift / Cmd + {click}", labelKey: "canvas.shortcut.addSelection", category: "selection", keywords: ["加选", "multi", "select", "shift"] },
    { id: "select-all", keys: "Ctrl / Cmd + A", labelKey: "canvas.shortcut.selectAll", category: "selection", keywords: ["全选", "select all"] },
    { id: "copy-paste", keys: "Ctrl / Cmd + C / V", labelKey: "canvas.shortcut.copyPaste", category: "editing", keywords: ["复制", "粘贴", "copy", "paste"] },
    { id: "undo", keys: "Ctrl / Cmd + Z", labelKey: "canvas.undo", category: "editing", keywords: ["撤销", "undo"] },
    { id: "redo", keys: "Ctrl / Cmd + Shift + Z / Y", labelKey: "canvas.redo", category: "editing", keywords: ["重做", "redo"] },
    { id: "delete", keys: "Delete / Backspace", labelKey: "canvas.shortcut.delete", category: "editing", keywords: ["删除", "delete", "remove"] },
    { id: "escape", keys: "Esc", labelKey: "canvas.shortcut.escape", category: "editing", keywords: ["取消", "escape", "cancel"] },
    { id: "upload", keys: "{dropMedia}", labelKey: "canvas.shortcut.upload", category: "media", keywords: ["上传", "拖入", "drop", "upload", "media"] },
];

/** 把 {drag} 之类的 token 换成当前语言文案。 */
export function resolveShortcutKeys(keys: string, translate: (key: string) => string) {
    return keys.replace(/\{(\w+)\}/g, (match, token: string) => {
        const i18nKey = TOKEN_I18N_KEYS[token];
        return i18nKey ? translate(i18nKey) : match;
    });
}

export type ShortcutGroup = { category: ShortcutCategory; label: string; entries: Array<ShortcutEntry & { resolvedKeys: string; resolvedLabel: string }> };

/**
 * 按查询过滤并按固定分类顺序分组。查询为空时返回全部分组。
 * 命中范围 = 键位 + 已翻译说明 + 关键词，大小写不敏感。
 */
export function searchCanvasShortcuts(
    query: string,
    translate: (key: string) => string,
    language: "zh" | "en" = "zh",
): ShortcutGroup[] {
    const needle = query.trim().toLocaleLowerCase();
    const groups: ShortcutGroup[] = [];
    for (const category of SHORTCUT_CATEGORY_ORDER) {
        const entries = CANVAS_SHORTCUTS.filter(item => item.category === category).map(item => ({
            ...item,
            resolvedKeys: resolveShortcutKeys(item.keys, translate),
            resolvedLabel: translate(item.labelKey),
        })).filter(item => !needle || [item.resolvedKeys, item.resolvedLabel, ...item.keywords].some(value => value.toLocaleLowerCase().includes(needle)));
        if (entries.length) groups.push({ category, label: SHORTCUT_CATEGORY_LABELS[category][language], entries });
    }
    return groups;
}
