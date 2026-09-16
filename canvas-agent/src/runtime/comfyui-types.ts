export type ComfyPreset = { id: string; name: string; kind: "image" | "video"; inputs: string[]; params: string[] };
export type ComfyModelCatalog = { models: string[]; loras: string[]; textEncoders: string[]; videoVaes: string[]; audioVaes: string[]; latentUpscaleModels: string[]; nanfeng?: Record<string, unknown[]>; refreshedAt: string; error?: string };
