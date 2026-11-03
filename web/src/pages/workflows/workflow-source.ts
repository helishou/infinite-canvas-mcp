type DisplayNode = { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string }; mode?: number };
export type DisplayGraph = Record<string, DisplayNode>;
type Row = Record<string, any>;

/** Read-only display projection, NOT an execution compiler. The UI source remains authoritative. */
export function workflowDisplayGraph(source: unknown): DisplayGraph {
    const graph = source as Row | null;
    if (!Array.isArray(graph?.nodes)) return (source || {}) as DisplayGraph;
    const links = new Map<string, [string, number]>();
    for (const link of Array.isArray(graph.links) ? graph.links : Object.values(graph.links || {})) {
        if (Array.isArray(link)) links.set(String(link[0]), [String(link[1]), Number(link[2])]);
        else if (link && typeof link === "object") links.set(String((link as Row).id ?? (link as Row).link_id), [String((link as Row).origin_id ?? (link as Row).originId), Number((link as Row).origin_slot ?? (link as Row).originSlot)]);
    }
    const result: DisplayGraph = {};
    for (const node of graph.nodes as Row[]) {
        const inputs: Record<string, unknown> = {};
        const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        const named = node.widgets_values_named || (!Array.isArray(node.widgets_values) ? node.widgets_values : {}) || {};
        let widgetIndex = 0;
        for (const [index, input] of (Array.isArray(node.inputs) ? node.inputs : []).entries()) {
            const name = input.name || `input_${index}`;
            if (input.widget) {
                const widget = input.widget.name || name;
                inputs[name] = Object.hasOwn(named, widget) ? named[widget] : values[widgetIndex];
                widgetIndex++;
                if (["seed", "noise_seed"].includes(widget) && ["fixed", "increment", "decrement", "randomize"].includes(values[widgetIndex])) widgetIndex++;
            }
            if (input.link != null && links.has(String(input.link))) inputs[name] = links.get(String(input.link));
        }
        const virtual = ["SetNode", "GetNode"].includes(node.type);
        if (virtual) inputs.Constant = Object.hasOwn(named, "Constant") ? named.Constant : values[0];
        result[String(node.id)] = { class_type: node.type, inputs, mode: node.mode, _meta: { title: virtual ? `${node.type}: ${String(inputs.Constant ?? "")}` : node.title || node.type } };
    }
    return result;
}

export function workflowSourcePositions(source: unknown): Map<string, { x: number; y: number }> {
    const nodes = (source as Row | null)?.nodes;
    const positions = new Map<string, { x: number; y: number }>();
    if (!Array.isArray(nodes)) return positions;
    for (const node of nodes) {
        const x = Number(node.pos?.[0] ?? node.pos?.["0"]);
        const y = Number(node.pos?.[1] ?? node.pos?.["1"]);
        if (Number.isFinite(x) && Number.isFinite(y)) positions.set(String(node.id), { x, y });
    }
    return positions;
}
