import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 数据库快照的统一出口：命名、校验前置、保留上限。
 *
 * 背景：迁移/破坏性维护前用 `VACUUM INTO` 落一份全库快照是对的，但快照不能无上限堆积——
 * 本机曾因 dev 重启循环（每次启动都发现库落后一个版本）攒下 18 份 1.6 GB 的完整副本。
 * 因此所有快照都必须走这里：**同一用途只保留最新 N 份**，创建后立即回收更旧的。
 */

/** 保留份数上限；`INFINITE_CANVAS_SNAPSHOT_KEEP=0` 表示创建后不保留额外快照。 */
export function snapshotRetention(): number {
    const raw = Number(process.env.INFINITE_CANVAS_SNAPSHOT_KEEP);
    return Number.isInteger(raw) && raw >= 0 ? raw : 2;
}

/** 快照文件后缀：`VACUUM INTO` 产物是 .sqlite，director-source 的历史命名是 .bak。 */
const SNAPSHOT_SUFFIXES = [".sqlite", ".bak"];

function statMtimeMs(file: string): number {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 列出同一用途（`<库文件名>.<family>-*`）下的全部快照，按新→旧排序。 */
export function listDatabaseSnapshots(file: string, family: string): string[] {
    const directory = path.dirname(file);
    const prefix = `${path.basename(file)}.${family}-`;
    let names: string[];
    try { names = fs.readdirSync(directory); } catch { return []; }
    return names
        .filter((name) => name.startsWith(prefix) && SNAPSHOT_SUFFIXES.some((suffix) => name.endsWith(suffix)))
        .map((name) => path.join(directory, name))
        .sort((a, b) => (statMtimeMs(b) - statMtimeMs(a)) || path.basename(b).localeCompare(path.basename(a)));
}

/**
 * 保留策略：同一用途只留最新 `keep` 份，其余删除。尽力而为——删除失败（被占用/权限）不抛错，
 * 因为回收快照失败绝不能挡住迁移或启动。
 */
export function pruneDatabaseSnapshots(file: string, family: string, keep = snapshotRetention()): { kept: string[]; removed: string[] } {
    const snapshots = listDatabaseSnapshots(file, family);
    const bounded = Math.max(keep, 0);
    const kept = snapshots.slice(0, bounded);
    const removed: string[] = [];
    for (const stale of snapshots.slice(bounded)) {
        try { fs.rmSync(stale, { force: true }); removed.push(stale); } catch { /* 保留下次再回收 */ }
    }
    return { kept, removed };
}

/**
 * 创建一份快照并做最小完整性兜底（非空 + 0600）。返回快照路径；
 * 调用方仍需按各自的语义做 `integrity_check` / `foreign_key_check`。
 */
export function createDatabaseSnapshot(executor: { exec(sql: string): unknown }, file: string, family: string, suffix = ".sqlite"): string {
    const backup = `${file}.${family}-${crypto.randomUUID()}${suffix}`;
    executor.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    if (!fs.existsSync(backup) || fs.statSync(backup).size === 0) throw new Error("数据库快照为空，已中止后续操作");
    fs.chmodSync(backup, 0o600);
    return backup;
}
