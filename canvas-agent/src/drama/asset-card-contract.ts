/**
 * Asset-card contract shared by the write path and the compilation preflight.
 *
 * The Acheng engine validates every `asset_cards[]` entry against the IM2 image
 * skill contract (`skill/scripts/post_hooks.py::check_assets`). A card that is
 * stored without that routing data does not fail while it is being written: it
 * fails much later, inside the compiler, as the opaque engine error
 * `Acheng compiler failed: IM2 alias routing missing` — the first `require()`
 * in that chain. Because the compiler validates the cards that fall into the
 * compile scope, the same broken card surfaces (or hides) depending on which
 * shot was edited, which is why "adding a line to a silent clip" looked like the
 * cause.
 *
 * Two rules keep that from happening again:
 *  - routing/recipe/mode/status are derived from the card itself (below), never
 *    typed by the caller;
 *  - content fields the engine needs (seven_steps, transaction) are reported by
 *    name at write time instead of being discovered by the compiler.
 */

/** The only image route the pinned engine accepts for asset cards. */
export const IMAGE_ALIAS_ROUTE = { target_skill: "im2-clean-image", source_repository: "im2-image-skills" } as const;

export const ASSET_RECIPES = ["portrait", "dark", "fantasy", "hard_surface", "ink", "monochrome", "product", "clean_slate", "style"] as const;
export const ASSET_MODES = ["GENERATE", "EDIT", "REBUILD", "MIXED"] as const;

export type AssetRecipe = typeof ASSET_RECIPES[number];
export type AssetMode = typeof ASSET_MODES[number];

type Row = Record<string, any>;

const isObject = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Recipe follows the asset kind; an explicit valid recipe always wins. */
export function derivedRecipe(card: Row): AssetRecipe {
    const current = text(card.recipe);
    if ((ASSET_RECIPES as readonly string[]).includes(current)) return current as AssetRecipe;
    const kind = text(card.asset_kind).toLowerCase();
    if (kind === "style" || card.style_anchor_purpose) return "style";
    if (kind === "character") return "portrait";
    if (kind === "prop") return "product";
    return "fantasy";
}

/** Mode follows the reference slots: a bare prompt generates, bound references edit. */
export function derivedMode(card: Row): AssetMode {
    const current = text(card.mode);
    if ((ASSET_MODES as readonly string[]).includes(current)) return current as AssetMode;
    return Array.isArray(card.references) && card.references.length ? "EDIT" : "GENERATE";
}

/**
 * Stamps every routing field the engine derives-or-rejects, and leaves authored
 * content (prompt, seven_steps, transaction) untouched. Idempotent.
 */
export function normalizeAssetCard<T extends Row>(card: T): { card: T; derived: string[] } {
    const next = { ...card } as Row;
    const derived: string[] = [];
    for (const [field, value] of Object.entries(IMAGE_ALIAS_ROUTE)) {
        if (text(next[field]) !== value) { next[field] = value; derived.push(field); }
    }
    const recipe = derivedRecipe(next);
    if (next.recipe !== recipe) { next.recipe = recipe; derived.push("recipe"); }
    const mode = derivedMode(next);
    if (next.mode !== mode) { next.mode = mode; derived.push("mode"); }
    if (next.generation_status !== "generated" && next.generation_status !== "planned") { next.generation_status = "planned"; derived.push("generation_status"); }
    return { card: next as T, derived };
}

const SEVEN_STEPS = [1, 2, 3, 4, 5, 6, 7];

/** Engine-order field gaps for one card. Empty array means the engine will accept it. */
export function assetCardGaps(card: Row): string[] {
    const gaps: string[] = [];
    if (text(card.target_skill) !== IMAGE_ALIAS_ROUTE.target_skill) gaps.push("target_skill");
    if (text(card.source_repository) !== IMAGE_ALIAS_ROUTE.source_repository) gaps.push("source_repository");
    if (!(ASSET_RECIPES as readonly string[]).includes(text(card.recipe))) gaps.push("recipe");
    if (!(ASSET_MODES as readonly string[]).includes(text(card.mode))) gaps.push("mode");
    const steps = Array.isArray(card.seven_steps) ? card.seven_steps : [];
    const order = steps.map((step: unknown) => (isObject(step) ? step.step : undefined));
    if (order.length !== SEVEN_STEPS.length || order.some((step: unknown, index: number) => step !== SEVEN_STEPS[index])) gaps.push("seven_steps");
    else if (steps.some((step: Row) => !text(step.content))) gaps.push("seven_steps.content");
    const transaction = isObject(card.transaction) ? card.transaction : {};
    for (const field of ["change", "preserve", "rebuild"]) if (!text(transaction[field])) gaps.push(`transaction.${field}`);
    if (!["planned", "generated"].includes(text(card.generation_status))) gaps.push("generation_status");
    if (!text(card.prompt)) gaps.push("prompt");
    return gaps;
}

/** Cards that would crash the compiler, plus the field names that make them crash. */
export function incompleteAssetCards(cards: unknown[]): Array<{ id: string; gaps: string[] }> {
    return cards.filter(isObject).map(card => ({ id: text(card.id) || text(card.asset_id), gaps: assetCardGaps(card) }))
        .filter(entry => entry.gaps.length > 0);
}

/** Human-readable repair hint for markers such as the engine's alias-routing error. */
export function describeAssetCardGaps(id: string, gaps: string[]): string {
    const routing: string[] = gaps.filter((gap: string) => gap === "target_skill" || gap === "source_repository");
    const parts: string[] = [];
    if (routing.length) parts.push(`缺少 IM2 图片路由（${routing.join("、")}），编译器会把它报成 "IM2 alias routing missing"`);
    const other = gaps.filter((gap: string) => !routing.includes(gap));
    if (other.length) parts.push(`缺少 ${other.join("、")}`);
    return `资产卡 ${id || "(无 id)"} 不满足图像卡合同：${parts.join("；")}。补齐这些字段后重新预检；不要依赖编译器崩溃来发现它。`;
}
