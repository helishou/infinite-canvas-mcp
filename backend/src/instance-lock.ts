import fs from "node:fs";
import path from "node:path";

type LockRecord = { pid: number; startedAt: string };

function processExists(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Serialize HTTP Backend ownership for one data directory.
 * MCP stdio processes do not acquire this lock: they are clients of the
 * single HTTP Backend and must not open the SQLite database themselves.
 */
export function acquireBackendInstanceLock(dataDir: string) {
    const lockPath = path.join(dataDir, "backend.lock");
    const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    let handle: number;
    try {
        handle = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: Partial<LockRecord> = {};
        try { existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>; } catch { /* stale or partial lock */ }
        if (processExists(Number(existing.pid))) {
            throw new Error(`Backend 已在运行（PID ${existing.pid}），数据目录锁定于 ${lockPath}`);
        }
        try { fs.unlinkSync(lockPath); } catch (unlinkError) {
            throw new Error(`发现残留 Backend 锁但无法清理 ${lockPath}: ${String(unlinkError)}`);
        }
        handle = fs.openSync(lockPath, "wx", 0o600);
    }

    fs.writeSync(handle, JSON.stringify(record));
    fs.closeSync(handle);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        try {
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
            if (Number(current.pid) === process.pid) fs.unlinkSync(lockPath);
        } catch { /* process shutdown or another instance already released it */ }
    };
    process.once("exit", release);
    return release;
}
