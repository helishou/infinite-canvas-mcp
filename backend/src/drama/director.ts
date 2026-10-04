import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalProduction, type DirectorProduction, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import { resolveAchengRuntime } from "@basketikun/canvas-agent/skills/acheng";
import { ref2vaPromptDiagnostics, ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";

export function assertDirectorEngine(engine: DirectorProduction["engine"]) {
    const runtime = resolveAchengRuntime(engine.runtimeId);
    if (runtime.commit !== engine.commit || runtime.patchVersion !== engine.patchVersion || runtime.version !== engine.version) throw new Error("Acheng 引擎回执与固定运行版本不一致");
}

export const directorHash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value)).digest("hex");
export const promptHash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const obj = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value.map(obj) : [];
const prose = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? {});

export function projectDirector(data: EpisodeProductionData) {
    const d = data.director; if (!d) return;
    if (directorHash(d.source) !== d.sourceHash) throw new Error("Acheng sourceHash 与完整制作稿不一致");
    const source = d.source;
    if (JSON.stringify(source).includes('"legacy_fixture"')) throw new Error("新制作不能使用 legacy_fixture");
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error("Acheng fps 无效");
    const shots = list(source.shots);
    const scenes = list(source.script_scenes);
    // Location is the shared Shot scene identity; preserve authored scene blocks.
    const sceneIds = [...new Set([...scenes.map(s => String(s.scene_id || s.id)), ...shots.map(s => String(s.scene_id))])];
    data.scenes = sceneIds.map(sceneId => ({ id: sceneId, heading: String(scenes.find(s => (s.scene_id || s.id) === sceneId)?.scene_name || sceneId), location: sceneId, timeOfDay: "", blocks: scenes.filter(s => (s.scene_id || s.id) === sceneId).map(s => ({ id: String(s.id), kind: "action" as const, text: String(s.text || "") })) }));
    data.shots = shots.map(s => {
        const input = d.shotInputs[String(s.id)];
        const assetNodeIds = (input?.assetIds || []).flatMap(id => d.assets[id]?.nodeId ? [d.assets[id]!.nodeId!] : []);
        const duration = (Number(s.end_frame) - Number(s.start_frame)) / fps;
        return { id: String(s.id), sceneId: String(s.scene_id), title: String(s.title || s.id), duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
            visual: prose(s.visual), camera: prose(s.camera), openingState: prose(s.state_in), endingState: prose(s.state_out), sound: prose({ dialogues: s.dialogues, audio: s.audio }), assetNodeIds, keyframePolicy: input?.keyframePolicy || "none" };
    });
    const prior = new Map(data.clipGroups.map(g => [g.id, g]));
    const shotIds = new Set(shots.map(s => String(s.id)));
    data.clipGroups = list(source.segments).filter(s => Array.isArray(s.shot_ids) && s.shot_ids.length && s.shot_ids.every((id: unknown) => shotIds.has(String(id))))
        .map(s => ({ id: String(s.id), shotIds: s.shot_ids.map(String), nodeId: prior.get(String(s.id))?.nodeId || null, segmentId: prior.get(String(s.id))?.segmentId || null, sourceVersion: prior.get(String(s.id))?.sourceVersion || 0,
            ...(prior.get(String(s.id))?.inputOutdated === undefined ? {} : { inputOutdated: prior.get(String(s.id))!.inputOutdated }) }));
    if (new Set(d.artifacts.map(a => `${a.kind}:${a.targetId}`)).size !== d.artifacts.length) throw new Error("同一目标只能有一个当前编译产物");
    for (const artifact of d.artifacts) {
        if (artifact.sha256 !== promptHash(artifact.prompt)) throw new Error(`产物 ${artifact.id} 正文字节摘要不一致`);
        if (artifact.status === "ready" && (artifact.sourceHash !== d.sourceHash || artifact.receipt.sourceHash !== d.sourceHash || artifact.receipt.promptHash !== artifact.sha256 || artifact.receipt.engineRuntimeId !== d.engine.runtimeId)) throw new Error(`产物 ${artifact.id} 回执版本不一致`);

    }
    const sourceContract = /^[a-f0-9]{40}-[a-f0-9]{16}$/.test(d.engine.runtimeId) ? resolveAchengRuntime(d.engine.runtimeId).sourceContract : null;
    const promptIssues = ref2vaPromptDiagnostics(d, sourceContract ? sourceContract.ref2vaMaximumWords : 2900);
    if (promptIssues.length) throw new ProductionValidationError(promptIssues);
}

/** Verify actual media bytes and project ownership, never a supplied PASS string. */
export function validateDirectorMedia(db: BackendDatabase, projectId: string, d: DirectorProduction, targetIds?: string[]) {
    const nodes = db.getCanvasProject(projectId)?.nodes as Array<Record<string, any>> | undefined;
    if (!nodes) throw new Error("画布不存在");
    const plan = new Map(list(d.source.asset_plan).map(a => [String(a.asset_id || a.id), a]));
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error(`资产依赖存在循环：${id}`);
        if (visited.has(id)) return;
        const entry = plan.get(id); if (!entry) throw new Error(`资产依赖未登记：${id}`);
        visiting.add(id);
        for (const dependency of entry.depends_on || []) visit(String(dependency));
        visiting.delete(id); visited.add(id);
    };
    const selected = targetIds ? new Set(targetIds) : undefined;
    const artifacts = d.artifacts.filter(a => a.status === "ready" && (!selected || selected.has(a.targetId)));
    for (const artifact of artifacts) {
        const dependencies = artifact.kind === "image" ? plan.get(artifact.targetId)?.depends_on || []
            : list(d.source.shots).filter(s => list(d.source.segments).find(seg => seg.id === artifact.targetId)?.shot_ids?.includes(s.id)).flatMap(s => s.required_assets || []);
        for (const id of dependencies) visit(String(id));
        for (const id of dependencies) {
            const asset = d.assets[String(id)];
            if (asset?.inputOutdated) throw new Error(`依赖 ${id} 的媒体来自旧共享输入，请明确处理后继续`);
            if (!asset || asset.status !== "approved" || !asset.evidence?.trim() || (plan.get(String(id))?.version && plan.get(String(id))?.version !== asset.version)) throw new Error(`产物 ${artifact.id} 依赖未批准或版本不一致：${id}`);
        }
        if (d.source.style_policy === "waived" && !String(d.source.style_policy_reason || "").trim()) throw new Error("风格豁免缺少用户决定与理由");
        const styleRequired = d.source.style_policy === "required" || (plan.size > 1 && d.source.style_policy !== "waived");
        if (artifact.kind === "image" && styleRequired && artifact.targetId !== obj(d.source.style_lock).anchor_asset_id) {
            const styleId = String(obj(d.source.style_lock).anchor_asset_id || "");
            const style = d.assets[styleId];
            if (!style || style.status !== "approved" || artifact.references.at(-1)?.storageKey !== style.storageKey || !dependencies.includes(styleId)) throw new Error("缺少已批准的末槽 STYLE_MOTHER 引用");
        }
        for (const ref of artifact.references) {
            const node = nodes.find(n => n.id === ref.nodeId);
            const meta = obj(node?.metadata);
            const keys = node ? [...resolveCanvasImageReferenceNode(node).map(r => r.storageKey), node.storageKey, meta.storageKey, meta.resultStorageKey] : [];
            if (!node || !keys.includes(ref.storageKey)) throw new Error(`参考不属于目标画布节点：${ref.label}`);
            const media = db.getMediaFile(ref.storageKey);
            if (!media || !fs.existsSync(media.filePath) || crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") !== ref.sha256) throw new Error(`参考媒体字节或版本不一致：${ref.label}`);
            if (!Object.values(d.assets).some(a => a.nodeId === ref.nodeId && a.storageKey === ref.storageKey && a.sha256 === ref.sha256 && a.status === "approved" && a.evidence?.trim())) throw new Error(`参考缺少真实媒体批准证据：${ref.label}`);
        }
    }
}

export function directorArtifact(data: EpisodeProductionData, kind: "image" | "h3", targetId: string) {
    const d = data.director;
    const a = d?.artifacts.find(a => a.kind === kind && a.targetId === targetId && a.status === "ready");
    if (!d || !a || a.sourceHash !== d.sourceHash || promptHash(a.prompt) !== a.sha256) throw new Error(`${targetId} 缺少当前版本完整 ${kind} 产物；请由 Acheng 编译，不从镜头摘要生成`);
    return a;
}
