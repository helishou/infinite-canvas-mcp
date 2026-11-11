import { H3_STYLE_TEMPLATES, resolveH3StyleTemplates } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";

type Translate = (key: string, options?: { defaultValue: string }) => string;

/** Use the same saved template definitions as H3; only built-in names are i18n keys. */
export function clipStyleCatalog(defaults: Record<string, unknown>, translate: Translate) {
    const templates = resolveH3StyleTemplates(defaults.styleTemplates);
    const deleted = new Set(Array.isArray(defaults.deletedStyleTemplateIds) ? defaults.deletedStyleTemplateIds : []);
    const name = (value: string | null) => {
        if (!value) return translate("director.workspace.clipStyleNone");
        const template = templates.find(item => item.id === value);
        if (!template) return translate("director.studio.clipStyleMissing");
        const builtin = H3_STYLE_TEMPLATES.find(item => item.id === value);
        return builtin && builtin.label === template.label
            ? translate(`director.workspace.clipStyleNames.${value}`, { defaultValue: template.label })
            : template.label;
    };
    return { name, options: templates.filter(template => !deleted.has(template.id)).map(template => ({ value: template.id, label: name(template.id) })) };
}
