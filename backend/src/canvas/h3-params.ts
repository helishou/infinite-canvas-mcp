export type H3LoraSlot = { name: string; strength: number; enabled: boolean };

const MAX_H3_SEED = Number.MAX_SAFE_INTEGER;

export function parseH3Seed(value: unknown) {
    const seed = Number(value);
    return Number.isSafeInteger(seed) && seed >= 0 && seed <= MAX_H3_SEED ? seed : undefined;
}

export function randomH3Seed() {
    return Math.max(1, Math.floor(Math.random() * MAX_H3_SEED));
}

/**
 * Normalize the two historical LoRA representations into the slot list that
 * the V15 node actually consumes. An empty array is the legacy "not migrated"
 * value; a non-empty array (including disabled/empty slots) is authoritative.
 */
export function normalizeH3LoraSlots(params: Record<string, unknown>) {
    if (Array.isArray(params.loraSlots) && params.loraSlots.length > 0) return params.loraSlots;
    const name = String(params.loraName || "").trim();
    if (!name) return Array.isArray(params.loraSlots) ? params.loraSlots : [];
    return [{ name, strength: Number(params.loraStrength ?? 1), enabled: true } satisfies H3LoraSlot];
}

/**
 * Make the effective seed visible in the task snapshot before the prompt is
 * built. Random mode keeps an already generated non-zero seed (the UI dice
 * value); zero/empty is replaced once, so the UI, task and Comfy prompt agree.
 */
export function normalizeH3Params(params: Record<string, unknown>, generateRandomSeed = false) {
    const next: Record<string, unknown> = { ...params };
    const seed = parseH3Seed(next.seed) ?? parseH3Seed(next.noiseSeed);
    const rawMode = String(next.noiseSeedMode || "").toLowerCase();
    const mode = rawMode === "fixed" ? "fixed" : rawMode === "random" ? "random" : seed === undefined || seed === 0 ? "random" : "fixed";
    next.noiseSeedMode = mode;
    const effectiveSeed = mode === "random" && (seed === undefined || seed === 0)
        ? (generateRandomSeed ? randomH3Seed() : seed)
        : seed;
    if (effectiveSeed !== undefined) {
        next.seed = effectiveSeed;
        next.noiseSeed = effectiveSeed;
    }
    next.loraSlots = normalizeH3LoraSlots(next);
    return next;
}

export function resolveH3Seed(params: Record<string, unknown>) {
    const normalized = normalizeH3Params(params, true);
    return parseH3Seed(normalized.seed) ?? randomH3Seed();
}
