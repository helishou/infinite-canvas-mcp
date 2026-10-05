import crypto from "node:crypto";
import { productionScriptGroups, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import { applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";
import type { BackendDatabase } from "../db.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { projectDirector } from "./director.js";
import { productionNodePosition } from "./production-layout-geometry.js";
import type { ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";

type Owner = { kind: "canvas" | "episode"; id: string };
const nodes = (project: Record<string, any>) => (project.nodes || []) as Record<string, any>[];
const scriptNodeId = (owner: Owner, id: string) => `production-script-${crypto.createHash("sha256").update(`${owner.kind}\0${owner.id}\0${id}`).digest("hex").slice(0, 24)}`;

/** Keep original block identities so editing dialogue never rewrites adjacent actions or beats. */
export function productionScriptNodes(data: EpisodeProductionData, owner: Owner) {
    const scripts = data.director?.source.script_scenes;
    const groups = productionScriptGroups(Array.isArray(scripts) ? scripts as Record<string, any>[] : []);
    return groups.flatMap(group => group.blocks.map((block, index) => ({
        id: scriptNodeId(owner, String(block.id || block.scene_id)),
        sceneId: group.key, scriptId: String(block.id || block.scene_id),
        title: `${group.title || group.sceneId} · 剧本${group.blocks.length > 1 ? ` · ${index + 1}/${group.blocks.length}` : ""}`,
        content: String(block.text || ""),
    })));
}

/** Source-to-canvas projection; called inside the production transaction, never during GET. */
export function scriptNodeOperations(project: Record<string, any>, data: EpisodeProductionData, owner: Owner, previous?: EpisodeProductionData, layout?: ProductionLayoutPlan): CanvasOperation[] {
    const prior = new Map(previous ? productionScriptNodes(previous, owner).map(item => [item.id, item]) : []);
    const occupied = [...nodes(project)];
    return productionScriptNodes(data, owner).flatMap((script, index): CanvasOperation[] => {
        const node = nodes(project).find(node => node.id === script.id);
        if (!node) {
            const unit = layout?.units.find(unit => unit.targets.includes(`script:${script.scriptId}`));
            const member = unit?.members.find(member => member.nodeId === script.id);
            const planned = member?.position;
            const position = planned || productionNodePosition(occupied, { x: -640, y: 350 + index * 440 }, 560, 320, 1);
            occupied.push({ id: script.id, position, width: 560, height: 320 });
            return [{ type: "add_node", id: script.id, nodeType: "text", title: script.title, position, width: 560, height: 320,
                metadata: { content: script.content, status: "success", productionScriptId: script.scriptId, productionScriptSceneId: script.sceneId,
                    ...(unit ? { productionLayoutUnitId: unit.id, productionLayoutBounds: unit.bounds.size } : {}) } }];
        }
        if (node.type !== "text" || node.metadata?.productionScriptId !== script.scriptId) throw new Error("剧本文本节点身份冲突，未覆盖原节点");
        const content = String(node.metadata?.content || "");
        if (content === script.content) return [];
        if (!prior.has(script.id) || prior.get(script.id)!.content !== content) throw new Error("剧本文本已被修改，请回读后再保存制作稿");
        return [{ type: "update_node", id: node.id, metadata: { content: script.content } }];
    });
}

/** Canvas-to-source edits share the canvas ops transaction and its idempotent receipt. */
export function syncScriptNodeEdits(db: BackendDatabase, projectId: string, before: Record<string, any>, after: Record<string, any>) {
    if (!nodes(before).some(node => node.metadata?.productionScriptId)) return [];
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    const owner: Owner = episode ? { kind: "episode", id: episode.id } : { kind: "canvas", id: projectId };
    const table = episode ? "episode_productions" : "canvas_productions", column = episode ? "episode_id" : "project_id";
    const row = db.db.prepare(`SELECT revision, draft_json FROM ${table} WHERE ${column}=?`).get(owner.id) as { revision: number; draft_json: string } | undefined;
    if (!row) return [];
    const draft = JSON.parse(row.draft_json) as EpisodeProductionData;
    const scripts = productionScriptNodes(draft, owner);
    let changed = false;
    for (const script of scripts) {
        const oldNode = nodes(before).find(node => node.id === script.id);
        if (!oldNode) continue;
        const node = nodes(after).find(node => node.id === script.id);
        if (!node) continue; // Removing a projection never deletes the formal source or history.
        if (node.type !== "text" || node.metadata?.productionScriptId !== script.scriptId || node.metadata?.productionScriptSceneId !== script.sceneId) throw new Error("正式剧本文本节点的来源标识不能修改");
        const content = String(node.metadata?.content || "");
        if (content === String(oldNode.metadata?.content || "")) continue;
        if (String(oldNode.metadata?.content || "") !== script.content) throw new Error("制作稿剧本已变化，请回读后再编辑文本节点");
        applyDirectorSourcePatch(draft.director!, "scene", script.scriptId, { text: content });
        changed = true;
    }
    if (!changed) return [];
    projectDirector(draft);
    const revision = row.revision + 1;
    db.db.prepare(`UPDATE ${table} SET revision=?, draft_json=?, updated_at=? WHERE ${column}=?`).run(revision, JSON.stringify(draft), new Date().toISOString(), owner.id);
    return [{ entityId: owner.id, revision }];
}
