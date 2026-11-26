/**
 * 把共享资产画布里「有明确资产身份、却仍是 image 形态」的节点就地转成
 * character/scene/prop 实体节点，保留 nodeId（消费方引用不失效）。
 *
 * 背景：影策 promotion 旧逻辑沿用分集源节点的 image/config 形态，导致共享画布里
 * 一批资产节点是 image，前端资产库按实体 type 过滤时看不到它们。新 promotion
 * 逻辑已改为按 asset_plan.kind 产出实体节点；本脚本一次性转存量。
 *
 * 只读真值判定转换范围，绝不臆测：
 *  - 节点 type=image 且 metadata.productionAssetId 有权威 kind（来自各集 published
 *    asset_plan 的 asset_id→kind）；没有权威 kind 的（临时参考图、风格母图、段落
 *    参考图等）一律跳过。
 *  - 同一共享画布里若已存在同资产（同 productionAssetId 或同 title）的实体节点，
 *    跳过并报告，避免重复建节点。
 *  - 若该 canonical 节点被其它画布以 sharedAssetReference/sharedAssetOrigin 引用，
 *    跳过并报告：就地改 type 会让引用节点（按自身 type 投影）取不到实体字段，
 *    这类需单独处理。
 *
 * 用法：
 *   tsx src/maintenance/migrate-shared-image-assets-to-entities.ts            # dry-run
 *   tsx src/maintenance/migrate-shared-image-assets-to-entities.ts --apply     # 需先停后端
 *   tsx src/maintenance/migrate-shared-image-assets-to-entities.ts --project <sharedCanvasId> --apply
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BackendDatabase } from "../db.js";
import { CONFIG_FILE, DB_FILE, DEFAULT_PORT } from "../config.js";
import { createDatabaseSnapshot } from "../database-snapshots.js";
import type { CanvasOperation } from "../canvas/project-ops.js";

type EntityKind = "character" | "scene" | "prop";
type Candidate = {
    dramaId: string;
    sharedCanvasId: string;
    nodeId: string;
    title: string;
    paid: string;
    kind: EntityKind;
};
type Skipped = Candidate & { reason: string };
type Plan = { candidates: Candidate[]; skipped: Skipped[] };

const ENTITY_KINDS = new Set<string>(["character", "scene", "prop"]);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const projectFlag = args.indexOf("--project");
if (args.some(arg => !["--apply", "--project"].includes(arg) && args[args.indexOf(arg) - 1] !== "--project")
    || projectFlag >= 0 && (!args[projectFlag + 1] || args[projectFlag + 1].startsWith("--"))
    || args.filter(arg => arg === "--project").length > 1) {
    throw new Error("Usage: migrate-shared-image-assets-to-entities [--project <sharedCanvasId>] [--apply]");
}
const selectedProjectId = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
if (!fs.existsSync(DB_FILE)) throw new Error(`数据库不存在，拒绝创建空库进行迁移：${DB_FILE}`);

function parse(value: string | null | undefined): Record<string, any> {
    try { return value ? JSON.parse(value) as Record<string, any> : {}; } catch { return {}; }
}
const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, any>> : [];

/** 权威分类：各集 published/draft 的 asset_plan（asset_id → kind）。 */
function authoritativeKinds(db: DatabaseSync): Map<string, EntityKind> {
    const map = new Map<string, EntityKind>();
    for (const row of db.prepare("SELECT draft_json, published_json FROM episode_productions").all() as Array<{ draft_json: string | null; published_json: string | null }>) {
        for (const raw of [row.draft_json, row.published_json]) {
            const data = parse(raw);
            const plans = rows((data.director?.source)?.asset_plan);
            for (const plan of plans) {
                const assetId = String(plan.asset_id || plan.id || "");
                const kind = String(plan.kind || plan.asset_type || "").toLowerCase();
                if (assetId && ENTITY_KINDS.has(kind) && !map.has(assetId)) map.set(assetId, kind as EntityKind);
            }
        }
    }
    return map;
}

/** 扫描全部画布节点，建立 canonical 节点 → 引用方（projectId, type）索引。 */
function referenceIndex(db: DatabaseSync): Map<string, Array<{ projectId: string; type: string }>> {
    const index = new Map<string, Array<{ projectId: string; type: string }>>();
    for (const row of db.prepare("SELECT project_id, node_json FROM canvas_nodes").all() as Array<{ project_id: string; node_json: string }>) {
        const node = parse(row.node_json);
        const md = node.metadata || {};
        for (const ref of [md.sharedAssetReference, md.sharedAssetOrigin]) {
            if (!ref || typeof ref !== "object") continue;
            const sourceNodeId = String(ref.sourceNodeId || "");
            if (!sourceNodeId) continue;
            const key = `${String(ref.sourceProjectId || "")}\0${sourceNodeId}`;
            index.set(key, [...(index.get(key) || []), { projectId: row.project_id, type: String(node.type || "") }]);
        }
    }
    return index;
}

function buildPlan(db: DatabaseSync): Plan {
    const kinds = authoritativeKinds(db);
    const refs = referenceIndex(db);
    const projects = db.prepare("SELECT folder_id, shared_asset_canvas_id FROM drama_projects WHERE shared_asset_canvas_id IS NOT NULL")
        .all() as Array<{ folder_id: string; shared_asset_canvas_id: string }>;
    const candidates: Candidate[] = [];
    const skipped: Skipped[] = [];
    for (const project of projects) {
        const dramaId = project.folder_id;
        const sharedCanvasId = project.shared_asset_canvas_id;
        if (selectedProjectId && sharedCanvasId !== selectedProjectId) continue;
        const rowsForProject = db.prepare("SELECT node_id, node_json FROM canvas_nodes WHERE project_id=?").all(sharedCanvasId) as Array<{ node_id: string; node_json: string }>;
        const nodes: Array<Record<string, any> & { id: string }> = rowsForProject.map(row => ({ id: row.node_id, ...parse(row.node_json) }));
        // 同画布已有的实体节点索引：productionAssetId / title 两种口径。
        const entityByPaid = new Map<string, string>();
        const entityByTitle = new Map<string, string>();
        for (const node of nodes) {
            if (!ENTITY_KINDS.has(String(node.type))) continue;
            const md = node.metadata || {};
            const paid = String(md.productionAssetId || md.characterAssetId || md.sceneAssetId || md.assetId || "");
            if (paid) entityByPaid.set(paid, String(node.id));
            if (node.title) entityByTitle.set(String(node.title), String(node.id));
        }
        for (const node of nodes) {
            if (node.type !== "image") continue;
            const md = node.metadata || {};
            const paid = String(md.productionAssetId || "");
            const kind = kinds.get(paid);
            if (!kind) continue; // 无权威 kind：临时参考图/风格母图/段落参考图，跳过
            const base: Candidate = { dramaId, sharedCanvasId, nodeId: String(node.id), title: String(node.title || ""), paid, kind };
            const samePaid = paid ? entityByPaid.get(paid) : undefined;
            const sameTitle = node.title ? entityByTitle.get(String(node.title)) : undefined;
            if (samePaid || sameTitle) {
                skipped.push({ ...base, reason: `同画布已存在实体节点：${samePaid || sameTitle}` });
                continue;
            }
            const consumers = refs.get(`${sharedCanvasId}\0${node.id}`) || [];
            const mismatched = consumers.filter(c => c.type && c.type !== kind && c.type !== "image");
            if (mismatched.length) {
                skipped.push({ ...base, reason: `被引用节点 type 不一致，就地改会断链：${mismatched.map(c => `${c.projectId}:${c.type}`).join(",")}` });
                continue;
            }
            candidates.push(base);
        }
    }
    return { candidates, skipped };
}

/** 构造就地转换操作：nodeId 不变，type 改实体，补名称字段；媒体字段保留，由 project-ops 规范化派生实体图字段。 */
function conversionOperation(candidate: Candidate, node: Record<string, any>): CanvasOperation {
    const md = node.metadata || {};
    const nameField = candidate.kind === "character" ? "characterName" : candidate.kind === "scene" ? "sceneName" : "propName";
    const descField = candidate.kind === "character" ? "characterDescription" : candidate.kind === "scene" ? "sceneDescription" : "propDescription";
    const entityMetadata: Record<string, unknown> = {
        [nameField]: md[nameField] || candidate.title || candidate.paid,
        [descField]: md[descField] || md.description || "",
    };
    // 从原 image 节点的顶层媒体字段构造实体图对象（唯一真值，不臆造）。
    const media: Record<string, unknown> = {
        url: String(md.content || ""), storageKey: String(md.storageKey || ""),
        width: Number(md.naturalWidth || 0), height: Number(md.naturalHeight || 0),
        bytes: Number(md.bytes || 0), mimeType: String(md.mimeType || ""),
    };
    // 显式回填顶层媒体字段 + 非空实体图数组：project-ops 的规范化据此派生/保留，
    // 缺一会让 gallery 分支把顶层媒体字段当成「无图」而删除，导致节点丢图。
    const topMedia = { content: media.url, storageKey: media.storageKey, naturalWidth: media.width,
        naturalHeight: media.height, bytes: media.bytes, mimeType: media.mimeType };
    if (candidate.kind === "character") {
        entityMetadata.characterEnglishName = md.characterEnglishName || "";
        const existing = Array.isArray(md.characterImages) ? md.characterImages : [];
        entityMetadata.characterImages = existing.length ? existing : media.storageKey ? [media] : [];
        entityMetadata.characterPrimaryIndex = Number(md.characterPrimaryIndex || 0);
        Object.assign(entityMetadata, topMedia);
    } else if (candidate.kind === "scene") {
        entityMetadata.sceneImage = md.sceneImage || (media.storageKey ? media : undefined);
        if (entityMetadata.sceneImage) Object.assign(entityMetadata, topMedia);
    } else if (candidate.kind === "prop") {
        entityMetadata.propImage = md.propImage || (media.storageKey ? media : undefined);
        if (entityMetadata.propImage) Object.assign(entityMetadata, topMedia);
    }
    return {
        type: "update_node", id: candidate.nodeId, patch: { type: candidate.kind }, metadata: entityMetadata,
    } as CanvasOperation;
}

async function assertBackendStopped() {
    let port = DEFAULT_PORT;
    try { port = Number(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).port) || DEFAULT_PORT; } catch { /* use default */ }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
        throw new Error(`Backend 正在监听 127.0.0.1:${port}；批量迁移需在服务停止时运行，避免绕过其事务事件广播`);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Backend 正在监听")) throw error;
        const cause = (error as NodeJS.ErrnoException).cause as NodeJS.ErrnoException | undefined;
        const code = typeof cause?.code === "string" ? cause.code : undefined;
        if (controller.signal.aborted || !code || !["ECONNREFUSED", "ECONNRESET", "ENOTFOUND"].includes(code)) {
            throw new Error("无法确认 Backend 已停止，拒绝离线批量迁移");
        }
    } finally { clearTimeout(timer); }
}

const reader = new DatabaseSync(DB_FILE, { readOnly: true });
let plan: Plan;
try { plan = buildPlan(reader); } finally { reader.close(); }
const summary = { candidates: plan.candidates.length, skipped: plan.skipped.length,
    byKind: plan.candidates.reduce<Record<string, number>>((acc, c) => { acc[c.kind] = (acc[c.kind] || 0) + 1; return acc; }, {}) };
if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, summary, candidates: plan.candidates, skipped: plan.skipped }, null, 2));
    process.exit(0);
}

await assertBackendStopped();
const db = new BackendDatabase(DB_FILE);
try {
    const backup = createDatabaseSnapshot(db.db, DB_FILE, "pre-shared-image-entity-migration");
    const check = new DatabaseSync(backup, { readOnly: true });
    try {
        if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("迁移前备份完整性检查失败，未开始迁移");
    } finally { check.close(); }

    const byCanvas = new Map<string, Candidate[]>();
    for (const candidate of plan.candidates) byCanvas.set(candidate.sharedCanvasId, [...(byCanvas.get(candidate.sharedCanvasId) || []), candidate]);
    const applied: Array<{ sharedCanvasId: string; nodeId: string; kind: string; operationId: string }> = [];
    for (const [sharedCanvasId, candidates] of byCanvas) {
        const project = db.getCanvasProject(sharedCanvasId);
        if (!project) throw new Error(`共享画布不存在，跳过整批：${sharedCanvasId}`);
        const nodeMap = new Map((project.nodes as Array<Record<string, any>>).map(node => [String(node.id), node]));
        const operations: CanvasOperation[] = [];
        for (const candidate of candidates) {
            const node = nodeMap.get(candidate.nodeId);
            if (!node) throw new Error(`节点不存在，跳过整批：${sharedCanvasId}/${candidate.nodeId}`);
            operations.push(conversionOperation(candidate, node));
        }
        const operationId = `migrate-shared-image-entity:${sharedCanvasId}:${operations.length}`;
        db.applyCanvasProjectOperations(sharedCanvasId, undefined, operations, {
            operationId, runtimeWrite: true, source: { kind: "system", clientId: "maintenance:shared-image-entity", label: "存量共享资产转实体节点" },
        });
        for (const candidate of candidates) applied.push({ sharedCanvasId, nodeId: candidate.nodeId, kind: candidate.kind, operationId });
    }
    console.log(JSON.stringify({ ok: true, dryRun: false, backup, summary, applied, skipped: plan.skipped }, null, 2));
} finally { db.close(); }
