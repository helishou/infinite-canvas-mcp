type Row = Record<string, any>;
type Workspace = "story" | "assets" | "shots" | "continuity" | "production" | "advanced";
type Target = { kind: "asset" | "keyframe" | "segment"; targetId: string; title?: string; status: string; blockers: string[] };
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];

/** Source module notes describe past director work; only current target checks are blockers. */
export function manualWorkspaceProgress(workspace: Workspace, source: Row, targets: Target[], continuityStatus?: string) {
    const scoped = targets.filter(target => workspace === "assets" ? target.kind === "asset" : workspace === "production" ? target.kind === "segment" : workspace === "shots" ? target.kind === "keyframe" : false);
    const blocked = scoped.filter(target => target.status === "blocked" && target.blockers.length);
    const firstBlockedTarget = blocked[0];
    const issue = firstBlockedTarget ? `${firstBlockedTarget.title || firstBlockedTarget.targetId}：${firstBlockedTarget.blockers[0]}` : "";
    if (workspace === "story") {
        const scripts = rows(source.script_scenes).filter(scene => String(scene.text || "").trim());
        return { status: scripts.length ? "saved" : "waiting", summaryKey: scripts.length ? "storySaved" : "storyEmpty", values: { count: scripts.length }, actionKey: "editScript", firstBlockedTarget };
    }
    if (workspace === "assets") {
        const count = rows(source.subject_registry).length || rows(source.character_registry).length + rows(source.scene_registry).length + rows(source.asset_plan).filter(asset => String(asset.kind) === "prop").length;
        return { status: blocked.length ? "blocked" : count ? "saved" : "waiting", summaryKey: blocked.length ? "targetsBlocked" : count ? "assetsSaved" : "assetsEmpty", values: { count: blocked.length || count, issue }, actionKey: "editAssets", firstBlockedTarget };
    }
    if (workspace === "shots") {
        const count = rows(source.shots).length;
        return { status: blocked.length ? "blocked" : count ? "saved" : "waiting", summaryKey: blocked.length ? "targetsBlocked" : count ? "shotsSaved" : "shotsEmpty", values: { count: blocked.length || count, clips: rows(source.segments).length, issue }, actionKey: "editShots", firstBlockedTarget };
    }
    if (workspace === "continuity") {
        const blocking = targets.some(target => target.blockers.some(reason => /CONTINUITY_|连续性/.test(reason)));
        return { status: blocking ? "blocked" : continuityStatus === "passed" ? "done" : "optional", summaryKey: blocking ? "continuityBlocked" : continuityStatus === "passed" ? "continuityPassed" : "continuityOptional", values: {}, actionKey: "checkContinuity", firstBlockedTarget };
    }
    const count = scoped.length, complete = scoped.filter(target => target.status === "complete").length;
    return { status: blocked.length ? "blocked" : count && complete === count ? "done" : count ? "working" : "waiting", summaryKey: blocked.length ? "productionBlocked" : count ? "productionProgress" : "productionEmpty", values: { count, blocked: blocked.length, complete, issue }, actionKey: "editProduction", firstBlockedTarget };
}

export function manualTargetRecovery(target: Target, source: Row) {
    const workspace: Workspace = target.kind === "asset" ? "assets" : target.kind === "keyframe" ? "shots" : "production";
    const kind = target.kind === "keyframe" ? "shot" : target.kind;
    const reason = target.blockers[0] || "";
    const segment = rows(source.segments).find(segment => String(segment.id) === target.targetId);
    const shotId = Array.isArray(segment?.shot_ids) ? segment.shot_ids[0] : undefined;
    if (/提示词为空|prompt.*empty/i.test(reason) && target.kind === "segment" && shotId) return { workspace: "shots" as Workspace, kind: "shot", id: String(shotId), messageKey: "promptMissing", actionKey: "completeShot" };
    if (/模型|渠道|model|provider/i.test(reason)) return { workspace: "advanced" as Workspace, kind, id: target.targetId, messageKey: "modelMissing", actionKey: "chooseModel" };
    if (reason && /图片|参考|素材|归档|文件|REFERENCE_|SUBJECT_IMAGE/.test(reason)) return { workspace: target.kind === "asset" ? "assets" as Workspace : "shots" as Workspace, kind: shotId ? "shot" : kind, id: shotId ? String(shotId) : target.targetId, messageKey: "referenceMissing", actionKey: "chooseReference" };
    if (reason && /帧窗|秒数|时长|相邻|跨越|连续边界/.test(reason)) return { workspace: "shots" as Workspace, kind: shotId ? "shot" : kind, id: shotId ? String(shotId) : target.targetId, messageKey: "timingInvalid", actionKey: "editShots" };
    return { workspace, kind, id: target.targetId, messageKey: target.status === "blocked" ? "targetBlocked" : target.status === "needs_review" ? "reviewTarget" : "openTarget", actionKey: target.status === "needs_review" ? "reviewMedia" : "openTargetEditor" };
}

export function canBindSubjectImage(choice: { projectId: string; nodeId: string } | undefined, canvasId: string, nodes: Row[], bindings: Row[], imageKey?: string) {
    if (!choice) return false;
    const node = choice.projectId === canvasId ? nodes.find(item => item.id === choice.nodeId) : undefined;
    if (choice.projectId === canvasId && !(node && (["image", "character", "scene", "prop"].includes(String(node.type)) || node.type === "config" && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image"))) return false;
    const sameNode = bindings.filter(binding => binding.sourceNode?.projectId === choice.projectId && binding.sourceNode?.nodeId === choice.nodeId);
    if (node?.type === "character") {
        const images = rows(node.metadata?.characterImages);
        const keys = [...new Set(images.map(image => String(image.storageKey || "")).filter(Boolean))];
        if (!keys.length) return sameNode.length === 0;
        const primaryIndex = Math.min(Math.max(Math.trunc(Number(node.metadata?.characterPrimaryIndex) || 0), 0), Math.max(images.length - 1, 0));
        const primaryKey = String(images[primaryIndex]?.storageKey || "");
        const boundKeys = new Set<string>();
        for (const binding of sameNode) {
            const selection = binding.selection || {};
            if (selection.mode === "selected_result") {
                const resultId = String(selection.resultId || "");
                for (const key of keys) if (resultId === key || resultId === `${choice.nodeId}:character-image:${key}`) boundKeys.add(key);
            } else if (selection.mode === "node_selection" || selection.mode === "latest_success") {
                if (primaryKey) boundKeys.add(primaryKey);
            }
        }
        return imageKey ? keys.includes(imageKey) && !boundKeys.has(imageKey) : keys.some(key => !boundKeys.has(key));
    }
    return sameNode.length === 0;
}
