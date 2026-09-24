import localforage from "localforage";
import * as Y from "yjs";
import { getBackendUrl } from "@/services/backend-api";
import { withCanvasDraftOwner } from "@/lib/canvas/canvas-draft-session";
import { decodeTextUpdate } from "@/lib/canvas/collaborative-text-session";
import { draftImports, draftImportKey, type DraftImport, type DraftImportRecord } from "@/lib/canvas/canvas-draft-import-state";

const names = {
    command: "infinite-canvas-command-outbox", text: "infinite-canvas-text-outbox", suggestion: "infinite-canvas-text-suggestions-outbox",
    cache: "infinite-canvas-project-cache", deletion: "infinite-canvas-project-deletions",
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === "object" && !Array.isArray(value));
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function target(value: unknown) {
    return object(value) && ["prompt", "content", "composerContent", "globalPrompt"].includes(String(value.field))
        && ["nodeId", "segmentId", "textItemId"].every((key) => value[key] === undefined || string(value[key]));
}
/** 画布记录的结构性校验：只认「有 id/title/nodes/connections」。
 *  它**不要求**完整 CanvasProject —— op 作用域基线（canvas-conflict-baseline，带 `v: 1`）
 *  只带本次 ops 的目标节点与连线，同样满足这些字段，因此无需额外分支就会被接受。
 *  不要把它收紧成「必须完整画布」，否则存量/新写的基线草稿会被判为损坏。 */
function project(value: unknown): value is ObjectValue & { id: string } {
    return object(value) && string(value.id) && typeof value.title === "string" && Array.isArray(value.nodes) && Array.isArray(value.connections);
}
function scope(key: string): string[] {
    const value: unknown = JSON.parse(key);
    requireValue(strings(value) && value.length === 3, "备份记录缺少完整的后台/窗口/项目归属");
    return value;
}

/** 只接受本版本的已归属记录；操作 ID、基线、正文与来源原样保存，不猜测旧数据语义。 */
export function parseCanvasDraftImport(raw: string): DraftImport {
    const input: unknown = JSON.parse(raw);
    requireValue(object(input) && input.version === 1 && ["canvas-draft-backup", "canvas-unsaved-memory"].includes(String(input.format)) && Array.isArray(input.records), "不是支持的画布草稿备份版本");
    const records: DraftImportRecord[] = [];
    let skipped = 0;
    for (const item of input.records) {
        requireValue(object(item) && string(item.key), "备份记录缺少 key");
        if (input.format === "canvas-draft-backup") {
            requireValue(string(item.store) && "value" in item, "备份记录缺少存储类型或内容");
            records.push({ store: item.store, key: item.key, value: item.value });
        } else {
            // null 是已确认记录的清理，不是用户编辑；导入绝不删除当前浏览器的任何记录。
            if (item.record === null) { skipped++; continue; }
            requireValue(object(item.record), "内存备份缺少记录内容");
            const record = item.record;
            if (item.key.startsWith("command:")) records.push({ store: names.command, key: item.key.slice(8), value: record });
            else if (item.key.startsWith("text:")) records.push({ store: names.text, key: item.key.slice(5), value: record });
            else if (item.key.startsWith("suggestion:")) records.push({ store: names.suggestion, key: item.key.slice(11), value: record });
            else {
                const [, , id] = scope(item.key);
                if (id === "deletions" && Array.isArray(record.ids)) records.push({ store: names.deletion, key: item.key, value: record.ids });
                else {
                    const { backend: _, ownerId: __, ...cache } = record;
                    records.push({ store: names.cache, key: item.key, value: cache });
                }
            }
        }
    }
    requireValue(records.length, "备份中没有可导入的草稿（清理记录不会执行）");
    let backend = "", ownerId = "";
    const seen = new Set<string>();
    for (const entry of records) {
        requireValue(Object.values(names).includes(entry.store), "未知或旧版存储记录只能检查/导出，不能自动恢复");
        const unique = JSON.stringify([entry.store, entry.key]);
        requireValue(!seen.has(unique), "备份包含重复记录，未导入任何内容"); seen.add(unique);
        const value = entry.value;
        let recordBackend: unknown, recordOwner: unknown;
        if (entry.store === names.cache || entry.store === names.deletion) {
            const [b, o, id] = scope(entry.key); recordBackend = b; recordOwner = o;
            if (entry.store === names.deletion) requireValue(id === "deletions" && strings(value), "项目删除意图损坏");
            else requireValue(object(value) && value.queueVersion === 2 && project(value.project) && value.project.id === id && (value.base === undefined || (project(value.base) && value.base.id === id)), "画布缓存损坏或为未归属的旧结构");
        } else {
            requireValue(object(value) && string(value.projectId), "草稿缺少项目 ID");
            recordBackend = value.backend; recordOwner = value.ownerId;
            if (entry.store === names.command) {
                requireValue(value.operationId === entry.key && finite(value.order) && project(value.base) && value.base.id === value.projectId && Array.isArray(value.operations) && value.operations.every((op) => object(op) && string(op.type)), "命令 ID、基线或操作记录损坏");
                requireValue(value.baseRevision === undefined || (finite(value.baseRevision) && Number(value.baseRevision) >= 0), "命令基线版本损坏");
                requireValue(value.supersedes === undefined || strings(value.supersedes), "命令替代关系损坏");
            } else if (entry.store === names.text) {
                requireValue(value.operationId === entry.key && finite(value.order) && string(value.documentId) && string(value.state) && string(value.update) && target(value.target), "协作文本记录损坏");
                requireValue(object(value.source) && string(value.source.clientId) && string(value.source.kind) && string(value.source.label), "文本请求缺少原始来源");
                try { Y.decodeUpdate(decodeTextUpdate(value.state)); Y.decodeUpdate(decodeTextUpdate(value.update)); }
                catch { throw new Error("协作文本增量损坏，未导入任何内容"); }
            } else {
                const suggestion = value.suggestion;
                requireValue(object(suggestion) && string(suggestion.id) && string(suggestion.documentId) && typeof suggestion.base === "string" && typeof suggestion.text === "string" && target(suggestion.target), "强化候选记录损坏");
                requireValue(entry.key === JSON.stringify([recordBackend, recordOwner, value.projectId, suggestion.id]), "强化候选归属与 key 不一致");
            }
        }
        requireValue(string(recordBackend) && string(recordOwner), "无法确认旧草稿归属；请保留原备份，不会猜测窗口或后台");
        if (!backend) { backend = recordBackend; ownerId = recordOwner; }
        requireValue(backend === recordBackend && ownerId === recordOwner, "一次只能导入同一后台、同一窗口的完整会话备份");
    }
    return { backend, ownerId, records, skipped };
}

export async function importCanvasDraftBackup(input: DraftImport) {
    // 执行入口再次校验，不能依赖界面预览期间的可变对象。
    const archive = parseCanvasDraftImport(JSON.stringify({ format: "canvas-draft-backup", version: 1, records: input.records }));
    requireValue(archive.backend === getBackendUrl(), "备份属于其他后台，请先连接原后台；不会把草稿改写到当前后台");
    return withCanvasDraftOwner(archive.ownerId, async () => {
        const key = draftImportKey(archive);
        const unfinished = await draftImports.getItem<DraftImport>(key);
        requireValue(!unfinished || JSON.stringify(unfinished.records) === JSON.stringify(archive.records), "这份会话已有另一份未完成导入，请先完成原导入");
        const entries = archive.records.map((entry) => ({ ...entry, storage: localforage.createInstance({ name: entry.store, ...(entry.store === names.command ? { storeName: "commands" } : {}) }) }));
        // 先检查全部碰撞，再落盘；已有不同值绝不覆盖，也不删除任何旧草稿。
        for (const entry of entries) {
            const previous = await entry.storage.getItem(entry.key);
            requireValue(previous === null || JSON.stringify(previous) === JSON.stringify(entry.value), `本机已有不同内容的记录：${entry.key}，导入已停止`);
        }
        await draftImports.setItem(key, archive);
        for (const entry of entries) await entry.storage.setItem(entry.key, entry.value);
        await draftImports.removeItem(key);
        return archive;
    });
}
