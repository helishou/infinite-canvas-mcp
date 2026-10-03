import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalProduction, type DirectorProduction, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import { resolveAchengRuntime } from "@basketikun/canvas-agent/skills/acheng";

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
        if (!input) throw new Error(`Acheng 镜头 ${s.id} 缺少画布输入映射`);
        const assetNodeIds = input.assetIds.map(id => { if (!d.assets[id]) throw new Error(`缺少资产映射 ${id}`); return d.assets[id].nodeId; });
        return { id: String(s.id), sceneId: String(s.scene_id), title: String(s.title || s.id), duration: (Number(s.end_frame) - Number(s.start_frame)) / fps,
            visual: prose(s.visual), camera: prose(s.camera), openingState: prose(s.state_in), endingState: prose(s.state_out), sound: prose({ dialogues: s.dialogues, audio: s.audio }), assetNodeIds, keyframePolicy: input.keyframePolicy };
    });
    const prior = new Map(data.clipGroups.map(g => [g.id, g]));
    data.clipGroups = list(source.segments).map(s => ({ id: String(s.id), shotIds: (s.shot_ids || []).map(String), nodeId: prior.get(String(s.id))?.nodeId || null, segmentId: prior.get(String(s.id))?.segmentId || null, sourceVersion: prior.get(String(s.id))?.sourceVersion || 0 }));
    const segments = list(source.segments);
    if (new Set(d.artifacts.map(a => `${a.kind}:${a.targetId}`)).size !== d.artifacts.length) throw new Error("同一目标只能有一个当前编译产物");
    for (const [index, boundary] of d.boundaries.entries()) {
        if (d.boundaries.findIndex(b => b.from === boundary.from) !== index) throw new Error("重复 Segment 边界");
        const i = segments.findIndex(s => s.id === boundary.from);
        if (i < 0 || segments[i + 1]?.id !== boundary.to) throw new Error("连续性边界必须连接相邻 Segment");
    }
    for (const s of segments) {
        const duration = (Number(s.end_frame) - Number(s.start_frame)) / fps;
        const declared = String(s.generation_clip_duration).split('/').map(Number);
        const seconds = declared.length === 2 ? declared[0] / declared[1] : declared[0];
        if (!Number.isFinite(duration) || duration < 4 || duration > 15 || Math.abs(duration - seconds) > 1e-7) throw new Error(`Segment ${s.id} 帧窗/秒数不一致或不在 4–15 秒`);
        const included = (s.shot_ids || []).map((id: string) => shots.find(shot => shot.id === id));
        if (!included.length || included.some((shot: Record<string, any> | undefined) => !shot)
            || included[0].start_frame !== s.start_frame || included[included.length - 1].end_frame !== s.end_frame
            || included.some((shot: Record<string, any>, index: number) => index > 0 && shot.start_frame !== included[index - 1].end_frame)) throw new Error(`Segment ${s.id} 不覆盖连续的已编写镜头边界`);
    }
    for (const artifact of d.artifacts) {
        if (artifact.sha256 !== promptHash(artifact.prompt)) throw new Error(`产物 ${artifact.id} 正文字节摘要不一致`);
        if (artifact.status === "ready" && (artifact.sourceHash !== d.sourceHash || artifact.receipt.sourceHash !== d.sourceHash || artifact.receipt.promptHash !== artifact.sha256 || artifact.receipt.engineRuntimeId !== d.engine.runtimeId)) throw new Error(`产物 ${artifact.id} 回执版本不一致`);
        if (artifact.kind === "h3" && !segments.some(s => s.id === artifact.targetId)) throw new Error("H3 产物目标不存在");
        if (artifact.kind === "image" && !d.assets[artifact.targetId]) throw new Error("图像产物资产映射不存在");
        const segment = segments.find(s => s.id === artifact.targetId);
        if (artifact.kind === "h3" && artifact.status === "ready" && segment?.mode === "Ref2VA") {
            const body = artifact.prompt.split("detailed_description:\n")[1]?.split("\n\noverall_soundscape:")[0] || "";
            const words = body.match(/\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b/g)?.length || 0;
            if (words < 2200 || words > 2900) throw new Error(`Ref2VA 正文必须为 2200–2900 英文词：${artifact.id}`);
        }
    }
}

/** Verify actual media bytes and project ownership, never a supplied PASS string. */
export function validateDirectorMedia(db: BackendDatabase, projectId: string, d: DirectorProduction) {
    const nodes = db.getCanvasProject(projectId)?.nodes as Array<Record<string, any>> | undefined;
    if (!nodes) throw new Error("画布不存在");
    const plan = new Map(list(d.source.asset_plan).map(a => [String(a.id), a]));
    if (d.executionAuthorized && d.boundaries.length !== Math.max(0, list(d.source.segments).length - 1)) throw new Error("执行前须逐一确定相邻 Segment 的尾帧与 Motion Context 边界");
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error(`资产依赖存在循环：${id}`);
        if (visited.has(id)) return;
        const entry = plan.get(id); if (!entry) throw new Error(`资产依赖未登记：${id}`);
        visiting.add(id);
        for (const dependency of entry.depends_on || []) visit(String(dependency));
        visiting.delete(id); visited.add(id);
    };
    for (const id of plan.keys()) visit(id);
    for (const artifact of d.artifacts.filter(a => a.status === "ready")) {
        if (Object.values(d.modules).some(m => m.status === "partial" || m.status === "blocked") && d.executionAuthorized) throw new Error("未完成或受阻模块不能标为可执行生产");
        const dependencies = artifact.kind === "image" ? plan.get(artifact.targetId)?.depends_on || []
            : list(d.source.shots).filter(s => list(d.source.segments).find(seg => seg.id === artifact.targetId)?.shot_ids?.includes(s.id)).flatMap(s => s.required_assets || []);
        for (const id of dependencies) {
            const asset = d.assets[String(id)];
            if (!asset || asset.status !== "approved" || !asset.evidence?.trim() || (plan.get(String(id))?.version && plan.get(String(id))?.version !== asset.version)) throw new Error(`产物 ${artifact.id} 依赖未批准或版本不一致：${id}`);
        }
        if (artifact.kind === "h3" && list(d.source.asset_cards).some(card => !String(card.prompt || "").trim())) throw new Error("资产提示词未全量就绪，不能提交 H3");
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
