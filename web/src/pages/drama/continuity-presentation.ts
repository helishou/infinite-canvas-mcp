type Row = Record<string, any>;
type Labels = (key: string, values?: Record<string, unknown>) => string;

/** Resolve presentation text without changing canonical ledger identities or values. */
export function continuityPresentation(input: { facts: Row[]; timelines: Row[]; scenes: Row[]; locations: Row[]; characters: Row[]; assets: Row[]; shots: Row[]; segments: Row[]; sourceBlocks: Row[] }, label: Labels) {
    const name = (row?: Row) => String(row?.display_name || row?.display_label || row?.name || row?.title || row?.scene_name || row?.heading || "");
    const find = (rows: Row[], id: string) => rows.find(row => String(row.id || row.asset_id || row.scene_id) === id);
    const object = (kind: string, id: string) => name(find(kind === "character" ? input.characters : kind === "scene" ? [...input.locations, ...input.scenes] : input.assets, id)) || label("missingObject");
    const fact = (id: string) => {
        const row = find(input.facts, id);
        if (!row) return label("missingFact");
        const objectName = object(row.object_kind, row.object_id);
        const readableName = name(row);
        const title = readableName || label("factNumber", { count: input.facts.indexOf(row) + 1 });
        return title.includes(objectName) ? title : `${objectName} · ${title}`;
    };
    const value = (factId: string, raw: unknown): string => {
        if (raw === undefined || raw === null || raw === "unknown") return label("stateUnknown");
        const row = find(input.facts, factId);
        const displays = row?.display_values;
        const display = Array.isArray(displays) ? displays[(row?.allowed_values || []).indexOf(raw)] : displays?.[String(raw)];
        const description = row?.value_descriptions?.[String(raw)];
        return typeof description === "string" && description.trim() ? description : typeof display === "string" && display.trim() ? display : String(raw);
    };
    const timeline = (id: string) => {
        const row = find(input.timelines, id);
        const text = name(row) || String(row?.description || "");
        return text || (row ? label("timelineNumber", { count: input.timelines.indexOf(row) + 1 }) : label("missingTimeline"));
    };
    const scene = (id: string) => name(input.scenes.find(row => String(row.scene_id || row.id) === id)) || name(find(input.locations, id)) || label("missingScene");
    const target = (id: string) => {
        const shot = find(input.shots, id);
        if (shot) return name(shot) || label("shotNumber", { count: input.shots.indexOf(shot) + 1 });
        const segment = find(input.segments, id);
        return name(segment) || (segment ? (segment.shot_ids || []).map((shotId: string) => name(find(input.shots, shotId))).filter(Boolean).join("、") || label("segmentNumber", { count: input.segments.indexOf(segment) + 1 }) : label("missingTarget"));
    };
    const source = (id: string) => {
        const block = find(input.sourceBlocks, id);
        return block ? `${scene(String(block.sceneId))} · ${String(block.sourceBlock?.text || block.text || label("sourceNumber", { count: input.sourceBlocks.indexOf(block) + 1 }))}` : label("missingSource");
    };
    const expected = (factId: string, raw: unknown): string => {
        if (Array.isArray(raw)) return raw.map(item => expected(factId, item)).join("；");
        if (raw && typeof raw === "object") return Object.entries(raw).map(([id, state]) => find(input.facts, id) ? `${fact(id)}：${value(id, state)}` : expected(factId, state)).join("；");
        return value(factId, raw);
    };
    const message = (text: string) => {
        const names = new Map<string, string>();
        for (const row of input.facts) names.set(row.id, fact(row.id));
        for (const row of input.shots.concat(input.segments)) names.set(row.id, target(row.id));
        for (const row of input.timelines) names.set(row.id, timeline(row.id));
        for (const block of input.sourceBlocks) names.set(block.id, `${scene(String(block.sceneId))} · ${label("sourceNumber", { count: input.sourceBlocks.indexOf(block) + 1 })}`);
        for (const [id, title] of names) {
            if (!id) continue;
            const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            text = text.replace(new RegExp(`(?<![\\w:-])${escaped}(?![\\w:-])`, "g"), () => title);
        }
        return text;
    };
    return { object, fact, value, timeline, scene, target, source, expected, message };
}
