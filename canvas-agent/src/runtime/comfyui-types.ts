export type ComfyPreset = { id: string; name: string; kind: "image" | "video"; inputs: string[]; params: string[] };
export type ComfyModelCatalog = { models: string[]; loras: string[]; refreshedAt: string; error?: string };
