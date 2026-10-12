import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { acquireBackendInstanceLock } from "./instance-lock.js";

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "backend-lock-"));
}

async function backendOwner(t: TestContext, dir: string) {
    // Exercise process identity with an inert Backend-shaped entrypoint, never the real server.
    const entry = path.join(dir, "backend", "src", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000); process.send("ready");');
    const child = spawn(process.execPath, [entry], { argv0: "node", stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill();
        await exited;
    });
    assert.deepEqual(await once(child, "message"), ["ready", undefined]);
    assert.ok(child.pid);
    return child.pid;
}

function watchEnvironment(t: TestContext) {
    const previous = process.env.TSX_WATCHER;
    process.env.TSX_WATCHER = "1";
    t.after(() => {
        if (previous === undefined) delete process.env.TSX_WATCHER;
        else process.env.TSX_WATCHER = previous;
    });
}

// 普通模式：锁被活着的进程持有时必须直接拒绝，不能静默等待。
test("活进程持锁时普通模式立即拒绝", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pid = await backendOwner(t, dir);
    fs.writeFileSync(path.join(dir, "backend.lock"), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    await assert.rejects(() => acquireBackendInstanceLock(dir), /Backend 已在运行/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "backend.lock"), "utf8")).pid, pid);
});

test("活着的无关进程不占用 Backend 锁", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // The test runner is alive, but its command line is not a Backend entrypoint.
    fs.writeFileSync(path.join(dir, "backend.lock"), JSON.stringify({ pid: process.pid, startedAt: "unrelated-owner" }));
    const release = await acquireBackendInstanceLock(dir);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "backend.lock"), "utf8"));
    assert.equal(record.pid, process.pid);
    assert.notEqual(record.startedAt, "unrelated-owner");
    release();
    assert.equal(fs.existsSync(path.join(dir, "backend.lock")), false);
});

// 僵尸锁：持有者已死，必须自动清理后接管。
test("持有者已死时清理残留锁并接管", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // PID 0 在 Windows 上必然不存在。
    fs.writeFileSync(path.join(dir, "backend.lock"), JSON.stringify({ pid: 0, startedAt: new Date().toISOString() }));
    const release = await acquireBackendInstanceLock(dir);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "backend.lock"), "utf8"));
    assert.equal(Number(record.pid), process.pid, "锁应归当前进程所有");
    release();
    assert.equal(fs.existsSync(path.join(dir, "backend.lock")), false, "release 后锁文件应消失");
});

// watch 交接：旧子进程正在退出时，新子进程必须等它交锁，而不是崩掉。
// 这条同时验证等待期间事件循环没被冻住 —— 用计时器释放锁，冻住的话它永远等不到。
test("watch 模式下等待活着的旧实例释放锁", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, "backend.lock");
    const pid = await backendOwner(t, dir);
    fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString(), watchInstance: true }));
    // 旧实例会在 300ms 后交锁（模拟 tsx watch 的重启间隙）。
    let released = false;
    const timer = setTimeout(() => { fs.unlinkSync(lockPath); released = true; }, 300);
    t.after(() => clearTimeout(timer));
    watchEnvironment(t);

    const release = await acquireBackendInstanceLock(dir);
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(released, true, "新实例必须等旧实例交锁，不能提前接管");
    assert.equal(Number(record.pid), process.pid, "新实例应接管锁");
    assert.equal(record.watchInstance, true, "应记录这是 watch 实例");
    release();
});

// 双保险：watch 模式下旧实例真的不放锁时，也要有明确超时错误，不能无限挂住。
test("watch 模式下旧实例不释放锁时超时退出", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pid = await backendOwner(t, dir);
    // 指向一个不会主动交锁的 Backend 实例：必须超时抛错。
    // 显式标 watchInstance，因为只有「watch 实例」才允许让位等待 —— 普通实例撞锁必须立刻拒绝。
    fs.writeFileSync(path.join(dir, "backend.lock"), JSON.stringify({ pid, startedAt: new Date().toISOString(), watchInstance: true }));
    watchEnvironment(t);
    await assert.rejects(() => acquireBackendInstanceLock(dir), /未在 8 秒内释放锁/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "backend.lock"), "utf8")).pid, pid);
});

// 重复 acquire 时 release 必须幂等，否则 signal 监听会重复触发清理。
test("release 幂等且不误删他人的锁", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, "backend.lock");
    const release = await acquireBackendInstanceLock(dir);
    release();
    // 别的实例接管后，旧实例再次 release 不能把新锁删掉。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    release();
    assert.equal(fs.existsSync(lockPath), true, "锁内容不属于本进程时不应删除");
});
