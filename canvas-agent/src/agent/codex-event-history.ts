import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../config.js";
import type { CodexSupplementalHistory, CodexSupplementalHistoryItem, CodexSupplementalHistoryTurn } from "./codex-history.js";

type CodexEventHistoryData = { version: 1; items: CodexSupplementalHistoryItem[]; turns: CodexSupplementalHistoryTurn[] };

const STORAGE_VERSION = 1;

export const CODEX_EVENT_HISTORY_FILE = path.join(CONFIG_DIR, "codex-event-history.json");

/** 保存 Codex 持久线程投影可能省略的实时完成事件。 */
export class CodexEventHistory {
    private data?: CodexEventHistoryData;
    private queue: Promise<void> = Promise.resolve();

    constructor(private file = CODEX_EVENT_HISTORY_FILE) {}

    /** 按 threadId、turnId 和 itemId 新增或更新一条补充事件。 */
    record(entry: CodexSupplementalHistoryItem) {
        return this.run(async () => {
            const data = await this.load();
            const index = data.items.findIndex((item) => sameItem(item, entry));
            const previous = index >= 0 ? data.items[index] : undefined;
            const nextEntry = normalizeEntry({
                ...entry,
                ...(entry.sequence === undefined && previous?.sequence !== undefined ? { sequence: previous.sequence } : {}),
                item: mergeRecord(previous?.item, entry.item),
            });
            const items = [...data.items];
            if (index >= 0) items[index] = nextEntry;
            else items.push(nextEntry);
            const nextData = { ...data, items };
            await this.save(nextData);
            this.data = nextData;
        });
    }

    /** 保存 turn 终态，使标准线程历史尚未物化时仍可恢复完整轮次。 */
    recordTurn(entry: CodexSupplementalHistoryTurn) {
        return this.run(async () => {
            const data = await this.load();
            const index = data.turns.findIndex((turn) => sameTurn(turn, entry));
            const previous = index >= 0 ? data.turns[index] : undefined;
            const nextEntry = normalizeTurn({ ...entry, turn: mergeRecord(previous?.turn, entry.turn) });
            const turns = [...data.turns];
            if (index >= 0) turns[index] = nextEntry;
            else turns.push(nextEntry);
            const nextData = { ...data, turns };
            await this.save(nextData);
            this.data = nextData;
        });
    }

    /** 按 item 开始顺序返回指定线程的补充事件。 */
    readThread(threadId: string) {
        return this.run(async (): Promise<CodexSupplementalHistory> => {
            const data = await this.load();
            return {
                items: data.items.filter((item) => item.threadId === threadId).sort(compareEntries).map(cloneEntry),
                turns: data.turns.filter((turn) => turn.threadId === threadId).map(cloneTurn),
            };
        });
    }

    /** 归档线程后删除其补充事件。 */
    removeThread(threadId: string) {
        return this.run(async () => {
            const data = await this.load();
            const items = data.items.filter((item) => item.threadId !== threadId);
            const turns = data.turns.filter((turn) => turn.threadId !== threadId);
            if (items.length === data.items.length && turns.length === data.turns.length) return;
            const nextData = { version: 1 as const, items, turns };
            await this.save(nextData);
            this.data = nextData;
        });
    }

    private run<T>(task: () => Promise<T>) {
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async load() {
        if (this.data) return this.data;
        try {
            this.data = parseHistory(JSON.parse(await fs.readFile(this.file, "utf8")));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") this.data = emptyHistory();
            else if (error instanceof SyntaxError) throw new Error(`Codex event history JSON is invalid: ${this.file}. Refusing to overwrite existing data.`);
            else throw error;
        }
        return this.data;
    }

    private async save(data: CodexEventHistoryData) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporaryFile = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.writeFile(temporaryFile, JSON.stringify(data, null, 2));
            await fs.rename(temporaryFile, this.file);
        } finally {
            await fs.unlink(temporaryFile).catch(() => undefined);
        }
    }
}

export const codexEventHistory = new CodexEventHistory();

function emptyHistory(): CodexEventHistoryData {
    return { version: STORAGE_VERSION, items: [], turns: [] };
}

function parseHistory(value: unknown): CodexEventHistoryData {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidHistory();
    const data = value as Partial<CodexEventHistoryData>;
    if (data.version !== STORAGE_VERSION) throw new Error(`Unsupported Codex event history version: ${String(data.version ?? "missing")}. Refusing to overwrite existing data.`);
    if (!Array.isArray(data.items) || !Array.isArray(data.turns)) throw invalidHistory();
    return {
        version: STORAGE_VERSION,
        items: data.items.map((entry) => {
            if (!validIdentity(entry, true) || !entry.item || typeof entry.item !== "object" || Array.isArray(entry.item)) throw invalidHistory();
            return normalizeEntry(entry);
        }),
        turns: data.turns.map((entry) => {
            if (!validIdentity(entry, false) || !entry.turn || typeof entry.turn !== "object" || Array.isArray(entry.turn)) throw invalidHistory();
            return normalizeTurn(entry);
        }),
    };
}

function validIdentity(value: unknown, requireItemId: boolean): value is CodexSupplementalHistoryItem & CodexSupplementalHistoryTurn {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Partial<CodexSupplementalHistoryItem & CodexSupplementalHistoryTurn>;
    return typeof entry.threadId === "string" && Boolean(entry.threadId)
        && typeof entry.turnId === "string" && Boolean(entry.turnId)
        && (!requireItemId || (typeof entry.itemId === "string" && Boolean(entry.itemId)));
}

function invalidHistory() {
    return new Error("Codex event history data is invalid. Refusing to overwrite existing data.");
}

function sameItem(left: CodexSupplementalHistoryItem, right: CodexSupplementalHistoryItem) {
    return left.threadId === right.threadId && left.turnId === right.turnId && left.itemId === right.itemId;
}

function sameTurn(left: CodexSupplementalHistoryTurn, right: CodexSupplementalHistoryTurn) {
    return left.threadId === right.threadId && left.turnId === right.turnId;
}

function cloneEntry(entry: CodexSupplementalHistoryItem) {
    return structuredClone(entry);
}

function cloneTurn(entry: CodexSupplementalHistoryTurn) {
    return structuredClone(entry);
}

function compareEntries(left: CodexSupplementalHistoryItem, right: CodexSupplementalHistoryItem) {
    if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) return left.sequence - right.sequence;
    if (left.sequence !== undefined) return -1;
    if (right.sequence !== undefined) return 1;
    return 0;
}

function normalizeEntry(entry: CodexSupplementalHistoryItem): CodexSupplementalHistoryItem {
    return {
        ...entry,
        ...(entry.sequence === undefined ? {} : { sequence: entry.sequence }),
        item: structuredClone(entry.item),
    };
}

function normalizeTurn(entry: CodexSupplementalHistoryTurn): CodexSupplementalHistoryTurn {
    return { ...entry, turn: structuredClone({ ...entry.turn, id: entry.turnId }) };
}

function mergeRecord(previous: Record<string, unknown> | undefined, next: Record<string, unknown>) {
    if (!previous) return next;
    const merged = { ...previous };
    Object.entries(next).forEach(([key, value]) => {
        if (value !== undefined) merged[key] = value;
    });
    return merged;
}
