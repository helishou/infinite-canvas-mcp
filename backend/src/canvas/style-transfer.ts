import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("../../workers/style_transfer_worker.py", import.meta.url));
// scratch 放在 worker 代码同盘目录下：部分机器的安全策略禁止 Python 写系统 Temp/用户目录。
const scratchRoot = path.join(path.dirname(workerPath), ".style-transfer-tmp");

/** 优先级：显式 STYLE_TRANSFER_PYTHON > 仓库 backend/venv > PATH 上的 python。 */
export function resolveStyleTransferPython(platform = process.platform, exists = fs.existsSync, env = process.env): string {
  const configured = String(env.STYLE_TRANSFER_PYTHON || "").trim();
  if (configured) return configured;
  const venv = platform === "win32"
    ? fileURLToPath(new URL("../../venv/Scripts/python.exe", import.meta.url))
    : fileURLToPath(new URL("../../venv/bin/python", import.meta.url));
  if (exists(venv)) return venv;
  return platform === "win32" ? "python" : "python3";
}

export type StyleTransferParams = {
  strength?: number;
  kind?: "auto" | "scene" | "region" | "character";
  keepBlack?: boolean;
  bgFollow?: boolean;
};

export type StyleTransferOutput = { data: Buffer; width: number; height: number; log: string };

/** 本地风格迁移 worker 的进程管理；输出字节仍由调用方归档到媒体库。 */
export class StyleTransferRunner {
  private readonly processes = new Map<string, ChildProcess>();

  async run(
    childTaskId: string,
    stylePath: string,
    targetPath: string,
    params: StyleTransferParams,
  ): Promise<StyleTransferOutput> {
    await fs.promises.mkdir(scratchRoot, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(scratchRoot, "canvas-style-"));
    const outPath = path.join(dir, "result.png");
    const options = JSON.stringify({
      strength: Number.isFinite(params.strength) ? params.strength : 1,
      kind: params.kind || "auto",
      keep_black: Boolean(params.keepBlack),
      bg_follow: Boolean(params.bgFollow),
    });
    try {
      const { stdout, stderr, code } = await this.spawnWorker(
        resolveStyleTransferPython(),
        [workerPath, stylePath, targetPath, outPath, options],
        childTaskId,
      );
      if (code !== 0) throw new Error(stderr.trim() || `风格迁移 worker 退出码 ${code}`);
      let result: { ok?: boolean; width?: number; height?: number };
      try { result = JSON.parse(stdout); }
      catch { throw new Error("风格迁移 worker 返回了无效结果"); }
      if (!result.ok || !Number.isInteger(result.width) || !Number.isInteger(result.height)) {
        throw new Error(stderr.trim() || "风格迁移 worker 未返回有效结果");
      }
      const data = await fs.promises.readFile(outPath);
      return { data, width: result.width!, height: result.height!, log: stderr.trim() };
    } finally {
      this.processes.delete(childTaskId);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  cancel(childTaskId: string) {
    const child = this.processes.get(childTaskId);
    if (child && child.exitCode === null) child.kill();
  }

  private spawnWorker(command: string, args: string[], childTaskId: string) {
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.processes.set(childTaskId, child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => {
        this.processes.delete(childTaskId);
        reject(new Error(`无法启动风格迁移 Python：${error.message}`));
      });
      child.once("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 }));
    });
  }
}