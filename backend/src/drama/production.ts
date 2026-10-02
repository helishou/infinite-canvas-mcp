import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
    emptyEpisodeProduction,
    episodeProductionDataSchema,
    productionEditSchema,
    productionPublishSchema,
    type EpisodeProductionData,
    type ProductionOperation,
} from "@basketikun/canvas-agent/drama/production-contract";
import { BASE_H3_NODE_METADATA, isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";

import { DATA_DIR } from "../config.js";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";

type Row = { revision: number; draft_json: string; published_json: string | null; published_version: number; updated_at: string };
export type ProductionImpact = { changedSceneIds: string[]; affectedShotIds: string[]; imageShotIds: string[]; clipGroupIds: string[]; missingAssetNodeIds: string[] };
export type ProductionRecord = { episodeId: string; revision: number; draft: EpisodeProductionData; published: EpisodeProductionData | null; publishedVersion: number; updatedAt: string };
export type ProductionRun = { episodeId: string; version: number; status: string; plan: ProductionImpact; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string }>; error: string | null; updatedAt: string };

const fingerprint = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

export class ProductionConflictError extends Error {
    constructor(readonly current: ProductionRecord) { super("制作稿版本已变化，请核对当前版本后重试"); }
}

export class EpisodeProductionService {
    constructor(private readonly db: BackendDatabase, private readonly events?: BackendEventBus, private readonly legacyDataDir = DATA_DIR) {}

    episodeInfo(episodeId: string) { return this.episode(episodeId); }

    get(episodeId: string): ProductionRecord {
        this.episode(episodeId);
        const row = this.db.db.prepare("SELECT * FROM episode_productions WHERE episode_id = ?").get(episodeId) as Row | undefined;
        return row ? this.fromRow(episodeId, row) : { episodeId, revision: 0, draft: emptyEpisodeProduction(), published: null, publishedVersion: 0, updatedAt: "" };
    }

    versions(episodeId: string) {
        this.episode(episodeId);
        return this.db.db.prepare("SELECT version, stage, impact_json, created_at FROM episode_production_versions WHERE episode_id = ? ORDER BY version DESC").all(episodeId)
            .map((row) => { const item = row as { version: number; stage: string; impact_json: string; created_at: string }; return { version: item.version, stage: item.stage, impact: JSON.parse(item.impact_json) as ProductionImpact, createdAt: item.created_at }; });
    }

    version(episodeId: string, version: number) {
        this.episode(episodeId);
        const row = this.db.db.prepare("SELECT * FROM episode_production_versions WHERE episode_id = ? AND version = ?").get(episodeId, version) as { version: number; stage: string; snapshot_json: string; impact_json: string; created_at: string } | undefined;
        if (!row) throw new Error("找不到制作稿版本");
        return { version: row.version, stage: row.stage, snapshot: episodeProductionDataSchema.parse(JSON.parse(row.snapshot_json)), impact: JSON.parse(row.impact_json) as ProductionImpact, createdAt: row.created_at };
    }

    exportMarkdown(episodeId: string, stage: "script" | "shots", version?: number) {
        const current = this.get(episodeId);
        const targetVersion = version ?? current.publishedVersion;
        if (!targetVersion) throw new Error("尚无可导出的发布版本");
        const snapshot = this.version(episodeId, targetVersion).snapshot;
        const lines = [`# ${stage === "script" ? "分场剧本" : "镜头表"}`, ``, `分集：${episodeId} · 制作稿 v${targetVersion}`, ``];
        if (stage === "script") snapshot.scenes.forEach((scene, index) => {
            lines.push(`## 场 ${index + 1} · ${scene.heading || scene.id}`, ``, `场次 ID：${scene.id} · ${scene.location} · ${scene.timeOfDay}`, ``);
            for (const block of scene.blocks) lines.push(block.kind === "dialogue" ? `**${block.speaker || "人物"}**（${block.id}）` : `动作（${block.id}）`, ``, block.text, ``);
        });
        else snapshot.shots.forEach((shot, index) => {
            const group = snapshot.clipGroups.find((item) => item.shotIds.includes(shot.id));
            lines.push(`## 镜 ${index + 1} · ${shot.title || shot.id}`, ``, `镜头 ID：${shot.id} · 场次 ID：${shot.sceneId} · ${shot.duration}s`, ``, `画面：${shot.visual}`, ``, `机位：${shot.camera}`, ``, `起始：${shot.openingState}`, ``, `结束：${shot.endingState}`, ``, `声音：${shot.sound}`, ``, `资产节点：${shot.assetNodeIds.join(", ") || "无"}`, ``, `关键帧策略：${shot.keyframePolicy} · 节点：${snapshot.keyframes[shot.id]?.nodeId || "未绑定"}`, ``, `Clip：${group?.nodeId || "未绑定"}/${group?.segmentId || "未绑定"}`, ``);
        });
        return { fileName: `${episodeId.replace(/[^A-Za-z0-9_-]/g, "_")}-${stage}-v${targetVersion}.md`, markdown: lines.join("\n") };
    }

    legacy(episodeId: string) {
        const episode = this.episode(episodeId);
        return (["fullPlot", "script.md", "storyboard.md"] as const).flatMap((source) => {
            const text = this.legacyText(episode, source);
            return text ? [{ source, sha256: crypto.createHash("sha256").update(text).digest("hex"), text }] : [];
        });
    }

    edit(episodeId: string, raw: unknown) {
        const input = productionEditSchema.parse(raw);
        return this.commit(episodeId, input.operationId, input.expectedRevision, fingerprint(input), (record) => {
            const draft = structuredClone(record.draft);
            for (const operation of input.ops) this.apply(episodeId, draft, operation, record.publishedVersion);
            this.validateGraph(draft);
            const published = record.published ? structuredClone(record.published) : null;
            for (const operation of input.ops) if (operation.type === "review_keyframe") {
                const link = published?.keyframes[operation.shotId];
                if (!link || link.sourceVersion !== record.publishedVersion || fingerprint(link) !== fingerprint(draft.keyframes[operation.shotId])) throw new Error("关键帧已不是当前发布版本的媒体，不能自动通过");
                published!.keyframeReviews[operation.shotId] = draft.keyframeReviews[operation.shotId];
            }
            if (published && input.ops.some((operation) => operation.type === "review_keyframe")) this.db.db.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(published), episodeId, record.publishedVersion);
            return { ...record, revision: record.revision + 1, draft, published, updatedAt: new Date().toISOString() };
        });
    }

    previewImpact(episodeId: string, stage: "script" | "shots") {
        const current = this.get(episodeId);
        return this.publicationImpact(current, this.publishedCandidate(current, stage), episodeId, stage);
    }

    publish(episodeId: string, raw: unknown) {
        const input = productionPublishSchema.parse(raw);
        return this.commit(episodeId, input.operationId, input.expectedRevision, fingerprint(input), (record) => {
            const candidate = this.publishedCandidate(record, input.stage);
            const impact = this.publicationImpact(record, candidate, episodeId, input.stage);
            const publishedVersion = record.publishedVersion + 1;
            const updatedAt = new Date().toISOString();
            this.db.db.prepare("INSERT INTO episode_production_versions (episode_id, version, stage, snapshot_json, impact_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .run(episodeId, publishedVersion, input.stage, JSON.stringify(candidate), JSON.stringify(impact), updatedAt);
            if (candidate.settings.mode === "auto" && input.stage === "shots") {
                this.db.db.prepare("INSERT INTO episode_production_runs (episode_id, version, status, plan_json, submitted_json, updated_at) VALUES (?, ?, 'pending', ?, '[]', ?)")
                    .run(episodeId, publishedVersion, JSON.stringify(impact), updatedAt);
            }
            const draft = structuredClone(record.draft);
            if (input.stage === "shots") draft.clipGroups = candidate.clipGroups;
            return { ...record, revision: record.revision + 1, draft, published: candidate, publishedVersion, updatedAt, impact };
        });
    }

    /** Runtime outcome binding; source content stays at the published version. */
    bindRuntime(episodeId: string, version: number, input: { shotId?: string; groupId?: string; nodeId: string; segmentId?: string; storageKey?: string }) {
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(episodeId);
            if (current.publishedVersion !== version || !current.published) throw new Error("已有更新的发布版本，停止旧版本自动回写");
            const node = this.canvasNode(episodeId, input.nodeId);
            if (input.shotId && node.type !== "image" && !(node.type === "config" && record(node.metadata).generationMode === "image")) throw new Error("运行关键帧绑定不是当前分集的图片节点");
            if (input.groupId) {
                const segments = record(node.metadata).segments;
                if (!isH3NodeType(node.type) || !Array.isArray(segments) || !segments.some((segment) => record(segment).id === input.segmentId)) throw new Error("运行 Clip 绑定不是当前分集的 H3 片段");
            }
            const snapshot = structuredClone(current.published);
            const draft = structuredClone(current.draft);
            if (input.shotId) {
                if (!snapshot.shots.some((shot) => shot.id === input.shotId)) throw new Error("镜头不在发布版本中");
                const link = { nodeId: input.nodeId, storageKey: input.storageKey || "", sourceVersion: version };
                snapshot.keyframes[input.shotId] = link;
                if (fingerprint(draft.shots.find((shot) => shot.id === input.shotId)) === fingerprint(snapshot.shots.find((shot) => shot.id === input.shotId))) draft.keyframes[input.shotId] = link;
            }
            if (input.groupId) {
                const group = snapshot.clipGroups.find((item) => item.id === input.groupId);
                if (!group || !input.segmentId) throw new Error("Clip 映射不在发布版本中");
                group.nodeId = input.nodeId; group.segmentId = input.segmentId; group.sourceVersion = version;
                const draftGroup = draft.clipGroups.find((item) => item.id === input.groupId);
                if (draftGroup && fingerprint(draftGroup.shotIds) === fingerprint(group.shotIds)) Object.assign(draftGroup, { nodeId: input.nodeId, segmentId: input.segmentId, sourceVersion: version });
            }
            if (fingerprint(snapshot) === fingerprint(current.published) && fingerprint(draft) === fingerprint(current.draft)) { this.db.db.exec("COMMIT"); return current; }
            const revision = current.revision + 1;
            const updatedAt = new Date().toISOString();
            this.db.db.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?")
                .run(revision, JSON.stringify(draft), JSON.stringify(snapshot), updatedAt, episodeId);
            this.db.db.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?")
                .run(JSON.stringify(snapshot), episodeId, version);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision, publishedVersion: version } });
            return { ...current, revision, draft, published: snapshot, updatedAt };
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    restore(episodeId: string, version: number, operationId: string, expectedRevision: number) {
        return this.commit(episodeId, operationId, expectedRevision, fingerprint({ version, operationId, expectedRevision }), (record) => ({
            ...record, revision: record.revision + 1, draft: structuredClone(this.version(episodeId, version).snapshot), updatedAt: new Date().toISOString(),
        }));
    }

    run(episodeId: string, version: number): ProductionRun | null {
        const row = this.db.db.prepare("SELECT * FROM episode_production_runs WHERE episode_id = ? AND version = ?").get(episodeId, version) as { status: string; plan_json: string; submitted_json: string; error: string | null; updated_at: string } | undefined;
        return row ? { episodeId, version, status: row.status, plan: JSON.parse(row.plan_json) as ProductionImpact, submitted: JSON.parse(row.submitted_json) as ProductionRun["submitted"], error: row.error, updatedAt: row.updated_at } : null;
    }

    updateRun(run: ProductionRun) {
        this.db.db.prepare("UPDATE episode_production_runs SET status = ?, submitted_json = ?, error = ?, updated_at = ? WHERE episode_id = ? AND version = ?")
            .run(run.status, JSON.stringify(run.submitted), run.error, new Date().toISOString(), run.episodeId, run.version);
    }

    pendingRuns() {
        return this.db.db.prepare("SELECT episode_id, version FROM episode_production_runs WHERE status IN ('pending','running','awaiting_review') ORDER BY updated_at").all()
            .flatMap((row) => { const item = row as { episode_id: string; version: number }; const run = this.run(item.episode_id, item.version); return run ? [run] : []; });
    }

    private commit(episodeId: string, operationId: string, expectedRevision: number, requestHash: string, mutate: (record: ProductionRecord) => ProductionRecord & { impact?: ProductionImpact }) {
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const prior = this.db.db.prepare("SELECT episode_id, request_hash, receipt_json FROM episode_production_operations WHERE operation_id = ?").get(operationId) as { episode_id: string; request_hash: string; receipt_json: string } | undefined;
            if (prior) {
                if (prior.episode_id !== episodeId || prior.request_hash !== requestHash) throw new Error("operationId 已用于不同制作稿操作");
                this.db.db.exec("COMMIT");
                return { ...JSON.parse(prior.receipt_json) as ProductionRecord & { impact?: ProductionImpact }, replayed: true };
            }
            const current = this.get(episodeId);
            if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
            const next = mutate(current);
            this.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO UPDATE SET revision = excluded.revision, draft_json = excluded.draft_json, published_json = excluded.published_json, published_version = excluded.published_version, updated_at = excluded.updated_at")
                .run(episodeId, next.revision, JSON.stringify(next.draft), next.published ? JSON.stringify(next.published) : null, next.publishedVersion, next.updatedAt);
            this.db.db.prepare("INSERT INTO episode_production_operations (operation_id, episode_id, request_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)")
                .run(operationId, episodeId, requestHash, JSON.stringify(next), next.updatedAt);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: next.revision, publishedVersion: next.publishedVersion } });
            return { ...next, replayed: false };
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    private fromRow(episodeId: string, row: Row): ProductionRecord {
        return { episodeId, revision: row.revision, draft: episodeProductionDataSchema.parse(JSON.parse(row.draft_json)), published: row.published_json ? episodeProductionDataSchema.parse(JSON.parse(row.published_json)) : null, publishedVersion: row.published_version, updatedAt: row.updated_at };
    }

    private episode(episodeId: string) {
        const episode = this.db.getDramaEpisode(episodeId);
        if (!episode) throw new Error("分集不存在");
        return episode;
    }

    private legacyText(episode: NonNullable<ReturnType<BackendDatabase["getDramaEpisode"]>>, source: "fullPlot" | "script.md" | "storyboard.md") {
        if (source === "fullPlot") return episode.fullPlot || "";
        if (!episode.canvasId) return "";
        const base = path.resolve(this.legacyDataDir, "productions");
        const directory = path.resolve(base, episode.canvasId);
        if (!directory.startsWith(`${base}${path.sep}`)) throw new Error("制作目录路径无效");
        const file = path.join(directory, source);
        return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : "";
    }

    private apply(episodeId: string, draft: EpisodeProductionData, op: ProductionOperation, sourceVersion: number) {
        const shot = (id: string) => { const value = draft.shots.find((item) => item.id === id); if (!value) throw new Error(`镜头不存在：${id}`); return value; };
        if (op.type === "upsert_scene") {
            const index = draft.scenes.findIndex((item) => item.id === op.scene.id);
            if (index < 0) draft.scenes.push(op.scene); else draft.scenes[index] = op.scene;
        } else if (op.type === "delete_scene") {
            if (draft.shots.some((item) => item.sceneId === op.id)) throw new Error("场次仍有镜头，请先处理镜头");
            draft.scenes = draft.scenes.filter((item) => item.id !== op.id);
        } else if (op.type === "reorder_scenes") {
            draft.scenes = reorder(draft.scenes, op.ids);
            draft.shots = orderShotsByScene(draft);
        } else if (op.type === "upsert_script_block" || op.type === "delete_script_block" || op.type === "reorder_script_blocks") {
            const scene = draft.scenes.find((item) => item.id === op.sceneId);
            if (!scene) throw new Error("剧本块所属场次不存在");
            if (op.type === "upsert_script_block") {
                const index = scene.blocks.findIndex((item) => item.id === op.block.id);
                if (index >= 0) scene.blocks[index] = op.block;
                else if (op.beforeBlockId) {
                    const before = scene.blocks.findIndex((item) => item.id === op.beforeBlockId);
                    if (before < 0) throw new Error("插入位置的剧本块不存在");
                    scene.blocks.splice(before, 0, op.block);
                } else scene.blocks.push(op.block);
            } else if (op.type === "delete_script_block") scene.blocks = scene.blocks.filter((item) => item.id !== op.id);
            else scene.blocks = reorder(scene.blocks, op.ids);
        } else if (op.type === "upsert_shot") {
            if (!draft.scenes.some((item) => item.id === op.shot.sceneId)) throw new Error("镜头所属场次不存在");
            const index = draft.shots.findIndex((item) => item.id === op.shot.id);
            if (index < 0) draft.shots.push(op.shot); else draft.shots[index] = op.shot;
            draft.shots = orderShotsByScene(draft);
        } else if (op.type === "delete_shot") {
            draft.shots = draft.shots.filter((item) => item.id !== op.id);
            delete draft.keyframes[op.id]; delete draft.keyframeReviews[op.id];
            draft.clipGroups = draft.clipGroups.map((group) => ({ ...group, shotIds: group.shotIds.filter((id) => id !== op.id) })).filter((group) => group.shotIds.length);
        } else if (op.type === "reorder_shots") {
            const selected = draft.shots.filter((item) => item.sceneId === op.sceneId);
            const reordered = reorder(selected, op.ids);
            let cursor = 0;
            draft.shots = draft.shots.map((item) => item.sceneId === op.sceneId ? reordered[cursor++] : item);
            draft.shots = orderShotsByScene(draft);
        } else if (op.type === "set_keyframe") {
            shot(op.shotId);
            if (!op.nodeId) { delete draft.keyframes[op.shotId]; delete draft.keyframeReviews[op.shotId]; }
            else {
                const node = this.canvasNode(episodeId, op.nodeId);
                const metadata = record(node.metadata);
                if (node.type !== "image" && !(node.type === "config" && metadata.generationMode === "image")) throw new Error("关键帧必须引用图片或智能图片节点");
                const images = Array.isArray(metadata.images) ? metadata.images.map(record) : [];
                const active = images.find((item) => item.id === metadata.primaryImageId) || images.find((item) => item.storageKey);
                draft.keyframes[op.shotId] = { nodeId: op.nodeId, storageKey: String(active?.storageKey || metadata.storageKey || ""), sourceVersion };
            }
        } else if (op.type === "set_clip_group") {
            for (const id of op.group.shotIds) shot(id);
            if (op.group.shotIds.length > 1 && !op.group.continuityReason?.trim()) throw new Error("合并相邻镜头须说明动作承接关系");
            const indices = op.group.shotIds.map((id) => draft.shots.findIndex((item) => item.id === id));
            if (indices.some((index, i) => i && index !== indices[i - 1] + 1)) throw new Error("合并 Clip 只能选择相邻镜头");
            if (op.group.nodeId && op.group.segmentId) {
                const node = this.canvasNode(episodeId, op.group.nodeId);
                const segments = Array.isArray(record(node.metadata).segments) ? record(node.metadata).segments as Array<Record<string, unknown>> : [];
                if (!isH3NodeType(node.type) || !segments.some((item) => item.id === op.group.segmentId)) throw new Error("H3 Clip 绑定不存在");
            }
            const index = draft.clipGroups.findIndex((item) => item.id === op.group.id);
            if (index < 0) draft.clipGroups.push(op.group); else draft.clipGroups[index] = op.group;
        } else if (op.type === "delete_clip_group") {
            draft.clipGroups = draft.clipGroups.filter((item) => item.id !== op.id);
        } else if (op.type === "set_settings") {
            draft.settings = { ...draft.settings, ...op.patch };
        } else if (op.type === "review_keyframe") {
            if (!draft.keyframes[op.shotId]?.storageKey) throw new Error("关键帧没有可访问媒体");
            draft.keyframeReviews[op.shotId] = { verdict: op.verdict, evidence: op.evidence, sourceVersion };
        } else if (op.type === "import_legacy") {
            const episode = this.episode(episodeId);
            const text = this.legacyText(episode, op.source);
            if (!text.trim()) throw new Error("导入来源为空");
            const sha256 = crypto.createHash("sha256").update(text).digest("hex");
            draft.legacyImports = [...draft.legacyImports.filter((item) => item.source !== op.source), { source: op.source, sha256, text, importedAt: new Date().toISOString() }];
            if (op.source !== "storyboard.md" && !draft.scenes.length) draft.scenes.push({ id: crypto.randomUUID(), heading: "导入草稿", location: "", timeOfDay: "", blocks: [{ id: crypto.randomUUID(), kind: "action", text }] });
            if (op.source === "storyboard.md" && !draft.shots.length) {
                if (!draft.scenes.length) draft.scenes.push({ id: crypto.randomUUID(), heading: "待拆场", location: "", timeOfDay: "", blocks: [] });
                draft.shots.push({ id: crypto.randomUUID(), sceneId: draft.scenes[0].id, title: "导入分镜草稿", duration: 0, visual: text, camera: "", openingState: "", endingState: "", sound: "", assetNodeIds: [], keyframePolicy: "none" });
            }
        }
    }

    private validateGraph(draft: EpisodeProductionData) {
        const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`${label} ID 重复`); };
        unique(draft.scenes.map((item) => item.id), "场次");
        unique(draft.shots.map((item) => item.id), "镜头");
        unique(draft.scenes.flatMap((item) => item.blocks.map((block) => block.id)), "剧本块");
        unique(draft.clipGroups.map((item) => item.id), "Clip 映射");
        const scenes = new Set(draft.scenes.map((item) => item.id));
        for (const shot of draft.shots) if (!scenes.has(shot.sceneId)) throw new Error(`镜头 ${shot.id} 所属场次不存在`);
        const shotIds = new Set(draft.shots.map((item) => item.id));
        for (const id of Object.keys(draft.keyframes)) if (!shotIds.has(id)) throw new Error(`关键帧镜头不存在：${id}`);
        unique(draft.clipGroups.flatMap((group) => group.shotIds), "Clip 所属镜头");
        for (const group of draft.clipGroups) {
            const positions = group.shotIds.map((id) => draft.shots.findIndex((shot) => shot.id === id));
            if (positions.some((position) => position < 0)) throw new Error(`Clip ${group.id} 引用了不存在的镜头`);
            if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) throw new Error(`Clip ${group.id} 的镜头已不相邻，请先拆分或重编组`);
        }
    }

    private publishedCandidate(record: ProductionRecord, stage: "script" | "shots") {
        const candidate = structuredClone(record.published || emptyEpisodeProduction());
        if (stage === "script") {
            if (!record.draft.scenes.length || record.draft.scenes.some((scene) => !scene.blocks.length)) throw new Error("剧本至少需要一个含内容的场次");
            candidate.scenes = structuredClone(record.draft.scenes);
            const validScenes = new Set(candidate.scenes.map((scene) => scene.id));
            const validShots = new Set(candidate.shots.filter((shot) => validScenes.has(shot.sceneId)).map((shot) => shot.id));
            candidate.shots = candidate.shots.filter((shot) => validShots.has(shot.id));
            candidate.clipGroups = candidate.clipGroups.map((group) => ({ ...group, shotIds: group.shotIds.filter((id) => validShots.has(id)) })).filter((group) => group.shotIds.length);
            candidate.keyframes = Object.fromEntries(Object.entries(candidate.keyframes).filter(([id]) => validShots.has(id)));
            candidate.keyframeReviews = Object.fromEntries(Object.entries(candidate.keyframeReviews).filter(([id]) => validShots.has(id)));
        } else {
            if (!record.published?.scenes.length) throw new Error("请先发布剧本");
            if (fingerprint(record.draft.scenes) !== fingerprint(record.published.scenes)) throw new Error("剧本草稿尚未发布，请先发布剧本");
            if (!record.draft.shots.length || record.draft.shots.some((shot) => shot.duration <= 0 || !shot.visual.trim())) throw new Error("镜头须有画面描述和正时长");
            candidate.shots = structuredClone(record.draft.shots);
            candidate.keyframes = structuredClone(record.draft.keyframes);
            candidate.keyframeReviews = structuredClone(record.draft.keyframeReviews);
            candidate.clipGroups = structuredClone(record.draft.clipGroups);
            const claimed = new Set(candidate.clipGroups.flatMap((group) => group.shotIds));
            for (const shot of candidate.shots) if (!claimed.has(shot.id)) candidate.clipGroups.push({ id: `clip:${shot.id}`, shotIds: [shot.id], nodeId: null, segmentId: null, sourceVersion: record.publishedVersion + 1 });
        }
        candidate.settings = structuredClone(record.draft.settings);
        if (stage === "shots") this.lockModels(record.episodeId, candidate);
        candidate.legacyImports = structuredClone(record.draft.legacyImports);
        return candidate;
    }

    /** Freeze the existing node/config choices for this publication, without a second settings form. */
    private lockModels(episodeId: string, candidate: EpisodeProductionData) {
        const canvasId = this.episode(episodeId).canvasId;
        const nodes = (canvasId ? this.db.getCanvasProject(canvasId)?.nodes || [] : []) as Array<Record<string, unknown>>;
        const ai = record(this.db.getSetting("ai.config"));
        const h3 = record(this.db.getSetting("plugin:minimax-h3:defaults:v1"));
        const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
        const settings = candidate.settings;
        settings.imageModels = Object.fromEntries(candidate.shots.map((shot) => {
            const target = nodes.find((node) => node.id === candidate.keyframes[shot.id]?.nodeId);
            const source = nodes.find((node) => node.type === "config" && record(node.metadata).productionShotId === shot.id);
            return [shot.id, text(settings.imageModel) || text(record(source?.metadata).model) || text(record(target?.metadata).model) || text(ai.imageModel) || text(ai.model)];
        }));
        settings.h3Models = Object.fromEntries(candidate.clipGroups.map((group) => {
            const node = nodes.find((item) => item.id === group.nodeId);
            const metadata = record(node?.metadata);
            const segment = Array.isArray(metadata.segments) ? metadata.segments.find((item) => record(item).id === group.segmentId) : null;
            return [group.id, text(settings.h3Model) || text(record(segment).modelName) || text(metadata.modelName) || text(h3.modelName) || text(BASE_H3_NODE_METADATA.modelName)];
        }));
    }

    private publicationImpact(record: ProductionRecord, candidate: EpisodeProductionData, episodeId: string, stage: "script" | "shots") {
        const impact = this.impact(record.published, candidate, episodeId);
        if (stage !== "shots") return impact;
        const lastShots = this.db.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM episode_production_versions WHERE episode_id=? AND stage='shots'").get(episodeId) as { version: number };
        const scriptImpacts = this.db.db.prepare("SELECT impact_json FROM episode_production_versions WHERE episode_id=? AND stage='script' AND version>?").all(episodeId, lastShots.version) as Array<{ impact_json: string }>;
        const scriptScenes = new Set(scriptImpacts.flatMap((item) => (JSON.parse(item.impact_json) as ProductionImpact).changedSceneIds));
        for (const shot of candidate.shots) if (scriptScenes.has(shot.sceneId) && !impact.affectedShotIds.includes(shot.id)) impact.affectedShotIds.push(shot.id);
        impact.imageShotIds = [...new Set([...impact.imageShotIds, ...candidate.shots.filter((shot) => scriptScenes.has(shot.sceneId) && shot.keyframePolicy === "new").map((shot) => shot.id)])];
        impact.clipGroupIds = candidate.clipGroups.filter((group) => group.shotIds.some((id) => impact.affectedShotIds.includes(id))).map((group) => group.id);
        impact.missingAssetNodeIds = this.missingAssets(episodeId, candidate, new Set(impact.affectedShotIds));
        return impact;
    }

    private impact(previous: EpisodeProductionData | null, next: EpisodeProductionData, episodeId: string): ProductionImpact {
        const before = previous || emptyEpisodeProduction();
        const oldScenes = new Map(before.scenes.map((scene) => [scene.id, scene]));
        const newScenes = new Map(next.scenes.map((scene) => [scene.id, scene]));
        const changedSceneIds = [...new Set([...oldScenes.keys(), ...newScenes.keys()])].filter((id) => fingerprint(oldScenes.get(id)) !== fingerprint(newScenes.get(id)));
        const oldSceneOrder = before.scenes.map((scene) => scene.id);
        next.scenes.forEach((scene, index) => { if (oldSceneOrder.indexOf(scene.id) !== index && !changedSceneIds.includes(scene.id)) changedSceneIds.push(scene.id); });
        const oldShots = new Map(before.shots.map((shot) => [shot.id, shot]));
        const affected = new Set([...new Set([...oldShots.keys(), ...next.shots.map((shot) => shot.id)])].filter((id) => {
            const shot = next.shots.find((item) => item.id === id);
            return fingerprint(oldShots.get(id)) !== fingerprint(shot) || (shot && changedSceneIds.includes(shot.sceneId));
        }));
        next.shots.forEach((shot, index) => { if (oldShots.get(shot.id)?.endingState !== shot.endingState && next.shots[index + 1]) affected.add(next.shots[index + 1].id); });
        const oldOrder = before.shots.map((shot) => shot.id);
        const newOrder = next.shots.map((shot) => shot.id);
        if (fingerprint(oldOrder) !== fingerprint(newOrder)) {
            next.shots.forEach((shot, index) => {
                if (oldOrder.indexOf(shot.id) !== index) {
                    affected.add(shot.id);
                    if (next.shots[index + 1]) affected.add(next.shots[index + 1].id);
                }
            });
        }
        const imageAffected = new Set(affected);
        const groupContent = (group: EpisodeProductionData["clipGroups"][number]) => ({ id: group.id, shotIds: group.shotIds, continuityReason: group.continuityReason || "" });
        const oldGroups = new Map(before.clipGroups.map((group) => [group.id, groupContent(group)]));
        const changedGroups = next.clipGroups.filter((group) => fingerprint(oldGroups.get(group.id)) !== fingerprint(groupContent(group)));
        for (const group of changedGroups) for (const id of group.shotIds) affected.add(id);
        return {
            changedSceneIds,
            affectedShotIds: [...affected],
            imageShotIds: next.shots.filter((shot) => imageAffected.has(shot.id) && shot.keyframePolicy === "new").map((shot) => shot.id),
            clipGroupIds: next.clipGroups.filter((group) => changedGroups.includes(group) || group.shotIds.some((id) => affected.has(id))).map((group) => group.id),
            missingAssetNodeIds: this.missingAssets(episodeId, next, affected),
        };
    }

    private missingAssets(episodeId: string, data: EpisodeProductionData, affected: Set<string>) {
        const canvasId = this.episode(episodeId).canvasId;
        const nodes = canvasId ? ((this.db.getCanvasProject(canvasId)?.nodes || []) as Array<Record<string, unknown>>) : [];
        const nodeIds = new Set(nodes.map((node) => String(node.id || "")));
        return [...new Set(data.shots.filter((shot) => affected.has(shot.id)).flatMap((shot) => shot.assetNodeIds))].filter((id) => !nodeIds.has(id));
    }

    private canvasNode(episodeId: string, nodeId: string) {
        const canvasId = this.episode(episodeId).canvasId;
        const project = canvasId ? this.db.getCanvasProject(canvasId) : null;
        const node = (project?.nodes as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === nodeId);
        if (!node) throw new Error(`分集画布中找不到节点：${nodeId}`);
        return node;
    }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function reorder<T extends { id: string }>(items: T[], ids: string[]) {
    if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.some((item) => item.id === id))) throw new Error("排序列表必须恰好包含当前全部 ID");
    return ids.map((id) => items.find((item) => item.id === id)!);
}
function orderShotsByScene(draft: EpisodeProductionData) {
    return draft.scenes.flatMap((scene) => draft.shots.filter((shot) => shot.sceneId === scene.id));
}
