type SceneNode = Record<string, unknown>;

export function sceneNodesByIds(project: { nodes?: unknown }, ids: string[]) {
    const nodes = Array.isArray(project.nodes) ? project.nodes as SceneNode[] : [];
    const byId = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const added = new Set<string>();
    return ids.flatMap((id) => {
        const node = byId.get(id);
        if (!node || node.type !== "scene" || added.has(id)) return [];
        added.add(id);
        return [node];
    });
}

export function appendScenePalettePrompt(prompt: string, scenes: SceneNode[]) {
    const seen = new Set<string>();
    const blocks = scenes.flatMap((node) => {
        const id = String(node.id || "");
        if (id && seen.has(id)) return [];
        if (id) seen.add(id);
        const metadata = recordOf(node.metadata);
        const notes = String(metadata.sceneColorCardPrompt || "").trim();
        const colors = Array.isArray(metadata.sceneColorPalette)
            ? [...new Set(metadata.sceneColorPalette.map(normalizeHex).filter((value): value is string => Boolean(value)))]
            : [];
        if (!notes && !colors.length) return [];
        const name = String(metadata.sceneName || node.title || "未命名场景").trim();
        const notedColors = new Set([...(notes.matchAll(/#[\da-f]{6}\b/gi))].map(([hex]) => hex.toUpperCase()));
        const missingColors = colors.filter((hex) => !notedColors.has(hex));
        return [`【场景色彩：${name}】${notes ? `\n${notes}` : ""}${missingColors.length ? `\nHEX 色号：${missingColors.join("、")}` : ""}`];
    });
    return blocks.length ? [prompt.trim(), ...blocks].filter(Boolean).join("\n\n") : prompt;
}

function normalizeHex(value: unknown) {
    const text = String(value || "").trim();
    return /^#[\da-f]{6}$/i.test(text) ? text.toUpperCase() : undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
