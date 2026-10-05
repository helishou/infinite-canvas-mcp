import { z } from "zod";

export const productionReadSchema = z.object({
    view: z.enum(["summary", "source", "artifacts", "artifact_index", "full"]).default("summary"),
    snapshot: z.enum(["draft", "published"]).default("draft"),
    targetIds: z.array(z.string().min(1)).optional(),
    sourceSection: z.enum(["context", "asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry"]).optional(),
    pageSize: z.coerce.number().int().positive().optional(),
    cursor: z.string().optional(),
    chunkBytes: z.coerce.number().int().positive().optional(),
});
export function productionReadQuery(raw: unknown) {
    const input = productionReadSchema.parse(raw);
    const query = new URLSearchParams({ view: input.view, snapshot: input.snapshot });
    if (input.targetIds) query.set("targetIds", input.targetIds.join(","));
    for (const key of ["sourceSection", "pageSize", "cursor", "chunkBytes"] as const) if (input[key] !== undefined) query.set(key, String(input[key]));
    return `?${query}`;
}

/** MCP reads select one complete payload instead of repeating source/prompts/history. */
export function projectProductionRead(production: any, raw: unknown = {}, digest?: (value: string) => string) {
    const input = productionReadSchema.parse(raw);
    if (input.view === "full") return production;
    const header = { episodeId: production.episodeId, revision: production.revision, publishedVersion: production.publishedVersion, updatedAt: production.updatedAt };
    const selected = production[input.snapshot];
    const d = selected?.director;
    const selection = JSON.stringify({ owner: production.episodeId, snapshot: input.snapshot, revision: production.revision, sourceHash: d?.sourceHash, view: input.view, targetIds: input.targetIds, section: input.sourceSection, chunkBytes: input.chunkBytes });
    let offset = 0;
    if (input.cursor) {
        let cursor: any;
        try { cursor = JSON.parse(decodeURIComponent(input.cursor)); } catch { throw new Error("INVALID_CURSOR"); }
        if (cursor.selection !== selection) throw new Error("READ_CURSOR_EXPIRED: 读取对象或版本已变化，请从当前版本重新读取");
        offset = z.number().int().nonnegative().parse(cursor.offset);
    }
    const next = (index: number) => encodeURIComponent(JSON.stringify({ selection, offset: index }));
    const paginate = (items: any[]) => {
        if (input.cursor && !input.pageSize && !input.chunkBytes) throw new Error("游标读取必须携带 pageSize 或 chunkBytes");
        const end = input.pageSize ? offset + input.pageSize : items.length;
        return { items: items.slice(offset, end), total: items.length, nextCursor: end < items.length ? next(end) : null };
    };
    const chunk = (value: string) => {
        if (!digest) throw new Error("分块读取需要 Backend 完整性摘要");
        const bytes = new TextEncoder().encode(value);
        if (offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error("INVALID_CURSOR: 非 UTF-8 边界");
        let end = Math.min(bytes.length, offset + input.chunkBytes!);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        if (end === offset && offset < bytes.length) throw new Error("CHUNK_TOO_SMALL: chunkBytes 无法容纳下一个字符");
        return { sha256: digest(value), bytes: bytes.length, offset, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset, end)), nextCursor: end < bytes.length ? next(end) : null };
    };
    const selectedArtifacts = (d?.artifacts || []).filter((a: any) => !input.targetIds || input.targetIds.includes(a.targetId));
    if (input.view === "source") {
        if (input.targetIds && !input.sourceSection) throw new Error("定向源稿读取必须指定 sourceSection");
        const source = d?.source || null;
        const section = input.sourceSection === "context" ? Object.fromEntries(Object.entries(source || {}).filter(([key]) => !["asset_plan", "asset_cards", "shots", "segments", "script_scenes", "character_registry", "scene_registry"].includes(key))) : input.sourceSection ? source?.[input.sourceSection] : source;
        const filtered = Array.isArray(section) && input.targetIds ? section.filter((item: any) => input.targetIds!.includes(String(item.id || item.asset_id || item.shot_id || item.segment_id))) : section;
        if (input.chunkBytes) {
            const value = Array.isArray(filtered) ? (filtered.length === 1 ? filtered[0] : undefined) : filtered;
            if (value === undefined) throw new Error("分块读取必须选定一个源稿对象");
            return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, chunk: chunk(JSON.stringify(value)) };
        }
        return { ...header, snapshot: input.snapshot, engine: d?.engine, sourceHash: d?.sourceHash, ...(Array.isArray(filtered) && input.pageSize ? { source: paginate(filtered) } : { source: filtered }) };
    }
    if (input.view === "artifacts" || input.view === "artifact_index") {
        if (input.chunkBytes) {
            if (input.view !== "artifacts" || selectedArtifacts.length !== 1) throw new Error("分块读取必须选定一个产物");
            return { ...header, snapshot: input.snapshot, targetId: selectedArtifacts[0].targetId, chunk: chunk(selectedArtifacts[0].prompt) };
        }
        const artifacts = input.view === "artifact_index" ? selectedArtifacts.map(({ prompt, references = [], ...a }: any) => ({ id: a.id, targetId: a.targetId, kind: a.kind, status: a.status, sha256: a.sha256, sourceHash: a.sourceHash, promptBytes: new TextEncoder().encode(prompt).length, referenceCount: references.length })) : selectedArtifacts;
        return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, ...(input.pageSize ? { artifacts: paginate(artifacts) } : { artifacts }) };
    }
    const summarize = (data: any) => data ? {
        director: data.director ? { engine: data.director.engine, sourceHash: data.director.sourceHash, modules: data.director.modules, workflow: data.director.workflow, assets: data.director.assets,
            executionAuthorized: data.director.executionAuthorized, unresolved: data.director.unresolved,
            source: { brief: data.director.source.brief, production_total_duration: data.director.source.production_total_duration, fps_num: data.director.source.fps_num, fps_den: data.director.source.fps_den },
            artifacts: data.director.artifacts.filter((a: any) => !input.targetIds || input.targetIds.includes(a.targetId)).map(({ prompt, ...a }: any) => ({ ...a, promptBytes: new TextEncoder().encode(prompt).length })) } : null,
        scenes: (data.scenes || []).map((s: any) => ({ id: s.id, heading: s.heading })),
        shots: (data.shots || []).map((s: any) => ({ id: s.id, sceneId: s.sceneId, title: s.title, duration: s.duration })),
        clipGroups: data.clipGroups, keyframes: data.keyframes, keyframeReviews: data.keyframeReviews, settings: data.settings,
    } : null;
    return { ...header, view: "summary", draft: summarize(production.draft), published: production.published ? { sourceHash: production.published.director?.sourceHash, engine: production.published.director?.engine } : null };
}

export function productionWriteReceipt(result: any) {
    if (!result.production) return result;
    const p = result.production;
    return { ...result, production: { episodeId: p.episodeId, revision: p.revision, publishedVersion: p.publishedVersion, updatedAt: p.updatedAt, replayed: p.replayed,
        referenceSync: p.referenceSync, sourceHash: p.draft?.director?.sourceHash, engine: p.draft?.director?.engine, currentWork: p.draft?.director?.workflow.currentWork, impact: p.impact } };
}
