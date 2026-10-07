export function productionOwnerPath(input: { kind: "episode" | "canvas"; id: string }) {
    if (!["episode", "canvas"].includes(input.kind) || typeof input.id !== "string" || !input.id.length) throw new Error("制作工具必须指定 kind:episode/canvas 和 id");
    return `${input.kind === "episode" ? "/drama/episodes" : "/canvas/projects"}/${encodeURIComponent(input.id)}/production`;
}
