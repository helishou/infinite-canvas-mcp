import { productionEntityBinding } from "@basketikun/canvas-agent/drama/production-contract";

type ProductionEntityKind = "character" | "scene" | "prop";

type ProductionNodeIdentity = {
  id?: string;
  type?: string;
  metadata?: Record<string, unknown>;
};

type ProductionOwner = { kind: string; id: string };

export function subjectProductionKind(subject: Record<string, any>): ProductionEntityKind | undefined {
  const ref = subject.entityRef;
  if (!ref || typeof ref !== "object") return undefined;
  if (ref.kind === "character" || ref.kind === "scene") return ref.kind;
  if (ref.kind === "asset") return "prop";
  return undefined;
}

export function matchesProductionAssetNode(
  node: ProductionNodeIdentity,
  kind: ProductionEntityKind,
  owner: ProductionOwner,
  entityId?: string,
): boolean {
  if (node.type !== kind) return false;
  const binding = productionEntityBinding(node.metadata?.productionEntity);
  return Boolean(binding
    && binding.kind === kind
    && binding.ownerKind === owner.kind
    && binding.ownerId === owner.id
    && binding.entityId
    && (!entityId || binding.entityId === entityId));
}
