export type H3LoraSlot = { name: string; strength: number; enabled: boolean };

const MAX_H3_SEED = Number.MAX_SAFE_INTEGER;

/**
 * 与本机 NanFengH3MultiReferenceGeneratorV15 的「LoRA{N}强度」声明对齐：
 * FLOAT min -4.0、max 10.0、step 0.05；ComfyUI 进程重载节点后 object_info 才会更新。
 * 超出范围时 ComfyUI 会在 /prompt 阶段整体拒绝（HTTP 400
 * prompt_outputs_failed_validation / value_bigger_than_max），任务连队列都进不去，
 * 只对超出 V15 声明范围的值在编译期夹紧，而不是等 ComfyUI 报错。
 * 注意：走 LoraLoader/LoraLoaderModelOnly 的老路径范围是 ±100，这里只约束 V15 原生节点。
 */
export const H3_LORA_STRENGTH_MIN = -4;
export const H3_LORA_STRENGTH_MAX = 10;

export function clampH3LoraStrength(value: unknown, fallback = 1) {
    const strength = Number(value);
    if (!Number.isFinite(strength)) return fallback;
    return Math.min(H3_LORA_STRENGTH_MAX, Math.max(H3_LORA_STRENGTH_MIN, strength));
}

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
    const clampSlots = (slots: unknown[]) => (slots as Array<Record<string, unknown>>).map((slot) => {
        if (!slot || typeof slot !== "object") return slot;
        return slot.strength === undefined || slot.strength === null
            ? slot
            : { ...slot, strength: clampH3LoraStrength(slot.strength) };
    });
    if (Array.isArray(params.loraSlots) && params.loraSlots.length > 0) return clampSlots(params.loraSlots);
    const name = String(params.loraName || "").trim();
    if (!name) return Array.isArray(params.loraSlots) ? clampSlots(params.loraSlots) : [];
    return [{ name, strength: clampH3LoraStrength(params.loraStrength ?? 1), enabled: true } satisfies H3LoraSlot];
}

/**
 * Make the effective seed visible in the task snapshot before the prompt is
 * built. Keep a seed already resolved in the run plan; fill zero/empty values
 * for legacy inputs. New runs reroll random seeds per Clip in CanvasH3Runner,
 * so repeated graph construction and second-pass confirmation stay stable.
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
