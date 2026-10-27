import assert from "node:assert/strict";
import test from "node:test";
import { matchesProductionAssetNode, subjectProductionKind } from "./production-asset-identity";

test("subject display kind follows its stable entity reference, not a biological label", () => {
  assert.equal(subjectProductionKind({ kind: "animal", entityRef: { kind: "character", id: "FOX_1" } }), "character");
  assert.equal(subjectProductionKind({ kind: "prop", entityRef: { kind: "asset", id: "SWORD_1" } }), "prop");
  assert.equal(subjectProductionKind({ kind: "character", entityRef: { kind: "animal", id: "FOX_1" } }), undefined);
});

test("only a node with matching type and stable owner identity is a production asset node", () => {
  const owner = { kind: "episode", id: "EP_1" };
  const valid = { id: "N1", type: "character", metadata: { productionEntity: { ownerKind: "episode", ownerId: "EP_1", kind: "character", entityId: "CHAR_1" } } };
  assert.equal(matchesProductionAssetNode(valid, "character", owner, "CHAR_1"), true);
  assert.equal(matchesProductionAssetNode({ ...valid, metadata: {} }, "character", owner, "CHAR_1"), false);
  assert.equal(matchesProductionAssetNode({ ...valid, type: "prop" }, "character", owner, "CHAR_1"), false);
  assert.equal(matchesProductionAssetNode({ ...valid, metadata: { productionEntity: { ...valid.metadata.productionEntity, ownerId: "EP_2" } } }, "character", owner, "CHAR_1"), false);
  assert.equal(matchesProductionAssetNode({ ...valid, metadata: { productionEntity: { ...valid.metadata.productionEntity, entityId: "CHAR_2" } } }, "character", owner, "CHAR_1"), false);
});
