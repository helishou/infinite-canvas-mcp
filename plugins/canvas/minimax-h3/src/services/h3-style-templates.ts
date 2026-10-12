import { resolveH3StyleTemplates } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";

export function resolveAvailableH3StyleTemplates(defaults: Record<string, unknown>) {
    const deleted = new Set(
        Array.isArray(defaults.deletedStyleTemplateIds)
            ? defaults.deletedStyleTemplateIds.filter((id): id is string => typeof id === "string")
            : [],
    );
    return resolveH3StyleTemplates(defaults.styleTemplates).filter((template) => !deleted.has(template.id));
}
