import { z } from "zod";

export const productionReadSchema = z.object({
    view: z.enum(["summary", "source", "artifacts", "full"]).default("summary"),
    snapshot: z.enum(["draft", "published"]).default("draft"),
    targetIds: z.array(z.string().min(1)).optional(),
});
export function productionReadQuery(raw: unknown) {
    const input = productionReadSchema.parse(raw);
    const query = new URLSearchParams({ view: input.view, snapshot: input.snapshot });
    if (input.targetIds) query.set("targetIds", input.targetIds.join(","));
    return `?${query}`;
}

/** MCP reads select one complete payload instead of repeating source/prompts/history. */
export function projectProductionRead(production: any, raw: unknown = {}) {
    const input = productionReadSchema.parse(raw);
    if (input.view === "full") return production;
    const header = { episodeId: production.episodeId, revision: production.revision, publishedVersion: production.publishedVersion, updatedAt: production.updatedAt };
    const selected = production[input.snapshot];
    const d = selected?.director;
    if (input.view === "source") return { ...header, snapshot: input.snapshot, engine: d?.engine, sourceHash: d?.sourceHash, source: d?.source || null };
    if (input.view === "artifacts") return { ...header, snapshot: input.snapshot, sourceHash: d?.sourceHash, artifacts: (d?.artifacts || []).filter((a: any) => !input.targetIds || input.targetIds.includes(a.targetId)) };
    const summarize = (data: any) => data ? {
        director: data.director ? { engine: data.director.engine, sourceHash: data.director.sourceHash, modules: data.director.modules, workflow: data.director.workflow, assets: data.director.assets,
            executionAuthorized: data.director.executionAuthorized, unresolved: data.director.unresolved,
            source: { brief: data.director.source.brief, production_total_duration: data.director.source.production_total_duration, fps_num: data.director.source.fps_num, fps_den: data.director.source.fps_den },
            artifacts: data.director.artifacts.map(({ prompt, ...a }: any) => ({ ...a, promptBytes: new TextEncoder().encode(prompt).length })) } : null,
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
        sourceHash: p.draft?.director?.sourceHash, engine: p.draft?.director?.engine, currentWork: p.draft?.director?.workflow.currentWork, impact: p.impact } };
}
