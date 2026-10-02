import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type LockRecord = { pid: number; startedAt: string; watchInstance?: boolean };

function processExists(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function sleepMs(ms: number) {
    // 异步睡眠：拿锁等待期间事件循环必须保持可响应，
    // 用同步的 Atomics.wait 会把整个后端冻住 8 秒（tsx watch 重启时的竞态窗口）。
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 判断进程是不是 tsx watch 的子进程。
 * 走父进程命令行而不是环境变量：watch 的父进程 tsx 会一直在，
 * 凡是父进程是 tsx/cli 的实例，都可能是「正在退出的旧实例」，应该让位等待。
 *
 * 结果按 pid 缓存：一次拿锁判定只问一次，不在 150ms 的轮询里反复起 PowerShell。
 */
const watchChildCache = new Map<number, boolean>();
function isWatchChildProcess(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const cached = watchChildCache.get(pid);
    if (cached !== undefined) return cached;
    // 非 Windows 上父进程信息要靠 ps，成本高；只在 Windows 上做（这个仓库主战场是 Windows）。
    const verdict = process.platform !== "win32"
        ? Boolean(process.env.TSX_WATCHER)
        : readIsTsxChild(pid);
    watchChildCache.set(pid, verdict);
    return verdict;
}

function readIsTsxChild(pid: number) {
    try {
        const query = (field: string) => execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").${field}`,
        ], { encoding: "utf8", timeout: 1500, windowsHide: true }).trim();
        const parentPid = Number(query("ParentProcessId"));
        if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
        // 父进程的 cmdline 也要经过父进程自己那一跳，直接查它的父进程命令行更快也更可靠。
        const parentCmd = execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${parentPid}").CommandLine`,
        ], { encoding: "utf8", timeout: 1500, windowsHide: true });
        return /tsx/i.test(parentCmd);
    } catch {
        // 查不到就保守当成「不是 watch」，让正常的多实例保护继续生效。
        return false;
    }
}

/**
 * 等待锁的持有者退出，最多等 timeoutMs。
 * 返回 true 表示锁已空出（或已消失），可以去拿。
 */
async function waitForLockRelease(lockPath: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let current: Partial<LockRecord> = {};
        try { current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>; } catch { return true; /* 锁没了，可以拿 */ }
        if (!processExists(Number(current.pid))) return true;
        await sleepMs(150);
    }
    return false;
}

/**
 * Serialize HTTP Backend ownership for one data directory.
 * MCP stdio processes do not acquire this lock: they are clients of the
 * single HTTP Backend and must not open the SQLite database themselves.
 */
export async function acquireBackendInstanceLock(dataDir: string) {
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
            // tsx watch 重启：父进程 tsx 一直活着，真正的占位者是那个正在退出的旧子进程。
            // 这时要等它交锁，而不是当成「另一个实例在跑」直接退出 —— 否则 watch 的新进程
            // 一启动就崩，表现为「改代码没反应」。
            //
            // 不能只看环境变量：tsx 的模块求值顺序不保证 import 时就读得到 TSX_WATCHER，
            // 实测设了也会漏判。所以只要旧实例是「watch 实例」或父进程是 tsx，就一律等待。
            const oldIsWatch = existing.watchInstance === true || isWatchChildProcess(Number(existing.pid));
            if (oldIsWatch) {
                if (!await waitForLockRelease(lockPath, 8000)) {
                    throw new Error(`Backend 已在运行（PID ${existing.pid}）且未在 8 秒内释放锁：${lockPath}`);
                }
            } else {
                throw new Error(`Backend 已在运行（PID ${existing.pid}），数据目录锁定于 ${lockPath}`);
            }
        }
        // 锁已空出或属于已死进程：清掉后重新独占创建。
        try { fs.unlinkSync(lockPath); } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error(`发现残留 Backend 锁但无法清理 ${lockPath}: ${String(unlinkError)}`);
            }
        }
        handle = fs.openSync(lockPath, "wx", 0o600);
    }

    fs.writeSync(handle, JSON.stringify({ ...record, watchInstance: Boolean(process.env.TSX_WATCHER) }));
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
    // tsx watch 用 SIGTERM 结束子进程；不接住的话锁会残留到下次崩溃。
    // 注意：只释放锁，不 process.exit —— 硬退会跳过 DB flush 和 WebSocket 关闭。
    // 重复的 signal 监听会累积，所以只注册一次。
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(signal, () => release());
    }
    return release;
}
