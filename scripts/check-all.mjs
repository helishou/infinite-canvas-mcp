// 并行类型检查三个工作区包，利用各自的 incremental 缓存（.tsbuildinfo）。
// 不经 pnpm/corepack：直接 spawn 各包本地 tsc，避免 git-bash 下 corepack shim 的路径问题。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsc = rel => path.join(root, rel, "node_modules/typescript/bin/tsc");

const jobs = [
    { name: "backend", dir: "backend", bin: tsc("backend"), args: ["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", ".tsbuildinfo/check.tsbuildinfo"] },
    { name: "agent", dir: "canvas-agent", bin: tsc("canvas-agent"), args: ["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", ".tsbuildinfo/check.tsbuildinfo"], stack: 8000 },
    { name: "web", dir: "web", bin: tsc("backend"), args: ["--noEmit"] },
];

const prefix = (name, text) => text.split("\n").filter(Boolean).map(line => `[${name}] ${line}`).join("\n");

const runs = jobs.map(job => new Promise(resolve => {
    const started = Date.now();
    const nodeArgs = [...(job.stack ? [`--stack-size=${job.stack}`] : []), job.bin, ...job.args];
    const child = spawn(process.execPath, nodeArgs, { cwd: path.join(root, job.dir) });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("exit", code => {
        if (out.trim()) console.log(prefix(job.name, out.trim()));
        console.log(`[${job.name}] ${code === 0 ? "✔ 通过" : `✖ ${code}`} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        resolve(code);
    });
}));

const codes = await Promise.all(runs);
const failed = jobs.filter((job, i) => codes[i] !== 0).map(job => job.name);
if (failed.length) { console.log(`✖ 失败: ${failed.join(", ")}`); process.exit(1); }
console.log("✔ 全部通过");
