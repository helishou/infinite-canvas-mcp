import assert from "node:assert/strict";
import test from "node:test";
import { ASSET_MODES, ASSET_RECIPES, IMAGE_ALIAS_ROUTE, assetCardGaps, describeAssetCardGaps, derivedMode, derivedRecipe, incompleteAssetCards, normalizeAssetCard } from "./asset-card-contract.js";

const steps = [1, 2, 3, 4, 5, 6, 7].map(step => ({ step, content: `第${step}步说明` }));

const complete = () => ({
    id: "AST-1", asset_id: "AST-1", asset_kind: "scene", asset_version: "v1", prompt: "空场环境",
    references: [], reference_policy: "none", ...IMAGE_ALIAS_ROUTE, recipe: "fantasy", mode: "GENERATE",
    seven_steps: structuredClone(steps), transaction: { change: "建立环境", preserve: "保持门位", rebuild: "只画空场" },
    generation_status: "planned",
});

test("routing, recipe, mode and status are derived from the card instead of typed by the caller", () => {
    const bare = { id: "AST-2", asset_kind: "character", prompt: "角色卡", references: [{ asset_id: "STYLE", role: "style" }] };
    const { card, derived } = normalizeAssetCard(bare);
    assert.deepEqual({ target_skill: card.target_skill, source_repository: card.source_repository }, { ...IMAGE_ALIAS_ROUTE });
    assert.equal(card.recipe, "portrait");
    assert.equal(card.mode, "EDIT");
    assert.equal(card.generation_status, "planned");
    assert.deepEqual(derived.sort(), ["generation_status", "mode", "recipe", "source_repository", "target_skill"]);
    // Idempotent: a second pass changes nothing.
    assert.deepEqual(normalizeAssetCard(card).derived, []);
});

test("recipe and mode derivation keeps explicit valid values and follows the asset kind otherwise", () => {
    assert.equal(derivedRecipe({ asset_kind: "scene", recipe: "dark" }), "dark");
    assert.equal(derivedRecipe({ asset_kind: "style" }), "style");
    assert.equal(derivedRecipe({ asset_kind: "prop" }), "product");
    assert.equal(derivedRecipe({ asset_kind: "scene" }), "fantasy");
    assert.equal(derivedRecipe({ asset_kind: "scene", style_anchor_purpose: "统一色板" }), "style");
    assert.equal(derivedMode({ references: [] }), "GENERATE");
    assert.equal(derivedMode({ references: [{ asset_id: "A" }] }), "EDIT");
    assert.equal(derivedMode({ references: [], mode: "MIXED" }), "MIXED");
});

test("a complete card has no gaps and an incomplete card names every missing field", () => {
    assert.deepEqual(assetCardGaps(complete()), []);
    const broken = { id: "AST-3", asset_kind: "scene", prompt: "空场环境", references: [] };
    assert.deepEqual(assetCardGaps(broken), ["target_skill", "source_repository", "recipe", "mode", "seven_steps",
        "transaction.change", "transaction.preserve", "transaction.rebuild", "generation_status"]);
    const shortSteps = { ...complete(), seven_steps: steps.slice(0, 6) };
    assert.deepEqual(assetCardGaps(shortSteps), ["seven_steps"]);
    const emptyStep = { ...complete(), seven_steps: steps.map((step, index) => index === 3 ? { step: step.step, content: "  " } : step) };
    assert.deepEqual(assetCardGaps(emptyStep), ["seven_steps.content"]);
    assert.deepEqual([...ASSET_MODES], ["GENERATE", "EDIT", "REBUILD", "MIXED"]);
    assert.ok((ASSET_RECIPES as readonly string[]).includes("style"));
});

test("normalizing then checking turns a bare card into a routed one that still reports authored-content gaps", () => {
    const bare = { id: "AST-4", asset_kind: "scene", prompt: "空场环境", references: [] };
    const { card } = normalizeAssetCard(bare);
    assert.deepEqual(assetCardGaps(card), ["seven_steps", "transaction.change", "transaction.preserve", "transaction.rebuild"]);
    assert.deepEqual(incompleteAssetCards([complete(), bare]).map(entry => entry.id), ["AST-4"]);
});

test("the repair hint names the engine's alias-routing error so the crash message stops being the only clue", () => {
    const gaps = assetCardGaps({ id: "EP3-AST-TEMPLE-INTERIOR", asset_kind: "scene", prompt: "空场", references: [] });
    const hint = describeAssetCardGaps("EP3-AST-TEMPLE-INTERIOR", gaps);
    assert.match(hint, /EP3-AST-TEMPLE-INTERIOR/);
    assert.match(hint, /IM2 图片路由/);
    assert.match(hint, /IM2 alias routing missing/);
    assert.match(hint, /seven_steps/);
});
