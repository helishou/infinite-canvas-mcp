import localforage from "localforage";

export type DraftImportRecord = { store: string; key: string; value: unknown };
export type DraftImport = { backend: string; ownerId: string; records: DraftImportRecord[]; skipped: number };
export const draftImports = localforage.createInstance({ name: "infinite-canvas-draft-imports" });
export const draftImportKey = (value: Pick<DraftImport, "backend" | "ownerId">) => JSON.stringify([value.backend, value.ownerId]);

/** 跨 IndexedDB 库不能一起提交。完整档案先落盘，恢复入口在所有记录写完前保持关闭。 */
export async function hasPendingDraftImport(ownerId: string) {
    let pending = false;
    await draftImports.iterate<DraftImport, void>((entry) => { if (entry.ownerId === ownerId) pending = true; });
    return pending;
}
