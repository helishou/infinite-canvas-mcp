import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToRequests } from "node:timers/promises";

import { CONFIG_DIR } from "../config.js";
import { recordFlushTiming, recordHistoryLoad, recordQueueDepth, releaseQueueDepth } from "./codex-perf.js";
import type { CodexSupplementalHistory, CodexSupplementalHistoryItem, CodexSupplementalHistoryTurn } from "./codex-history.js";

type CodexEventHistoryData = { version: 1; items: CodexSupplementalHistoryItem[]; turns: CodexSupplementalHistoryTurn[] };

const STORAGE_VERSION = 1;

/** 落盘批处理的可选观测回调；用于验证合并写入确实生效。 */
export type CodexEventHistoryOptions = { onFlush?: (bytes: number) => void };

export const CODEX_EVENT_HISTORY_FILE = path.join(CONFIG_DIR, "codex-event-history.json");

/**
 * 保存 Codex 持久线程投影可能省略的实时完成事件。
 *
 * 逐条事件都全量重写整个文件时，成本是 O(总历史) × 事件数：历史涨到几十 MB 后，
 * 每条新事件都要把整个文件重新序列化并写盘一遍。
 *
 * 改为「同步合并 + 合批落盘」：
 * - `record` 在内存里同步合并（JS 单线程，无需排队），只标脏；
 * - 同一批并发 record 共享同一个落盘 Promise，因此 N 条事件只序列化一次；
 * - 真正需要耐久的位置（recordTurn / readThread / removeThread / flush）先排空待写内容。
 *
 * 落盘失败时回滚到上一次确认的状态，保证内存视图不领先于已确认耐久状态。
 */
export class CodexEventHistory {
    private data?: CodexEventHistoryData;
    /** 最近一次确认落盘的状态；写失败时回滚到这里。 */
    private durable?: CodexEventHistoryData;
    private queue: Promise<void> = Promise.resolve();
    /** 独立的落盘链，避免在 record 里排队等待造成自等待死锁。 */
    private diskQueue: Promise<void> = Promise.resolve();
    /** 首次加载；record 需要它先完成才能安全合并。 */
    private ready?: Promise<void>;
    /** 待落盘的脏标记；由 flushNow 消费。 */
    private dirty = false;
    /** 当前这一批共享的落盘句柄。 */
    private pending?: Promise<void>;

    constructor(private file = CODEX_EVENT_HISTORY_FILE, private options: CodexEventHistoryOptions = {}) {}

    /** 按 threadId、turnId 和 itemId 新增或更新一条补充事件。 */
    async record(entry: CodexSupplementalHistoryItem) {
        recordQueueDepth();
        try {
            await this.ensureLoaded();
            const data = this.data!;
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
            this.data = { ...data, items };
            this.dirty = true;
            await this.scheduleFlush();
        } finally {
            releaseQueueDepth();
        }
    }

    /** 保存 turn 终态，使标准线程历史尚未物化时仍可恢复完整轮次。 */
    recordTurn(entry: CodexSupplementalHistoryTurn) {
        return this.run(async () => {
            await this.ensureLoaded();
            const data = this.data!;
            const index = data.turns.findIndex((turn) => sameTurn(turn, entry));
            const previous = index >= 0 ? data.turns[index] : undefined;
            const nextEntry = normalizeTurn({ ...entry, turn: mergeRecord(previous?.turn, entry.turn) });
            const turns = [...data.turns];
            if (index >= 0) turns[index] = nextEntry;
            else turns.push(nextEntry);
            this.data = { ...data, turns };
            this.dirty = true;
            // 终态是 UI 完成转交的耐久门槛（CodexClient 会等这个 Promise）。
            await this.flush();
        });
    }

    /** 按 item 开始顺序返回指定线程的补充事件。 */
    readThread(threadId: string) {
        return this.run(async (): Promise<CodexSupplementalHistory> => {
            await this.ensureLoaded();
            // 读取前先排空，保证读到的是最新值而不是过期内存。
            await this.flush();
            const data = this.data!;
            return {
                items: data.items.filter((item) => item.threadId === threadId).sort(compareEntries).map(cloneEntry),
                turns: data.turns.filter((turn) => turn.threadId === threadId).map(cloneTurn),
            };
        });
    }

    /** 归档线程后删除其补充事件。 */
    removeThread(threadId: string) {
        return this.run(async () => {
            await this.ensureLoaded();
            const data = this.data!;
            const items = data.items.filter((item) => item.threadId !== threadId);
            const turns = data.turns.filter((turn) => turn.threadId !== threadId);
            if (items.length === data.items.length && turns.length === data.turns.length) return;
            this.data = { version: 1 as const, items, turns };
            this.dirty = true;
            await this.flush();
        });
    }

    /** 把待落盘的内存状态写盘；无待写内容时不产生任何 I/O。 */
    flush() {
        const chain = this.diskQueue.then(() => this.flushNow(), () => this.flushNow());
        this.diskQueue = chain.then(() => undefined, () => undefined);
        return chain;
    }

    /**
     * 合并写盘：同一批并发 record 共享同一次 save。
     * 用宏任务边界而不是定时器，让并发的 record 自然合批；
     * 落盘走独立链，绝不在 record 的队列任务里排队等待（那会自等待死锁）。
     */
    private scheduleFlush() {
        if (!this.pending) {
            this.pending = new Promise<void>((resolve, reject) => {
                setImmediate(() => {
                    const chain = this.flush();
                    this.pending = undefined;
                    chain.then(resolve, reject);
                });
            });
        }
        return this.pending;
    }

    /** 实际落盘；调用方负责串行化。失败时回滚内存到上次确认状态。 */
    private async flushNow() {
        if (!this.dirty || !this.data) return;
        const snapshot = this.data;
        // 注意：save 期间到达的新事件会再次置脏。这里不能在 await 前清标记，
        // 否则那些新事件会被这一轮误认为"已落盘"而在崩溃后丢失。
        try {
            await this.save(snapshot);
        } catch (error) {
            // 回滚：内存视图不得领先于已确认耐久状态。
            // 但如果 save 期间已有新事件把 data 换成了新快照，保留它并让下一批重试；
            // 不能因为上一批失败而把并发到达的新事件也一并抹掉。
            if (this.data === snapshot) {
                if (this.durable) this.data = this.durable;
                this.dirty = false;
            } else {
                this.dirty = true;
            }
            throw error;
        }
        this.durable = snapshot;
        // 只在成功后清除脏标记，且仅当期间没有新写入。
        if (this.data === snapshot) this.dirty = false;
    }

    private run<T>(task: () => Promise<T>) {
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private ensureLoaded() {
        return this.ready ??= this.loadOnce();
    }

    private async loadOnce(): Promise<void> {
        const readStarted = performance.now();
        try {
            const source = await fs.readFile(this.file, "utf8");
            const readMs = performance.now() - readStarted;
            const parseStarted = performance.now();
            this.data = parseHistory(JSON.parse(source));
            const parseMs = performance.now() - parseStarted;
            this.durable = this.data;
            recordHistoryLoad({ readMs: Math.round(readMs * 10) / 10, parseMs: Math.round(parseMs * 10) / 10, bytes: Buffer.byteLength(source, "utf8") });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") this.data = emptyHistory();
            else if (error instanceof SyntaxError) throw new Error(`Codex event history JSON is invalid: ${this.file}. Refusing to overwrite existing data.`);
            else throw error;
        }
        // ENOENT 也是合法的初始耐久状态：首次写入失败时应回滚为空历史。
        this.durable = this.data;
    }

    private async save(data: CodexEventHistoryData) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporaryFile = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        try {
            // 逐条序列化并交还事件循环，避免大历史的一次 stringify/UTF-8 转换
            // 阻塞同进程的 /health、业务请求与 Agent 事件。流背压控制在途内存。
            let serializeMs = 0;
            let bytes = 0;
            async function* chunks() {
                const encode = (value: unknown) => {
                    const started = performance.now();
                    const chunk = Buffer.from(JSON.stringify(value));
                    serializeMs += performance.now() - started;
                    bytes += chunk.length;
                    return chunk;
                };
                const literal = (value: string) => {
                    bytes += Buffer.byteLength(value);
                    return value;
                };
                yield literal('{"version":1,"items":[');
                for (const [index, entry] of data.items.entries()) {
                    await yieldToRequests();
                    if (index) yield literal(',');
                    yield encode(entry);
                }
                yield literal('],"turns":[');
                for (const [index, entry] of data.turns.entries()) {
                    await yieldToRequests();
                    if (index) yield literal(',');
                    yield encode(entry);
                }
                yield literal(']}');
            }
            const writeStarted = performance.now();
            await pipeline(Readable.from(chunks()), createWriteStream(temporaryFile));
            await fs.rename(temporaryFile, this.file);
            const writeMs = performance.now() - writeStarted - serializeMs;
            this.options.onFlush?.(bytes);
            recordFlushTiming({ serializeMs, writeMs, bytes });
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
