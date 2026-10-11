import crypto from "node:crypto";
import { z } from "zod";
import type { ComfyModelCatalog } from "./comfyui-types.js";

export const modelCategories = ["models", "loras", "textEncoders", "videoVaes", "audioVaes", "nanfeng"] as const;
export const modelCatalogReadSchema = z.object({
    view: z.enum(["summary", "entries", "full"]).default("summary"),
    categories: z.array(z.enum(modelCategories)).min(1).optional(),
    query: z.string().optional(), pageSize: z.coerce.number().int().positive().optional(), cursor: z.string().optional(),
}).superRefine((input, ctx) => {
    if (input.view === "entries" && (!input.categories || !input.pageSize)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "entries 必须指定 categories 和 pageSize" });
    if (input.view !== "entries" && (input.categories || input.query !== undefined || input.pageSize || input.cursor)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "筛选和分页参数只适用于 entries" });
});
export type ModelCatalogRead = z.input<typeof modelCatalogReadSchema>;

export function projectModelCatalog(catalog: ComfyModelCatalog, raw: unknown) {
    const input = modelCatalogReadSchema.parse(raw);
    const full = { models: catalog.models || [], loras: catalog.loras || [], textEncoders: catalog.textEncoders || [], videoVaes: catalog.videoVaes || [], audioVaes: catalog.audioVaes || [], nanfeng: catalog.nanfeng || {} };
    if (input.view === "full") return full;
    const all = modelCategories.flatMap<{ category: typeof modelCategories[number]; group: string; name: string; value: unknown }>(category => category === "nanfeng"
        ? Object.entries(full.nanfeng).flatMap(([group, values]) => values.map(value => ({ category, group, name: typeof value === "string" ? value : JSON.stringify(value), value })))
        : full[category].map(name => ({ category, group: "", name, value: name })));
    const header = { view: input.view, refreshedAt: catalog.refreshedAt, ...(catalog.error ? { error: catalog.error } : {}) };
    if (input.view === "summary") return { ...header, counts: Object.fromEntries(modelCategories.map(category => [category, all.filter(item => item.category === category).length])),
        nextRead: { tool: "h3_list_models", input: { view: "entries", categories: ["models"] }, required: ["pageSize"] } };
    const categories = [...new Set(input.categories!)].sort();
    const query = (input.query || "").toLowerCase();
    const entries = all.filter(item => categories.includes(item.category) && item.name.toLowerCase().includes(query))
        .sort((a, b) => a.category < b.category ? -1 : a.category > b.category ? 1 : a.group < b.group ? -1 : a.group > b.group ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const selection = crypto.createHash("sha256").update(JSON.stringify({ categories, query, entries })).digest("hex");
    let offset = 0;
    if (input.cursor) {
        let cursor;
        try { cursor = JSON.parse(decodeURIComponent(input.cursor)); } catch { throw new Error("INVALID_CURSOR"); }
        if (cursor.selection !== selection) throw new Error("READ_CURSOR_EXPIRED: 模型目录或查询已变化，请重新读取");
        offset = z.number().int().nonnegative().parse(cursor.offset);
        if (offset > entries.length) throw new Error("INVALID_CURSOR");
    }
    const end = Math.min(entries.length, offset + input.pageSize!);
    return { ...header, entries: entries.slice(offset, end), total: entries.length,
        nextCursor: end < entries.length ? encodeURIComponent(JSON.stringify({ selection, offset: end })) : null };
}
