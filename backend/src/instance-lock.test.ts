import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireBackendInstanceLock } from "./instance-lock.js";

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "backend-lock-"));
}

// 普通模式：锁被活着的进程持有时必须直接拒绝，不能静默等待。
test("活进程持锁时普通模式立即拒绝", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // 自己就是活进程，写一把指向自己 PID 的锁。
    fs.writeFileSync(path.join(dir, "backend.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await assert.rejects(() => acquireBackendInstanceLock(dir), /Backend 已在运行/);
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
    // 模拟 tsx watch 的交接：锁被一个仍然活着的进程持有。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), watchInstance: true }));
    // 旧实例会在 300ms 后交锁（模拟 tsx watch 的重启间隙）。
    setTimeout(() => { try { fs.unlinkSync(lockPath); } catch { /* 已释放 */ } }, 300);
    process.env.TSX_WATCHER = "1";
    t.after(() => { delete process.env.TSX_WATCHER; });

    const release = await acquireBackendInstanceLock(dir);
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(Number(record.pid), process.pid, "新实例应接管锁");
    assert.equal(record.watchInstance, true, "应记录这是 watch 实例");
    release();
});

// 双保险：watch 模式下旧实例真的不放锁时，也要有明确超时错误，不能无限挂住。
test("watch 模式下旧实例不释放锁时超时退出", async (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // 指向自己且永不释放：必须超时抛错。
    // 显式标 watchInstance，因为只有「watch 实例」才允许让位等待 —— 普通实例撞锁必须立刻拒绝。
    fs.writeFileSync(path.join(dir, "backend.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), watchInstance: true }));
    process.env.TSX_WATCHER = "1";
    t.after(() => { delete process.env.TSX_WATCHER; });
    await assert.rejects(() => acquireBackendInstanceLock(dir), /未在 8 秒内释放锁/);
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
