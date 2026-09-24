export type DraftWrite = { key: string; label: string; projectId?: string; record: unknown; write: () => Promise<unknown> };
export type DraftStorageFailure = Omit<DraftWrite, "write"> & { error: string };

/** 同一记录顺序落盘；失败的最新值留在内存中，供重试和导出，不靠通知消失冒充已保存。 */
export class CanvasDraftPersistence {
    private latest = new Map<string, DraftWrite>();
    private chains = new Map<string, Promise<unknown>>();
    private failures = new Map<string, DraftStorageFailure>();
    private listeners = new Set<() => void>();
    private snapshot: DraftStorageFailure[] = [];
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish() {
        this.snapshot = [...this.failures.values()];
        this.listeners.forEach((listener) => listener());
    }
    save(input: DraftWrite): Promise<unknown> {
        const entry = { ...input, record: structuredClone(input.record) };
        this.latest.set(entry.key, entry);
        const operation = (this.chains.get(entry.key) || Promise.resolve()).catch(() => {}).then(entry.write).then((value) => {
            if (this.latest.get(entry.key) === entry) {
                this.latest.delete(entry.key);
                if (this.failures.delete(entry.key)) this.publish();
            }
            return value;
        }).catch((error) => {
            if (this.latest.get(entry.key) === entry) {
                const { write: _, ...record } = entry;
                this.failures.set(entry.key, { ...record, error: error instanceof Error ? error.message : String(error) });
                this.publish();
            }
            throw error;
        }).finally(() => { if (this.chains.get(entry.key) === operation) this.chains.delete(entry.key); });
        this.chains.set(entry.key, operation);
        return operation;
    }
    async retry() {
        const entries = [...this.failures.keys()].map((key) => this.latest.get(key)).filter((entry): entry is DraftWrite => Boolean(entry));
        await Promise.allSettled(entries.map((entry) => this.save(entry)));
        if (this.failures.size) throw new Error("仍有本机草稿未保存，请导出内存备份并检查浏览器存储空间或权限");
    }
    exportBackup() {
        // 包含正在重试的最新值，而不是上次失败时的过期快照。
        return { format: "canvas-unsaved-memory", version: 1, records: [...this.latest.values()].map(({ write: _, ...entry }) => entry) };
    }
}

export const canvasDraftPersistence = new CanvasDraftPersistence();
