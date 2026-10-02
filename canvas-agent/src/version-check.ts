import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { VERSION } from "./config.js";
import { logger } from "./utils/logger.js";
import { findCodexLaunch } from "./agent/codex-executable.js";

const execFileAsync = promisify(execFile);

/** 输出当前版本，并在后台检查 npm 最新版本。 */
export function checkVersions() {
    const localCodexVersion = commandVersion("codex");
    let installedCodexVersion = "";
    try { installedCodexVersion = findCodexLaunch()?.version || ""; }
    catch (error) { logger.warn("Optional Codex installation is unavailable", { error: String(error) }); }
    logger.info("Canvas Agent version", { version: VERSION });
    logger.info("Optional Codex version", { version: installedCodexVersion || "not installed" });
    logger.info("Local Codex version", { version: localCodexVersion || "not found" });
    if (!installedCodexVersion && !localCodexVersion) {
        logger.info("Codex chat is optional. To enable it: npm install -g @openai/codex@0.160.0");
    }
    void checkLatestVersions(localCodexVersion, installedCodexVersion);
}

/** 查询 npm，提醒升级不再维护的旧版本。 */
async function checkLatestVersions(localCodexVersion: string, installedCodexVersion: string) {
    try {
        const [latestAgent, latestCodex] = await Promise.all([
            npmVersion("@basketikun/canvas-agent"),
            npmVersion("@openai/codex"),
        ]);
        if (isOlder(VERSION, latestAgent)) logger.warn(`Update available: Canvas Agent ${VERSION} -> ${latestAgent}. Run: npx -y @basketikun/canvas-agent@latest`);
        if (installedCodexVersion && isOlder(installedCodexVersion, latestCodex)) logger.info(`Update available: optional Codex ${installedCodexVersion} -> ${latestCodex}`);
        if (localCodexVersion && isOlder(localCodexVersion, latestCodex)) logger.warn(`Update available: local Codex ${localCodexVersion} -> ${latestCodex}. Run: npm install -g @openai/codex@latest`);
    } catch {
        logger.warn("Unable to check the latest npm versions; startup will continue.");
    }
}

/** 读取本机命令输出中的语义版本号。 */
function commandVersion(command: string) {
    try {
        return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).match(/\d+\.\d+\.\d+/)?.[0] || "";
    } catch {
        return "";
    }
}

/** 读取 npm 包的最新版本。 */
async function npmVersion(name: string) {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await execFileAsync(command, ["view", name, "version"], { encoding: "utf8", timeout: 10_000 });
    return stdout.trim();
}

/** 比较仅包含数字段的稳定版语义版本。 */
function isOlder(current: string, latest: string) {
    const left = current.split(".").map(Number);
    const right = latest.split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) < (right[index] || 0);
    }
    return false;
}
