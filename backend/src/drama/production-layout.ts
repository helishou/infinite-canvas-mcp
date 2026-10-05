import crypto from "node:crypto";
import { canonicalProduction, productionLayoutPlanSchema, productionSceneEntries, type EpisodeProductionData, type ProductionLayoutPlan, type ProductionLayoutUnit } from "@basketikun/canvas-agent/drama/production-contract";
import { productionScriptNodes } from "./script-nodes.js";
import { productionNodePosition, productionLayoutStableId, productionSharedProjectionNodeId, type Position } from "./production-layout-geometry.js";
export { productionAssetPosition, productionNodePosition, productionOutputPosition, productionSceneLayout } from "./production-layout-geometry.js";

type Node = Record<string, any>;
type Owner = { kind: "episode" | "canvas"; id: string };
type Input = { canvasId: string; owner: Owner; production: EpisodeProductionData; project: Record<string, any>; previous?: ProductionLayoutPlan | null };
type Member = ProductionLayoutUnit["members"][number];
type DraftUnit = { id: string; area: ProductionLayoutUnit["area"]; targets: string[]; sceneId?: string; bounds: { position: Position; size: { width: number; height: number } }; members: Member[]; status?: ProductionLayoutUnit["status"] };
const obj = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const arr = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") as Record<string, any>[] : [];
const hash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
const size = (value: unknown, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const category = (kind: string) => { const key = kind.toLocaleLowerCase(); return /(style|风格)/.test(key) ? 0 : /(character|wardrobe|outfit|costume|角色|服装)/.test(key) ? 1 : /(scene|环境|场景)/.test(key) ? 2 : /(prop|道具)/.test(key) ? 3 : 4; };

/** Pure whole-production layout compiler. It neither writes nodes nor submits media. */
export function compileProductionLayout({ canvasId, owner, production, project, previous }: Input): ProductionLayoutPlan {
    const director = production.director;
    const nodes = arr(project.nodes), nodeById = new Map(nodes.map(node => [String(node.id), node]));
    const oldUnits = new Map((previous?.units || []).map(unit => [unit.id, unit]));
    const diagnostics: ProductionLayoutPlan["diagnostics"] = [];
    const units = new Map<string, DraftUnit>(), activeIds = new Set<string>();
    const plan = arr(director?.source.asset_plan);
    const scripts = director ? productionScriptNodes(production, owner) : [];
    const scenes = director ? productionSceneEntries(director.source) : [];
    const sceneByShot = new Map<string, string>();
    for (const scene of scenes) for (const shotId of scene.shotIds) if (!sceneByShot.has(shotId)) sceneByShot.set(shotId, scene.id);
    const scriptByScene = new Map<string, typeof scripts>();
    for (const script of scripts) scriptByScene.set(script.sceneId, [...(scriptByScene.get(script.sceneId) || []), script]);
    const inputAssetByShot = director?.shotInputs || {};
    const shotsByKeyframeAsset = new Map<string, string[]>();
    for (const [shotId, input] of Object.entries(inputAssetByShot)) if (input.keyframeAssetId && input.keyframePolicy !== "none") {
        const key = String(input.keyframeAssetId); shotsByKeyframeAsset.set(key, [...(shotsByKeyframeAsset.get(key) || []), shotId]);
    }
    const explicitAssets = plan.map((item, index) => ({ item, index, id: String(item.asset_id || item.id || "") })).filter(item => item.id);
    for (const [index, id] of Object.keys(director?.assets || {}).entries()) if (!explicitAssets.some(item => item.id === id)) explicitAssets.push({ item: { id, kind: "other" }, index: explicitAssets.length + index, id });
    explicitAssets.sort((a, b) => category(String(a.item.kind || a.item.role || "")) - category(String(b.item.kind || b.item.role || "")) || a.index - b.index || a.id.localeCompare(b.id));
    const createUnit = (id: string, area: ProductionLayoutUnit["area"], targets: string[], sceneId: string | undefined, preferred: Position, bounds: { width: number; height: number }, members: Member[]) => {
        const old = oldUnits.get(id);
        if (old && (old.area !== area || old.sceneId !== sceneId)) diagnostics.push({ code: "LAYOUT_UNIT_RECLASSIFIED", target: targets[0], message: "对象分区已变化；保留已编译布局" });
        const templatePositions = new Map(members.map(member => [member.nodeId, { ...member.position }]));
        const active = { id, area: old?.area || area, targets: [...new Set([...(old?.targets || []), ...targets])], ...(old?.sceneId || sceneId ? { sceneId: old?.sceneId || sceneId } : {}), bounds: old?.bounds || { position: preferred, size: bounds }, members };
        if (old?.status === "reserved") {
            active.bounds = old.bounds;
            for (const member of active.members) {
                const priorMember = old.members.find(candidate => candidate.nodeId === member.nodeId);
                if (priorMember && !nodeById.has(member.nodeId)) { member.position = priorMember.position; member.size = priorMember.size; }
            }
        }
        for (const member of active.members) {
            const actual = nodeById.get(member.nodeId);
            if (actual?.position) { member.position = { x: Number(actual.position.x), y: Number(actual.position.y) }; member.size = { width: size(actual.width, member.size.width), height: size(actual.height, member.size.height) }; }
        }
        const anchor = active.members.find(member => nodeById.has(member.nodeId));
        const priorAnchor = anchor && old?.members.find(member => member.nodeId === anchor.nodeId);
        const templateAnchor = anchor && templatePositions.get(anchor.nodeId);
        if (anchor && !old && templateAnchor) {
            active.bounds.position = { x: preferred.x + anchor.position.x - templateAnchor.x, y: preferred.y + anchor.position.y - templateAnchor.y };
            const right = Math.max(...active.members.map(member => member.position.x + member.size.width)), bottom = Math.max(...active.members.map(member => member.position.y + member.size.height));
            active.bounds.size = { width: Math.max(active.bounds.size.width, right - active.bounds.position.x), height: Math.max(active.bounds.size.height, bottom - active.bounds.position.y) };
        } else if (anchor && priorAnchor && old?.status === "materialized") {
            active.bounds.position = { x: old.bounds.position.x + anchor.position.x - priorAnchor.position.x, y: old.bounds.position.y + anchor.position.y - priorAnchor.position.y };
            const right = Math.max(...active.members.map(member => member.position.x + member.size.width)), bottom = Math.max(...active.members.map(member => member.position.y + member.size.height));
            active.bounds.size = { width: Math.max(old.bounds.size.width, right - active.bounds.position.x), height: Math.max(old.bounds.size.height, bottom - active.bounds.position.y) };
        }
        const anchored = active.members.map(member => ({ member, old: old?.members.find(item => item.nodeId === member.nodeId), template: templatePositions.get(member.nodeId) })).find(item => item.template && nodeById.has(item.member.nodeId));
        if (anchored) {
            const anchorBase = anchored.old?.position || anchored.template!;
            active.bounds.position = { x: active.bounds.position.x + anchored.member.position.x - anchorBase.x, y: active.bounds.position.y + anchored.member.position.y - anchorBase.y };
            const right = Math.max(...active.members.map(member => member.position.x + member.size.width)), bottom = Math.max(...active.members.map(member => member.position.y + member.size.height));
            active.bounds.size = { width: Math.max(active.bounds.size.width, right - active.bounds.position.x), height: Math.max(active.bounds.size.height, bottom - active.bounds.position.y) };
        }
        units.set(id, active); activeIds.add(id);
        return active;
    };

    const frameAssetIds = new Set(shotsByKeyframeAsset.keys());
    const standaloneAssets = explicitAssets.filter(item => !frameAssetIds.has(item.id));
    const multiSceneFrames = explicitAssets.filter(item => frameAssetIds.has(item.id) && new Set((shotsByKeyframeAsset.get(item.id) || []).map(shotId => sceneByShot.get(shotId)).filter(Boolean)).size > 1).map(item => item.id);
    const assetOrder = [...new Set([...standaloneAssets.map(item => item.id), ...multiSceneFrames])];
    // Keep the first asset row below the fixed canvas toolbar and review actions.
    const assetAreaTop = 280;
    for (let index = 0; index < standaloneAssets.length; index++) {
        const { id, item } = standaloneAssets[index];
        const shared = String(item.canvas_scope || "") === "shared" || Boolean(director?.assets[id]?.sharedSource);
        const boundId = String(director?.assets[id]?.nodeId || ""), bound = boundId ? nodeById.get(boundId) : undefined;
        const sharedProjectionId = shared && owner.kind === "episode" ? productionSharedProjectionNodeId(owner.id, id) : "";
        const existingId = String(sharedProjectionId && bound?.metadata?.sharedAssetOrigin?.assetId !== id ? sharedProjectionId : boundId || sharedProjectionId || productionLayoutStableId("production-asset", owner.id, id));
        const slot = assetOrder.indexOf(id), cell = { x: slot % 3 * 720, y: assetAreaTop + Math.floor(slot / 3) * 840 };
        createUnit(`asset:${id}`, "asset", [`asset:${id}`], undefined, cell, { width: 620, height: 720 }, [{ role: "asset", nodeId: existingId, nodeType: "image", position: { x: cell.x + 140, y: cell.y + 80 }, size: { width: 340, height: 520 } }]);
    }

    let sceneY = assetAreaTop + Math.ceil(Math.max(1, assetOrder.length) / 3) * 840 + 180;
    const sceneFrameAssets = new Map<string, string[]>();
    for (const [assetId, shotIds] of shotsByKeyframeAsset) for (const shotId of shotIds) {
        const sceneId = sceneByShot.get(shotId); if (!sceneId) continue;
        sceneFrameAssets.set(sceneId, [...(sceneFrameAssets.get(sceneId) || []), shotId]);
    }
    const sceneGeometry = new Map<string, { y: number; height: number; width: number }>();
    for (const scene of scenes) {
        const sceneScripts = scriptByScene.get(scene.id) || [], frameShots = sceneFrameAssets.get(scene.id) || [];
        const height = Math.max(900, sceneScripts.length * 440, Math.ceil(frameShots.length / 3) * 1000 + 130);
        sceneGeometry.set(scene.id, { y: sceneY, height, width: 2160 });
        const groupId = productionLayoutStableId("production-scene", owner.id, scene.id), groupNode = nodeById.get(groupId), priorGroup = oldUnits.get(`scene:${scene.id}`);
        const groupPosition = groupNode?.position ? { x: Number(groupNode.position.x), y: Number(groupNode.position.y) } : priorGroup?.bounds.position || { x: 0, y: sceneY };
        const requiredGroupSize = { width: Math.max(2160, size(groupNode?.width, 2160)), height: Math.max(height, size(groupNode?.height, height)) };
        const sceneUnit = createUnit(`scene:${scene.id}`, "scene", [`scene:${scene.id}`], scene.id, groupPosition, requiredGroupSize,
            [{ role: "scene", nodeId: groupId, nodeType: "group", position: groupPosition, size: requiredGroupSize }]);
        sceneUnit.bounds.size = { width: Math.max(2160, size(groupNode?.width, 2160)), height: Math.max(height, size(groupNode?.height, height)) };
        sceneUnit.members[0].size = sceneUnit.bounds.size;
        for (let index = 0; index < sceneScripts.length; index++) {
            const script = sceneScripts[index], node = nodeById.get(script.id), preferred = { x: -700, y: sceneY + index * 380 };
            createUnit(`script:${script.scriptId}`, "script", [`script:${script.scriptId}`], scene.id, node?.position || preferred,
                { width: size(node?.width, 560), height: size(node?.height, 320) }, [{ role: "script", nodeId: script.id, nodeType: "text", position: node?.position || preferred, size: { width: size(node?.width, 560), height: size(node?.height, 320) } }]);
        }
        for (let index = 0; index < frameShots.length; index++) {
            const shotId = frameShots[index], assetId = String(inputAssetByShot[shotId]?.keyframeAssetId), nodeId = String(production.keyframes[shotId]?.nodeId || director?.assets[assetId]?.nodeId || productionLayoutStableId("production-asset", owner.id, assetId));
            const cell = { x: groupPosition.x + 20 + index % 3 * 720, y: groupPosition.y + 70 + Math.floor(index / 3) * 1000 };
            const existing = nodeById.get(nodeId), sharedShots = shotsByKeyframeAsset.get(assetId) || [], multiScene = new Set(sharedShots.map(id => sceneByShot.get(id)).filter(Boolean)).size > 1;
            const assetIndex = assetOrder.indexOf(assetId), assetCell = { x: assetIndex % 3 * 720, y: assetAreaTop + Math.floor(assetIndex / 3) * 840 };
            const imagePosition = existing?.position || (multiScene ? { x: assetCell.x + 140, y: assetCell.y + 80 } : { x: cell.x + 140, y: cell.y });
            const imageUnit = createUnit(`keyframe-asset:${assetId}`, multiScene ? "asset" : "keyframe", [`asset:${assetId}`, ...sharedShots.map(id => `frame:${id}`)], multiScene ? undefined : scene.id,
                multiScene ? assetCell : { x: cell.x + 140, y: cell.y }, { width: multiScene ? 620 : 340, height: multiScene ? 720 : 520 },
                [{ role: "keyframe", nodeId, nodeType: "image", position: imagePosition, size: { width: size(existing?.width, 340), height: size(existing?.height, 520) } }]);
            const promptId = productionLayoutStableId("production-source", owner.id, shotId), oldPromptUnit = oldUnits.get(`frame-prompt:${shotId}`);
            const promptNode = nodeById.get(promptId), promptCell = { x: cell.x + 20, y: cell.y + 600 };
            const promptBounds = oldPromptUnit?.bounds || { position: promptCell, size: { width: 620, height: 220 } };
            const promptPosition = promptNode?.position || oldPromptUnit?.members[0]?.position || { x: promptCell.x + 120, y: promptCell.y };
            createUnit(`frame-prompt:${shotId}`, "prompt", [`frame-prompt:${shotId}`], scene.id, promptBounds.position, promptBounds.size,
                [{ role: "prompt", nodeId: promptId, nodeType: "config", position: promptPosition, size: { width: size(promptNode?.width, 340), height: size(promptNode?.height, 180) } }]);
            // One asset node may be a keyframe for multiple shots; its single physical slot is shared.
            if (!imageUnit.targets.includes(`frame:${shotId}`)) imageUnit.targets.push(`frame:${shotId}`);
        }
        sceneY += height + 120;
    }

    const videoNodeIds = [...new Set(production.clipGroups.map(group => String(group.nodeId || productionLayoutStableId("production-h3", owner.id))))];
    for (let index = 0; index < videoNodeIds.length; index++) {
        const nodeId = videoNodeIds[index], existing = nodeById.get(nodeId), position = existing?.position || { x: 0, y: sceneY + index * 1240 };
        const targets = production.clipGroups.filter(group => String(group.nodeId || productionLayoutStableId("production-h3", owner.id)) === nodeId).map(group => `segment:${group.id}`);
        createUnit(`video:${nodeId}`, "video", targets, undefined, position, { width: size(existing?.width, 1960), height: size(existing?.height, 1080) }, [{ role: "video", nodeId, nodeType: "minimax-h3:video", position, size: { width: size(existing?.width, 1960), height: size(existing?.height, 1080) } }]);
    }

    // Old materialized nodes remain layout anchors even if their source object was later removed.
    for (const old of oldUnits.values()) if (!activeIds.has(old.id) && old.status === "materialized" && old.members.some(member => nodeById.has(member.nodeId))) {
        units.set(old.id, old); diagnostics.push({ code: "LAYOUT_ORPHAN_ANCHOR", target: old.targets[0], message: "既有节点已不在当前源稿，仍保留其布局锚点" });
    }

    const fixed = nodes.filter(node => node.position).map(node => ({ id: String(node.id), position: { x: Number(node.position.x), y: Number(node.position.y) }, width: size(node.width, 340), height: size(node.height, 260) }));
    const reservedMembers: Node[] = [];
    for (const candidate of units.values()) {
        if (candidate.members.length === 1 && candidate.members[0].role === "scene") continue;
        const old = oldUnits.get(candidate.id);
        if (old?.status === "materialized" || candidate.members.some(member => nodeById.has(member.nodeId))) {
            const anchors = candidate.members.map(member => ({ member, old: old?.members.find(item => item.nodeId === member.nodeId) })).filter(item => item.old && nodeById.has(item.member.nodeId));
            if (anchors.length) {
                const first = anchors[0], previousMember = first.old!;
                const dx = first.member.position.x - previousMember.position.x, dy = first.member.position.y - previousMember.position.y;
                const left = Math.min(...candidate.members.map(member => member.position.x)), top = Math.min(...candidate.members.map(member => member.position.y));
                const right = Math.max(...candidate.members.map(member => member.position.x + member.size.width)), bottom = Math.max(...candidate.members.map(member => member.position.y + member.size.height));
                candidate.bounds = old ? { position: { x: old.bounds.position.x + dx, y: old.bounds.position.y + dy }, size: { width: Math.max(old.bounds.size.width, right - left), height: Math.max(old.bounds.size.height, bottom - top) } }
                    : { position: { x: left, y: top }, size: { width: right - left, height: bottom - top } };
            }
            continue;
        }
        const physicalIds = new Set(candidate.members.map(member => member.nodeId));
        const sceneGroupIds = new Set(nodes.filter(node => node.metadata?.productionSceneId === candidate.sceneId).map(node => String(node.id)));
        const blockers = [...fixed.filter(node => !physicalIds.has(node.id) && !sceneGroupIds.has(node.id)), ...reservedMembers.filter(node => !physicalIds.has(String(node.id)) && !(candidate.sceneId && node.sceneId === candidate.sceneId && node.area === "scene"))];
        const preferred = old?.bounds.position || candidate.bounds.position;
        const relocated = productionNodePosition(blockers, preferred, candidate.bounds.size.width, candidate.bounds.size.height, 1);
        if (relocated.x !== preferred.x || relocated.y !== preferred.y) {
            candidate.bounds = { position: relocated, size: candidate.bounds.size };
            const dx = relocated.x - preferred.x, dy = relocated.y - preferred.y;
            candidate.members = candidate.members.map(member => ({ ...member, position: { x: member.position.x + dx, y: member.position.y + dy } }));
            if (old) diagnostics.push({ code: "LAYOUT_RESERVED_SLOT_OCCUPIED", target: candidate.targets[0], message: "预留位置被画布对象占用；只调整尚未创建的布局单元" });
        }
        reservedMembers.push(...candidate.members.map(member => ({ id: member.nodeId, position: member.position, width: member.size.width, height: member.size.height, area: candidate.area, sceneId: candidate.sceneId })));
    }

    for (const unit of units.values()) unit.status = unit.members.every(member => nodeById.has(member.nodeId)) ? "materialized" : "reserved";
    const planUnits = [...units.values()].sort((a, b) => a.id.localeCompare(b.id));
    const regions = [...new Set(planUnits.map(unit => unit.area))].map(area => {
        const selected = planUnits.filter(unit => unit.area === area), x = Math.min(...selected.map(unit => unit.bounds.position.x)), y = Math.min(...selected.map(unit => unit.bounds.position.y));
        const right = Math.max(...selected.map(unit => unit.bounds.position.x + unit.bounds.size.width)), bottom = Math.max(...selected.map(unit => unit.bounds.position.y + unit.bounds.size.height));
        return { id: area, area, bounds: { position: { x, y }, size: { width: right - x, height: bottom - y } } };
    });
    const structureHash = hash({ assets: explicitAssets.map(item => [item.id, item.item.kind || item.item.role || "other", item.item.canvas_scope || "", item.item.depends_on || []]), scripts: scripts.map(script => [script.sceneId, script.scriptId]), scenes: scenes.map(scene => [scene.id, scene.shotIds]), frames: Object.entries(inputAssetByShot).map(([id, input]) => [id, input.keyframeAssetId || "", input.keyframePolicy]), clips: production.clipGroups.map(group => [group.id, group.shotIds, group.nodeId || ""]) });
    const geometryHash = hash(fixed.map(node => [node.id, node.position, node.width, node.height]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const body = { schemaVersion: 1, algorithmVersion: "production-layout-v1", canvasId, owner, structureHash, geometryHash, regions, units: planUnits, diagnostics };
    return productionLayoutPlanSchema.parse({ ...body, planHash: hash(body) });
}
