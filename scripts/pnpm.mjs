#!/usr/bin/env node
/**
 * pnpm 启动器：绕开 npm 生成的 shell shim 在 git-bash 下的路径错位。
 *
 * 背景：`C:\Program Files\nodejs\corepack` 是个 sh shim，里面用
 *   basedir=$(dirname "$0"); exec node "$basedir/node_modules/corepack/dist/corepack.js"
 * 在 MSYS/git-bash 里 `$basedir` 还是 `/c/Program Files/nodejs`，交给原生 node 后被当成
 * 相对当前盘的路径 → 解析成 `E:\c\Program Files\...`（当前目录在 E 盘时）→ MODULE_NOT_FOUND。
 * 同一个问题也发生在 `%APPDATA%\npm\pnpm` 这类 shim 上。
 *
 * 这里用 node 自己的 execPath 定位 corepack 的 JS 入口，再用 node 直接跑，
 * 全程不经过任何 sh shim，所以 cmd / PowerShell / git-bash 都能用。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function candidates() {
    const list = [];
    if (process.env.PNPM_BIN) list.push({ kind: "bin", value: process.env.PNPM_BIN });
    // 1) node 安装目录里的 corepack（保持 package.json 的 packageManager 版本语义）
    const nodeDir = path.dirname(process.execPath);
    list.push({ kind: "corepack", value: path.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js") });
    list.push({ kind: "corepack", value: path.join(process.env.ProgramFiles ?? "C:/Program Files", "nodejs", "node_modules", "corepack", "dist", "corepack.js") });
    // 2) 现成的 pnpm 可执行文件（没有 corepack 时兜底）
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const appData = process.env.APPDATA ?? "";
    list.push({ kind: "bin", value: path.join(localAppData, "pnpm", "pnpm.exe") });
    list.push({ kind: "bin", value: path.join(appData, "npm", "pnpm.exe") });
    list.push({ kind: "shim", value: "pnpm" });
    return list;
}

function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, { stdio: "inherit", shell: false });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, status: result.status ?? 0 };
}

// PNPM_BIN 直给可执行文件
if (process.env.PNPM_BIN) {
    const direct = run(process.env.PNPM_BIN, args);
    if (direct.ok) process.exit(direct.status);
}

for (const candidate of candidates()) {
    if (candidate.kind === "bin" && !existsSync(candidate.value)) continue;
    if (candidate.kind === "corepack" && !existsSync(candidate.value)) continue;
    const result = candidate.kind === "corepack"
        ? run(process.execPath, [candidate.value, "pnpm", ...args])
        // 直接用 pnpm；最后一个候选是 PATH 里的名字，可能存在但坏掉，失败继续下一个
        : run(candidate.value, args);
    if (result.ok) process.exit(result.status);
    if (process.env.PNPM_DEBUG) process.stderr.write(`[pnpm-launcher] ${candidate.value}: ${result.error}\n`);
}

process.stderr.write("[pnpm-launcher] 找不到可用的 pnpm：设置 PNPM_BIN 指向 pnpm 可执行文件，或安装 corepack。\n");
process.exit(1);
